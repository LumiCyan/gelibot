#!/usr/bin/env node
/**
 * 通过 GitHub REST API 发布 Release（不依赖 gh CLI）。
 *
 * 为什么不用 gh：这台机器没装，而且出网要过本地代理做 TLS 中间人，
 * 系统证书链校验不过。这里只对本进程关闭证书校验 —— 代理在 127.0.0.1，
 * 不涉及外部第三方，风险可控。
 *
 * 凭证来源：git credential manager 里已有的 PAT（与 git push 用的是同一份），
 * 通过环境变量 GITHUB_TOKEN 传入，脚本本身不读取、不打印。
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/upload-release-api.mjs 2.0.0
 *   GITHUB_TOKEN=xxx node scripts/upload-release-api.mjs 2.0.0 --dry-run
 */
// 代理是本地 MITM，只在本次进程内跳过证书校验
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const VERSION = args.find((a) => /^\d+\.\d+\.\d+$/.test(a)) ?? '2.0.0';
const DRY = args.includes('--dry-run');
const TAG = `v${VERSION}`;
const OWNER = 'LumiCyan';
const REPO = 'gelibot';
const TOKEN = process.env.GITHUB_TOKEN ?? '';

/**
 * 目录后缀用完整版本号。
 *
 * 2.0 那一次用的是 major.minor（release-assets-2.0），结果一个目录里
 * 混着上一版的 asar 和本版的 patch，很容易拿错文件。从 2.0.1 起
 * 每个版本一个目录，传什么一目了然。
 */
const DIR_TAG = VERSION;

const ASSET_DIR = path.join(ROOT, `release-assets-${DIR_TAG}`);
const EXE_DIR = path.join(ROOT, `dist-release-${DIR_TAG}`);
const NOTES = path.join(ROOT, 'docs', `RELEASE-v${VERSION}.md`);

/**
 * 附件表：{ 本地路径, 上传后的文件名 }
 *
 * 为什么 exe 要改名：GitHub 上传 API 会把文件名里的**空格替换成点**
 * （`GeLi Bot v2.0.0.exe` → `GeLi.Bot.v2.0.0.exe`），而清单里的 exeUrl
 * 是客户端拼 URL 用的，必须与实际存储名逐字节一致，否则 404。
 * 所以统一用连字符命名，并在清单里写同一个值。
 */
/**
 * 附件表：完全由 release-manifest.json 推导。
 *
 * 早先这里是硬编码的 2.0.0 文件名，换版本就得改代码 —— 而且漏一个
 * patch 会让老用户「检查更新」拿到 404。现在清单里有几个 patch 就传几个。
 *
 * 注意 exe：清单里的 exeUrl 已是无空格名（GitHub 会把空格转成点，
 * 客户端按清单拼 URL 就会 404），本地文件名则带空格。
 */
const ASSET_DIR_MANIFEST = path.join(ASSET_DIR, 'release-manifest.json');
if (!fs.existsSync(ASSET_DIR_MANIFEST)) {
  console.error(`\u2718 \u627e\u4e0d\u5230\u6e05\u5355\uff1a${ASSET_DIR_MANIFEST}`);
  console.error('  \u5148\u8dd1\uff1anode scripts/build-update-manifest.mjs ' + VERSION + ' old-asar ' + path.basename(ASSET_DIR));
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(ASSET_DIR_MANIFEST, 'utf8'));
if (manifest.version !== VERSION) {
  console.error(`\u2718 \u6e05\u5355\u7248\u672c\u662f ${manifest.version}\uff0c\u4e0e\u8981\u53d1\u5e03\u7684 ${VERSION} \u4e0d\u4e00\u81f4`);
  process.exit(1);
}

const ASSETS = [
  { path: ASSET_DIR_MANIFEST, name: 'release-manifest.json' },
  { path: path.join(ASSET_DIR, manifest.asarUrl), name: manifest.asarUrl },
  ...manifest.patches.map((p) => ({
    path: path.join(ASSET_DIR, p.url),
    name: p.url,
  })),
  ...(manifest.exeUrl
    ? [
        {
          path: path.join(EXE_DIR, `GeLi Bot v${VERSION}.exe`),
          name: manifest.exeUrl,
        },
      ]
    : []),
  {
    path: path.join(EXE_DIR, `GeLi Bot Setup ${VERSION}.exe`),
    name: `GeLi-Bot-Setup-${VERSION}.exe`,
  },
];

if (!TOKEN) {
  console.error('✘ 缺少环境变量 GITHUB_TOKEN');
  process.exit(1);
}

/** 发一个 HTTPS 请求，返回 { status, headers, body } */
function request(method, host, urlPath, { body, headers = {}, stream = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        host,
        path: urlPath,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'gelibot-release',
          'X-GitHub-Api-Version': '2022-11-28',
          ...headers,
        },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(600000, () => req.destroy(new Error('请求超时')));

    if (stream) {
      stream.pipe(req);
    } else {
      if (body) req.write(body);
      req.end();
    }
  });
}

const api = (method, p, body) =>
  request(method, 'api.github.com', p, {
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'Content-Type': 'application/json' } : {},
  });

function fmtSize(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

// ---------------------------------------------------------------- 预检
console.log(`发布 ${TAG} → ${OWNER}/${REPO}\n`);

const manifest = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'release-manifest.json'), 'utf8'));
if (manifest.version !== VERSION) {
  console.error(`✘ 清单版本 ${manifest.version} ≠ ${VERSION}`);
  process.exit(1);
}
for (const a of ASSETS) {
  if (!fs.existsSync(a.path)) {
    console.error(`✘ 缺少文件：${a.path}`);
    process.exit(1);
  }
}
console.log(`✔ 6 个附件就绪，release notes ${fmtSize(fs.statSync(NOTES).size)}`);

// ---------------------------------------------------------------- 1. 创建 Release
const notesBody = fs.readFileSync(NOTES, 'utf8');

let release = null;
const existing = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
if (existing.status === 200) {
  release = JSON.parse(existing.body);
  console.log(`ℹ Release 已存在（id=${release.id}），改为上传/覆盖附件`);
} else {
  if (DRY) {
    console.log(`[dry] POST /repos/${OWNER}/${REPO}/releases  (tag=${TAG})`);
    process.exit(0);
  }
  const created = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: TAG,
    name: `GeLi Bot ${TAG}`,
    body: notesBody,
    draft: false,
    prerelease: false,
    make_latest: 'true',
  });
  if (created.status !== 201) {
    console.error(`✘ 创建 Release 失败（HTTP ${created.status}）\n${created.body.slice(0, 500)}`);
    process.exit(1);
  }
  release = JSON.parse(created.body);
  console.log(`✔ Release 已创建：${release.html_url}`);
}

// ---------------------------------------------------------------- 2. 上传附件
// 先清空现有资产：文件名规则改过（空格 → 连字符），旧的会残留成孤儿
const listRes = await api('GET', `/repos/${OWNER}/${REPO}/releases/${release.id}/assets`);
const existingAssets = listRes.status === 200 ? JSON.parse(listRes.body) : [];
for (const a of existingAssets) {
  if (DRY) {
    console.log(`  [dry] 删除旧资产 ${a.name}`);
    continue;
  }
  const del = await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${a.id}`);
  console.log(`  − 已删除旧资产 ${a.name}（HTTP ${del.status}）`);
}

let okCount = 0;
for (const asset of ASSETS) {
  const size = fs.statSync(asset.path).size;

  if (DRY) {
    console.log(`  [dry] 上传 ${asset.name}（${fmtSize(size)}）`);
    okCount++;
    continue;
  }

  const started = Date.now();
  process.stdout.write(`  ↑ ${asset.name}（${fmtSize(size)}）… `);
  const up = await request(
    'POST',
    'uploads.github.com',
    `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
    {
      stream: fs.createReadStream(asset.path),
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
      },
    },
  );
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (up.status === 201) {
    const stored = JSON.parse(up.body);
    // GitHub 可能改写文件名，这里立刻比对，避免「上传成功但客户端 404」
    if (stored.name !== asset.name) {
      console.log(`✘ 文件名被改写：${asset.name} → ${stored.name}`);
      process.exit(1);
    }
    console.log(`✔ ${fmtSize(stored.size)} / ${secs}s`);
    okCount++;
  } else {
    console.log(`✘ HTTP ${up.status}`);
    console.log(up.body.slice(0, 400));
    process.exit(1);
  }
}

console.log(`\n✔ ${okCount}/${ASSETS.length} 个附件上传完成`);
console.log(`  ${release.html_url}`);

// ---------------------------------------------------------------- 3. 验证清单可访问
if (!DRY) {
  const url = `/repos/${OWNER}/${REPO}/releases/latest`;
  const latest = await api('GET', url);
  const tag = latest.status === 200 ? JSON.parse(latest.body).tag_name : '(查询失败)';
  console.log(`\n最新 Release: ${tag}${tag === TAG ? ' ✔' : ' ⚠'}`);
}
