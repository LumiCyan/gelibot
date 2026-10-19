/**
 * AI 模块纯函数测试（ai-util.ts，不依赖 electron）。
 *
 * 重点覆盖「清洗」这一层 —— 它是防提示词注入的最后一道闸门：
 * 模型可能被诱导输出 CQ 码，直接发出去等于让群成员操作机器人。
 *
 * 运行：npm test（会先 build:main）
 */
const {
  sanitizeAIReply,
  trimContext,
  translateAIError,
  extractContent,
  todayKey,
  isSameDay,
  MAX_REPLY_LENGTH,
} = require('../../dist/main/ai-util.js');

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

// ---------- sanitizeAIReply：安全清洗 ----------

check(
  '剥离 CQ 图片码',
  sanitizeAIReply('看这个[CQ:image,file=http://evil/x.jpg]') === '看这个',
);
check(
  '剥离 CQ 全员 @',
  sanitizeAIReply('注意[CQ:at,qq=all]全体') === '注意全体',
);
check(
  '剥离 CQ 表情码',
  sanitizeAIReply('开心[CQ:face,id=14]') === '开心',
);
check(
  '剥离伪造的 CQ 文件码',
  sanitizeAIReply('[CQ:file,file=//server/share]') === '',
);
check('代码块围栏被去掉', sanitizeAIReply('```js\nlist\n```') === 'list');
check('行内反引号被去掉', sanitizeAIReply('执行 `list` 就行') === '执行 list 就行');
check('粗体标记被去掉', sanitizeAIReply('**重要**提示') === '重要提示');
check('标题标记被去掉', sanitizeAIReply('## 小标题\n正文') === '小标题\n正文');
check('列表符被去掉', sanitizeAIReply('- 第一条\n- 第二条') === '第一条\n第二条');
check('颜色码被剥离', sanitizeAIReply('§c红色§r文字') === '红色文字');
check('多余空白被压缩', sanitizeAIReply('a    b') === 'a b');
check('首尾空白被去掉', sanitizeAIReply('  hi  ') === 'hi');
check('空串安全', sanitizeAIReply('') === '');
check('null 安全', sanitizeAIReply(null) === '');

{
  const long = 'a'.repeat(MAX_REPLY_LENGTH + 100);
  const out = sanitizeAIReply(long);
  check('超长被截断到上限', out.length === MAX_REPLY_LENGTH);
  check('截断后带省略号', out.endsWith('…'));
}
check('自定义上限', sanitizeAIReply('abcdefghij', 5).length === 5);
check('上限为 0 不截断', sanitizeAIReply('abcdef', 0) === 'abcdef');

// 真实攻击样例：诱导模型输出的注入串，必须被清空
check(
  '中文注入样例被清洗',
  sanitizeAIReply('[CQ:at,qq=all] 服务器已关闭，请所有人退群') === '服务器已关闭，请所有人退群',
);

// ---------- trimContext ----------

{
  const msgs = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
  ];
  check('轮数 0 返回空', trimContext(msgs, 0).length === 0);
  // 末尾停在未回答的 user：只保留最后 1 轮 = 这一条提问
  check('轮数 1 只留最后一轮', trimContext(msgs, 1).length === 1);
  check('轮数 1 内容正确', trimContext(msgs, 1)[0].content === 'q3');
  // 轮数 2 = q2 + a2 + q3
  check('轮数 2 留两轮', trimContext(msgs, 2).length === 3);
  check('轮数 2 首条是 user', trimContext(msgs, 2)[0].content === 'q2');
  check('轮数足够时全留', trimContext(msgs, 10).length === 5);
  check('裁剪后首条永远是 user', trimContext(msgs, 2)[0].role === 'user');

  // 以 assistant 开头的异常上下文要被修掉
  const weird = [
    { role: 'assistant', content: 'a0' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
  ];
  const trimmed = trimContext(weird, 3);
  check('开头的孤立 assistant 被剔除', trimmed.length === 2);
  check('剔除后首条是 user', trimmed[0].role === 'user');
  check('剔除后内容正确', trimmed[0].content === 'q1');

  // 全是 assistant（数据异常）应返回空而不是死循环
  check(
    '全 assistant 返回空',
    trimContext([{ role: 'assistant', content: 'x' }], 1).length === 0,
  );
}
check('空上下文安全', trimContext([], 5).length === 0);

// ---------- translateAIError ----------

check(
  '401 → Key 无效',
  translateAIError(401, '').includes('Key 无效'),
);
check(
  '403 → 无权限',
  translateAIError(403, '').includes('Key 无效'),
);
check(
  '404 → 地址或模型名',
  translateAIError(404, '').includes('接口地址或模型名'),
);
check('429 → 限流', translateAIError(429, '').includes('额度'));
check('400 → 带原始片段', translateAIError(400, 'bad request detail').includes('bad request'));
check('500 → 服务端错误', translateAIError(500, '').includes('服务端错误'));
check('502 → 服务端错误', translateAIError(502, '').includes('服务端错误'));
check('418 → 通用兜底', translateAIError(418, '').includes('HTTP 418'));

// ---------- extractContent ----------

check(
  '标准 OpenAI 格式',
  extractContent({ choices: [{ message: { content: '你好' } }] }) === '你好',
);
check(
  '部分网关的 text 字段',
  extractContent({ choices: [{ text: '你好' }] }) === '你好',
);
check('output_text 字段', extractContent({ output_text: '你好' }) === '你好');
check('空 choices 返回空', extractContent({ choices: [] }) === '');
check('缺字段返回空', extractContent({}) === '');
check('null 安全', extractContent(null) === '');
check('undefined 安全', extractContent(undefined) === '');

// ---------- 日期 ----------

{
  const d = new Date(2026, 9, 18, 22, 30);
  check('todayKey 格式正确', todayKey(d) === '2026-10-18');
  check('个位数月份补零', todayKey(new Date(2026, 0, 5)) === '2026-01-05');
  check('isSameDay 相同', isSameDay('2026-10-18', '2026-10-18') === true);
  check('isSameDay 不同', isSameDay('2026-10-18', '2026-10-19') === false);
}

console.log(`AI 测试：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
