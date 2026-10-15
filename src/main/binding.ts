import type {
  BindCodeRecord,
  Binding,
  BindingConfig,
} from '../shared/types';
import type { BindCodeManager } from './bindcode';

/** 验证 MC 玩家 ID：与 Minecraft 用户名规则一致 */
export const PLAYER_ID_RE = /^[A-Za-z0-9_]{3,16}$/;

/** 绑定操作结果 */
export interface BindResult {
  ok: boolean;
  message: string;
  /** 校验失败时的原因（不含模板前缀），便于上层复用 */
  reason?: string;
  /** 成功时返回的绑定记录 */
  binding?: Binding;
  /** 双向验证模式：是否需要提示「去群里发验证码」 */
  awaitingCode?: boolean;
}

/** 渲染模板占位符 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/#(\w+)/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m,
  );
}

/**
 * 绑定管理器：负责 QQ 号 ↔ MC 玩家 ID 的绑定关系。
 *
 * 两条强制约束（与 EasyBot 一致）：
 * 1. 单个 QQ 最大绑定数量可配
 * 2. 玩家 ID 全局唯一，防止冒用
 */
export class BindingManager {
  private store: {
    listBindings(): Binding[];
    getBindingsOf(qq: string): Binding[];
    countBindingsOf(qq: string): number;
    hasBinding(qq: string, playerId: string): boolean;
    isPlayerTaken(playerId: string): Binding | undefined;
    addBinding(binding: Binding): void;
    removeBinding(qq: string, playerId: string): boolean;
    removeBindingsOf(qq: string): number;
  };
  private config: BindingConfig;
  private codes: BindCodeManager;
  private serverId: string;
  /** 是否启用「QQ 发起 → 验证服发码 → 主服加白」的双服流程（影响文案） */
  private verifyFlow = false;

  constructor(
    store: BindingManager['store'],
    config: BindingConfig,
    codes: BindCodeManager,
    serverId = '',
  ) {
    this.store = store;
    this.config = config;
    this.codes = codes;
    this.serverId = serverId;
  }

  updateConfig(
    config: BindingConfig,
    serverId?: string,
    opts?: { verifyFlow?: boolean },
  ): void {
    this.config = config;
    if (serverId !== undefined) this.serverId = serverId;
    if (opts?.verifyFlow !== undefined) this.verifyFlow = opts.verifyFlow;
  }

  getConfig(): BindingConfig {
    return this.config;
  }

  list(): Binding[] {
    return this.store.listBindings();
  }

  listOf(qq: string): Binding[] {
    return this.store.getBindingsOf(qq);
  }

  countOf(qq: string): number {
    return this.store.countBindingsOf(qq);
  }

  findByPlayer(playerId: string): Binding | undefined {
    return this.store.isPlayerTaken(playerId);
  }

  hasAnyBinding(qq: string): boolean {
    return this.countOf(qq) > 0;
  }

  private maxOf(): number {
    return Math.max(1, this.config.maxBindingsPerQQ);
  }

  /** 统一渲染成功消息 */
  private successMessage(qq: string, playerId: string): string {
    return renderTemplate(this.config.messages.bindSuccess, {
      player: playerId,
      qq,
      nickname: this.config.messages.bindSuccess.includes('#nickname') ? '' : '',
      current: this.countOf(qq),
      max: this.maxOf(),
    }).trim();
  }

  /** 统一渲染失败消息 */
  fail(reason: string): BindResult {
    return {
      ok: false,
      reason,
      message: renderTemplate(this.config.messages.bindFail, { why: reason }),
    };
  }

  /**
   * 写入前的统一闸门校验（所有绑定入口共用）。
   * 返回 null 表示可以继续写入；返回字符串表示拒绝原因。
   */
  private checkCommit(
    qq: string,
    playerId: string,
    opts: { enforceLimit?: boolean } = {},
  ): string | null {
    const name = playerId.trim();

    if (this.store.hasBinding(qq, name)) {
      return `你已经绑定过 ${name} 了`;
    }

    if (opts.enforceLimit !== false) {
      const max = this.maxOf();
      if (this.countOf(qq) >= max) {
        return `绑定数量已达上限（最多 ${max} 个），请先使用 /解绑 释放名额`;
      }
    }

    const taken = this.store.isPlayerTaken(name);
    if (taken && taken.qq !== qq) {
      return `玩家 ID ${name} 已被其他 QQ 绑定，如有异议请联系管理员`;
    }

    return null;
  }

  /**
   * 双服流程专用：QQ 侧发起绑定前的预检。
   *
   * 会先跑一遍与写入完全相同的闸门（自助开关 / ID 合法性 / 数量上限 / 是否被占用），
   * 避免出现「验证码已经发到游戏里了，最后一步却绑不上」的糟糕体验。
   */
  precheckQqBind(qq: string, playerId: string): { ok: boolean; reason?: string } {
    const gate = this.checkSelfBindAllowed();
    if (gate) return { ok: false, reason: gate };

    const invalid = this.validatePlayerId(playerId);
    if (invalid) return { ok: false, reason: invalid };

    const why = this.checkCommit(qq, playerId);
    if (why) return { ok: false, reason: why };

    return { ok: true };
  }

  /**
   * 核心写入：通过全部校验后落库。
   * 所有绑定入口（自助 / 验证码 / 管理员）最终都汇聚到这里，
   * 保证约束只有一处实现，不会因为入口不同而绕过限制。
   */
  private commit(
    qq: string,
    playerId: string,
    opts: { fromGroup?: string; nickname?: string; enforceLimit?: boolean } = {},
  ): BindResult {
    const name = playerId.trim();
    const enforceLimit = opts.enforceLimit !== false;

    const why = this.checkCommit(qq, name, { enforceLimit });
    if (why) return this.fail(why);

    const binding: Binding = {
      qq,
      playerId: name,
      fromGroup: opts.fromGroup,
      serverId: this.serverId || undefined,
      nickname: opts.nickname,
      createdAt: new Date().toISOString(),
    };
    this.store.addBinding(binding);
    return { ok: true, message: this.successMessage(qq, name), binding };
  }

  /** 校验玩家 ID 是否合法 */
  private validatePlayerId(playerId: string): string | null {
    const name = playerId.trim();
    if (!PLAYER_ID_RE.test(name)) {
      return '玩家 ID 不合法（需 3-16 位字母、数字或下划线）';
    }
    return null;
  }

  /** 自助绑定的总开关校验 */
  private checkSelfBindAllowed(): string | null {
    if (!this.config.allowSelfBind) {
      return '自助绑定已被管理员关闭，请联系管理员处理';
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 模式一：社交平台信任模式（群里直接发「绑定 + 玩家ID」）
  // ------------------------------------------------------------------

  /** 信任模式的自助绑定 */
  bindByPlayerId(
    qq: string,
    playerId: string,
    opts: { fromGroup?: string; nickname?: string } = {},
  ): BindResult {
    const gate = this.checkSelfBindAllowed();
    if (gate) return this.fail(gate);

    const invalid = this.validatePlayerId(playerId);
    if (invalid) return this.fail(invalid);

    return this.commit(qq, playerId, opts);
  }

  // ------------------------------------------------------------------
  // 模式二：双向验证模式（服务器取码 → 群内发「绑定 + 验证码」）
  // ------------------------------------------------------------------

  /** 服务器内发起绑定，签发验证码 */
  issueCodeFor(
    playerId: string,
    opts: { groupId?: string; qq?: string } = {},
  ): { ok: boolean; record?: BindCodeRecord; error?: string } {
    const invalid = this.validatePlayerId(playerId);
    if (invalid) return { ok: false, error: invalid };

    const record = this.codes.issue({
      length: this.config.codeLength,
      format: this.config.codeFormat,
      ttlSeconds: this.config.codeTtlSeconds,
      playerId: playerId.trim(),
      groupId: opts.groupId,
      qq: opts.qq,
      serverId: this.serverId || undefined,
    });
    return { ok: true, record };
  }

  /** 双向验证模式：用验证码完成绑定 */
  bindByCode(
    qq: string,
    code: string,
    opts: { fromGroup?: string; nickname?: string } = {},
  ): BindResult {
    const gate = this.checkSelfBindAllowed();
    if (gate) return this.fail(gate);

    const input = code.trim();
    if (!input) return this.fail('请提供验证码');

    // 管理员不因验证码失效被卡死：直接按玩家 ID 绑定属于管理员的特权，不走这里。
    // 带上 qq 做归属校验：只允许发起者本人使用该验证码。
    const consumed = this.codes.consume(input, {
      groupId: opts.fromGroup,
      qq,
    });
    if (!consumed.ok || !consumed.record) {
      return this.fail(consumed.reason ?? '验证码无效或已过期');
    }

    const playerId = consumed.record.playerId;
    const result = this.commit(qq, playerId, opts);
    if (!result.ok) {
      // 绑定失败时验证码已被消费，需要重新取码——这里在原因后补一句提示
      const retry = `${result.reason ?? '绑定失败'}（验证码已作废，请重新获取）`;
      return this.fail(retry);
    }
    return result;
  }

  /** 当前的绑定模式 */
  get mode() {
    return this.config.mode;
  }

  // ------------------------------------------------------------------
  // 解绑
  // ------------------------------------------------------------------

  /** 按 QQ + 玩家 ID 解绑 */
  remove(qq: string, playerId: string, opts: { asAdmin?: boolean } = {}): BindResult {
    if (!opts.asAdmin && !this.config.allowSelfUnbind) {
      return this.fail('自助解绑已被管理员关闭，请联系管理员处理');
    }
    const name = playerId.trim();
    if (!name) {
      // 未指定玩家 ID：若只有一个绑定，直接解掉，符合直觉
      const mine = this.listOf(qq);
      if (mine.length === 1) {
        this.store.removeBinding(qq, mine[0].playerId);
        return {
          ok: true,
          message: renderTemplate(this.config.messages.unbindSuccess, {
            player: mine[0].playerId,
            qq,
          }),
        };
      }
      if (mine.length === 0) return this.fail('你当前没有任何绑定记录');
      const list = mine.map((b) => b.playerId).join('、');
      return this.fail(`你绑定了多个账号，请指定要解绑的玩家 ID：${list}`);
    }

    const ok = this.store.removeBinding(qq, name);
    if (!ok) return this.fail(`未找到绑定：${name}`);
    return {
      ok: true,
      message: renderTemplate(this.config.messages.unbindSuccess, { player: name, qq }),
    };
  }

  /** 退群 / 清号：移除某个 QQ 的全部绑定，返回被解绑的玩家 ID */
  removeAllOf(qq: string): string[] {
    const players = this.listOf(qq).map((b) => b.playerId);
    this.store.removeBindingsOf(qq);
    return players;
  }

  /** 管理员强制绑定，忽略自助开关与数量上限，并可直接改绑 */
  adminBind(qq: string, playerId: string): BindResult {
    const invalid = this.validatePlayerId(playerId);
    if (invalid) return this.fail(invalid);

    const name = playerId.trim();
    const taken = this.store.isPlayerTaken(name);
    if (taken && taken.qq !== qq) {
      // 管理员可直接改绑：先移除旧的
      this.store.removeBinding(taken.qq, name);
    }
    if (this.store.hasBinding(qq, name)) {
      return this.fail(`${qq} 已绑定 ${name}`);
    }
    this.store.addBinding({
      qq,
      playerId: name,
      serverId: this.serverId || undefined,
      createdAt: new Date().toISOString(),
    });
    return { ok: true, message: `已绑定 ${qq} ↔ ${name}` };
  }

  // ------------------------------------------------------------------
  // 查询与展示
  // ------------------------------------------------------------------

  formatList(qq: string): string {
    const list = this.listOf(qq);
    if (list.length === 0) {
      if (this.config.mode !== 'code') {
        return '你当前没有任何绑定记录。\n直接发送「绑定 <玩家ID>」即可完成绑定。';
      }
      const hint = this.verifyFlow
        ? '发送「绑定 <玩家ID>」，验证码会发到你的游戏内对话框（需先登录验证服）。'
        : '在服务器内获取验证码后，发送「绑定 <验证码>」即可完成绑定。';
      return `你当前没有任何绑定记录。\n${hint}`;
    }
    const max = this.maxOf();
    const lines = list.map((b, i) => {
      const when = new Date(b.createdAt).toLocaleString('zh-CN');
      return `${i + 1}. ${b.playerId}（${when}）`;
    });
    return `你的绑定（${list.length}/${max}）：\n${lines.join('\n')}`;
  }

  /** 管理员查询：按 QQ 或 玩家ID 反查 */
  query(keyword: string): string {
    const key = keyword.trim();
    if (!key) return '用法：/查询绑定 <QQ号 或 玩家ID>';

    const byPlayer = this.findByPlayer(key);
    if (byPlayer) {
      return `玩家 ${byPlayer.playerId} 归属 QQ：${byPlayer.qq}${
        byPlayer.fromGroup ? `（来源群 ${byPlayer.fromGroup}）` : ''
      }`;
    }

    const ofQq = this.listOf(key);
    if (ofQq.length > 0) {
      const lines = ofQq.map((b) => b.playerId).join('、');
      return `QQ ${key} 绑定了：${lines}`;
    }

    return `未找到与「${key}」相关的绑定记录`;
  }

  /** 群名片文本：多个 ID 用空格分隔，超长截断 */
  cardText(qq: string, maxLen = 30): string {
    const list = this.listOf(qq);
    if (list.length === 0) return '';
    const joined = list.map((b) => b.playerId).join(' ');
    const text = `${this.config.cardPrefix}${joined}`;
    return text.length > maxLen ? text.slice(0, maxLen) : text;
  }

  /** 该服务器是否处于强制绑定模式 */
  isForceBindActive(): boolean {
    if (!this.config.forceBind.enabled) return false;
    const servers = this.config.forceBind.servers;
    if (!servers || servers.length === 0) return true;
    return servers.includes(this.serverId);
  }

  /** 渲染强制绑定的踢出消息 */
  kickMessage(): string {
    return renderTemplate(this.config.messages.kickMessage, {
      prefix: this.config.cardPrefix,
    });
  }
}
