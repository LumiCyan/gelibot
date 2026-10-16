import { app, BrowserWindow, dialog, ipcMain, net, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type {
  AppConfig,
  AuditEntry,
  BindCodeRecord,
  Binding,
  DataDirInfo,
  DataFileInfo,
  DataTransferResult,
  PresencePreview,
  RuntimeStatus,
  SnowLumaStatus,
} from '../shared/types';
import { Store, mergeConfigWithDefaults } from './store';
import { RconClient } from './rcon';
import {
  OneBotClient,
  isGroupDecreaseNotice,
  type MessageEvent,
  type OneBotEvent,
} from './onebot';
import { BindCodeManager } from './bindcode';
import { BindingManager } from './binding';
import { CommandRouter } from './router';
import { PresenceService } from './presence';
import { AvatarCache, type FetchLike } from './avatar';
import { CardRenderer } from './card';
import { OnlineCardService } from './online-card';
import { SnowLumaManager, SNOWLUMA_DATA_SUBDIR } from './snowluma';
import {
  DATA_SUBDIR,
  pickPortableDir,
  planMoveToPortable,
  moveDataToPortable,
  resolveDataDir,
  sidecarDataDir,
  type DataDirDecision,
} from './datadir';
import {
  buildExportBundle,
  mergeBindings,
  mergeImportedConfig,
  parseImportBundle,
  suggestExportName,
} from './transfer';

let mainWindow: BrowserWindow | null = null;
let store: Store;
/** 本次运行采用的数据目录决策（启动时算一次，之后不再变） */
let dataDirDecision: DataDirDecision;
/** 便携版里「用户放 exe 的文件夹」，用于「把配置存到程序目录」；不可用时为 null */
let portableDir: string | null = null;
let rcon: RconClient;
/** 验证服 RCON（双服务器绑定流程用；未启用时不连接） */
let rconVerify: RconClient;
let onebot: OneBotClient;
let bindCodes: BindCodeManager;
let bindingManager: BindingManager;
let router: CommandRouter;
let snowLuma: SnowLumaManager;
/** 在线人数采集（主服 RCON list） */
let presence: PresenceService;
/** 图片卡片渲染器（隐藏窗口截图） */
let cardRenderer: CardRenderer;
/** 在线展示编排（采集 + 头像 + 渲染 + 落盘） */
let onlineCard: OnlineCardService;

/** 图标读取失败时的 1×1 透明占位，保证卡片头部不出现破图 */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** 读正式图标（渲染层资源，与窗口图标同一份）并转成 data URI */
function loadCardIconUri(): string {
  try {
    const p = path.join(__dirname, '../renderer/assets/window-256.png');
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch {
    return TINY_PNG;
  }
}

function isDevMode(): boolean {
  return process.argv.includes('--dev');
}

/**
 * 本次运行采用哪个数据目录（只算一次，之后不再变）。
 *
 * 规则：
 * 1. 开发模式（`--dev`）→ 项目内的 data/
 * 2. 程序目录下存在 `data/config.json` → 用它（绿色版模式，配置跟随程序）
 * 3. 否则 → `%APPDATA%/GeLi Bot/data`
 *
 * 第 2 条是为了根治「换版本要重新配置」：把 data 文件夹和 exe 放在一起，
 * 换任何版本、任何电脑，配置都是同一份。第 3 条是兜底，保持老用户无感。
 */
function ensureDataDirDecision(): DataDirDecision {
  if (dataDirDecision) return dataDirDecision;

  if (isDevMode()) {
    dataDirDecision = {
      dir: path.join(process.cwd(), DATA_SUBDIR),
      source: 'user',
      reason: '开发模式（--dev）：使用项目内的 data 目录',
    };
    return dataDirDecision;
  }

  portableDir = pickPortableDir({
    portableEnv: process.env.PORTABLE_EXECUTABLE_DIR,
    exePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
  });
  dataDirDecision = resolveDataDir({
    portableDir,
    userDataDir: app.getPath('userData'),
  });

  console.log(`[data] 数据目录：${dataDirDecision.dir}（${dataDirDecision.reason}）`);
  if (dataDirDecision.warning) console.warn(`[data] ${dataDirDecision.warning}`);
  return dataDirDecision;
}

function getDataDir(): string {
  return ensureDataDirDecision().dir;
}

/**
 * 内置 SnowLuma 的程序目录。
 *
 * 注意这里用 `app.isPackaged` 而不是 `--dev` 来判断：
 * 「SnowLuma 放在哪」取决于代码是从源码跑还是从 exe 跑，
 * 与用户是否想要开发模式的配置目录没有关系。
 * （`npm start` 不带 --dev 时数据目录走 AppData，但 SnowLuma 仍在项目根目录。）
 */
function getBundledSnowLumaDir(): string | null {
  const candidates: string[] = [];

  if (!app.isPackaged) {
    // 从源码运行：SnowLuma 在项目根目录
    candidates.push(path.join(app.getAppPath(), 'snowluma'));
    candidates.push(path.join(process.cwd(), 'snowluma'));
  }
  candidates.push(
    // 打包后：extraResources 铺到 resources/snowluma/
    path.join(process.resourcesPath, 'snowluma'),
    // 便携版会被解到临时目录，同时兜底看一眼 exe 同级目录，
    // 方便用户把 snowluma/ 直接放在 exe 旁边替换版本
    path.join(path.dirname(app.getPath('exe')), 'snowluma'),
  );

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.mjs'))) return dir;
  }
  return null;
}

/** SnowLuma 的数据目录：固定放在 userData 下，保证程序只读也能持久化配置 */
function getSnowLumaDataDir(): string {
  return path.join(app.getPath('userData'), SNOWLUMA_DATA_SUBDIR);
}

/**
 * 一次性迁移：产品从 GeLiCraft 改名为 GeLi Bot 后，userData 目录也跟着变了。
 * 这里把旧目录下的 data/ 整体搬过来，免得用户重新填一遍 RCON 密码和绑定关系。
 * 只在「新目录还没有 data」且「旧目录存在」时执行一次。
 *
 * 旧目录候选：
 * - `GeLiCraft`：v1.14.x 正式版的 userData（当时 productName 为 GeLiCraft）
 * - `gelibot`：v1.15.0 早期构建的 userData（productName 没写进 app.asar，退化成了 name）
 */
const LEGACY_DATA_DIRS = ['GeLiCraft', 'gelibot'];

function migrateLegacyData(): void {
  if (isDevMode()) return;
  try {
    const target = getDataDir();
    if (fs.existsSync(target)) return;

    // 有多个旧目录时取「配置文件最新」的那个，避免拿到过期数据
    let picked: string | null = null;
    let pickedTime = -1;
    for (const name of LEGACY_DATA_DIRS) {
      const dir = path.join(app.getPath('appData'), name, 'data');
      if (!fs.existsSync(dir)) continue;
      const cfg = path.join(dir, 'config.json');
      const t = fs.existsSync(cfg) ? fs.statSync(cfg).mtimeMs : 0;
      if (t > pickedTime) {
        picked = dir;
        pickedTime = t;
      }
    }
    if (!picked) return;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(picked, target, { recursive: true });
    console.log(`[migrate] 已把旧版本配置从 ${picked} 迁移到 ${target}`);
  } catch (err) {
    console.warn('[migrate] 旧配置迁移失败，将按默认配置启动：', err);
  }
}

function buildStatus(): RuntimeStatus {
  const r = rcon.getState();
  const o = onebot.getState();
  const describe = (state: string): string =>
    state === 'connected'
      ? '已连接'
      : state === 'connecting'
        ? '连接中…'
        : state === 'error'
          ? '连接异常'
          : '未连接';
  const status: RuntimeStatus = {
    rcon: {
      state: r.state,
      message: describe(r.state),
      lastError: r.lastError,
    },
    onebot: {
      state: o.state,
      message: describe(o.state),
      lastError: o.lastError,
      selfId: o.selfId,
      selfName: o.selfName,
    },
  };
  if (rconVerify) {
    const v = rconVerify.getState();
    status.rconVerify = {
      state: v.state,
      message: describe(v.state),
      lastError: v.lastError,
    };
  }
  return status;
}

function broadcastStatus(): void {
  // 窗口或渲染帧可能已销毁（例如关闭瞬间仍有状态回调），需要双重校验
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
  try {
    wc.send('status:update', buildStatus());
  } catch {
    // 渲染进程尚未就绪或正在销毁，忽略本次推送即可
  }
}

function broadcastSnowLuma(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
  try {
    wc.send('snowluma:update', snowLuma.getStatus());
  } catch {
    // 渲染进程尚未就绪，忽略本次推送
  }
}

/** 把路由处理结果发回消息来源 */
async function dispatchReply(ev: MessageEvent, text: string): Promise<void> {
  try {
    if (ev.message_type === 'group') {
      await onebot.sendGroupMessage(ev.group_id, text);
    } else {
      await onebot.sendPrivateMessage(ev.user_id, text);
    }
  } catch (err) {
    console.error('[dispatch] 回复失败:', err);
  }
}

function wireEvents(): void {
  rcon.on('state', () => broadcastStatus());
  rconVerify?.on('state', () => broadcastStatus());
  onebot.on('state', () => broadcastStatus());

  onebot.on('message', (ev: MessageEvent) => {
    void (async () => {
      try {
        const result = await router.handle(ev);
        if (result.handled && result.reply) {
          await dispatchReply(ev, result.reply);
        }
      } catch (err) {
        console.error('[router] 处理消息出错:', err);
      }
    })();
  });

  // 群成员减少事件：按配置自动解绑（对齐 EasyBot 的「退群事件」）
  onebot.on('event', (ev: OneBotEvent) => {
    if (!isGroupDecreaseNotice(ev)) return;
    if (!store.getConfig().binding.unbindOnGroupLeave) return;
    void (async () => {
      try {
        const qq = String(ev.user_id);
        if (bindingManager.countOf(qq) === 0) return;
        const players = bindingManager.removeAllOf(qq);
        console.log(
          `[bind] 成员 ${qq} 退出群 ${ev.group_id}（${ev.sub_type}），已自动解绑：${players.join('、')}`,
        );
        // 强制绑定服务器：离线玩家下次进服会被拒绝，无需立即踢出
        mainWindow?.webContents.send('binding:changed');
      } catch (err) {
        console.error('[bind] 退群自动解绑失败:', err);
      }
    })();
  });
}

function createWindow(): void {
  // 窗口 / 任务栏图标。打包后 exe 已内嵌 icon.ico，但开发模式与
  // 任务栏小组件仍会读 BrowserWindow 的 icon，所以显式指定一份 PNG。
  // 资源由 scripts/make-ui-assets.py 生成并随 copy-assets 进 dist。
  const iconPath = path.join(__dirname, '../renderer/assets/window-256.png');

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'GeLi Bot 控制台',
    backgroundColor: '#f7f9fc',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 按配置启停验证服连接。
 * 未启用时主动断开，免得它在后台反复重连、把「连接异常」一直挂在状态栏上。
 */
function applyVerifyServerConfig(next: AppConfig): void {
  if (!rconVerify) return;
  rconVerify.updateConfig(next.verifyServer.rcon);
  if (next.verifyServer.enabled) {
    const st = rconVerify.getState().state;
    if (st === 'disconnected' || st === 'error') void rconVerify.connect();
  } else {
    void rconVerify.disconnect();
  }
}

/**
 * 把一份新配置落盘并让所有运行中的组件切过去。
 * config:save / config:reset / data:import 三处共用，避免任何一条路径漏掉某个组件。
 */
function applyConfig(next: AppConfig): void {
  store.saveConfig(next);
  rcon.updateConfig(next.rcon);
  onebot.updateConfig(next.onebot);
  applyVerifyServerConfig(next);
  router.updateConfig(next);
  snowLuma?.updateOptions({
    customDir: next.snowluma.dir,
    fallbackWebUrl: next.snowluma.webUrl,
  });
}

/** 收集当前数据目录的信息，供界面展示 */
function buildDataDirInfo(): DataDirInfo {
  const decision = ensureDataDirDecision();
  let files: DataFileInfo[] = [];
  try {
    files = fs
      .readdirSync(decision.dir)
      .filter((f) => !f.endsWith('.tmp'))
      .map((name) => {
        const st = fs.statSync(path.join(decision.dir, name));
        return { name, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    files = [];
  }

  const existing = sidecarDataDir(portableDir);
  const decisionPortable =
    decision.source === 'portable' ? decision.dir : null;
  const plan = planMoveToPortable({ portableDir, currentDir: decision.dir });

  return {
    dir: decision.dir,
    source: decision.source,
    reason: decision.reason,
    warning: decision.warning,
    portableDir,
    canMoveToPortable: plan.ok,
    existingPortableDataDir: decisionPortable ?? existing,
    files,
  };
}

/**
 * 对话框统一挂到主窗口上（有窗口时），否则在部分环境下会弹到屏幕角落。
 */
function showSave(opts: SaveDialogOptions): ReturnType<typeof dialog.showSaveDialog> {
  return mainWindow ? dialog.showSaveDialog(mainWindow, opts) : dialog.showSaveDialog(opts);
}

function showOpen(opts: OpenDialogOptions): ReturnType<typeof dialog.showOpenDialog> {
  return mainWindow ? dialog.showOpenDialog(mainWindow, opts) : dialog.showOpenDialog(opts);
}

/** 数据目录与备份相关的 IPC */
function registerDataIpc(): void {
  ipcMain.handle('data:info', (): DataDirInfo => buildDataDirInfo());

  ipcMain.handle('data:openDir', async () => {
    const dir = getDataDir();
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('data:export', async (_e, includeSecrets: boolean) => {
    try {
      const suggested = suggestExportName();
      const res = await showSave({
        title: '导出 GeLi Bot 配置',
        defaultPath: suggested,
        filters: [{ name: 'GeLi Bot 配置', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, error: '已取消' };

      const bundle = buildExportBundle(store.getConfig(), store.listBindings(), {
        includeSecrets: includeSecrets === true,
        productVersion: app.getVersion(),
      });
      const text = JSON.stringify(bundle, null, 2);
      fs.writeFileSync(res.filePath, text, 'utf8');

      const lines = [
        `已写入 ${res.filePath}`,
        `包含 1 份配置 + ${bundle.bindings.length} 条绑定关系`,
        bundle.secretsIncluded
          ? '⚠ 文件包含 RCON 密码 / OneBot AccessToken，请妥善保管'
          : '已剔除密码等敏感字段（导入后需要重新填写密码）',
      ];
      return { ok: true, path: res.filePath, bytes: Buffer.byteLength(text), lines };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('data:import', async () => {
    try {
      const res = await showOpen({
        title: '导入 GeLi Bot 配置（导出包或 data/config.json 均可）',
        properties: ['openFile'],
        filters: [{ name: 'GeLi Bot 配置', extensions: ['json'] }],
      });
      if (res.canceled || res.filePaths.length === 0) {
        return { ok: false, error: '已取消' };
      }
      const file = res.filePaths[0];
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

      const parsed = parseImportBundle(raw);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const bundle = parsed.value;

      const current = store.getConfig();
      // 走与「读取老配置」同一条合并链，缺字段自动补默认值
      const merged = mergeConfigWithDefaults(bundle.config);
      const next = mergeImportedConfig(merged, current, bundle.secretsIncluded);
      applyConfig(next);

      const before = store.listBindings();
      const merged2 = mergeBindings(before, bundle.bindings);
      if (merged2.added > 0) store.setBindings(merged2.list);

      const lines = [
        `已导入 ${file}`,
        bundle.shape === 'raw-config'
          ? '识别为原始 config.json（不含绑定关系）'
          : `来源：GeLi Bot ${bundle.productVersion}${bundle.exportedAt ? ` · ${bundle.exportedAt.slice(0, 10)}` : ''}`,
      ];
      if (bundle.shape === 'bundle') {
        lines.push(`绑定关系：新增 ${merged2.added} 条，跳过 ${merged2.skipped} 条（已存在）`);
      }
      if (bundle.droppedBindings > 0) {
        lines.push(`⚠ 有 ${bundle.droppedBindings} 条绑定记录字段残缺，已丢弃`);
      }
      if (!bundle.secretsIncluded) {
        lines.push('文件未包含密码，本机原有的 RCON 密码与 AccessToken 已保留');
      }
      lines.push('配置已生效，无需重启');

      return { ok: true, path: file, lines, configChanged: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('data:moveToPortable', () => {
    try {
      const current = getDataDir();
      const plan = planMoveToPortable({ portableDir, currentDir: current });
      if (!plan.ok) return { ok: false, error: plan.error };

      moveDataToPortable(current, plan.target);
      const count = fs.readdirSync(plan.target).length;
      return {
        ok: true,
        path: plan.target,
        lines: [
          `已把 ${count} 个文件复制到 ${plan.target}`,
          '请手动重启 GeLi Bot，重启后配置就会跟随程序目录',
          '之后换版本只需把 exe 和 data 文件夹放在一起',
        ],
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}

/** 在线展示（图片卡片）相关 IPC */
function registerPresenceIpc(): void {
  ipcMain.handle(
    'presence:preview',
    async (_e, draft?: Partial<AppConfig['presence']>): Promise<PresencePreview> => {
      const cfg = store.getConfig();
      // 草稿优先：界面改了没保存也能预览到真实效果
      const presenceCfg = { ...cfg.presence, ...(draft ?? {}) };
      try {
        const snap = await presence.refresh();
        const demo = !snap.ok;
        const data = demo
          ? OnlineCardService.demoData(presenceCfg.serverName)
          : await onlineCard.buildData(snap, presenceCfg);
        const { png, width, height } = await cardRenderer.render(data);
        return {
          ok: true,
          dataUrl: 'data:image/png;base64,' + png.toString('base64'),
          demo,
          width,
          height,
          summary: demo
            ? `真实查询不可用（${snap.error ?? '未知原因'}），下面是用演示数据渲染的效果`
            : `当前在线 ${snap.online}/${snap.max}，名单 ${snap.players.length} 人`,
        };
      } catch (err) {
        return { ok: false, demo: false, error: (err as Error).message };
      }
    },
  );
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => store.getConfig());

  ipcMain.handle('config:save', (_e, next: AppConfig) => {
    try {
      applyConfig(next);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('config:reset', () => {
    const fresh = store.resetConfig();
    // resetConfig 已落盘，这里再走一次统一的「切换组件」路径，
    // 保证以后新增组件时不会漏掉恢复默认这一条路径
    applyConfig(fresh);
    return fresh;
  });

  ipcMain.handle('status:get', () => buildStatus());

  ipcMain.handle('rcon:reconnect', async () => {
    try {
      await rcon.disconnect();
      await rcon.connect();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('onebot:reconnect', async () => {
    try {
      await onebot.disconnect();
      await onebot.connect();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('rcon:test', () => rcon.execute('list'));

  ipcMain.handle('rconVerify:test', () => rconVerify.execute('list'));

  ipcMain.handle('rconVerify:reconnect', async () => {
    try {
      await rconVerify.disconnect();
      await rconVerify.connect();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('rcon:execute', (_e, command: string) =>
    router.executeManual(command),
  );

  ipcMain.handle('binding:list', (): Binding[] => bindingManager.list());

  ipcMain.handle('binding:add', (_e, qq: string, playerId: string) => {
    const res = bindingManager.adminBind(qq, playerId);
    return { ok: res.ok, error: res.ok ? undefined : res.message };
  });

  ipcMain.handle('binding:remove', (_e, qq: string, playerId: string) => {
    const res = bindingManager.remove(qq, playerId, { asAdmin: true });
    return { ok: res.ok, error: res.ok ? undefined : res.message };
  });

  ipcMain.handle('binding:of', (_e, qq: string): Binding[] =>
    bindingManager.listOf(qq),
  );

  ipcMain.handle('binding:byPlayer', (_e, playerId: string): Binding | null =>
    bindingManager.findByPlayer(playerId) ?? null,
  );

  ipcMain.handle('bindcode:list', (): BindCodeRecord[] => bindCodes.list());

  ipcMain.handle('bindcode:cancel', (_e, code: string) => {
    const ok = bindCodes.cancel(code);
    return ok ? { ok: true } : { ok: false, error: '验证码不存在或已过期' };
  });

  ipcMain.handle('bindcode:issue', (_e, playerId: string) => {
    const res = bindingManager.issueCodeFor(playerId);
    if (!res.ok || !res.record) {
      return { ok: false, error: res.error ?? '签发失败' };
    }
    return { ok: true, code: res.record.code };
  });

  ipcMain.handle('audit:list', (_e, limit?: number): AuditEntry[] =>
    store.listAudit(limit ?? 200),
  );

  ipcMain.handle('audit:clear', () => {
    store.clearAudit();
  });

  ipcMain.handle(
    'message:sendTest',
    async (_e, targetType: 'group' | 'private', targetId: string, text: string) => {
      const id = Number(targetId);
      if (!Number.isFinite(id)) return { ok: false, error: '目标 ID 不合法' };
      const res =
        targetType === 'group'
          ? await onebot.sendGroupMessage(id, text)
          : await onebot.sendPrivateMessage(id, text);
      return res.status === 'ok'
        ? { ok: true }
        : { ok: false, error: `发送失败（retcode=${res.retcode}）` };
    },
  );

  // ---------- SnowLuma 启动器 ----------

  ipcMain.handle('snowluma:status', (): SnowLumaStatus => snowLuma.getStatus());

  ipcMain.handle('snowluma:log', (): string[] => snowLuma.getLog());

  ipcMain.handle('snowluma:bundledDir', () => getBundledSnowLumaDir());

  ipcMain.handle('snowluma:start', async () => snowLuma.start());

  ipcMain.handle('snowluma:stop', async () => snowLuma.stop());

  ipcMain.handle('snowluma:openWeb', async () => {
    const url = snowLuma.getStatus().webUrl || store.getConfig().snowluma.webUrl;
    if (!url) return { ok: false, error: '未配置 WebUI 地址' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('snowluma:pickDir', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择 SnowLuma 程序目录（含 node.exe 与 index.mjs）',
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });
}

app.whenReady().then(async () => {
  migrateLegacyData();
  store = new Store(getDataDir());
  const config = store.getConfig();

  rcon = new RconClient(config.rcon);
  rconVerify = new RconClient(config.verifyServer.rcon);
  onebot = new OneBotClient(config.onebot);
  bindCodes = new BindCodeManager();
  bindingManager = new BindingManager(
    store,
    config.binding,
    bindCodes,
    config.serverId,
  );
  router = new CommandRouter(
    store,
    bindingManager,
    bindCodes,
    rcon,
    config,
    rconVerify,
  );
  // 把群名片更新能力注入路由，避免 router 直接依赖 onebot 客户端
  router.setGroupCardProvider(async (groupId, userId, card) => {
    await onebot.setGroupCard(groupId, userId, card);
  });

  // 在线展示：/在线 的图片卡片（采集 + 头像 + 隐藏窗口渲染）
  presence = new PresenceService(rcon);
  const avatarCache = new AvatarCache({
    dir: path.join(getDataDir(), 'avatars'),
    // net.fetch 走 Chromium 网络栈 —— Node 的 TLS 会被证书吊销检查卡住
    fetchImpl: (url, init) => net.fetch(url, init),
    log: (m) => console.warn('[avatar]', m),
  });
  cardRenderer = new CardRenderer({ iconUri: loadCardIconUri() });
  onlineCard = new OnlineCardService({
    presence,
    avatars: avatarCache,
    renderer: cardRenderer,
    getConfig: () => store.getConfig(),
    findBinding: (playerId) => bindingManager.findByPlayer(playerId),
    cardDir: path.join(getDataDir(), 'cards'),
    log: (m) => console.warn('[online-card]', m),
  });
  router.setOnlineCardProvider(onlineCard);

  snowLuma = new SnowLumaManager({
    customDir: config.snowluma.dir,
    bundledDir: getBundledSnowLumaDir(),
    dataDir: getSnowLumaDataDir(),
    fallbackWebUrl: config.snowluma.webUrl,
  });
  snowLuma.on('status', () => broadcastSnowLuma());
  snowLuma.on('log', () => broadcastSnowLuma());
  // 只在检测到 WebUI 真正开始监听时开一次浏览器
  snowLuma.on('web-ready', (url: string) => {
    if (!store.getConfig().snowluma.autoOpen) return;
    void shell.openExternal(url);
  });

  wireEvents();
  registerIpc();
  registerDataIpc();
  registerPresenceIpc();
  createWindow();

  // 等渲染进程就绪后再发起连接，避免状态推送早于页面加载
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      void rcon.connect();
      void onebot.connect();
      // 验证服只在启用时才连，避免默认配置下多打一个必然失败的连接
      if (store.getConfig().verifyServer.enabled) void rconVerify.connect();
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  rcon?.destroy();
  rconVerify?.destroy();
  onebot?.destroy();
  cardRenderer?.destroy();
  if (process.platform !== 'darwin') app.quit();
});

/**
 * 退出前收尾。
 * SnowLuma 是独立进程，不会随我们自动结束，所以要在 before-quit 里显式停掉。
 * 停止是异步的，这里先拦一次退出，等停完再真正 quit。
 */
let quitting = false;
app.on('before-quit', (e) => {
  rcon?.destroy();
  rconVerify?.destroy();
  onebot?.destroy();
  cardRenderer?.destroy();
  if (quitting) return;

  const shouldStop = (() => {
    try {
      return store?.getConfig().snowluma.stopWithApp ?? false;
    } catch {
      return false;
    }
  })();

  if (snowLuma?.isRunning() && shouldStop) {
    e.preventDefault();
    quitting = true;
    void snowLuma.stop().finally(() => app.quit());
  }
});
