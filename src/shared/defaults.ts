import type { AppConfig, BindingConfig, CommandRule, SnowLumaConfig } from './types';

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
      serverHint:
        '[绑定] 你的验证码是 #code，请在 QQ 群内发送「绑定 #code」，有效期 #time',
      unbindSuccess: '[解绑成功] 已解除与玩家 #player 的绑定',
      kickMessage:
        '&c你尚未完成账号绑定或已解绑，请先在 QQ 群内完成绑定后再进入服务器。',
    },
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

export function createDefaultConfig(): AppConfig {
  return {
    rcon: {
      host: '127.0.0.1',
      port: 25575,
      password: '',
      timeoutMs: 8000,
      reconnectIntervalMs: 5000,
    },
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
    snowluma: createDefaultSnowLumaConfig(),
    commands: defaultCommands(),
    serverId: 'main',
    rateLimitMs: 1500,
  };
}
