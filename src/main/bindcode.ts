import { randomInt } from 'node:crypto';
import type { BindCodeRecord, CodeFormat } from '../shared/types';

/** 验证码字符集 */
const CHARSETS: Record<CodeFormat, string> = {
  number: '0123456789',
  // 去掉容易混淆的 I L O
  letter: 'ABCDEFGHJKMNPQRSTUVWXYZ',
  mixed: '23456789ABCDEFGHJKMNPQRSTUVWXYZ',
};

export interface IssueOptions {
  length: number;
  format: CodeFormat;
  /** 有效期（秒） */
  ttlSeconds: number;
  playerId: string;
  groupId?: string;
  serverId?: string;
}

export interface ConsumeResult {
  ok: boolean;
  /** 命中失败时的原因（用于渲染 bindFail 模板） */
  reason?: string;
  record?: BindCodeRecord;
}

/**
 * 验证码管理器（双向验证模式的核心）。
 *
 * 与 EasyBot 的行为对齐：
 * - 玩家在服务器内发起绑定 → 生成一次性验证码，带有效期
 * - 玩家在群内发送「绑定 <验证码>」→ 校验并消费验证码
 * - 验证码是一次性的：消费后立即失效，无论成功与否都从池中移除
 * - 同一个玩家重复发起时，旧验证码会被作废（避免多个有效码并存造成混乱）
 */
export class BindCodeManager {
  /** code → 记录 */
  private codes = new Map<string, BindCodeRecord>();
  /** playerId → code，用于作废同一玩家的旧码 */
  private byPlayer = new Map<string, string>();

  /** 生成一个不重复的验证码 */
  private generate(length: number, format: CodeFormat): string {
    const charset = CHARSETS[format] ?? CHARSETS.number;
    const len = Math.max(4, Math.min(12, length));
    // 冲突概率极低，但仍做有限次重试，避免碰撞
    for (let attempt = 0; attempt < 50; attempt++) {
      let out = '';
      for (let i = 0; i < len; i++) {
        out += charset[randomInt(0, charset.length)];
      }
      if (!this.codes.has(out)) return out;
    }
    // 极端情况下退化为带时间戳后缀
    return `${Date.now()}`.slice(-len);
  }

  /** 清理过期验证码，返回是否发生变化 */
  private purge(now = Date.now()): boolean {
    let changed = false;
    for (const [code, rec] of this.codes) {
      if (new Date(rec.expiresAt).getTime() <= now) {
        this.codes.delete(code);
        if (this.byPlayer.get(rec.playerId) === code) {
          this.byPlayer.delete(rec.playerId);
        }
        changed = true;
      }
    }
    return changed;
  }

  /** 签发一个验证码，会作废同一玩家此前的验证码 */
  issue(opts: IssueOptions): BindCodeRecord {
    this.purge();

    // 同一玩家重复发起 → 作废旧码，保证同时只有一个有效码
    const old = this.byPlayer.get(opts.playerId);
    if (old) {
      this.codes.delete(old);
      this.byPlayer.delete(opts.playerId);
    }

    const code = this.generate(opts.length, opts.format);
    const now = Date.now();
    const ttl = Math.max(30, opts.ttlSeconds) * 1000;
    const record: BindCodeRecord = {
      code,
      playerId: opts.playerId,
      groupId: opts.groupId,
      serverId: opts.serverId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    this.codes.set(code, record);
    this.byPlayer.set(opts.playerId, code);
    return record;
  }

  /**
   * 消费一个验证码。
   * 无论成功失败都会把该码从池中移除（一次性），只有「不存在/过期」才算未命中。
   */
  consume(code: string, opts?: { groupId?: string }): ConsumeResult {
    this.purge();
    const key = code.trim().toUpperCase();
    const rec = this.codes.get(key);
    if (!rec) {
      return { ok: false, reason: '验证码无效或已过期，请在服务器内重新获取' };
    }

    // 一次性：先移除再校验其余条件
    this.codes.delete(key);
    if (this.byPlayer.get(rec.playerId) === key) {
      this.byPlayer.delete(rec.playerId);
    }

    // 若签发时绑定了群，则要求在同一个群内完成验证
    if (rec.groupId && opts?.groupId && rec.groupId !== opts.groupId) {
      return {
        ok: false,
        reason: '该验证码只能在其发起绑定的群内使用，请回到原群完成绑定',
      };
    }

    return { ok: true, record: rec };
  }

  /** 查看某个玩家的待验证码（用于界面提示「已发码待验证」） */
  findOfPlayer(playerId: string): BindCodeRecord | undefined {
    this.purge();
    const code = this.byPlayer.get(playerId);
    return code ? this.codes.get(code) : undefined;
  }

  /** 按验证码精确查询 */
  find(code: string): BindCodeRecord | undefined {
    this.purge();
    return this.codes.get(code.trim().toUpperCase());
  }

  /** 列出所有待验证码 */
  list(): BindCodeRecord[] {
    this.purge();
    return [...this.codes.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  /** 主动撤销一个验证码（失败时提示失败；成功时提示已撤销） */
  cancel(code: string): boolean {
    const key = code.trim().toUpperCase();
    const rec = this.codes.get(key);
    if (!rec) return false;
    this.codes.delete(key);
    if (this.byPlayer.get(rec.playerId) === key) {
      this.byPlayer.delete(rec.playerId);
    }
    return true;
  }

  /** 清空全部验证码（配置重置 / 关停时调用） */
  clear(): void {
    this.codes.clear();
    this.byPlayer.clear();
  }

  /** 剩余有效秒数，用于渲染 #time 占位符 */
  remainingSeconds(rec: BindCodeRecord): number {
    const left = new Date(rec.expiresAt).getTime() - Date.now();
    return Math.max(0, Math.ceil(left / 1000));
  }
}

/**
 * 把剩余秒数渲染成人话，例如 "4 分 30 秒"。
 * 与 EasyBot 在游戏内展示「请在 xx 前完成验证」的语义保持一致。
 */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '已过期';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m <= 0) return `${s} 秒`;
  if (s === 0) return `${m} 分钟`;
  return `${m} 分 ${s} 秒`;
}
