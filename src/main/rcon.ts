import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { RconConfig, RconResult } from '../shared/types';

/** RCON 包类型 */
const TYPE = {
  RESPONSE_VALUE: 0,
  // 3 已废弃（Auth Response 的历史值）
  AUTH_RESPONSE: 2,
  EXECCOMMAND: 2,
  AUTH: 3,
} as const;

/** 单条命令在服务端返回中可能被拆成多个包，用这个约定结束符判定 */
const TERMINATOR = '\u0000';

interface PendingRequest {
  requestId: number;
  resolve: (value: RconResult) => void;
  timer: NodeJS.Timeout;
  chunks: string[];
}

/**
 * Minecraft RCON 协议客户端。
 *
 * 协议要点：
 * - 裸 TCP，密码明文传输，绝不能暴露公网
 * - 包结构：[长度 int32LE][请求ID int32LE][类型 int32LE][body + \0\0]
 * - 鉴权：发 AUTH 包，服务端返回 requestId = -1 表示失败
 */
export class RconClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private config: RconConfig;
  private buffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private authed = false;
  private pending = new Map<number, PendingRequest>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closedByUser = false;
  private state: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private lastError?: string;

  constructor(config: RconConfig) {
    super();
    this.config = config;
  }

  updateConfig(config: RconConfig): void {
    const changed =
      this.config.host !== config.host ||
      this.config.port !== config.port ||
      this.config.password !== config.password;
    this.config = config;
    if (changed && this.state === 'connected') {
      void this.disconnect().then(() => this.connect());
    }
  }

  getState() {
    return { state: this.state, lastError: this.lastError };
  }

  private setState(state: typeof this.state, message?: string): void {
    this.state = state;
    if (message) this.lastError = message;
    if (state === 'connected') this.lastError = undefined;
    this.emit('state', { state, lastError: this.lastError });
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.clearReconnectTimer();
      this.closedByUser = false;

      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.destroy();
        this.socket = null;
      }

      if (!this.config.host || !this.config.port) {
        this.setState('error', 'RCON 地址或端口未配置');
        resolve();
        return;
      }

      this.setState('connecting');
      const socket = net.createConnection(
        { host: this.config.host, port: this.config.port },
        () => {
          this.authenticate()
            .then((ok) => {
              if (ok) {
                this.setState('connected');
                this.emit('connect');
              } else {
                this.setState('error', 'RCON 密码错误或被拒绝');
                socket.destroy();
              }
              resolve();
            })
            .catch((err: Error) => {
              this.setState('error', err.message);
              socket.destroy();
              resolve();
            });
        },
      );

      socket.setNoDelay(true);
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', (err) => {
        this.setState('error', err.message);
      });
      socket.on('close', () => {
        this.authed = false;
        this.failAllPending('连接已关闭');
        if (this.state !== 'error') this.setState('disconnected');
        if (!this.closedByUser) this.scheduleReconnect();
      });

      this.socket = socket;
    });
  }

  disconnect(): Promise<void> {
    this.closedByUser = true;
    this.clearReconnectTimer();
    return new Promise<void>((resolve) => {
      if (!this.socket) {
        this.setState('disconnected');
        resolve();
        return;
      }
      const sock = this.socket;
      sock.once('close', () => resolve());
      sock.destroy();
      this.socket = null;
      this.authed = false;
      this.setState('disconnected');
      resolve();
    });
  }

  private scheduleReconnect(): void {
    if (this.config.reconnectIntervalMs <= 0) return;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, this.config.reconnectIntervalMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private writePacket(type: number, body: string, requestId: number): void {
    if (!this.socket || this.socket.destroyed) return;
    const payload = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(payload.length + 14);
    buf.writeInt32LE(payload.length + 10, 0);
    buf.writeInt32LE(requestId, 4);
    buf.writeInt32LE(type, 8);
    payload.copy(buf, 12);
    buf.writeInt16LE(0, 12 + payload.length);
    this.socket.write(buf);
  }

  private authenticate(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!this.socket) return resolve(false);
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, this.config.timeoutMs);

      this.pending.set(requestId, {
        requestId,
        chunks: [],
        timer,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result.success);
        },
      });

      this.writePacket(TYPE.AUTH, this.config.password, requestId);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 12) {
      const size = this.buffer.readInt32LE(0);
      if (this.buffer.length < size + 4) break;

      const requestId = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const bodyStart = 12;
      const bodyEnd = 4 + size;
      const raw = this.buffer.subarray(bodyStart, bodyEnd);
      // 去掉尾部 \0\0
      const body = raw.toString('utf8').replace(/\u0000+$/, '');

      this.buffer = this.buffer.subarray(4 + size);

      if (type === TYPE.AUTH_RESPONSE || requestId === -1) {
        // 鉴权响应：requestId === -1 表示失败
        if (requestId === -1) {
          const p = this.findAuthPending();
          if (p) {
            this.pending.delete(p.requestId);
            clearTimeout(p.timer);
            p.resolve({ success: false, response: '' });
          }
        } else {
          this.authed = true;
          const p = this.pending.get(requestId);
          if (p) {
            this.pending.delete(requestId);
            clearTimeout(p.timer);
            p.resolve({ success: true, response: '' });
          }
        }
        continue;
      }

      // 命令响应
      const pending = this.pending.get(requestId);
      if (pending) {
        // 部分服务端会把长响应拆包，这里按请求ID聚合
        if (body === '' || body !== TERMINATOR) {
          pending.chunks.push(body);
        }
        // 简单策略：收到包后延迟少许再结算，兼顾单包与多包
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          this.pending.delete(requestId);
          pending.resolve({
            success: true,
            response: pending.chunks.join('').replace(/\u0000+$/, '').trim(),
          });
        }, 40);
      }
    }
  }

  private findAuthPending(): PendingRequest | undefined {
    // 鉴权失败时服务端返回 requestId=-1，找不到原请求ID，取最早的一个
    const values = [...this.pending.values()];
    return values[0];
  }

  private failAllPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ success: false, response: '', error: reason });
    }
    this.pending.clear();
  }

  /** 执行一条命令，自动做参数清洗（禁止换行注入） */
  execute(command: string): Promise<RconResult> {
    if (this.state !== 'connected' || !this.authed) {
      // 尝试自动重连一次
      if (this.state === 'disconnected') {
        void this.connect();
      }
      return Promise.resolve({ success: false, response: '', error: 'RCON 未连接' });
    }

    const cleaned = command.replace(/[\r\n\u0000]/g, ' ').trim();
    if (!cleaned) {
      return Promise.resolve({ success: false, response: '', error: '命令为空' });
    }

    return new Promise<RconResult>((resolve) => {
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ success: false, response: '', error: '命令执行超时' });
      }, this.config.timeoutMs);

      this.pending.set(requestId, { requestId, chunks: [], timer, resolve });
      this.writePacket(TYPE.EXECCOMMAND, cleaned, requestId);
    });
  }

  destroy(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    this.failAllPending('客户端已销毁');
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.setState('disconnected');
  }
}
