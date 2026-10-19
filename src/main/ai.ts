/**
 * AI 客户端（OpenAI 兼容协议）。
 *
 * 为什么用 OpenAI 兼容而不是某家 SDK：
 * DeepSeek / OpenAI / 通义 / Kimi / 本地 Ollama、LM Studio 都实现了
 * `POST {baseUrl}/chat/completions`，所以换服务商只要改 baseUrl + model，
 * 不需要改代码、不用更新客户端版本。
 *
 * 纯函数（清洗 / 裁剪 / 错误翻译）放在 ai-util.ts，本文件只负责网络、上下文与配额。
 *
 * 安全边界（与项目一贯原则一致）：
 * 1. **AI 只产出文本**，绝不直接投递 RCON 命令。
 * 2. 输出必须经过 sanitizeAIReply：剥离 CQ 码（防止模型被诱导输出
 *    [CQ:image] 往群里塞图、或 [CQ:at,qq=all] 全员 @）、去 Markdown、限长。
 * 3. 每个 QQ 有每日配额，防止单人把额度刷爆。
 * 4. API Key 明文存配置，需保证数据目录权限。
 */

import { net } from 'electron';
import type { AIConfig, AIStatus } from '../shared/types';
import {
  extractContent,
  isSameDay,
  sanitizeAIReply,
  todayKey,
  translateAIError,
  trimContext,
  type ChatMessage,
} from './ai-util';

export type { ChatMessage } from './ai-util';
export {
  sanitizeAIReply,
  trimContext,
  translateAIError,
  extractContent,
  todayKey,
  isSameDay,
} from './ai-util';

/** 单次调用结果 */
export interface AIResult {
  ok: boolean;
  text: string;
  error?: string;
}

/** 配额账本：qq → { day, count } */
interface QuotaRecord {
  day: string;
  count: number;
}

/**
 * AI 客户端。
 *
 * 负责：拼请求、管上下文、算配额、清洗输出。
 * 不负责：决定「什么时候该问 AI」（那是 router / main 的事）。
 */
export class AIClient {
  private config: AIConfig;
  /** 会话上下文：key = 群号 或 private:<qq> */
  private contexts = new Map<string, ChatMessage[]>();
  /** 配额账本 */
  private quota = new Map<string, QuotaRecord>();
  private status: AIStatus = { enabled: false, ready: false, todayCalls: 0 };

  constructor(config: AIConfig) {
    this.config = config;
    this.refreshStatus();
  }

  updateConfig(config: AIConfig): void {
    this.config = config;
    this.refreshStatus();
  }

  getStatus(): AIStatus {
    return { ...this.status };
  }

  private refreshStatus(): void {
    const c = this.config;
    const ready = Boolean(c.baseUrl.trim() && c.apiKey.trim() && c.model.trim());
    this.status = {
      ...this.status,
      enabled: c.enabled,
      ready,
      todayCalls: this.totalCallsToday(),
    };
  }

  /** 今天所有用户的调用总数 */
  private totalCallsToday(): number {
    const day = todayKey();
    let sum = 0;
    for (const rec of this.quota.values()) {
      if (isSameDay(rec.day, day)) sum += rec.count;
    }
    return sum;
  }

  /** 检查并占用一次配额 */
  private consumeQuota(qq: string): { ok: boolean; error?: string } {
    const limit = this.config.dailyQuotaPerUser;
    if (limit <= 0) return { ok: true };
    const day = todayKey();
    const rec = this.quota.get(qq);
    if (!rec || !isSameDay(rec.day, day)) {
      this.quota.set(qq, { day, count: 1 });
      return { ok: true };
    }
    if (rec.count >= limit) {
      return { ok: false, error: `你今天已经问了 ${limit} 次，明天再来吧` };
    }
    rec.count += 1;
    return { ok: true };
  }

  /** 清空所有会话上下文 */
  clearContext(): void {
    this.contexts.clear();
  }

  /** 清空某个会话的上下文 */
  clearContextOf(sessionKey: string): void {
    this.contexts.delete(sessionKey);
  }

  /**
   * 发起一次对话。
   *
   * @param question   用户问题
   * @param sessionKey 会话标识（群号 / private:<qq>），决定上下文隔离
   * @param qq         提问者 QQ（配额按人算）
   * @param extraSystem 额外系统提示（例如「下面给你玩家统计数据，据此写画像」）
   */
  async chat(
    question: string,
    sessionKey: string,
    qq: string,
    extraSystem?: string,
  ): Promise<AIResult> {
    const c = this.config;
    if (!c.enabled) return { ok: false, text: '', error: 'AI 功能未启用' };
    if (!c.baseUrl.trim() || !c.apiKey.trim() || !c.model.trim()) {
      return { ok: false, text: '', error: 'AI 配置不完整（需要 baseUrl / apiKey / model）' };
    }

    const quota = this.consumeQuota(qq);
    if (!quota.ok) return { ok: false, text: '', error: quota.error };

    const text = String(question ?? '').trim();
    if (!text) return { ok: false, text: '', error: '问题为空' };

    // 组装消息：系统人设 + 额外系统提示 + 历史上下文 + 本次提问
    const history = trimContext(this.contexts.get(sessionKey) ?? [], c.contextTurns);
    const messages: ChatMessage[] = [];
    if (c.systemPrompt.trim()) messages.push({ role: 'system', content: c.systemPrompt });
    if (extraSystem?.trim()) messages.push({ role: 'system', content: extraSystem });
    messages.push(...history);
    messages.push({ role: 'user', content: text });

    const url = `${c.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, c.timeoutMs));

    let body: unknown;
    try {
      const res = await net.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify({
          model: c.model,
          messages,
          temperature: c.temperature,
          max_tokens: c.maxTokens,
        }),
        signal: controller.signal,
      });

      const raw = await res.text();
      if (!res.ok) {
        const err = translateAIError(res.status, raw);
        this.markFail(err);
        return { ok: false, text: '', error: err };
      }
      try {
        body = JSON.parse(raw);
      } catch {
        const err = 'AI 返回的不是合法 JSON（接口地址可能不对）';
        this.markFail(err);
        return { ok: false, text: '', error: err };
      }
    } catch (err) {
      const e = err as Error;
      const msg =
        e.name === 'AbortError'
          ? `AI 请求超时（${c.timeoutMs}ms），请检查网络或缩短问题`
          : `AI 请求失败：${e.message}`;
      this.markFail(msg);
      return { ok: false, text: '', error: msg };
    } finally {
      clearTimeout(timer);
    }

    const content = extractContent(body);
    if (!content) {
      const err = 'AI 返回了空内容（可能是额度用尽或模型拒答）';
      this.markFail(err);
      return { ok: false, text: '', error: err };
    }

    const clean = sanitizeAIReply(content);

    // 只在成功时写入上下文，避免把报错也塞进历史
    const ctx = this.contexts.get(sessionKey) ?? [];
    ctx.push({ role: 'user', content: text });
    ctx.push({ role: 'assistant', content: clean });
    this.contexts.set(sessionKey, trimContext(ctx, c.contextTurns));

    this.markOk();
    return { ok: true, text: clean };
  }

  private markOk(): void {
    this.status = {
      ...this.status,
      lastOk: true,
      lastError: undefined,
      todayCalls: this.totalCallsToday(),
    };
  }

  private markFail(error: string): void {
    this.status = {
      ...this.status,
      lastOk: false,
      lastError: error,
      todayCalls: this.totalCallsToday(),
    };
  }
}
