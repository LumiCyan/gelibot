/**
 * 界面切换动画的视觉验证。
 *
 * 用 Electron 真实加载渲染层（dist/renderer），注入一份假 bridge 喂固定数据，
 * 然后：
 *   1. 量侧边栏高亮块是否与当前项对齐
 *   2. 点导航，检查进场动画是否真的挂上、方向 class 是否正确
 *   3. 把动画暂停在 120ms 截一张中间帧，看是不是「依次浮起」而不是整块跳出来
 *
 * 跑法：npm run ui:shot
 * 产物：.stage/ui/*.png
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.stage', 'ui');
fs.mkdirSync(OUT, { recursive: true });

// 这台机器（以及多数无独显的服务器）上 GPU 进程会直接崩，截图不需要它
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  \u2714 ${name}`);
  } else {
    fail++;
    console.log(`  \u2718 ${name}${detail ? ' \u2014 ' + detail : ''}`);
  }
}

/** 渲染层需要的 bridge，数据全用真实默认配置，够跑满所有页面 */
function writeMockPreload() {
  const file = path.join(OUT, 'mock-bridge.cjs');
  const defaultsPath = path.join(ROOT, 'dist', 'shared', 'defaults.js');
  const src = `
const { createDefaultConfig } = require(${JSON.stringify(defaultsPath)});

const config = createDefaultConfig();
const status = {
  rcon: { state: 'connected', message: '\u5df2\u8fde\u63a5' },
  rconVerify: { state: 'disconnected', message: '\u672a\u8fde\u63a5' },
  onebot: { state: 'connected', message: '\u5728\u7ebf', selfId: '10001', selfName: '\u9e3d\u5b50' },
};
const snowluma = {
  state: 'running',
  pid: 4321,
  webUrl: 'http://127.0.0.1:8080',
  dataDir: 'D:\\\\SnowLuma\\\\data',
  dirSource: 'bundled',
  resolvedDir: 'D:\\\\SnowLuma',
  listening: true,
};
const noop = () => () => {};
const now = Date.now();

// 把未捕获异常的堆栈打出来，否则只知道崩了但不知道崩在哪
window.addEventListener('error', (e) => {
  console.error('[boot-error]', (e.error && e.error.stack) || e.message);
});

const impl = {
  getConfig: async () => config,
  getStatus: async () => status,
  getSnowLumaStatus: async () => snowluma,
  getSnowLumaLog: async () => ['[SnowLuma] 正在初始化…', '[SnowLuma] WebUI 已就绪：http://127.0.0.1:8080'],
  getBundledSnowLumaDir: async () => null,
  getDataDirInfo: async () => ({
    dir: 'C:\\\\Users\\\\Admin\\\\AppData\\\\Roaming\\\\GeLiBot\\\\data',
    source: 'user',
    reason: '程序目录不可写，回退到用户数据目录',
    portableDir: null,
    canMoveToPortable: true,
    existingPortableDataDir: null,
    files: [
      { name: 'config.json', size: 8421, mtime: now },
      { name: 'bindings.json', size: 1203, mtime: now },
    ],
  }),
  getLogWatcherStatus: async () => ({
    running: true,
    path: 'D:\\\\mc\\\\logs\\\\latest.log',
    offset: 1048576,
    lastError: null,
  }),
  getAIStatus: async () => ({ enabled: true, ready: true, todayCalls: 17 }),
  getOwnerCareStatus: async () => ({
    enabled: true,
    startDate: '2026-10-18',
    days: 3,
    sentToday: false,
    nextAt: '20:00',
    previewMessage: '【慰问服主】服主离开 3 天了',
  }),
  getUpdateStatus: async () => ({ state: 'idle', message: '已是最新版本 2.0.0' }),
  saveConfig: async () => ({ ok: true }),
  resetConfig: async () => config,
  onStatusChange: noop,
  onSnowLumaStatus: noop,
  onUpdateStatus: noop,
};

// 其余接口一律兜底，免得某个页面调用了没实现的方法直接白屏
const listLike = /^(getStatsTop|listBindings|listAudit|listPendingCodes|getTaskHistory)$/;
window.bridge = new Proxy(impl, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key !== 'string') return undefined;
    if (/^on[A-Z]/.test(key)) return noop;
    if (listLike.test(key)) return async () => [];
    return async () => ({ ok: true });
  },
});
`;
  fs.writeFileSync(file, src, 'utf8');
  return file;
}

async function main() {
  await app.whenReady();

  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    x: 80,
    y: 40,
    frame: false,
    show: false,
    backgroundColor: '#f7f9fc',
    webPreferences: {
      preload: writeMockPreload(),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'));
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('  [renderer]', message);
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    console.log('  [preload-error]', p, err && err.message);
  });
  win.show();
  await wait(1000);

  // ------------------------------------------------------------ 1. 首屏
  console.log('\n[1] \u9996\u5c4f');
  const first = await win.webContents.executeJavaScript(`
(() => {
  const bar = document.querySelector('.nav-indicator');
  const active = document.querySelector('.nav-item.active');
  const nav = document.querySelector('.sidebar');
  const stage = document.querySelector('.page-stage');
  if (!bar || !active || !nav || !stage) return { error: 'missing node' };
  const br = bar.getBoundingClientRect();
  const ar = active.getBoundingClientRect();
  return {
    barTop: Math.round(br.top), barHeight: Math.round(br.height),
    itemTop: Math.round(ar.top), itemHeight: Math.round(ar.height),
    barOpacity: getComputedStyle(bar).opacity,
    activeText: active.textContent.trim(),
    stageClass: stage.className,
    stageChildren: stage.children.length,
    scrollTop: document.querySelector('.content').scrollTop,
  };
})()
`);
  if (first.error) {
    check('\u9875\u9762\u6e32\u67d3', false, first.error);
    const dump = await win.webContents.executeJavaScript(
      `({ html: document.body.innerHTML.slice(0, 400), text: document.body.innerText.slice(0, 200), hasBridge: typeof window.bridge })`,
    );
    console.log('  body.text =', JSON.stringify(dump.text));
    console.log('  hasBridge =', dump.hasBridge);
    console.log('  body.html =', dump.html);
    app.exit(1);
    return;
  }
  check(
    '\u9ad8\u4eae\u5757\u4e0e\u5f53\u524d\u9879\u5bf9\u9f50',
    Math.abs(first.barTop - first.itemTop) <= 1 && Math.abs(first.barHeight - first.itemHeight) <= 1,
    `bar=${first.barTop}/${first.barHeight} item=${first.itemTop}/${first.itemHeight}`,
  );
  check('\u9ad8\u4eae\u5757\u5df2\u663e\u793a', first.barOpacity === '1', first.barOpacity);
  check('\u9ed8\u8ba4\u505c\u5728\u8fde\u63a5\u8bbe\u7f6e', first.activeText === '\u8fde\u63a5\u8bbe\u7f6e', first.activeText);
  check('\u9996\u5c4f\u65b9\u5411\u4e3a enter-up', first.stageClass.includes('enter-up'), first.stageClass);

  fs.writeFileSync(path.join(OUT, '01-initial.png'), (await win.webContents.capturePage()).toPNG());

  // ------------------------------------------------------------ 2. 前进切页
  console.log('\n[2] \u524d\u8fdb\u5207\u9875\uff08\u8fde\u63a5\u8bbe\u7f6e \u2192 \u73a9\u5bb6\u7edf\u8ba1\uff09');
  const fwd = await win.webContents.executeJavaScript(`
(async () => {
  const items = [...document.querySelectorAll('.nav-item')];
  const target = items.find((b) => b.textContent.trim() === '\u73a9\u5bb6\u7edf\u8ba1');
  if (!target) return { error: 'nav item not found' };
  target.click();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const stage = document.querySelector('.page-stage');
  const anims = document.getAnimations()
    .filter((a) => (a.effect.getComputedTiming().duration || 0) > 50)
    .map((a) => ({
      name: a.animationName || a.transitionProperty || '?',
      delay: Math.round(a.effect.getComputedTiming().delay),
      duration: Math.round(a.effect.getComputedTiming().duration),
      state: a.playState,
    }));
  return {
    stageClass: stage.className,
    children: stage.children.length,
    anims,
  };
})()
`);
  if (fwd.error) {
    check('\u70b9\u51fb\u5bfc\u822a', false, fwd.error);
    app.exit(1);
    return;
  }
  check('\u65b9\u5411\u4e3a enter-up\uff08\u5f80\u4e0b\u8d70\uff09', fwd.stageClass.includes('enter-up'), fwd.stageClass);

  const itemIn = fwd.anims.filter((a) => a.name === 'itemIn');
  check('\u6bcf\u4e2a\u9876\u5c42\u5757\u90fd\u6302\u4e86\u8fdb\u573a\u52a8\u753b', itemIn.length === fwd.children,
    `itemIn=${itemIn.length} children=${fwd.children}`);
  check('\u8fdb\u573a\u65f6\u957f 260ms', itemIn.every((a) => a.duration === 260),
    itemIn.map((a) => a.duration).join(','));
  check(
    '\u9519\u5f00\u5ef6\u8fdf\u4e14\u9012\u589e',
    itemIn.length >= 2 && itemIn[0].delay < itemIn[itemIn.length - 1].delay,
    itemIn.map((a) => a.delay).join(','),
  );

  const slide = fwd.anims.filter((a) => a.name === 'transform');
  check('\u9ad8\u4eae\u5757\u5728\u6ed1\u52a8', slide.length > 0, JSON.stringify(fwd.anims.slice(0, 6)));

  // ------------------------------------------------------------ 3. 中间帧
  console.log('\n[3] \u4e2d\u95f4\u5e27\uff08\u6682\u505c\u5230 120ms\uff09');
  const paused = await win.webContents.executeJavaScript(`
(() => {
  const acts = document.getAnimations().filter((a) => (a.effect.getComputedTiming().duration || 0) > 50);
  acts.forEach((a) => { a.pause(); a.currentTime = 120; });
  const stage = document.querySelector('.page-stage');
  const mid = [...stage.children].map((el) => {
    const cs = getComputedStyle(el);
    return { tag: el.tagName.toLowerCase(), cls: el.className, opacity: Number(cs.opacity).toFixed(2) };
  });
  return { count: acts.length, mid };
})()
`);
  check('\u6709\u52a8\u753b\u88ab\u63a7\u5236', paused.count > 0, String(paused.count));
  const opacities = paused.mid.map((m) => Number(m.opacity));
  const distinct = new Set(opacities).size;
  check(
    '\u4e2d\u95f4\u5e27\u5404\u5757\u900f\u660e\u5ea6\u4e0d\u540c\uff08\u771f\u7684\u662f\u9519\u5f00\u800c\u975e\u6574\u5757\u6de1\u5165\uff09',
    distinct >= 2,
    opacities.join(','),
  );
  check('\u4e2d\u95f4\u5e27\u6709\u5143\u7d20\u5c1a\u672a\u5b8c\u5168\u663e\u73b0', opacities.some((v) => v < 0.95), opacities.join(','));
  // 动画是暂停的，等一会儿不会改变状态，只是让渲染管线把这帧真的画出来
  await wait(180);
  fs.writeFileSync(path.join(OUT, '02-transition.png'), (await win.webContents.capturePage()).toPNG());
  console.log(`    \u900f\u660e\u5ea6\uff1a${paused.mid.map((m) => `${m.cls || m.tag}=${m.opacity}`).join('  ')}`);

  // 放到终点，等动画收尾
  await win.webContents.executeJavaScript(`
(() => { document.getAnimations().forEach((a) => { try { a.finish(); } catch {} }); })()
`);
  await wait(600);
  fs.writeFileSync(path.join(OUT, '03-after.png'), (await win.webContents.capturePage()).toPNG());

  // ------------------------------------------------------------ 4. 滑块落位
  console.log('\n[4] \u5207\u9875\u540e');
  const after = await win.webContents.executeJavaScript(`
(() => {
  const bar = document.querySelector('.nav-indicator');
  const active = document.querySelector('.nav-item.active');
  const br = bar.getBoundingClientRect();
  const ar = active.getBoundingClientRect();
  return {
    barTop: Math.round(br.top), barHeight: Math.round(br.height),
    itemTop: Math.round(ar.top), itemHeight: Math.round(ar.height),
    activeText: active.textContent.trim(),
    scrollTop: document.querySelector('.content').scrollTop,
  };
})()
`);
  check('\u9ad8\u4eae\u5757\u8ddf\u5230\u65b0\u9879', Math.abs(after.barTop - after.itemTop) <= 1,
    `bar=${after.barTop} item=${after.itemTop}`);
  check('\u65b0\u9879\u4e3a\u73a9\u5bb6\u7edf\u8ba1', after.activeText === '\u73a9\u5bb6\u7edf\u8ba1', after.activeText);
  check('\u5207\u9875\u540e\u56de\u5230\u9876\u90e8', after.scrollTop === 0, String(after.scrollTop));

  // ------------------------------------------------------------ 5. 后退方向
  console.log('\n[5] \u540e\u9000\u5207\u9875\uff08\u73a9\u5bb6\u7edf\u8ba1 \u2192 \u81ea\u52a8\u56de\u590d\uff09');
  const back = await win.webContents.executeJavaScript(`
(async () => {
  const items = [...document.querySelectorAll('.nav-item')];
  const target = items.find((b) => b.textContent.trim() === '\u81ea\u52a8\u56de\u590d');
  target.click();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { stageClass: document.querySelector('.page-stage').className };
})()
`);
  check('\u65b9\u5411\u4e3a enter-down\uff08\u5f80\u4e0a\u8d70\uff09', back.stageClass.includes('enter-down'), back.stageClass);
  await win.webContents.executeJavaScript(`
(() => { document.getAnimations().forEach((a) => { try { a.finish(); } catch {} }); })()
`);

  // ------------------------------------------------------------ 6. 提示条
  console.log('\n[6] \u63d0\u793a\u6761\u751f\u547d\u5468\u671f');
  const toast = await win.webContents.executeJavaScript(`
(() => {
  const el = document.createElement('div');
  el.className = 'banner toast ok';
  el.textContent = '\u914d\u7f6e\u5df2\u4fdd\u5b58\u5e76\u751f\u6548';
  document.querySelector('.content').prepend(el);
  const a = el.getAnimations()[0];
  const info = a
    ? { name: a.animationName, duration: Math.round(a.effect.getComputedTiming().duration) }
    : { name: null, duration: 0 };
  return info;
})()
`);
  check('\u63d0\u793a\u6761\u6302\u4e86\u751f\u547d\u5468\u671f\u52a8\u753b', toast.name === 'toastLife', String(toast.name));
  check('\u65f6\u957f\u4e0e 2600ms \u5378\u8f7d\u5bf9\u9f50', toast.duration === 2600, String(toast.duration));

  // ------------------------------------------------------------ 7. 降级
  console.log('\n[7] \u7cfb\u7edf\u5173\u6389\u52a8\u6548\u65f6\u7684\u964d\u7ea7');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  const reduced = await win.webContents.executeJavaScript(`
(() => {
  const block = document.querySelector('.page-stage > *');
  const cs = block ? getComputedStyle(block) : null;
  const el = document.createElement('div');
  el.className = 'banner toast ok';
  el.textContent = '\u964d\u7ea7\u63d0\u793a';
  document.querySelector('.content').prepend(el);
  const toastOpacity = getComputedStyle(el).opacity;
  el.remove();
  const raw = cs ? cs.animationDuration : '';
  return {
    matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
    raw,
    seconds: raw ? (raw.includes('ms') ? parseFloat(raw) / 1000 : parseFloat(raw)) : 0,
    toastOpacity,
  };
})()
`);
  check('\u5a92\u4f53\u67e5\u8be2\u751f\u6548', reduced.matches, String(reduced.matches));
  check('\u8fdb\u573a\u52a8\u753b\u88ab\u538b\u5230\u77ac\u65f6', reduced.seconds <= 0.01,
    `${reduced.raw} \u2192 ${reduced.seconds}s`);
  check(
    '\u63d0\u793a\u6761\u5728\u964d\u7ea7\u4e0b\u4ecd\u7136\u53ef\u89c1\uff08\u4e0d\u4f1a\u5361\u5728\u6de1\u51fa\u672b\u5e27\uff09',
    reduced.toastOpacity === '1',
    reduced.toastOpacity,
  );
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  win.webContents.debugger.detach();
  fs.writeFileSync(path.join(OUT, '04-reduced-motion.png'), (await win.webContents.capturePage()).toPNG());

  win.close();
  console.log(`\n\u7ed3\u679c\uff1a${pass} \u9879\u901a\u8fc7\uff0c${fail} \u9879\u5931\u8d25`);
  app.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\u811a\u672c\u51fa\u9519\uff1a', err);
  app.exit(1);
});
