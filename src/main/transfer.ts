import type { AppConfig, Binding } from '../shared/types';

/**
 * 配置导出 / 导入。
 *
 * 数据目录虽然已经能跟随程序走，但「意外」仍然存在：误删、换机、装到只读位置、
 * 将来某次改名。所以再补一条与路径无关的通道 —— 一份 JSON 走天下。
 *
 * 两个设计取舍：
 * 1. **默认脱敏**：RCON 密码 / OneBot AccessToken 默认不写进导出文件，
 *    需要显式勾选才带上。
 * 2. **导入是合并而非覆盖**：脱敏文件导进来不会把本机已有的密码抹成空；
 *    绑定关系按「QQ + 玩家 ID」去重追加，不动已有数据。
 */

export const EXPORT_KIND = 'gelibot-config';
/** 导出文件的格式版本（与软件版本无关，只在结构变化时 +1）*/
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportBundle {
  app: 'GeLi Bot';
  kind: typeof EXPORT_KIND;
  version: number;
  /** 生成这份文件时的软件版本，仅作参考 */
  productVersion: string;
  exportedAt: string;
  /** 文件里是否包含密码等敏感字段 */
  secretsIncluded: boolean;
  config: AppConfig;
  bindings: Binding[];
}

export interface ImportBundle {
  config: AppConfig;
  bindings: Binding[];
  /** 文件里是否带敏感字段 */
  secretsIncluded: boolean;
  productVersion: string;
  exportedAt: string;
  /** 来源形态：标准导出包，还是用户直接拿来的 data/config.json */
  shape: 'bundle' | 'raw-config';
  /** 包里被丢弃的绑定记录条数（字段残缺）*/
  droppedBindings: number;
}

export type ParseResult =
  | { ok: true; value: ImportBundle }
  | { ok: false; error: string };

/** 深拷贝配置，并把敏感字段清空 */
export function redactSecrets(config: AppConfig): AppConfig {
  const copy = structuredClone(config);
  copy.rcon.password = '';
  copy.verifyServer.rcon.password = '';
  copy.onebot.accessToken = '';
  return copy;
}

export function buildExportBundle(
  config: AppConfig,
  bindings: Binding[],
  opts: { includeSecrets: boolean; productVersion: string; now?: Date },
): ExportBundle {
  return {
    app: 'GeLi Bot',
    kind: EXPORT_KIND,
    version: EXPORT_FORMAT_VERSION,
    productVersion: opts.productVersion,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    secretsIncluded: opts.includeSecrets,
    config: opts.includeSecrets ? structuredClone(config) : redactSecrets(config),
    bindings: structuredClone(bindings),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 一条绑定记录是否可用 */
function normalizeBinding(raw: unknown): Binding | null {
  if (!isObject(raw)) return null;
  const qq = typeof raw.qq === 'string' ? raw.qq.trim() : '';
  const playerId = typeof raw.playerId === 'string' ? raw.playerId.trim() : '';
  if (!qq || !playerId) return null;
  const out: Binding = {
    qq,
    playerId,
    // createdAt 是必填项，缺失时补当前时间，免得后续界面拿到 undefined
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
  // 其余字段（fromGroup / serverId / nickname 等）原样带上
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'qq' || k === 'playerId' || k === 'createdAt') continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * 解析导入文件。既接受本程序导出的包，也接受用户直接从数据目录里
 * 拷贝出来的 `config.json`（那种更朴素，但很常见）。
 */
export function parseImportBundle(raw: unknown): ParseResult {
  if (!isObject(raw)) {
    return { ok: false, error: '文件内容不是合法的 JSON 对象' };
  }

  // ---- 形态一：标准导出包 ----
  if (raw.kind === EXPORT_KIND) {
    const version = typeof raw.version === 'number' ? raw.version : 0;
    if (version > EXPORT_FORMAT_VERSION) {
      return {
        ok: false,
        error: `这份文件来自更新版本的 GeLi Bot（格式 v${version}），当前程序无法识别`,
      };
    }
    if (!isObject(raw.config)) {
      return { ok: false, error: '导出包里缺少 config 段' };
    }
    const rawBindings = Array.isArray(raw.bindings) ? raw.bindings : [];
    const bindings = rawBindings
      .map(normalizeBinding)
      .filter((b): b is Binding => b !== null);
    return {
      ok: true,
      value: {
        config: raw.config as unknown as AppConfig,
        bindings,
        secretsIncluded: raw.secretsIncluded === true,
        productVersion: typeof raw.productVersion === 'string' ? raw.productVersion : '未知',
        exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
        shape: 'bundle',
        droppedBindings: rawBindings.length - bindings.length,
      },
    };
  }

  // ---- 形态二：裸 config.json ----
  if (isObject(raw.rcon) && isObject(raw.binding)) {
    return {
      ok: true,
      value: {
        config: raw as unknown as AppConfig,
        bindings: [],
        // 裸配置文件里从不做脱敏，密码通常是有的
        secretsIncluded: true,
        productVersion: '未知',
        exportedAt: '',
        shape: 'raw-config',
        droppedBindings: 0,
      },
    };
  }

  return {
    ok: false,
    error: '无法识别的文件：既不是 GeLi Bot 导出包，也不像 data/config.json',
  };
}

/**
 * 把导入的配置并到当前配置上。
 * - 脱敏文件（secretsIncluded=false）不覆盖本机已有的密码，避免「导一次配置把服务器连不上」
 * - 其余字段以导入文件为准
 */
export function mergeImportedConfig(
  imported: AppConfig,
  current: AppConfig,
  secretsIncluded: boolean,
): AppConfig {
  const next = structuredClone(imported);
  if (!secretsIncluded) {
    if (!next.rcon.password) next.rcon.password = current.rcon.password;
    if (!next.verifyServer?.rcon?.password) {
      next.verifyServer.rcon.password = current.verifyServer.rcon.password;
    }
    if (!next.onebot?.accessToken) next.onebot.accessToken = current.onebot.accessToken;
  }
  return next;
}

export interface BindingMergeResult {
  list: Binding[];
  added: number;
  skipped: number;
}

/** 绑定关系按「QQ + 玩家 ID」去重追加（玩家 ID 大小写不敏感）*/
export function mergeBindings(current: Binding[], incoming: Binding[]): BindingMergeResult {
  const seen = new Set(
    current.map((b) => `${b.qq}::${b.playerId.toLowerCase()}`),
  );
  const list = [...current];
  let added = 0;
  let skipped = 0;
  for (const b of incoming) {
    const key = `${b.qq}::${b.playerId.toLowerCase()}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    list.push(b);
    added++;
  }
  return { list, added, skipped };
}

/** 导出文件名建议：gelibot-config-20261017.json */
export function suggestExportName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `gelibot-config-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
}
