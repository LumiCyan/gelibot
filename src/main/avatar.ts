/**
 * QQ 头像获取与缓存。
 *
 * 走腾讯官方头像 CDN（免鉴权）：
 *   https://q1.qlogo.cn/g?b=qq&nk=<QQ号>&s=100     主用
 *   https://q.qlogo.cn/headimg_dl?dst_uin=<QQ>&spec=100  备用
 *
 * 设计要点：
 *  - 网络层依赖注入（生产用 Electron net.fetch，走 Chromium 网络栈，
 *    不受 Node TLS 证书吊销检查的影响；测试注入 mock）
 *  - 值以 base64 data URL 返回，卡片模板直接内嵌，渲染时零网络依赖
 *  - 磁盘缓存 data/avatars/<QQ>.<ext>，默认 7 天过期
 *  - 任何失败都返回 null —— 卡片侧回退为首字母色块，绝不因头像拖垮整张图
 */
import fs from 'node:fs';
import path from 'node:path';

/** 窄化的 fetch 形状：够用且方便在测试里 mock */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface AvatarCacheOptions {
  /** 缓存目录 */
  dir: string;
  /** 缓存有效期，默认 7 天 */
  ttlMs?: number;
  /** 网络实现；缺省时 get() 直接返回 null（只吃缓存） */
  fetchImpl?: FetchLike;
  /** 时间源，测试用 */
  now?: () => number;
  /** 单次请求超时，默认 8 秒 */
  timeoutMs?: number;
  /** 上传下载并发上限，默认 4 */
  maxConcurrent?: number;
  /** 日志（默认静默） */
  log?: (msg: string) => void;
}

const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 按魔数嗅探图片类型 —— 这个接口有时返回 JPEG 有时返回 PNG，不能写死 */
export function sniffImageExt(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return '.webp';
  return null;
}

/** QQ 号是否长得像 QQ 号（防注入路径 / 防把别的字符串当文件名） */
export function isSaneQq(qq: string): boolean {
  return /^\d{5,12}$/.test(qq);
}

export class AvatarCache {
  private dir: string;
  private ttlMs: number;
  private fetchImpl?: FetchLike;
  private now: () => number;
  private timeoutMs: number;
  private maxConcurrent: number;
  private log: (msg: string) => void;

  /** 内存缓存：qq -> { dataUrl, at } */
  private mem = new Map<string, { dataUrl: string; at: number }>();
  /** 并发闸门 */
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(opts: AvatarCacheOptions) {
    this.dir = opts.dir;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL;
    this.fetchImpl = opts.fetchImpl;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 4);
    this.log = opts.log ?? (() => undefined);
  }

  /** 取头像；返回 data URL，取不到返回 null */
  async get(qq: string): Promise<string | null> {
    if (!isSaneQq(qq)) return null;

    const hit = this.mem.get(qq);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.dataUrl;

    // 磁盘缓存
    const cached = this.readDisk(qq);
    if (cached) {
      this.mem.set(qq, { dataUrl: cached, at: this.now() });
      return cached;
    }

    if (!this.fetchImpl) return null;

    await this.acquire();
    try {
      const dataUrl = await this.fetchAndStore(qq);
      if (dataUrl) this.mem.set(qq, { dataUrl, at: this.now() });
      return dataUrl;
    } catch (err) {
      this.log(`头像获取失败 QQ ${qq}: ${(err as Error).message}`);
      return null;
    } finally {
      this.release();
    }
  }

  /** 批量取；返回 qq -> dataUrl 的映射（失败的不在表里） */
  async getMany(qqs: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
      Array.from(new Set(qqs)).map(async (qq) => {
        const v = await this.get(qq);
        if (v) out.set(qq, v);
      }),
    );
    return out;
  }

  /** 清空内存缓存（磁盘不动） */
  clearMemory(): void {
    this.mem.clear();
  }

  // ---------------------------------------------------------------- 内部

  private readDisk(qq: string): string | null {
    for (const ext of Object.keys(MIME_BY_EXT)) {
      const file = path.join(this.dir, qq + ext);
      try {
        const st = fs.statSync(file);
        if (this.now() - st.mtimeMs >= this.ttlMs) continue; // 过期
        const buf = fs.readFileSync(file);
        if (buf.length < 64) continue;
        return `data:${MIME_BY_EXT[ext]};base64,${buf.toString('base64')}`;
      } catch {
        // 不存在，试下一种扩展名
      }
    }
    return null;
  }

  private async fetchAndStore(qq: string): Promise<string | null> {
    const urls = [
      `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`,
      `https://q.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=100`,
    ];
    for (const url of urls) {
      try {
        const res = await this.fetchImpl!(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 64) continue; // 明显不是图片
        const ext = sniffImageExt(buf);
        if (!ext) continue;

        // 写盘失败不影响本次返回
        try {
          fs.mkdirSync(this.dir, { recursive: true });
          fs.writeFileSync(path.join(this.dir, qq + ext), buf);
        } catch (err) {
          this.log(`头像写缓存失败 QQ ${qq}: ${(err as Error).message}`);
        }
        return `data:${MIME_BY_EXT[ext]};base64,${buf.toString('base64')}`;
      } catch (err) {
        this.log(`头像请求失败（${url}）: ${(err as Error).message}`);
      }
    }
    return null;
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}
