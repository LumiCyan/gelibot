/**
 * 通用卡片模板：任意「回复文本」→ 一张图。
 *
 * 与在线人数卡片（card-template.ts）分开的原因：
 * 那个是专用结构（人数/进度条/头像网格），这里要的是「什么内容都能放」，
 * 所以用「行数组」模型 —— 每行一个语义类型，模板只负责排版。
 *
 * 视觉可配（主题 / 宽度 / 字号缩放 / 水印），因为「图片渲染」在本项目里
 * 已经独立成一个功能域，不再只是「回复要不要出图」的开关。
 *
 * 与 card-template.ts 一样是纯字符串拼装：可单测、不依赖 Electron。
 */

import type { CardTheme } from '../shared/types';

export type CardLine =
  /** 普通段落 */
  | { kind: 'text'; text: string }
  /** 等宽块（RCON 原始输出、代码、表格对齐内容） */
  | { kind: 'mono'; text: string }
  /** 键值行（左标签右值） */
  | { kind: 'kv'; label: string; value: string }
  /** 列表项，可带右侧徽章（例如「已绑定」「管理员」） */
  | { kind: 'item'; text: string; badge?: string }
  /** 分隔线 */
  | { kind: 'divider' };

export type CardTone = 'ok' | 'warn' | 'err' | 'info';

export interface GenericCardData {
  /** 主标题 */
  title: string;
  /** 副标题（通常放触发的指令名） */
  subtitle?: string;
  /** 右上角徽章 */
  badge?: { text: string; tone: CardTone };
  /** 正文行 */
  lines: CardLine[];
  /** 底部小字 */
  footer?: string;
}

/** 卡片渲染参数 */
export interface CardVisualOptions {
  iconUri: string;
  /** 卡片宽度（CSS px） */
  width: number;
  /** 主题 */
  theme?: CardTheme;
  /** 字号缩放（0.85 ~ 1.25） */
  scale?: number;
  /** 水印文字（显示在底部右侧，空则不显示） */
  watermark?: string;
}

/** 两套主题的配色 */
const THEMES: Record<
  CardTheme,
  {
    cardBg: string;
    border: string;
    title: string;
    text: string;
    muted: string;
    dim: string;
    blockBg: string;
    line: string;
  }
> = {
  dark: {
    cardBg: '#17191d',
    border: 'transparent',
    title: '#e8eaed',
    text: '#d7dae0',
    muted: '#9aa0a6',
    dim: '#6b7076',
    blockBg: '#1e2227',
    line: '#262a30',
  },
  light: {
    cardBg: '#ffffff',
    border: '#e2e8f0',
    title: '#16202b',
    text: '#2b3542',
    muted: '#64748b',
    dim: '#8a97a6',
    blockBg: '#f4f7fa',
    line: '#e6ebf1',
  },
};

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 徽章配色 */
const TONE_COLOR: Record<CardTone, { fg: string; bd: string; bg: string }> = {
  ok: { fg: '#4ade80', bd: 'rgba(74,222,128,.45)', bg: 'rgba(74,222,128,.08)' },
  warn: { fg: '#fbbf24', bd: 'rgba(251,191,36,.45)', bg: 'rgba(251,191,36,.08)' },
  err: { fg: '#f87171', bd: 'rgba(248,113,113,.45)', bg: 'rgba(248,113,113,.08)' },
  info: { fg: '#8ab4f8', bd: 'rgba(138,180,248,.45)', bg: 'rgba(138,180,248,.08)' },
};

/**
 * 模板。
 *
 * 字号统一写成 `calc(Npx * var(--s))`，`--s` 由配置注入 ——
 * 这样只改一个变量就能整体缩放，不必为每一处字号各写一套。
 */
const TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: transparent; }
  body {
    width: __WIDTH__px; --s: __SCALE__;
    font-family: "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  }
  .card {
    width: __WIDTH__px; border-radius: 18px; background: __C_CARD_BG__;
    border: 1px solid __C_BORDER__;
    padding: 22px 26px 18px; color: __C_TEXT__;
    display: flex; flex-direction: column;
  }

  /* ---------- 头部 ---------- */
  .head { display: flex; align-items: center; gap: 12px; }
  .logo { width: 40px; height: 40px; border-radius: 11px; flex: none; object-fit: contain; }
  .htext { min-width: 0; }
  .title {
    font-size: calc(19px * var(--s)); font-weight: 700; letter-spacing: .2px;
    line-height: 1.25; color: __C_TITLE__;
  }
  .sub { font-size: calc(12px * var(--s)); color: __C_MUTED__; margin-top: 3px; }
  .badge {
    margin-left: auto; font-size: calc(12px * var(--s)); white-space: nowrap;
    padding: 5px 11px; border-radius: 999px; flex: none;
  }

  /* ---------- 正文 ---------- */
  .body { margin-top: 16px; display: flex; flex-direction: column; gap: 7px; }
  .t {
    font-size: calc(13.5px * var(--s)); line-height: 1.65;
    color: __C_TEXT__; word-break: break-word;
  }
  .mono {
    font-family: "Consolas", "Courier New", monospace;
    font-size: calc(12.5px * var(--s)); line-height: 1.6;
    background: __C_BLOCK_BG__; border-radius: 10px; padding: 11px 13px;
    color: __C_TEXT__; white-space: pre-wrap; word-break: break-word;
  }
  .kv { display: flex; align-items: baseline; gap: 10px; font-size: calc(13px * var(--s)); }
  .kv .k { color: __C_MUTED__; flex: none; min-width: 96px; }
  .kv .v { color: __C_TEXT__; word-break: break-word; }
  .item {
    display: flex; align-items: center; gap: 9px;
    font-size: calc(13px * var(--s));
    background: __C_BLOCK_BG__; border-radius: 9px; padding: 8px 12px;
  }
  .item .dot { width: 5px; height: 5px; border-radius: 50%; background: #4ade80; flex: none; }
  .item .it { flex: 1; min-width: 0; word-break: break-word; }
  .item .ib {
    font-size: calc(11px * var(--s)); color: __C_MUTED__;
    border: 1px solid __C_LINE__; border-radius: 999px; padding: 2px 8px; flex: none;
  }
  .hr { height: 1px; background: __C_LINE__; margin: 3px 0; }

  /* ---------- 底部 ---------- */
  .foot {
    margin-top: 16px; display: flex; justify-content: space-between; gap: 12px;
    font-size: calc(11px * var(--s)); color: __C_DIM__;
  }
  .foot .wm { text-align: right; opacity: .85; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <img class="logo" src="__ICON__" alt="">
      <div class="htext">
        <div class="title">__TITLE__</div>
        __SUB__
      </div>
      __BADGE__
    </div>
    <div class="body">__BODY__</div>
    __FOOT__
  </div>
</body>
</html>`;

/** 渲染单行 */
function renderLine(line: CardLine): string {
  switch (line.kind) {
    case 'text':
      return `<div class="t">${escapeHtml(line.text)}</div>`;
    case 'mono':
      return `<div class="mono">${escapeHtml(line.text)}</div>`;
    case 'kv':
      return (
        `<div class="kv"><span class="k">${escapeHtml(line.label)}</span>` +
        `<span class="v">${escapeHtml(line.value)}</span></div>`
      );
    case 'item':
      return (
        `<div class="item"><span class="dot"></span><span class="it">${escapeHtml(line.text)}</span>` +
        (line.badge ? `<span class="ib">${escapeHtml(line.badge)}</span>` : '') +
        `</div>`
      );
    case 'divider':
      return '<div class="hr"></div>';
    default:
      return '';
  }
}

/**
 * 生成完整卡片 HTML。
 *
 * 所有插值均 HTML 转义 —— 内容可能来自 RCON 输出、QQ 昵称、AI 回复，
 * 任何一处漏转义都可能破坏文档结构。
 */
export function buildGenericCardHtml(
  data: GenericCardData,
  opts: CardVisualOptions,
): string {
  const theme = THEMES[opts.theme ?? 'dark'] ?? THEMES.dark;
  const width = Math.max(320, Math.min(1000, Math.round(opts.width || 600)));
  const scale = Math.max(0.8, Math.min(1.3, Number(opts.scale) || 1));

  const sub = data.subtitle
    ? `<div class="sub">${escapeHtml(data.subtitle)}</div>`
    : '';

  let badge = '';
  if (data.badge) {
    const c = TONE_COLOR[data.badge.tone] ?? TONE_COLOR.info;
    badge =
      `<div class="badge" style="color:${c.fg};border:1px solid ${c.bd};background:${c.bg}">` +
      `${escapeHtml(data.badge.text)}</div>`;
  }

  const body = data.lines.map(renderLine).join('');

  // 底部：左侧时间/说明，右侧品牌 + 可选水印
  const watermark = (opts.watermark ?? '').trim();
  const brand = watermark ? `GeLi Bot · ${escapeHtml(watermark)}` : 'GeLi Bot';
  const foot = data.footer
    ? `<div class="foot"><span>${escapeHtml(data.footer)}</span><span class="wm">${brand}</span></div>`
    : `<div class="foot"><span></span><span class="wm">${brand}</span></div>`;

  return TEMPLATE.replace(/__WIDTH__/g, String(width))
    .replace(/__SCALE__/g, String(scale))
    .replace(/__C_CARD_BG__/g, theme.cardBg)
    .replace(/__C_BORDER__/g, theme.border)
    .replace(/__C_TITLE__/g, theme.title)
    .replace(/__C_TEXT__/g, theme.text)
    .replace(/__C_MUTED__/g, theme.muted)
    .replace(/__C_DIM__/g, theme.dim)
    .replace(/__C_BLOCK_BG__/g, theme.blockBg)
    .replace(/__C_LINE__/g, theme.line)
    .replace(/__ICON__/g, opts.iconUri)
    .replace(/__TITLE__/g, escapeHtml(data.title))
    .replace(/__SUB__/g, sub)
    .replace(/__BADGE__/g, badge)
    .replace(/__BODY__/g, body)
    .replace(/__FOOT__/g, foot);
}
