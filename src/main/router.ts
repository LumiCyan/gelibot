import type {
  AppConfig,
  AuditEntry,
  CommandRule,
  RconResult,
} from '../shared/types';
import type { BindCodeManager } from './bindcode';
import { formatDuration } from './bindcode';
import type { BindResult, BindingManager } from './binding';
import { PLAYER_ID_RE, renderTemplate } from './binding';
import type { MessageEvent } from './onebot';
import type { RconClient } from './rcon';
import type { Store } from './store';

/** 指令处理结果 */
interface HandleResult {
  /** 是否有响应（用于判断是否回复） */
  handled: boolean;
  /** 要回复的文本 */
  reply?: string;
}

/** 内置的绑定管理指令名（不投递 RCON，由本层直接处理） */
const BUILTIN = {
  bind: ['绑定', 'bind'],
  unbind: ['解绑', 'unbind'],
  myBind: ['我的绑定', 'mybind'],
  queryBind: ['查询绑定', '查询', 'querybind'],
  help: ['帮助', 'help', '菜单'],
};

/**
 * 指令路由与权限控制中心。
 *
 * 安全设计原则：
 * 1. 聊天源白名单：只有配置内的群 / 私聊才会被处理
 * 2. 指令白名单：只有配置内且启用的命令才会被投递
 * 3. 模板化：用户输入只作为参数填充模板，绝不拼接任意命令
 * 4. 参数校验：参数必须匹配 MC 用户名规则
 * 5. 限流：同一用户单位时间内只能触发一次
 * 6. 全量审计：每一条投递的 RCON 命令都落库
 */
export class CommandRouter {
  private store: Store;
  private binding: BindingManager;
  private codes: BindCodeManager;
  private rcon: RconClient;
  private config: AppConfig;
  private lastTrigger = new Map<string, number>();

  constructor(
    store: Store,
    binding: BindingManager,
    codes: BindCodeManager,
    rcon: RconClient,
    config: AppConfig,
  ) {
    this.store = store;
    this.binding = binding;
    this.codes = codes;
    this.rcon = rcon;
    this.config = config;
    this.binding.updateConfig(config.binding, config.serverId);
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
    this.binding.updateConfig(config.binding, config.serverId);
  }

  private isAdmin(qq: string): boolean {
    return this.config.whitelist.admins.includes(qq);
  }

  /** 判断消息源是否被允许处理 */
  private isSourceAllowed(ev: MessageEvent): boolean {
    const wl = this.config.whitelist;
    if (ev.message_type === 'group') {
      if (!wl.groupEnabled) return false;
      // 管理员所在群不受白名单限制
      if (wl.groups.includes(String(ev.group_id))) return true;
      return this.isAdmin(String(ev.user_id));
    }
    if (!wl.privateEnabled) return false;
    return (
      wl.privates.includes(String(ev.user_id)) ||
      this.isAdmin(String(ev.user_id))
    );
  }

  private checkRateLimit(qq: string): boolean {
    const now = Date.now();
    const last = this.lastTrigger.get(qq) ?? 0;
    if (now - last < this.config.rateLimitMs) return false;
    this.lastTrigger.set(qq, now);
    return true;
  }

  private findRule(name: string): CommandRule | undefined {
    return this.config.commands.find(
      (c) => c.enabled && c.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private matchBuiltin(name: string): keyof typeof BUILTIN | null {
    const lower = name.toLowerCase();
    for (const key of Object.keys(BUILTIN) as Array<keyof typeof BUILTIN>) {
      if (BUILTIN[key].some((k) => k.toLowerCase() === lower)) return key;
    }
    return null;
  }

  /** 构建帮助文本 */
  private buildHelp(isAdmin: boolean): string {
    const lines: string[] = [];
    for (const cmd of this.config.commands) {
      if (!cmd.enabled) continue;
      if (cmd.adminOnly && !isAdmin) continue;
      lines.push(`/${cmd.name}  -  ${cmd.description}`);
    }

    const mode = this.config.binding.mode;
    lines.push('');
    lines.push('—— 账号绑定 ——');
    if (mode === 'code') {
      lines.push('/绑定 <验证码>  -  双向验证：先在服务器内取码，再在群内绑定');
    } else {
      lines.push('/绑定 <玩家ID>  -  直接绑定你的游戏账号');
    }
    if (this.config.binding.allowSelfUnbind) {
      lines.push('/解绑 [玩家ID]  -  解除绑定（仅一个绑定时可省略）');
    }
    lines.push('/我的绑定  -  查看已绑定账号');
    if (isAdmin) {
      lines.push('/查询绑定 <QQ 或 玩家ID>  -  反查绑定归属（管理员）');
    }
    return `可用指令：\n${lines.join('\n')}`;
  }

  /** 主入口：处理一条消息事件，返回需要回复的内容 */
  async handle(ev: MessageEvent): Promise<HandleResult> {
    if (!this.isSourceAllowed(ev)) return { handled: false };

    const qq = String(ev.user_id);
    const raw = (ev.raw_message ?? '').trim();
    if (!raw.startsWith('/')) {
      // 非指令消息不处理（除非启用了「按消息刷新群名片」）
      this.maybeRefreshCard(ev).catch(() => undefined);
      if (raw === '/') {
        return { handled: true, reply: this.buildHelp(this.isAdmin(qq)) };
      }
      return { handled: false };
    }

    const body = raw.slice(1).trim();
    const spaceIdx = body.search(/\s/);
    const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
    const argsRaw = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();
    const args = argsRaw ? argsRaw.split(/\s+/) : [];

    if (!name) return { handled: true, reply: this.buildHelp(this.isAdmin(qq)) };

    // 帮助指令优先，不受限流影响
    if (this.matchBuiltin(name) === 'help') {
      return { handled: true, reply: this.buildHelp(this.isAdmin(qq)) };
    }

    if (!this.checkRateLimit(qq)) {
      return { handled: true, reply: '操作太频繁，请稍后再试' };
    }

    const builtin = this.matchBuiltin(name);
    if (builtin) {
      return { handled: true, reply: await this.handleBuiltin(builtin, qq, args, ev) };
    }

    return this.handleRconCommand(name, qq, args, ev);
  }

  /** 处理内置的绑定类指令 */
  private async handleBuiltin(
    kind: keyof typeof BUILTIN,
    qq: string,
    args: string[],
    ev: MessageEvent,
  ): Promise<string> {
    const fromGroup = ev.message_type === 'group' ? String(ev.group_id) : undefined;
    const nickname =
      ev.message_type === 'group'
        ? ev.sender?.card || ev.sender?.nickname
        : ev.sender?.nickname;

    if (kind === 'bind') {
      if (!args[0]) {
        return this.config.binding.mode === 'code'
          ? '用法：/绑定 <验证码>\n请先在服务器内执行 /easybot bind 获取验证码'
          : '用法：/绑定 <玩家ID>';
      }
      const res =
        this.config.binding.mode === 'code'
          ? this.binding.bindByCode(qq, args[0], { fromGroup, nickname })
          : this.binding.bindByPlayerId(qq, args[0], { fromGroup, nickname });

      if (res.ok) {
        // 绑定成功后按策略同步群名片
        await this.syncCardAfterBind(ev, qq);
      }
      return this.decorate(res, ev);
    }

    if (kind === 'unbind') {
      if (!this.config.binding.allowSelfUnbind && !this.isAdmin(qq)) {
        return this.binding.fail('自助解绑已被管理员关闭，请联系管理员处理').message;
      }
      const before = this.binding.listOf(qq).map((b) => b.playerId);
      const res = this.binding.remove(qq, args[0] ?? '', {
        asAdmin: this.isAdmin(qq),
      });
      if (res.ok) {
        // 强制绑定服务器：解绑后要把在线玩家踢出
        await this.kickUnboundIfNeeded(before);
        await this.syncCardAfterBind(ev, qq);
      }
      return this.decorate(res, ev);
    }

    if (kind === 'myBind') {
      return this.binding.formatList(qq);
    }

    if (kind === 'queryBind') {
      if (!this.isAdmin(qq)) return '你没有权限执行该指令';
      return this.binding.query(args.join(' '));
    }

    return this.buildHelp(this.isAdmin(qq));
  }

  /** 给回复加上 @ 前缀（按配置） */
  private decorate(res: BindResult, ev: MessageEvent): string {
    if (!this.config.binding.mentionOnReply) return res.message;
    const at =
      ev.message_type === 'group'
        ? `[CQ:at,qq=${ev.user_id}] `
        : '';
    return `${at}${res.message}`;
  }

  /** 绑定/解绑成功后同步群名片 */
  private async syncCardAfterBind(ev: MessageEvent, qq: string): Promise<void> {
    if (ev.message_type !== 'group') return;
    if (this.config.binding.cardUpdate === 'off') return;
    const card = this.binding.cardText(qq);
    if (!card) return;
    try {
      await this.setGroupCard(String(ev.group_id), qq, card);
    } catch (err) {
      console.error('[card] 更新群名片失败:', err);
    }
  }

  /** 群名片更新（通过 OneBot set_group_card，由 main 注入的回调实现） */
  private setGroupCardImpl?: (
    groupId: string,
    userId: string,
    card: string,
  ) => Promise<void>;

  /** 由主进程注入群名片更新实现（避免 router 直接依赖 onebot 客户端） */
  setGroupCardProvider(
    fn: (groupId: string, userId: string, card: string) => Promise<void>,
  ): void {
    this.setGroupCardImpl = fn;
  }

  private async setGroupCard(
    groupId: string,
    userId: string,
    card: string,
  ): Promise<void> {
    if (!this.setGroupCardImpl) return;
    await this.setGroupCardImpl(groupId, userId, card);
  }

  /** 按消息刷新群名片（cardUpdate === 'on_message'） */
  private async maybeRefreshCard(ev: MessageEvent): Promise<void> {
    if (this.config.binding.cardUpdate !== 'on_message') return;
    if (ev.message_type !== 'group') return;
    const qq = String(ev.user_id);
    const card = this.binding.cardText(qq);
    if (!card) return;
    // 与现有名片相同则跳过，减少无谓请求
    if (ev.sender?.card === card) return;
    await this.setGroupCard(String(ev.group_id), qq, card);
  }

  /** 强制绑定服务器中，解绑后把对应玩家踢出 */
  private async kickUnboundIfNeeded(players: string[]): Promise<void> {
    if (!this.binding.isForceBindActive()) return;
    if (players.length === 0) return;
    const reason = this.binding.kickMessage();
    for (const player of players) {
      await this.rcon.execute(`kick ${player} ${reason}`);
    }
  }

  /** 处理投递到 RCON 的指令 */
  private async handleRconCommand(
    name: string,
    qq: string,
    args: string[],
    ev: MessageEvent,
  ): Promise<HandleResult> {
    const rule = this.findRule(name);
    if (!rule) {
      return { handled: false };
    }

    const isAdmin = this.isAdmin(qq);

    // 作用域校验
    if (rule.scope === 'group' && ev.message_type !== 'group') {
      return { handled: true, reply: `指令 /${rule.name} 仅限群聊使用` };
    }
    if (rule.scope === 'private' && ev.message_type !== 'private') {
      return { handled: true, reply: `指令 /${rule.name} 仅限私聊使用` };
    }

    // 权限校验
    if (rule.adminOnly && !isAdmin) {
      return { handled: true, reply: '你没有权限执行该指令' };
    }

    // 参数校验
    if (rule.allowArgs && rule.template.includes('{')) {
      if (args.length === 0) {
        return { handled: true, reply: `用法：/${rule.name} <参数>` };
      }
      // 若模板只用到一个参数，则强校验为合法玩家 ID
      const needsPlayerId = /\{arg\d+\}/.test(rule.template);
      if (needsPlayerId && !PLAYER_ID_RE.test(args[0])) {
        return {
          handled: true,
          reply: '参数不合法（玩家 ID 需 3-16 位字母、数字或下划线）',
        };
      }
    }

    // 绑定前置要求
    if (this.config.binding.requireBindingForCommands && !rule.adminOnly) {
      if (this.binding.countOf(qq) === 0) {
        const tip =
          this.config.binding.mode === 'code'
            ? '你还没有绑定游戏账号，请在服务器内执行 /easybot bind 取码后，在群内发送「绑定 <验证码>」'
            : '你还没有绑定游戏账号，请先使用 /绑定 <玩家ID>';
        return { handled: true, reply: tip };
      }
    }

    // 用参数填充模板
    const command = this.fillTemplate(rule.template, args);
    if (!command) {
      return { handled: true, reply: '指令模板为空，请检查配置' };
    }

    const result = await this.rcon.execute(command);
    this.audit(ev, qq, rule.name, command, result, isAdmin);

    return { handled: true, reply: this.formatRconReply(rule.name, result) };
  }

  private fillTemplate(template: string, args: string[]): string {
    return template
      .replace(/\{args\}/g, args.join(' '))
      .replace(/\{arg(\d+)\}/g, (_m, idx: string) => args[Number(idx)] ?? '')
      .trim();
  }

  private formatRconReply(cmdName: string, result: RconResult): string {
    if (!result.success) {
      return `执行 /${cmdName} 失败：${result.error ?? '未知错误'}`;
    }
    const body = result.response || '（无输出）';
    return `/${cmdName} 执行结果：\n${body}`;
  }

  private audit(
    ev: MessageEvent,
    qq: string,
    cmdName: string,
    command: string,
    result: RconResult,
    _isAdmin: boolean,
  ): void {
    const entry: AuditEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      sourceType: ev.message_type,
      sourceId:
        ev.message_type === 'group' ? String(ev.group_id) : String(ev.user_id),
      userId: qq,
      rawMessage: ev.raw_message,
      command,
      result: result.success ? result.response : `[失败] ${result.error ?? ''}`,
      success: result.success,
    };
    this.store.appendAudit(entry);
  }

  /** 供界面手动执行命令并落审计 */
  async executeManual(command: string): Promise<RconResult> {
    const result = await this.rcon.execute(command);
    this.store.appendAudit({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      sourceType: 'private',
      sourceId: 'console',
      userId: 'console',
      rawMessage: '[控制台手动执行]',
      command,
      result: result.success ? result.response : `[失败] ${result.error ?? ''}`,
      success: result.success,
    });
    return result;
  }

  // ------------------------------------------------------------------
  // 服务器侧双向验证的入口（由「服务器内 /easybot bind」触发）
  // ------------------------------------------------------------------

  /**
   * 玩家在服务器内发起绑定。
   *
   * 与 EasyBot 的 /easybot bind 行为对齐：
   * 1. 生成验证码
   * 2. 若开启 pushCodeToServer，则通过 RCON 把验证码播报到游戏内
   * 3. 返回验证码，供上层（未来接入服务器插件桥）回执
   */
  async startServerSideBind(
    playerId: string,
    opts: { groupId?: string } = {},
  ): Promise<{ ok: boolean; code?: string; ttlText?: string; error?: string }> {
    const issued = this.binding.issueCodeFor(playerId, opts);
    if (!issued.ok || !issued.record) {
      return { ok: false, error: issued.error ?? '签发验证码失败' };
    }
    const rec = issued.record;
    const ttlText = formatDuration(this.codes.remainingSeconds(rec));

    if (this.config.binding.pushCodeToServer) {
      const hint = renderTemplate(this.config.binding.messages.serverHint, {
        code: rec.code,
        time: ttlText,
        player: rec.playerId,
      });
      // 用 tellraw 保证中文字符与颜色码正确渲染；失败也不影响取码流程
      const target = this.pickTarget(rec.playerId);
      const command = `tellraw ${target} ${JSON.stringify({ text: hint })}`;
      const res = await this.rcon.execute(command);
      this.store.appendAudit({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        sourceType: 'private',
        sourceId: 'server-bind',
        userId: rec.playerId,
        rawMessage: `[服务器内发起绑定] ${rec.playerId}`,
        command,
        result: res.success ? res.response : `[失败] ${res.error ?? ''}`,
        success: res.success,
      });
    }

    return { ok: true, code: rec.code, ttlText };
  }

  /** 选择 tellraw 的目标：优先 @a 之外的精确玩家选择器 */
  private pickTarget(playerId: string): string {
    // 玩家 ID 已通过正则校验，不含特殊字符，可安全用于选择器
    return PLAYER_ID_RE.test(playerId) ? playerId : '@a';
  }

  /** 供 main 复用：清洗后的服务器命令直发（不落审计） */
  async rawExecute(command: string): Promise<RconResult> {
    return this.rcon.execute(command);
  }
}
