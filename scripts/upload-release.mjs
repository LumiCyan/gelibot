#!/usr/bin/env node
/**
 * 一键发布：创建 GitHub Release 并上传全部资产。
 *
 * 为什么要这个脚本：Release 附件必须**文件名逐字节匹配**清单里的字段，
 * 手动拖文件很容易改错（尤其 `GeLi Bot v2.0.0.exe` 里有空格）。
 * 这里按清单自动拼参数，杜绝手滑。
 *
 * 前置：
 *   1. 装 GitHub CLI：winget install GitHub.cli
 *   2. 登录：gh auth login（浏览器授权，不用手抄 token）
 *
 * 用法：
 *   node scripts/upload-release.mjs            # 上传 2.0.0
 *   node scripts/upload-release.mjs --dry-run  # 只打印将执行的命令
 *   node scripts/upload-release.mjs --push-code # 同时推送源码与 tag
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const VERSION = '2.0.0';
const TAG = `v${VERSION}`;
const REPO = 'lumicyan/gelibot';
const ASSET_DIR = path.join(ROOT, 'release-assets-2.0');
const EXE_DIR = path.join(ROOT, 'dist-release-2.0');
const NOTES = path.join(ROOT, 'docs', `RELEASE-v${VERSION}.md`);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const pushCode = args.includes('--push-code');

/** 要上传的附件（顺序无所谓，但名字必须与清单一致） */
const ASSETS = [
  path.join(ASSET_DIR, 'release-manifest.json'),
  path.join(ASSET_DIR, `app-${VERSION}.asar`),
  path.join(ASSET_DIR, 'app-1.17.0-to-2.0.0.patch'),
  path.join(ASSET_DIR, 'app-1.18.0-to-2.0.0.patch'),
  path.join(EXE_DIR, `GeLi Bot v${VERSION}.exe`),
  path.join(EXE_DIR, `GeLi Bot Setup ${VERSION}.exe`),
];

function die(msg, hint) {
  console.error(`\n✘ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function hasGh() {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

function ghLoggedIn() {
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  return r.status === 0;
}

// ---------------------------------------------------------------- 预检
console.log(`发布 GeLi Bot ${TAG} → ${REPO}\n`);

if (!fs.existsSync(NOTES)) die(`找不到 release notes：${NOTES}`);
for (const a of ASSETS) {
  if (!fs.existsSync(a)) {
    die(
      `缺少附件：${path.basename(a)}`,
      `先运行 npm run dist 与 node scripts/build-update-manifest.mjs ${VERSION} old-asar release-assets-2.0`,
    );
  }
}

// 校验清单与实际文件一致（大小 + sha256），防止传错版本
{
  const manifestPath = path.join(ASSET_DIR, 'release-manifest.json');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (m.version !== VERSION) die(`清单版本是 ${m.version}，期望 ${VERSION}`);

  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  const exePath = path.join(EXE_DIR, `GeLi Bot v${VERSION}.exe`);
  if (m.exeSha256 && sha(exePath) !== m.exeSha256) {
    die('portable exe 的 sha256 与清单不符', '产物可能没重新打包，请重跑 npm run dist');
  }
  const asarPath = path.join(ASSET_DIR, `app-${VERSION}.asar`);
  if (sha(asarPath) !== m.asarSha256) {
    die('asar 的 sha256 与清单不符', '请重新生成清单');
  }
  for (const p of m.patches ?? []) {
    const pp = path.join(ASSET_DIR, p.url);
    if (!fs.existsSync(pp)) die(`清单引用的差量包不存在：${p.url}`);
    if (sha(pp) !== p.sha256) die(`差量包 sha256 不符：${p.url}`);
  }
  console.log('✔ 清单与产物一致（sha256 已比对）');
  console.log(`  版本 ${m.version} · ${m.patches.length} 个差量包 · exe ${(m.exeSize / 1024 / 1024).toFixed(1)} MB`);
}

if (!hasGh()) {
  die(
    '没有找到 GitHub CLI（gh）',
    '装一下：winget install GitHub.cli   然后 gh auth login',
  );
}
if (!ghLoggedIn()) {
  die('gh 还没登录', '执行：gh auth login（选 GitHub.com → HTTPS → 浏览器授权）');
}

// ---------------------------------------------------------------- 可选：推代码
if (pushCode) {
  console.log('\n[1/2] 推送源码与 tag…');
  const steps = [
    ['git', ['add', '-A']],
    ['git', ['commit', '-m', `release: v${VERSION}`]],
    ['git', ['tag', '-a', TAG, '-m', `GeLi Bot ${TAG}`]],
    ['git', ['push', 'origin', 'HEAD']],
    ['git', ['push', 'origin', TAG]],
  ];
  for (const [cmd, argv] of steps) {
    console.log(`  $ ${cmd} ${argv.join(' ')}`);
    if (dryRun) continue;
    // commit 在没有改动时会失败，属于正常，不中断
    const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0 && !(argv[0] === 'commit')) {
      die(`命令失败：${cmd} ${argv.join(' ')}`);
    }
  }
}

// ---------------------------------------------------------------- 创建 Release
console.log(`\n[2/2] 创建 Release ${TAG} 并上传 ${ASSETS.length} 个附件…`);
const ghArgs = [
  'release',
  'create',
  TAG,
  ...ASSETS,
  '--repo',
  REPO,
  '--title',
  `GeLi Bot ${TAG}`,
  '--notes-file',
  NOTES,
];

console.log(`\n$ gh ${ghArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`);
if (dryRun) {
  console.log('（--dry-run，未真正执行）');
  process.exit(0);
}

const res = spawnSync('gh', ghArgs, { cwd: ROOT, stdio: 'inherit' });
if (res.status !== 0) die('gh release create 失败（若 Release 已存在，加 --repo 后手动上传或用 gh release upload）');

// ---------------------------------------------------------------- 验证
console.log('\n验证清单可访问性…');
const url = `https://github.com/${REPO}/releases/latest/download/release-manifest.json`;
try {
  const out = execFileSync(
    'curl',
    ['-sL', '-o', '/dev/null', '-w', '%{http_code}', url],
    { encoding: 'utf8' },
  ).trim();
  if (out === '200') {
    console.log(`✔ ${url} → 200`);
  } else {
    console.log(`⚠ ${url} → ${out}（GitHub CDN 可能有延迟，稍等再试）`);
  }
} catch {
  console.log('⚠ 无法验证（curl 不可用），请手动打开上面的链接确认');
}

console.log('\n完成 🎉');
