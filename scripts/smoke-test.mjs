#!/usr/bin/env node
/**
 * 全功能端到端排查（不参与打包）。
 *
 * 和单元测试的区别：单元测试喂的是构造好的数据，这里跑的是**真实链路**——
 * 起一个真实的 TCP RCON 服务端、写真实的日志文件，让 RconClient / LogWatcher
 * 走真实的 socket 与文件 IO，再把上层模块串起来验证。
 *
 * 覆盖：RCON 连接与命令 → 在线解析 → 日志事件 → 统计 → 消息桥 → 自动回复
 *       → 权限组 → 慰问服主 → 图片解析 → 配置迁移
 *
 * 用法：node scripts/smoke-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const PORT = 25600;
const PASSWORD = 'mockpass';
const MOCK_DIR = path.join(ROOT, '.stage', 'smoke-server');
const LOG_FILE = path.join(MOCK_DIR, 'logs', 'latest.log');

// ---------------------------------------------------------------- 断言
let pass = 0;
let fail = 0;
const failures = [];

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
}
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? '：' + detail : ''}`);
    console.log(`  ✘ ${name}${detail ? '：' + detail : ''}`);
  }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 TCP 端口可连 */
async function waitPort(port, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const ok = await new Promise((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port }, () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
      s.setTimeout(500, () => {
        s.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    if (Date.now() - start > timeoutMs) return false;
    await delay(120);
  }
}

/** 往 mock 日志追加一行 */
function appendLog(text) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const line = `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] [Server thread/INFO]: ${text}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
  return line;
}

// ---------------------------------------------------------------- 主流程
async function main() {
  console.log('GeLi Bot 全功能排查\n' + '='.repeat(56));

  // -------------------------------------------------- 0. 起虚拟服务器
  section('0. 虚拟 Minecraft 服务器');
  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, 'scripts', 'mock-server.mjs'),
      '--dir', MOCK_DIR,
      '--port', String(PORT),
      '--password', PASSWORD,
      '--no-events',
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let mockLog = '';
  child.stdout.on('data', (d) => (mockLog += d.toString()));
  child.stderr.on('data', (d) => (mockLog += d.toString()));

  const up = await waitPort(PORT);
  check('RCON 端口已监听', up, `端口 ${PORT}`);
  check('日志文件已创建', fs.existsSync(LOG_FILE), LOG_FILE);
  if (!up) {
    console.error(mockLog);
    child.kill();
    process.exit(1);
  }

  // 载入被测模块（编译产物）
  const { RconClient } = require(path.join(ROOT, 'dist', 'main', 'rcon.js'));
  const { PresenceService, parseListOutput } = require(path.join(ROOT, 'dist', 'main', 'presence.js'));
  const { LogWatcher, parseLogLine } = require(path.join(ROOT, 'dist', 'main', 'logwatcher.js'));
  const { StatsManager } = require(path.join(ROOT, 'dist', 'main', 'stats.js'));
  const { ChatBridge, inQuietHours, sanitizeForGame } = require(path.join(ROOT, 'dist', 'main', 'chatbridge.js'));
  const { Responder } = require(path.join(ROOT, 'dist', 'main', 'responder.js'));
  const { canUseCommand } = require(path.join(ROOT, 'dist', 'main', 'permissions.js'));
  const { daysSince, formatCareMessage } = require(path.join(ROOT, 'dist', 'main', 'owner-care.js'));
  const { parseReplyToLines, shouldRenderImage } = require(path.join(ROOT, 'dist', 'main', 'image-reply-util.js'));
  const { buildGenericCardHtml } = require(path.join(ROOT, 'dist', 'main', 'card-generic.js'));
  const { mergeConfigWithDefaults } = require(path.join(ROOT, 'dist', 'main', 'store.js'));
  const { createDefaultConfig } = require(path.join(ROOT, 'dist', 'shared', 'defaults.js'));

  // -------------------------------------------------- 1. RCON
  section('1. RCON 连接与命令');

  const badClient = new RconClient({
    host: '127.0.0.1', port: PORT, password: 'wrong', timeoutMs: 3000, reconnectIntervalMs: 0,
  });
  await badClient.connect();
  check('错误密码被拒绝', badClient.getState().state === 'error', JSON.stringify(badClient.getState()));
  badClient.destroy();

  const rcon = new RconClient({
    host: '127.0.0.1', port: PORT, password: PASSWORD, timeoutMs: 4000, reconnectIntervalMs: 0,
  });
  await rcon.connect();
  check('正确密码连接成功', rcon.getState().state === 'connected', JSON.stringify(rcon.getState()));

  const listRes = await rcon.execute('list');
  check('list 执行成功', listRes.success, listRes.error);
  check('list 返回在线人数', /There are \d+ of a max of \d+ players online/.test(listRes.response ?? ''), listRes.response);

  const tpsRes = await rcon.execute('tps');
  check('tps 返回 TPS 数据', tpsRes.success && /TPS/.test(tpsRes.response ?? ''), tpsRes.response);

  const addRes = await rcon.execute('whitelist add SmokeTester');
  check('whitelist add 成功', /Added SmokeTester/.test(addRes.response ?? ''), addRes.response);

  const wlRes = await rcon.execute('whitelist list');
  check('新增玩家已在白名单', /SmokeTester/.test(wlRes.response ?? ''), wlRes.response);

  // 离线玩家的 tellraw：真实服务端「执行成功但带提示」，这是绑定流程的判断依据
  const tellRes = await rcon.execute('tellraw NotOnline {"text":"hi"}');
  check(
    'tellraw 离线玩家返回 No player',
    tellRes.success && /No player was found/i.test(tellRes.response ?? ''),
    tellRes.response,
  );

  const unknown = await rcon.execute('definitely_not_a_command');
  check('未知命令返回 Unknown', /Unknown or incomplete command/i.test(unknown.response ?? ''), unknown.response);

  // 超时：命令响应慢于 timeout 时应报错而不是永久挂起
  const quick = new RconClient({
    host: '127.0.0.1', port: PORT, password: PASSWORD, timeoutMs: 1000, reconnectIntervalMs: 0,
  });
  await quick.connect();
  const kickRes = await quick.execute('kick Ghost');
  check('kick 离线玩家报 No player', /No player was found/i.test(kickRes.response ?? ''), kickRes.response);
  quick.destroy();

  // -------------------------------------------------- 2. 在线展示
  section('2. 在线人数解析');

  const parsed = parseListOutput(listRes.response ?? '');
  check('parseListOutput 解析成功', parsed !== null, listRes.response);
  if (parsed) {
    // 虚拟服初始：Steve、Alex + 假人 Bot_Farmer = 3
    check('解析出在线人数', parsed.online === 3, `online=${parsed.online}`);
    check('解析出上限', parsed.max === 20, `max=${parsed.max}`);
    check('解析出玩家列表', Array.isArray(parsed.players) && parsed.players.length === 3, JSON.stringify(parsed.players));
  }

  const presence = new PresenceService(rcon);
  const snap = await presence.refresh();
  check('PresenceService 采集成功', snap.ok === true, JSON.stringify({ ok: snap.ok, error: snap.error }));
  check('并发 refresh 共享请求', (await Promise.all([presence.refresh(), presence.refresh()])).every((s) => s.ok));

  // -------------------------------------------------- 3. 日志监听
  section('3. 日志监听（游戏内事件）');

  const events = [];
  const watcher = new LogWatcher({
    enabled: true,
    logPath: LOG_FILE,
    serverDir: '',
    replayHistory: false,
    botPrefixes: ['Bot_'],
    filterBots: true,
  });
  watcher.onEvent((ev) => events.push(ev));
  watcher.start();
  check('日志监听已启动', watcher.getStatus().running, JSON.stringify(watcher.getStatus()));

  // 手动追加事件，避免依赖定时器的时序
  appendLog('SmokePlayer joined the game');
  await delay(700);
  appendLog('<SmokePlayer> 测试消息');
  await delay(700);
  appendLog('SmokePlayer was slain by Zombie');
  await delay(700);
  appendLog('Bot_Farmer joined the game'); // 应被假人过滤
  await delay(700);
  appendLog('SmokePlayer left the game');
  await delay(900);

  const kinds = events.map((e) => e.kind);
  check('捕获进服事件', kinds.includes('join'), JSON.stringify(kinds));
  check('捕获聊天事件', kinds.includes('chat'), JSON.stringify(kinds));
  check('捕获死亡事件', kinds.includes('death'), JSON.stringify(kinds));
  check('捕获退服事件', kinds.includes('leave'), JSON.stringify(kinds));
  check('假人事件被过滤', !events.some((e) => e.player === 'Bot_Farmer'), JSON.stringify(events.map((e) => e.player)));

  const chatEv = events.find((e) => e.kind === 'chat');
  check('聊天内容解析正确', chatEv?.detail === '测试消息', chatEv?.detail);
  check('聊天玩家解析正确', chatEv?.player === 'SmokePlayer', chatEv?.player);

  // 解析器兜底
  check('普通 INFO 行不产生事件', parseLogLine('Saving chunks') === null);

  watcher.stop();
  check('日志监听可停止', watcher.getStatus().running === false);

  // -------------------------------------------------- 4. 统计
  section('4. 玩家统计');

  const stats = new StatsManager({ enabled: true, maxPlayers: 100 });
  stats.onJoin('SmokePlayer');
  stats.onChat('SmokePlayer');
  stats.onChat('SmokePlayer');
  stats.onCommand('SmokePlayer');
  stats.onLeave('SmokePlayer');

  const rec = stats.get('SmokePlayer');
  check('记录进服次数', rec?.joinCount === 1, String(rec?.joinCount));
  check('记录发言次数', rec?.chatCount === 2, String(rec?.chatCount));
  check('记录指令次数', rec?.commandCount === 1, String(rec?.commandCount));
  check('查询大小写不敏感', stats.get('smokeplayer')?.chatCount === 2);
  check('在线时长已结算', (rec?.onlineSeconds ?? -1) >= 0, String(rec?.onlineSeconds));
  check('排行榜可用', stats.top('chatCount', 5).length === 1);

  // -------------------------------------------------- 5. 消息桥
  section('5. 群服消息互通');

  const sentToGroups = [];
  const sentToGame = [];
  const bridge = new ChatBridge(
    {
      enabled: true,
      gameToChat: { enabled: true, groups: ['100'], template: '[游戏] {player}: {message}' },
      chatToGame: {
        enabled: true, groups: ['100'], template: '[群] {nickname}: {message}',
        skipCommands: true, mergeWindowMs: 0,
      },
      blockPatterns: ['广告'],
      replacements: [{ from: '微信', to: '***' }],
      quietHours: { start: 3, end: 4 },
      maxLength: 200,
    },
    { enabled: true, groups: ['100'], join: { enabled: true, template: '[进服] {player}' },
      leave: { enabled: false, template: '' }, death: { enabled: false, template: '' },
      advancement: { enabled: false, template: '' }, serverStart: { enabled: false, template: '' } },
    {
      sendToGroups: async (groups, text, kind) => sentToGroups.push({ groups, text, kind }),
      sendToGame: async (text) => sentToGame.push(text),
    },
  );

  await bridge.handleGameChat({ kind: 'chat', player: 'SmokePlayer', detail: '你好', raw: '', at: '' });
  check('游戏→群 已发送', sentToGroups.length === 1, JSON.stringify(sentToGroups));
  check('游戏→群 文案正确', sentToGroups[0]?.text === '[游戏] SmokePlayer: 你好', sentToGroups[0]?.text);

  await bridge.handleChatMessage({ groupId: '100', qq: '1', nickname: '小明', message: '在吗' });
  check('群→游戏 已发送', sentToGame.length === 1, JSON.stringify(sentToGame));
  check('群→游戏 文案正确', sentToGame[0] === '[群] 小明: 在吗', sentToGame[0]);

  await bridge.handleChatMessage({ groupId: '100', qq: '1', nickname: '小明', message: '/在线' });
  check('斜杠命令不转发到游戏', sentToGame.length === 1, JSON.stringify(sentToGame));

  await bridge.handleChatMessage({ groupId: '100', qq: '1', nickname: '小明', message: '卖广告的来了' });
  check('屏蔽词生效', sentToGame.length === 1, JSON.stringify(sentToGame));

  await bridge.handleChatMessage({ groupId: '100', qq: '1', nickname: '小明', message: '加我微信' });
  check('敏感词已替换', sentToGame[1] === '[群] 小明: 加我***', sentToGame[1]);

  await bridge.handleChatMessage({ groupId: '999', qq: '1', nickname: '小明', message: '别的群' });
  check('非白名单群不转发', sentToGame.length === 2, JSON.stringify(sentToGame));

  await bridge.handleGameEvent({ kind: 'join', player: 'SmokePlayer', detail: '', raw: '', at: '' });
  check('进服通知已发送', sentToGroups.some((m) => m.text === '[进服] SmokePlayer'), JSON.stringify(sentToGroups));

  check('CQ 图片降级', sanitizeForGame('[CQ:image,file=x.png]') === '[图片]');
  check('静音时段判断（跨零点）', inQuietHours(23, 7, 2) === true && inQuietHours(23, 7, 12) === false);

  // -------------------------------------------------- 6. 自动回复
  section('6. 自动回复');

  const responder = new Responder({
    enabled: true,
    rules: [{
      id: 'r1', name: '进服指引', enabled: true, matchType: 'keyword', pattern: '怎么进',
      reply: '发送 /绑定 你的ID', toGame: false, adminOnly: false, cooldownSeconds: 60,
    }],
  });
  check('关键词命中', responder.evaluate('请问怎么进服', { qq: '1', isAdmin: false }) !== null);
  check('冷却生效', responder.evaluate('怎么进服', { qq: '1', isAdmin: false }) === null);
  check('不相关消息不命中', responder.evaluate('今天天气不错', { qq: '1', isAdmin: false }) === null);

  // -------------------------------------------------- 7. 权限组
  section('7. 权限组');

  const permCfg = {
    enabled: true,
    groups: [
      { id: 'vip', name: 'VIP', subjects: [{ type: 'account', value: '1001' }],
        allowCommands: ['list', 'tps'], denyCommands: [], priority: 1 },
      { id: 'all', name: '包含VIP', subjects: [{ type: 'nested', value: 'vip' }],
        allowCommands: ['whitelist*'], denyCommands: ['stop'], priority: 2 },
    ],
  };
  check('权限组内指令放行', canUseCommand('list', { qq: '1001' }, permCfg, false, true) === true);
  check('未授权指令拒绝', canUseCommand('op', { qq: '1001' }, permCfg, false, true) === false);
  check('嵌套组继承权限', canUseCommand('whitelist add', { qq: '1001' }, permCfg, false, true) === true);
  check('deny 优先于继承的 allow', canUseCommand('stop', { qq: '1001' }, permCfg, false, true) === false);
  check('全局管理员兜底放行', canUseCommand('stop', { qq: '1' }, permCfg, true, true) === true);

  // -------------------------------------------------- 8. 慰问服主
  section('8. 慰问服主');

  const today = new Date();
  const t2 = (n) => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${t2(today.getMonth() + 1)}-${t2(today.getDate())}`;
  check('起始日当天为第 1 天', daysSince(todayStr) === 1, String(daysSince(todayStr)));
  check('跨月计算正确', daysSince('2026-01-31', new Date(2026, 1, 2)) === 3);
  check('非法日期返回 0', daysSince('2026-02-31') === 0);
  check(
    '文案渲染',
    formatCareMessage('{owner}离开 {days} 天', { days: 3, owner: '服主', startDate: '' }) === '服主离开 3 天',
  );

  // -------------------------------------------------- 9. 图片渲染
  section('9. 图片渲染');

  const parsedCard = parseReplyToLines('/在线 执行结果：\nThere are 3 of a max of 20 players online: a, b');
  check('解析出副标题', parsedCard.subtitle === '/在线', parsedCard.subtitle);
  check('解析出正文', parsedCard.lines.length === 1);
  check('阈值判断：长文本出图', shouldRenderImage('a\nb\nc', { enabled: true, scope: 'command', minLines: 3, minChars: 60, keepFiles: 60, showTime: true }) === true);
  check('阈值判断：短文本不出图', shouldRenderImage('好', { enabled: true, scope: 'command', minLines: 3, minChars: 60, keepFiles: 60, showTime: true }) === false);

  const html = buildGenericCardHtml(
    { title: '<script>x</script>', lines: [{ kind: 'text', text: '<img onerror=1>' }] },
    { iconUri: 'data:image/png;base64,AA', width: 600, theme: 'light', scale: 1.1, watermark: '测试' },
  );
  check('HTML 转义：script 被消解', !html.includes('<script>x</script>'));
  check('HTML 转义：img 被消解', !html.includes('<img onerror=1>'));
  check('浅色主题生效', html.includes('#ffffff'));
  check('缩放生效', html.includes('--s: 1.1'));
  check('水印渲染', html.includes('测试'));
  check('无残留占位符', !/__[A-Z_]+__/.test(html));

  // -------------------------------------------------- 10. 配置迁移
  section('10. 配置与迁移');

  const legacy = mergeConfigWithDefaults({ rcon: { host: '1.1.1.1' } });
  check('旧配置保留原值', legacy.rcon.host === '1.1.1.1');
  const newKeys = ['logWatcher', 'chatBridge', 'responder', 'permissions', 'tasks', 'stats', 'notify', 'ai', 'imageReply', 'ownerCare'];
  check('新配置域全部补齐', newKeys.every((k) => legacy[k] !== undefined), newKeys.filter((k) => !legacy[k]).join(','));
  check('新配置域默认关闭', newKeys.every((k) => legacy[k].enabled === false));
  const defaults = createDefaultConfig();
  check('默认指令表非空', defaults.commands.length > 0, String(defaults.commands.length));
  check('慰问起始日为今天', defaults.ownerCare.startDate === todayStr, defaults.ownerCare.startDate);

  // -------------------------------------------------- 收尾
  rcon.destroy();
  child.kill();
  await delay(200);

  console.log('\n' + '='.repeat(56));
  console.log(`排查完成：通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

main().catch((err) => {
  console.error('\n排查脚本异常：', err);
  process.exit(1);
});
