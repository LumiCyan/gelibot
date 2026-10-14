/**
 * 配置迁移测试：验证老版本 config.json（无 binding 子字段）加载后自动补齐新字段。
 * 运行：node _test-migrate.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../dist/main/store.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${extra ? `  → ${extra}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qmc-migrate-'));

// ---- 场景 1：全新安装 ----
section('全新安装');
{
  const dir = path.join(tmp, 'fresh');
  const store = new Store(dir);
  const c = store.getConfig();

  check('自动生成 config.json', fs.existsSync(path.join(dir, 'config.json')));
  check('默认模式为双向验证', c.binding.mode === 'code', c.binding.mode);
  check('验证码位数默认 6', c.binding.codeLength === 6, `${c.binding.codeLength}`);
  check('验证码类型默认纯数字', c.binding.codeFormat === 'number', c.binding.codeFormat);
  check('默认有效期为 300 秒', c.binding.codeTtlSeconds === 300, `${c.binding.codeTtlSeconds}`);
  check('强制绑定默认关闭', c.binding.forceBind.enabled === false);
  check('消息模板已填充', typeof c.binding.messages.bindSuccess === 'string');
  check('serverId 默认为 main', c.serverId === 'main', c.serverId);
}

// ---- 场景 2：老配置升级（缺 binding 新字段） ----
section('老配置升级');
{
  const dir = path.join(tmp, 'legacy');
  fs.mkdirSync(dir, { recursive: true });
  // 模拟上一版写出的 config.json：binding 只有三个老字段
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        rcon: { host: '10.0.0.5', port: 25575, password: 'secret', timeoutMs: 8000, reconnectIntervalMs: 5000 },
        onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', autoReconnect: true, reconnectIntervalMs: 5000 },
        whitelist: { groupEnabled: true, groups: ['111'], privateEnabled: false, privates: [], admins: ['111'] },
        binding: { maxBindingsPerQQ: 2, requireBindingForCommands: true, allowSelfBind: false },
        commands: [],
        rateLimitMs: 900,
      },
      null,
      2,
    ),
  );

  const store = new Store(dir);
  const c = store.getConfig();

  check('保留用户自定义 RCON host', c.rcon.host === '10.0.0.5', c.rcon.host);
  check('保留用户自定义密码', c.rcon.password === 'secret', c.rcon.password);
  check('保留绑定上限 2', c.binding.maxBindingsPerQQ === 2, `${c.binding.maxBindingsPerQQ}`);
  check('保留 requireBindingForCommands', c.binding.requireBindingForCommands === true);
  check('保留 allowSelfBind=false', c.binding.allowSelfBind === false);

  check('补齐 mode 字段', c.binding.mode === 'code', c.binding.mode);
  check('补齐 codeLength', c.binding.codeLength === 6, `${c.binding.codeLength}`);
  check('补齐 codeFormat', c.binding.codeFormat === 'number', c.binding.codeFormat);
  check('补齐 codeTtlSeconds', c.binding.codeTtlSeconds === 300, `${c.binding.codeTtlSeconds}`);
  check('补齐 allowSelfUnbind', c.binding.allowSelfUnbind === true);
  check('补齐 forceBind 对象', typeof c.binding.forceBind === 'object' && c.binding.forceBind.enabled === false);
  check('补齐 forceBind.servers 数组', Array.isArray(c.binding.forceBind.servers));
  check('补齐 unbindOnGroupLeave', c.binding.unbindOnGroupLeave === false);
  check('补齐 cardUpdate', c.binding.cardUpdate === 'off', c.binding.cardUpdate);
  check('补齐 messages 对象', typeof c.binding.messages === 'object');
  check('补齐 messages.bindSuccess 文案', typeof c.binding.messages.bindSuccess === 'string' && c.binding.messages.bindSuccess.length > 0);
  check('补齐 messages.kickMessage 文案', typeof c.binding.messages.kickMessage === 'string');
  check('补齐 serverId', c.serverId === 'main', c.serverId);
  check('保留 rateLimitMs 900', c.rateLimitMs === 900, `${c.rateLimitMs}`);
  check('commands 为空时回退内置指令表', c.commands.length === 9, `${c.commands.length}`);
  check('内置指令含查询绑定', c.commands.some((x) => x.name === '查询绑定'));
}

// ---- 场景 3：部分 messages 缺失 ----
section('部分 messages 缺失');
{
  const dir = path.join(tmp, 'partial');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        binding: {
          mode: 'trust',
          maxBindingsPerQQ: 5,
          messages: { bindSuccess: '自定义成功 #player' },
        },
      },
      null,
      2,
    ),
  );

  const store = new Store(dir);
  const c = store.getConfig();

  check('保留自定义 bindSuccess', c.binding.messages.bindSuccess === '自定义成功 #player', c.binding.messages.bindSuccess);
  check('补齐缺失的 bindFail', typeof c.binding.messages.bindFail === 'string' && c.binding.messages.bindFail.includes('#why'));
  check('补齐缺失的 kickMessage', typeof c.binding.messages.kickMessage === 'string');
  check('保留 mode=trust', c.binding.mode === 'trust', c.binding.mode);
}

// ---- 场景 4：持久化往返 ----
section('持久化往返');
{
  const dir = path.join(tmp, 'roundtrip');
  const s1 = new Store(dir);
  const cfg = s1.getConfig();
  cfg.binding.mode = 'trust';
  cfg.binding.codeLength = 8;
  cfg.binding.messages.bindSuccess = 'ROUND #player';
  cfg.whitelist.groups = ['555', '666'];
  s1.saveConfig(cfg);

  const s2 = new Store(dir);
  const c2 = s2.getConfig();
  check('mode 往返一致', c2.binding.mode === 'trust', c2.binding.mode);
  check('codeLength 往返一致', c2.binding.codeLength === 8, `${c2.binding.codeLength}`);
  check('自定义消息往返一致', c2.binding.messages.bindSuccess === 'ROUND #player', c2.binding.messages.bindSuccess);
  check('群列表往返一致', c2.whitelist.groups.join(',') === '555,666', c2.whitelist.groups.join(','));
}

// ---- 场景 5：损坏文件降级 ----
section('损坏文件降级');
{
  const dir = path.join(tmp, 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json ');
  let ok = true;
  let c = null;
  try {
    c = new Store(dir).getConfig();
  } catch {
    ok = false;
  }
  check('损坏配置不抛异常', ok);
  check('降级为默认配置', ok && c.binding.mode === 'code', ok ? c.binding.mode : 'n/a');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${'='.repeat(48)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(48));
process.exit(fail === 0 ? 0 : 1);
