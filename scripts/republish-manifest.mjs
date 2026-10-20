#!/usr/bin/env node
/**
 * 就地修补已发布版本的 release-manifest.json（只替换清单附件，不动其它附件）。
 *
 * 用途：清单里如果写了相对文件名，客户端要自己拼地址；拼错一次就会让所有
 * 已发布的旧客户端「检查更新成功、下载更新失败」。这种 bug 不能靠发新版
 * 解决 —— 卡住的正是老版本。所以必须能单独把清单换掉。
 *
 * 做的事：
 * 1. 把 asarUrl / exeUrl / patches[].url 统一改写成绝对 URL；
 * 2. 删掉该 Release 上旧的 release-manifest.json 附件，重新上传；
 * 3. 从 `releases/latest/download/release-manifest.json` 拉回来核对。
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/republish-manifest.mjs 2.0.1
 *   GITHUB_TOKEN=xxx node scripts/republish-manifest.mjs 2.0.1 --dry-run
 *
 * 注意：只改「已经发布过」的清单，sha256 / size 等字段原样保留 —— 附件内容
 * 没变，改的只是地址写法。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 本地代理是 MITM，仅本进程放宽

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const VERSION = args.find((a) => /^\d+\.\d+\.\d+$/.test(a)) ?? '';
const DRY = args.includes('--dry-run');
const OWNER = 'LumiCyan';
const REPO = 'gelibot';
const TOKEN = process.env.GITHUB_TOKEN ?? '';
const TAG = `v${VERSION}`;

if (!VERSION) {
  console.error('用法: node scripts/republish-manifest.mjs <版本号> [--dry-run]');
  process.exit(1);
}
if (!TOKEN && !DRY) {
  console.error('✘ 缺少环境变量 GITHUB_TOKEN');
  process.exit(1);
}

const MANIFEST_PATH = path.join(ROOT, `release-assets-${VERSION}`, 'release-manifest.json');
if (!fs.existsSync(MANIFEST_PATH)) {
  console.error(`✘ 找不到清单：${MANIFEST_PATH}`);
  process.exit(1);
}

/** 把任意写法的附件地址补成绝对 URL（已经是绝对的保持不变） */
function absolutize(u) {
  const raw = String(u ?? '').trim();
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  const name = raw.split('/').pop();
  return `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${name}`;
}

// ---------------------------------------------------------------- 1. 改写清单
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
if (manifest.version !== VERSION) {
  console.error(`✘ 清单版本是 ${manifest.version}，与 ${VERSION} 不一致`);
  process.exit(1);
}

const before = {
  asarUrl: manifest.asarUrl,
  exeUrl: manifest.exeUrl,
  patches: manifest.patches.map((p) => p.url),
};

manifest.asarUrl = absolutize(manifest.asarUrl);
if (manifest.exeUrl) manifest.exeUrl = absolutize(manifest.exeUrl);
for (const p of manifest.patches) p.url = absolutize(p.url);

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`✔ 清单已改写为绝对地址：${path.relative(ROOT, MANIFEST_PATH)}`);
console.log(`  asarUrl : ${before.asarUrl}`);
console.log(`         → ${manifest.asarUrl}`);
if (manifest.exeUrl) {
  console.log(`  exeUrl  : ${before.exeUrl}`);
  console.log(`         → ${manifest.exeUrl}`);
}
console.log(`  patches : ${manifest.patches.length} 个，地址同样改为绝对`);

// ---------------------------------------------------------------- 2. 替换远端附件
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
          'User-Agent': 'gelibot-manifest-fix',
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
    req.setTimeout(300000, () => req.destroy(new Error('请求超时')));
    if (stream) stream.pipe(req);
    else {
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

const rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
if (rel.status !== 200) {
  console.error(`✘ 取 Release ${TAG} 失败（HTTP ${rel.status}）`);
  process.exit(1);
}
const release = JSON.parse(rel.body);
console.log(`\nRelease ${TAG}（id=${release.id}）`);

const list = await api('GET', `/repos/${OWNER}/${REPO}/releases/${release.id}/assets`);
const assets = list.status === 200 ? JSON.parse(list.body) : [];
const old = assets.find((a) => a.name === 'release-manifest.json');

if (DRY) {
  if (old) console.log(`  [dry] 删除旧清单附件 id=${old.id}`);
  console.log('  [dry] 重新上传 release-manifest.json');
  process.exit(0);
}

if (old) {
  const del = await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${old.id}`);
  console.log(`  − 已删除旧清单（HTTP ${del.status}）`);
}

const buf = fs.readFileSync(MANIFEST_PATH);
const up = await request(
  'POST',
  'uploads.github.com',
  `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=release-manifest.json`,
  {
    stream: fs.createReadStream(MANIFEST_PATH),
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
  },
);
if (up.status !== 201) {
  console.error(`✘ 上传失败（HTTP ${up.status}）\n${up.body.slice(0, 400)}`);
  process.exit(1);
}
console.log(`  ↑ 已上传新清单（${buf.length} 字节）`);

// ---------------------------------------------------------------- 3. 回读核对
// GitHub 的发布附件是 302 跳到 release-assets.githubusercontent.com，
// 不跟随重定向就只会看到一个 302（早期这里误判成「失败」）。
function fetchJson(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向次数过多'));
    const u = new URL(url);
    const req = https.request(
      {
        host: u.hostname,
        path: `${u.pathname}${u.search}`,
        headers: { 'User-Agent': 'gelibot-manifest-fix' },
        rejectUnauthorized: false,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(fetchJson(new URL(res.headers.location, url).toString(), depth + 1));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('回读超时')));
    req.end();
  });
}

const check = await fetchJson(
  `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/release-manifest.json`,
);
if (check.status !== 200) {
  console.error(`✘ 回读失败（HTTP ${check.status}）`);
  process.exit(1);
}
const remote = JSON.parse(check.body);
const allAbsolute = [remote.asarUrl, remote.exeUrl, ...remote.patches.map((p) => p.url)]
  .filter(Boolean)
  .every((u) => /^https:\/\//.test(u));
console.log(`\n✔ 线上清单版本 ${remote.version}，地址全为绝对 URL：${allAbsolute ? '是' : '否'}`);
if (!allAbsolute) process.exit(1);
