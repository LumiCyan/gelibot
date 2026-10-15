/**
 * 双服务器绑定流程测试。
 *
 * 覆盖「玩家在 QQ 发『绑定 <玩家ID>』→ 验证服 RCON 把验证码投进游戏内对话框
 * → 玩家回填验证码 → 主服 RCON 执行 whitelist add」全链路，
 * 以及配置迁移、归属校验、降级路径等边界。
 *
 * 运行：node scripts/tests/test-verify-flow.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BindCodeManager } = require('../../dist/main/bindcode.js');
const { BindingManager } = require('../../dist/main/binding.js');
const { CommandRouter } = require('../../dist/main/router.js');
const { Store } = require('../../dist/main/store.js');
const { createDefaultConfig } = require('../../dist/shared/defaults.js');

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

// ---------------------------------------------------------------------------
// 测试台：主服 / 验证服两个独立的假 RCON，分别记录各自收到的命令
// ---------------------------------------------------------------------------
function makeHarness(mutate = () => {}) {
  const config = createDefaultConfig();
  config.whitelist.groups = ['123456789'];
  config.whitelist.admins = ['10001'];
  config.binding.maxBindingsPerQQ = 3;
  config.rateLimitMs = 0;
  config.verifyServer.enabled = true;
  mutate(config);

  let bindings = [];
  const store = {
    listBindings: () => [...bindings],
    getBindingsOf: (qq) => bindings.filter((b) => b.qq === qq),
    countBindingsOf: (qq) => bindings.filter((b) => b.qq === qq).length,
    hasBinding: (qq, p) =>
      bindings.some(
        (b) => b.qq === qq && b.playerId.toLowerCase() === p.toLowerCase(),
      ),
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
    appendAudit: () => undefined,
    listAudit: () => [],
  };

  const mainCalls = [];
  const verifyCalls = [];
  const mainState = { fail: false, response: null };
  const verifyState = { fail: false, response: null };

  const mainRcon = {
    execute: async (cmd) => {
      mainCalls.push(cmd);
      if (mainState.fail) {
        return { success: false, response: '', error: 'RCON 未连接' };
      }
      return {
        success: true,
        response: mainState.response ?? `[main] ${cmd}`,
      };
    },
  };
  const verifyRcon = {
    execute: async (cmd) => {
      verifyCalls.push(cmd);
      if (verifyState.fail) {
        return { success: false, response: '', error: 'RCON 未连接' };
      }
      return {
        success: true,
        response: verifyState.response ?? `[verify] ${cmd}`,
      };
    },
  };

  const codes = new BindCodeManager();
  const mgr = new BindingManager(store, config.binding, codes, config.serverId);
  const router = new CommandRouter(
    store,
    mgr,
    codes,
    mainRcon,
    config,
    verifyRcon,
  );
  router.setGroupCardProvider(async () => undefined);

  return {
    router,
    mgr,
    codes,
    store,
    config,
    mainCalls,
    verifyCalls,
    mainState,
    verifyState,
    bindings: () => bindings,
  };
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

/** 从池子里取出当前唯一的验证码 */
function soleCode(codes) {
  const list = codes.list();
  return list.length ? list[0].code : null;
}

(async () => {
  // -------------------------------------------------------------------------
  section('配置结构：默认值与老配置升级');

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gelibot-verify-'));
    const c = new Store(dir).getConfig();

    check('默认存在 verifyServer 配置块', !!c.verifyServer);
    check('验证服默认关闭', c.verifyServer.enabled === false);
    check(
      '验证服默认端口 25576（主服仍是 25575）',
      c.verifyServer.rcon.port === 25576 && c.rcon.port === 25575,
      `${c.verifyServer.rcon.port} / ${c.rcon.port}`,
    );
    check('默认自动加白开启', c.verifyServer.autoWhitelist === true);
    check(
      '默认加白命令为原版 whitelist add',
      c.verifyServer.whitelistAddCommand === 'whitelist add {player}',
      c.verifyServer.whitelistAddCommand,
    );
    check(
      '新增 codeIssued 消息模板已填充',
      typeof c.binding.messages.codeIssued === 'string' &&
        c.binding.messages.codeIssued.length > 0,
    );
  }

  {
    // 老配置：完全没有 verifyServer 这个键
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gelibot-verify-'));
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify(
        {
          rcon: { host: '10.0.0.1', port: 25575, password: 'x', timeoutMs: 8000, reconnectIntervalMs: 0 },
          binding: { mode: 'code', codeLength: 4, messages: { bindSuccess: '自定义成功' } },
        },
        null,
        2,
      ),
      'utf8',
    );
    const c = new Store(dir).getConfig();

    check('老配置补齐 verifyServer', !!c.verifyServer);
    check('老配置的 verifyServer 用默认值', c.verifyServer.enabled === false);
    check('老配置已有的 rcon 不被覆盖', c.rcon.host === '10.0.0.1');
    check('老配置已改的消息模板不被覆盖', c.binding.messages.bindSuccess === '自定义成功');
    check(
      '老配置补齐 codeIssued 模板',
      typeof c.binding.messages.codeIssued === 'string',
    );
  }

  {
    // 半新配置：verifyServer 只填了一部分（例如手动改过 config.json）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gelibot-verify-'));
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify(
        {
          verifyServer: { enabled: true, rcon: { host: 'mc.example.com', port: 26000 } },
        },
        null,
        2,
      ),
      'utf8',
    );
    const c = new Store(dir).getConfig();

    check('部分填写时 enabled 被保留', c.verifyServer.enabled === true);
    check('部分填写时 host/port 被保留', c.verifyServer.rcon.host === 'mc.example.com');
    check('缺失的 rcon 子字段被补齐（超时）', c.verifyServer.rcon.timeoutMs === 8000);
    check('缺失的顶层字段被补齐（自动加白）', c.verifyServer.autoWhitelist === true);
  }

  // -------------------------------------------------------------------------
  section('第一步：QQ 发「绑定 <玩家ID>」→ 验证服发码');

  {
    const h = makeHarness();
    const res = await h.router.handle(groupMsg('10001', '/绑定 Steve'));

    check('消息被处理', res.handled === true);
    check('回复提示查看验证码', /请查看验证码/.test(res.reply), res.reply);
    check('验证服收到 tellraw', h.verifyCalls.length === 1, h.verifyCalls.join(' | '));
    check(
      'tellraw 指向该玩家本人',
      h.verifyCalls[0].startsWith('tellraw Steve '),
      h.verifyCalls[0],
    );
    check('主服没有收到任何命令', h.mainCalls.length === 0, h.mainCalls.join(' | '));

    const code = soleCode(h.codes);
    check('池子里有且只有一个验证码', !!code, `${h.codes.list().length}`);
    check('验证码出现在游戏内提示里', h.verifyCalls[0].includes(code), h.verifyCalls[0]);
    check('验证码已绑定到发起者 QQ', h.codes.list()[0].qq === '10001');

    // 第二步：回填验证码
    h.verifyCalls.length = 0;
    const res2 = await h.router.handle(groupMsg('10001', `/绑定 ${code}`));

    check('回填验证码后回复绑定成功', /绑定成功/.test(res2.reply), res2.reply);
    check('回复里带上加白结果', /白名单/.test(res2.reply), res2.reply);
    check('绑定记录已落库', h.bindings().length === 1, `${h.bindings().length}`);
    check(
      '绑定的是正确的玩家',
      h.bindings()[0].playerId === 'Steve' && h.bindings()[0].qq === '10001',
    );
    check(
      '主服收到 whitelist add',
      h.mainCalls.length === 1 && h.mainCalls[0] === 'whitelist add Steve',
      h.mainCalls.join(' | '),
    );
    check('回填阶段不再重复发码', h.verifyCalls.length === 0, h.verifyCalls.join(' | '));
    check('验证码被消费（池子清空）', h.codes.list().length === 0);
  }

  // -------------------------------------------------------------------------
  section('玩家不在线：不能把码发进虚空');

  {
    const h = makeHarness();
    // Minecraft 在目标实体不存在时，RCON 仍是「执行成功」，只是响应里带报错
    h.verifyState.response = 'No player was found';

    const res = await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    check('回复里提示未找到玩家', /未找到玩家/.test(res.reply), res.reply);
    check('不会留下收不到的验证码', h.codes.list().length === 0);
    check('没有产生绑定记录', h.bindings().length === 0);
    check('主服未被调用', h.mainCalls.length === 0);
  }

  {
    const h = makeHarness();
    h.verifyState.fail = true;

    const res = await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    check('验证服 RCON 不可用时给出明确原因', /验证服 RCON 不可用/.test(res.reply), res.reply);
    check('失败后作废验证码', h.codes.list().length === 0);
  }

  // -------------------------------------------------------------------------
  section('归属校验：验证码只能由发起者本人使用');

  {
    const h = makeHarness();
    await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    const code = soleCode(h.codes);

    const stolen = await h.router.handle(groupMsg('10002', `/绑定 ${code}`));
    check('别人用这个码会失败', /不是发给你的/.test(stolen.reply), stolen.reply);
    check('别人的绑定没有落库', h.bindings().length === 0);
    check('验证码没有被别人消费掉', h.codes.list().length === 1, `${h.codes.list().length}`);

    const owner = await h.router.handle(groupMsg('10001', `/绑定 ${code}`));
    check('发起者本人仍可用', /绑定成功/.test(owner.reply), owner.reply);
  }

  // -------------------------------------------------------------------------
  section('输错验证码 vs 换绑另一个玩家 ID');

  {
    const h = makeHarness();
    await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    h.verifyCalls.length = 0;

    // 位数与字符集都符合验证码规则，但池子里没有 → 判定为输错
    const typo = await h.router.handle(groupMsg('10001', '/绑定 999999'));
    check('输错验证码时明确提示', /验证码不正确/.test(typo.reply), typo.reply);
    check('输错不会重新发码', h.verifyCalls.length === 0, h.verifyCalls.join(' | '));
    check('原本的验证码仍然有效', h.codes.list().length === 1);

    // 换绑另一个玩家 ID → 重新发码，旧码作废
    const swap = await h.router.handle(groupMsg('10001', '/绑定 Alex'));
    check('换绑会重新发码', h.verifyCalls.length === 1, h.verifyCalls.join(' | '));
    check('换绑回复也是「请查看验证码」', /请查看验证码/.test(swap.reply), swap.reply);
    check('同一 QQ 只保留一张有效码', h.codes.list().length === 1, `${h.codes.list().length}`);
    check('保留的是新玩家的码', h.codes.list()[0].playerId === 'Alex');
  }

  // -------------------------------------------------------------------------
  section('预检：注定失败的绑定不该发码');

  {
    const h = makeHarness();
    h.mgr.adminBind('99999', 'Steve');

    const res = await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    check('已被他人绑定的 ID 直接拒绝', /已被其他 QQ 绑定/.test(res.reply), res.reply);
    check('拒绝时不投递 RCON', h.verifyCalls.length === 0, h.verifyCalls.join(' | '));
    check('拒绝时不留验证码', h.codes.list().length === 0);
  }

  {
    const h = makeHarness();
    h.mgr.adminBind('10001', 'Alex');

    const res = await h.router.handle(groupMsg('10001', '/绑定 Alex'));
    check('重复绑定自己已有的 ID 被拒绝', /已经绑定过/.test(res.reply), res.reply);
    check('拒绝时不投递 RCON', h.verifyCalls.length === 0);
  }

  {
    const h = makeHarness((c) => {
      c.binding.maxBindingsPerQQ = 1;
    });
    h.mgr.adminBind('10001', 'Alex');

    const res = await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    check('超出数量上限被拒绝', /上限/.test(res.reply), res.reply);
    check('拒绝时不投递 RCON', h.verifyCalls.length === 0);
  }

  {
    const h = makeHarness((c) => {
      c.binding.allowSelfBind = false;
    });

    const res = await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    check('自助绑定关闭时被拒绝', /自助绑定已被管理员关闭/.test(res.reply), res.reply);
    check('拒绝时不投递 RCON', h.verifyCalls.length === 0);
  }

  {
    const h = makeHarness();
    const res = await h.router.handle(groupMsg('10001', '/绑定 非法ID!'));
    check('非法参数直接给用法提示', /用法/.test(res.reply), res.reply);
    check('非法参数不投递 RCON', h.verifyCalls.length === 0);
  }

  // -------------------------------------------------------------------------
  section('未启用验证服：保持旧行为');

  {
    const h = makeHarness((c) => {
      c.verifyServer.enabled = false;
    });

    const res = await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    check('未启用时不按玩家 ID 发码', h.verifyCalls.length === 0, h.verifyCalls.join(' | '));
    check('给出验证码无效的提示', /验证码无效或已过期/.test(res.reply), res.reply);

    // 旧路线仍然可用：管理员签发 → 群内回填
    const issued = h.mgr.issueCodeFor('Steve', { groupId: '123456789' });
    const res2 = await h.router.handle(
      groupMsg('10001', `/绑定 ${issued.record.code}`),
    );
    check('旧路线仍能完成绑定', /绑定成功/.test(res2.reply), res2.reply);
    check('未启用验证服时不自动加白', h.mainCalls.length === 0, h.mainCalls.join(' | '));
  }

  // -------------------------------------------------------------------------
  section('加白环节：开关、模板与失败提示');

  {
    const h = makeHarness((c) => {
      c.verifyServer.autoWhitelist = false;
    });
    await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    const code = soleCode(h.codes);
    const res = await h.router.handle(groupMsg('10001', `/绑定 ${code}`));

    check('关闭自动加白后仍能绑定', /绑定成功/.test(res.reply), res.reply);
    check('关闭自动加白后主服不被调用', h.mainCalls.length === 0, h.mainCalls.join(' | '));
  }

  {
    const h = makeHarness((c) => {
      c.verifyServer.whitelistAddCommand = 'minecraft:whitelist add {player}';
    });
    await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    const code = soleCode(h.codes);
    await h.router.handle(groupMsg('10001', `/绑定 ${code}`));

    check(
      '自定义加白模板生效',
      h.mainCalls[0] === 'minecraft:whitelist add Steve',
      h.mainCalls.join(' | '),
    );
  }

  {
    const h = makeHarness();
    await h.router.handle(groupMsg('10001', '/绑定 Steve'));
    const code = soleCode(h.codes);
    h.mainState.fail = true;
    const res = await h.router.handle(groupMsg('10001', `/绑定 ${code}`));

    check('加白失败不影响绑定本身', /绑定成功/.test(res.reply), res.reply);
    check('加白失败会在回复里警示', /加入白名单失败/.test(res.reply), res.reply);
    check('绑定记录仍然写入了', h.bindings().length === 1);
  }

  // -------------------------------------------------------------------------
  section('帮助与文案：启用双服后提示新流程');

  {
    const h = makeHarness();
    const res = await h.router.handle(groupMsg('10001', '/帮助'));
    check('帮助里出现「绑定 <玩家ID>」', res.reply.includes('绑定 <玩家ID>'), res.reply);
    check('帮助里说明会发到游戏内', /游戏内/.test(res.reply), res.reply);

    const h2 = makeHarness((c) => {
      c.verifyServer.enabled = false;
    });
    const res2 = await h2.router.handle(groupMsg('10001', '/帮助'));
    check(
      '未启用验证服时帮助仍是旧流程',
      res2.reply.includes('先在服务器内取码'),
      res2.reply,
    );
  }

  {
    const h = makeHarness();
    const res = await h.router.handle(groupMsg('10001', '/绑定'));
    check('无参数时给出两种用法', /玩家ID/.test(res.reply) && /验证码/.test(res.reply), res.reply);
  }

  // -------------------------------------------------------------------------
  console.log('\n================================================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
