/**
 * 用 CDP 启动 Electron 并截图，用于验证 UI 改动。
 *
 * 用法: node scripts/ui-screenshot.cjs <输出png> [等待毫秒]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('D:/work/2026-10-12-13-01-56/node_modules/ws');

const out = process.argv[2] || path.join(process.cwd(), '.stage/ui-shot.png');
const waitMs = Number(process.argv[3] || 7000);
const PORT = 9333;
const ROOT = 'D:/work/2026-10-12-13-01-56';

const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

// 关键：必须清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会退化成纯 Node
// 运行（报 "Cannot read properties of undefined (reading 'whenReady')"），
// 窗口根本不会出现。run.cmd 里也有同样的处理。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (d) => (logs += d.toString()));
child.stderr.on('data', (d) => (logs += d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('未找到可调试的页面目标\n' + logs.slice(-2000));
}

async function main() {
  const target = await getTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl, {
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
  });

  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  await new Promise((r) => ws.on('open', r));
  await send('Page.enable');
  await sleep(waitMs);

  // 顺便把顶栏品牌区的渲染信息取回来，确认背景图加载成功
  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('.brand-mark');
      if (!el) return 'no .brand-mark';
      const cs = getComputedStyle(el);
      return JSON.stringify({
        w: el.offsetWidth, h: el.offsetHeight,
        bg: cs.backgroundImage,
        radius: cs.borderRadius,
      });
    })()`,
    returnByValue: true,
  });
  console.log('brand-mark 探测:', probe.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('截图已保存:', out, fs.statSync(out).size, 'bytes');

  ws.close();
  child.kill();
  await sleep(600);
  process.exit(0);
}

main().catch((e) => {
  console.error('失败:', e.message);
  try { child.kill(); } catch (_) {}
  process.exit(1);
});
