/**
 * 「把回复文本变成卡片」的纯函数层（不依赖 Electron，可单测）。
 *
 * 核心是 parseReplyToLines：把形形色色的纯文本回复（RCON 输出、帮助菜单、
 * 绑定列表、AI 回答…）猜成有排版意义的行，交给 card-generic 去渲染。
 *
 * 为什么要「猜」而不是让每个功能自己产出结构化数据：
 * 这个项目有 20 多处回复出口，逐个改会造成大量重复代码且容易漏。
 * 在发送层统一解析，新功能不用关心图片这件事。
 */

import type { CardLine, GenericCardData } from './card-generic';
import type { ImageReplyConfig } from '../shared/types';

// 配置类型统一放在 shared/types，这里 re-export 方便同目录模块引用
export type { ImageReplyConfig } from '../shared/types';

/**
 * 指令回复的识别前缀。
 * 同时兼容两种形态：
 *   `/在线 执行结果：`            （结果在后续行）
 *   `/tps 执行结果: 20.0, 20.0`   （结果在同一行）
 */
const RESULT_HEADER = /^(\/\S+)\s*执行结果\s*[:：]\s*(.*)$/;

/** 列表项符号 */
const BULLET = /^[-•·*]\s+/;

/** 「标签：值」里标签的最大长度（超过就不当 kv，避免把整句话切开） */
const MAX_LABEL_LEN = 14;

/**
 * 把一段回复文本解析成卡片行。
 *
 * 规则（从具体到宽泛）：
 * 1. 空行 → 分隔线
 * 2. `/xxx 执行结果：` → 提取为副标题（不占正文）
 * 3. `/指令  -  说明` → 列表项（帮助菜单的形态）
 * 4. `- xxx` / `• xxx` → 列表项
 * 5. `左边：右边` 且左边 ≤ 14 字、右边非空 → 键值行
 * 6. 其余 → 普通段落
 */
export function parseReplyToLines(text: string): { subtitle?: string; lines: CardLine[] } {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const lines: CardLine[] = [];
  let subtitle: string | undefined;

  for (const original of raw) {
    const line = original.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (!trimmed) {
      // 连续空行只留一条分隔线，避免卡片出现大段空白
      if (lines.length > 0 && lines[lines.length - 1].kind !== 'divider') {
        lines.push({ kind: 'divider' });
      }
      continue;
    }

    // /xxx 执行结果：/  /xxx 执行结果: 内容 → 副标题（同行内容并入正文）
    const resultHeader = RESULT_HEADER.exec(trimmed);
    if (resultHeader) {
      subtitle = resultHeader[1];
      const rest = resultHeader[2].trim();
      if (rest) lines.push({ kind: 'text', text: rest });
      continue;
    }

    // 帮助菜单条目：/在线  -  查询在线玩家
    if (trimmed.startsWith('/') && /\s+-\s+/.test(trimmed)) {
      lines.push({ kind: 'item', text: trimmed });
      continue;
    }

    // 项目符号
    if (BULLET.test(trimmed)) {
      lines.push({ kind: 'item', text: trimmed.replace(BULLET, '') });
      continue;
    }

    // 键值：找第一个冒号，判断左侧长度
    const sep = findKeyValueSeparator(trimmed);
    if (sep) {
      lines.push({ kind: 'kv', label: sep.label, value: sep.value });
      continue;
    }

    lines.push({ kind: 'text', text: trimmed });
  }

  // 去掉首尾的分隔线
  while (lines.length > 0 && lines[0].kind === 'divider') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].kind === 'divider') lines.pop();

  return { subtitle, lines };
}

/** 找出「标签：值」的分隔点；不满足条件返回 null */
function findKeyValueSeparator(
  text: string,
): { label: string; value: string } | null {
  // 中文全角冒号优先（中文回复最常见），其次英文冒号 + 空格
  const full = text.indexOf('：');
  const half = text.indexOf(': ');

  let idx = -1;
  let sepLen = 1;
  if (full > 0 && (half === -1 || full < half)) {
    idx = full;
    sepLen = 1;
  } else if (half > 0) {
    idx = half;
    sepLen = 2;
  }
  if (idx <= 0) return null;

  const label = text.slice(0, idx).trim();
  const value = text.slice(idx + sepLen).trim();
  if (!label || !value) return null;
  if (label.length > MAX_LABEL_LEN) return null;
  // 标签里不该有句子感（句号/问号/逗号说明这是正文）
  if (/[。？！，,?]/.test(label)) return null;
  return { label, value };
}

/**
 * 判断一段回复该不该转成图片。
 *
 * 短回复（一句话）出图反而更费眼 —— 群里看一行字比点开一张图快。
 * 所以只有「够长或够多行」才转。
 */
export function shouldRenderImage(text: string, cfg: ImageReplyConfig): boolean {
  if (!cfg.enabled) return false;
  const t = String(text ?? '').trim();
  if (!t) return false;
  // 已经是图片 / 含 CQ 码的富文本，不再包一层
  if (t.includes('[CQ:image')) return false;

  const lineCount = t.split('\n').filter((l) => l.trim()).length;
  const minLines = Math.max(1, cfg.minLines);
  const minChars = Math.max(0, cfg.minChars);
  return lineCount >= minLines || t.length >= minChars;
}

/** 组装通用卡片数据 */
export function buildReplyCard(
  text: string,
  opts: {
    title?: string;
    ok?: boolean;
    footer?: string;
  } = {},
): GenericCardData {
  const { subtitle, lines } = parseReplyToLines(text);
  const data: GenericCardData = {
    title: opts.title ?? '执行结果',
    lines,
    footer: opts.footer,
  };
  if (subtitle) data.subtitle = subtitle;
  if (opts.ok !== undefined) {
    data.badge = opts.ok
      ? { text: '成功', tone: 'ok' }
      : { text: '失败', tone: 'err' };
  }
  return data;
}
