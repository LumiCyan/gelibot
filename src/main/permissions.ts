/**
 * 权限组系统。
 *
 * 现状：原项目只有「管理员 / 普通用户」二元权限（whitelist.admins）。
 * EasyBot 提供的是「群组 / 身份 / 账号 / 嵌套」四类主体的完整权限组，
 * 这里补齐，同时保证：
 *   - permissions.enabled = false 时完全沿用旧的二元判断（老配置零影响）
 *   - 权限组只做「放大/收缩可执行指令集合」，不改变管理员兜底
 *
 * 判定顺序：
 *   1. 全局管理员（whitelist.admins）→ 永远放行
 *   2. permissions 关闭 → 回退旧的 adminOnly 判断
 *   3. 收集该用户命中的所有权限组（按 priority 降序）
 *   4. deny 优先于 allow；allow 支持 `*` 与 `前缀*` 通配
 */

import type { PermissionConfig, PermissionGroup } from '../shared/types';

/** 判断指令名是否命中某条允许/拒绝模式 */
export function matchCommandPattern(pattern: string, command: string): boolean {
  const p = pattern.trim().toLowerCase();
  const c = command.trim().toLowerCase();
  if (!p) return false;
  if (p === '*') return true;
  if (p.endsWith('*')) return c.startsWith(p.slice(0, -1));
  return p === c;
}

/** 一组主体上下文：判断一个用户在某场景下属于哪些权限组 */
export interface PermissionContext {
  /** QQ 号 */
  qq: string;
  /** 群号（私聊时为空） */
  groupId?: string;
  /** 群内身份：群主/管理员/成员；未知时为空 */
  role?: 'owner' | 'admin' | 'member';
}

/** 单个权限组是否命中该上下文 */
function groupMatches(group: PermissionGroup, ctx: PermissionContext): boolean {
  for (const s of group.subjects) {
    if (s.type === 'account' && s.value === ctx.qq) return true;
    if (s.type === 'group' && ctx.groupId && s.value === ctx.groupId) return true;
    if (s.type === 'role' && ctx.role && s.value === ctx.role) return true;
    // nested 在 resolveGroups 里展开，这里不直接匹配
  }
  return false;
}

/**
 * 收集用户命中的全部权限组，并展开 nested 引用。
 *
 * nested 的语义是「包含」：组 H 的 subjects 里出现 `{ type:'nested', value:'G' }`
 * 表示 **H 包含 G 的全部成员**。所以判定方向是「由内向外」——
 * 用户命中 G 后，所有包含 G 的组也随之命中，直到不动点。
 *
 * 用「集合 + 迭代到不动点」而不是递归，天然免疫 A→B→A 的循环引用。
 */
export function resolveGroups(
  config: PermissionConfig,
  ctx: PermissionContext,
): PermissionGroup[] {
  const byId = new Map(config.groups.map((g) => [g.id, g]));
  const hit = new Set<string>();

  // 1) 直接命中的组
  for (const g of config.groups) {
    if (groupMatches(g, ctx)) hit.add(g.id);
  }

  // 2) 反向展开：谁包含了已命中的组
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of config.groups) {
      if (hit.has(g.id)) continue;
      for (const s of g.subjects) {
        if (s.type === 'nested' && hit.has(s.value)) {
          hit.add(g.id);
          changed = true;
          break;
        }
      }
    }
  }

  return [...hit]
    .map((id) => byId.get(id))
    .filter((g): g is PermissionGroup => Boolean(g))
    .sort((a, b) => b.priority - a.priority);
}

/**
 * 判断用户能否执行某条指令。
 *
 * @param commandName 指令名（不含斜杠）
 * @param ctx         用户上下文
 * @param config      权限配置
 * @param isGlobalAdmin 是否全局管理员（永远放行）
 * @param defaultAdminOnly 该指令原本是否要求管理员（权限组关闭时使用）
 */
export function canUseCommand(
  commandName: string,
  ctx: PermissionContext,
  config: PermissionConfig,
  isGlobalAdmin: boolean,
  defaultAdminOnly: boolean,
): boolean {
  // 全局管理员永远放行
  if (isGlobalAdmin) return true;

  // 权限组关闭：退回旧的二元判断
  if (!config.enabled) return !defaultAdminOnly;

  const groups = resolveGroups(config, ctx);
  if (groups.length === 0) {
    // 没有命中任何权限组：按「是否要求管理员」回退，避免一刀切禁掉所有人
    return !defaultAdminOnly;
  }

  // deny 优先
  for (const g of groups) {
    if (g.denyCommands.some((p) => matchCommandPattern(p, commandName))) {
      return false;
    }
  }
  // allow
  for (const g of groups) {
    if (g.allowCommands.some((p) => matchCommandPattern(p, commandName))) {
      return true;
    }
  }
  return false;
}

/** 把用户命中的所有权限组合并成一份「可执行指令清单」，供界面展示 */
export function allowedCommandPatterns(
  config: PermissionConfig,
  ctx: PermissionContext,
): string[] {
  const groups = resolveGroups(config, ctx);
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const g of groups) {
    g.allowCommands.forEach((p) => allow.add(p));
    g.denyCommands.forEach((p) => deny.add(p));
  }
  for (const d of deny) allow.delete(d);
  return [...allow];
}
