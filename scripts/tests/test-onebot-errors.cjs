/**
 * OneBot 连接错误翻译测试。
 *
 * 起因：真实环境里服务端设了 accessToken 而本程序留空，握手返回 401，
 * 但界面只显示 `Unexpected server response: 401`，完全看不出该去填 Token。
 * 这组测试锁定「把原始错误翻成可照做的中文」这一行为。
 *
 * 运行：node scripts/tests/test-onebot-errors.cjs
 */
const { OneBotClient } = require('../../dist/main/onebot.js');

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
function section(t) {
  console.log(`\n=== ${t} ===`);
}

/** explainError 是私有方法，这里直接取原型上的实现来测 */
const proto = OneBotClient.prototype;
const explain = proto.explainError;

function makeClient(accessToken) {
  const c = new OneBotClient({
    wsUrl: 'ws://127.0.0.1:3001',
    accessToken,
    autoReconnect: true,
    reconnectIntervalMs: 5000,
  });
  return c;
}

function translate(err, token) {
  const client = makeClient(token);
  return explain.call(client, err);
}

section('401：最关键的场景');
{
  const e = new Error('Unexpected server response: 401');
  const noToken = translate(e, '');
  check('未填 Token 时点明「留空」', /留空/.test(noToken), noToken);
  check('提到 SnowLuma 后台', /SnowLuma 后台/.test(noToken), noToken);
  check('给出下一步动作', /复制|填到/.test(noToken), noToken);

  const withToken = translate(e, 'some-token-here');
  check('已填 Token 时改为提示「不一致」', /不一致/.test(withToken), withToken);
  check('已填 Token 时不误报「留空」', !/留空/.test(withToken), withToken);
  check('两种场景文案不同', noToken !== withToken);
}

section('403 与 401 同路');
{
  const t = translate(new Error('Unexpected server response: 403'), '');
  check('403 也走认证分支', /认证被拒/.test(t), t);
}

section('撞到 WebUI 端口（404 / 426）');
{
  const t404 = translate(new Error('Unexpected server response: 404'), '');
  check('404 提示端口填错', /端口/.test(t404) && /WS/.test(t404), t404);

  const t426 = translate(new Error('Unexpected server response: 426'), '');
  check('426 提示不是 WS 端点', /WS 端点|端口/.test(t426), t426);
  check('426 提醒别填 WebUI 端口', /WebUI/.test(t426), t426);
}

section('其他 HTTP 状态码兜底');
{
  const t = translate(new Error('Unexpected server response: 500'), '');
  check('500 落到通用握手失败', /握手被拒/.test(t), t);
  check('保留了原始状态码', /500/.test(t), t);
}

section('网络类错误');
{
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3001'), {
    code: 'ECONNREFUSED',
  });
  const t1 = translate(refused, '');
  check('ECONNREFUSED 提示没有服务在监听', /没有服务在监听/.test(t1), t1);
  check('ECONNREFUSED 提醒先启动 SnowLuma', /SnowLuma/.test(t1), t1);

  const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const t2 = translate(reset, '');
  check('ECONNRESET 提示连接被重置', /重置/.test(t2), t2);

  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), {
    code: 'ENOTFOUND',
  });
  const t3 = translate(dns, '');
  check('ENOTFOUND 提示域名解析失败', /解析失败/.test(t3), t3);

  const timeout = new Error('WebSocket was closed due to timeout');
  const t4 = translate(timeout, '');
  check('超时提示连接超时', /超时/.test(t4), t4);
}

section('兜底与健壮性');
{
  const t = translate(new Error('某种没见过的错误'), '');
  check('未知错误原样透出', t === '某种没见过的错误', t);

  const empty = new Error('');
  const t2 = translate(empty, '');
  check('空消息有兜底文案', t2.length > 0 && /未知原因/.test(t2), t2);

  // 不应抛异常
  let threw = false;
  try {
    translate({}, '');
  } catch {
    threw = true;
  }
  check('传入畸形对象不抛异常', !threw);

  // 所有输出都应是非空字符串
  const samples = [
    new Error('Unexpected server response: 401'),
    new Error('Unexpected server response: 426'),
    new Error('connect ECONNREFUSED'),
    new Error('random'),
  ];
  const allStrings = samples.every((e) => {
    const r = translate(e, '');
    return typeof r === 'string' && r.length > 0;
  });
  check('所有路径都返回非空字符串', allStrings);
}

section('URL 构造：Token 走 query 参数');
{
  const withToken = makeClient('abc123');
  const url = proto.buildUrl.call(withToken);
  check('带 Token 时拼到 access_token', /access_token=abc123/.test(url), url);

  const noToken = makeClient('');
  const url2 = proto.buildUrl.call(noToken);
  check('无 Token 时保持原样', url2 === 'ws://127.0.0.1:3001', url2);

  const emptyUrl = makeClient('x');
  emptyUrl.updateConfig({ wsUrl: '   ', accessToken: 'x', autoReconnect: false, reconnectIntervalMs: 0 });
  const url3 = proto.buildUrl.call(emptyUrl);
  check('地址为空白时返回空串', url3 === '', JSON.stringify(url3));

  // 带特殊字符的 Token 要被正确编码
  const special = makeClient('a+b/c=d&e');
  const url4 = proto.buildUrl.call(special);
  check('特殊字符被 URL 编码', !/a\+b\/c=d&e/.test(url4) && /access_token=/.test(url4), url4);
  const parsed = new URL(url4);
  check('解码后与原 Token 一致', parsed.searchParams.get('access_token') === 'a+b/c=d&e', url4);
}

console.log('\n' + '='.repeat(48));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(48));
process.exit(fail === 0 ? 0 : 1);
