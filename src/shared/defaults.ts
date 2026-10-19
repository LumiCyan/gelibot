import type {
  AIConfig,
  AppConfig,
  BindingConfig,
  ChatBridgeConfig,
  CommandRule,
  ImageReplyConfig,
  LogWatcherConfig,
  NotifyConfig,
  OwnerCareConfig,
  PermissionConfig,
  PresenceConfig,
  ResponderConfig,
  SnowLumaConfig,
  StatsConfig,
  TaskConfig,
  UpdateChannel,
  VerifyServerConfig,
} from './types';

/**
 * 默认 SnowLuma 启动器配置。
 *
 * `dir` 留空表示「用内置版本」——程序里已随包附了一份完整的 SnowLuma
 * （含自带 node.exe），用户不需要自己准备。只有想换版本或改用外部目录时才填。
 */
export function createDefaultSnowLumaConfig(): SnowLumaConfig {
  return {
    dir: '',
    webUrl: 'http://127.0.0.1:5099',
    autoOpen: true,
    stopWithApp: true,
  };
}

/**
 * 默认绑定策略。
 *
 * 采用 EasyBot 的「双向验证模式」作为开箱默认值：
 * 玩家在服务器内执行 /easybot bind 拿到验证码，再到群里发「绑定 <验证码>」。
 * 这样默认状态下不会出现「随便报个 ID 就绑上」的冒用问题。
 */
export function createDefaultBindingConfig(): BindingConfig {
  return {
    mode: 'code',

    codeLength: 6,
    codeFormat: 'number',
    codeTtlSeconds: 300,
    serverBindCommand: 'easybot bind',
    pushCodeToServer: true,

    maxBindingsPerQQ: 1,
    requireBindingForCommands: false,
    allowSelfBind: true,
    allowSelfUnbind: true,

    forceBind: {
      enabled: false,
      servers: [],
    },

    unbindOnGroupLeave: false,

    cardUpdate: 'off',
    cardPrefix: '',

    mentionOnReply: false,

    messages: {
      bindSuccess:
        '[绑定成功] 玩家 #player 已与 QQ #qq 完成绑定（#current/#max）',
      bindFail: '[绑定失败] #why',
      bindStart:
        '[发起绑定] 请在群内发送「绑定 #code」完成绑定，有效期 #time',
      codeIssued:
        '[绑定中] 请查看验证码：已发送到你的游戏内对话框，收到后回到这里发送验证码即可完成绑定（有效期 #time）',
      serverHint:
        '[绑定] 你的验证码是 #code，请在 QQ 群内发送「绑定 #code」，有效期 #time',
      unbindSuccess: '[解绑成功] 已解除与玩家 #player 的绑定',
      kickMessage:
        '&c你尚未完成账号绑定或已解绑，请先在 QQ 群内完成绑定后再进入服务器。',
    },
  };
}

/**
 * 默认验证服配置（双服务器模式）。
 *
 * 默认关闭：单服用户升级后行为完全不变。启用后，
 * `/绑定 <玩家ID>` 会改为「验证服发码 → 回填验证码 → 主服加白」。
 */
export function createDefaultVerifyServerConfig(): VerifyServerConfig {
  return {
    enabled: false,
    rcon: {
      host: '127.0.0.1',
      port: 25576,
      password: '',
      timeoutMs: 8000,
      reconnectIntervalMs: 5000,
    },
    autoWhitelist: true,
    whitelistAddCommand: 'whitelist add {player}',
  };
}

/**
 * 默认在线展示配置。
 *
 * 默认关闭：升级后 `/在线` 行为与旧版完全一致（文字转发 RCON 输出）。
 * 启用后改为发送图片卡片（服务器名 + 在线人数 + 玩家头像）。
 */
export function createDefaultPresenceConfig(): PresenceConfig {
  return {
    enabled: false,
    serverName: '生存服',
    showAvatars: true,
    sendImage: true,
    textTemplate: '[{server}] 在线 {online}/{max}\n{players}',
  };
}

/** 内置默认指令表：开箱即可用，且全部走「模板 + 参数校验」的安全路径 */
function defaultCommands(): CommandRule[] {
  return [
    {
      id: 'cmd-list',
      name: '在线',
      template: 'list',
      scope: 'both',
      adminOnly: false,
      allowArgs: false,
      enabled: true,
      description: '查询服务器当前在线玩家',
    },
    {
      id: 'cmd-tps',
      name: 'tps',
      template: 'tps',
      scope: 'both',
      adminOnly: false,
      allowArgs: false,
      enabled: true,
      description: '查询服务器 TPS（需服务端支持）',
    },
    {
      id: 'cmd-bind',
      name: '绑定',
      template: '',
      scope: 'both',
      adminOnly: false,
      allowArgs: true,
      enabled: true,
      description: '绑定 QQ 与 MC 玩家 ID。双向验证模式填验证码，信任模式填玩家ID',
    },
    {
      id: 'cmd-unbind',
      name: '解绑',
      template: '',
      scope: 'both',
      adminOnly: false,
      allowArgs: true,
      enabled: true,
      description: '解除 QQ 与 MC 玩家 ID 的绑定，格式：/解绑 <玩家ID>',
    },
    {
      id: 'cmd-mybind',
      name: '我的绑定',
      template: '',
      scope: 'both',
      adminOnly: false,
      allowArgs: false,
      enabled: true,
      description: '查看当前 QQ 已绑定的玩家 ID 列表',
    },
    {
      id: 'cmd-querybind',
      name: '查询绑定',
      template: '',
      scope: 'both',
      adminOnly: true,
      allowArgs: true,
      enabled: true,
      description: '按 QQ 号或玩家 ID 查询绑定归属（管理员）',
    },
    {
      id: 'cmd-wladd',
      name: '加白',
      template: 'whitelist add {arg0}',
      scope: 'both',
      adminOnly: true,
      allowArgs: true,
      enabled: true,
      description: '将指定玩家加入服务器白名单（管理员）',
    },
    {
      id: 'cmd-wlremove',
      name: '移除白名单',
      template: 'whitelist remove {arg0}',
      scope: 'both',
      adminOnly: true,
      allowArgs: true,
      enabled: true,
      description: '将指定玩家移出服务器白名单（管理员）',
    },
    {
      id: 'cmd-reload',
      name: '重载白名单',
      template: 'whitelist reload',
      scope: 'both',
      adminOnly: true,
      allowArgs: false,
      enabled: true,
      description: '重新读取白名单文件（管理员）',
    },
  ];
}

/** 默认日志监听配置：默认关闭，不启用时一切行为与旧版一致 */
export function createDefaultLogWatcherConfig(): LogWatcherConfig {
  return {
    enabled: false,
    logPath: '',
    serverDir: '',
    replayHistory: false,
    botPrefixes: ['Bot_', 'BOT_', 'bot_'],
    filterBots: true,
  };
}

/** 默认群服消息互通配置：默认关闭 */
export function createDefaultChatBridgeConfig(): ChatBridgeConfig {
  return {
    enabled: false,
    gameToChat: {
      enabled: true,
      groups: [],
      template: '[游戏] {player}: {message}',
    },
    chatToGame: {
      enabled: true,
      groups: [],
      template: '[群] {nickname}: {message}',
      skipCommands: true,
      mergeWindowMs: 0,
    },
    blockPatterns: [],
    replacements: [],
    quietHours: { start: 0, end: 0 },
    maxLength: 200,
  };
}

/** 默认自动回复配置：默认关闭，规则为空 */
export function createDefaultResponderConfig(): ResponderConfig {
  return {
    enabled: false,
    rules: [],
  };
}

/** 默认权限组配置：默认关闭。关闭时沿用原有的「管理员/普通用户」二元权限 */
export function createDefaultPermissionConfig(): PermissionConfig {
  return {
    enabled: false,
    groups: [],
  };
}

/** 默认定时任务配置：默认关闭，任务为空 */
export function createDefaultTaskConfig(): TaskConfig {
  return {
    enabled: false,
    tasks: [],
  };
}

/** 默认统计配置：默认关闭 */
export function createDefaultStatsConfig(): StatsConfig {
  return {
    enabled: false,
    maxPlayers: 2000,
  };
}

/** 默认事件通知配置：默认关闭 */
export function createDefaultNotifyConfig(): NotifyConfig {
  return {
    enabled: false,
    groups: [],
    join: { enabled: true, template: '[进服] {player} 加入了服务器' },
    leave: { enabled: true, template: '[退服] {player} 离开了服务器' },
    death: { enabled: true, template: '[死亡] {player} {detail}' },
    advancement: { enabled: false, template: '[成就] {player} 达成了 {detail}' },
    serverStart: { enabled: false, template: '[服务器] 已启动' },
  };
}

/**
 * 默认 AI 配置：默认关闭，且不预填任何 Key。
 *
 * 协议选 OpenAI 兼容（/chat/completions）而不是某一家 SDK：
 * DeepSeek、OpenAI、通义、Kimi、本地 Ollama / LM Studio 都实现了这套接口，
 * 用户只需换 baseUrl + model 就能切服务商，不必改代码、不用更新客户端。
 */
export function createDefaultAIConfig(): AIConfig {
  return {
    enabled: false,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    trigger: 'both',
    systemPrompt:
      '你是 Minecraft 服务器 QQ 群的管理助手。回答要简短、准确、口语化，' +
      '一般不超过 100 字。不确定的事情直接说不知道，不要编造服务器规则或数据。' +
      '不要输出任何命令、代码块或 Markdown 标记。',
    temperature: 0.7,
    maxTokens: 500,
    timeoutMs: 20000,
    contextTurns: 5,
    dailyQuotaPerUser: 30,
    fallbackToAI: false,
    mentionOnReply: false,
    allowPlayerProfile: true,
  };
}

/**
 * 默认图片回复配置：默认关闭。
 *
 * 关闭时所有回复保持纯文本，行为与旧版逐字节一致。
 * 阈值默认「3 行或 60 字」——短回复出图反而更难读，
 * 群里看一行字比点开一张图快。
 */
export function createDefaultImageReplyConfig(): ImageReplyConfig {
  return {
    enabled: false,
    scope: 'command',
    minLines: 3,
    minChars: 60,
    keepFiles: 60,
    showTime: true,
    theme: 'dark',
    width: 600,
    scale: 1,
    watermark: '',
  };
}

/** 本地日期 YYYY-MM-DD（默认起始日要用「今天」） */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 默认慰问服主配置：默认关闭，起始日 = 首次创建配置的当天。
 *
 * 起始日当天算第 1 天，所以第一次启用时播报的就是「离开 1 天」。
 */
export function createDefaultOwnerCareConfig(): OwnerCareConfig {
  return {
    enabled: false,
    startDate: todayStr(),
    groups: [],
    dailyAt: '20:00',
    template: '【慰问服主】{owner}离开 {days} 天了',
    ownerName: '服主',
    ownerQQ: '',
    mentionOwner: false,
  };
}

export function createDefaultConfig(): AppConfig {
  return {
    rcon: {
      host: '127.0.0.1',
      port: 25575,
      password: '',
      timeoutMs: 8000,
      reconnectIntervalMs: 5000,
    },
    verifyServer: createDefaultVerifyServerConfig(),
    onebot: {
      wsUrl: 'ws://127.0.0.1:3001',
      accessToken: '',
      autoReconnect: true,
      reconnectIntervalMs: 5000,
    },
    whitelist: {
      groupEnabled: true,
      groups: [],
      privateEnabled: true,
      privates: [],
      admins: [],
    },
    binding: createDefaultBindingConfig(),
    presence: createDefaultPresenceConfig(),
    snowluma: createDefaultSnowLumaConfig(),
    commands: defaultCommands(),
    serverId: 'main',
    rateLimitMs: 1500,
    update: createDefaultUpdateChannel(),
    logWatcher: createDefaultLogWatcherConfig(),
    chatBridge: createDefaultChatBridgeConfig(),
    responder: createDefaultResponderConfig(),
    permissions: createDefaultPermissionConfig(),
    tasks: createDefaultTaskConfig(),
    stats: createDefaultStatsConfig(),
    notify: createDefaultNotifyConfig(),
    ai: createDefaultAIConfig(),
    imageReply: createDefaultImageReplyConfig(),
    ownerCare: createDefaultOwnerCareConfig(),
  };
}

/** 默认更新源：GitHub 官方仓库（可在设置里改成自定义静态源） */
export function createDefaultUpdateChannel(): UpdateChannel {
  return {
    customUrl: '',
    repoUrl: 'lumicyan/gelibot',
  };
}
