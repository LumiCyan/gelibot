import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfig, BridgeApi, RuntimeStatus, SnowLumaStatus, UpdateStatus } from '../shared/types';

/**
 * 通过 contextBridge 暴露受限的 IPC 接口。
 * 渲染进程无法直接访问 Node / Electron API，只能调用这里白名单化的方法。
 */
const api: BridgeApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config: AppConfig) => ipcRenderer.invoke('config:save', config),
  resetConfig: () => ipcRenderer.invoke('config:reset'),

  getStatus: () => ipcRenderer.invoke('status:get'),
  onStatusChange: (cb: (s: RuntimeStatus) => void) => {
    const listener = (_e: unknown, status: RuntimeStatus) => cb(status);
    ipcRenderer.on('status:update', listener);
    return () => ipcRenderer.removeListener('status:update', listener);
  },

  reconnectRcon: () => ipcRenderer.invoke('rcon:reconnect'),
  reconnectOneBot: () => ipcRenderer.invoke('onebot:reconnect'),
  testRcon: () => ipcRenderer.invoke('rcon:test'),

  reconnectRconVerify: () => ipcRenderer.invoke('rconVerify:reconnect'),
  testRconVerify: () => ipcRenderer.invoke('rconVerify:test'),

  executeRcon: (command: string) => ipcRenderer.invoke('rcon:execute', command),

  listBindings: () => ipcRenderer.invoke('binding:list'),
  addBinding: (qq: string, playerId: string) =>
    ipcRenderer.invoke('binding:add', qq, playerId),
  removeBinding: (qq: string, playerId: string) =>
    ipcRenderer.invoke('binding:remove', qq, playerId),
  listBindingsOf: (qq: string) => ipcRenderer.invoke('binding:of', qq),
  findBindingByPlayer: (playerId: string) =>
    ipcRenderer.invoke('binding:byPlayer', playerId),

  listPendingCodes: () => ipcRenderer.invoke('bindcode:list'),
  cancelPendingCode: (code: string) => ipcRenderer.invoke('bindcode:cancel', code),
  issueCode: (playerId: string) => ipcRenderer.invoke('bindcode:issue', playerId),

  listAudit: (limit?: number) => ipcRenderer.invoke('audit:list', limit),
  clearAudit: () => ipcRenderer.invoke('audit:clear'),

  sendTestMessage: (targetType, targetId, text) =>
    ipcRenderer.invoke('message:sendTest', targetType, targetId, text),

  // ---------- SnowLuma 启动器 ----------

  getSnowLumaStatus: () => ipcRenderer.invoke('snowluma:status'),

  onSnowLumaStatus: (cb) => {
    const listener = (_e: unknown, status: SnowLumaStatus) => cb(status);
    ipcRenderer.on('snowluma:update', listener);
    return () => ipcRenderer.removeListener('snowluma:update', listener);
  },

  startSnowLuma: () => ipcRenderer.invoke('snowluma:start'),
  stopSnowLuma: () => ipcRenderer.invoke('snowluma:stop'),
  openSnowLumaWeb: () => ipcRenderer.invoke('snowluma:openWeb'),
  getSnowLumaLog: () => ipcRenderer.invoke('snowluma:log'),
  pickSnowLumaDir: () => ipcRenderer.invoke('snowluma:pickDir'),
  getBundledSnowLumaDir: () => ipcRenderer.invoke('snowluma:bundledDir'),

  // ---------- 数据目录与备份 ----------

  getDataDirInfo: () => ipcRenderer.invoke('data:info'),
  exportData: (includeSecrets: boolean) => ipcRenderer.invoke('data:export', includeSecrets),
  importData: () => ipcRenderer.invoke('data:import'),
  moveDataToPortable: () => ipcRenderer.invoke('data:moveToPortable'),
  openDataDir: () => ipcRenderer.invoke('data:openDir'),

  // ---------- 在线展示 ----------

  previewPresence: (presence) => ipcRenderer.invoke('presence:preview', presence),

  // ---------- 自动更新 ----------

  getUpdateStatus: () => ipcRenderer.invoke('update:status'),

  onUpdateStatus: (cb) => {
    const listener = (_e: unknown, status: UpdateStatus) => cb(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),

  // ---------- 日志监听 / 统计 / 定时任务 ----------

  getLogWatcherStatus: () => ipcRenderer.invoke('logwatch:status'),
  probeLogPath: (serverDir: string) => ipcRenderer.invoke('logwatch:probe', serverDir),

  getStats: () => ipcRenderer.invoke('stats:list'),
  getStatsTop: (by, limit?: number) => ipcRenderer.invoke('stats:top', by, limit),
  clearStats: () => ipcRenderer.invoke('stats:clear'),

  getTaskHistory: () => ipcRenderer.invoke('task:history'),
  runTaskNow: (taskId: string) => ipcRenderer.invoke('task:runNow', taskId),

  testResponder: (text: string) => ipcRenderer.invoke('responder:test', text),

  // ---------- AI ----------

  getAIStatus: () => ipcRenderer.invoke('ai:status'),
  testAI: () => ipcRenderer.invoke('ai:test'),
  askAI: (question: string) => ipcRenderer.invoke('ai:ask', question),
  clearAIContext: () => ipcRenderer.invoke('ai:clearContext'),

  // ---------- 图片回复 ----------

  previewImageReply: (text: string) => ipcRenderer.invoke('imageReply:preview', text),

  // ---------- 慰问服主 ----------

  getOwnerCareStatus: () => ipcRenderer.invoke('ownerCare:status'),
  sendOwnerCareNow: () => ipcRenderer.invoke('ownerCare:sendNow'),
  resetOwnerCareStart: () => ipcRenderer.invoke('ownerCare:resetStart'),
};

contextBridge.exposeInMainWorld('bridge', api);
