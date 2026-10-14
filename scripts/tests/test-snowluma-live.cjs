/**
 * SnowLuma 启动器「真机」端到端测试（可选，不在 npm test 里）。
 *
 * 会真的把内置的 SnowLuma 拉起来（监听 127.0.0.1:5099），验证：
 *  - 能 spawn 起来并拿到 PID
 *  - 能从日志里抓出首次启动的后台账号密码
 *  - 能解析出监听地址并把状态切到 running
 *  - config/ 与 logs/ 确实落在指定的数据目录（而不是程序目录）
 *  - 能干净地停掉，不留残留进程
 *
 * 需要项目根目录下存在 snowluma/（约 97 MB）。
 * 运行：node scripts/tests/test-snowluma-live.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SnowLumaManager } = require('../../dist/main/snowluma.js');

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

const root = path.resolve(__dirname, '../..');
const snowlumaDir = path.join(root, 'snowluma');

if (!fs.existsSync(path.join(snowlumaDir, 'index.mjs'))) {
  console.log(`\n[跳过] 未找到内置 SnowLuma：${snowlumaDir}`);
  console.log('（这是可选测试，缺少运行包时跳过，不算失败）');
  process.exit(0);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gelibot-sl-live-'));

const manager = new SnowLumaManager({
  customDir: '',
  bundledDir: snowlumaDir,
  dataDir,
  fallbackWebUrl: 'http://127.0.0.1:5099',
});

const seen = { webReady: 0, webUrls: [] };
manager.on('web-ready', (url) => {
  seen.webReady++;
  seen.webUrls.push(url);
});

/** 轮询等待某个条件成立 */
function waitFor(fn, timeoutMs, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (fn()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        console.log(`  … 等待「${label}」超时（${timeoutMs}ms）`);
        resolve(false);
      }
    }, 250);
  });
}

(async () => {
  try {
    section('启动前的状态');
    {
      const s = manager.getStatus();
      check('识别为内置版本', s.dirSource === 'bundled', s.dirSource);
      check('resolvedDir 指向项目内 snowluma/', s.resolvedDir === snowlumaDir, s.resolvedDir);
      check('初始未运行', manager.isRunning() === false);
    }

    section('启动');
    {
      const res = await manager.start();
      check('start() 返回成功', res.ok === true, res.error);
      const s = manager.getStatus();
      check('拿到 PID', typeof s.pid === 'number' && s.pid > 0, `${s.pid}`);
      check('进程真的活着', manager.isRunning() === true);
      check('状态进入 starting', s.state === 'starting', s.state);
    }

    section('等待 WebUI 监听');
    {
      const ok = await waitFor(
        () => manager.getStatus().state === 'running',
        60000,
        'WebUI 监听',
      );
      check('状态切到 running', ok === true, manager.getStatus().state);

      const s = manager.getStatus();
      check('listening 标记为 true', s.listening === true);
      check(
        '解析出监听地址',
        /^http:\/\/127\.0\.0\.1:\d+$/.test(s.webUrl),
        s.webUrl,
      );
      check('触发了一次 web-ready 事件', seen.webReady === 1, `${seen.webReady}`);
      check('web-ready 带上了地址', seen.webUrls[0] === s.webUrl, seen.webUrls.join());
    }

    section('首次启动凭据');
    {
      const s = manager.getStatus();
      check('抓到后台账号', s.adminUser === 'admin', s.adminUser);
      check(
        '抓到后台临时密码',
        typeof s.password === 'string' && s.password.length >= 8,
        s.password,
      );
    }

    section('数据目录');
    {
      check(
        'config/runtime.json 落在数据目录',
        fs.existsSync(path.join(dataDir, 'config', 'runtime.json')),
      );
      check(
        'config/webui.json 落在数据目录',
        fs.existsSync(path.join(dataDir, 'config', 'webui.json')),
      );
      check('logs/ 落在数据目录', fs.existsSync(path.join(dataDir, 'logs')));
      check(
        '程序目录没有被写脏（没有 config/）',
        !fs.existsSync(path.join(snowlumaDir, 'config')),
      );
    }

    section('日志缓冲');
    {
      const log = manager.getLog();
      check('日志非空', log.length > 0, `${log.length} 行`);
      check(
        '日志里含启动横幅',
        log.some((l) => l.includes('SnowLuma starting')),
      );
      check(
        '日志里含管理器自身的前缀行',
        log.some((l) => l.startsWith('[管理器]')),
      );
    }

    section('停止');
    {
      const res = await manager.stop();
      check('stop() 返回成功', res.ok === true, res.error);
      check('进程已退出', manager.isRunning() === false);
      const s = manager.getStatus();
      check('状态回到 stopped', s.state === 'stopped', s.state);
      check('listening 复位', s.listening === false);
      check('PID 已清空', s.pid === undefined, `${s.pid}`);
      check('正常停止不报错', s.lastError === undefined, s.lastError);
    }
  } catch (err) {
    fail++;
    console.log(`\n  ✘ 未捕获异常：${err && err.stack ? err.stack : err}`);
  } finally {
    // 无论成败都要保证不留 SnowLuma 进程
    if (manager.isRunning()) {
      console.log('\n[清理] 收尾停止 SnowLuma…');
      await manager.stop();
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉无所谓 */
    }
  }

  console.log('\n' + '='.repeat(48));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('='.repeat(48));
  process.exit(fail === 0 ? 0 : 1);
})();
