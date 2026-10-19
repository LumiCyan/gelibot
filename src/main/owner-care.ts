/**
 * 慰问服主：每天在群里报一次「服主离开第 N 天」。
 *
 * 缘起：很多服的服主建完服就不见了，玩家之间拿「服主失踪 N 天」当梗。
 * 这个模块就是个带点温度的小播报器 —— 起始日当天算第 1 天。
 *
 * 设计要点：
 * 1. 天数计算用 UTC 归一化（Date.UTC(y,m,d)）而不是直接减毫秒差额，
 *    否则夏令时/时区调整会让「第 N 天」在某天突然跳 2 或原地不动。
 * 2. 播报去重按「本地日期字符串」比较，同一分钟多次 tick 不会重复发。
 * 3. 纯函数（todayDateString / daysSince / formatCareMessage）不依赖 electron，可单测。
 */

import type { OwnerCareConfig, OwnerCareStatus } from '../shared/types';

/** 本地日期 → YYYY-MM-DD */
export function todayDateString(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 把 YYYY-MM-DD 转成 UTC 日序号（同一天 = 同一个整数） */
function utcDayOf(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ts = Date.UTC(y, mo - 1, d);
  // 反查校验（拦掉 2026-02-31 这类会被 Date 静默进位的日期）
  const back = new Date(ts);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return Math.floor(ts / 86400000);
}

/**
 * 计算「今天是第几天」，起始日当天 = 1。
 *
 * 起始日晚于今天（还没开始）返回 0；日期非法也返回 0。
 */
export function daysSince(startDate: string, now = new Date()): number {
  const start = utcDayOf(startDate);
  if (start === null) return 0;
  const today = Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000,
  );
  const diff = today - start;
  if (diff < 0) return 0;
  return diff + 1;
}

/** 渲染播报文案 */
export function formatCareMessage(
  template: string,
  vars: { days: number; owner: string; startDate: string },
): string {
  return String(template ?? '')
    .split('{days}')
    .join(String(vars.days))
    .split('{owner}')
    .join(vars.owner)
    .split('{startDate}')
    .join(vars.startDate);
}

/** 校验并规范化 HH:mm；非法返回 null */
export function parseDailyAt(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** 发送能力（主进程注入） */
export interface OwnerCareDeps {
  sendToGroups(groups: string[], text: string): Promise<void>;
  log?: (msg: string) => void;
}

/**
 * 慰问服主服务。
 *
 * 只在 `dailyAt` 命中的那一分钟发一次；同一天不会重复。
 * 进程重启后「今天已发」的记录会丢，可能补发一次 —— 这是刻意的取舍：
 * 为了这点去写磁盘状态不值得，而多一条播报的代价远小于漏播。
 */
export class OwnerCareService {
  private config: OwnerCareConfig;
  private deps: OwnerCareDeps;
  private timer: NodeJS.Timeout | null = null;
  /** 已播报的本地日期（YYYY-MM-DD） */
  private lastSentDate: string | null = null;

  constructor(config: OwnerCareConfig, deps: OwnerCareDeps) {
    this.config = config;
    this.deps = deps;
  }

  updateConfig(config: OwnerCareConfig): void {
    this.config = config;
    if (config.enabled && this.timer === null) this.start();
    if (!config.enabled && this.timer !== null) this.stop();
  }

  start(): void {
    if (this.timer) return;
    // 20 秒一次：比一分钟更细，避免定时器漂移刚好跨过目标分钟
    this.timer = setInterval(() => this.tick(), 20_000);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 今天第几天 */
  getDays(now = new Date()): number {
    return daysSince(this.config.startDate, now);
  }

  /** 生成当前文案 */
  buildMessage(now = new Date()): string {
    const owner = this.config.ownerName.trim() || '服主';
    return formatCareMessage(this.config.template, {
      days: this.getDays(now),
      owner,
      startDate: this.config.startDate,
    });
  }

  /** 带 @ 的最终消息（群消息用） */
  private buildMessageWithMention(now = new Date()): string {
    const text = this.buildMessage(now);
    const qq = this.config.ownerQQ.trim();
    if (!this.config.mentionOwner || !qq) return text;
    return `[CQ:at,qq=${qq}] ${text}`;
  }

  getStatus(now = new Date()): OwnerCareStatus {
    const today = todayDateString(now);
    const at = parseDailyAt(this.config.dailyAt);
    return {
      enabled: this.config.enabled,
      startDate: this.config.startDate,
      days: this.getDays(now),
      sentToday: this.lastSentDate === today,
      nextAt: at ? this.config.dailyAt : undefined,
      previewMessage: this.buildMessage(now),
    };
  }

  /** 立即播报一次（界面按钮用；不算「今天已发」以外的特殊处理） */
  async sendNow(now = new Date()): Promise<{ ok: boolean; error?: string }> {
    const groups = this.config.groups.filter(Boolean);
    if (groups.length === 0) return { ok: false, error: '还没有配置目标群' };
    try {
      await this.deps.sendToGroups(groups, this.buildMessageWithMention(now));
      this.lastSentDate = todayDateString(now);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** 每分钟粒度检查是否到了播报时刻 */
  private tick(): void {
    const cfg = this.config;
    if (!cfg.enabled) return;
    if (cfg.groups.length === 0) return;

    const now = new Date();
    const at = parseDailyAt(cfg.dailyAt);
    if (!at) return;
    if (now.getHours() !== at.hour || now.getMinutes() !== at.minute) return;

    const today = todayDateString(now);
    if (this.lastSentDate === today) return;

    // 先记账再发送：发送抛错也不要在一分钟内反复重试
    this.lastSentDate = today;
    void this.deps
      .sendToGroups(cfg.groups, this.buildMessageWithMention(now))
      .catch((err) => {
        this.deps.log?.(`慰问播报失败：${(err as Error).message}`);
      });
  }
}
