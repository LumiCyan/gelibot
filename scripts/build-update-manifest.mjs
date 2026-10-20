/**
 * 生成发布清单与差量包。
 *
 * 在 `npm run dist` 打包出 app.asar 之后运行，产出：
 * 1. release-manifest.json —— 供客户端判断是否有更新、走哪条升级路径。
 * 2. app-<旧版本>-to-<新版本>.patch —— 从历史版本升级到当前版本的差量包。
 * 3. app.asar 本身的 sha256（写进清单，全量下载时校验）。
 *
 * 用法：
 *   node scripts/build-update-manifest.mjs <新版本> <旧版本目录> <输出目录>
 *
 * 参数：
 *   <新版本>      当前要发布的版本号，如 1.18.0
 *   <旧版本目录>  存放历史版本 app.asar 的目录（文件名需为 app-<ver>.asar）
 *   <输出目录>    差量包与清单的输出目录（与 Releases 附件上传到同一处）
 *
 * 环境变量：
 *   GC_OUT_DIR    打包产物所在目录，默认 dist-release
 *                 （与 build-release.mjs 共用同一个变量，换目录打包后无需改脚本）
 *
 * 约定：客户端从「当前版本」出发，若清单里存在 from=当前版本 的 patch 就用差量，
 * 否则回退到完整 asar。因此这里对每个旧版本生成一份 patch。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generatePatch } from './bsdiff.mjs';

/** 打包产物目录（与 build-release.mjs 保持一致） */
const BUILD_DIR = process.env.GC_OUT_DIR || 'dist-release';

/**
 * 清单里所有附件地址统一写成**绝对 URL**。
 *
 * 为什么不留相对文件名：客户端要自己拼地址，而「GitHub 模式下 baseUrl 只有
 * owner/repo」这个细节曾经漏过一次，拼出 `lumicyan/gelibot/xxx.exe` 这种
 * 不是 URL 的字符串，更新直接失败。清单里写绝对地址就不依赖客户端的拼接
 * 逻辑 —— 老版本客户端（含已发布的 2.0.1）拿到新清单也能正常下载。
 *
 * 仓库可用环境变量 GELIBOT_REPO 覆盖（默认 LumiCyan/gelibot）。
 */
const REPO = (process.env.GELIBOT_REPO || 'LumiCyan/gelibot').trim();

function assetBase(version) {
  return `https://github.com/${REPO}/releases/download/v${version}`;
}

function assetUrl(version, name) {
  return `${assetBase(version)}/${name}`;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 去掉 Markdown 标记：清单里的 notes 会被直接推到 QQ 群，不能带 `**` 这类符号 */
function stripMarkdown(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]{1,3}/g, '')
    .replace(/^[>\-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从 docs/RELEASE-v<version>.md 里取一段更新说明，填进清单的 notes。
 *
 * 取法：跳过一级标题、分隔线、空行，收集前两段真正的正文再合并。
 * 为什么取两段：release notes 的第一段通常只是「这个软件是什么」的固定简介，
 * 第二段才开始说这一版做了什么。只取第一段等于没写。
 * 最后截到 200 字，避免清单过长。
 */
function extractNotes(version) {
  const file = path.join('docs', `RELEASE-v${version}.md`);
  try {
    if (!fs.existsSync(file)) return '';
    const text = fs.readFileSync(file, 'utf8');
    const paragraphs = text.split(/\n\s*\n/);
    const picked = [];
    for (const p of paragraphs) {
      const t = p.trim();
      // 跳过标题行、分隔线、以及只由这些组成的块
      if (!t || t.startsWith('#') || /^-{3,}$/.test(t)) continue;
      const oneLine = stripMarkdown(t);
      if (oneLine.length < 4) continue;
      picked.push(oneLine);
      if (picked.length >= 2) break;
    }
    const merged = picked.join(' ');
    return merged.length > 200 ? `${merged.slice(0, 199)}…` : merged;
  } catch {
    return '';
  }
}

function main() {
  const [, , version, oldDir, outDir] = process.argv;
  if (!version || !outDir) {
    console.error('用法: node scripts/build-update-manifest.mjs <新版本> [旧版本目录] <输出目录>');
    process.exit(1);
  }

  const asarPath = path.join(BUILD_DIR, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    console.error(
      `未找到 app.asar：${asarPath}\n请先运行 npm run dist（或 dist:dir）生成打包产物。`,
    );
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const asarBuf = fs.readFileSync(asarPath);
  const asarHash = sha256(asarBuf);

  const patches = [];

  // 对每个历史版本生成差量包
  if (oldDir && fs.existsSync(oldDir)) {
    const files = fs.readdirSync(oldDir).filter((f) => /^app-.+\.asar$/.test(f));
    for (const f of files) {
      const fromVer = f.replace(/^app-/, '').replace(/\.asar$/, '');
      if (fromVer === version) continue;
      const oldPath = path.join(oldDir, f);
      const oldBuf = fs.readFileSync(oldPath);
      if (!oldBuf.equals(asarBuf)) {
        const patchName = `app-${fromVer}-to-${version}.patch`;
        const patchPath = path.join(outDir, patchName);
        const t0 = Date.now();
        const r = generatePatch(oldPath, asarPath, patchPath);
        console.log(
          `[manifest] ${fromVer} → ${version}：${patchName}（${(r.size / 1024 / 1024).toFixed(2)} MB，` +
            `${Date.now() - t0}ms）`,
        );
        patches.push({
          from: fromVer,
          to: version,
          url: assetUrl(version, patchName),
          sha256: r.sha256,
          size: r.size,
        });
      } else {
        console.log(`[manifest] 跳过 ${fromVer}（与当前版本内容一致）`);
      }
    }
  }

  // 完整 asar 也复制一份到输出目录（供全量下载）
  const asarOutName = `app-${version}.asar`;
  fs.copyFileSync(asarPath, path.join(outDir, asarOutName));

  // 检测便携版 exe（绿色版整包覆盖用）
  const exeCandidates = [
    path.join(BUILD_DIR, `GeLi Bot v${version}.exe`),
    path.join(BUILD_DIR, `GeLi Bot-${version}.exe`),
  ];
  let exeOutName;
  let exeSha;
  let exeSize;
  for (const p of exeCandidates) {
    if (fs.existsSync(p)) {
      // 用连字符而不是空格：GitHub 上传时会把空格替换成点，
      // 而 exeUrl 是客户端拼下载地址用的，必须与服务器上的存储名逐字节一致。
      exeOutName = `GeLi-Bot-v${version}.exe`;
      const exeBuf = fs.readFileSync(p);
      exeSha = sha256(exeBuf);
      exeSize = exeBuf.length;
      fs.copyFileSync(p, path.join(outDir, exeOutName));
      console.log(`[manifest] portable exe：${exeOutName}（${(exeSize / 1024 / 1024).toFixed(2)} MB）`);
      break;
    }
  }

  const manifest = {
    version,
    notes: extractNotes(version),
    publishedAt: new Date().toISOString(),
    asarUrl: assetUrl(version, asarOutName),
    asarSha256: asarHash,
    fullSize: asarBuf.length,
    ...(exeOutName
      ? { exeUrl: assetUrl(version, exeOutName), exeSha256: exeSha, exeSize }
      : {}),
    patches,
  };

  const manifestPath = path.join(outDir, 'release-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[manifest] 已写入 ${manifestPath}`);
  console.log(`[manifest] 完整 asar：${(asarBuf.length / 1024 / 1024).toFixed(2)} MB（sha256=${asarHash.slice(0, 16)}…）`);
  console.log(`[manifest] 差量包 ${patches.length} 个`);
}

main();
