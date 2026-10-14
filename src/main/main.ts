import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type {
  AppConfig,
  AuditEntry,
  BindCodeRecord,
  Binding,
  RuntimeStatus,
  SnowLumaStatus,
} from '../shared/types';
import { Store } from './store';
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
import { SnowLumaManager, SNOWLUMA_DATA_SUBDIR } from './snowluma';

let mainWindow: BrowserWindow | null = null;
let store: Store;
let rcon: RconClient;
let onebot: OneBotClient;
let bindCodes: BindCodeManager;
let bindingManager: BindingManager;
let router: CommandRouter;
let snowLuma: SnowLumaManager;

function isDevMode(): boolean {
  return process.argv.includes('--dev');
}

function getDataDir(): string {
  // 开发模式下用项目内 data/，打包后使用用户数据目录
  if (isDevMode()) return path.join(process.cwd(), 'data');
  return path.join(app.getPath('userData'), 'data');
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
  return {
    rcon: {
      state: r.state,
      message:
        r.state === 'connected'
          ? '已连接'
          : r.state === 'connecting'
            ? '连接中…'
            : r.state === 'error'
              ? '连接异常'
              : '未连接',
      lastError: r.lastError,
    },
    onebot: {
      state: o.state,
      message:
        o.state === 'connected'
          ? '已连接'
          : o.state === 'connecting'
            ? '连接中…'
            : o.state === 'error'
              ? '连接异常'
              : '未连接',
      lastError: o.lastError,
      selfId: o.selfId,
      selfName: o.selfName,
    },
  };
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

function registerIpc(): void {
  ipcMain.handle('config:get', () => store.getConfig());

  ipcMain.handle('config:save', (_e, next: AppConfig) => {
    try {
      store.saveConfig(next);
      rcon.updateConfig(next.rcon);
      onebot.updateConfig(next.onebot);
      router.updateConfig(next);
      snowLuma.updateOptions({
        customDir: next.snowluma.dir,
        fallbackWebUrl: next.snowluma.webUrl,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('config:reset', () => {
    const fresh = store.resetConfig();
    rcon.updateConfig(fresh.rcon);
    onebot.updateConfig(fresh.onebot);
    router.updateConfig(fresh);
    snowLuma.updateOptions({
      customDir: fresh.snowluma.dir,
      fallbackWebUrl: fresh.snowluma.webUrl,
    });
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
  onebot = new OneBotClient(config.onebot);
  bindCodes = new BindCodeManager();
  bindingManager = new BindingManager(
    store,
    config.binding,
    bindCodes,
    config.serverId,
  );
  router = new CommandRouter(store, bindingManager, bindCodes, rcon, config);
  // 把群名片更新能力注入路由，避免 router 直接依赖 onebot 客户端
  router.setGroupCardProvider(async (groupId, userId, card) => {
    await onebot.setGroupCard(groupId, userId, card);
  });

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
  createWindow();

  // 等渲染进程就绪后再发起连接，避免状态推送早于页面加载
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      void rcon.connect();
      void onebot.connect();
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  rcon?.destroy();
  onebot?.destroy();
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
  onebot?.destroy();
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
