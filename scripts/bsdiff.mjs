/**
 * 纯 JS bsdiff 生成器（bsdiff 4.3 算法）。
 *
 * 输出 patch 格式与 src/main/updater.ts 的 bspatch 严格对应：
 *   [8 字节 "GBDIFF10"][newSize:u32le][ctrlLen:u32le][diffLen:u32le][extraLen:u32le]
 *   [ctrl 段][diff 段][extra 段]
 * ctrl 段 = 连续 int32le 三元组 (x, y, z)：
 *   x：diff 段字节数，new[i] = old[oldPos+i] + diff[diffPos+i]（newPos、oldPos 都 +x）
 *   y：extra 段字节数，new[i] = extra[extraPos+i]（仅 newPos +y）
 *   z：oldPos 额外前移字节数
 *
 * 为取得真正的「差量」效果（匹配字节不重复存储），diff/extra 两段用 zlib deflate 压缩，
 * bspatch 端 inflate 还原。匹配字节编码为 diff 里的 0，deflate 后几乎不占空间。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from('GBDIFF10', 'latin1');

/** 倍增法构建后缀数组，O(n log^2 n) */
function buildSuffixArray(buf) {
  const n = buf.length;
  if (n === 0) return new Int32Array(0);
  let rank = new Int32Array(n);
  for (let i = 0; i < n; i++) rank[i] = buf[i];
  let sa = new Int32Array(n);
  for (let i = 0; i < n; i++) sa[i] = i;
  const tmp = new Int32Array(n);
  let nextRank = new Int32Array(n);

  for (let k = 1; k < n; k <<= 1) {
    const maxVal = n + 1;
    const cnt = new Int32Array(maxVal + 1);
    for (let i = 0; i < n; i++) {
      const key = i + k < n ? rank[i + k] + 1 : 0;
      cnt[key + 1]++;
    }
    for (let i = 0; i < maxVal; i++) cnt[i + 1] += cnt[i];
    for (let i = 0; i < n; i++) {
      const key = i + k < n ? rank[i + k] + 1 : 0;
      tmp[cnt[key]++] = i;
    }
    cnt.fill(0);
    for (let i = 0; i < n; i++) cnt[rank[tmp[i]] + 1]++;
    for (let i = 0; i < maxVal; i++) cnt[i + 1] += cnt[i];
    for (let i = 0; i < n; i++) {
      const idx = tmp[i];
      sa[cnt[rank[idx]]++] = idx;
    }
    nextRank[sa[0]] = 0;
    for (let i = 1; i < n; i++) {
      const prev = sa[i - 1];
      const cur = sa[i];
      const same =
        rank[prev] === rank[cur] &&
        (prev + k < n ? rank[prev + k] : -1) === (cur + k < n ? rank[cur + k] : -1);
      nextRank[cur] = nextRank[prev] + (same ? 0 : 1);
    }
    const t = rank;
    rank = nextRank;
    nextRank = t;
    if (rank[sa[n - 1]] === n - 1) break;
  }
  return sa;
}

/** 二分后缀数组，求 new[newPos:] 与 old 的最长匹配，返回 { len, pos } */
function searchMatch(sa, oldBuf, newBuf, newPos) {
  const n = oldBuf.length;
  const m = newBuf.length;
  if (n === 0 || newPos >= m) return { len: 0, pos: -1 };
  let lo = 0;
  let hi = n - 1;
  let bestLen = 0;
  let bestPos = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pos = sa[mid];
    let len = 0;
    while (
      newPos + len < m &&
      pos + len < n &&
      newBuf[newPos + len] === oldBuf[pos + len]
    ) {
      len++;
    }
    if (len > bestLen) {
      bestLen = len;
      bestPos = pos;
    }
    if (newPos + len < m && pos + len < n) {
      if (newBuf[newPos + len] < oldBuf[pos + len]) hi = mid - 1;
      else lo = mid + 1;
    } else if (newPos + len >= m) hi = mid - 1;
    else lo = mid + 1;
  }
  return { len: bestLen, pos: bestPos };
}

/**
 * 生成 bsdiff patch（经典算法，与 bspatch 端严格对偶）。
 */
export function bsdiff(oldBuf, newBuf) {
  const oldsize = oldBuf.length;
  const newsize = newBuf.length;
  const sa = buildSuffixArray(oldBuf);

  const ctrl = [];
  const diff = [];
  const extra = [];

  let scan = 0;
  let lastscan = 0;
  let lastpos = 0;

  while (scan < newsize) {
    let { len, pos } = searchMatch(sa, oldBuf, newBuf, scan);
    if (len === 0) {
      // 完全没有匹配：把剩余全部当作 diff（new 相对 old 末尾的差异）
      // 这里退化为逐字节 literal，保证正确性
      break;
    }

    // 在匹配窗口内寻找更优的 score（对齐经典 bsdiff，简化：直接用首匹配）
    scan += len;

    // 向前扩展：匹配结束后还能继续匹配多少字节
    let lenf = 0;
    for (let i = 0; i < 8 && scan + i < newsize && pos + len + i < oldsize; i++) {
      if (newBuf[scan + i] === oldBuf[pos + len + i]) lenf++;
      else break;
    }

    // 向后扩展：匹配开始前还能往前匹配多少字节
    let lenb = 0;
    if (scan < newsize) {
      let s = 0;
      let sf = 0;
      for (let i = 1; scan >= lastscan + i && pos >= i; i++) {
        if (oldBuf[pos - i] === newBuf[scan - i]) s++;
        else if (s * 2 - i > sf * 2 - lenb) {
          lenb = i;
          sf = s;
        }
      }
    }

    const x = lenf - lenb; // diff 段长度
    const y = (scan - lenb) - (lastscan + lenf); // extra 段长度
    const z = (pos - lenb) - (lastpos + lenf); // seek 长度

    ctrl.push(x, y, z);

    // diff 段：new - old
    for (let i = 0; i < x; i++) {
      const nb = newBuf[lastscan + i];
      const ob = lastpos + i < oldsize ? oldBuf[lastpos + i] : 0;
      diff.push((nb - ob + 256) % 256);
    }
    // extra 段：new 里直接复制的字节
    for (let i = 0; i < y; i++) {
      extra.push(newBuf[lastscan + lenf + i]);
    }

    lastscan = scan - lenb;
    lastpos = pos - lenb;
    scan = lastscan + len + lenf; // 继续从匹配结束后扫描
  }

  // 处理尾部未匹配部分（上面的 break 或循环自然结束后）
  if (lastscan < newsize) {
    // 剩余字节全部作为 diff（相对 old 的 lastpos 逐字节）
    const x = newsize - lastscan;
    const y = 0;
    const z = 0;
    ctrl.push(x, y, z);
    for (let i = 0; i < x; i++) {
      const nb = newBuf[lastscan + i];
      const ob = lastpos + i < oldsize ? oldBuf[lastpos + i] : 0;
      diff.push((nb - ob + 256) % 256);
    }
  }

  const ctrlBuf = Buffer.from(Int32Array.from(ctrl).buffer);
  const diffRaw = Buffer.from(diff);
  const extraRaw = Buffer.from(extra);
  const diffCmp = zlib.deflateSync(diffRaw);
  const extraCmp = zlib.deflateSync(extraRaw);

  const header = Buffer.alloc(8 + 16);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(newsize, 8);
  header.writeUInt32LE(ctrlBuf.length, 12);
  header.writeUInt32LE(diffCmp.length, 16);
  header.writeUInt32LE(extraCmp.length, 20);

  return Buffer.concat([header, ctrlBuf, diffCmp, extraCmp]);
}

/** CLI：node scripts/bsdiff.mjs <旧文件> <新文件> <输出.patch> */
export function generatePatch(oldFile, newFile, outFile) {
  const oldBuf = fs.readFileSync(oldFile);
  const newBuf = fs.readFileSync(newFile);
  const patch = bsdiff(oldBuf, newBuf);
  fs.writeFileSync(outFile, patch);
  return {
    size: patch.length,
    sha256: crypto.createHash('sha256').update(patch).digest('hex'),
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const [, , oldFile, newFile, outFile] = process.argv;
  if (!oldFile || !newFile || !outFile) {
    console.error('用法: node scripts/bsdiff.mjs <旧文件> <新文件> <输出.patch>');
    process.exit(1);
  }
  const r = generatePatch(oldFile, newFile, outFile);
  console.log(`已生成 ${outFile}（${r.size} 字节，sha256=${r.sha256.slice(0, 16)}…）`);
}
