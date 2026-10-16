import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfig, BridgeApi, RuntimeStatus, SnowLumaStatus } from '../shared/types';

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
};

contextBridge.exposeInMainWorld('bridge', api);
