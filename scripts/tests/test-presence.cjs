/**
 * 在线展示（/在线 图片卡片）测试。
 *
 * 覆盖：
 *   · list 输出解析（中英文、空响应、脏输入）
 *   · 多命令回退（插件服 list 返回空时改走 minecraft:list）与命令记忆
 *   · QQ 头像缓存（内存/磁盘/TTL/魔数/失败回退/非法输入）
 *   · 卡片 HTML 模板（占位符全局替换、HTML 转义、JSON 注入安全）
 *   · 卡片落盘（内容哈希复用、清理策略）
 *   · 编排层（图片/文字/降级/无数据 四条路径）
 *   · 配置升级（老配置补默认值）
 *
 * 运行：node scripts/tests/test-presence.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseListOutput,
  splitPlayerNames,
  renderTextTemplate,
  PresenceService,
} = require('../../dist/main/presence.js');
const { AvatarCache, sniffImageExt, isSaneQq } = require('../../dist/main/avatar.js');
const { buildCardHtml, colorOfName, toSafeJson } = require('../../dist/main/card-template.js');
const { writeCardMessage, pruneCards } = require('../../dist/main/card-file.js');
const { OnlineCardService } = require('../../dist/main/online-card.js');
const { CommandRouter } = require('../../dist/main/router.js');
const { BindingManager } = require('../../dist/main/binding.js');
const { BindCodeManager } = require('../../dist/main/bindcode.js');
const { createDefaultConfig } = require('../../dist/shared/defaults.js');
const { mergeConfigWithDefaults } = require('../../dist/main/store.js');

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
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gelibot-presence-'));

/** 假 RCON：按命令返回预设结果，并记录调用序列 */
function makeFakeRcon(map) {
  const calls = [];
  return {
    calls,
    execute(cmd) {
      calls.push(cmd);
      const v = map[cmd];
      if (v === undefined) return Promise.resolve({ success: true, response: '' });
      if (typeof v === 'function') return Promise.resolve(v(cmd));
      return Promise.resolve(v);
    },
  };
}

/** 造一张最小合法 PNG（内容可控，用于落盘测试） */
function fakePng(tag) {
  const body = Buffer.from(`fake-png-${tag}`);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), body]);
}
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

(async () => {
  // -------------------------------------------------------------------------
  section('list 输出解析');

  {
    const r = parseListOutput('There are 3 of a max of 20 players online: Steve, Alex, Herobrine');
    check('英文标准格式', r && r.online === 3 && r.max === 20 && r.players.length === 3, JSON.stringify(r));
  }
  {
    const r = parseListOutput('There are 0 of a max of 20 players online:');
    check('无人时（冒号后为空）', r && r.online === 0 && r.max === 20 && r.players.length === 0, JSON.stringify(r));
  }
  {
    const r = parseListOutput('There are 1 of a maximum of 30 players online: Notch');
    check('maximum 变体', r && r.online === 1 && r.max === 30 && r.players[0] === 'Notch', JSON.stringify(r));
  }
  {
    const r = parseListOutput('当前有 2/100 名玩家在线：Steve、Alex');
    check('中文格式（顿号分隔）', r && r.online === 2 && r.max === 100 && r.players.length === 2, JSON.stringify(r));
  }
  {
    const r = parseListOutput('Players online: 5/50');
    check('倒装格式', r && r.online === 5 && r.max === 50, JSON.stringify(r));
  }
  {
    const r = parseListOutput('§aThere are 2 of a max of 20 players online: §fSteve, §bAlex');
    check('带颜色代码', r && r.online === 2 && r.players.join(',') === 'Steve,Alex', JSON.stringify(r));
  }
  {
    check('空字符串 → null', parseListOutput('') === null);
    check('纯垃圾文本 → null', parseListOutput('This is not a list output') === null);
    check('null 安全', parseListOutput(null) === null);
  }
  {
    const names = splitPlayerNames('Steve, Alex and Notch、小王');
    check('混合分隔符切分', names.join('|') === 'Steve|Alex|Notch|小王', names.join('|'));
    const dirty = splitPlayerNames('Steve, 12345, this_name_is_way_too_long_to_be_a_player, Alex');
    check('过滤纯数字与超长碎片', dirty.join('|') === 'Steve|Alex', dirty.join('|'));
  }

  // -------------------------------------------------------------------------
  section('多命令回退与命令记忆');

  {
    const rcon = makeFakeRcon({
      list: { success: true, response: '' }, // 插件服：list 被接管，返回空
      'minecraft:list': {
        success: true,
        response: 'There are 4 of a max of 20 players online: A, B, C, D',
      },
    });
    const svc = new PresenceService(rcon);
    const s1 = await svc.refresh();
    check('list 为空时回退 minecraft:list 且成功', s1.ok && s1.online === 4, JSON.stringify(s1));
    check('命令序列为 list → minecraft:list', rcon.calls.join(',') === 'list,minecraft:list', rcon.calls.join(','));

    rcon.calls.length = 0;
    const s2 = await svc.refresh();
    check('第二次直接命中上次成功的命令', rcon.calls.join(',') === 'minecraft:list', rcon.calls.join(','));
    check('快照被记住', svc.getSnapshot()?.online === 4);
    check('快照时间戳是数字', typeof s2.at === 'number' && s2.at > 0);
  }

  {
    const rcon = makeFakeRcon({
      list: { success: true, response: 'There are 1 of a max of 10 players online: Solo' },
    });
    const svc = new PresenceService(rcon);
    const s = await svc.refresh();
    check('原版服务器一次命中 list', s.ok && rcon.calls.join(',') === 'list', rcon.calls.join(','));
  }

  {
    const rcon = makeFakeRcon({ list: { success: true, response: '' } });
    const svc = new PresenceService(rcon);
    const s = await svc.refresh();
    check('全部命令都拿不到数据 → ok:false', s.ok === false);
    check('错误文案指明内容为空', /未返回/.test(s.error || ''), s.error);
    check('失败也走完两条命令', rcon.calls.length === 2, rcon.calls.join(','));
  }

  {
    const rcon = makeFakeRcon({ list: { success: false, error: 'RCON 未连接' } });
    const svc = new PresenceService(rcon);
    const s = await svc.refresh();
    check('RCON 不可用 → ok:false 且透传错误', s.ok === false && s.error === 'RCON 未连接', s.error);
  }

  {
    const rcon = makeFakeRcon({
      list: { success: true, response: 'There are 2 of a max of 20 players online: X, Y' },
    });
    const svc = new PresenceService(rcon);
    await Promise.all([svc.refresh(), svc.refresh(), svc.refresh()]);
    check('并发 refresh 合并为一次查询', rcon.calls.filter((c) => c === 'list').length === 1, rcon.calls.join(','));
  }

  // -------------------------------------------------------------------------
  section('文字模板渲染');

  {
    const t = renderTextTemplate('[{server}] 在线 {online}/{max}\n{players}', {
      server: '生存服',
      online: 2,
      max: 20,
      players: ['Steve', 'Alex'],
    });
    check('全部变量被替换', t === '[生存服] 在线 2/20\nSteve、Alex', JSON.stringify(t));
  }
  {
    const t = renderTextTemplate('{server}: {players}', { server: 'S', online: 0, max: 0, players: [] });
    check('空名单显示「无」', t === 'S: 无', t);
  }

  // -------------------------------------------------------------------------
  section('QQ 头像缓存');

  {
    check('JPEG 魔数', sniffImageExt(FAKE_JPEG) === '.jpg');
    check('PNG 魔数', sniffImageExt(fakePng('x')) === '.png');
    check('GIF 魔数', sniffImageExt(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x00])) === '.gif');
    check('未知内容 → null', sniffImageExt(Buffer.from([1, 2, 3, 4, 5])) === null);
    check('合法 QQ 号', isSaneQq('10001') && isSaneQq('123456789012'));
    check('非法 QQ 号被拒', !isSaneQq('abc') && !isSaneQq('123') && !isSaneQq('1234567890123'));
  }

  {
    const dir = path.join(tmpRoot, 'av1');
    let fetchCount = 0;
    const cache = new AvatarCache({
      dir,
      fetchImpl: async () => {
        fetchCount++;
        return { ok: true, status: 200, arrayBuffer: async () => FAKE_JPEG };
      },
    });
    const a1 = await cache.get('10001');
    const a2 = await cache.get('10001');
    check('首次返回 data URL', typeof a1 === 'string' && a1.startsWith('data:image/jpeg;base64,'), String(a1).slice(0, 40));
    check('第二次命中内存缓存不重复请求', fetchCount === 1 && a1 === a2, `fetchCount=${fetchCount}`);
    check('磁盘已落盘', fs.existsSync(path.join(dir, '10001.jpg')));
  }

  {
    const dir = path.join(tmpRoot, 'av1'); // 复用上面的缓存目录
    let fetchCount = 0;
    const cache2 = new AvatarCache({
      dir,
      fetchImpl: async () => {
        fetchCount++;
        return { ok: true, status: 200, arrayBuffer: async () => FAKE_JPEG };
      },
    });
    const a = await cache2.get('10001');
    check('新实例命中磁盘缓存（不联网）', fetchCount === 0 && !!a, `fetchCount=${fetchCount}`);
  }

  {
    const dir = path.join(tmpRoot, 'av2');
    let fetchCount = 0;
    // now 基准用真实时间：磁盘文件的 mtime 是真实时间戳，混用会算错 TTL
    let now = Date.now();
    const cache = new AvatarCache({
      dir,
      ttlMs: 1000,
      now: () => now,
      fetchImpl: async () => {
        fetchCount++;
        return { ok: true, status: 200, arrayBuffer: async () => FAKE_JPEG };
      },
    });
    await cache.get('10002');
    now += 500; // TTL 内
    await cache.get('10002');
    check('TTL 内不重复请求', fetchCount === 1, `fetchCount=${fetchCount}`);
    now += 2000; // 过期
    cache.clearMemory();
    await cache.get('10002');
    check('TTL 过期后重新请求', fetchCount === 2, `fetchCount=${fetchCount}`);
  }

  {
    const dir = path.join(tmpRoot, 'av3');
    const urls = [];
    const cache = new AvatarCache({
      dir,
      fetchImpl: async (url) => {
        urls.push(url);
        if (urls.length === 1) throw new Error('主接口超时');
        return { ok: true, status: 200, arrayBuffer: async () => FAKE_JPEG };
      },
    });
    const a = await cache.get('10003');
    check('主接口失败后自动用备用接口', urls.length === 2 && !!a, urls.join(' | '));
    check('备用接口是 headimg_dl', urls[1]?.includes('headimg_dl'), urls[1] || '');
  }

  {
    const dir = path.join(tmpRoot, 'av4');
    let called = 0;
    const cache = new AvatarCache({
      dir,
      fetchImpl: async () => {
        called++;
        return { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) };
      },
    });
    const a = await cache.get('10004');
    check('全部接口失败 → null（不抛错）', a === null);
    check('两个接口都试过', called === 2, `called=${called}`);
    const bad = await cache.get('not-a-qq');
    check('非法 QQ 直接拒绝（不联网）', bad === null && called === 2, `called=${called}`);
  }

  {
    const dir = path.join(tmpRoot, 'av4');
    const cache = new AvatarCache({ dir, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(10) }) });
    const a = await cache.get('10005');
    check('返回内容过小 → null', a === null);
  }

  {
    const dir = path.join(tmpRoot, 'av5');
    let fetchCount = 0;
    const cache = new AvatarCache({
      dir,
      fetchImpl: async () => {
        fetchCount++;
        return { ok: true, status: 200, arrayBuffer: async () => FAKE_JPEG };
      },
    });
    const m = await cache.getMany(['10006', '10006', '10007']);
    check('getMany 去重且都成功', m.size === 2 && fetchCount === 2, `size=${m.size} fetch=${fetchCount}`);
  }

  {
    const cache = new AvatarCache({ dir: path.join(tmpRoot, 'av6') }); // 无 fetchImpl
    const a = await cache.get('10008');
    check('未注入网络实现时安全返回 null', a === null);
  }

  // -------------------------------------------------------------------------
  section('卡片 HTML 模板');

  {
    const html = buildCardHtml(
      {
        serverName: '创造服',
        online: 6,
        max: 20,
        players: [
          { name: 'Steve', avatar: 'data:image/jpeg;base64,AAA' },
          { name: 'Alex', avatar: null },
        ],
        timeText: '2026-10-17 01:00',
      },
      { iconUri: 'data:image/png;base64,ICON', width: 600 },
    );
    check('宽度占位符全部替换', !html.includes('__WIDTH__') && (html.match(/600px/g) || []).length === 2, String((html.match(/600px/g) || []).length));
    check('百分比出现两处且都是 30', (html.match(/30/g) || []).length >= 2 && !html.includes('__PCT__'));
    check('服务器名已填入', html.includes('创造服'));
    check('图标 data URI 已注入', html.includes('data:image/png;base64,ICON'));
    check('玩家数据已注入 JSON', html.includes('data:image/jpeg;base64,AAA') && html.includes('"Alex"'));
    check('无残留占位符', !/__[A-Z]+__/.test(html), (html.match(/__[A-Z]+__/g) || []).join(','));
  }
  {
    const html = buildCardHtml(
      { serverName: '<b>坏名字</b>', online: 0, max: 0, players: [], timeText: 't' },
      { iconUri: 'x', width: 600 },
    );
    check('服务器名做 HTML 转义', !html.includes('<b>坏名字</b>') && html.includes('&lt;b&gt;'));
    check('max=0 时百分比为 0（不除零）', html.includes('占用 0%'));
  }
  {
    const json = toSafeJson({ name: '</script><img>' });
    check('JSON 注入转义 < 防截断', !json.includes('</script>') && json.includes('\\u003c'), json);
  }
  {
    check('同名同色', colorOfName('Steve') === colorOfName('Steve'));
    const set = new Set(['Steve', 'Alex', 'Notch', 'x', 'y', 'z'].map(colorOfName));
    check('调色板可用（多种颜色）', set.size >= 3, String(set.size));
  }

  // -------------------------------------------------------------------------
  section('卡片落盘与清理');

  {
    const dir = path.join(tmpRoot, 'cards1');
    const png = fakePng('one');
    const msg1 = writeCardMessage(dir, png);
    const msg2 = writeCardMessage(dir, png);
    check('返回 CQ 码且指向 file://', msg1.startsWith('[CQ:image,file=file:///'), msg1);
    check('文件名是 12 位内容哈希', /online-[0-9a-f]{12}\.png/.test(msg1), msg1);
    check('同内容复用同一文件', msg1 === msg2 && fs.readdirSync(dir).length === 1);

    const msg3 = writeCardMessage(dir, fakePng('two'));
    check('不同内容生成新文件', msg3 !== msg1 && fs.readdirSync(dir).length === 2);
  }
  {
    const dir = path.join(tmpRoot, 'cards2');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, `online-${String(i).repeat(12).slice(0, 12)}.png`);
      fs.writeFileSync(f, fakePng(i));
      // 让 mtime 递增，模拟先后写入
      const t = new Date(Date.now() - (6 - i) * 1000);
      fs.utimesSync(f, t, t);
    }
    pruneCards(dir, 2);
    check('pruneCards 只保留最新 keep 个', fs.readdirSync(dir).length === 2, String(fs.readdirSync(dir).length));
    check('保留的是最新两个', fs.existsSync(path.join(dir, `online-${'5'.repeat(12)}.png`)) && fs.existsSync(path.join(dir, `online-${'4'.repeat(12)}.png`)));
  }

  // -------------------------------------------------------------------------
  section('编排层（在线卡片服务）');

  const basePresence = {
    enabled: true,
    serverName: '创造服',
    showAvatars: true,
    sendImage: true,
    textTemplate: '[{server}] 在线 {online}/{max} {players}',
  };
  const makeSvc = (opts = {}) => {
    const snap = opts.snap ?? {
      ok: true,
      online: 2,
      max: 20,
      players: ['Steve', 'Alex'],
      at: Date.now(),
    };
    const calls = { render: [], getMany: [] };
    const svc = new OnlineCardService({
      presence: { refresh: async () => snap },
      avatars: {
        getMany: async (qqs) => {
          calls.getMany.push([...qqs]);
          return new Map(qqs.map((q) => [q, 'data:image/jpeg;base64,AV']));
        },
      },
      renderer: {
        render: async (data) => {
          calls.render.push(data);
          return { png: fakePng('card'), width: 750, height: 500 };
        },
      },
      getConfig: () => ({ presence: { ...basePresence, ...(opts.presence ?? {}) } }),
      findBinding: (p) => (p === 'Steve' ? { qq: '10001' } : undefined),
      cardDir: path.join(tmpRoot, 'cards-svc'),
      log: () => {},
    });
    return { svc, calls, snap };
  };

  {
    const { svc, calls } = makeSvc();
    const msg = await svc.build();
    check('成功路径返回 CQ 图片消息', typeof msg === 'string' && msg.startsWith('[CQ:image,'), String(msg).slice(0, 60));
    check('渲染数据含服务器名与人数', calls.render[0]?.serverName === '创造服' && calls.render[0]?.online === 2);
    check('只对已绑定玩家拉头像', calls.getMany.length === 1 && calls.getMany[0].join(',') === '10001', JSON.stringify(calls.getMany));
    const steve = calls.render[0]?.players.find((p) => p.name === 'Steve');
    const alex = calls.render[0]?.players.find((p) => p.name === 'Alex');
    check('已绑定玩家带头像', !!steve?.avatar);
    check('未绑定玩家头像为 null', alex?.avatar === null);
  }
  {
    const { svc, calls } = makeSvc({ presence: { sendImage: false } });
    const msg = await svc.build();
    check('关闭发图 → 返回文字模板', msg === '[创造服] 在线 2/20 Steve、Alex', String(msg));
    check('关闭发图时不渲染', calls.render.length === 0);
  }
  {
    const { svc } = makeSvc({ presence: { showAvatars: false } });
    const msg = await svc.build();
    check('关闭头像时仍能出图', String(msg).startsWith('[CQ:image,'));
  }
  {
    const snap = { ok: false, online: 0, max: 0, players: [], at: Date.now(), error: 'RCON 未连接' };
    const { svc } = makeSvc({ snap });
    const msg = await svc.build();
    check('数据不可用 → 返回 null（交还路由走原生流程）', msg === null);
  }
  {
    const svc = new OnlineCardService({
      presence: { refresh: async () => ({ ok: true, online: 1, max: 20, players: ['Solo'], at: Date.now() }) },
      avatars: { getMany: async () => new Map() },
      renderer: { render: async () => { throw new Error('截图失败'); } },
      getConfig: () => ({ presence: { ...basePresence } }),
      findBinding: () => undefined,
      cardDir: path.join(tmpRoot, 'cards-svc'),
      log: () => {},
    });
    const msg = await svc.build();
    check('渲染失败降级为文字', msg === '[创造服] 在线 1/20 Solo', String(msg));
  }

  // -------------------------------------------------------------------------
  section('路由接入（/在线 图片路径与回退）');

  {
    const makeRouterHarness = (mutate = () => {}) => {
      const config = createDefaultConfig();
      config.whitelist.groups = ['123456789'];
      config.whitelist.admins = ['10001'];
      config.rateLimitMs = 0;
      mutate(config);

      const store = {
        listBindings: () => [],
        getBindingsOf: () => [],
        countBindingsOf: () => 0,
        hasBinding: () => false,
        isPlayerTaken: () => undefined,
        addBinding: () => undefined,
        removeBinding: () => false,
        removeBindingsOf: () => 0,
        appendAudit: () => undefined,
        listAudit: () => [],
      };
      const rconCalls = [];
      const rcon = {
        execute: async (cmd) => {
          rconCalls.push(cmd);
          return { success: true, response: 'There are 1 of a max of 20 players online: Solo' };
        },
      };
      const codes = new BindCodeManager();
      const mgr = new BindingManager(store, config.binding, codes, config.serverId);
      const router = new CommandRouter(store, mgr, codes, rcon, config);
      router.setGroupCardProvider(async () => undefined);
      return { router, config, rconCalls };
    };
    const groupMsg = (qq, text) => ({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: Math.floor(Math.random() * 1e6),
      group_id: 123456789,
      user_id: Number(qq),
      raw_message: text,
      message: text,
      sender: { nickname: `user${qq}`, role: 'member' },
    });

    {
      const h = makeRouterHarness();
      const res = await h.router.handle(groupMsg('20001', '/在线'));
      check('未启用时走原生 RCON 流程', h.rconCalls.includes('list') && /执行结果/.test(res.reply || ''), JSON.stringify(res).slice(0, 120));
    }
    {
      const h = makeRouterHarness((c) => { c.presence.enabled = true; });
      h.router.setOnlineCardProvider({
        build: async () => '[CQ:image,file=file:///x/online-abc123.png]',
      });
      const res = await h.router.handle(groupMsg('20002', '/在线'));
      check('启用后 /在线 返回图片消息', res.handled === true && res.reply === '[CQ:image,file=file:///x/online-abc123.png]', JSON.stringify(res).slice(0, 120));
      check('图片路径不再执行 list', !h.rconCalls.includes('list'), h.rconCalls.join(','));
    }
    {
      const h = makeRouterHarness((c) => { c.presence.enabled = true; });
      h.router.setOnlineCardProvider({ build: async () => null });
      const res = await h.router.handle(groupMsg('20003', '/在线'));
      check('提供者返回 null → 回退原生 RCON', h.rconCalls.includes('list') && /执行结果/.test(res.reply || ''), JSON.stringify(res).slice(0, 120));
    }
    {
      const h = makeRouterHarness(); // presence.enabled 默认 false
      let called = 0;
      h.router.setOnlineCardProvider({ build: async () => { called++; return 'x'; } });
      const res = await h.router.handle(groupMsg('20004', '/在线'));
      check('未启用时提供者不被调用', called === 0 && h.rconCalls.includes('list'));
      check('未启用时回复格式与旧版一致', /\/在线 执行结果：/.test(res.reply || ''), JSON.stringify(res.reply).slice(0, 120));
    }
    {
      const h = makeRouterHarness((c) => { c.presence.enabled = true; });
      h.router.setOnlineCardProvider({ build: async () => '[CQ:image,file=file:///x.png]' });
      const res = await h.router.handle(groupMsg('20005', '/tps'));
      check('其他指令不受影响（/tps 正常走 RCON）', h.rconCalls.includes('tps') && /tps 执行结果/.test(res.reply || ''), JSON.stringify(res).slice(0, 120));
    }
  }

  // -------------------------------------------------------------------------
  section('配置默认值与老配置升级');

  {
    const d = createDefaultConfig();
    check('默认关闭（升级后行为不变）', d.presence.enabled === false);
    check('默认服务器名', d.presence.serverName === '生存服');
    check('默认发图 + 显示头像', d.presence.sendImage === true && d.presence.showAvatars === true);
    check('默认文字模板带变量', /\{server\}/.test(d.presence.textTemplate) && /\{online\}/.test(d.presence.textTemplate));
  }
  {
    const legacy = { rcon: { host: '1.2.3.4', port: 25575, password: 'pw' }, binding: {} };
    const merged = mergeConfigWithDefaults(legacy);
    check('老配置自动补 presence 块', !!merged.presence && merged.presence.enabled === false);
    check('老配置原有字段不受影响', merged.rcon.host === '1.2.3.4' && merged.rcon.password === 'pw');
  }
  {
    const partial = { presence: { enabled: true, serverName: '空岛服' } };
    const merged = mergeConfigWithDefaults(partial);
    check('部分字段的 presence 被补齐', merged.presence.enabled === true && merged.presence.serverName === '空岛服' && merged.presence.sendImage === true, JSON.stringify(merged.presence));
  }

  // -------------------------------------------------------------------------
  console.log(`\n${'='.repeat(48)}`);
  console.log(`在线展示测试：通过 ${pass} 项，失败 ${fail} 项`);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试自身异常:', err);
  process.exit(1);
});
