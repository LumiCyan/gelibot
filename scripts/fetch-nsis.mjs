/**
 * 预置 NSIS 工具链到 electron-builder 缓存。
 *
 * 打安装程序（NSIS 目标）时 electron-builder 需要两样东西：
 *   - nsis-3.0.4.1.7z            NSIS 编译器本体（makensis.exe 等）
 *   - nsis-resources-3.4.1.7z    默认安装界面资源（多语言界面、图标等）
 *
 * 默认都会去 GitHub 下载，受限网络必超时。这里和 fetch-wincodesign.mjs
 * 一样，把它们从 npmmirror 镜像提前放进缓存目录。
 *
 * 用法: node scripts/fetch-nsis.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 与 electron-builder 25.x 锁定的版本一致
const NSIS_VERSION = '3.0.4.1';
const NSIS_RES_VERSION = '3.4.1';
const ARCHIVES = [
  `nsis-${NSIS_VERSION}.7z`,
  `nsis-resources-${NSIS_RES_VERSION}.7z`,
];

const CACHE_BASE = process.env.ELECTRON_BUILDER_CACHE
  || path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache');

const MIRRORS = [
  'https://npmmirror.com/mirrors/electron-builder-binaries/',
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/',
  process.env.NSIS_MIRROR,
].filter(Boolean);

function log(...args) {
  console.log('[nsis]', ...args);
}

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
  // 校验 7z 魔数，避免把错误页/重定向页存下来
  if (buf.length < 6 || buf.toString('hex', 0, 6) !== '377abcaf271c') {
    throw new Error(`响应不是 7z（前 6 字节 ${buf.toString('hex', 0, 6)}）`);
  }
  return buf;
}

async function ensureArchive(archive) {
  // electron-builder 的缓存约定：工具链解压后放在 Cache/<dirName>/，
  // dirName = 归档名去掉 .7z（如 Cache/nsis-3.0.4.1/），里面直接是 Bin/makensis.exe。
  const dirName = archive.replace('.7z', '');
  const cacheDir = path.join(CACHE_BASE, dirName);
  // sentinel 因包而异：nsis 主包有 Bin/makensis.exe，resources 包只有 plugins/
  const sentinel = archive.startsWith('nsis-resources')
    ? path.join(cacheDir, 'plugins')
    : path.join(cacheDir, 'Bin', 'makensis.exe');
  if (fs.existsSync(sentinel)) {
    log(`已存在，跳过：${cacheDir}`);
    return;
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  let buf = null;
  let lastErr = null;
  for (const base of MIRRORS) {
    // 真实 URL 带一层目录：.../download/<dirName>/<dirName>.7z
    const url = `${base}${dirName}/${archive}`;
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

  const tmp = path.join(cacheDir, archive);
  fs.writeFileSync(tmp, buf);

  const sevenZip = find7z();
  try {
    // 解压到 cacheDir，归档内是扁平的（Bin/、Include/ 等直接铺开）
    execFileSync(sevenZip, ['x', '-y', `-o${cacheDir}`, tmp], { stdio: 'inherit' });
  } catch (e) {
    log('解压返回非零，检查目录是否已生成');
  }
  fs.rmSync(tmp, { force: true });

  if (!fs.existsSync(sentinel)) {
    throw new Error(`解压后仍未找到 ${sentinel}，请检查归档结构`);
  }
  log(`完成：${cacheDir}`);
}

async function main() {
  for (const archive of ARCHIVES) {
    await ensureArchive(archive);
  }
  log('NSIS 工具链就绪');
}

main().catch((e) => {
  console.error('[nsis] 失败:', e.message);
  process.exit(1);
});
