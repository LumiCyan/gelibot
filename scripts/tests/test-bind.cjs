/**
 * 绑定逻辑冒烟测试（EasyBot 式双模式）。
 *
 * 不依赖 Electron：直接用 ts 编译产物里的 BindCodeManager / BindingManager，
 * 配一个内存版 Store 替身。
 *
 * 运行：node _test-bind.cjs
 */
const { BindCodeManager, formatDuration } = require('../../dist/main/bindcode.js');
const { BindingManager, PLAYER_ID_RE, renderTemplate } = require('../../dist/main/binding.js');
const { createDefaultBindingConfig } = require('../../dist/shared/defaults.js');

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    console.log(`  ✘ ${name}${extra ? `  → ${extra}` : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/** 内存版 Store 替身 */
function makeStore() {
  let bindings = [];
  return {
    listBindings: () => [...bindings],
    getBindingsOf: (qq) => bindings.filter((b) => b.qq === qq),
    countBindingsOf: (qq) => bindings.filter((b) => b.qq === qq).length,
    hasBinding: (qq, pid) =>
      bindings.some((b) => b.qq === qq && b.playerId.toLowerCase() === pid.toLowerCase()),
    isPlayerTaken: (pid) =>
      bindings.find((b) => b.playerId.toLowerCase() === pid.toLowerCase()),
    addBinding: (b) => bindings.push(b),
    removeBinding: (qq, pid) => {
      const before = bindings.length;
      bindings = bindings.filter(
        (b) => !(b.qq === qq && b.playerId.toLowerCase() === pid.toLowerCase()),
      );
      return bindings.length !== before;
    },
    removeBindingsOf: (qq) => {
      const before = bindings.length;
      bindings = bindings.filter((b) => b.qq !== qq);
      return before - bindings.length;
    },
    _raw: () => bindings,
  };
}

function setup(overrides = {}) {
  const store = makeStore();
  const codes = new BindCodeManager();
  const cfg = { ...createDefaultBindingConfig(), ...overrides };
  const mgr = new BindingManager(store, cfg, codes, 'main');
  return { store, codes, mgr, cfg };
}

// ---------------------------------------------------------------------------
section('验证码生成与格式');

{
  const codes = new BindCodeManager();

  const num = codes.issue({ length: 6, format: 'number', ttlSeconds: 300, playerId: 'Steve' });
  check('数字验证码为 6 位', num.code.length === 6, num.code);
  check('数字验证码仅含数字', /^\d{6}$/.test(num.code), num.code);

  const letter = codes.issue({ length: 5, format: 'letter', ttlSeconds: 300, playerId: 'Alex' });
  check('字母验证码为 5 位', letter.code.length === 5, letter.code);
  check('字母验证码仅含大写字母', /^[A-Z]{5}$/.test(letter.code), letter.code);

  const mixed = codes.issue({ length: 8, format: 'mixed', ttlSeconds: 300, playerId: 'Herobrine' });
  check('混合验证码为 8 位', mixed.code.length === 8, mixed.code);
  check('混合验证码不含易混淆字符 I/L/O',
    !/[ILO01]/.test(mixed.code), mixed.code);
}

{
  const codes = new BindCodeManager();
  // 100 次生成，验证无重复
  const seen = new Set();
  let dup = 0;
  for (let i = 0; i < 100; i++) {
    const r = codes.issue({ length: 6, format: 'number', ttlSeconds: 300, playerId: `P${i}` });
    if (seen.has(r.code)) dup++;
    seen.add(r.code);
  }
  check('100 次签发无重复验证码', dup === 0, `重复 ${dup} 次`);
}

// ---------------------------------------------------------------------------
section('同一玩家重复取码 → 旧码作废');

{
  const codes = new BindCodeManager();
  const a = codes.issue({ length: 6, format: 'number', ttlSeconds: 300, playerId: 'Steve' });
  const b = codes.issue({ length: 6, format: 'number', ttlSeconds: 300, playerId: 'Steve' });

  check('两次取码得到不同验证码', a.code !== b.code);
  check('旧码已被移除', codes.find(a.code) === undefined);
  check('新码有效', codes.find(b.code) !== undefined);
  check('该玩家当前只有一个待验证码', codes.list().length === 1, `实际 ${codes.list().length}`);
}

// ---------------------------------------------------------------------------
section('验证码过期');

{
  const codes = new BindCodeManager();
  const r = codes.issue({ length: 6, format: 'number', ttlSeconds: 30, playerId: 'Steve' });
  check('新码剩余时间为正', codes.remainingSeconds(r) > 0, `${codes.remainingSeconds(r)}s`);

  // 直接改 expiresAt 模拟过期
  r.expiresAt = new Date(Date.now() - 1000).toISOString();
  const consumed = codes.consume(r.code);
  check('过期码消费失败', consumed.ok === false, JSON.stringify(consumed));
  check('过期码给出明确原因', /失效|过期/.test(consumed.reason ?? ''), consumed.reason);
  check('过期码被自动清理', codes.list().length === 0);
}

check('formatDuration 渲染分钟', formatDuration(300) === '5 分钟', formatDuration(300));
check('formatDuration 渲染分秒', formatDuration(150) === '2 分 30 秒', formatDuration(150));
check('formatDuration 渲染纯秒', formatDuration(45) === '45 秒', formatDuration(45));
check('formatDuration 处理过期', formatDuration(0) === '已过期', formatDuration(0));

// ---------------------------------------------------------------------------
section('双向验证模式 — bindByCode');

{
  const { mgr, codes } = setup({ mode: 'code' });
  const issued = mgr.issueCodeFor('Steve', { groupId: '123456' });
  check('服务器内取码成功', issued.ok === true);
  const code = issued.record.code;

  const res = mgr.bindByCode('10001', code, { fromGroup: '123456' });
  check('群内用验证码绑定成功', res.ok === true, res.message);
  check('成功消息含玩家名', res.message.includes('Steve'), res.message);
  check('绑定已落库', mgr.list().length === 1);
  check('绑定记录了来源群', mgr.list()[0].fromGroup === '123456');
}

{
  const { mgr, codes } = setup({ mode: 'code' });
  const issued = mgr.issueCodeFor('Steve', { groupId: '123456' });
  mgr.bindByCode('10001', issued.record.code, { fromGroup: '123456' });

  // 同一个码再用一次
  const again = mgr.bindByCode('10002', issued.record.code, { fromGroup: '123456' });
  check('验证码一次性，二次使用失败', again.ok === false, again.message);
  check('二次使用后绑定数仍为 1', mgr.list().length === 1, `${mgr.list().length}`);
}

{
  const { mgr } = setup({ mode: 'code' });
  const res = mgr.bindByCode('10001', '000000', { fromGroup: '123456' });
  check('不存在的验证码被拒绝', res.ok === false);
  check('给出明确原因', /失效|过期|无效/.test(res.message), res.message);
}

{
  const { mgr } = setup({ mode: 'code' });
  const issued = mgr.issueCodeFor('Steve', { groupId: '123456' });
  const res = mgr.bindByCode('10001', issued.record.code, { fromGroup: '999999' });
  check('跨群使用验证码被拒绝', res.ok === false, res.message);
  check('明确提示需回原群', /原群|发起/.test(res.message), res.message);
}

{
  const { mgr } = setup({ mode: 'code', maxBindingsPerQQ: 1 });
  const i1 = mgr.issueCodeFor('Steve');
  mgr.bindByCode('10001', i1.record.code);
  const i2 = mgr.issueCodeFor('Alex');
  const res = mgr.bindByCode('10001', i2.record.code);
  check('超出绑定上限被拒绝', res.ok === false, res.message);
  check('提示已达上限', /上限/.test(res.message), res.message);
  check('失败后验证码已作废（需重新取码）', /重新获取/.test(res.message), res.message);
}

{
  const { mgr } = setup({ mode: 'code', maxBindingsPerQQ: 3 });
  const i1 = mgr.issueCodeFor('Steve');
  mgr.bindByCode('10001', i1.record.code);
  check('上限 3 时第 1 个绑定成功', mgr.countOf('10001') === 1);

  const i2 = mgr.issueCodeFor('Alex');
  mgr.bindByCode('10001', i2.record.code);
  const i3 = mgr.issueCodeFor('Notch');
  mgr.bindByCode('10001', i3.record.code);
  check('上限 3 时已绑 3 个', mgr.countOf('10001') === 3, `${mgr.countOf('10001')}`);

  const i4 = mgr.issueCodeFor('Herobrine');
  const res = mgr.bindByCode('10001', i4.record.code);
  check('第 4 个被上限拦截', res.ok === false, res.message);
}

// ---------------------------------------------------------------------------
section('玩家 ID 唯一性（防冒用）');

{
  const { mgr } = setup({ mode: 'code', maxBindingsPerQQ: 5 });
  const i1 = mgr.issueCodeFor('Steve');
  mgr.bindByCode('10001', i1.record.code);

  const i2 = mgr.issueCodeFor('Steve'); // 另一个 QQ 拿 Steve 的码
  const res = mgr.bindByCode('10002', i2.record.code);
  check('他人已绑定的玩家 ID 被拒绝', res.ok === false, res.message);
  check('明确提示已被其他 QQ 绑定', /其他 QQ/.test(res.message), res.message);
}

// ---------------------------------------------------------------------------
section('信任模式 — bindByPlayerId');

{
  const { mgr } = setup({ mode: 'trust' });
  const res = mgr.bindByPlayerId('10001', 'Steve', { fromGroup: '123456' });
  check('信任模式直接绑定成功', res.ok === true, res.message);
  check('绑定已落库', mgr.list().length === 1);
}

{
  const { mgr } = setup({ mode: 'trust' });
  const res = mgr.bindByPlayerId('10001', 'ab'); // 太短
  check('非法玩家 ID 被拒绝', res.ok === false, res.message);
  check('提示 ID 不合法', /不合法/.test(res.message), res.message);
}

{
  const { mgr } = setup({ mode: 'trust' });
  const bads = ['../../etc', 'Steve;stop', 'rm -rf', 'a'.repeat(17), '中文名字', 'a b'];
  let rejected = 0;
  for (const bad of bads) {
    const r = mgr.bindByPlayerId('10001', bad);
    if (!r.ok) rejected++;
  }
  check('6 个注入/非法 ID 全部被拒绝', rejected === 6, `拒绝 ${rejected}/6`);
  check('无任何绑定写入', mgr.list().length === 0, `${mgr.list().length} 条`);
}

{
  const { mgr } = setup({ mode: 'trust', allowSelfBind: false });
  const res = mgr.bindByPlayerId('10001', 'Steve');
  check('关闭自助绑定后拒绝', res.ok === false, res.message);
  check('提示已被关闭', /关闭/.test(res.message), res.message);
}

// ---------------------------------------------------------------------------
section('解绑');

{
  const { mgr } = setup({ mode: 'trust', maxBindingsPerQQ: 5 });
  mgr.bindByPlayerId('10001', 'Steve');
  mgr.bindByPlayerId('10001', 'Alex');

  const res = mgr.remove('10001', 'Steve');
  check('指定解绑成功', res.ok === true, res.message);
  check('解绑后剩余 1 条', mgr.countOf('10001') === 1, `${mgr.countOf('10001')}`);

  const res2 = mgr.remove('10001', 'Steve');
  check('重复解绑失败', res2.ok === false, res2.message);
}

{
  const { mgr } = setup({ mode: 'trust' });
  mgr.bindByPlayerId('10001', 'Steve');
  const res = mgr.remove('10001', ''); // 只有一个绑定时可省略
  check('唯一绑定时省略 ID 也能解绑', res.ok === true, res.message);
  check('解绑后为 0 条', mgr.countOf('10001') === 0);
}

{
  const { mgr } = setup({ mode: 'trust', maxBindingsPerQQ: 5 });
  mgr.bindByPlayerId('10001', 'Steve');
  mgr.bindByPlayerId('10001', 'Alex');
  const res = mgr.remove('10001', '');
  check('多个绑定时省略 ID 被拒绝', res.ok === false, res.message);
  check('提示需指定哪个 ID', /指定/.test(res.message), res.message);
}

{
  const { mgr } = setup({ mode: 'trust', allowSelfUnbind: false });
  mgr.bindByPlayerId('10001', 'Steve');
  const res = mgr.remove('10001', 'Steve');
  check('关闭自助解绑后拒绝', res.ok === false, res.message);
  const admin = mgr.remove('10001', 'Steve', { asAdmin: true });
  check('管理员解绑不受开关限制', admin.ok === true, admin.message);
}

// ---------------------------------------------------------------------------
section('退群自动解绑');

{
  const { mgr } = setup({ mode: 'trust', maxBindingsPerQQ: 5 });
  mgr.bindByPlayerId('10001', 'Steve');
  mgr.bindByPlayerId('10001', 'Alex');
  mgr.bindByPlayerId('10002', 'Notch');

  const removed = mgr.removeAllOf('10001');
  check('返回被解绑的玩家列表', removed.length === 2, JSON.stringify(removed));
  check('该 QQ 绑定已清空', mgr.countOf('10001') === 0);
  check('其他 QQ 不受影响', mgr.countOf('10002') === 1, `${mgr.countOf('10002')}`);
}

// ---------------------------------------------------------------------------
section('强制绑定判定');

{
  const { mgr } = setup({ mode: 'trust' });
  check('默认未启用强制绑定', mgr.isForceBindActive() === false);

  mgr.updateConfig({
    ...mgr.getConfig(),
    forceBind: { enabled: true, servers: [] },
  });
  check('启用且列表为空 → 对所有服务器生效', mgr.isForceBindActive() === true);

  mgr.updateConfig({
    ...mgr.getConfig(),
    forceBind: { enabled: true, servers: ['survival'] },
  });
  check('列表不含当前服务器 → 不生效', mgr.isForceBindActive() === false);

  mgr.updateConfig({
    ...mgr.getConfig(),
    forceBind: { enabled: true, servers: ['main'] },
  });
  check('列表含当前服务器 → 生效', mgr.isForceBindActive() === true);
}

// ---------------------------------------------------------------------------
section('消息模板渲染');

{
  const out = renderTemplate(
    '[绑定成功] #player ↔ #qq（#current/#max）',
    { player: 'Steve', qq: '10001', current: 1, max: 3 },
  );
  check('模板占位符全部替换', out === '[绑定成功] Steve ↔ 10001（1/3）', out);
  check('未知占位符原样保留', renderTemplate('#unknown', {}) === '#unknown');
}

{
  const { mgr } = setup({ mode: 'trust' });
  mgr.bindByPlayerId('10001', 'Steve');
  const res = mgr.remove('10001', 'Steve');
  check('解绑消息含玩家名', res.message.includes('Steve'), res.message);
}

// ---------------------------------------------------------------------------
section('群名片文本');

{
  const { mgr } = setup({ mode: 'trust', maxBindingsPerQQ: 5, cardPrefix: '[玩家] ' });
  check('无绑定时名片文本为空', mgr.cardText('10001') === '');
  mgr.bindByPlayerId('10001', 'Steve');
  check('绑定后名片含前缀与 ID', mgr.cardText('10001') === '[玩家] Steve', mgr.cardText('10001'));
  mgr.bindByPlayerId('10001', 'Alex');
  check('多个 ID 用空格分隔', mgr.cardText('10001') === '[玩家] Steve Alex', mgr.cardText('10001'));
}

{
  const { mgr } = setup({ mode: 'trust', maxBindingsPerQQ: 20 });
  for (const n of ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD', 'EEEEEE', 'FFFFFF', 'GGGGGG']) {
    mgr.bindByPlayerId('10001', n);
  }
  const card = mgr.cardText('10001', 30);
  check('超长名片被截断到 30 字符', card.length === 30, `${card.length}: ${card}`);
}

// ---------------------------------------------------------------------------
section('管理员查询');

{
  const { mgr } = setup({ mode: 'trust', maxBindingsPerQQ: 5 });
  mgr.bindByPlayerId('10001', 'Steve');

  const byPlayer = mgr.query('Steve');
  check('按玩家 ID 反查到 QQ', byPlayer.includes('10001'), byPlayer);

  const byQq = mgr.query('10001');
  check('按 QQ 反查到玩家', byQq.includes('Steve'), byQq);

  const none = mgr.query('nobody');
  check('查不到时给出提示', /未找到/.test(none), none);
}

// ---------------------------------------------------------------------------
section('玩家 ID 正则（安全边界）');

{
  const valid = ['Steve', 'abc', 'a_b_c', 'A1B2C3', 'a'.repeat(16)];
  const invalid = ['ab', 'a'.repeat(17), 'a b', 'a-b', 'a.b', '', '中文', 'Steve;stop'];
  check('合法 ID 全部通过', valid.every((v) => PLAYER_ID_RE.test(v)));
  check('非法 ID 全部拒绝', invalid.every((v) => !PLAYER_ID_RE.test(v)));
}

// ---------------------------------------------------------------------------
section('自定义消息模板生效');

{
  const { mgr } = setup({ mode: 'trust' });
  mgr.updateConfig({
    ...mgr.getConfig(),
    messages: {
      ...mgr.getConfig().messages,
      bindSuccess: 'OK! #player',
      bindFail: 'NO! #why',
    },
  });
  const ok = mgr.bindByPlayerId('10001', 'Steve');
  check('自定义成功模板生效', ok.message === 'OK! Steve', ok.message);
  const bad = mgr.bindByPlayerId('10001', 'x');
  check('自定义失败模板生效', bad.message.startsWith('NO! '), bad.message);
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(48)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(48));
process.exit(fail === 0 ? 0 : 1);
