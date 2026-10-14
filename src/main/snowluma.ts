import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { SnowLumaStatus } from '../shared/types';

/** 日志环形缓冲保留的行数 */
const LOG_LIMIT = 400;

/** 日志里「首次启动凭据」的匹配式 */
const CRED_RE = /initial credentials:\s*user=(\S+)\s+password=(\S+)/i;
/** 日志里「WebUI 开始监听」的匹配式 */
const LISTEN_RE = /listening\s+(https?:\/\/\S+)/i;

/** 从一行日志里提取出来的关键信息 */
export interface ParsedSnowLumaLine {
  /** 首次启动凭据，只有全新数据目录才会有 */
  cred?: { user: string; password: string };
  /** WebUI 监听地址 */
  url?: string;
}

/**
 * 解析一行 SnowLuma 日志。
 *
 * 实测输出形如：
 *   [WebUI] initial credentials: user=admin password=da70a69fa18246f1
 *   [WebUI] listening http://127.0.0.1:5099
 *
 * 注意凭据只在「全新数据目录首次启动」时打印一次，之后重启不会再出现，
 * 所以调用方拿到后要一直保留。
 */
export function parseSnowLumaLine(line: string): ParsedSnowLumaLine | null {
  if (!line) return null;

  const cred = CRED_RE.exec(line);
  if (cred) return { cred: { user: cred[1], password: cred[2] } };

  const listen = LISTEN_RE.exec(line);
  if (listen) return { url: listen[1].replace(/\/+$/, '') };

  return null;
}

export interface SnowLumaOptions {
  /** 用户指定的程序目录，空字符串表示用内置版 */
  customDir: string;
  /** 内置程序目录；null 表示当前构建没有内置 SnowLuma */
  bundledDir: string | null;
  /** 数据目录（作为 cwd），SnowLuma 的 config/ 与 logs/ 都落在这里 */
  dataDir: string;
  /** 默认 WebUI 地址，仅用于界面展示 */
  fallbackWebUrl: string;
}

/** 目录校验结果 */
interface ResolvedDir {
  dir: string | null;
  source: 'bundled' | 'custom' | 'missing';
  reason?: string;
}

/**
 * SnowLuma 进程管理器。
 *
 * 不直接调用发行包里的 `launcher.bat`，原因有二：
 * 1. launcher.bat 依赖 PATH 里的 `node`，而发行包自带 node.exe，直接调更可靠
 * 2. launcher.bat 结尾有 `pause`，进程永不退出，无法做生命周期管理
 *
 * 因此这里直接 spawn `<dir>/node.exe <dir>/index.mjs`，并把 cwd 指向数据目录，
 * 这样程序文件可以只读（放在 resources 里），配置与日志则落到可写且持久的位置。
 */
export class SnowLumaManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private opts: SnowLumaOptions;
  private logs: string[] = [];
  private status: SnowLumaStatus;
  private lineBuf = { out: '', err: '' };
  /** 区分「我们主动停的」与「自己挂掉的」 */
  private stopping = false;

  constructor(opts: SnowLumaOptions) {
    super();
    this.opts = opts;
    this.status = this.baseStatus();
  }

  // ---------- 目录解析 ----------

  /** 校验一个目录是不是可用的 SnowLuma 程序目录 */
  private check(dir: string): string | null {
    if (!dir) return '目录为空';
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      return '目录不存在';
    }
    if (!st.isDirectory()) return '不是目录';
    if (!fs.existsSync(path.join(dir, 'index.mjs'))) return '缺少 index.mjs';
    if (!this.findNode(dir)) return '缺少 node.exe（Lite 版需要另装 Node.js，不受支持）';
    return null;
  }

  /** 找出可用的 node 可执行文件 */
  private findNode(dir: string): string | null {
    for (const name of process.platform === 'win32' ? ['node.exe'] : ['node']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /** 按「自定义优先，其次内置」的顺序选目录 */
  private resolveDir(): ResolvedDir {
    const custom = this.opts.customDir.trim();
    if (custom) {
      const bad = this.check(custom);
      if (!bad) return { dir: custom, source: 'custom' };
      // 自定义目录填了但不可用：明确报错，不要悄悄退回内置版，
      // 否则用户会以为自己在用外部版本
      return { dir: null, source: 'custom', reason: `自定义目录不可用：${bad}` };
    }

    const bundled = this.opts.bundledDir;
    if (bundled) {
      const bad = this.check(bundled);
      if (!bad) return { dir: bundled, source: 'bundled' };
      return { dir: null, source: 'missing', reason: `内置 SnowLuma 不完整：${bad}` };
    }

    return {
      dir: null,
      source: 'missing',
      reason: '没有内置 SnowLuma，请先指定 SnowLuma 程序目录',
    };
  }

  // ---------- 状态 ----------

  private baseStatus(): SnowLumaStatus {
    const r = this.resolveDir();
    return {
      state: 'stopped',
      webUrl: this.opts.fallbackWebUrl,
      dataDir: this.opts.dataDir,
      dirSource: r.source,
      resolvedDir: r.dir ?? undefined,
      listening: false,
      lastError: r.reason,
    };
  }

  getStatus(): SnowLumaStatus {
    return { ...this.status };
  }

  getLog(): string[] {
    return [...this.logs];
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  /** 重新计算目录（配置变更后调用），空闲时同步刷新状态 */
  refresh(): void {
    if (this.isRunning()) return;
    this.status = { ...this.baseStatus(), state: this.status.state === 'exited' ? 'exited' : 'stopped' };
    this.emit('status', this.getStatus());
  }

  /** 配置保存后更新选项（仅在未运行时生效） */
  updateOptions(patch: { customDir?: string; fallbackWebUrl?: string }): void {
    if (patch.customDir !== undefined) this.opts.customDir = patch.customDir;
    if (patch.fallbackWebUrl !== undefined) this.opts.fallbackWebUrl = patch.fallbackWebUrl;
    this.refresh();
  }

  private push(line: string): void {
    const t = line.replace(/\r$/, '');
    if (!t.trim()) return;
    this.logs.push(t);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.inspect(t);
    this.emit('log', t);
  }

  /** 从日志行里提取凭据与监听地址 */
  private inspect(line: string): void {
    const parsed = parseSnowLumaLine(line);
    if (!parsed) return;

    if (parsed.cred) {
      this.status.adminUser = parsed.cred.user;
      this.status.password = parsed.cred.password;
      this.emit('status', this.getStatus());
      return;
    }

    if (parsed.url) {
      const first = !this.status.listening;
      this.status.listening = true;
      this.status.webUrl = parsed.url;
      this.status.state = 'running';
      if (!this.status.startedAt) this.status.startedAt = new Date().toISOString();
      this.emit('status', this.getStatus());
      // 只在第一次监听到时通知，避免重连日志反复触发开浏览器
      if (first) this.emit('web-ready', parsed.url);
    }
  }

  private update(patch: Partial<SnowLumaStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  // ---------- 生命周期 ----------

  /** 启动 SnowLuma */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.isRunning()) return { ok: false, error: 'SnowLuma 已在运行' };

    const r = this.resolveDir();
    const base = this.baseStatus();
    this.status = { ...base, state: 'starting', dirSource: r.source, resolvedDir: r.dir ?? undefined };

    if (!r.dir) {
      this.update({ state: 'error', lastError: r.reason });
      return { ok: false, error: r.reason ?? '找不到 SnowLuma 程序目录' };
    }

    const nodeExe = this.findNode(r.dir);
    if (!nodeExe) {
      const msg = `目录里没有 node.exe：${r.dir}`;
      this.update({ state: 'error', lastError: msg });
      return { ok: false, error: msg };
    }

    // 先探一下 WebUI 端口。若已经有实例在跑（可能是上次没退干净，或用户自己启过），
    // 直接再拉一个只会在端口上撞车然后莫名其妙地退出，不如提前说清楚。
    if (await probeWeb(this.opts.fallbackWebUrl)) {
      const msg = `检测到 ${this.opts.fallbackWebUrl} 上已有 SnowLuma 在运行，请直接点「打开后台」查看；若要重启，请先结束那只进程`;
      this.update({ state: 'error', lastError: msg });
      return { ok: false, error: msg };
    }

    // 数据目录必须存在，SnowLuma 会往里写 config/ 与 logs/
    try {
      fs.mkdirSync(this.opts.dataDir, { recursive: true });
    } catch (err) {
      const msg = `无法创建数据目录：${(err as Error).message}`;
      this.update({ state: 'error', lastError: msg });
      return { ok: false, error: msg };
    }

    // 入口用绝对路径，见下方 spawn 处的说明
    const entry = path.join(r.dir, 'index.mjs');

    this.logs = [];
    this.lineBuf = { out: '', err: '' };
    this.stopping = false;
    this.update({
      state: 'starting',
      listening: false,
      password: undefined,
      adminUser: undefined,
      exitCode: undefined,
      lastError: undefined,
      startedAt: undefined,
    });
    this.push(`[管理器] 程序目录：${r.dir}（${r.source === 'bundled' ? '内置' : '自定义'}）`);
    this.push(`[管理器] 数据目录：${this.opts.dataDir}`);
    this.push(`[管理器] 启动命令：node.exe ${entry}`);

    // 注意：入口脚本必须传绝对路径。
    // Node 是按 cwd 解析相对入口的，而我们把 cwd 设成了数据目录，
    // 传相对路径 'index.mjs' 会去数据目录里找，直接 MODULE_NOT_FOUND。
    let child: ChildProcess;
    try {
      child = spawn(nodeExe, [entry], {
        cwd: this.opts.dataDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
    } catch (err) {
      const msg = `启动失败：${(err as Error).message}`;
      this.update({ state: 'error', lastError: msg });
      return { ok: false, error: msg };
    }

    this.proc = child;
    this.update({ pid: child.pid });

    const wire = (stream: NodeJS.ReadableStream | null, key: 'out' | 'err') => {
      if (!stream) return;
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        const merged = this.lineBuf[key] + chunk;
        const parts = merged.split('\n');
        this.lineBuf[key] = parts.pop() ?? '';
        for (const p of parts) this.push(p);
      });
    };
    wire(child.stdout, 'out');
    wire(child.stderr, 'err');

    child.on('error', (err) => {
      this.proc = null;
      const msg = `进程错误：${err.message}`;
      this.push(`[管理器] ${msg}`);
      this.update({ state: 'error', lastError: msg, listening: false });
    });

    child.on('exit', (code, signal) => {
      // 冲掉缓冲区里最后一行（没有换行结尾的情况）
      if (this.lineBuf.out.trim()) this.push(this.lineBuf.out);
      if (this.lineBuf.err.trim()) this.push(this.lineBuf.err);
      this.lineBuf = { out: '', err: '' };
      this.proc = null;

      const byUs = this.stopping;
      this.stopping = false;
      this.push(`[管理器] SnowLuma 已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
      this.update({
        state: byUs ? 'stopped' : code === 0 ? 'stopped' : 'exited',
        listening: false,
        pid: undefined,
        exitCode: code,
        lastError: byUs || code === 0 ? undefined : `进程意外退出（code=${code ?? signal}）`,
      });
    });

    return { ok: true };
  }

  /** 停止 SnowLuma（连同子进程树） */
  async stop(): Promise<{ ok: boolean; error?: string }> {
    const child = this.proc;
    if (!child || child.exitCode !== null) {
      this.update({ state: 'stopped', listening: false, pid: undefined });
      return { ok: true };
    }

    const pid = child.pid;
    this.stopping = true;
    this.push('[管理器] 正在停止 SnowLuma…');

    if (process.platform === 'win32' && pid) {
      // Node 在 Windows 上不会把信号传给子进程，用 taskkill 结束整棵树
      await new Promise<void>((resolve) => {
        const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        k.on('exit', () => resolve());
        k.on('error', () => resolve());
      });
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 进程可能已经退出 */
      }
    }

    // 等 exit 事件把状态收敛掉，最多等 6 秒
    await new Promise<void>((resolve) => {
      if (!this.proc) return resolve();
      const t = setTimeout(() => resolve(), 6000);
      this.proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });

    if (this.proc) {
      // 还没死透，兜底再补一次
      try {
        this.proc.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
      this.proc = null;
    }
    this.update({ state: 'stopped', listening: false, pid: undefined });
    return { ok: true };
  }
}

/** 生成默认数据目录名（供 main 进程拼接 userData 用） */
export const SNOWLUMA_DATA_SUBDIR = 'snowluma';

/**
 * 探测地址上是否已经有东西在监听（用来发现「已经有一只 SnowLuma 在跑」）。
 * 只要 TCP 连上并回了响应就算有，不看状态码——WebUI 可能返回 401/403 也算活着。
 */
export function probeWeb(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return finish(false);
    }

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname || '/',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        finish(true);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.on('error', () => finish(false));
    req.end();
  });
}
