/**
 * SnowLuma 启动器测试：
 *  - 日志行解析（凭据 / 监听地址）—— 这是「拿到后台密码」的关键路径
 *  - 程序目录解析（内置 / 自定义 / 缺失）
 *  - snowluma 配置的默认值与老配置升级补齐
 *
 * 运行：node scripts/tests/test-snowluma.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { SnowLumaManager, parseSnowLumaLine, probeWeb } = require('../../dist/main/snowluma.js');
const { Store } = require('../../dist/main/store.js');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gelibot-snowluma-'));

// ---------------------------------------------------------------- 日志解析
section('日志行解析');

// 下面两行是从真实 SnowLuma v1.14.22 启动日志里原样抄下来的
{
  const credLine =
    '12:57:15 INFO               [WebUI] initial credentials: user=admin password=da70a69fa18246f1';
  const r = parseSnowLumaLine(credLine);
  check('能解析出凭据行', r && r.cred !== undefined);
  check('账号为 admin', r && r.cred.user === 'admin', r && r.cred.user);
  check(
    '密码正确',
    r && r.cred.password === 'da70a69fa18246f1',
    r && r.cred.password,
  );
}

{
  const listenLine = '12:57:15 INFO               [WebUI] listening http://127.0.0.1:5099';
  const r = parseSnowLumaLine(listenLine);
  check('能解析出监听行', r && r.url !== undefined);
  check('地址正确', r && r.url === 'http://127.0.0.1:5099', r && r.url);
}

{
  // 真实日志里带尾斜杠/带路径的情况要能规整掉，否则「打开后台」会拼出双斜杠
  const r = parseSnowLumaLine('[WebUI] listening http://127.0.0.1:5099///');
  check('尾斜杠被去掉', r && r.url === 'http://127.0.0.1:5099', r && r.url);
}

{
  const r = parseSnowLumaLine('[WebUI] listening https://box.local:8443/panel/');
  check('https 地址可识别', r && r.url === 'https://box.local:8443/panel', r && r.url);
}

{
  check('普通日志行返回 null', parseSnowLumaLine('[App] SnowLuma starting') === null);
  check('空字符串返回 null', parseSnowLumaLine('') === null);
  check(
    '凭据行大小写不敏感',
    parseSnowLumaLine('[WebUI] Initial Credentials: user=root password=abc123') !== null,
  );
  check(
    '凭据行容忍多余空格',
    (() => {
      const r = parseSnowLumaLine('[WebUI] initial credentials:  user=admin   password=xyz');
      return r && r.cred.password === 'xyz';
    })(),
  );
  // 只有监听但没有协议头的行不该被误判
  check('无协议头的行不误判', parseSnowLumaLine('[WebUI] listening on port 5099') === null);
}

// ---------------------------------------------------------------- 目录解析
section('程序目录解析');

/** 造一个「合格的」SnowLuma 目录 */
function makeDir(name, { indexMjs = true, nodeExe = true } = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  if (indexMjs) fs.writeFileSync(path.join(dir, 'index.mjs'), '// stub');
  if (nodeExe) fs.writeFileSync(path.join(dir, 'node.exe'), 'stub');
  return dir;
}

function makeManager(opts) {
  return new SnowLumaManager({
    customDir: '',
    bundledDir: null,
    dataDir: path.join(tmp, 'data'),
    fallbackWebUrl: 'http://127.0.0.1:5099',
    ...opts,
  });
}

{
  const m = makeManager({});
  const s = m.getStatus();
  check('既无内置也无自定义 → dirSource=missing', s.dirSource === 'missing', s.dirSource);
  check('初始状态为 stopped', s.state === 'stopped', s.state);
  check('给出可操作的错误提示', /指定/.test(s.lastError ?? ''), s.lastError);
  check('未运行时 listening 为 false', s.listening === false);
  check('回退 WebUI 地址生效', s.webUrl === 'http://127.0.0.1:5099', s.webUrl);
  check('数据目录透传', s.dataDir === path.join(tmp, 'data'), s.dataDir);
}

{
  const good = makeDir('bundled-ok');
  const m = makeManager({ bundledDir: good });
  const s = m.getStatus();
  check('内置目录完整 → dirSource=bundled', s.dirSource === 'bundled', s.dirSource);
  check('resolvedDir 指向内置目录', s.resolvedDir === good, s.resolvedDir);
  check('无错误', s.lastError === undefined, s.lastError);
}

{
  const noNode = makeDir('bundled-nonode', { nodeExe: false });
  const m = makeManager({ bundledDir: noNode });
  const s = m.getStatus();
  check('内置缺 node.exe → missing', s.dirSource === 'missing', s.dirSource);
  check('错误提到 node.exe', /node\.exe/.test(s.lastError ?? ''), s.lastError);
}

{
  const noIndex = makeDir('bundled-noindex', { indexMjs: false });
  const m = makeManager({ bundledDir: noIndex });
  const s = m.getStatus();
  check('内置缺 index.mjs → missing', s.dirSource === 'missing', s.dirSource);
  check('错误提到 index.mjs', /index\.mjs/.test(s.lastError ?? ''), s.lastError);
}

{
  const custom = makeDir('custom-ok');
  const bundled = makeDir('bundled-also-ok');
  const m = makeManager({ customDir: custom, bundledDir: bundled });
  const s = m.getStatus();
  check('自定义优先于内置', s.resolvedDir === custom, s.resolvedDir);
  check('来源标记为 custom', s.dirSource === 'custom', s.dirSource);
}

{
  // 关键行为：自定义目录填错了要明确报错，而不是悄悄退回内置版，
  // 否则用户会以为自己在用外部版本，实际跑的是内置版
  const bundled = makeDir('bundled-fallback');
  const m = makeManager({
    customDir: path.join(tmp, 'not-exist-at-all'),
    bundledDir: bundled,
  });
  const s = m.getStatus();
  check('自定义无效时不回退到内置', s.resolvedDir === undefined, s.resolvedDir);
  check('来源仍标记为 custom', s.dirSource === 'custom', s.dirSource);
  check('错误提示是「不可用」', /不可用/.test(s.lastError ?? ''), s.lastError);
  check('错误原因包含「目录不存在」', /不存在/.test(s.lastError ?? ''), s.lastError);
}

{
  // 目录存在但根本不是 SnowLuma（比如用户选了个空目录）
  const empty = path.join(tmp, 'empty-dir');
  fs.mkdirSync(empty, { recursive: true });
  const m = makeManager({ customDir: empty });
  const s = m.getStatus();
  check('空目录被判为不可用', s.resolvedDir === undefined, s.resolvedDir);
  check('错误提到 index.mjs', /index\.mjs/.test(s.lastError ?? ''), s.lastError);
}

{
  // 传的是文件而不是目录
  const file = path.join(tmp, 'a-file.txt');
  fs.writeFileSync(file, 'x');
  const m = makeManager({ customDir: file });
  check('传入文件时提示「不是目录」', /不是目录/.test(m.getStatus().lastError ?? ''));
}

{
  const good = makeDir('refresh-ok');
  const m = makeManager({ bundledDir: good });
  m.refresh();
  check('refresh 后状态仍正确', m.getStatus().dirSource === 'bundled');
  m.updateOptions({ customDir: good });
  check('updateOptions 后切到 custom', m.getStatus().dirSource === 'custom');
}

{
  const m = makeManager({});
  check('未运行时 isRunning 为 false', m.isRunning() === false);
  check('日志初始为空', m.getLog().length === 0);
}

// ---------------------------------------------------------------- 端口探测
async function probeSection() {
  section('端口探测（防止重复启动撞车）');

  // 空闲端口应当探测为 false
  {
    const free = await probeWeb('http://127.0.0.1:59873', 800);
    check('空闲端口 → false', free === false);
  }

  // 非法地址不应抛异常
  {
    const bad = await probeWeb('not-a-url', 500);
    check('非法地址 → false（不抛异常）', bad === false);
  }

  // 起一个真实的 http 服务，应当探测为 true
  await new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    server.listen(59874, '127.0.0.1', async () => {
      const up = await probeWeb('http://127.0.0.1:59874', 1500);
      check('有服务监听 → true', up === true);
      // 返回 401 也算「活着」，否则会误判成没人监听
      server.close();
      const down = await probeWeb('http://127.0.0.1:59874', 800);
      check('服务关闭后 → false', down === false);
      resolve();
    });
  });

  await new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401);
      res.end('unauthorized');
    });
    server.listen(59875, '127.0.0.1', async () => {
      const up = await probeWeb('http://127.0.0.1:59875', 1500);
      check('返回 401 也视为已运行', up === true);
      server.close();
      resolve();
    });
  });
}

// ---------------------------------------------------------------- 配置
function configSection() {
  section('snowluma 配置默认值与升级');

  {
    const dir = path.join(tmp, 'cfg-fresh');
    const store = new Store(dir);
    const c = store.getConfig();
    check('新装含 snowluma 段', typeof c.snowluma === 'object' && c.snowluma !== null);
    check('默认 dir 为空（用内置版）', c.snowluma.dir === '', JSON.stringify(c.snowluma.dir));
    check('默认后台地址为 5099', c.snowluma.webUrl === 'http://127.0.0.1:5099', c.snowluma.webUrl);
    check('默认自动打开后台', c.snowluma.autoOpen === true);
    check('默认随程序退出而停止', c.snowluma.stopWithApp === true);
    check('snowluma 已落盘', fs.existsSync(path.join(dir, 'config.json')));
  }

  {
    // 老配置（v1.14.x）完全没有 snowluma 段，应自动补齐
    const dir = path.join(tmp, 'cfg-legacy-nosection');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        rcon: { host: '10.0.0.5', port: 25575, password: 'pw', timeoutMs: 8000, reconnectIntervalMs: 0 },
        onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', autoReconnect: true, reconnectIntervalMs: 5000 },
        serverId: 'main',
        rateLimitMs: 900,
      }),
    );
    const c = new Store(dir).getConfig();
    check('补齐 snowluma 段', typeof c.snowluma === 'object' && c.snowluma !== null);
    check('补齐 dir 为空', c.snowluma.dir === '');
    check('补齐 autoOpen', c.snowluma.autoOpen === true);
    check('补齐 stopWithApp', c.snowluma.stopWithApp === true);
    check('补齐 webUrl', c.snowluma.webUrl === 'http://127.0.0.1:5099');
    check('保留用户 rcon host', c.rcon.host === '10.0.0.5', c.rcon.host);
    check('保留用户 rateLimitMs', c.rateLimitMs === 900, `${c.rateLimitMs}`);
  }

  {
    // 部分字段缺失：已有的要保留，缺的要补
    const dir = path.join(tmp, 'cfg-legacy-partial');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ snowluma: { dir: 'D:/my-snowluma', autoOpen: false } }),
    );
    const c = new Store(dir).getConfig();
    check('保留自定义 dir', c.snowluma.dir === 'D:/my-snowluma', c.snowluma.dir);
    check('保留 autoOpen=false', c.snowluma.autoOpen === false);
    check('补齐缺失的 stopWithApp', c.snowluma.stopWithApp === true);
    check('补齐缺失的 webUrl', c.snowluma.webUrl === 'http://127.0.0.1:5099');
  }

  {
    // 持久化往返
    const dir = path.join(tmp, 'cfg-roundtrip');
    const store = new Store(dir);
    const c = store.getConfig();
    c.snowluma.dir = 'E:/snowluma';
    c.snowluma.webUrl = 'http://127.0.0.1:6000';
    c.snowluma.autoOpen = false;
    c.snowluma.stopWithApp = false;
    store.saveConfig(c);
    const back = new Store(dir).getConfig();
    check('dir 往返一致', back.snowluma.dir === 'E:/snowluma', back.snowluma.dir);
    check('webUrl 往返一致', back.snowluma.webUrl === 'http://127.0.0.1:6000', back.snowluma.webUrl);
    check('autoOpen 往返一致', back.snowluma.autoOpen === false);
    check('stopWithApp 往返一致', back.snowluma.stopWithApp === false);
  }
}

(async () => {
  await probeSection();
  configSection();

  console.log('\n' + '='.repeat(48));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('='.repeat(48));
  process.exit(fail === 0 ? 0 : 1);
})();

