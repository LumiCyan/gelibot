#!/usr/bin/env node
/**
 * 拉取并解压内置用的 SnowLuma 运行包到项目根目录的 snowluma/。
 *
 * 为什么不把 snowluma/ 提交进仓库：
 *   它有 97 MB（含自带的 node.exe），且是**第三方**产物。
 *   放进 git 会让仓库臃肿，也有再分发许可上的问题。
 *   所以只在构建 exe 时需要它，按需拉取即可。
 *
 * 用法：
 *   node scripts/fetch-snowluma.mjs              # 用默认版本
 *   node scripts/fetch-snowluma.mjs 1.14.22      # 指定版本
 *   node scripts/fetch-snowluma.mjs --force      # 已存在也重新下载
 *
 * 网络受限时（GitHub 直连被墙）会自动改用镜像，可用环境变量覆盖：
 *   SL_MIRROR=https://gh-proxy.com/ node scripts/fetch-snowluma.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'snowluma');

const args = process.argv.slice(2);
const force = args.includes('--force');
const version = args.find((a) => !a.startsWith('--')) || '1.14.22';

const ASSET = `SnowLuma-v${version}-win-x64.zip`;
const UPSTREAM = `https://github.com/SnowLuma/SnowLuma/releases/download/v${version}/${ASSET}`;

/** 直连优先，失败后依次尝试镜像 */
const MIRRORS = [
  '',
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
];

const overrideMirror = process.env.SL_MIRROR;
const sources = overrideMirror
  ? [`${overrideMirror}${UPSTREAM}`]
  : MIRRORS.map((m) => `${m}${UPSTREAM}`);

function log(msg) {
  console.log(`[snowluma] ${msg}`);
}

function find7z() {
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    '/usr/bin/7z',
    '/usr/local/bin/7z',
    '7z',
    '7za',
  ];
  for (const c of candidates) {
    try {
      if (c.includes('/') || c.includes('\\')) {
        if (!fs.existsSync(c)) continue;
      }
      execFileSync(c, ['i'], { stdio: 'ignore' });
      return c;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

async function download(url, out) {
  log(`尝试下载：${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // ZIP 魔数校验，避免把 HTML 错误页当成压缩包
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`返回内容不是 ZIP（前 4 字节 ${buf.subarray(0, 4).toString('hex')}）`);
  }
  fs.writeFileSync(out, buf);
  return buf.length;
}

async function main() {
  if (fs.existsSync(dest) && !force) {
    const hasEntry = fs.existsSync(path.join(dest, 'index.mjs'));
    if (hasEntry) {
      log(`snowluma/ 已存在且含 index.mjs，跳过。要重新拉取请加 --force`);
      return;
    }
    log(`snowluma/ 存在但不完整，重新拉取`);
  }

  const zip = path.join(root, '.snowluma-download.zip');
  let ok = false;
  let lastErr = null;
  for (const url of sources) {
    try {
      const size = await download(url, zip);
      log(`下载成功：${(size / 1024 / 1024).toFixed(1)} MB`);
      ok = true;
      break;
    } catch (err) {
      lastErr = err;
      log(`失败：${err.message}`);
    }
  }
  if (!ok) {
    console.error('');
    console.error('下载失败。可手动下载后解压到 snowluma/ 目录：');
    console.error(`  ${UPSTREAM}`);
    console.error('');
    console.error(`最后错误：${lastErr && lastErr.message}`);
    process.exit(1);
  }

  const sz = find7z();
  if (!sz) {
    console.error('');
    console.error('未找到 7-Zip。请安装 7-Zip，或用资源管理器手动解压：');
    console.error(`  ${zip}  ->  ${dest}`);
    console.error('');
    process.exit(1);
  }

  log(`解压中（${path.basename(sz)}）…`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execFileSync(sz, ['x', zip, `-o${dest}`, '-y'], { stdio: 'ignore' });

  // 有些包会多套一层目录，这里拍平
  const entries = fs.readdirSync(dest);
  if (entries.length === 1) {
    const inner = path.join(dest, entries[0]);
    if (fs.statSync(inner).isDirectory() && fs.existsSync(path.join(inner, 'index.mjs'))) {
      log('检测到多套一层目录，正在拍平');
      for (const f of fs.readdirSync(inner)) {
        fs.renameSync(path.join(inner, f), path.join(dest, f));
      }
      fs.rmdirSync(inner);
    }
  }

  fs.rmSync(zip, { force: true });

  const okEntry = fs.existsSync(path.join(dest, 'index.mjs'));
  const okNode = fs.existsSync(path.join(dest, 'node.exe'));
  const files = fs.readdirSync(dest).length;

  log('');
  log(`完成：snowluma/ 共 ${files} 项`);
  log(`  index.mjs : ${okEntry ? '✔' : '✘'}`);
  log(`  node.exe  : ${okNode ? '✔' : '✘'}`);
  if (!okEntry || !okNode) {
    console.error('包内容不完整，请检查。');
    process.exit(1);
  }
  log('');
  log('可以打包了：npm run dist');
}

main().catch((err) => {
  console.error('意外错误：', err);
  process.exit(1);
});
