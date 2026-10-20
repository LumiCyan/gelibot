/**
 * 应用自动更新（差量）模块。
 *
 * 整体设计：
 * 1. 更新源：GitHub Releases（默认 lumicyan/gelibot），也可在设置里换成任意静态源。
 * 2. 版本清单：每个发布版本在 Releases 里附一个 `release-manifest.json`，
 *    内含该版本的 app.asar 的 sha256、以及从若干旧版本升级到它的 .patch 差量包信息。
 * 3. 差量：bsdiff 生成 .patch，客户端用 bspatch 把「当前版本的 app.asar」打成新版本。
 *    实现为纯 JS（不引第三方），数据量级（app.asar 几十 MB）完全够用。
 * 4. 应用：下载/补丁完成后校验 sha256，写入临时文件，退出时用独立批处理替换并重启。
 *
 * 安全边界（与项目一贯的「模板化 + 强校验 + 全量审计」一致）：
 * - 下载的 patch / 完整 asar 在应用前必须通过 sha256 校验，不匹配即丢弃。
 * - 更新源默认 GitHub（HTTPS），自定义源强制 https 或 http-localhost。
 * - 替换动作只针对便携版 exe 目录内的 resources/app.asar，绝不触碰用户 data 目录。
 */

import { app, net } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  UpdateChannel,
  UpdateInfo,
  UpdateManifest,
  UpdatePatchEntry,
  UpdateStatus,
} from '../shared/types';
import {
  compareVersions,
  customBaseUrl,
  githubReleaseBase,
  isUpdateUrlAllowed,
  mirrorCandidates,
  normalizeRepo,
  normalizeVersion,
  resolveUpdateAssetUrl,
} from './version';

/** 默认更新源（GitHub 仓库，可被设置覆盖） */
const DEFAULT_REPO = 'LumiCyan/gelibot';

/** 清单文件名：每个发布版本附带的元数据 */
const MANIFEST_NAME = 'release-manifest.json';

/** 当前版本号（来自 package.json / app.getVersion()） */
function currentVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}

/** 校验下载的缓冲区是否符合声明的 sha256 */
function verifySha256(buf: Buffer, expectedHex: string): boolean {
  if (!expectedHex) return false;
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  return actual.toLowerCase() === expectedHex.toLowerCase();
}

/**
 * 用 net.fetch 下载一个 URL，返回 Buffer。
 * net.fetch 走 Chromium 网络栈（与 avatar 模块一致），
 * 避免 Node TLS 被证书吊销检查卡住。
 *
 * 对 GitHub 域：直连失败时自动按序尝试镜像前缀（gh-proxy 等），
 * 全部失败才抛错。镜像仅用于下载，不改动清单地址生成逻辑。
 */
async function download(url: string, onProgress?: (done: number, total: number) => void): Promise<Buffer> {
  const candidates = mirrorCandidates(url);
  let lastErr: Error | null = null;
  for (const candidate of candidates) {
    try {
      return await downloadOnce(candidate, onProgress);
    } catch (err) {
      lastErr = err as Error;
      // 非 GitHub 域（只有原 URL 一个候选）直接抛；否则继续试下一个镜像
      if (candidates.length === 1) throw err;
    }
  }
  throw new Error(`下载失败（已尝试 ${candidates.length} 个源）：${lastErr?.message ?? '未知错误'}`);
}

/** 单次下载（不重试），失败抛错 */
async function downloadOnce(url: string, onProgress?: (done: number, total: number) => void): Promise<Buffer> {
  const res = await net.fetch(url);
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body) {
    throw new Error('下载失败：响应为空');
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * 取出配置里的 GitHub 仓库，归一化成 `owner/name`。
 *
 * 空值回落到默认仓库；写了但不合法（比如只填了仓库名、填了个中文名）
 * 直接抛错 —— 沉默地回落到默认仓库会让用户以为「检查更新成功了」，
 * 实际查的是别人的仓库。
 */
function configuredRepo(channel: UpdateChannel): string {
  const raw = (channel.repoUrl ?? '').trim();
  if (!raw) return DEFAULT_REPO;
  const normalized = normalizeRepo(raw);
  if (!normalized) {
    throw new Error(
      `更新源仓库格式不正确：${raw}（应填写 owner/name，例如 ${DEFAULT_REPO}）`,
    );
  }
  return normalized;
}

/**
 * 计算 GitHub 清单下载地址（走 releases 下载直链）。
 *
 * 注意这里必须产出一个**完整的 https 地址**，不能是 `owner/name`。
 */
function manifestUrl(channel: UpdateChannel): string {
  const custom = customBaseUrl(channel);
  if (custom) {
    return `${custom}/${MANIFEST_NAME}`;
  }
  // latest 而不是具体 tag：检查更新的目的就是拿「最新那版」的清单
  return `${githubReleaseBase(configuredRepo(channel))}/${MANIFEST_NAME}`;
}

/**
 * 更新器。
 * 状态机：idle → checking → { up-to-date | available } → downloading → ready → applying
 * 任何一步失败回到 idle 并记录 lastError。
 */
export class Updater {
  private channel: UpdateChannel;
  private status: UpdateStatus = { state: 'idle', message: '' };
  private listeners = new Set<(s: UpdateStatus) => void>();
  /** 已下载/补齐完成的差量包或完整 asar 的落盘路径（应用前） */
  private stagedFile: string | null = null;
  /** 解析出的最新版本信息（用于 UI 展示与决策） */
  private info: UpdateInfo | undefined;
  /** 工作目录（放临时补丁文件） */
  private workDir: string;

  constructor(channel: UpdateChannel) {
    this.channel = channel;
    this.workDir = path.join(app.getPath('userData'), 'updates');
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  onStatus(cb: (s: UpdateStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  updateChannel(channel: UpdateChannel): void {
    this.channel = channel;
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const cb of this.listeners) {
      try {
        cb(this.status);
      } catch {
        /* 监听器抛错不影响更新流程 */
      }
    }
  }

  private fail(message: string, phase?: UpdateStatus['phase']): void {
    this.setStatus({ state: 'error', message, phase });
  }

  /**
   * 检查更新：拉取最新 release 的清单，比对版本，返回是否有可用更新。
   * 结果通过 onStatus 推送；也作为返回值便于 IPC 直接回传。
   */
  async check(): Promise<{ hasUpdate: boolean; info: UpdateInfo | undefined; error?: string }> {
    this.setStatus({ state: 'checking', message: '正在检查更新…' });
    try {
      const manifest = await this.fetchManifest();
      const cur = currentVersion();
      const hasUpdate = compareVersions(manifest.version, cur) > 0;

      const info: UpdateInfo = {
        current: cur,
        latest: manifest.version,
        hasUpdate,
        notes: manifest.notes,
        publishedAt: manifest.publishedAt,
        patchAvailable: this.pickPatch(manifest, cur) !== null,
        patchSize: this.pickPatch(manifest, cur)?.size,
        fullSize: manifest.fullSize,
      };
      this.info = info;

      if (hasUpdate) {
        this.setStatus({ state: 'available', message: `发现新版本 v${manifest.version}`, info });
      } else {
        this.setStatus({ state: 'idle', message: '已是最新版本', info });
      }
      return { hasUpdate, info };
    } catch (err) {
      const msg = (err as Error).message;
      this.fail(msg, 'check');
      return { hasUpdate: false, info: undefined, error: msg };
    }
  }

  /** 下载最新版清单 */
  private async fetchManifest(): Promise<UpdateManifest> {
    const url = manifestUrl(this.channel);
    if (!isUpdateUrlAllowed(url)) {
      throw new Error(`更新源地址不合法：${url}`);
    }
    let buf: Buffer;
    try {
      buf = await download(url);
    } catch (err) {
      const msg = (err as Error).message;
      // 404 通常是发布源还没上传 release-manifest.json 附件，给用户可操作的提示
      if (/HTTP 404/.test(msg)) {
        throw new Error(
          '更新清单不存在（HTTP 404）：发布源尚未上传 release-manifest.json，' +
            '请先在 GitHub Release 里附带该清单附件，或检查更新源地址',
        );
      }
      throw err;
    }
    const text = buf.toString('utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('更新源返回的内容不是合法 JSON');
    }
    const m = raw as UpdateManifest;
    if (!m || typeof m.version !== 'string' || !Array.isArray(m.patches)) {
      throw new Error('更新清单格式不正确（缺少 version / patches）');
    }
    return m;
  }

  /** 从清单里挑出「当前版本 → 最新版本」的差量包（没有则返回 null，走全量） */
  private pickPatch(manifest: UpdateManifest, fromVersion: string): UpdatePatchEntry | null {
    const from = normalizeVersion(fromVersion);
    const found = manifest.patches.find(
      (p) => normalizeVersion(p.from) === from && normalizeVersion(p.to) === normalizeVersion(manifest.version),
    );
    return found ?? null;
  }

  /** 下载并把更新材料准备好。便携版整包下载 exe；否则差量优先、回退全量 asar */
  async downloadUpdate(): Promise<{ ok: boolean; error?: string; fullDownload?: boolean }> {
    if (!this.info || !this.info.hasUpdate) {
      this.fail('当前没有可用的更新', 'download');
      return { ok: false, error: '当前没有可用的更新' };
    }

    let manifest: UpdateManifest;
    try {
      manifest = await this.fetchManifest();
    } catch (err) {
      // 重新拉清单失败（源改了、附件没了）也要落到「出错」而不是抛出去
      const msg = (err as Error).message;
      this.fail(msg, 'download');
      return { ok: false, error: msg };
    }
    fs.mkdirSync(this.workDir, { recursive: true });

    // 仓库名写错时立刻报出来，别等到下载才看见「地址不合法」
    if (!customBaseUrl(this.channel)) {
      try {
        configuredRepo(this.channel);
      } catch (err) {
        const msg = (err as Error).message;
        this.fail(msg, 'download');
        return { ok: false, error: msg };
      }
    }

    // 便携版无法靠差量持久化（解压到临时目录），必须整包替换 exe
    if (this.isPortable()) {
      return this.downloadExe(manifest);
    }

    const cur = currentVersion();
    const patch = this.pickPatch(manifest, cur);

    if (patch && patch.sha256) {
      // 差量：下载 .patch，本地用 bspatch 打补丁生成新 asar
      const patchUrl = this.resolveAssetUrl(patch.url, manifest.version);
      if (!isUpdateUrlAllowed(patchUrl)) {
        const msg = `差量包地址不合法：${patchUrl}（请检查「连接设置 → 软件更新源」）`;
        this.fail(msg, 'download');
        return { ok: false, error: msg };
      }

      this.setStatus({
        state: 'downloading',
        message: '正在下载差量更新包…',
        phase: 'download',
        progress: 0,
        fullDownload: false,
      });
      let patchBuf: Buffer;
      try {
        patchBuf = await download(patchUrl, (done, total) => {
          this.setStatus({
            progress: total > 0 ? Math.min(99, Math.round((done / total) * 90)) : undefined,
          });
        });
      } catch (err) {
        this.fail(`差量包下载失败：${(err as Error).message}`, 'download');
        return { ok: false, error: `差量包下载失败：${(err as Error).message}` };
      }

      if (!verifySha256(patchBuf, patch.sha256)) {
        this.fail('差量包校验失败（sha256 不匹配），已中止', 'verify');
        return { ok: false, error: '差量包校验失败（sha256 不匹配）' };
      }

      this.setStatus({ state: 'downloading', message: '正在生成新版本…', phase: 'patch', progress: 90 });
      try {
        const oldAsar = this.currentAsarPath();
        const newAsarBuf = await this.applyPatch(patchBuf, fs.readFileSync(oldAsar));

        // 关键校验：打出来的新 asar 必须与清单声明的 sha256 一致。
        // 差量包是「针对某个确定旧文件」生成的，用户手上的旧 asar 一旦不是同一份
        // （改过包、装过别的分支、版本被覆盖过），bspatch 仍会「成功」但产出错误内容，
        // 直接替换就会把程序写坏。这里比对不过就回退全量，绝不放行。
        if (manifest.asarSha256 && !verifySha256(newAsarBuf, manifest.asarSha256)) {
          this.setStatus({
            state: 'downloading',
            message: '差量结果校验不符，改用完整包…',
            phase: 'download',
            progress: 0,
          });
          return this.downloadFull(manifest);
        }

        const target = this.asarTargetForVersion(manifest.version);
        fs.writeFileSync(target, newAsarBuf);
        this.stagedFile = target;
      } catch (err) {
        // 差量打补丁失败，回退到全量下载
        this.setStatus({
          state: 'downloading',
          message: '差量更新失败，改用完整包…',
          phase: 'download',
          progress: 0,
        });
        return this.downloadFull(manifest);
      }

      this.setStatus({ state: 'ready', message: `v${manifest.version} 已就绪，可重启更新`, progress: 100, info: this.info });
      return { ok: true, fullDownload: false };
    }

    return this.downloadFull(manifest);
  }

  /** 便携版：下载完整 exe 整包 */
  private async downloadExe(manifest: UpdateManifest): Promise<{ ok: boolean; error?: string; fullDownload?: boolean }> {
    const url = this.resolveAssetUrl(manifest.exeUrl, manifest.version);
    if (!url || !isUpdateUrlAllowed(url)) {
      const msg = `便携版完整包地址不合法：${url || '(空)'}（清单里的 exeUrl 缺失，或更新源配置有误）`;
      this.fail(msg, 'download');
      return { ok: false, error: msg };
    }

    this.setStatus({
      state: 'downloading',
      message: '正在下载便携版完整包…',
      phase: 'download',
      progress: 0,
      fullDownload: true,
    });
    let buf: Buffer;
    try {
      buf = await download(url, (done, total) => {
        this.setStatus({
          progress: total > 0 ? Math.min(99, Math.round((done / total) * 99)) : undefined,
        });
      });
    } catch (err) {
      this.fail(`便携版完整包下载失败：${(err as Error).message}`, 'download');
      return { ok: false, error: `便携版完整包下载失败：${(err as Error).message}` };
    }

    if (manifest.exeSha256 && !verifySha256(buf, manifest.exeSha256)) {
      this.fail('便携版完整包校验失败（sha256 不匹配），已中止', 'verify');
      return { ok: false, error: '便携版完整包校验失败（sha256 不匹配）' };
    }

    const target = path.join(this.workDir, `GeLi Bot v${manifest.version}.exe`);
    fs.writeFileSync(target, buf);
    this.stagedExe = target;

    this.setStatus({ state: 'ready', message: `v${manifest.version} 已就绪，可重启更新`, progress: 100, info: this.info });
    return { ok: true, fullDownload: true };
  }

  /** 全量下载最新 app.asar */
  private async downloadFull(manifest: UpdateManifest): Promise<{ ok: boolean; error?: string; fullDownload?: boolean }> {
    const url = this.resolveAssetUrl(manifest.asarUrl, manifest.version);
    if (!url || !isUpdateUrlAllowed(url)) {
      const msg = `完整包地址不合法：${url || '(空)'}（清单里的 asarUrl 缺失，或更新源配置有误）`;
      this.fail(msg, 'download');
      return { ok: false, error: msg };
    }

    this.setStatus({
      state: 'downloading',
      message: '正在下载完整更新包…',
      phase: 'download',
      progress: 0,
      fullDownload: true,
    });
    let buf: Buffer;
    try {
      buf = await download(url, (done, total) => {
        this.setStatus({
          progress: total > 0 ? Math.min(99, Math.round((done / total) * 99)) : undefined,
        });
      });
    } catch (err) {
      this.fail(`完整包下载失败：${(err as Error).message}`, 'download');
      return { ok: false, error: `完整包下载失败：${(err as Error).message}` };
    }

    if (!verifySha256(buf, manifest.asarSha256)) {
      this.fail('完整包校验失败（sha256 不匹配），已中止', 'verify');
      return { ok: false, error: '完整包校验失败（sha256 不匹配）' };
    }

    const target = this.asarTargetForVersion(manifest.version);
    fs.writeFileSync(target, buf);
    this.stagedFile = target;

    this.setStatus({ state: 'ready', message: `v${manifest.version} 已就绪，可重启更新`, progress: 100, info: this.info });
    return { ok: true, fullDownload: true };
  }

  /**
   * 解析清单里的资产地址为绝对 URL。
   *
   * 真正的拼装规则在 version.ts 的 `resolveUpdateAssetUrl` 里（纯函数，可单测）：
   * 这个 bug 就出在拼装环节，必须让单测直接盯着那个函数，而不是隔着
   * electron 依赖的类方法。
   */
  private resolveAssetUrl(asset: string | undefined, version?: string): string {
    return resolveUpdateAssetUrl(this.channel, asset, version);
  }

  /** 便携版 / 安装版中 app.asar 的路径 */
  private currentAsarPath(): string {
    return path.join(process.resourcesPath, 'app.asar');
  }

  /** 新 asar 落盘位置（临时目录，应用时再替换到 resources） */
  private asarTargetForVersion(version: string): string {
    return path.join(this.workDir, `app-${version}.asar`);
  }

  /** 已下载的完整 exe（便携版整包覆盖用） */
  private stagedExe: string | null = null;

  /** 是否以便携版（绿色版单 exe）方式运行 */
  private isPortable(): boolean {
    return (process.env.PORTABLE_EXECUTABLE_DIR ?? '').trim().length > 0;
  }

  /** 便携版下用户放置 exe 的真实目录 */
  private portableExeDir(): string | null {
    const env = (process.env.PORTABLE_EXECUTABLE_DIR ?? '').trim();
    return env || null;
  }

  /**
   * 应用更新。
   *
   * 便携版（绿色版单 exe）：exe 运行时解压到 %TEMP%，替换临时目录里的 app.asar
   * 无法持久化——下次双击用户 exe 会重新解压。因此便携版必须整包替换：
   * 下载完整 exe，校验后覆盖 PORTABLE_EXECUTABLE_DIR 下用户那个 exe，再重启。
   *
   * 非便携版（unpacked / 安装版）：直接把 staged 的新 app.asar 替换到 resources。
   */
  async apply(): Promise<{ ok: boolean; error?: string }> {
    this.setStatus({ state: 'applying', message: '正在应用更新…', phase: 'apply' });
    if (this.isPortable()) {
      return this.applyPortable();
    }
    return this.applyAsar();
  }

  /** 非便携版：替换 app.asar */
  private async applyAsar(): Promise<{ ok: boolean; error?: string }> {
    if (!this.stagedFile || !fs.existsSync(this.stagedFile)) {
      this.fail('没有已就绪的更新文件', 'apply');
      return { ok: false, error: '没有已就绪的更新文件' };
    }
    const targetAsar = this.currentAsarPath();
    try {
      const backup = `${targetAsar}.bak`;
      fs.copyFileSync(targetAsar, backup);
      try {
        fs.copyFileSync(this.stagedFile, targetAsar);
      } catch (err) {
        fs.copyFileSync(backup, targetAsar);
        throw err;
      }
      fs.rmSync(backup, { force: true });
    } catch (err) {
      this.fail(`应用更新失败：${(err as Error).message}`, 'apply');
      return { ok: false, error: `应用更新失败：${(err as Error).message}` };
    }

    this.setStatus({ state: 'done', message: '更新完成，即将重启', progress: 100 });
    return { ok: true };
  }

  /**
   * 便携版：把下载好的完整 exe 覆盖到用户放置 exe 的目录，然后重启。
   * 正在运行的 exe 通常被占用无法直接覆盖，这里用「改名旧 exe + 写入新 exe」。
   */
  private async applyPortable(): Promise<{ ok: boolean; error?: string }> {
    const dir = this.portableExeDir();
    if (!dir) {
      this.fail('无法确定便携版程序目录，无法自动更新', 'apply');
      return { ok: false, error: '无法确定便携版程序目录，无法自动更新' };
    }
    if (!this.stagedExe || !fs.existsSync(this.stagedExe)) {
      this.fail('尚未下载便携版完整包', 'apply');
      return { ok: false, error: '尚未下载便携版完整包，请先在「软件更新」页下载更新' };
    }

    const currentExe = path.basename(
      process.env.PORTABLE_EXECUTABLE_FILE || 'GeLi Bot.exe',
    );
    const target = path.join(dir, currentExe);
    const backup = `${target}.old`;

    try {
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      // Windows 允许对正在运行的文件改名，但通常不允许覆盖写入，
      // 所以先改名旧的，再写入新的。
      fs.renameSync(target, backup);
      fs.copyFileSync(this.stagedExe, target);
      fs.rmSync(backup, { force: true });
    } catch (err) {
      this.fail(`替换便携版 exe 失败：${(err as Error).message}`, 'apply');
      return { ok: false, error: `替换便携版 exe 失败：${(err as Error).message}` };
    }

    this.setStatus({ state: 'done', message: '更新完成，即将重启', progress: 100 });
    return { ok: true };
  }

  /** 触发应用重启（替换完成后调用） */
  restart(): void {
    app.relaunch();
    app.exit(0);
  }

  // ---------------------------------------------------------------------
  // bsdiff / bspatch（纯 JS 实现，避免依赖与跨平台编译）
  // ---------------------------------------------------------------------

  /**
   * 用 bspatch 把旧文件 + patch 合成新文件。
   * 只支持本项目自产 patch 的格式（由 build 脚本用同一套实现生成），
   * 因此数据布局可控、简单。
   */
  private async applyPatch(patchBuf: Buffer, oldBuf: Buffer): Promise<Buffer> {
    // 放到子线程执行，避免阻塞主进程事件循环（几十 MB 文件仍较快）
    return new Promise<Buffer>((resolve, reject) => {
      const code = `
        const fs = require('fs');
        const zlib = require('zlib');
        let stdin = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => { stdin += d; });
        process.stdin.on('end', () => {
          try {
            const input = JSON.parse(stdin);
            const result = bspatchSync(input);
            fs.writeFileSync(process.argv[2], result);
            process.exit(0);
          } catch (err) {
            process.stderr.write(String(err && err.stack || err));
            process.exit(1);
          }
        });

        // 纯 JS bspatch：格式 [MAGIC 8B]["GBDIFF10"][newSize u32][ctrlLen u32][diffCmpLen u32][extraCmpLen u32][ctrl][diff:zlib][extra:zlib]
        function bspatchSync(input) {
          const patch = fs.readFileSync(input.patchFile);
          const old = fs.readFileSync(input.oldFile);
          if (patch.toString('latin1', 0, 8) !== 'GBDIFF10') throw new Error('patch 魔数不符');
          let off = 8;
          const newSize = patch.readUInt32LE(off); off += 4;
          const ctrlLen = patch.readUInt32LE(off); off += 4;
          const diffLen = patch.readUInt32LE(off); off += 4;
          const extraLen = patch.readUInt32LE(off); off += 4;
          const ctrl = patch.subarray(off, off + ctrlLen); off += ctrlLen;
          const diff = zlib.inflateSync(patch.subarray(off, off + diffLen)); off += diffLen;
          const extra = zlib.inflateSync(patch.subarray(off, off + extraLen)); off += extraLen;

          const out = Buffer.alloc(newSize);
          let oldPos = 0, newPos = 0, ctrlPos = 0, diffPos = 0, extraPos = 0;
          const readCtrl = () => {
            const x = ctrl.readInt32LE(ctrlPos); ctrlPos += 4;
            const y = ctrl.readInt32LE(ctrlPos); ctrlPos += 4;
            const z = ctrl.readInt32LE(ctrlPos); ctrlPos += 4;
            return [x, y, z];
          };
          while (newPos < newSize) {
            const [x, y, z] = readCtrl();
            for (let i = 0; i < x; i++) {
              out[newPos] = ((old[oldPos] || 0) + diff[diffPos]) & 0xff;
              newPos++; oldPos++; diffPos++;
            }
            extra.copy(out, newPos, extraPos, extraPos + y);
            newPos += y; extraPos += y;
            oldPos += z;
          }
          return out;
        }
      `;
      // 用 node 子进程执行，避免把 bsdiff 逻辑写进主进程
      const patchFile = path.join(this.workDir, 'patch.gbdiff');
      const oldFile = path.join(this.workDir, 'old.asar');
      const newFile = path.join(this.workDir, 'new.asar');
      fs.writeFileSync(patchFile, patchBuf);
      fs.writeFileSync(oldFile, oldBuf);
      const scriptFile = path.join(this.workDir, 'bspatch.js');
      fs.writeFileSync(scriptFile, code);
      const payload = JSON.stringify({ patchFile, oldFile });

      const child = spawn(process.execPath, [scriptFile, newFile], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.write(payload);
      child.stdin.end();
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(newFile)) {
          resolve(fs.readFileSync(newFile));
        } else {
          reject(new Error(`bspatch 执行失败（exit=${code}）：${stderr}`));
        }
      });
    });
  }
}

/** 便捷工厂：按当前配置创建更新器 */
export function createUpdater(channel: UpdateChannel): Updater {
  return new Updater(channel);
}
