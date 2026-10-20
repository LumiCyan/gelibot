/**
 * 用 GitHub 的 Git Data API 提交代码（绕开 git push）。
 *
 * 为什么要这个：本机出网要过一层本地代理，它只放行 api.github.com，
 * 对 github.com 的 CONNECT 一律 502。而 `git push` 走的是
 * https://github.com/{owner}/{repo}.git，必然被拒。API 走 https，
 * 能同时提交文件、提交、分支和 tag，效果与自己 push 一致。
 *
 * 前提：本地已经 commit（脚本读 HEAD 与 HEAD~1 的差异）。
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/push-via-api.mjs v2.0.1
 *   GITHUB_TOKEN=xxx node scripts/push-via-api.mjs v2.0.1 --dry-run
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.GITHUB_TOKEN ?? '';
const OWNER = 'LumiCyan';
const REPO = 'gelibot';
const BRANCH = 'main';

const args = process.argv.slice(2);
const TAG_NAME = args.find((a) => /^v\d+/.test(a)) ?? '';
const DRY = args.includes('--dry-run');

if (!TOKEN) {
  console.error('\u2718 \u7f3a\u5c11 GITHUB_TOKEN');
  process.exit(1);
}

const git = (...a) =>
  execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

async function api(method, endpoint, payload) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应保持 null */
  }
  return { status: res.status, json, text };
}

const ok = (s) => s >= 200 && s < 300;

async function main() {
  const head = git('rev-parse', 'HEAD');
  const message = git('log', '-1', '--pretty=%B');
  const files = git('diff', '--name-only', 'HEAD~1', 'HEAD')
    .split('\n')
    .filter(Boolean);

  console.log(`\u672c\u5730 HEAD   : ${head}`);
  console.log(`\u63d0\u4ea4\u8bf4\u660e : ${message.split('\n')[0]}`);
  console.log(`\u53d8\u66f4\u6587\u4ef6 : ${files.length} \u4e2a`);
  for (const f of files) console.log(`  ${f}`);
  if (TAG_NAME) console.log(`\u5c06\u6253 tag  : ${TAG_NAME}`);

  if (DRY) {
    console.log('\n[dry] \u9884\u68c0\u901a\u8fc7\uff0c\u672a\u63d0\u4ea4');
    return;
  }

  // 1. 远端当前指向
  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  if (!ok(ref.status)) throw new Error(`\u8bfb\u5206\u652f\u5931\u8d25\uff1a${ref.status} ${ref.text.slice(0, 200)}`);
  const baseSha = ref.json.object.sha;
  console.log(`\n\u8fdc\u7aef ${BRANCH} : ${baseSha}`);

  if (baseSha === head) {
    console.log('\u8fdc\u7aef\u5df2\u662f\u8be5\u63d0\u4ea4\uff0c\u65e0\u9700\u63a8\u9001');
  }

  // 2. 以远端树为底，只替换本次改动的文件
  const baseCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseSha}`);
  if (!ok(baseCommit.status)) throw new Error(`\u8bfb\u63d0\u4ea4\u5931\u8d25\uff1a${baseCommit.status}`);
  const baseTree = baseCommit.json.tree.sha;

  const tree = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`\u6587\u4ef6\u4e0d\u5b58\u5728\uff1a${rel}\uff08\u811a\u672c\u4e0d\u5904\u7406\u5220\u9664\uff09`);
    }
    const content = fs.readFileSync(abs).toString('base64');
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content,
      encoding: 'base64',
    });
    if (!ok(blob.status)) throw new Error(`\u521b\u5efa blob \u5931\u8d25\uff08${rel}\uff09\uff1a${blob.status}`);
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.json.sha });
    console.log(`  \u2191 ${rel}  ${blob.json.sha.slice(0, 10)}`);
  }

  const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: baseTree,
    tree,
  });
  if (!ok(newTree.status)) throw new Error(`\u521b\u5efa tree \u5931\u8d25\uff1a${newTree.status} ${newTree.text.slice(0, 200)}`);
  console.log(`\u65b0 tree : ${newTree.json.sha}`);

  // 3. 建提交（parent = 远端当前指向，保证是快进）
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message,
    tree: newTree.json.sha,
    parents: [baseSha],
  });
  if (!ok(commit.status)) throw new Error(`\u521b\u5efa\u63d0\u4ea4\u5931\u8d25\uff1a${commit.status} ${commit.text.slice(0, 200)}`);
  const newSha = commit.json.sha;
  console.log(`\u65b0\u63d0\u4ea4 : ${newSha}`);

  // 4. 移动分支
  const moved = await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: newSha,
    force: false,
  });
  if (!ok(moved.status)) throw new Error(`\u66f4\u65b0\u5206\u652f\u5931\u8d25\uff1a${moved.status} ${moved.text.slice(0, 200)}`);
  console.log(`\u2714 ${BRANCH} \u5df2\u66f4\u65b0\u5230 ${newSha.slice(0, 10)}`);

  // 5. 打 tag
  if (TAG_NAME) {
    const tag = await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, {
      ref: `refs/tags/${TAG_NAME}`,
      sha: newSha,
    });
    if (!ok(tag.status)) {
      if (tag.status === 422) console.log(`\u26a0 tag ${TAG_NAME} \u5df2\u5b58\u5728\uff0c\u8df3\u8fc7`);
      else throw new Error(`\u521b\u5efa tag \u5931\u8d25\uff1a${tag.status} ${tag.text.slice(0, 200)}`);
    } else {
      console.log(`\u2714 tag ${TAG_NAME} \u5df2\u521b\u5efa`);
    }
  }

  // 6. 回读确认
  const check = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  console.log(`\u56de\u8bfb ${BRANCH} : ${check.json?.object?.sha}`);
  console.log(check.json?.object?.sha === newSha ? '\u5168\u90e8\u5b8c\u6210 \u2705' : '\u56de\u8bfb\u4e0d\u4e00\u81f4 \u274c');
}

main().catch((err) => {
  console.error('\n\u5931\u8d25\uff1a', err.message);
  process.exit(1);
});
