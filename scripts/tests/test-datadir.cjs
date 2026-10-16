/**
 * 数据目录与配置迁移测试。
 *
 * 覆盖两件用户直接感知的事：
 *   1. 数据目录能否「跟随程序」—— 换版本不用重新配置
 *   2. 配置能否导出 / 导入 —— 跨机器、跨意外情况
 *
 * 运行：npm test（会先 build:main）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DATA_SUBDIR,
  pickPortableDir,
  sidecarDataDir,
  resolveDataDir,
  planMoveToPortable,
  moveDataToPortable,
} = require('../../dist/main/datadir.js');

const {
  EXPORT_KIND,
  EXPORT_FORMAT_VERSION,
  redactSecrets,
  buildExportBundle,
  parseImportBundle,
  mergeImportedConfig,
  mergeBindings,
  suggestExportName,
} = require('../../dist/main/transfer.js');

const { Store, mergeConfigWithDefaults } = require('../../dist/main/store.js');
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gelibot-datadir-'));

/** 造一个「程序目录」：exe 旁边有没有 data/config.json */
function makePortableDir(label, { withData = true } = {}) {
  const dir = path.join(tmp, `app-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'GeLi Bot.exe'), 'fake');
  if (withData) {
    const data = path.join(dir, DATA_SUBDIR);
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.json'), '{}');
  }
  return dir;
}

// ---------------------------------------------------------------------------
section('挑选「程序目录」');
{
  check(
    '便携版优先用 PORTABLE_EXECUTABLE_DIR（不是 exe 所在目录）',
    pickPortableDir({
      portableEnv: 'D:\\Downloads\\GeLiBot',
      exePath: 'C:\\Users\\x\\AppData\\Local\\Temp\\GeLiBot\\GeLi Bot.exe',
      isPackaged: true,
    }) === 'D:\\Downloads\\GeLiBot',
  );
  check(
    '没有环境变量时退回 exe 所在目录（安装版）',
    pickPortableDir({
      portableEnv: undefined,
      exePath: 'C:\\Program Files\\GeLi Bot\\GeLi Bot.exe',
      isPackaged: true,
    }) === 'C:\\Program Files\\GeLi Bot',
  );
  check(
    '开发模式（未打包）不认 exe 目录，避免指向 node_modules',
    pickPortableDir({
      portableEnv: undefined,
      exePath: path.join('D:', 'proj', 'node_modules', 'electron', 'dist', 'electron.exe'),
      isPackaged: false,
    }) === null,
  );
  check(
    '空字符串环境变量视为未设置',
    pickPortableDir({ portableEnv: '   ', exePath: 'C:\\x\\GeLi Bot.exe', isPackaged: true }) ===
      'C:\\x',
  );
}

// ---------------------------------------------------------------------------
section('程序目录下 data 的识别');
{
  const withData = makePortableDir('withdata');
  const without = makePortableDir('nodata', { withData: false });
  check('exe 旁有 data/config.json → 认这个目录', sidecarDataDir(withData) === path.join(withData, DATA_SUBDIR));
  check('exe 旁只有空 data 目录 → 不认（需要 config.json）', sidecarDataDir(without) === null);
  check('portableDir 为 null → 不认', sidecarDataDir(null) === null);
}

// ---------------------------------------------------------------------------
section('数据目录决策');
{
  const userDataDir = path.join(tmp, 'userdata');

  // 1. 绿色版：exe 旁有 data 且可写
  const portable = makePortableDir('green');
  const d1 = resolveDataDir({ portableDir: portable, userDataDir }, () => true);
  check('exe 旁有 data 且可写 → source=portable', d1.source === 'portable', d1.source);
  check('  dir 指向程序目录下的 data', d1.dir === path.join(portable, DATA_SUBDIR), d1.dir);
  check('  无 warning', d1.warning === undefined);

  // 2. 普通安装：exe 旁没有 data
  const plain = makePortableDir('plain', { withData: false });
  const d2 = resolveDataDir({ portableDir: plain, userDataDir }, () => true);
  check('exe 旁没有 data → source=user', d2.source === 'user', d2.source);
  check('  dir 指向 %APPDATA%/GeLi Bot/data', d2.dir === path.join(userDataDir, DATA_SUBDIR), d2.dir);

  // 3. exe 旁有 data 但不可写（Program Files / 只读 U 盘）
  const d3 = resolveDataDir({ portableDir: portable, userDataDir }, () => false);
  check('exe 旁 data 不可写 → 回退到 user', d3.source === 'user', d3.source);
  check('  回退目标正确', d3.dir === path.join(userDataDir, DATA_SUBDIR), d3.dir);
  check('  给出 warning 提醒用户', typeof d3.warning === 'string' && d3.warning.includes('不可写'));

  // 4. 开发模式（portableDir = null）
  const d4 = resolveDataDir({ portableDir: null, userDataDir }, () => true);
  check('portableDir=null → source=user', d4.source === 'user', d4.source);
  check('  仍指向 userData', d4.dir === path.join(userDataDir, DATA_SUBDIR));
}

// ---------------------------------------------------------------------------
section('「把配置存到程序目录」的规划');
{
  const portable = makePortableDir('plan', { withData: false });
  const currentDir = path.join(tmp, 'userdata', DATA_SUBDIR);

  check(
    '没有程序目录 → 明确报错',
    planMoveToPortable({ portableDir: null, currentDir }).ok === false,
  );

  const already = path.join(portable, DATA_SUBDIR);
  fs.mkdirSync(already, { recursive: true });
  fs.writeFileSync(path.join(already, 'config.json'), '{}');
  const p2 = planMoveToPortable({ portableDir: portable, currentDir: already });
  check('已经在程序目录下 → 拒绝重复移动', p2.ok === false, p2.error);

  const occupied = makePortableDir('occupied'); // 已有 data
  const p3 = planMoveToPortable({ portableDir: occupied, currentDir });
  check('程序目录已有 data → 拒绝覆盖', p3.ok === false && /已经存在/.test(p3.error), p3.error);

  const free = makePortableDir('free', { withData: false });
  const p4 = planMoveToPortable({ portableDir: free, currentDir });
  check('可移动 → 给出目标路径', p4.ok === true && p4.target === path.join(free, DATA_SUBDIR), p4.error);
}

// ---------------------------------------------------------------------------
section('移动文件（真实复制）');
{
  const src = path.join(tmp, 'move-src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'config.json'), '{"a":1}');
  fs.writeFileSync(path.join(src, 'bindings.json'), '[]');
  const target = path.join(tmp, 'move-dst', DATA_SUBDIR);

  moveDataToPortable(src, target);
  check('config.json 已复制', fs.existsSync(path.join(target, 'config.json')));
  check('bindings.json 已复制', fs.existsSync(path.join(target, 'bindings.json')));
  check('内容一致', fs.readFileSync(path.join(target, 'config.json'), 'utf8') === '{"a":1}');
  check('源目录仍在（是复制不是搬走）', fs.existsSync(path.join(src, 'config.json')));
  check(
    '没有残留 .staging 目录',
    !fs.readdirSync(path.dirname(target)).some((f) => f.includes('.staging-')),
  );
}

// ---------------------------------------------------------------------------
section('导出：脱敏与否');
{
  const cfg = createDefaultConfig();
  cfg.rcon.password = 'super-secret';
  cfg.verifyServer.rcon.password = 'verify-secret';
  cfg.onebot.accessToken = 'token-abc';

  const redacted = redactSecrets(cfg);
  check('脱敏后主服密码清空', redacted.rcon.password === '', redacted.rcon.password);
  check('脱敏后验证服密码清空', redacted.verifyServer.rcon.password === '');
  check('脱敏后 AccessToken 清空', redacted.onebot.accessToken === '');
  check('原对象未被改动（深拷贝）', cfg.rcon.password === 'super-secret');

  const noSecret = buildExportBundle(cfg, [], {
    includeSecrets: false,
    productVersion: '1.16.0',
    now: new Date('2026-10-17T00:00:00Z'),
  });
  check('包内标记 secretsIncluded=false', noSecret.secretsIncluded === false);
  check('包内确实没有密码', noSecret.config.rcon.password === '');
  check('kind 正确', noSecret.kind === EXPORT_KIND);
  check('格式版本正确', noSecret.version === EXPORT_FORMAT_VERSION);
  check('导出时间已写入', noSecret.exportedAt === '2026-10-17T00:00:00.000Z');

  const withSecret = buildExportBundle(cfg, [], { includeSecrets: true, productVersion: '1.16.0' });
  check('勾选后保留密码', withSecret.config.rcon.password === 'super-secret');
  check('勾选后标记 secretsIncluded=true', withSecret.secretsIncluded === true);
}

// ---------------------------------------------------------------------------
section('导出文件名');
{
  const name = suggestExportName(new Date(2026, 9, 17)); // 2026-10-17
  check('形如 gelibot-config-YYYYMMDD.json', name === 'gelibot-config-20261017.json', name);
}

// ---------------------------------------------------------------------------
section('导入：解析与校验');
{
  const bundle = {
    app: 'GeLi Bot',
    kind: EXPORT_KIND,
    version: EXPORT_FORMAT_VERSION,
    productVersion: '1.16.0',
    exportedAt: '2026-10-17T00:00:00.000Z',
    secretsIncluded: true,
    config: createDefaultConfig(),
    bindings: [
      { qq: '10001', playerId: 'Steve', createdAt: '2026-01-01T00:00:00.000Z' },
      { qq: '10002', playerId: 'Alex', createdAt: '2026-01-01T00:00:00.000Z' },
      { qq: '', playerId: 'Bad' }, // 缺 qq，应被丢弃
      { qq: '10003' }, // 缺 playerId，应被丢弃
    ],
  };

  const r1 = parseImportBundle(bundle);
  check('标准导出包解析成功', r1.ok === true, r1.error);
  check('  识别为 bundle', r1.ok && r1.value.shape === 'bundle');
  check('  保留 2 条有效绑定', r1.ok && r1.value.bindings.length === 2);
  check('  统计出 2 条被丢弃', r1.ok && r1.value.droppedBindings === 2);
  check('  secretsIncluded 透传', r1.ok && r1.value.secretsIncluded === true);

  const raw = createDefaultConfig();
  const r2 = parseImportBundle(raw);
  check('裸 config.json 也能识别', r2.ok === true, r2.error);
  check('  识别为 raw-config', r2.ok && r2.value.shape === 'raw-config');
  check('  裸配置文件视为含密码', r2.ok && r2.value.secretsIncluded === true);

  const r3 = parseImportBundle({ hello: 'world' });
  check('无关 JSON 被拒绝', r3.ok === false);
  check('  给出可读错误', r3.ok === false && /无法识别/.test(r3.error), r3.ok ? '' : r3.error);

  const r4 = parseImportBundle([1, 2, 3]);
  check('数组被拒绝', r4.ok === false);

  const r5 = parseImportBundle({ kind: EXPORT_KIND, version: 99, config: {} });
  check('来自更新格式版本的文件被拒绝', r5.ok === false);
  check('  提示提到版本', r5.ok === false && /更新版本/.test(r5.error), r5.ok ? '' : r5.error);

  const r6 = parseImportBundle({ kind: EXPORT_KIND, version: 1 });
  check('缺 config 段被拒绝', r6.ok === false && /config/.test(r6.error), r6.ok ? '' : r6.error);

  const r7 = parseImportBundle({
    kind: EXPORT_KIND,
    version: 1,
    config: createDefaultConfig(),
    // bindings 缺失时应视作空数组而不是报错
  });
  check('缺 bindings 段时按空数组处理', r7.ok === true && r7.value.bindings.length === 0);
}

// ---------------------------------------------------------------------------
section('导入：合并而不覆盖');
{
  const current = createDefaultConfig();
  current.rcon.password = '本机密码';
  current.onebot.accessToken = '本机 token';
  current.verifyServer.rcon.password = '本机验证服密码';

  const imported = createDefaultConfig();
  imported.rcon.host = '新主机';
  imported.rcon.password = ''; // 脱敏文件导进来是空的
  imported.onebot.accessToken = '';

  const merged = mergeImportedConfig(imported, current, false);
  check('脱敏导入时保留本机主服密码', merged.rcon.password === '本机密码', merged.rcon.password);
  check('脱敏导入时保留本机 AccessToken', merged.onebot.accessToken === '本机 token');
  check('脱敏导入时保留本机验证服密码', merged.verifyServer.rcon.password === '本机验证服密码');
  check('非敏感字段以导入文件为准', merged.rcon.host === '新主机', merged.rcon.host);

  const withSecrets = createDefaultConfig();
  withSecrets.rcon.password = '导入的密码';
  const merged2 = mergeImportedConfig(withSecrets, current, true);
  check('含密码的导入会覆盖本机密码', merged2.rcon.password === '导入的密码', merged2.rcon.password);

  // 绑定关系去重
  const existing = [
    { qq: '10001', playerId: 'Steve', createdAt: 'x' },
    { qq: '10002', playerId: 'Alex', createdAt: 'x' },
  ];
  const incoming = [
    { qq: '10001', playerId: 'steve', createdAt: 'y' }, // 大小写不同但同一玩家 → 跳过
    { qq: '10002', playerId: 'Alex', createdAt: 'y' }, // 完全重复 → 跳过
    { qq: '10003', playerId: 'Herobrine', createdAt: 'y' }, // 新增
  ];
  const r = mergeBindings(existing, incoming);
  check('重复的绑定被跳过（玩家 ID 大小写不敏感）', r.skipped === 2, `${r.skipped}`);
  check('新绑定被追加', r.added === 1, `${r.added}`);
  check('合并后总数正确', r.list.length === 3, `${r.list.length}`);
  check('原有绑定未被修改', r.list[0].playerId === 'Steve' && r.list[0].createdAt === 'x');
}

// ---------------------------------------------------------------------------
section('导入老版本配置：走迁移链补齐字段');
{
  // 模拟一份 v1.14 时代的配置（没有 verifyServer、没有 binding.messages）
  const legacy = {
    rcon: { host: '10.0.0.1', port: 25575, password: 'pw', timeoutMs: 5000 },
    binding: { mode: 'code', codeLength: 6, codeFormat: 'number', codeTtlSeconds: 300 },
    onebot: { url: 'ws://127.0.0.1:3001', accessToken: '' },
    whitelist: { groupEnabled: true, groups: ['123'], privates: [], admins: [] },
  };
  const parsed = parseImportBundle({
    kind: EXPORT_KIND,
    version: 1,
    config: legacy,
    secretsIncluded: true,
  });
  check('老配置能被解析', parsed.ok === true, parsed.ok ? '' : parsed.error);

  const merged = mergeConfigWithDefaults(parsed.value.config);
  check('补齐 verifyServer 块', typeof merged.verifyServer === 'object');
  check('  验证服默认关闭', merged.verifyServer.enabled === false);
  check('  验证服默认端口 25576', merged.verifyServer.rcon.port === 25576, `${merged.verifyServer.rcon.port}`);
  check('补齐 binding.messages', typeof merged.binding.messages === 'object');
  check('  新增的 codeIssued 文案已补上', typeof merged.binding.messages.codeIssued === 'string');
  check('保留用户填的群号', merged.whitelist.groups[0] === '123');
  check('保留用户填的 RCON 地址', merged.rcon.host === '10.0.0.1', merged.rcon.host);
}

// ---------------------------------------------------------------------------
section('与 Store 联调：导入后真的落盘生效');
{
  const dir = path.join(tmp, 'store-import');
  const store = new Store(dir);
  const before = store.getConfig();
  check('初始密码为空', before.rcon.password === '');

  const importedCfg = createDefaultConfig();
  importedCfg.rcon.host = '162.251.94.89';
  importedCfg.rcon.port = 52051;
  importedCfg.rcon.password = 'imported-pw';
  importedCfg.whitelist.groups = ['337012223'];

  const merged = mergeImportedConfig(mergeConfigWithDefaults(importedCfg), store.getConfig(), true);
  store.saveConfig(merged);

  // 重新打开一个 Store，确认真的写进文件了
  const reopened = new Store(dir);
  const after = reopened.getConfig();
  check('主机已落盘', after.rcon.host === '162.251.94.89', after.rcon.host);
  check('端口已落盘', after.rcon.port === 52051, `${after.rcon.port}`);
  check('密码已落盘', after.rcon.password === 'imported-pw');
  check('群号已落盘', after.whitelist.groups[0] === '337012223');

  // 绑定关系
  store.setBindings([{ qq: '10001', playerId: 'Steve', createdAt: 'x' }]);
  const r2 = new Store(dir);
  check('绑定关系已落盘', r2.listBindings().length === 1);
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(48)}`);
console.log(`数据目录与备份测试：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);
