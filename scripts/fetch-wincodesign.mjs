/**
 * 预置 winCodeSign 工具链到 electron-builder 缓存。
 *
 * 为什么需要它：electron-builder 要用 winCodeSign 里的 rcedit-x64.exe
 * 把 build/icon.ico **写进 exe**。没有它，打包时会去 GitHub 下载（受限网络必超时）。
 * 更糟的是如果因此设了 `signAndEditExecutable: false` 来绕开下载，
 * 图标嵌入也会被一起关掉——exe 上会显示 Electron 默认图标。
 *
 * 所以做法是：把工具链提前放进缓存，然后正常打包（签名会因无证书自然跳过，
 * 但图标照常嵌入）。
 *
 * 用法: node scripts/fetch-wincodesign.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '2.6.0';
const ARCHIVE = `winCodeSign-${VERSION}.7z`;

const CACHE_BASE = process.env.ELECTRON_BUILDER_CACHE
  || path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache');
const CACHE_DIR = path.join(CACHE_BASE, 'winCodeSign');

// rcedit 是真正干活的工具；它在就说明工具链齐了
const SENTINEL = path.join(CACHE_DIR, 'rcedit-x64.exe');

const MIRRORS = [
  'https://npmmirror.com/mirrors/electron-builder-binaries/',
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/',
  process.env.WCS_MIRROR, // 可用 WCS_MIRROR 覆盖
].filter(Boolean);

function log(...args) {
  console.log('[wincodesign]', ...args);
}

/** 找一个可用的解压工具：优先项目内的 7za，其次 PATH 里的 7z */
function find7z() {
  const local = path.join(process.cwd(), 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (fs.existsSync(local)) return local;
  for (const cand of ['7za', '7z']) {
    try {
      execFileSync(cand, ['i'], { stdio: 'ignore' });
      return cand;
    } catch (_) {}
  }
  throw new Error('找不到 7z 解压工具（需要 node_modules/7zip-bin 或 PATH 里的 7z）');
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 校验 7z 魔数，避免把错误页存下来
  if (buf.length < 6 || buf.toString('hex', 0, 6) !== '377abcaf271c') {
    throw new Error(`响应不是 7z（前 6 字节 ${buf.toString('hex', 0, 6)}）`);
  }
  return buf;
}

async function main() {
  if (fs.existsSync(SENTINEL)) {
    log(`已存在，跳过：${SENTINEL}`);
    return;
  }

  fs.mkdirSync(CACHE_BASE, { recursive: true });

  let buf = null;
  let lastErr = null;
  for (const base of MIRRORS) {
    const url = `${base}${ARCHIVE}`;
    try {
      log(`尝试下载 ${url}`);
      buf = await download(url);
      log(`成功，${buf.length} 字节`);
      break;
    } catch (e) {
      lastErr = e;
      log(`失败：${e.message}`);
    }
  }
  if (!buf) throw new Error(`所有镜像都下载失败：${lastErr && lastErr.message}`);

  const tmp = path.join(CACHE_BASE, ARCHIVE);
  fs.writeFileSync(tmp, buf);

  const sevenZip = find7z();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  try {
    execFileSync(sevenZip, ['x', '-y', `-o${CACHE_DIR}`, tmp], { stdio: 'inherit' });
  } catch (e) {
    // macOS 的 .dylib 符号链接在 Windows 上建不了，属预期内，不影响 Windows 工具
    log('解压返回非零（macOS 符号链接权限所致，通常可忽略）');
  }

  if (!fs.existsSync(SENTINEL)) {
    throw new Error(`解压后仍未找到 ${SENTINEL}，请检查归档结构`);
  }
  fs.rmSync(tmp, { force: true });
  log(`完成：${CACHE_DIR}`);
}

main().catch((e) => {
  console.error('[wincodesign] 失败:', e.message);
  process.exit(1);
});
