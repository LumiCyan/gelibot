/**
 * 卡片落盘与 OneBot 消息组装（纯 Node，不依赖 Electron，可单元测试）。
 *
 * 与 card.ts（渲染器）分离的原因：渲染器需要 BrowserWindow，
 * 只能在 Electron 里跑；这一半是纯文件操作，必须能被 npm test 覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * 把 PNG 写进卡片目录并返回 OneBot 可直接发送的消息文本。
 *
 * 文件按内容哈希命名：内容不变就复用同一文件（群里反复查 `/在线`
 * 不会堆出一堆图片），内容变了才产生新文件；顺带清理旧文件。
 */
export function writeCardMessage(
  dir: string,
  png: Buffer,
  opts: { keep?: number } = {},
): string {
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha1').update(png).digest('hex').slice(0, 12);
  const file = path.join(dir, `online-${hash}.png`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, png);
    pruneCards(dir, opts.keep ?? 40, file);
  }
  // CQ 码中的路径用标准 file URL（空格等字符会被正确转义）
  return `[CQ:image,file=${pathToFileURL(file).href}]`;
}

/** 只保留最近 keep 个卡片文件（按 mtime），刚写入的 keepFile 永不删 */
export function pruneCards(dir: string, keep: number, keepFile?: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^online-[0-9a-f]{12}\.png$/.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(keep)) {
      if (keepFile && path.resolve(f.full) === path.resolve(keepFile)) continue;
      try {
        fs.unlinkSync(f.full);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 清理失败不影响发送 */
  }
}
