/**
 * 在线人数卡片的 HTML/CSS 模板。
 *
 * 与渲染器分离的原因：模板是纯字符串拼装（可单测），渲染器只管窗口与截图。
 * 设计稿来自 .stage/card-v2 的候选样张，正式版做了三处调整：
 *   1. 去掉「其中 N 人已绑定 QQ」—— 会公开暴露绑定情况
 *   2. 所有占位符用全局替换（样张脚本只替换首处，进度条宽度曾因此失效）
 *   3. 所有插值做 HTML 转义，JSON 注入转义 <，防止破坏文档结构
 */

export interface CardPlayer {
  name: string;
  /** base64 data URL；缺省时用首字母色块 */
  avatar?: string | null;
  /** 首字母色块背景色 */
  color?: string;
}

export interface CardData {
  serverName: string;
  online: number;
  max: number;
  players: CardPlayer[];
  /** 底部「更新于」文本 */
  timeText: string;
}

/** 首字母色块调色板 —— 按玩家名做稳定取色 */
const PALETTE = [
  '#8ab4f8',
  '#f6b26b',
  '#c58af9',
  '#4ade80',
  '#f28b82',
  '#7fd1e8',
  '#f7d774',
  '#b0a4f5',
];

/** 按名字稳定取色（同名同色，不同名多半不同色） */
export function colorOfName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 内嵌数据转 JSON：转义 < 与行分隔符，确保不会截断 script 标签 */
export function toSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: transparent; }
  body { width: __WIDTH__px; font-family: "Microsoft YaHei", "Segoe UI", system-ui, sans-serif; }
  .card {
    width: __WIDTH__px; border-radius: 18px; background: #17191d;
    padding: 24px 28px 20px; color: #e8eaed;
    display: flex; flex-direction: column;
  }

  /* ---------- 头部 ---------- */
  .head { display: flex; align-items: center; gap: 13px; }
  .logo {
    width: 46px; height: 46px; border-radius: 12px; flex: none;
    display: block; object-fit: contain;
  }
  .title { font-size: 21px; font-weight: 700; letter-spacing: .3px; }
  .sub { font-size: 12.5px; color: #9aa0a6; margin-top: 3px; }
  .pill {
    margin-left: auto; font-size: 12.5px; color: #4ade80; white-space: nowrap;
    border: 1px solid rgba(74, 222, 128, .45); background: rgba(74, 222, 128, .08);
    padding: 5px 12px; border-radius: 999px;
  }

  /* ---------- 人数 ---------- */
  .count { margin-top: 22px; display: flex; align-items: baseline; gap: 9px; }
  .num { font-size: 52px; font-weight: 700; letter-spacing: 1px; line-height: 1; color: #4ade80; }
  .max { font-size: 18px; color: #9aa0a6; }
  .pct { margin-left: auto; font-size: 13px; color: #9aa0a6; }
  .bar { margin-top: 13px; height: 8px; border-radius: 999px; background: #26292e; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: linear-gradient(90deg, #34d399, #4ade80); border-radius: 999px; }

  /* ---------- 玩家 ---------- */
  .sechd { margin-top: 22px; display: flex; align-items: baseline; gap: 8px; }
  .sec { font-size: 13px; color: #9aa0a6; }
  .secn { font-size: 12px; color: #6b7076; }
  .players { margin-top: 11px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .p {
    display: flex; align-items: center; gap: 10px;
    background: #20242a; border-radius: 12px; padding: 7px 12px 7px 7px;
    font-size: 14px; overflow: hidden;
  }
  .av {
    width: 32px; height: 32px; border-radius: 50%; flex: none;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 700; color: #0b1207;
    object-fit: cover; background: #2b3037;
  }
  .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* ---------- 空态 ---------- */
  .empty { margin-top: 11px; padding: 22px; text-align: center; color: #6b7076; font-size: 13.5px; background: #20242a; border-radius: 12px; }

  /* ---------- 底部 ---------- */
  .foot { margin-top: 22px; display: flex; justify-content: space-between; font-size: 11.5px; color: #6b7076; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <img class="logo" src="__ICON__" alt="">
      <div>
        <div class="title">__SERVER__</div>
        <div class="sub">GeLi Bot · 我的世界服务器</div>
      </div>
      <div class="pill">● 在线</div>
    </div>

    <div class="count">
      <span class="num">__ONLINE__</span><span class="max">/ __MAX__ 人</span>
      <span class="pct">占用 __PCT__%</span>
    </div>
    <div class="bar"><i style="width: __PCT__%"></i></div>

    <div class="sechd">
      <span class="sec">当前在线玩家</span>
    </div>
    <div class="players" id="players"></div>

    <div class="foot">
      <span>更新于 __TIME__</span>
      <span>GeLi Bot · 在线人数卡片</span>
    </div>
  </div>

  <script>
    const DATA = __DATA__;
    const box = document.getElementById('players');
    if (!DATA.players.length) {
      box.outerHTML = '<div class="empty">当前没有玩家在线</div>';
    } else {
      for (const p of DATA.players) {
        const el = document.createElement('div');
        el.className = 'p';
        const av = document.createElement(p.avatar ? 'img' : 'div');
        av.className = 'av';
        if (p.avatar) { av.src = p.avatar; }
        else {
          av.textContent = p.name[0].toUpperCase();
          av.style.background = p.color;
        }
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = p.name;
        el.append(av, nm);
        box.append(el);
      }
    }
    document.title = 'ready';
  </script>
</body>
</html>`;

/**
 * 生成完整卡片 HTML。
 * 所有替换均为全局替换 + HTML 转义；内嵌 JSON 做了 < 转义。
 */
export function buildCardHtml(data: CardData, opts: { iconUri: string; width: number }): string {
  const pct = data.max > 0 ? Math.min(100, Math.round((data.online / data.max) * 100)) : 0;
  const players = data.players.map((p) => ({
    name: p.name,
    avatar: p.avatar ?? null,
    color: p.color ?? colorOfName(p.name),
  }));

  return TEMPLATE.replace(/__WIDTH__/g, String(opts.width))
    .replace(/__ICON__/g, opts.iconUri)
    .replace(/__SERVER__/g, escapeHtml(data.serverName))
    .replace(/__ONLINE__/g, String(data.online))
    .replace(/__MAX__/g, String(data.max))
    .replace(/__PCT__/g, String(pct))
    .replace(/__TIME__/g, escapeHtml(data.timeText))
    .replace(/__DATA__/g, toSafeJson({ players }));
}
