/**
 * 带 app-builder 兼容补丁的打包脚本。
 *
 * 为什么需要它：
 *   electron-builder 会调用 app-builder（Go 程序）解压 winCodeSign 工具链，
 *   解压命令固定带 `-snld`（启用符号链接还原）。但 winCodeSign-2.6.0.7z 内含
 *   两条 macOS 符号链接：
 *       darwin/10.12/lib/libcrypto.dylib -> libcrypto.1.0.0.dylib
 *       darwin/10.12/lib/libssl.dylib    -> libssl.1.0.0.dylib
 *   普通 Windows 账户没有 SeCreateSymbolicLinkPrivilege，7za 会报
 *       ERROR: Cannot create symbolic link : 客户端没有所需的特权
 *   并以退出码 2 结束。app-builder 视非 0 为失败，重试 3 次后放弃 ——
 *   而它发生在 signAndEditResources（写入 exe 图标）**之前**，
 *   结果就是打出来的 exe 顶着 Electron 默认的电子轨道图标。
 *
 * 做法（二进制补丁，最干净）：
 *   app-builder.exe 里 `-snld` 这个字面量只出现一次（实测偏移 9019367），
 *   而 7-Zip 的 `-snl-` 恰好也是 5 个 ASCII 字节，可以原地等长替换，
 *   不需要改长度、不需要重算校验和。
 *
 *   补丁后 app-builder 会以 `-snl-` 调用 7za，即「不要还原符号链接」，
 *   Windows 上 7za 退出码为 0，解压正常完成。被跳过的两条 .dylib 只是
 *   macOS 构建用的快捷方式，Windows 打包完全用不到
 *   （我们只需要 windows-10/ 与 rcedit-x64.exe）。
 *
 *   通过官方的 CUSTOM_APP_BUILDER_PATH 环境变量指向打补丁后的副本，
 *   不修改 node_modules 原始文件，npm install 后依然可用。
 *
 * 用法：node scripts/build-release.mjs [--dir]
 *   环境变量 GC_OUT_DIR 可指定输出目录，默认 dist-release。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const NEEDLE = Buffer.from('-snld', 'ascii');
const REPLACEMENT = Buffer.from('-snl-', 'ascii');

/**
 * 把 app-builder.exe 里的 `-snld` 打成 `-snl-`，输出到 .stage/bin/。
 * 幂等：若源文件里 `-snld` 已不存在（已打过补丁），则直接复用已有产物。
 *
 * @returns {string|null} 补丁后二进制的绝对路径；非 Windows 返回 null
 */
function patchAppBuilder() {
  if (!isWin) return null;

  const src = path.join(
    ROOT, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe',
  );
  if (!fs.existsSync(src)) {
    throw new Error(`找不到 app-builder.exe: ${src}`);
  }

  const outDir = path.join(ROOT, '.stage', 'bin');
  fs.mkdirSync(outDir, { recursive: true });
  const dst = path.join(outDir, 'app-builder.exe');
  // 源文件指纹，用于判断是否需要重新打补丁
  const srcHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(src))
    .digest('hex')
    .slice(0, 16);
  const stampFile = path.join(outDir, 'app-builder.src-sha256');

  if (
    fs.existsSync(dst) &&
    fs.existsSync(stampFile) &&
    fs.readFileSync(stampFile, 'utf8').trim() === srcHash
  ) {
    console.log('[build-release] app-builder 补丁已是最新，复用缓存');
    return dst;
  }

  const buf = Buffer.from(fs.readFileSync(src));
  const at = buf.indexOf(NEEDLE);
  if (at === -1) {
    // 已经是 -snl- 或上游改了实现，直接用原文件
    console.warn('[build-release] 未找到 `-snld` 字面量，改用原始 app-builder');
    fs.copyFileSync(src, dst);
    fs.writeFileSync(stampFile, srcHash);
    return dst;
  }
  const second = buf.indexOf(NEEDLE, at + 1);
  if (second !== -1) {
    console.warn(
      `[build-release] 警告：\`-snld\` 出现多次（${at}, ${second}...），` +
        '仅替换第一处。若打包仍失败请人工检查。',
    );
  }
  REPLACEMENT.copy(buf, at);
  fs.writeFileSync(dst, buf);
  fs.writeFileSync(stampFile, srcHash);
  console.log(
    `[build-release] 已打补丁 app-builder：偏移 ${at} 处 -snld -> -snl-`,
  );
  return dst;
}

// --- 1. 打补丁 --------------------------------------------------------------
let patchedBuilder = null;
try {
  patchedBuilder = patchAppBuilder();
} catch (err) {
  console.warn(`[build-release] app-builder 补丁失败，将使用原版：${err.message}`);
}

// --- 1.5 预置工具链（winCodeSign 写图标 + NSIS 编译安装包） -----------------
// 都是幂等的：脚本内部检测到已缓存就跳过。联网失败这里只告警不中断，
// 让 electron-builder 自己去下载兜底（或明确报错）。
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fetch-wincodesign.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (err) {
  console.warn('[build-release] winCodeSign 预置失败：', err.message);
}
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fetch-nsis.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (err) {
  console.warn('[build-release] NSIS 预置失败：', err.message);
}

// --- 2. 组装环境变量 --------------------------------------------------------
const env = { ...process.env };
if (patchedBuilder) {
  env.CUSTOM_APP_BUILDER_PATH = patchedBuilder;
  console.log(`[build-release] CUSTOM_APP_BUILDER_PATH=${patchedBuilder}`);
}
env.ELECTRON_BUILDER_BINARIES_MIRROR =
  env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

// --- 3. 调用 electron-builder ----------------------------------------------
// 直接调 cli.js 而非 `npx electron-builder`：受限网络/环境里 node_modules/.bin
// 可能缺失（npx 找不到可执行入口），直接调入口文件最稳。
const ebCli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
if (!fs.existsSync(ebCli)) {
  console.error(`[build-release] 找不到 electron-builder 入口：${ebCli}`);
  process.exit(1);
}
const dirOnly = process.argv.includes('--dir');
const args = [
  ebCli,
  '--config',
  'electron-builder.config.js',
  '--win',
];
if (dirOnly) args.push('--dir');

console.log('[build-release] npm run build ...');
const build = spawnSync('npm', ['run', 'build'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  shell: true,
});
if (build.status !== 0) {
  console.error(`[build-release] npm run build 失败，退出码 ${build.status}`);
  process.exit(build.status ?? 1);
}

const outDir = env.GC_OUT_DIR || 'dist-release';
console.log(`[build-release] electron-builder -> ${outDir} ...`);
const res = spawnSync(process.execPath, args, {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  shell: true,
});
process.exit(res.status ?? 1);
