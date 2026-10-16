import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, AuditEntry, Binding } from '../shared/types';
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
    // snowluma 也是嵌套对象，同样要展开合并
    snowluma: { ...defaults.snowluma, ...(saved.snowluma ?? {}) },
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

  private config: AppConfig;
  private bindings: Binding[];
  private audit: AuditEntry[] = [];

  constructor(baseDir: string) {
    this.dir = baseDir;
    this.configFile = path.join(baseDir, 'config.json');
    this.bindingsFile = path.join(baseDir, 'bindings.json');
    this.auditFile = path.join(baseDir, 'audit.json');

    fs.mkdirSync(this.dir, { recursive: true });
    this.config = this.loadConfig();
    this.bindings = this.loadJson<Binding[]>(this.bindingsFile, []);
    this.audit = this.loadJson<AuditEntry[]>(this.auditFile, []);

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
}
