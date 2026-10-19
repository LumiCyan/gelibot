/**
 * 新增功能域的单测：日志解析 / 权限组 / 自动回复 / 定时任务 / 消息桥 / 统计。
 *
 * 这些模块的「判定逻辑」都写成了纯函数，正是为了让它们能脱离 electron 环境直接验证。
 *
 * 运行：npm test（会先 build:main）
 */
const {
  parseLogLine,
  stripLogPrefix,
  isBotName,
} = require('../../dist/main/logwatcher.js');
const {
  matchCommandPattern,
  canUseCommand,
  resolveGroups,
  allowedCommandPatterns,
} = require('../../dist/main/permissions.js');
const { Responder, matchRule, renderResponderReply } = require('../../dist/main/responder.js');
const { shouldRun, parseDailyAt } = require('../../dist/main/task.js');
const {
  inQuietHours,
  sanitizeForGame,
  isBlocked,
  truncate,
  applyReplacements,
  renderMessage,
} = require('../../dist/main/chatbridge.js');
const { StatsManager, formatOnlineTime } = require('../../dist/main/stats.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  ✘ ${name}${extra ? '：' + extra : ''}`);
  }
}

// ============================================================
// 一、日志解析
// ============================================================

// --- 前缀剥离：兼容多种服务端 ---
check(
  'Vanilla 前缀剥离',
  stripLogPrefix('[19:44:15] [Server thread/INFO]: <Steve> hi') === '<Steve> hi',
);
check(
  'Paper 1.19+ 前缀剥离',
  stripLogPrefix('[19:44:15 INFO]: <Steve> hi') === '<Steve> hi',
);
check(
  'Forge 前缀剥离',
  stripLogPrefix('[17Oct2026 19:44:15.123] [Server thread/INFO] [net.minecraft.server/MinecraftServer/]: <Steve> hi') ===
    '<Steve> hi',
);
check('无前缀原样返回', stripLogPrefix('<Steve> hi') === '<Steve> hi');
check('空行返回空串', stripLogPrefix('   ') === '');

// --- 聊天 ---
{
  const ev = parseLogLine('[19:44:15] [Server thread/INFO]: <Steve> hello world');
  check('聊天事件类型', ev?.kind === 'chat');
  check('聊天事件玩家', ev?.player === 'Steve');
  check('聊天事件内容', ev?.detail === 'hello world');
  check('聊天事件保留原始行', typeof ev?.raw === 'string' && ev.raw.includes('hello world'));
}
{
  // 空消息（只发了 <Steve> 后面没内容）
  const ev = parseLogLine('[19:44:15] [Server thread/INFO]: <Steve> ');
  check('空聊天内容仍解析', ev?.kind === 'chat' && ev.detail === '');
}

// --- 进服 / 退服 ---
check('进服事件', parseLogLine('[19:44:15] [Server thread/INFO]: Alex joined the game')?.kind === 'join');
check('进服带句点', parseLogLine('Alex joined the game.')?.kind === 'join');
check('退服事件', parseLogLine('[19:44:15] [Server thread/INFO]: Alex left the game')?.kind === 'leave');
check('退服玩家名', parseLogLine('Alex left the game')?.player === 'Alex');

// --- 死亡（英文多形态）---
check('被僵尸杀死', parseLogLine('[19:44:15] [Server thread/INFO]: Steve was slain by Zombie')?.kind === 'death');
check('溺水', parseLogLine('Steve drowned')?.kind === 'death');
check('摔落', parseLogLine('Steve fell from a high place')?.kind === 'death');
check('岩浆', parseLogLine('Steve tried to swim in lava')?.kind === 'death');
check('被玩家杀死', parseLogLine('Steve was slain by Alex using [Diamond Sword]')?.kind === 'death');
check('死亡详情保留', parseLogLine('Steve drowned')?.detail === 'drowned');

// --- 死亡（中文服务端）---
check('中文淹死', parseLogLine('Steve 淹死了')?.kind === 'death');
check('中文被杀', parseLogLine('Steve 被 Alex 杀死了')?.kind === 'death');
check('中文摔死', parseLogLine('Steve 从高处摔了下来')?.kind === 'death');

// --- 成就 ---
{
  const ev = parseLogLine('Steve has made the advancement [Stone Age]');
  check('成就事件', ev?.kind === 'advancement');
  check('成就名', ev?.detail === 'Stone Age');
}
check(
  '挑战完成',
  parseLogLine('Steve has completed the challenge [Monsters Hunted]')?.kind === 'advancement',
);

// --- 服务器启动 ---
check(
  '服务器就绪',
  parseLogLine('Done (3.456s)! For help, type "help"')?.kind === 'server-start',
);

// --- 非事件行 ---
check('普通 INFO 行不产生事件', parseLogLine('[19:44:15] [Server thread/INFO]: Saving chunks') === null);
check('空行不产生事件', parseLogLine('') === null);
check('纯空白不产生事件', parseLogLine('   \n') === null);

// --- 假人过滤 ---
check('假人进服被过滤', parseLogLine('Bot_Steve joined the game', { botPrefixes: ['Bot_'], filterBots: true }) === null);
check('假人聊天被过滤', parseLogLine('<Bot_Steve> hi', { botPrefixes: ['Bot_'], filterBots: true }) === null);
check(
  '关闭过滤后假人可见',
  parseLogLine('Bot_Steve joined the game', { botPrefixes: ['Bot_'], filterBots: false })?.kind === 'join',
);
check('不匹配前缀的真人可见', parseLogLine('Steve joined the game', { botPrefixes: ['Bot_'], filterBots: true })?.kind === 'join');
check('isBotName 命中', isBotName('Bot_A', ['Bot_'], true) === true);
check('isBotName 关闭时恒 false', isBotName('Bot_A', ['Bot_'], false) === false);
check('空前缀不误伤', isBotName('Steve', [''], true) === false);

// ============================================================
// 二、权限组
// ============================================================

check('通配 * 全匹配', matchCommandPattern('*', 'list') === true);
check('前缀通配', matchCommandPattern('white*', 'whitelist') === true);
check('前缀通配不误伤', matchCommandPattern('white*', 'list') === false);
check('精确匹配忽略大小写', matchCommandPattern('LIST', 'list') === true);
check('空模式不匹配', matchCommandPattern('', 'list') === false);

{
  const cfg = {
    enabled: true,
    groups: [
      {
        id: 'vip',
        name: 'VIP',
        subjects: [{ type: 'account', value: '10001' }],
        allowCommands: ['list', 'tps'],
        denyCommands: [],
        priority: 10,
      },
    ],
  };
  const ctx = { qq: '10001' };
  check('权限组命中后可执行', canUseCommand('list', ctx, cfg, false, true) === true);
  check('权限组未授权的拒绝', canUseCommand('stop', ctx, cfg, false, true) === false);

  // 全局管理员永远放行
  check('全局管理员放行', canUseCommand('stop', ctx, cfg, true, true) === true);
}

{
  // deny 优先于 allow
  const cfg = {
    enabled: true,
    groups: [
      {
        id: 'g1',
        name: 'G1',
        subjects: [{ type: 'group', value: '555' }],
        allowCommands: ['*'],
        denyCommands: ['stop'],
        priority: 1,
      },
    ],
  };
  const ctx = { qq: '1', groupId: '555' };
  check('allow * 生效', canUseCommand('list', ctx, cfg, false, true) === true);
  check('deny 压过 allow', canUseCommand('stop', ctx, cfg, false, true) === false);
}

{
  // 权限组关闭：退回旧的二元判断
  const cfg = { enabled: false, groups: [] };
  check('关闭时普通指令放行', canUseCommand('list', {}, cfg, false, false) === true);
  check('关闭时管理指令拒绝', canUseCommand('stop', {}, cfg, false, true) === false);
}

{
  // 嵌套展开 + 循环引用不死循环
  const cfg = {
    enabled: true,
    groups: [
      {
        id: 'A',
        name: 'A',
        subjects: [{ type: 'account', value: '9' }],
        allowCommands: ['a'],
        denyCommands: [],
        priority: 1,
      },
      {
        id: 'B',
        name: 'B',
        subjects: [{ type: 'nested', value: 'A' }],
        allowCommands: ['b'],
        denyCommands: [],
        priority: 2,
      },
      {
        id: 'C',
        name: 'C',
        subjects: [{ type: 'nested', value: 'B' }],
        allowCommands: ['c'],
        denyCommands: [],
        priority: 3,
      },
    ],
  };
  const groups = resolveGroups(cfg, { qq: '9' });
  check('嵌套链 A→B→C 全部展开', groups.length === 3);
  const allowed = allowedCommandPatterns(cfg, { qq: '9' });
  check('嵌套组指令合并', ['a', 'b', 'c'].every((c) => allowed.includes(c)));

  // 循环引用：D→E→D
  const cyclic = {
    enabled: true,
    groups: [
      {
        id: 'D',
        name: 'D',
        subjects: [{ type: 'account', value: '1' }, { type: 'nested', value: 'E' }],
        allowCommands: ['d'],
        denyCommands: [],
        priority: 1,
      },
      {
        id: 'E',
        name: 'E',
        subjects: [{ type: 'nested', value: 'D' }],
        allowCommands: ['e'],
        denyCommands: [],
        priority: 2,
      },
    ],
  };
  check('循环嵌套不死循环', resolveGroups(cyclic, { qq: '1' }).length === 2);
}

// ============================================================
// 三、自动回复
// ============================================================

{
  const rule = {
    id: 'r1',
    name: 'R1',
    enabled: true,
    matchType: 'keyword',
    pattern: '怎么进',
    reply: '加群 123',
    toGame: false,
    adminOnly: false,
    cooldownSeconds: 0,
  };
  check('关键词命中', matchRule(rule, '请问怎么进服') === true);
  check('关键词不命中', matchRule(rule, '今天天气不错') === false);
  check('关键词忽略大小写', matchRule({ ...rule, pattern: 'HELLO' }, 'say hello') === true);

  const exact = { ...rule, matchType: 'exact', pattern: '你好' };
  check('完全匹配命中', matchRule(exact, '你好') === true);
  check('完全匹配不接受包含', matchRule(exact, '你好啊') === false);

  const regex = { ...rule, matchType: 'regex', pattern: '^\\d{6}$' };
  check('正则命中 6 位数字', matchRule(regex, '123456') === true);
  check('正则不命中', matchRule(regex, '12345') === false);

  // 非法正则不抛错
  check('非法正则安全返回 false', matchRule({ ...rule, matchType: 'regex', pattern: '([' }, 'x') === false);
}

check(
  '回复变量替换',
  renderResponderReply('你好 {nickname}（{user}）在 {group}', {
    qq: '10086',
    nickname: '小明',
    groupId: '555',
  }) === '你好 小明（10086）在 555',
);

{
  const cfg = {
    enabled: true,
    rules: [
      {
        id: 'r1',
        name: 'R1',
        enabled: true,
        matchType: 'keyword',
        pattern: '在线',
        reply: '回复1',
        toGame: false,
        adminOnly: false,
        cooldownSeconds: 0,
      },
      {
        id: 'r2',
        name: 'R2',
        enabled: true,
        matchType: 'keyword',
        pattern: '在线',
        reply: '回复2',
        toGame: false,
        adminOnly: false,
        cooldownSeconds: 0,
      },
    ],
  };
  const r = new Responder(cfg);
  const hit = r.evaluate('在线吗', { qq: '1', groupId: '9', isAdmin: false });
  check('多规则命中只取第一条', hit?.rule.id === 'r1');
  check('回复已渲染', hit?.reply === '回复1');

  // 关闭后不命中
  const off = new Responder({ ...cfg, enabled: false });
  check('总开关关闭不命中', off.evaluate('在线', { qq: '1', isAdmin: false }) === null);
}

{
  // 冷却：同群同规则
  const cfg = {
    enabled: true,
    rules: [
      {
        id: 'r1',
        name: 'R1',
        enabled: true,
        matchType: 'keyword',
        pattern: 'x',
        reply: 'y',
        toGame: false,
        adminOnly: false,
        cooldownSeconds: 60,
      },
    ],
  };
  const r = new Responder(cfg);
  check('首次命中', r.evaluate('x', { qq: '1', groupId: '9', isAdmin: false }) !== null);
  check('冷却期内不再命中', r.evaluate('x', { qq: '1', groupId: '9', isAdmin: false }) === null);
  check('不同群不受另一群冷却影响', r.evaluate('x', { qq: '1', groupId: '10', isAdmin: false }) !== null);
}

{
  // adminOnly
  const cfg = {
    enabled: true,
    rules: [
      {
        id: 'r1',
        name: 'R1',
        enabled: true,
        matchType: 'keyword',
        pattern: 'x',
        reply: 'y',
        toGame: false,
        adminOnly: true,
        cooldownSeconds: 0,
      },
    ],
  };
  const r = new Responder(cfg);
  check('普通用户触碰管理员规则无响应', r.evaluate('x', { qq: '1', isAdmin: false }) === null);
  check('管理员可触发', r.evaluate('x', { qq: '1', isAdmin: true }) !== null);
}

// ============================================================
// 四、定时任务
// ============================================================

check('解析 04:00', parseDailyAt('04:00')?.hour === 4 && parseDailyAt('04:00')?.minute === 0);
check('解析 23:59', parseDailyAt('23:59')?.hour === 23);
check('解析单数字小时', parseDailyAt('4:5')?.hour === 4 && parseDailyAt('4:5')?.minute === 5);
check('非法格式返回 null', parseDailyAt('25:00') === null);
check('非法格式返回 null 2', parseDailyAt('abc') === null);
check('空串返回 null', parseDailyAt('') === null);

{
  const base = {
    id: 't1',
    name: 'T1',
    enabled: true,
    intervalMinutes: 0,
    dailyAt: '',
    action: { type: 'rcon', command: 'list' },
  };

  // 每日定点
  const daily = { ...base, dailyAt: '04:00' };
  check('定点命中', shouldRun(daily, new Date(2026, 0, 1, 4, 0, 30)) === true);
  check('非定点分钟不跑', shouldRun(daily, new Date(2026, 0, 1, 4, 1, 0)) === false);
  check(
    '同分钟已跑过不再跑',
    shouldRun({ ...daily, lastRunAt: new Date(2026, 0, 1, 4, 0, 5).toISOString() }, new Date(2026, 0, 1, 4, 0, 50)) ===
      false,
  );
  check(
    '次日同一点再跑',
    shouldRun({ ...daily, lastRunAt: new Date(2026, 0, 1, 4, 0, 5).toISOString() }, new Date(2026, 0, 2, 4, 0, 10)) ===
      true,
  );

  // 间隔
  const every = { ...base, intervalMinutes: 30 };
  check('从未跑过立即跑', shouldRun(every, new Date(2026, 0, 1, 0, 0)) === true);
  check(
    '未到间隔不跑',
    shouldRun({ ...every, lastRunAt: new Date(2026, 0, 1, 0, 0).toISOString() }, new Date(2026, 0, 1, 0, 10)) ===
      false,
  );
  check(
    '到间隔再跑',
    shouldRun({ ...every, lastRunAt: new Date(2026, 0, 1, 0, 0).toISOString() }, new Date(2026, 0, 1, 0, 31)) ===
      true,
  );

  // 未配置触发条件
  check('无触发条件永不执行', shouldRun({ ...base, intervalMinutes: 0, dailyAt: '' }, new Date()) === false);
  // 关闭的任务
  check('关闭的任务不执行', shouldRun({ ...daily, enabled: false }, new Date(2026, 0, 1, 4, 0)) === false);
}

// ============================================================
// 五、消息桥纯函数
// ============================================================

check('静音时段内（普通）', inQuietHours(23, 7, 2) === true);
check('静音时段外（普通）', inQuietHours(23, 7, 12) === false);
check('静音时段内（同日）', inQuietHours(1, 6, 3) === true);
check('静音时段外（同日）', inQuietHours(1, 6, 7) === false);
check('起止相同不静音', inQuietHours(0, 0, 12) === false);
check('跨零点边界起始', inQuietHours(23, 7, 23) === true);
check('跨零点边界结束', inQuietHours(23, 7, 7) === false);

check('CQ 图片降级', sanitizeForGame('看这个[CQ:image,file=abc.jpg]') === '看这个[图片]');
check('CQ 表情降级', sanitizeForGame('[CQ:face,id=1]') === '[表情]');
check('CQ @ 降级', sanitizeForGame('[CQ:at,qq=12345] 你好').includes('@12345'));
check('颜色码被剥离', sanitizeForGame('§c红色文字') === '红色文字');
check('换行归一', sanitizeForGame('第一行\n第二行') === '第一行 第二行');

check('敏感词替换', applyReplacements('加我微信 abc', [{ from: '微信', to: '***' }]) === '加我*** abc');
check('替换表空不崩', applyReplacements('abc', []) === 'abc');

check('屏蔽正则命中', isBlocked('出售代练服务', ['代练']) === true);
check('屏蔽正则不命中', isBlocked('正常聊天', ['代练']) === false);
check('非法屏蔽正则不崩', isBlocked('abc', ['([']) === false);

check('截断超长', truncate('abcdefghij', 5).length === 5);
check('未超长不截断', truncate('abc', 5) === 'abc');
check('maxLength 为 0 不截断', truncate('abcdef', 0) === 'abcdef');

check(
  '模板变量替换',
  renderMessage('[游戏] {player}: {message}', { player: 'Steve', message: 'hi' }) ===
    '[游戏] Steve: hi',
);
check('未知变量原样保留', renderMessage('{unknown}', {}) === '{unknown}');

// ============================================================
// 六、统计
// ============================================================

check('格式化 0 秒', formatOnlineTime(0) === '0秒');
check('格式化 90 秒', formatOnlineTime(90) === '1分');
check('格式化 1 小时', formatOnlineTime(3600) === '1小时');
check('格式化 3 天', formatOnlineTime(3 * 86400).startsWith('3天'));
check('负数归零', formatOnlineTime(-5) === '0秒');

{
  const s = new StatsManager({ enabled: true, maxPlayers: 100 });
  s.onJoin('Steve');
  s.onChat('Steve');
  s.onChat('Steve');
  s.onCommand('Steve');
  const rec = s.get('Steve');
  check('统计：进服次数', rec?.joinCount === 1);
  check('统计：发言数', rec?.chatCount === 2);
  check('统计：指令数', rec?.commandCount === 1);
  check('统计：大小写不敏感查询', s.get('steve')?.chatCount === 2);
  check('统计：不存在玩家返回 null', s.get('Nobody') === null);

  const top = s.top('chatCount', 10);
  check('排行榜返回该玩家', top.length === 1 && top[0].playerId === 'Steve');

  s.onLeave('Steve');
  check('退服后在线时长已结算（≥0）', (s.get('Steve')?.onlineSeconds ?? -1) >= 0);

  s.clear();
  check('清空后无记录', s.list().length === 0);
}

{
  // 关闭统计时所有记录都是空操作
  const off = new StatsManager({ enabled: false, maxPlayers: 100 });
  off.onJoin('Steve');
  check('统计关闭不记录', off.list().length === 0);
}

{
  // 容量淘汰：超上限时淘汰最久未出现的
  const s = new StatsManager({ enabled: true, maxPlayers: 2 });
  s.onChat('A');
  s.onChat('B');
  s.onChat('C');
  check('超过上限被淘汰', s.list().length <= 2);
}

console.log(`新增功能测试：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
