import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { OneBotConfig } from '../shared/types';

/** OneBot v11 群消息事件（只声明用到的字段） */
export interface GroupMessageEvent {
  post_type: 'message';
  message_type: 'group';
  sub_type: string;
  message_id: number;
  group_id: number;
  user_id: number;
  raw_message: string;
  message: unknown;
  sender?: { nickname?: string; card?: string; role?: string };
}

/** OneBot v11 私聊消息事件 */
export interface PrivateMessageEvent {
  post_type: 'message';
  message_type: 'private';
  sub_type: string;
  message_id: number;
  user_id: number;
  raw_message: string;
  message: unknown;
  sender?: { nickname?: string };
}

export type MessageEvent = GroupMessageEvent | PrivateMessageEvent;

/** OneBot v11 群成员减少事件（notice：某人退群 / 被踢） */
export interface GroupDecreaseNotice {
  post_type: 'notice';
  notice_type: 'group_decrease';
  sub_type: 'leave' | 'kick' | 'kick_me';
  group_id: number;
  operator_id: number;
  user_id: number;
}

/** OneBot v11 事件（消息 / 通知 / 请求 / 元事件） */
export type OneBotEvent =
  | MessageEvent
  | GroupDecreaseNotice
  | { post_type: string; [key: string]: unknown };

/** 判断是否为群成员减少事件 */
export function isGroupDecreaseNotice(ev: OneBotEvent): ev is GroupDecreaseNotice {
  return (
    (ev as GroupDecreaseNotice).post_type === 'notice' &&
    (ev as GroupDecreaseNotice).notice_type === 'group_decrease'
  );
}

/** OneBot v11 API 响应 */
interface ApiResponse {
  status: string;
  retcode: number;
  data: unknown;
  echo?: string;
}

/**
 * OneBot v11 WebSocket 客户端（正向连接 / 客户端模式）。
 *
 * 支持 SnowLuma 暴露的 ws://127.0.0.1:3001 端口。
 * 发送的 action 带 echo 字段，服务端响应通过 echo 关联回 Promise。
 */
export class OneBotClient extends EventEmitter {
  private config: OneBotConfig;
  private ws: WebSocket | null = null;
  private pending = new Map<string, {
    resolve: (v: ApiResponse) => void;
    timer: NodeJS.Timeout;
  }>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closedByUser = false;
  private echoSeq = 1;
  private state: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private lastError?: string;
  private selfId?: string;
  private selfName?: string;

  constructor(config: OneBotConfig) {
    super();
    this.config = config;
  }

  updateConfig(config: OneBotConfig): void {
    const changed =
      this.config.wsUrl !== config.wsUrl ||
      this.config.accessToken !== config.accessToken;
    // autoReconnect 的变化即时生效
    this.config = config;
    if (changed && this.state !== 'disconnected') {
      void this.disconnect().then(() => this.connect());
    }
  }

  getState() {
    return {
      state: this.state,
      lastError: this.lastError,
      selfId: this.selfId,
      selfName: this.selfName,
    };
  }

  private setState(state: typeof this.state, err?: string): void {
    this.state = state;
    this.lastError = err;
    this.emit('state', this.getState());
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.clearReconnectTimer();
      this.closedByUser = false;

      if (this.ws) {
        this.ws.removeAllListeners();
        try { this.ws.close(); } catch { /* ignore */ }
        this.ws = null;
      }

      const url = this.buildUrl();
      if (!url) {
        this.setState('error', 'WebSocket 地址未配置');
        resolve();
        return;
      }

      this.setState('connecting');

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this.setState('error', (e as Error).message);
        resolve();
        return;
      }

      ws.on('open', () => {
        this.setState('connected');
        this.emit('connect');
        // 拉取登录信息，用于界面展示机器人账号
        void this.call('get_login_info', {}).then((res) => {
          if (res.status === 'ok' && res.data && typeof res.data === 'object') {
            const data = res.data as { user_id?: number; nickname?: string };
            this.selfId = data.user_id != null ? String(data.user_id) : undefined;
            this.selfName = data.nickname;
            this.emit('state', this.getState());
          }
        });
        resolve();
      });

      ws.on('message', (data) => this.onMessage(data.toString()));

      ws.on('error', (err) => {
        // 注意：这里只记录状态，不自己排重连。
        // `ws` 在 close 之前必先 emit 'error'（v8 起还对 error 事件挂了默认监听，
        // 所以不存在「没人监听就抛异常」的问题），重连统一交给 'close' 处理，
        // 免得 error + close 各排一次导致双重重连。
        this.setState('error', this.explainError(err));
      });

      ws.on('close', () => {
        this.failAllPending('连接已关闭');
        if (this.state !== 'error') this.setState('disconnected');
        if (!this.closedByUser && this.config.autoReconnect) this.scheduleReconnect();
      });

      this.ws = ws;
    });
  }

  private buildUrl(): string {
    const base = (this.config.wsUrl || '').trim();
    if (!base) return '';
    if (!this.config.accessToken) return base;
    try {
      const u = new URL(base);
      u.searchParams.set('access_token', this.config.accessToken);
      return u.toString();
    } catch {
      return base;
    }
  }

  /**
   * 把 ws 库的原始错误翻译成能直接照做的中文提示。
   *
   * 这里是踩过坑的：握手被拒时 `err.message` 是 `Unexpected server response: 401`，
   * 而 401 最常见的成因恰恰是「没填 Token」——但原始文案完全看不出来该干什么。
   */
  private explainError(err: Error & { code?: string }): string {
    const msg = err.message || '';
    const hasToken = !!this.config.accessToken;

    // WebSocket 握手阶段被 HTTP 状态码拒绝
    const httpCode = /Unexpected server response:\s*(\d+)/.exec(msg);
    if (httpCode) {
      const code = Number(httpCode[1]);
      if (code === 401 || code === 403) {
        return hasToken
          ? `认证被拒（HTTP ${code}）：Token 与服务端不一致，请核对 SnowLuma 节点配置里的 accessToken`
          : `认证被拒（HTTP ${code}）：服务端要求 Token，但这里留空了。` +
            `请到 SnowLuma 后台 → 节点配置 → WS 服务端，复制 accessToken 填到「访问令牌」`;
      }
      if (code === 404 || code === 426) {
        return `地址不是 OneBot WS 端点（HTTP ${code}）：请确认端口填的是「WS 服务端」的端口，而不是 WebUI 端口`;
      }
      return `握手被拒（HTTP ${code}）：服务端不接受本次连接`;
    }

    // 连接被直接掐断（端口没监听 / 被防火墙拦）
    if (err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) {
      return `连接被拒绝：${this.config.wsUrl} 没有服务在监听。请先启动 SnowLuma，并确认 WS 服务端已启用`;
    }
    if (err.code === 'ECONNRESET' || /ECONNRESET/.test(msg)) {
      return '连接被重置：服务端中途断开了连接（常见于 Token 错误或端口被占用）';
    }
    if (err.code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/.test(msg)) {
      return `域名解析失败：找不到 ${this.config.wsUrl} 对应的主机`;
    }
    if (/ETIMEDOUT|timeout/i.test(msg)) {
      return '连接超时：目标端口无响应，请检查地址与防火墙';
    }
    return msg || '连接失败（未知原因）';
  }

  private scheduleReconnect(): void {
    if (this.config.reconnectIntervalMs <= 0) return;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => void this.connect(), this.config.reconnectIntervalMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  disconnect(): Promise<void> {
    this.closedByUser = true;
    this.clearReconnectTimer();
    return new Promise<void>((resolve) => {
      if (!this.ws) {
        this.setState('disconnected');
        resolve();
        return;
      }
      const ws = this.ws;
      ws.once('close', () => resolve());
      try { ws.close(); } catch { /* ignore */ }
      this.ws = null;
      this.setState('disconnected');
      resolve();
    });
  }

  private onMessage(raw: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const obj = payload as Record<string, unknown>;

    // 带 echo 的是 action 响应；不带 echo 的是事件推送
    if (typeof obj.echo === 'string' || typeof obj.echo === 'number') {
      const key = String(obj.echo);
      const p = this.pending.get(key);
      if (p) {
        this.pending.delete(key);
        clearTimeout(p.timer);
        p.resolve(obj as unknown as ApiResponse);
      }
      return;
    }

    if (obj.post_type === 'message') {
      this.emit('message', obj as unknown as MessageEvent);
    } else {
      this.emit('event', obj);
    }
  }

  private failAllPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ status: 'failed', retcode: -1, data: null, echo: reason } as ApiResponse);
    }
    this.pending.clear();
  }

  /** 调用一个 OneBot action */
  call(action: string, params: Record<string, unknown>, timeoutMs = 10000): Promise<ApiResponse> {
    return new Promise<ApiResponse>((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve({ status: 'failed', retcode: -1, data: null });
        return;
      }
      const echo = `echo-${this.echoSeq++}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        resolve({ status: 'failed', retcode: -1, data: null });
      }, timeoutMs);
      this.pending.set(echo, { resolve, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch {
        this.pending.delete(echo);
        clearTimeout(timer);
        resolve({ status: 'failed', retcode: -1, data: null });
      }
    });
  }

  /** 发送群消息 */
  sendGroupMessage(groupId: string | number, message: string): Promise<ApiResponse> {
    return this.call('send_group_msg', {
      group_id: typeof groupId === 'string' ? Number(groupId) : groupId,
      message,
    });
  }

  /** 发送私聊消息 */
  sendPrivateMessage(userId: string | number, message: string): Promise<ApiResponse> {
    return this.call('send_private_msg', {
      user_id: typeof userId === 'string' ? Number(userId) : userId,
      message,
    });
  }

  /** 设置群名片（用于「绑定后改名」功能） */
  setGroupCard(
    groupId: string | number,
    userId: string | number,
    card: string,
  ): Promise<ApiResponse> {
    return this.call('set_group_card', {
      group_id: typeof groupId === 'string' ? Number(groupId) : groupId,
      user_id: typeof userId === 'string' ? Number(userId) : userId,
      card,
    });
  }

  destroy(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    this.failAllPending('客户端已销毁');
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.setState('disconnected');
  }
}
