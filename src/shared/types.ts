/**
 * 全局共享类型定义
 * 主进程（main）与渲染进程（renderer）通过 preload 暴露的 IPC 接口共享这些类型。
 */

/** 指令作用域：群聊 / 私聊 / 两者都允许 */
export type ChatScope = 'group' | 'private' | 'both';

/** 一条可执行指令的权限规则 */
export interface CommandRule {
  /** 唯一标识，用于前端编辑 */
  id: string;
  /** 触发命令名，不含斜杠，例如 "list"、"白名单" */
  name: string;
  /** 实际投递给 RCON 的命令模板，支持 {arg0} {arg1} {args} 占位符 */
  template: string;
  /** 允许的聊天场景 */
  scope: ChatScope;
  /** 是否仅限管理员可用 */
  adminOnly: boolean;
  /** 是否允许该指令携带参数 */
  allowArgs: boolean;
  /** 是否启用 */
  enabled: boolean;
  /** 指令说明，展示在帮助里 */
  description: string;
}

/** 聊天源白名单配置 */
export interface ChatWhitelist {
  /** 是否只接受白名单内的群 */
  groupEnabled: boolean;
  /** 允许的群号列表 */
  groups: string[];
  /** 是否只接受白名单内的私聊 */
  privateEnabled: boolean;
  /** 允许私聊的 QQ 号列表 */
  privates: string[];
  /** 全局管理员 QQ 号列表（不受白名单限制，可执行管理指令） */
  admins: string[];
}

/** RCON 连接配置 */
export interface RconConfig {
  host: string;
  port: number;
  password: string;
  /** 命令执行超时（毫秒） */
  timeoutMs: number;
  /** 断线自动重连间隔（毫秒），0 表示不自动重连 */
  reconnectIntervalMs: number;
}

/**
 * 验证服配置（双服务器模式）。
 *
 * 流程：玩家先登录验证服 → 在 QQ 发「绑定 <玩家ID>」→ 本程序把验证码经
 * **验证服** RCON 投递到该玩家的游戏内对话框 → 玩家在 QQ 回填验证码 →
 * 验证通过后经 **主服** RCON 执行 whitelist add，把玩家放进真正的服务器。
 *
 * 两个 RCON 完全独立：主服 RCON 负责日常指令与加白，验证服 RCON 只负责发码。
 * 验证服与主服可以在同一台机器上（不同端口），也可以是两台机器。
 */
export interface VerifyServerConfig {
  /** 是否启用双服验证流程（关闭后 /绑定 <玩家ID> 不会触发发码） */
  enabled: boolean;
  /** 验证服 RCON：仅用于向玩家对话框投递验证码 */
  rcon: RconConfig;
  /** 验证通过后自动把玩家加入主服白名单 */
  autoWhitelist: boolean;
  /** 加白命令模板，{player} 会被替换为已通过验证的玩家 ID */
  whitelistAddCommand: string;
}

/**
 * 在线展示（/在线 指令的图片卡片）配置。
 *
 * 数据来自主服 RCON 的 `list`；渲染成本机进程内的隐藏窗口截图，
 * 不依赖任何第三方渲染库，也不依赖服务端插件。
 */
export interface PresenceConfig {
  /** 总开关：关闭后 /在线 保持原样（文字转发 RCON 输出） */
  enabled: boolean;
  /** 卡片上展示的服务器名，例如「生存服」 */
  serverName: string;
  /** 卡片里显示玩家头像（取绑定 QQ 的头像，未绑定则用首字母色块） */
  showAvatars: boolean;
  /** /在线 发送图片卡片；关闭则只发文字模板 */
  sendImage: boolean;
  /**
   * 文字模板，出现在两种场合：
   *  1) sendImage 关闭时，作为 /在线 的回复
   *  2) 图片渲染失败时的降级回复
   * 变量：{server} {online} {max} {players}
   */
  textTemplate: string;
}

/** OneBot (SnowLuma) 连接配置 */
export interface OneBotConfig {
  /** WebSocket 地址，例如 ws://127.0.0.1:3001 */
  wsUrl: string;
  /** 访问令牌，可留空 */
  accessToken: string;
  /** 是否自动重连 */
  autoReconnect: boolean;
  /** 重连间隔（毫秒） */
  reconnectIntervalMs: number;
}

/**
 * 绑定模式（对齐 EasyBot 的两种模式）
 * - code：双向验证模式。玩家在服务器内获取验证码，再在群里输入「绑定 + 验证码」完成绑定
 * - trust：社交平台信任模式。玩家直接在群里输入「绑定 + 玩家ID」即可绑定
 */
export type BindMode = 'code' | 'trust';

/** 验证码字符集 */
export type CodeFormat = 'number' | 'letter' | 'mixed';

/** 群名片改名策略 */
export type CardUpdatePolicy = 'on_bind' | 'on_message' | 'off';

/** QQ 与 MC 玩家 ID 的绑定关系 */
export interface Binding {
  /** QQ 号 */
  qq: string;
  /** Minecraft 玩家 ID */
  playerId: string;
  /** 绑定的群号（记录来源，可空表示私聊绑定） */
  fromGroup?: string;
  /** 所属服务器标识（未启用多服务器时为空） */
  serverId?: string;
  /** 社交平台昵称（用于展示） */
  nickname?: string;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
}

/** 一次性验证码（双向验证模式使用） */
export interface BindCodeRecord {
  /** 验证码本身，例如 482913 */
  code: string;
  /** 发起绑定的玩家 ID */
  playerId: string;
  /** 发起来源群（用于校验在正确群里完成绑定），可空 */
  groupId?: string;
  /** 发起绑定的 QQ 号：有此值时只有该 QQ 能使用这个验证码，防止被他人截走 */
  qq?: string;
  /** 所属服务器标识 */
  serverId?: string;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 过期时间（ISO 字符串） */
  expiresAt: string;
}

/** 绑定消息模板：均为可自定义文案，支持占位符 */
export interface BindMessages {
  /** 绑定成功。占位符：#player #qq #nickname #current #max */
  bindSuccess: string;
  /** 绑定失败。占位符：#why */
  bindFail: string;
  /** 已在服务器内发起绑定，提示到群里输入验证码。占位符：#code #time */
  bindStart: string;
  /** QQ 侧发起绑定、验证码已投递到游戏内时的提示。占位符：#player #time */
  codeIssued: string;
  /** 服务器内提示语（用于在游戏内展示验证码）。占位符：#code #time */
  serverHint: string;
  /** 解绑成功。占位符：#player */
  unbindSuccess: string;
  /** 强制绑定服务器中，未绑定玩家被踢出的提示。占位符：#prefix */
  kickMessage: string;
}

/** 强制绑定配置（对齐 EasyBot：列表中的服务器必须绑定才能进服） */
export interface ForceBindConfig {
  /** 是否启用强制绑定 */
  enabled: boolean;
  /** 生效的服务器标识列表，空表示所有服务器 */
  servers: string[];
}

/** 绑定策略配置 */
export interface BindingConfig {
  /** 绑定模式：双向验证 / 社交平台信任 */
  mode: BindMode;

  /** 验证码位数（双向验证模式） */
  codeLength: number;
  /** 验证码字符集（双向验证模式） */
  codeFormat: CodeFormat;
  /** 验证码有效期（秒，双向验证模式） */
  codeTtlSeconds: number;
  /** 玩家在服务器内发起绑定的指令（双向验证模式） */
  serverBindCommand: string;
  /** 是否通过 RCON 把验证码播报到游戏内（双向验证模式） */
  pushCodeToServer: boolean;

  /** 单个 QQ 号最多可绑定的玩家 ID 数量 */
  maxBindingsPerQQ: number;
  /** 是否要求绑定后才能执行指令 */
  requireBindingForCommands: boolean;
  /** 是否允许玩家自助绑定（false 则仅管理员可绑定） */
  allowSelfBind: boolean;
  /** 是否允许玩家自助解绑 */
  allowSelfUnbind: boolean;

  /** 强制绑定 */
  forceBind: ForceBindConfig;

  /** 成员退群时自动解绑其所有账号 */
  unbindOnGroupLeave: boolean;

  /** 群名片改名策略 */
  cardUpdate: CardUpdatePolicy;
  /** 群名片前缀（可空） */
  cardPrefix: string;

  /** 绑定提示是否 @ 触发者 */
  mentionOnReply: boolean;

  /** 自定义消息模板 */
  messages: BindMessages;
}

/**
 * SnowLuma 启动器配置。
 *
 * 程序文件（node.exe + index.mjs）可以来自两个地方：
 * - 内置版：随程序一起打包在 resources/snowluma/
 * - 自定义：用户自己指定一个 SnowLuma 目录
 *
 * 无论哪种，SnowLuma 的 config/ 与 logs/ 都写到 cwd，
 * 因此我们固定把 cwd 设为用户数据目录下的 snowluma/，保证重启后配置不丢。
 */
export interface SnowLumaConfig {
  /** 自定义 SnowLuma 程序目录；留空表示使用内置版本 */
  dir: string;
  /** WebUI 地址（用于「打开后台」） */
  webUrl: string;
  /** 启动成功后自动打开浏览器后台 */
  autoOpen: boolean;
  /** 关闭本程序时一并停止 SnowLuma */
  stopWithApp: boolean;
}

/** SnowLuma 进程状态 */
export type SnowLumaState = 'stopped' | 'starting' | 'running' | 'exited' | 'error';

/** SnowLuma 运行时状态（推送给渲染进程） */
export interface SnowLumaStatus {
  state: SnowLumaState;
  /** 子进程 PID */
  pid?: number;
  /** WebUI 地址 */
  webUrl: string;
  /** SnowLuma 的数据目录（cwd），config/ 与 logs/ 都在这里 */
  dataDir: string;
  /** 程序目录来源 */
  dirSource: 'bundled' | 'custom' | 'missing';
  /** 实际使用的程序目录 */
  resolvedDir?: string;
  /** 首次启动时日志里输出的管理员账号 */
  adminUser?: string;
  /** 首次启动时日志里输出的临时密码（改密后失效） */
  password?: string;
  /** 是否已监听到 WebUI 端口 */
  listening: boolean;
  /** 退出码（进程结束后） */
  exitCode?: number | null;
  lastError?: string;
  /** 启动时间（ISO 字符串） */
  startedAt?: string;
}

/** 指令执行审计记录 */
export interface AuditEntry {
  id: string;
  /** 触发时间 ISO 字符串 */
  timestamp: string;
  /** 触发来源：群号或 QQ 号 */
  sourceType: 'group' | 'private';
  sourceId: string;
  /** 触发者 QQ 号 */
  userId: string;
  /** 原始消息内容 */
  rawMessage: string;
  /** 实际执行的 RCON 命令 */
  command: string;
  /** RCON 返回结果 */
  result: string;
  /** 是否成功 */
  success: boolean;
}

// ---------------------------------------------------------------------------
// 日志监听（游戏内事件源）
// ---------------------------------------------------------------------------

/** 一条从服务端日志解析出来的事件 */
export interface GameEvent {
  /** 事件类型 */
  kind: 'chat' | 'join' | 'leave' | 'death' | 'advancement' | 'server-start';
  /** 玩家名（server-start 时为空） */
  player: string;
  /** 事件负载：chat 为消息内容，death 为死因描述，advancement 为成就名 */
  detail: string;
  /** 原始日志行 */
  raw: string;
  /** 解析时间（ISO） */
  at: string;
}

/** 日志监听配置 */
export interface LogWatcherConfig {
  /** 是否启用（关闭后所有游戏内事件功能失效，其它行为不变） */
  enabled: boolean;
  /** 日志文件路径；留空则自动探测 server.properties 所在目录的 logs/latest.log */
  logPath: string;
  /** 服务端根目录（用于自动探测 logs/latest.log 与 server.properties） */
  serverDir: string;
  /** 启动时是否重放已有历史行（false 则只处理新增行） */
  replayHistory: boolean;
  /** 假人（机器人）名称前缀，命中则过滤掉其事件 */
  botPrefixes: string[];
  /** 是否过滤假人事件 */
  filterBots: boolean;
}

// ---------------------------------------------------------------------------
// 群服消息互通
// ---------------------------------------------------------------------------

/** 消息方向 */
export type MessageDirection = 'game-to-chat' | 'chat-to-game';

/** 群服消息同步配置 */
export interface ChatBridgeConfig {
  /** 总开关 */
  enabled: boolean;
  /** 游戏内聊天 → QQ 群 */
  gameToChat: {
    enabled: boolean;
    /** 目标群号列表（空表示不发） */
    groups: string[];
    /** 模板，变量：{player} {message} {server} */
    template: string;
  };
  /** QQ 群消息 → 游戏内 */
  chatToGame: {
    enabled: boolean;
    /** 来源群号列表（空表示不接收） */
    groups: string[];
    /** 模板，变量：{nickname} {message} */
    template: string;
    /** 是否跳过以 / 或 !! 开头的消息 */
    skipCommands: boolean;
    /** 合并窗口毫秒数（0 表示不合并）：窗口内多条合并成一条发出 */
    mergeWindowMs: number;
  };
  /** 消息过滤：命中的内容不转发（正则，逐条匹配） */
  blockPatterns: string[];
  /** 敏感词替换表：from → to */
  replacements: Array<{ from: string; to: string }>;
  /** 静音时段（24 小时制），在时段内不转发；start === end 表示不启用 */
  quietHours: { start: number; end: number };
  /** 单条消息最大长度，超出截断 */
  maxLength: number;
}

// ---------------------------------------------------------------------------
// 自动回复（关键词 / 正则）
// ---------------------------------------------------------------------------

/** 一条自动回复规则 */
export interface ResponderRule {
  id: string;
  /** 规则名（仅用于界面展示） */
  name: string;
  enabled: boolean;
  /** 匹配类型：keyword = 包含即命中；regex = 正则；exact = 完全相等 */
  matchType: 'keyword' | 'regex' | 'exact';
  /** 触发词/正则 */
  pattern: string;
  /** 回复内容，支持 {user} {nickname} {group} 变量 */
  reply: string;
  /** 是否同时投递到游戏内 */
  toGame: boolean;
  /** 是否仅管理员生效 */
  adminOnly: boolean;
  /** 冷却秒数（同群同规则） */
  cooldownSeconds: number;
}

/** 自动回复配置 */
export interface ResponderConfig {
  enabled: boolean;
  rules: ResponderRule[];
}

// ---------------------------------------------------------------------------
// 权限组
// ---------------------------------------------------------------------------

/** 权限主体：账号 / 群 / 群内身份 / 嵌套引用其它组 */
export type PermissionSubjectType = 'account' | 'group' | 'role' | 'nested';

export interface PermissionSubject {
  type: PermissionSubjectType;
  /** account/group 为 ID；role 为 owner/admin/member；nested 为组 ID */
  value: string;
}

/** 一个权限组 */
export interface PermissionGroup {
  id: string;
  name: string;
  /** 成员主体列表 */
  subjects: PermissionSubject[];
  /** 允许的指令名（支持 * 通配） */
  allowCommands: string[];
  /** 拒绝的指令名（优先级高于 allow） */
  denyCommands: string[];
  /** 优先级，数字大者优先 */
  priority: number;
}

/** 权限配置 */
export interface PermissionConfig {
  enabled: boolean;
  groups: PermissionGroup[];
}

// ---------------------------------------------------------------------------
// 定时任务
// ---------------------------------------------------------------------------

/** 定时任务的动作 */
export type TaskAction =
  | { type: 'rcon'; command: string }
  | { type: 'chat'; targetType: 'group' | 'private'; targetId: string; text: string };

/** 一条定时任务 */
export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  /** 触发间隔（分钟）。0 表示不使用间隔，仅用 dailyAt */
  intervalMinutes: number;
  /** 每日定点触发，格式 HH:mm，例如 "04:00"；空表示不用 */
  dailyAt: string;
  /** 动作 */
  action: TaskAction;
  /** 上次执行时间（ISO），运行时维护 */
  lastRunAt?: string;
}

/** 定时任务配置 */
export interface TaskConfig {
  enabled: boolean;
  tasks: ScheduledTask[];
}

// ---------------------------------------------------------------------------
// 玩家统计
// ---------------------------------------------------------------------------

/** 单个玩家的累计统计 */
export interface PlayerStats {
  playerId: string;
  /** 首次出现时间 ISO */
  firstSeen: string;
  /** 最后出现时间 ISO */
  lastSeen: string;
  /** 累计在线秒数 */
  onlineSeconds: number;
  /** 发言条数 */
  chatCount: number;
  /** 指令使用次数 */
  commandCount: number;
  /** 进服次数 */
  joinCount: number;
}

/** 统计配置 */
export interface StatsConfig {
  enabled: boolean;
  /** 保留条数上限，超出按最后出现时间淘汰 */
  maxPlayers: number;
}

// ---------------------------------------------------------------------------
// 事件通知
// ---------------------------------------------------------------------------

/** 事件通知配置：把游戏内事件推送到群 */
export interface NotifyConfig {
  enabled: boolean;
  /** 目标群号 */
  groups: string[];
  /** 进服通知 */
  join: { enabled: boolean; template: string };
  /** 退服通知 */
  leave: { enabled: boolean; template: string };
  /** 死亡通知 */
  death: { enabled: boolean; template: string };
  /** 成就通知 */
  advancement: { enabled: boolean; template: string };
  /** 服务器启动通知 */
  serverStart: { enabled: boolean; template: string };
}

// ---------------------------------------------------------------------------
// AI（OpenAI 兼容协议）
// ---------------------------------------------------------------------------

/**
 * AI 触发方式。
 * - command：只响应 `/问`（或 `/ai`）指令，最保守
 * - mention：只响应 @机器人
 * - both：两者都响应
 */
export type AITriggerMode = 'command' | 'mention' | 'both';

/** AI 配置。全部走 OpenAI 兼容的 /chat/completions 协议 */
export interface AIConfig {
  /** 总开关 */
  enabled: boolean;
  /** 接口根地址，例如 https://api.deepseek.com/v1（不要带 /chat/completions） */
  baseUrl: string;
  /** API Key（明文存储，与 RCON 密码同等对待） */
  apiKey: string;
  /** 模型名，例如 deepseek-chat */
  model: string;
  /** 触发方式 */
  trigger: AITriggerMode;
  /** 人设 / 系统提示词 */
  systemPrompt: string;
  /** 采样温度（0-2） */
  temperature: number;
  /** 单次回复最大 token */
  maxTokens: number;
  /** 请求超时（毫秒） */
  timeoutMs: number;
  /** 上下文保留轮数（一问一答算一轮） */
  contextTurns: number;
  /** 每个 QQ 每天最多问几次，0 表示不限制 */
  dailyQuotaPerUser: number;
  /** 自动回复没命中时，是否让 AI 兜底作答 */
  fallbackToAI: boolean;
  /** 回复是否 @ 提问者 */
  mentionOnReply: boolean;
  /** 是否允许 AI 分析玩家数据（/ai 玩家 xxx） */
  allowPlayerProfile: boolean;
}

/** AI 运行状态（推送给界面） */
export interface AIStatus {
  enabled: boolean;
  /** 是否配置齐全（baseUrl + apiKey + model） */
  ready: boolean;
  /** 最近一次调用是否成功 */
  lastOk?: boolean;
  /** 最近一次错误 */
  lastError?: string;
  /** 今日已调用次数 */
  todayCalls: number;
}

// ---------------------------------------------------------------------------
// 图片回复（把任意功能回复渲染成卡片图）
// ---------------------------------------------------------------------------

/** 卡片主题 */
export type CardTheme = 'dark' | 'light';

/** 图片回复配置 */
export interface ImageReplyConfig {
  /** 总开关 */
  enabled: boolean;
  /**
   * 作用范围：
   * - command：只把「指令/查询的回复」转图
   * - all：所有功能回复都转图（群聊同步仍保持文字）
   */
  scope: 'command' | 'all';
  /** 至少多少行才转图 */
  minLines: number;
  /** 或至少多少字符才转图 */
  minChars: number;
  /** 卡片文件保留数量上限 */
  keepFiles: number;
  /** 卡片底部是否显示生成时间 */
  showTime: boolean;

  // ---------- 视觉（图片域专属） ----------

  /** 卡片主题 */
  theme: CardTheme;
  /** 卡片宽度（CSS px），建议 480 / 600 / 720 */
  width: number;
  /** 字号缩放，0.9 = 紧凑，1.1 = 宽松 */
  scale: number;
  /** 水印文字（显示在卡片底部右侧，留空则不显示） */
  watermark: string;
}

// ---------------------------------------------------------------------------
// 慰问服主（每日播报「服主离开第 N 天」）
// ---------------------------------------------------------------------------

/**
 * 慰问服主配置。
 *
 * 缘起：很多服的服主建完服就消失了，玩家之间常用「服主失踪 N 天」当梗。
 * 这个功能每天定点在群里播报一次，起始日当天算第 1 天。
 */
export interface OwnerCareConfig {
  /** 总开关 */
  enabled: boolean;
  /** 起始日期 YYYY-MM-DD；起始日当天算第 1 天 */
  startDate: string;
  /** 播报目标群（空则不播） */
  groups: string[];
  /** 每天播报时刻 HH:mm；留空表示不自动播报（只保留手动 /慰问） */
  dailyAt: string;
  /** 播报文案，变量：{days} {owner} {startDate} */
  template: string;
  /** 服主称呼（用于 {owner}），留空则用「服主」 */
  ownerName: string;
  /** 服主的 QQ（用于 @），留空则不 @ */
  ownerQQ: string;
  /** 播报时是否 @ 服主 */
  mentionOwner: boolean;
}

/** 慰问服主的运行状态 */
export interface OwnerCareStatus {
  enabled: boolean;
  /** 起始日期 */
  startDate: string;
  /** 今天是第几天（起始日为 1；起始日在未来时为 0） */
  days: number;
  /** 今天是否已经播报过 */
  sentToday: boolean;
  /** 下一次播报时刻（HH:mm），未启用自动播报时为空 */
  nextAt?: string;
  /** 下一条播报的完整文案（便于界面预览） */
  previewMessage: string;
}

/** 应用完整配置 */
export interface AppConfig {
  /** 主服 RCON：日常指令、白名单管理都走这里 */
  rcon: RconConfig;
  /** 验证服：双服绑定流程 */
  verifyServer: VerifyServerConfig;
  onebot: OneBotConfig;
  whitelist: ChatWhitelist;
  binding: BindingConfig;
  /** 在线展示（/在线 图片卡片） */
  presence: PresenceConfig;
  /** SnowLuma 启动器 */
  snowluma: SnowLumaConfig;
  commands: CommandRule[];
  /** 服务器标识，多服场景用于区分（可空） */
  serverId: string;
  /** 同一用户触发指令的最小间隔（毫秒） */
  rateLimitMs: number;
  /** 自动更新源配置 */
  update: UpdateChannel;

  // ---------- 新增功能域（全部默认关闭，老配置升级后行为不变） ----------

  /** 服务端日志监听（游戏内事件源） */
  logWatcher: LogWatcherConfig;
  /** 群服消息双向同步 */
  chatBridge: ChatBridgeConfig;
  /** 关键词/正则自动回复 */
  responder: ResponderConfig;
  /** 权限组 */
  permissions: PermissionConfig;
  /** 定时任务 */
  tasks: TaskConfig;
  /** 玩家统计 */
  stats: StatsConfig;
  /** 事件通知 */
  notify: NotifyConfig;
  /** AI（OpenAI 兼容协议） */
  ai: AIConfig;
  /** 图片回复（任意功能回复渲染成卡片） */
  imageReply: ImageReplyConfig;
  /** 慰问服主（每日播报「离开 N 天」） */
  ownerCare: OwnerCareConfig;
}

/** 连接状态片段 */
export interface ConnectionState {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  message: string;
  lastError?: string;
}

/** 运行时连接状态 */
export interface RuntimeStatus {
  rcon: ConnectionState;
  /** 验证服 RCON 状态（未启用双服模式时不下发） */
  rconVerify?: ConnectionState;
  onebot: ConnectionState & {
    /** 机器人自身 QQ 号 */
    selfId?: string;
    selfName?: string;
  };
}

/** RCON 执行结果 */
export interface RconResult {
  success: boolean;
  /** 服务器返回的响应文本 */
  response: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// 数据目录 / 备份
// ---------------------------------------------------------------------------

/** 数据目录的归属：portable = 跟随程序，user = 系统用户目录 */
export type DataDirSource = 'portable' | 'user';

export interface DataFileInfo {
  name: string;
  /** 字节数 */
  size: number;
  /** 最后修改时间（ISO）*/
  mtime: string;
}

/** 当前数据目录的完整情况，用于连接设置页的「数据与备份」卡片 */
export interface DataDirInfo {
  /** 当前实际使用的 data 目录（绝对路径）*/
  dir: string;
  source: DataDirSource;
  /** 决策原因，直接展示给用户 */
  reason: string;
  /** 需要提醒的异常，例如程序目录不可写 */
  warning?: string;
  /** 程序目录（便携版 = 放 exe 的文件夹）；开发模式下为 null */
  portableDir: string | null;
  /** 是否支持「把配置存到程序目录」*/
  canMoveToPortable: boolean;
  /** 程序目录下已存在的 data 目录（已存在时给出路径，用于提示冲突）*/
  existingPortableDataDir: string | null;
  /** data 目录内的文件清单 */
  files: DataFileInfo[];
}

/** 导出 / 导入 / 迁移的统一返回 */
export interface DataTransferResult {
  ok: boolean;
  error?: string;
  /** 涉及的文件路径 */
  path?: string;
  /** 写入的字节数（导出时）*/
  bytes?: number;
  /** 面向用户的结果要点，逐条展示 */
  lines?: string[];
  /** 导入后配置是否已变化（渲染层据此重新拉取）*/
  configChanged?: boolean;
}

/** preload 暴露给渲染进程的 API */
export interface BridgeApi {
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<{ ok: boolean; error?: string }>;
  resetConfig(): Promise<AppConfig>;

  getStatus(): Promise<RuntimeStatus>;
  onStatusChange(cb: (status: RuntimeStatus) => void): () => void;

  reconnectRcon(): Promise<{ ok: boolean; error?: string }>;
  reconnectOneBot(): Promise<{ ok: boolean; error?: string }>;
  testRcon(): Promise<RconResult>;

  /** 重连验证服 RCON（双服模式） */
  reconnectRconVerify(): Promise<{ ok: boolean; error?: string }>;
  /** 测试验证服 RCON 连通性（执行 list） */
  testRconVerify(): Promise<RconResult>;

  /** 手动执行一条 RCON 命令（仅测试/管理用途） */
  executeRcon(command: string): Promise<RconResult>;

  listBindings(): Promise<Binding[]>;
  addBinding(qq: string, playerId: string): Promise<{ ok: boolean; error?: string }>;
  removeBinding(qq: string, playerId: string): Promise<{ ok: boolean; error?: string }>;
  /** 查询某个 QQ 的绑定列表 */
  listBindingsOf(qq: string): Promise<Binding[]>;
  /** 按玩家 ID 反查绑定归属 */
  findBindingByPlayer(playerId: string): Promise<Binding | null>;

  /** 当前所有待验证的验证码（双向验证模式） */
  listPendingCodes(): Promise<BindCodeRecord[]>;
  /** 手动取消一个待验证码 */
  cancelPendingCode(code: string): Promise<{ ok: boolean; error?: string }>;
  /** 手动签发一个验证码（管理员在群外发放用） */
  issueCode(playerId: string): Promise<{ ok: boolean; code?: string; error?: string }>;

  listAudit(limit?: number): Promise<AuditEntry[]>;
  clearAudit(): Promise<void>;

  /** 向指定群/私聊发送测试消息 */
  sendTestMessage(targetType: 'group' | 'private', targetId: string, text: string): Promise<{ ok: boolean; error?: string }>;

  // ---------- SnowLuma 启动器 ----------

  /** 当前 SnowLuma 进程状态 */
  getSnowLumaStatus(): Promise<SnowLumaStatus>;
  /** 订阅 SnowLuma 状态变化 */
  onSnowLumaStatus(cb: (status: SnowLumaStatus) => void): () => void;
  /** 启动 SnowLuma */
  startSnowLuma(): Promise<{ ok: boolean; error?: string }>;
  /** 停止 SnowLuma */
  stopSnowLuma(): Promise<{ ok: boolean; error?: string }>;
  /** 在系统浏览器里打开 SnowLuma 后台 */
  openSnowLumaWeb(): Promise<{ ok: boolean; error?: string }>;
  /** 读取最近的启动日志 */
  getSnowLumaLog(): Promise<string[]>;
  /** 弹目录选择框，返回选中的 SnowLuma 目录 */
  pickSnowLumaDir(): Promise<string | null>;
  /** 内置 SnowLuma 程序目录（不存在时为 null） */
  getBundledSnowLumaDir(): Promise<string | null>;

  // ---------- 数据目录与备份 ----------

  /** 当前数据目录的位置、来源与文件清单 */
  getDataDirInfo(): Promise<DataDirInfo>;
  /** 导出配置到文件（弹出保存对话框）*/
  exportData(includeSecrets: boolean): Promise<DataTransferResult>;
  /** 从文件导入配置（弹出打开对话框）*/
  importData(): Promise<DataTransferResult>;
  /** 把当前配置整体复制到程序目录（绿色版模式，重启后生效）*/
  moveDataToPortable(): Promise<DataTransferResult>;
  /** 在系统文件管理器里打开数据目录 */
  openDataDir(): Promise<{ ok: boolean; error?: string }>;

  // ---------- 在线展示（图片卡片） ----------

  /**
   * 渲染一张在线人数卡片预览。
   * 传入界面上的草稿配置（未保存也能预览，所见即所得）；
   * 省略时用当前已保存的配置。真实查询失败时回退演示数据。
   */
  previewPresence(presence?: PresenceConfig): Promise<PresencePreview>;

  // ---------- 自动更新 ----------

  /** 当前更新器状态 */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** 订阅更新状态变化 */
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
  /** 检查更新 */
  checkUpdate(): Promise<{ hasUpdate: boolean; info: UpdateInfo | undefined; error?: string }>;
  /** 下载更新（差量优先，失败回退全量） */
  downloadUpdate(): Promise<{ ok: boolean; error?: string; fullDownload?: boolean }>;
  /** 应用已就绪的更新并重启 */
  applyUpdate(): Promise<{ ok: boolean; error?: string }>;

  // ---------- 日志监听 / 统计 / 定时任务 ----------

  /** 日志监听器运行状态 */
  getLogWatcherStatus(): Promise<{
    running: boolean;
    path: string | null;
    offset: number;
    lastError: string | null;
  }>;
  /** 探测服务端目录下的日志文件是否存在 */
  probeLogPath(serverDir: string): Promise<{ path: string; exists: boolean }>;

  /** 玩家统计（按在线时长降序） */
  getStats(): Promise<PlayerStats[]>;
  /** 排行榜 */
  getStatsTop(by: 'onlineSeconds' | 'chatCount' | 'commandCount' | 'joinCount', limit?: number): Promise<PlayerStats[]>;
  /** 清空统计 */
  clearStats(): Promise<void>;

  /** 定时任务执行历史 */
  getTaskHistory(): Promise<Array<{ at: string; taskId: string; name: string; ok: boolean; error?: string }>>;
  /** 立即运行一条定时任务 */
  runTaskNow(taskId: string): Promise<{ ok: boolean; error?: string }>;

  /** 测试一条自动回复规则会怎么命中（不真的发送） */
  testResponder(text: string): Promise<{ hit: boolean; ruleName?: string; reply?: string }>;

  // ---------- AI ----------

  /** AI 运行状态 */
  getAIStatus(): Promise<AIStatus>;
  /** 测试 AI 连通性（发一条最小请求） */
  testAI(): Promise<{ ok: boolean; reply?: string; error?: string }>;
  /** 在界面里直接问一句（不经过 QQ，用于调人设） */
  askAI(question: string): Promise<{ ok: boolean; reply?: string; error?: string }>;
  /** 清空 AI 会话上下文 */
  clearAIContext(): Promise<void>;

  // ---------- 图片回复 ----------

  /**
   * 预览：把一段文本按当前图片回复配置渲染成卡片（不发送）。
   * 用于界面调阈值，所见即所得。
   */
  previewImageReply(text: string): Promise<{ ok: boolean; dataUrl?: string; wouldRender?: boolean; error?: string }>;

  // ---------- 慰问服主 ----------

  /** 当前天数与播报状态 */
  getOwnerCareStatus(): Promise<OwnerCareStatus>;
  /** 立即发一次播报（不等到定点） */
  sendOwnerCareNow(): Promise<{ ok: boolean; error?: string }>;
  /** 把起始日重置为今天（相当于宣布「服主今天又回来了」） */
  resetOwnerCareStart(): Promise<OwnerCareStatus>;
}

// ---------------------------------------------------------------------------
// 自动更新（差量）
// ---------------------------------------------------------------------------

/** 更新源配置：默认 GitHub Releases，可切换自定义静态源 */
export interface UpdateChannel {
  /** 自定义更新源基础 URL（留空则用 repoUrl / 默认 GitHub） */
  customUrl: string;
  /** GitHub 仓库（owner/name），默认 lumicyan/gelibot */
  repoUrl: string;
}

/** 清单里的一条差量包（从某旧版本升级到最新版本） */
export interface UpdatePatchEntry {
  /** 起始版本，例如 "1.17.0" */
  from: string;
  /** 目标版本，例如 "1.18.0" */
  to: string;
  /** 差量包下载地址（相对或绝对 URL） */
  url: string;
  /** 差量包 sha256 */
  sha256: string;
  /** 差量包字节数 */
  size: number;
}

/** 发布清单：每个发布版本附带一份，供客户端决定升级路径 */
export interface UpdateManifest {
  /** 本次发布版本号 */
  version: string;
  /** 更新说明 */
  notes?: string;
  /** 发布时间（ISO） */
  publishedAt?: string;
  /** 完整 app.asar 的下载地址 */
  asarUrl: string;
  /** 完整 app.asar 的 sha256 */
  asarSha256: string;
  /** 完整 app.asar 字节数 */
  fullSize: number;
  /** 完整 portable exe 的下载地址（绿色版整包覆盖用） */
  exeUrl?: string;
  /** 完整 portable exe 的 sha256 */
  exeSha256?: string;
  /** 完整 portable exe 字节数 */
  exeSize?: number;
  /** 可用的差量包列表（相对当前版本挑选） */
  patches: UpdatePatchEntry[];
}

/** 一次检查更新的结果（面向 UI） */
export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  notes?: string;
  publishedAt?: string;
  /** 是否存在当前版本 → 最新版本的差量包 */
  patchAvailable: boolean;
  /** 差量包大小（字节） */
  patchSize?: number;
  /** 完整包大小（字节） */
  fullSize?: number;
}

/** 更新器运行时状态（推送给渲染进程） */
export interface UpdateStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'applying'
    | 'done'
    | 'error';
  /** 人类可读的状态描述 */
  message: string;
  /** 当前阶段 */
  phase?: 'check' | 'download' | 'patch' | 'verify' | 'apply';
  /** 下载进度（0-100） */
  progress?: number;
  /** 是否走全量下载（而非差量） */
  fullDownload?: boolean;
  /** 本次检查结果 */
  info?: UpdateInfo;
  /** 错误详情 */
  error?: string;
}

/** 在线卡片预览结果 */
export interface PresencePreview {
  ok: boolean;
  /** PNG 的 data URL（可直接塞进 <img src>） */
  dataUrl?: string;
  /** 是否使用了演示数据（真实查询失败时） */
  demo: boolean;
  /** 输出尺寸（物理像素） */
  width?: number;
  height?: number;
  /** 真实数据下的摘要文本，例如「在线 3/20，共 3 人」 */
  summary?: string;
  error?: string;
}
