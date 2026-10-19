/**
 * 群服消息双向同步。
 *
 * 对标 EasyBot 的「消息同步（游戏↔群）+ 玩家事件通知」。
 *
 * 分工：
 *   - 游戏 → 群：由 logwatcher 的 chat 事件驱动
 *   - 群 → 游戏：由 onebot 的消息事件驱动
 *   - 进/退/死/成就：由 logwatcher 的对应事件驱动
 *
 * 所有对外发送都通过注入的 deps 完成，本模块不直接依赖 onebot / rcon，
 * 便于单测和替换实现。
 */

import type { ChatBridgeConfig, GameEvent, NotifyConfig } from '../shared/types';

/** 对外发送能力（由主进程注入） */
export interface ChatBridgeDeps {
  /**
   * 发到若干 QQ 群。
   *
   * kind 用于让上层决定「要不要渲染成图片」：
   * - chat：游戏内聊天同步，绝不出图（否则群里每条聊天一张卡）
   * - notice：进服/退服/死亡等事件通知，可按配置出图
   */
  sendToGroups(groups: string[], text: string, kind: 'chat' | 'notice'): Promise<void>;
  /** 发到游戏内（通常是 RCON tellraw @a） */
  sendToGame(text: string): Promise<void>;
}

/** 格式化模板变量 */
export function renderMessage(
  template: string,
  vars: Record<string, string>,
): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}

/**
 * 判断当前时间是否落在静音时段内。
 * start === end 视为「不启用静音」。
 * 支持跨零点（如 23 → 7）。
 */
export function inQuietHours(start: number, end: number, hour: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  // 跨零点
  return hour >= start || hour < end;
}

/** 剔除会破坏游戏内展示的控制字符（CQ 码、换行、§ 颜色码） */
export function sanitizeForGame(text: string): string {
  return text
    // QQ 富文本（图片、表情、@）在游戏内没有对应渲染，统一降级成文字标记
    .replace(/\[CQ:image,[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:face,[^\]]*\]/g, '[表情]')
    .replace(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/g, '@$1 ')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/§./g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** 应用敏感词替换表 */
export function applyReplacements(
  text: string,
  table: Array<{ from: string; to: string }>,
): string {
  let out = text;
  for (const r of table) {
    if (!r.from) continue;
    out = out.split(r.from).join(r.to ?? '');
  }
  return out;
}

/** 是否命中屏蔽规则 */
export function isBlocked(text: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (!p) continue;
    try {
      if (new RegExp(p, 'i').test(text)) return true;
    } catch {
      // 非法正则忽略
    }
  }
  return false;
}

/** 截断超长文本 */
export function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 群服消息桥。
 *
 * 只做「格式化成字符串 + 调用 deps」，不做任何 IO。
 */
export class ChatBridge {
  private config: ChatBridgeConfig;
  private notify: NotifyConfig;
  private deps: ChatBridgeDeps;
  /** 群→游戏的合并缓冲 */
  private mergeBuffer: string[] = [];
  private mergeTimer: NodeJS.Timeout | null = null;

  constructor(config: ChatBridgeConfig, notify: NotifyConfig, deps: ChatBridgeDeps) {
    this.config = config;
    this.notify = notify;
    this.deps = deps;
  }

  updateConfig(config: ChatBridgeConfig, notify: NotifyConfig): void {
    this.config = config;
    this.notify = notify;
  }

  /** 游戏内聊天 → 群 */
  async handleGameChat(ev: GameEvent): Promise<void> {
    const cfg = this.config;
    if (!cfg.enabled || !cfg.gameToChat.enabled) return;
    if (cfg.gameToChat.groups.length === 0) return;
    if (this.isQuiet()) return;
    if (isBlocked(ev.detail, cfg.blockPatterns)) return;

    const body = truncate(applyReplacements(ev.detail, cfg.replacements), cfg.maxLength);
    const text = renderMessage(cfg.gameToChat.template, {
      player: ev.player,
      message: body,
      server: '',
    });
    await this.deps.sendToGroups(cfg.gameToChat.groups, text, 'chat');
  }

  /** QQ 群消息 → 游戏内 */
  async handleChatMessage(input: {
    groupId?: string;
    qq: string;
    nickname: string;
    message: string;
  }): Promise<void> {
    const cfg = this.config;
    if (!cfg.enabled || !cfg.chatToGame.enabled) return;
    const gid = input.groupId ?? '';
    if (!gid || !cfg.chatToGame.groups.includes(gid)) return;
    if (this.isQuiet()) return;

    const raw = input.message.trim();
    if (!raw) return;
    if (cfg.chatToGame.skipCommands && /^(\/|!!|!)/.test(raw)) return;
    if (isBlocked(raw, cfg.blockPatterns)) return;

    const clean = truncate(
      applyReplacements(sanitizeForGame(raw), cfg.replacements),
      cfg.maxLength,
    );
    if (!clean) return;

    const text = renderMessage(cfg.chatToGame.template, {
      nickname: input.nickname || input.qq,
      message: clean,
    });

    if (cfg.chatToGame.mergeWindowMs > 0) {
      this.mergeBuffer.push(text);
      this.scheduleMergeFlush();
      return;
    }
    await this.deps.sendToGame(text);
  }

  /** 合并窗口到期后一次性发出 */
  private scheduleMergeFlush(): void {
    if (this.mergeTimer) return;
    const windowMs = Math.max(200, this.config.chatToGame.mergeWindowMs);
    this.mergeTimer = setTimeout(() => {
      this.mergeTimer = null;
      const buffered = this.mergeBuffer;
      this.mergeBuffer = [];
      if (buffered.length === 0) return;
      const text = truncate(buffered.join(' | '), this.config.maxLength * 2);
      void this.deps.sendToGame(text).catch((err) => {
        console.error('[chatbridge] 合并发送失败:', err);
      });
    }, windowMs);
  }

  /** 处理玩家事件（进/退/死/成就/启动）→ 群通知 */
  async handleGameEvent(ev: GameEvent): Promise<void> {
    const n = this.notify;
    if (!n.enabled || n.groups.length === 0) return;
    if (this.isQuiet()) return;

    const pick = (() => {
      switch (ev.kind) {
        case 'join':
          return n.join;
        case 'leave':
          return n.leave;
        case 'death':
          return n.death;
        case 'advancement':
          return n.advancement;
        case 'server-start':
          return n.serverStart;
        default:
          return null;
      }
    })();

    if (!pick || !pick.enabled) return;

    const text = renderMessage(pick.template, {
      player: ev.player,
      detail: ev.detail,
      server: '',
    });
    await this.deps.sendToGroups(n.groups, text, 'notice');
  }

  /** 是否在静音时段 */
  private isQuiet(): boolean {
    const { start, end } = this.config.quietHours;
    return inQuietHours(start, end, new Date().getHours());
  }

  /** 停止并清空合并缓冲 */
  dispose(): void {
    if (this.mergeTimer) {
      clearTimeout(this.mergeTimer);
      this.mergeTimer = null;
    }
    this.mergeBuffer = [];
  }
}
