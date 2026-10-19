/**
 * 玩家统计。
 *
 * 数据来源全部是「已经在别处发生过的事件」：
 *   - join / leave：logwatcher 解析的进出服事件（用于累计在线时长）
 *   - chat：聊天事件（发言数）
 *   - command：router 里指令命中（指令使用数）
 *
 * 因此这个模块本身不做 IO，只维护内存聚合，持久化交给 Store。
 */

import type { PlayerStats, StatsConfig } from '../shared/types';

/** 排行榜维度 */
export type LeaderboardBy = 'onlineSeconds' | 'chatCount' | 'commandCount' | 'joinCount';

/** 把秒数格式化成「3天2小时15分」 */
export function formatOnlineTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}小时`);
  if (m > 0) parts.push(`${m}分`);
  if (parts.length === 0) parts.push(`${s}秒`);
  return parts.join('');
}

/** 统计管理器 */
export class StatsManager {
  private config: StatsConfig;
  private players = new Map<string, PlayerStats>();
  /** 当前在线玩家的进服时间戳（毫秒），用于计算本次在线时长 */
  private sessionStart = new Map<string, number>();
  private dirty = false;

  constructor(config: StatsConfig, initial: PlayerStats[] = []) {
    this.config = config;
    for (const p of initial) {
      this.players.set(p.playerId.toLowerCase(), { ...p });
    }
  }

  updateConfig(config: StatsConfig): void {
    this.config = config;
  }

  /** 是否启用了统计（关闭时所有记录都是空操作） */
  private get active(): boolean {
    return this.config.enabled;
  }

  private ensure(playerId: string): PlayerStats | null {
    if (!this.active) return null;
    const key = playerId.toLowerCase();
    let rec = this.players.get(key);
    if (!rec) {
      const now = new Date().toISOString();
      rec = {
        playerId,
        firstSeen: now,
        lastSeen: now,
        onlineSeconds: 0,
        chatCount: 0,
        commandCount: 0,
        joinCount: 0,
      };
      this.players.set(key, rec);
      // 新玩家加入后立刻检查容量：所有入口（进服/发言/指令）都会经过这里，
      // 就不必在三个 on* 里各写一次淘汰逻辑
      this.dirty = true;
      this.evictIfNeeded();
    }
    return rec;
  }

  /** 玩家进服：记一次 join，并开始计时 */
  onJoin(playerId: string): void {
    const rec = this.ensure(playerId);
    if (!rec) return;
    const now = new Date().toISOString();
    rec.joinCount += 1;
    rec.lastSeen = now;
    this.sessionStart.set(playerId.toLowerCase(), Date.now());
    this.dirty = true;
    this.evictIfNeeded();
  }

  /** 玩家退服：结算本次在线时长 */
  onLeave(playerId: string): void {
    if (!this.active) return;
    const key = playerId.toLowerCase();
    const rec = this.players.get(key);
    if (!rec) return;
    const start = this.sessionStart.get(key);
    if (start) {
      rec.onlineSeconds += Math.max(0, Math.floor((Date.now() - start) / 1000));
      this.sessionStart.delete(key);
    }
    rec.lastSeen = new Date().toISOString();
    this.dirty = true;
  }

  /** 记一条发言 */
  onChat(playerId: string): void {
    const rec = this.ensure(playerId);
    if (!rec) return;
    rec.chatCount += 1;
    rec.lastSeen = new Date().toISOString();
    this.dirty = true;
  }

  /** 记一次指令使用 */
  onCommand(playerId: string): void {
    const rec = this.ensure(playerId);
    if (!rec) return;
    rec.commandCount += 1;
    rec.lastSeen = new Date().toISOString();
    this.dirty = true;
  }

  /**
   * 计算「含当前进行中会话」的实时在线时长。
   * 直接读 onlineSeconds 会漏掉正在在线的这段时间，查询前走这里。
   */
  private liveOnline(rec: PlayerStats): number {
    const start = this.sessionStart.get(rec.playerId.toLowerCase());
    if (!start) return rec.onlineSeconds;
    return rec.onlineSeconds + Math.max(0, Math.floor((Date.now() - start) / 1000));
  }

  /** 单个玩家的统计（含实时在线时长） */
  get(playerId: string): PlayerStats | null {
    const rec = this.players.get(playerId.toLowerCase());
    if (!rec) return null;
    return { ...rec, onlineSeconds: this.liveOnline(rec) };
  }

  /** 全部玩家（按在线时长降序） */
  list(): PlayerStats[] {
    return [...this.players.values()]
      .map((r) => ({ ...r, onlineSeconds: this.liveOnline(r) }))
      .sort((a, b) => b.onlineSeconds - a.onlineSeconds);
  }

  /** 排行榜 */
  top(by: LeaderboardBy, limit = 10): PlayerStats[] {
    return [...this.players.values()]
      .map((r) => ({ ...r, onlineSeconds: this.liveOnline(r) }))
      .sort((a, b) => b[by] - a[by])
      .slice(0, Math.max(1, limit));
  }

  /** 剔除长久未上线的记录，把总量压到 maxPlayers 以内 */
  private evictIfNeeded(): void {
    const max = Math.max(1, this.config.maxPlayers);
    if (this.players.size <= max) return;
    const sorted = [...this.players.values()].sort(
      (a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen),
    );
    const drop = this.players.size - max;
    for (let i = 0; i < drop; i++) {
      this.players.delete(sorted[i].playerId.toLowerCase());
    }
    this.dirty = true;
  }

  /** 是否自上次取走后有变化（用于决定是否落盘） */
  consumeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  /** 导出全部记录（落盘用） */
  snapshot(): PlayerStats[] {
    return [...this.players.values()].map((r) => ({ ...r }));
  }

  /** 清空 */
  clear(): void {
    this.players.clear();
    this.sessionStart.clear();
    this.dirty = true;
  }
}
