/**
 * 自动回复（关键词 / 正则 / 完全匹配）。
 *
 * 对标 EasyBot 的「回复预设的文本（支持设定关键词、正则）」。
 *
 * 安全约束：自动回复只产出**纯文本**，绝不触发 RCON。
 * 需要联动游戏内的场景（如「有人问在线人数就查一次」）走 `toGame` 标记，
 * 由上层用既有的模板化指令执行，仍然受参数校验与限流保护。
 */

import type { ResponderConfig, ResponderRule } from '../shared/types';

/** 一条待回复的消息上下文 */
export interface ResponderContext {
  /** 发送者 QQ */
  qq: string;
  /** 群号（私聊为空） */
  groupId?: string;
  /** 昵称 */
  nickname?: string;
  /** 是否为管理员 */
  isAdmin: boolean;
}

/** 一次命中结果 */
export interface ResponderHit {
  rule: ResponderRule;
  /** 已替换变量的回复文本 */
  reply: string;
}

/** 渲染回复模板里的变量 */
export function renderResponderReply(
  template: string,
  ctx: ResponderContext,
): string {
  return template
    .replace(/\{user\}/g, ctx.qq)
    .replace(/\{nickname\}/g, ctx.nickname ?? '')
    .replace(/\{group\}/g, ctx.groupId ?? '');
}

/** 判断一条规则是否命中消息 */
export function matchRule(rule: ResponderRule, message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  const p = rule.pattern;
  if (!p) return false;

  if (rule.matchType === 'exact') {
    return text.toLowerCase() === p.toLowerCase();
  }
  if (rule.matchType === 'keyword') {
    return text.toLowerCase().includes(p.toLowerCase());
  }
  if (rule.matchType === 'regex') {
    try {
      return new RegExp(p, 'i').test(text);
    } catch {
      // 非法正则：当作不命中，避免一条坏规则拖垮整条链路
      return false;
    }
  }
  return false;
}

/**
 * 自动回复引擎。
 *
 * 冷却粒度是「规则 + 会话」（同群同规则 N 秒内只回一次），
 * 避免群里连续聊天时同一个关键词被反复触发刷屏。
 */
export class Responder {
  private config: ResponderConfig;
  /** key = `${ruleId}:${sessionId}` → 上次触发时间戳 */
  private lastHit = new Map<string, number>();

  constructor(config: ResponderConfig) {
    this.config = config;
  }

  updateConfig(config: ResponderConfig): void {
    this.config = config;
  }

  /**
   * 评估一条消息，返回命中的规则（最多一条）。
   *
   * 为什么只回一条：多条规则同时命中时如果全都回，群里会瞬间刷出一堆消息。
   * 按规则在配置里的顺序取第一条命中的，最符合「用户预期」。
   */
  evaluate(message: string, ctx: ResponderContext): ResponderHit | null {
    if (!this.config.enabled) return null;
    const sid = ctx.groupId ?? `private:${ctx.qq}`;
    const now = Date.now();

    for (const rule of this.config.rules) {
      if (!rule.enabled) continue;
      if (rule.adminOnly && !ctx.isAdmin) continue;
      if (!matchRule(rule, message)) continue;

      const key = `${rule.id}:${sid}`;
      const last = this.lastHit.get(key) ?? 0;
      const cdMs = Math.max(0, rule.cooldownSeconds) * 1000;
      if (cdMs > 0 && now - last < cdMs) {
        // 命中但在冷却期：跳过这条规则，继续看后面的
        continue;
      }
      this.lastHit.set(key, now);

      return {
        rule,
        reply: renderResponderReply(rule.reply, ctx),
      };
    }
    return null;
  }

  /** 清空冷却记录（配置变更或手动重置时） */
  clearCooldowns(): void {
    this.lastHit.clear();
  }
}
