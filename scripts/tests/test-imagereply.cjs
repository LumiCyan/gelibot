/**
 * 图片回复的纯函数测试：文本解析 / 阈值判断 / HTML 转义 / 卡片落盘。
 *
 * 这几层都不依赖 Electron，所以能直接跑。
 * 重点是「HTML 转义」—— 内容来自 RCON 输出、QQ 昵称、AI 回复，
 * 任何一处漏转义都可能破坏文档结构。
 *
 * 运行：npm test（会先 build:main）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseReplyToLines,
  shouldRenderImage,
  buildReplyCard,
} = require('../../dist/main/image-reply-util.js');
const { buildGenericCardHtml } = require('../../dist/main/card-generic.js');
const { writeCardMessage, pruneCards } = require('../../dist/main/card-file.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  ✘ ${name}${extra ? '：' + extra : ''}`);
  }
}

// ============================================================
// 一、parseReplyToLines
// ============================================================

{
  const r = parseReplyToLines('/在线 执行结果：\nThere are 3 of a max of 20 players online');
  check('执行结果头被提为副标题', r.subtitle === '/在线');
  check('副标题不占正文', r.lines.length === 1);
  check('正文保留原文', r.lines[0].text.includes('3 of a max of 20'));
}
{
  // 半角冒号版本
  const r = parseReplyToLines('/tps 执行结果: 20.0, 20.0, 20.0');
  check('英式冒号也能识别副标题', r.subtitle === '/tps');
}

{
  const r = parseReplyToLines('- 第一条\n- 第二条\n• 第三条\n* 第四条');
  check('四种项目符号都识别', r.lines.every((l) => l.kind === 'item'));
  check('项目符号被去掉', r.lines[0].text === '第一条');
}

{
  const r = parseReplyToLines('/在线  -  查询在线玩家\n/tps  -  查询 TPS');
  check('帮助菜单条目识别为 item', r.lines.every((l) => l.kind === 'item'));
  check('帮助条目保留整行', r.lines[0].text.includes('/在线'));
}

{
  const r = parseReplyToLines('玩家ID：Steve\n绑定QQ：10001\n来源群：123456');
  check('键值行识别', r.lines.every((l) => l.kind === 'kv'));
  check('标签正确', r.lines[0].label === '玩家ID');
  check('值正确', r.lines[0].value === 'Steve');
}
{
  const r = parseReplyToLines('在线人数: 3');
  check('英式冒号键值识别', r.lines[0].kind === 'kv' && r.lines[0].value === '3');
}

{
  // 标签过长 → 不当键值，避免把整句切开
  const longLabel = '这是一段特别长的文字用来当作标签应该被拒绝处理';
  const r = parseReplyToLines(`${longLabel}：值`);
  check('超长标签不当键值', r.lines[0].kind === 'text');
}
{
  // 标签里有句号 → 说明是正文
  const r = parseReplyToLines('他说了句。然后：走了');
  check('标签含句号不当键值', r.lines[0].kind === 'text');
}
{
  // 冒号后为空 → 不当键值
  const r = parseReplyToLines('可用指令：');
  check('冒号后为空不当键值', r.lines[0].kind === 'text');
}
{
  // 冒号在最前面（无标签）
  const r = parseReplyToLines('：没有标签');
  check('无标签不当键值', r.lines[0].kind === 'text');
}

{
  const r = parseReplyToLines('第一段\n\n第二段');
  check('空行变成分隔线', r.lines[1].kind === 'divider');
}
{
  const r = parseReplyToLines('第一段\n\n\n\n第二段');
  check('连续空行只留一条分隔线', r.lines.filter((l) => l.kind === 'divider').length === 1);
}
{
  const r = parseReplyToLines('\n\n正文\n\n');
  check('首部分隔线被去掉', r.lines[0].kind === 'text');
  check('尾部分隔线被去掉', r.lines[r.lines.length - 1].kind === 'text');
}

{
  const r = parseReplyToLines('');
  check('空串返回空行数组', r.lines.length === 0);
  check('空串无副标题', r.subtitle === undefined);
}
{
  const r = parseReplyToLines('   \n  \n ');
  check('纯空白返回空行数组', r.lines.length === 0);
}

{
  // 支持 § 颜色码的文本（清洗在 service 层，解析层应原样保留）
  const r = parseReplyToLines('§a绿色文字');
  check('解析层不剥颜色码', r.lines[0].text === '§a绿色文字');
}

// ============================================================
// 二、shouldRenderImage
// ============================================================

const baseCfg = { enabled: true, scope: 'command', minLines: 3, minChars: 60, keepFiles: 60, showTime: true };

check('关闭时不转图', shouldRenderImage('a\nb\nc\nd', { ...baseCfg, enabled: false }) === false);
check('空文本不转图', shouldRenderImage('', baseCfg) === false);
check('纯空白不转图', shouldRenderImage('   \n  ', baseCfg) === false);

check('行数达标转图', shouldRenderImage('a\nb\nc', baseCfg) === true);
check('行数不足不转图', shouldRenderImage('a\nb', baseCfg) === false);
check('字数达标转图', shouldRenderImage('x'.repeat(60), baseCfg) === true);
check('字数不足不转图', shouldRenderImage('x'.repeat(59), baseCfg) === false);
check(
  '行数与字数是「或」关系',
  shouldRenderImage('a\nb\nc', { ...baseCfg, minChars: 9999 }) === true,
);

check(
  '已是图片的消息不再包一层',
  shouldRenderImage('[CQ:image,file=http://x/y.png]', baseCfg) === false,
);
check(
  '含图片的混合消息也不转',
  shouldRenderImage('看这个[CQ:image,file=a.png]很长很长很长很长很长很长很长很长很长很长', baseCfg) === false,
);

// 阈值可调
check('阈值为 1 行时单行也转', shouldRenderImage('一句话', { ...baseCfg, minLines: 1, minChars: 0 }) === true);

// ============================================================
// 三、buildReplyCard
// ============================================================

{
  const c = buildReplyCard('/tps 执行结果：\n20.0');
  check('卡片默认标题', c.title === '执行结果');
  check('卡片带副标题', c.subtitle === '/tps');
  check('卡片有正文', c.lines.length === 1);
}
{
  check('ok=true 出成功徽章', buildReplyCard('x', { ok: true }).badge?.tone === 'ok');
  check('ok=false 出失败徽章', buildReplyCard('x', { ok: false }).badge?.tone === 'err');
  check('不传 ok 无徽章', buildReplyCard('x').badge === undefined);
  check('自定义标题生效', buildReplyCard('x', { title: '绑定信息' }).title === '绑定信息');
}

// ============================================================
// 四、buildGenericCardHtml（转义是重点）
// ============================================================

const ICON = 'data:image/png;base64,AAA';

{
  const html = buildGenericCardHtml(
    {
      title: '标题',
      subtitle: '副标题',
      badge: { text: '成功', tone: 'ok' },
      lines: [{ kind: 'text', text: '正文' }],
      footer: '页脚',
    },
    { iconUri: ICON, width: 600 },
  );
  check('HTML 含标题', html.includes('标题'));
  check('HTML 含副标题', html.includes('副标题'));
  check('HTML 含徽章', html.includes('成功'));
  check('HTML 含正文', html.includes('正文'));
  check('HTML 含页脚', html.includes('页脚'));
  check('宽度被替换', html.includes('600') && !html.includes('__WIDTH__'));
  check('图标被替换', html.includes(ICON) && !html.includes('__ICON__'));
  check('没有残留占位符', !/__[A-Z_]+__/.test(html));
}

{
  // 关键：XSS / 结构破坏
  const html = buildGenericCardHtml(
    {
      title: '<script>alert(1)</script>',
      lines: [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }],
    },
    { iconUri: ICON, width: 600 },
  );
  check('标题里的 script 被转义', !html.includes('<script>alert(1)</script>'));
  check('标题转义成实体', html.includes('&lt;script&gt;'));
  check('正文里的 img 被转义', html.includes('&lt;img src=x'));
  check('没有可执行的 onerror', !html.includes('onerror=alert(1)">'));
}
{
  const html = buildGenericCardHtml(
    { title: '引号"测试"', lines: [{ kind: 'kv', label: 'a"b', value: "c'd" }] },
    { iconUri: ICON, width: 600 },
  );
  check('双引号被转义', html.includes('&quot;'));
  check('单引号被转义', html.includes('&#39;'));
}
{
  // 所有行类型都能渲染
  const html = buildGenericCardHtml(
    {
      title: 't',
      lines: [
        { kind: 'text', text: 'a' },
        { kind: 'mono', text: 'b' },
        { kind: 'kv', label: 'k', value: 'v' },
        { kind: 'item', text: 'i', badge: '徽章' },
        { kind: 'divider' },
      ],
    },
    { iconUri: ICON, width: 600 },
  );
  check('text 行渲染', html.includes('class="t"'));
  check('mono 行渲染', html.includes('class="mono"'));
  check('kv 行渲染', html.includes('class="kv"'));
  check('item 行渲染', html.includes('class="item"'));
  check('item 徽章渲染', html.includes('class="ib"'));
  check('分隔线渲染', html.includes('class="hr"'));
}
{
  // 四种徽章配色都能取到（不能有 undefined）
  for (const tone of ['ok', 'warn', 'err', 'info']) {
    const html = buildGenericCardHtml(
      { title: 't', badge: { text: 'b', tone }, lines: [] },
      { iconUri: ICON, width: 600 },
    );
    check(`徽章配色 ${tone} 正常`, !html.includes('undefined'));
  }
}
{
  const html = buildGenericCardHtml(
    { title: 't', lines: [{ kind: 'text', text: 'a' }] },
    { iconUri: ICON, width: 600 },
  );
  // 没有 footer 也会保留底部一行 —— 那里放品牌与水印
  check('无页脚时保留品牌行', html.includes('class="foot"') && html.includes('GeLi Bot'));
}

// ---------- 视觉：主题 / 宽度 / 缩放 / 水印 ----------

{
  const dark = buildGenericCardHtml({ title: 't', lines: [] }, { iconUri: ICON, width: 600, theme: 'dark' });
  const light = buildGenericCardHtml({ title: 't', lines: [] }, { iconUri: ICON, width: 600, theme: 'light' });
  check('深色主题背景', dark.includes('#17191d'));
  check('浅色主题背景', light.includes('#ffffff'));
  check('两主题输出不同', dark !== light);
  check(
    '不传主题默认深色',
    buildGenericCardHtml({ title: 't', lines: [] }, { iconUri: ICON, width: 600 }).includes('#17191d'),
  );
}
{
  const html = buildGenericCardHtml(
    { title: 't', lines: [] },
    { iconUri: ICON, width: 600, watermark: '生存服' },
  );
  check('水印被渲染', html.includes('生存服'));
  check('水印与品牌连排', html.includes('GeLi Bot · 生存服'));
}
{
  const html = buildGenericCardHtml({ title: 't', lines: [] }, { iconUri: ICON, width: 600, watermark: '' });
  check('空水印只显示品牌', html.includes('>GeLi Bot<'));
}
{
  const html = buildGenericCardHtml({ title: 't', lines: [] }, { iconUri: ICON, width: 600, scale: 1.1 });
  check('缩放注入 CSS 变量', html.includes('--s: 1.1'));
  check(
    '缩放上界被夹住',
    buildGenericCardHtml({ title: 't', lines: [] }, { iconUri: ICON, width: 600, scale: 9 }).includes('--s: 1.3'),
  );
  check(
    '缩放下界被夹住',
    buildGenericCardHtml({ title: 't', lines: [] }, { iconUri: ICON, width: 600, scale: 0.1 }).includes('--s: 0.8'),
  );
}
{
  const html = buildGenericCardHtml({ title: 't', lines: [] }, { iconUri: ICON, width: 720 });
  check('宽度注入', html.includes('width: 720px'));
  check(
    '过窄被夹到 320',
    buildGenericCardHtml({ title: 't', lines: [] }, { iconUri: ICON, width: 100 }).includes('width: 320px'),
  );
  check(
    '过宽被夹到 1000',
    buildGenericCardHtml({ title: 't', lines: [] }, { iconUri: ICON, width: 5000 }).includes('width: 1000px'),
  );
}
{
  // 水印同样要转义，防止用户在水印里写 HTML
  const html = buildGenericCardHtml(
    { title: 't', lines: [] },
    { iconUri: ICON, width: 600, watermark: '<b>x</b>' },
  );
  check('水印里的 HTML 被转义', !html.includes('<b>x</b>') && html.includes('&lt;b&gt;'));
}

// ============================================================
// 五、卡片落盘与前缀隔离
// ============================================================

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gelibot-card-'));
  try {
    const png1 = Buffer.from('fake-png-1');
    const msg1 = writeCardMessage(dir, png1, { prefix: 'reply' });
    check('返回 CQ 图片码', msg1.startsWith('[CQ:image,file='));
    check('文件名带 reply 前缀', msg1.includes('reply-'));

    // 同内容复用同一文件
    const msg2 = writeCardMessage(dir, png1, { prefix: 'reply' });
    check('相同内容复用文件', msg1 === msg2);

    // 不同内容产生新文件
    const msg3 = writeCardMessage(dir, Buffer.from('fake-png-2'), { prefix: 'reply' });
    check('不同内容新文件', msg3 !== msg1);
    check('目录里有 2 张图', fs.readdirSync(dir).length === 2);

    // 前缀隔离：online 与 reply 各自清理，不互相删
    writeCardMessage(dir, Buffer.from('online-a'), { prefix: 'online' });
    check('online 前缀独立命名', fs.readdirSync(dir).some((f) => f.startsWith('online-')));
    pruneCards(dir, 10, undefined, 'reply');
    check(
      '按 reply 前缀清理不影响 online',
      fs.readdirSync(dir).some((f) => f.startsWith('online-')),
    );

    // 非法前缀被清洗成安全字符
    const msgBad = writeCardMessage(dir, Buffer.from('x'), { prefix: '../evil' });
    check('非法前缀被清洗', !msgBad.includes('..'));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
}

console.log(`图片回复测试：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
