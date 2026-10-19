/**
 * AI 模块的纯函数（不依赖 electron，可独立单测）。
 *
 * 与 version.ts 同一思路：把「判定/清洗」逻辑从网络层剥出来，
 * 这样单元测试不需要跑在 electron 里，也不需要真实 API Key。
 */

/** 一条对话消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 回复长度硬上限（QQ 单条消息放不下更长的内容，也会刷屏） */
export const MAX_REPLY_LENGTH = 600;

/**
 * 清洗 AI 输出。
 *
 * 这一步不是「锦上添花」而是**必须的**：模型可能被用户诱导输出
 * `[CQ:image,file=...]` 或 `[CQ:at,qq=all]` 这类 CQ 码，
 * 直接发出去就等于让群成员通过提示词注入操作机器人。
 */
export function sanitizeAIReply(text: string, maxLength = MAX_REPLY_LENGTH): string {
  let out = String(text ?? '');
  // 剥离所有 CQ 码（图片/@/表情/文件…）
  out = out.replace(/\[CQ:[^\]]*\]/gi, '');
  // 去掉代码块围栏与行内反引号
  out = out.replace(/```[a-zA-Z0-9]*\n?/g, '').replace(/`/g, '');
  // 去掉常见 Markdown 标记（粗体/斜体/标题/列表符）
  out = out.replace(/\*\*/g, '').replace(/__/g, '').replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/^[>\-+]\s+/gm, '');
  // 去掉颜色码
  out = out.replace(/§./g, '');
  // 压缩空白
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (maxLength > 0 && out.length > maxLength) {
    out = `${out.slice(0, maxLength - 1)}…`;
  }
  return out;
}

/**
 * 裁剪上下文到最近 N 轮。
 *
 * 一轮 = 一条 user + 它之后的回复。实现方式不是「取最后 2N 条」——
 * 那样在对话末尾正好停在一句 user 提问（还没回答）时，会截出
 * 「assistant 开头」的畸形上下文，部分服务商会直接返回 400。
 *
 * 正确做法：先找出所有 user 的位置，保留「最后 N 个 user」及其之后的内容。
 * 这样无论末尾停在 user 还是 assistant，切出来的结构都合法。
 */
export function trimContext(messages: ChatMessage[], turns: number): ChatMessage[] {
  if (turns <= 0) return [];
  const userIndexes: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') userIndexes.push(i);
  });
  if (userIndexes.length === 0) return [];
  const keepFrom = userIndexes[Math.max(0, userIndexes.length - turns)];
  return messages.slice(keepFrom);
}

/** 把 HTTP 错误翻译成用户能看懂的话 */
export function translateAIError(status: number, body: string): string {
  const snippet = (body || '').slice(0, 200);
  if (status === 401 || status === 403) {
    return 'API Key 无效或无权限，请检查「AI 设置」里的 Key';
  }
  if (status === 404) {
    return '接口地址或模型名不对（HTTP 404）。请确认 baseUrl 是否需要带 /v1，以及模型名是否存在';
  }
  if (status === 429) {
    return '调用太频繁或额度已用完（HTTP 429），请稍后再试';
  }
  if (status === 400) {
    return `请求被拒绝（HTTP 400）：${snippet}`;
  }
  if (status >= 500) {
    return `AI 服务端错误（HTTP ${status}），稍后再试`;
  }
  return `AI 调用失败（HTTP ${status}）：${snippet}`;
}

/** 判断两个日期字符串是否同一天（用于配额重置） */
export function isSameDay(a: string, b: string): boolean {
  return a === b;
}

/** 取本地日期字符串 YYYY-MM-DD */
export function todayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 从响应体里取正文。
 * 兼容标准 OpenAI 格式与部分服务商/网关的等价字段。
 */
export function extractContent(body: unknown): string {
  const b = body as {
    choices?: Array<{ message?: { content?: string }; text?: string }>;
    output_text?: string;
  };
  if (!b) return '';
  if (typeof b.output_text === 'string' && b.output_text.trim()) return b.output_text;
  const first = b.choices?.[0];
  if (!first) return '';
  if (typeof first.message?.content === 'string') return first.message.content;
  if (typeof first.text === 'string') return first.text;
  return '';
}
