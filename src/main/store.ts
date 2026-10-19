import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, AuditEntry, Binding, PlayerStats } from '../shared/types';
import { createDefaultConfig } from '../shared/defaults';

/**
 * 把任意来源的（可能残缺的、老版本的）配置与默认值做深度合并，
 * 保证新增字段自动补齐。
 *
 * 独立成导出函数是因为「导入配置」也要走同一条链路：
 * 用户从旧版本导出的配置导入后，同样需要补齐这一版新增的字段。
 */
export function mergeConfigWithDefaults(saved: Partial<AppConfig>): AppConfig {
  const defaults = createDefaultConfig();
  const savedBinding = (saved.binding ?? {}) as Partial<AppConfig['binding']>;
  const savedVerify = (saved.verifyServer ?? {}) as Partial<
    AppConfig['verifyServer']
  >;
  return {
    ...defaults,
    ...saved,
    rcon: { ...defaults.rcon, ...(saved.rcon ?? {}) },
    // 验证服是两级嵌套（enabled / autoWhitelist / rcon），必须逐层合并，
    // 否则老配置升级后会丢掉 rcon 里的 host/port 等字段
    verifyServer: {
      ...defaults.verifyServer,
      ...savedVerify,
      rcon: { ...defaults.verifyServer.rcon, ...(savedVerify.rcon ?? {}) },
    },
    onebot: { ...defaults.onebot, ...(saved.onebot ?? {}) },
    whitelist: { ...defaults.whitelist, ...(saved.whitelist ?? {}) },
    // presence 单层嵌套；显式展开以便未来加字段时老配置继续自动补齐
    presence: { ...defaults.presence, ...(saved.presence ?? {}) },
    // snowluma 也是嵌套对象，同样要展开合并
    snowluma: { ...defaults.snowluma, ...(saved.snowluma ?? {}) },
    // update 是单层嵌套（customUrl / repoUrl），展开合并以便将来加字段
    update: { ...defaults.update, ...(saved.update ?? {}) },
    // binding 存在两级嵌套，必须逐层合并，否则老配置升级后会丢掉新增的模板字段
    binding: {
      ...defaults.binding,
      ...savedBinding,
      forceBind: {
        ...defaults.binding.forceBind,
        ...(savedBinding.forceBind ?? {}),
      },
      messages: {
        ...defaults.binding.messages,
        ...(savedBinding.messages ?? {}),
      },
    },
    commands:
      Array.isArray(saved.commands) && saved.commands.length > 0
        ? saved.commands
        : defaults.commands,
    // 新增功能域的嵌套字段逐层展开，保证老配置升级后自动补齐子字段
    logWatcher: { ...defaults.logWatcher, ...(saved.logWatcher ?? {}) },
    chatBridge: {
      ...defaults.chatBridge,
      ...(saved.chatBridge ?? {}),
      gameToChat: {
        ...defaults.chatBridge.gameToChat,
        ...(saved.chatBridge?.gameToChat ?? {}),
      },
      chatToGame: {
        ...defaults.chatBridge.chatToGame,
        ...(saved.chatBridge?.chatToGame ?? {}),
      },
      quietHours: {
        ...defaults.chatBridge.quietHours,
        ...(saved.chatBridge?.quietHours ?? {}),
      },
      blockPatterns: Array.isArray(saved.chatBridge?.blockPatterns)
        ? saved.chatBridge!.blockPatterns
        : defaults.chatBridge.blockPatterns,
      replacements: Array.isArray(saved.chatBridge?.replacements)
        ? saved.chatBridge!.replacements
        : defaults.chatBridge.replacements,
    },
    responder: {
      ...defaults.responder,
      ...(saved.responder ?? {}),
      rules: Array.isArray(saved.responder?.rules)
        ? saved.responder!.rules
        : defaults.responder.rules,
    },
    permissions: {
      ...defaults.permissions,
      ...(saved.permissions ?? {}),
      groups: Array.isArray(saved.permissions?.groups)
        ? saved.permissions!.groups
        : defaults.permissions.groups,
    },
    tasks: {
      ...defaults.tasks,
      ...(saved.tasks ?? {}),
      tasks: Array.isArray(saved.tasks?.tasks)
        ? saved.tasks!.tasks
        : defaults.tasks.tasks,
    },
    stats: { ...defaults.stats, ...(saved.stats ?? {}) },
    ai: { ...defaults.ai, ...(saved.ai ?? {}) },
    imageReply: { ...defaults.imageReply, ...(saved.imageReply ?? {}) },
    ownerCare: {
      ...defaults.ownerCare,
      ...(saved.ownerCare ?? {}),
      groups: Array.isArray(saved.ownerCare?.groups)
        ? saved.ownerCare!.groups
        : defaults.ownerCare.groups,
    },
    notify: {
      ...defaults.notify,
      ...(saved.notify ?? {}),
      join: { ...defaults.notify.join, ...(saved.notify?.join ?? {}) },
      leave: { ...defaults.notify.leave, ...(saved.notify?.leave ?? {}) },
      death: { ...defaults.notify.death, ...(saved.notify?.death ?? {}) },
      advancement: {
        ...defaults.notify.advancement,
        ...(saved.notify?.advancement ?? {}),
      },
      serverStart: {
        ...defaults.notify.serverStart,
        ...(saved.notify?.serverStart ?? {}),
      },
    },
  };
}

/**
 * 极简的 JSON 持久化层。
 * 所有数据放在用户数据目录下的 data/ 子目录，避免污染安装目录。
 */
export class Store {
  private readonly dir: string;
  private readonly configFile: string;
  private readonly bindingsFile: string;
  private readonly auditFile: string;
  private readonly statsFile: string;

  private config: AppConfig;
  private bindings: Binding[];
  private audit: AuditEntry[] = [];
  private stats: PlayerStats[] = [];

  constructor(baseDir: string) {
    this.dir = baseDir;
    this.configFile = path.join(baseDir, 'config.json');
    this.bindingsFile = path.join(baseDir, 'bindings.json');
    this.auditFile = path.join(baseDir, 'audit.json');
    this.statsFile = path.join(baseDir, 'stats.json');

    fs.mkdirSync(this.dir, { recursive: true });
    this.config = this.loadConfig();
    this.bindings = this.loadJson<Binding[]>(this.bindingsFile, []);
    this.audit = this.loadJson<AuditEntry[]>(this.auditFile, []);
    this.stats = this.loadJson<PlayerStats[]>(this.statsFile, []);

    // 首次运行时落盘，方便用户直接查看与备份配置
    if (!fs.existsSync(this.configFile)) {
      this.writeJson(this.configFile, this.config);
    }
  }

  private loadJson<T>(file: string, fallback: T): T {
    try {
      if (!fs.existsSync(file)) return fallback;
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, data: unknown): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /** 读取配置，并与默认值做深度合并，保证新增字段自动补齐 */
  private loadConfig(): AppConfig {
    const saved = this.loadJson<Partial<AppConfig>>(this.configFile, {});
    return mergeConfigWithDefaults(saved);
  }

  getConfig(): AppConfig {
    return this.config;
  }

  saveConfig(next: AppConfig): void {
    this.config = next;
    this.writeJson(this.configFile, this.config);
  }

  resetConfig(): AppConfig {
    this.config = createDefaultConfig();
    this.writeJson(this.configFile, this.config);
    return this.config;
  }

  // ---------- 绑定 ----------

  listBindings(): Binding[] {
    return [...this.bindings];
  }

  getBindingsOf(qq: string): Binding[] {
    return this.bindings.filter((b) => b.qq === qq);
  }

  countBindingsOf(qq: string): number {
    return this.bindings.filter((b) => b.qq === qq).length;
  }

  hasBinding(qq: string, playerId: string): boolean {
    return this.bindings.some(
      (b) => b.qq === qq && b.playerId.toLowerCase() === playerId.toLowerCase(),
    );
  }

  /** 玩家 ID 是否已被其他 QQ 绑定 */
  isPlayerTaken(playerId: string): Binding | undefined {
    return this.bindings.find(
      (b) => b.playerId.toLowerCase() === playerId.toLowerCase(),
    );
  }

  addBinding(binding: Binding): void {
    this.bindings.push(binding);
    this.writeJson(this.bindingsFile, this.bindings);
  }

  removeBinding(qq: string, playerId: string): boolean {
    const before = this.bindings.length;
    this.bindings = this.bindings.filter(
      (b) => !(b.qq === qq && b.playerId.toLowerCase() === playerId.toLowerCase()),
    );
    const changed = this.bindings.length !== before;
    if (changed) this.writeJson(this.bindingsFile, this.bindings);
    return changed;
  }

  /** 移除某个 QQ 的全部绑定，返回移除条数（退群自动解绑用） */
  removeBindingsOf(qq: string): number {
    const before = this.bindings.length;
    this.bindings = this.bindings.filter((b) => b.qq !== qq);
    const removed = before - this.bindings.length;
    if (removed > 0) this.writeJson(this.bindingsFile, this.bindings);
    return removed;
  }

  setBindings(list: Binding[]): void {
    this.bindings = list;
    this.writeJson(this.bindingsFile, this.bindings);
  }

  // ---------- 审计 ----------

  listAudit(limit = 200): AuditEntry[] {
    return this.audit.slice(-limit).reverse();
  }

  appendAudit(entry: AuditEntry): void {
    this.audit.push(entry);
    // 只保留最近 2000 条，避免文件无限增长
    if (this.audit.length > 2000) {
      this.audit = this.audit.slice(-2000);
    }
    this.writeJson(this.auditFile, this.audit);
  }

  clearAudit(): void {
    this.audit = [];
    this.writeJson(this.auditFile, this.audit);
  }

  // ---------- 玩家统计 ----------

  loadStats(): PlayerStats[] {
    return this.stats.map((s) => ({ ...s }));
  }

  saveStats(list: PlayerStats[]): void {
    this.stats = list;
    this.writeJson(this.statsFile, this.stats);
  }
}
