/**
 * 通用「回复出图」服务。
 *
 * 把任意功能回复渲染成一张卡片图，返回可直接发给 OneBot 的 CQ 码。
 * 失败一律返回 null，由调用方回退成纯文本 —— 图片是锦上添花，
 * 不能因为渲染出问题就让用户收不到结果。
 */

import type { AppConfig } from '../shared/types';
import type { CardRenderer } from './card';
import { buildGenericCardHtml } from './card-generic';
import { writeCardMessage } from './card-file';
import { buildReplyCard, shouldRenderImage } from './image-reply-util';

/** 回复的语义类型，决定 scope=command 时是否转图 */
export type ReplyKind = 'command' | 'notice' | 'auto' | 'chat';

export interface ImageReplyOptions {
  renderer: CardRenderer;
  /** 卡片左上角图标（与在线卡片共用同一份资源） */
  iconUri: string;
  /** 卡片文件目录 */
  cardDir: string;
  getConfig: () => AppConfig;
  log?: (msg: string) => void;
}

/** 剥掉 MC 颜色码（§c 这类），卡片里用不上 */
function stripMcColors(text: string): string {
  return String(text ?? '').replace(/§./g, '');
}

/** 单张卡片正文的最大行数（超出部分截断，避免图片高到离谱） */
const MAX_LINES = 40;

export class ImageReplyService {
  private opts: ImageReplyOptions;
  private log: (msg: string) => void;

  constructor(opts: ImageReplyOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
  }

  /**
   * 尝试把一段回复渲染成图片。
   *
   * @returns 成功返回 `[CQ:image,file=...]`；不该转图或渲染失败返回 null
   */
  async maybeRender(
    text: string,
    meta: {
      kind: ReplyKind;
      /** 卡片标题，默认「执行结果」 */
      title?: string;
      /** 成败徽章；不传则不显示 */
      ok?: boolean;
      /** 底部说明 */
      footer?: string;
    },
  ): Promise<string | null> {
    try {
      const cfg = this.opts.getConfig().imageReply;
      if (!cfg.enabled) return null;

      // 聊天同步永远不出图：群里每条消息一张卡会把聊天刷没
      if (meta.kind === 'chat') return null;
      // scope=command 时，只有指令/查询类回复转图
      if (cfg.scope === 'command' && meta.kind !== 'command') return null;

      const clean = stripMcColors(text);
      if (!shouldRenderImage(clean, cfg)) return null;

      // 组装卡片数据，并对超长内容做截断
      const card = buildReplyCard(clean, {
        title: meta.title,
        ok: meta.ok,
        footer:
          meta.footer ??
          (cfg.showTime
            ? `${new Date().toLocaleString('zh-CN', { hour12: false })}`
            : undefined),
      });
      if (card.lines.length > MAX_LINES) {
        card.lines = card.lines.slice(0, MAX_LINES);
        card.lines.push({
          kind: 'text',
          text: `… 内容过多，已省略 ${card.lines.length} 行`,
        });
      }
      if (card.lines.length === 0) return null;

      const html = buildGenericCardHtml(card, {
        iconUri: this.opts.iconUri,
        width: cfg.width,
        theme: cfg.theme,
        scale: cfg.scale,
        watermark: cfg.watermark,
      });
      const { png } = await this.opts.renderer.renderHtml(html);
      return writeCardMessage(this.opts.cardDir, png, {
        keep: Math.max(10, cfg.keepFiles),
        prefix: 'reply',
      });
    } catch (err) {
      // 渲染失败不是错误，只是降级成文字
      this.log(`图片回复渲染失败，回退文字：${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 预览：把文本渲染成卡片并直接返回 data URL（不落盘、不发送）。
   *
   * 与 maybeRender 的区别：这里**不看阈值**，强制出图 ——
   * 预览的目的就是看排版长什么样。
   */
  async preview(text: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
    try {
      const clean = stripMcColors(text);
      if (!clean.trim()) return { ok: false, error: '内容为空' };

      const card = buildReplyCard(clean, {
        title: '预览',
        footer: '这是预览效果，不会发送到群里',
      });
      if (card.lines.length === 0) return { ok: false, error: '解析不出可显示的内容' };

      // 预览也用当前视觉配置，所见即所得（主题/宽度/字号/水印）
      const cfg = this.opts.getConfig().imageReply;
      const html = buildGenericCardHtml(card, {
        iconUri: this.opts.iconUri,
        width: cfg.width,
        theme: cfg.theme,
        scale: cfg.scale,
        watermark: cfg.watermark,
      });
      const { png } = await this.opts.renderer.renderHtml(html);
      return { ok: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
