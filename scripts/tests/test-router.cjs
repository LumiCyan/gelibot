/**
 * 路由集成测试：模拟一条群消息，走完「白名单 → 指令匹配 → 绑定/RCON → 回复」全链路。
 *
 * 用假的 RconClient / Store 替身，验证：
 * - 双向验证模式下 /绑定 <验证码> 的完整流程
 * - 信任模式下 /绑定 <玩家ID>
 * - 非白名单群被忽略
 * - 注入尝试不会投递 RCON
 *
 * 运行：node _test-router.cjs
 */
const { BindCodeManager } = require('../../dist/main/bindcode.js');
const { BindingManager } = require('../../dist/main/binding.js');
const { CommandRouter } = require('../../dist/main/router.js');
const { createDefaultConfig } = require('../../dist/shared/defaults.js');

let pass = 0;
let fail = 0;
const rconCalls = [];

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${extra ? `  → ${extra}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

function makeHarness(mutate = () => {}) {
  const config = createDefaultConfig();
  config.whitelist.groups = ['123456789'];
  config.whitelist.privates = ['10001'];
  config.whitelist.admins = ['10001'];
  config.binding.maxBindingsPerQQ = 3;
  // 测试里连续发消息，关掉限流以免干扰断言（限流本身有单独用例覆盖）
  config.rateLimitMs = 0;
  mutate(config);

  let bindings = [];
  let audit = [];
  const store = {
    listBindings: () => [...bindings],
    getBindingsOf: (qq) => bindings.filter((b) => b.qq === qq),
    countBindingsOf: (qq) => bindings.filter((b) => b.qq === qq).length,
    hasBinding: (qq, p) =>
      bindings.some((b) => b.qq === qq && b.playerId.toLowerCase() === p.toLowerCase()),
    isPlayerTaken: (p) =>
      bindings.find((b) => b.playerId.toLowerCase() === p.toLowerCase()),
    addBinding: (b) => bindings.push(b),
    removeBinding: (qq, p) => {
      const n = bindings.length;
      bindings = bindings.filter(
        (b) => !(b.qq === qq && b.playerId.toLowerCase() === p.toLowerCase()),
      );
      return bindings.length !== n;
    },
    removeBindingsOf: (qq) => {
      const n = bindings.length;
      bindings = bindings.filter((b) => b.qq !== qq);
      return n - bindings.length;
    },
    appendAudit: (e) => audit.push(e),
    listAudit: () => audit,
  };

  const rcon = {
    execute: async (cmd) => {
      rconCalls.push(cmd);
      return { success: true, response: `[mock] ${cmd}` };
    },
  };

  const codes = new BindCodeManager();
  const mgr = new BindingManager(store, config.binding, codes, config.serverId);
  const router = new CommandRouter(store, mgr, codes, rcon, config);
  router.setGroupCardProvider(async () => undefined);

  return { router, mgr, codes, store, config, bindings: () => bindings };
}

function groupMsg(qq, text, groupId = 123456789) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: Math.floor(Math.random() * 1e6),
    group_id: Number(groupId),
    user_id: Number(qq),
    raw_message: text,
    message: text,
    sender: { nickname: `user${qq}`, role: 'member' },
  };
}

function privateMsg(qq, text) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: Math.floor(Math.random() * 1e6),
    user_id: Number(qq),
    raw_message: text,
    message: text,
    sender: { nickname: `user${qq}` },
  };
}

(async () => {
  // -------------------------------------------------------------------------
  section('源码忽略：非白名单群');

  {
    rconCalls.length = 0;
    const { router } = makeHarness();
    const res = await router.handle(groupMsg('20002', '/在线', 999999999));
    check('非白名单群的消息被忽略', res.handled === false, JSON.stringify(res));
    check('未产生任何 RCON 调用', rconCalls.length === 0, `${rconCalls.length}`);
  }

  // -------------------------------------------------------------------------
  section('双向验证模式：完整绑定流程');

  {
    rconCalls.length = 0;
    const h = makeHarness();

    // 1) 服务器内发起绑定
    const issued = await h.router.startServerSideBind('Herobrine', { groupId: '123456789' });
    check('服务器内取码成功', issued.ok === true, JSON.stringify(issued));
    check('返回验证码', typeof issued.code === 'string' && issued.code.length === 6, issued.code);
    check('返回有效期文本', typeof issued.ttlText === 'string', issued.ttlText);
    check('通过 RCON 播报了验证码', rconCalls.some((c) => c.startsWith('tellraw')), rconCalls.join(' | '));

    // 2) 群内用验证码绑定
    const res = await h.router.handle(groupMsg('20002', `/绑定 ${issued.code}`));
    check('群内绑定被处理', res.handled === true);
    check('回复为绑定成功', /绑定成功/.test(res.reply), res.reply);
    check('绑定已落库', h.bindings().length === 1, `${h.bindings().length}`);
  }

  // -------------------------------------------------------------------------
  section('双向验证模式：错误与边界');

  {
    const h = makeHarness();
    const res = await h.router.handle(groupMsg('20002', '/绑定 000000'));
    check('错误验证码被拒绝', /失败/.test(res.reply), res.reply);
    check('未产生绑定', h.bindings().length === 0);
  }

  {
    const h = makeHarness();
    const res = await h.router.handle(groupMsg('20002', '/绑定'));
    check('缺少参数时提示用法', /用法/.test(res.reply), res.reply);
  }

  {
    const h = makeHarness();
    const issued = await h.router.startServerSideBind('Herobrine', { groupId: '123456789' });
    await h.router.handle(groupMsg('20002', `/绑定 ${issued.code}`));
    // 第二次用同一个码
    const again = await h.router.handle(groupMsg('20003', `/绑定 ${issued.code}`));
    check('验证码一次性，二次失败', /失败/.test(again.reply), again.reply);
    check('绑定数仍为 1', h.bindings().length === 1, `${h.bindings().length}`);
  }

  // -------------------------------------------------------------------------
  section('信任模式');

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/绑定 Steve'));
    check('信任模式直接绑定成功', /绑定成功/.test(res.reply), res.reply);
    check('绑定已落库', h.bindings().length === 1);
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/绑定 ../../etc'));
    check('信任模式拒绝非法 ID', /失败|不合法/.test(res.reply), res.reply);
    check('未产生绑定', h.bindings().length === 0);
  }

  // -------------------------------------------------------------------------
  section('解绑');

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    await h.router.handle(groupMsg('20002', '/绑定 Steve'));
    const res = await h.router.handle(groupMsg('20002', '/解绑 Steve'));
    check('解绑成功', /解绑成功/.test(res.reply), res.reply);
    check('绑定已清空', h.bindings().length === 0, `${h.bindings().length}`);
  }

  // -------------------------------------------------------------------------
  section('我的绑定 / 查询绑定');

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    await h.router.handle(groupMsg('20002', '/绑定 Steve'));
    const mine = await h.router.handle(groupMsg('20002', '/我的绑定'));
    check('我的绑定列出玩家', mine.reply.includes('Steve'), mine.reply);
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    await h.router.handle(groupMsg('20002', '/绑定 Steve'));
    // 20002 不是管理员
    const denied = await h.router.handle(groupMsg('20002', '/查询绑定 Steve'));
    check('非管理员查询被拒绝', /没有权限/.test(denied.reply), denied.reply);
    // 10001 是管理员
    const allowed = await h.router.handle(groupMsg('10001', '/查询绑定 Steve'));
    check('管理员查询成功', allowed.reply.includes('20002'), allowed.reply);
  }

  // -------------------------------------------------------------------------
  section('强制绑定：解绑后踢出');

  {
    rconCalls.length = 0;
    const h = makeHarness((c) => {
      c.binding.mode = 'trust';
      c.binding.forceBind = { enabled: true, servers: ['main'] };
    });
    await h.router.handle(groupMsg('20002', '/绑定 Steve'));
    rconCalls.length = 0;
    await h.router.handle(groupMsg('20002', '/解绑 Steve'));
    check('解绑后下发了 kick 指令', rconCalls.some((c) => c.startsWith('kick Steve')), rconCalls.join(' | '));
  }

  {
    rconCalls.length = 0;
    const h = makeHarness((c) => {
      c.binding.mode = 'trust';
      c.binding.forceBind = { enabled: false, servers: [] };
    });
    await h.router.handle(groupMsg('20002', '/绑定 Steve'));
    rconCalls.length = 0;
    await h.router.handle(groupMsg('20002', '/解绑 Steve'));
    check('未启用强制绑定时不下发 kick', rconCalls.length === 0, rconCalls.join(' | '));
  }

  // -------------------------------------------------------------------------
  section('绑定前置要求');

  {
    const h = makeHarness((c) => {
      c.binding.mode = 'trust';
      c.binding.requireBindingForCommands = true;
    });
    const res = await h.router.handle(groupMsg('20002', '/在线'));
    check('未绑定时被拦截', /还没有绑定/.test(res.reply), res.reply);
    check('提示中包含绑定指引', /绑定/.test(res.reply));
  }

  {
    const h = makeHarness((c) => {
      c.binding.mode = 'trust';
      c.binding.requireBindingForCommands = true;
    });
    await h.router.handle(groupMsg('20002', '/绑定 Steve'));
    const res = await h.router.handle(groupMsg('20002', '/在线'));
    check('绑定后指令放行', /执行结果/.test(res.reply), res.reply);
  }

  // -------------------------------------------------------------------------
  section('RCON 指令权限与注入防护');

  {
    rconCalls.length = 0;
    const h = makeHarness((c) => {
      c.binding.requireBindingForCommands = false;
      c.binding.mode = 'trust';
    });

    // 普通用户执行管理员指令
    const denied = await h.router.handle(groupMsg('20002', '/加白 Steve'));
    check('普通用户被拒绝管理指令', /没有权限/.test(denied.reply), denied.reply);
    check('管理指令未投递 RCON', rconCalls.length === 0, rconCalls.join(' | '));

    // 管理员执行
    const allowed = await h.router.handle(groupMsg('10001', '/加白 Steve'));
    check('管理员执行加白成功', /执行结果/.test(allowed.reply), allowed.reply);
    check('投递了 whitelist add', rconCalls.some((c) => c === 'whitelist add Steve'), rconCalls.join(' | '));
  }

  {
    rconCalls.length = 0;
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const attacks = [
      '/加白 ../../etc',
      '/加白 Steve;stop',
      '/加白 rm -rf',
      '/加白 "Steve stop"',
    ];
    for (const a of attacks) {
      await h.router.handle(groupMsg('10001', a));
    }
    check('注入尝试全部被参数校验拦截', rconCalls.length === 0, rconCalls.join(' | '));
  }

  // -------------------------------------------------------------------------
  section('帮助与限流');

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const help = await h.router.handle(groupMsg('20002', '/帮助'));
    check('帮助包含绑定说明', /账号绑定/.test(help.reply), help.reply.slice(0, 60));
    check('帮助不含管理员指令（非管理员）', !help.reply.includes('查询绑定'), '包含了');
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; c.rateLimitMs = 5000; });
    const a = await h.router.handle(groupMsg('20002', '/在线'));
    const b = await h.router.handle(groupMsg('20002', '/在线'));
    check('第一次正常处理', !/太频繁/.test(a.reply), a.reply);
    check('第二次被限流拦截', /太频繁/.test(b.reply), b.reply);
  }
  // -------------------------------------------------------------------------
  section('私聊场景');

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(privateMsg('10001', '/绑定 Steve'));
    check('私聊内绑定成功', /绑定成功/.test(res.reply), res.reply);
    const b = h.bindings()[0];
    check('私聊绑定无来源群', b.fromGroup === undefined, String(b.fromGroup));
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(privateMsg('99999', '/绑定 Steve'));
    check('非白名单私聊被忽略', res.handled === false, JSON.stringify(res));
  }

  // -------------------------------------------------------------------------
  section('未知指令：以 / 开头却匹配不上（不能再静默）');

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/绑定Steve'));
    check('漏空格的 /绑定Steve 不再静默', res.handled === true, JSON.stringify(res));
    check('提示点破「需要一个空格」', /需要一个空格/.test(res.reply), res.reply);
    check('提示给出正确写法', /\/绑定 Steve/.test(res.reply), res.reply);
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/绑定xx'));
    check('短 ID 粘连同样给出漏空格提示', /\/绑定 xx/.test(res.reply), res.reply);
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/解绑Steve'));
    check('解绑粘连给出正确写法', /\/解绑 Steve/.test(res.reply), res.reply);
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/查询绑定abc'));
    check('长指令名优先切分（查询绑定）', /\/查询绑定 abc/.test(res.reply), res.reply);
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/我的绑定abc'));
    check(
      '不吃参数的 /我的绑定 不做漏空格建议',
      !/需要一个空格/.test(res.reply),
      res.reply,
    );
    check('改为引导查看帮助', /\/帮助/.test(res.reply), res.reply);
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/在线xx'));
    check(
      '不吃参数的 /在线 不做漏空格建议',
      !/需要一个空格/.test(res.reply),
      res.reply,
    );
    check('改为引导查看帮助（在线）', /\/帮助/.test(res.reply), res.reply);
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/帮组'));
    check('纯错别字指令给出帮助引导', res.handled === true && /\/帮助/.test(res.reply), res.reply);
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/绑定 Steve'));
    check('正常写法不受影响（有空格仍能绑定）', /绑定成功/.test(res.reply), res.reply);
  }

  {
    const h = makeHarness((c) => { c.binding.mode = 'trust'; });
    const res = await h.router.handle(groupMsg('20002', '/'));
    check('单个 / 仍返回帮助', /可用指令/.test(res.reply), res.reply);
  }

  // -------------------------------------------------------------------------
  console.log(`\n${'='.repeat(48)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('='.repeat(48));
  process.exit(fail === 0 ? 0 : 1);
})();
