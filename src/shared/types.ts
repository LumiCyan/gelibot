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

/** 应用完整配置 */
export interface AppConfig {
  /** 主服 RCON：日常指令、白名单管理都走这里 */
  rcon: RconConfig;
  /** 验证服：双服绑定流程 */
  verifyServer: VerifyServerConfig;
  onebot: OneBotConfig;
  whitelist: ChatWhitelist;
  binding: BindingConfig;
  /** SnowLuma 启动器 */
  snowluma: SnowLumaConfig;
  commands: CommandRule[];
  /** 服务器标识，多服场景用于区分（可空） */
  serverId: string;
  /** 同一用户触发指令的最小间隔（毫秒） */
  rateLimitMs: number;
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
}
