import React, { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import type { AIConfig, AIStatus } from '../../shared/types';

/**
 * 常见服务商预设。
 *
 * 全部实现 OpenAI 兼容的 /chat/completions，所以切换服务商只是换
 * baseUrl + model，不需要改客户端。本地 Ollama / LM Studio 同理。
 */
const PRESETS: Array<{ key: string; label: string; baseUrl: string; model: string; note: string }> = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    note: '便宜、中文好，适合群聊问答',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    note: '需能直连 api.openai.com',
  },
  {
    key: 'moonshot',
    label: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    note: '国内直连快',
  },
  {
    key: 'dashscope',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    note: '阿里云百炼，兼容模式',
  },
  {
    key: 'ollama',
    label: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    note: '完全本地、不出网，key 可随便填',
  },
];

/**
 * AI 设置页。
 *
 * 设计原则：**默认关闭，且不预填任何 Key**。
 * 开启后 AI 只产出群聊文本，不会执行任何服务器命令。
 */
export function AIPage({ config, patch }: PageProps) {
  const ai = config.ai;
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    void window.bridge.getAIStatus().then(setStatus);
    const timer = setInterval(() => {
      void window.bridge.getAIStatus().then(setStatus);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const patchAI = (partial: Partial<AIConfig>) => {
    patch({ ai: { ...ai, ...partial } });
  };

  const doTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await window.bridge.testAI();
    setTesting(false);
    setTestResult(
      res.ok
        ? { ok: true, text: `连接成功，模型回：${res.reply ?? ''}` }
        : { ok: false, text: res.error ?? '未知错误' },
    );
  };

  const doAsk = async () => {
    if (!question.trim()) return;
    setAsking(true);
    setAnswer('');
    const res = await window.bridge.askAI(question.trim());
    setAsking(false);
    setAnswer(res.ok ? (res.reply ?? '') : `[出错] ${res.error}`);
  };

  return (
    <>
      <div className="card">
        <h2 className="card-title">AI 助手</h2>
        <p className="hint">
          使用 OpenAI 兼容协议，DeepSeek / OpenAI / Kimi / 通义 / 本地 Ollama 都能接。
          AI <strong>只会回复文字</strong>，不会执行任何服务器命令。
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={ai.enabled}
            onChange={(e) => patchAI({ enabled: e.target.checked })}
          />
          <span>启用 AI 功能</span>
        </label>

        <div className="row-flex" style={{ marginTop: 8 }}>
          <div className="banner ok" style={{ flex: 1, marginBottom: 0 }}>
            状态：
            {status?.enabled ? '已启用' : '未启用'}
            {' · '}
            {status?.ready ? '配置完整' : '配置不完整'}
            {status?.lastOk === true ? ' · 上次调用成功' : ''}
            {status?.lastOk === false && status.lastError
              ? ` · 上次失败：${status.lastError}`
              : ''}
            {' · '}今日已调用 {status?.todayCalls ?? 0} 次
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">服务商</h2>
        <div className="row-flex" style={{ flexWrap: 'wrap', gap: 8 }}>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={`btn ${ai.baseUrl === p.baseUrl ? 'primary' : ''}`}
              title={p.note}
              onClick={() => patchAI({ baseUrl: p.baseUrl, model: p.model })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="hint">点一下自动填好地址和模型名，再填自己的 Key 即可。</p>

        <div className="field">
          <label>接口地址（baseUrl，不要带 /chat/completions）</label>
          <input
            value={ai.baseUrl}
            placeholder="https://api.deepseek.com/v1"
            onChange={(e) => patchAI({ baseUrl: e.target.value })}
          />
        </div>

        <div className="field">
          <label>API Key（明文保存在本机 config.json）</label>
          <div className="row-flex" style={{ gap: 8 }}>
            <input
              type={showKey ? 'text' : 'password'}
              value={ai.apiKey}
              placeholder="sk-..."
              style={{ flex: 1 }}
              onChange={(e) => patchAI({ apiKey: e.target.value })}
            />
            <button className="btn" onClick={() => setShowKey((v) => !v)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <p className="hint">
            建议用一个单独的、有额度上限的 Key。数据目录若与别人共享，注意别泄露。
          </p>
        </div>

        <div className="field" style={{ maxWidth: 320 }}>
          <label>模型名</label>
          <input
            value={ai.model}
            placeholder="deepseek-chat"
            onChange={(e) => patchAI({ model: e.target.value })}
          />
        </div>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={() => void doTest()} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn" onClick={() => void window.bridge.clearAIContext()}>
            清空会话上下文
          </button>
        </div>
        {testResult && (
          <div className={`banner ${testResult.ok ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>
            {testResult.text}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">触发方式</h2>
        <div className="field" style={{ maxWidth: 320 }}>
          <label>什么时候响应</label>
          <select
            value={ai.trigger}
            onChange={(e) => patchAI({ trigger: e.target.value as AIConfig['trigger'] })}
          >
            <option value="both">指令 + @我 都响应</option>
            <option value="command">只响应 /问 指令</option>
            <option value="mention">只响应 @我</option>
          </select>
        </div>
        <p className="hint">
          指令形式：<code>/问 服务器怎么进</code> 或 <code>/ai 服务器怎么进</code>；
          也可以在群里直接 <code>@机器人 问题</code>。
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={ai.fallbackToAI}
            onChange={(e) => patchAI({ fallbackToAI: e.target.checked })}
          />
          <span>
            自动回复没命中时，让 AI 兜底作答
            <span className="hint" style={{ marginLeft: 6 }}>
              （会让 AI 参与所有群聊，可能较吵且费额度）
            </span>
          </span>
        </label>

        <label className="check-row">
          <input
            type="checkbox"
            checked={ai.allowPlayerProfile}
            onChange={(e) => patchAI({ allowPlayerProfile: e.target.checked })}
          />
          <span>允许 /ai 玩家 &lt;ID&gt; 生成玩家画像（普通用户只能查自己绑定的角色）</span>
        </label>

        <label className="check-row">
          <input
            type="checkbox"
            checked={ai.mentionOnReply}
            onChange={(e) => patchAI({ mentionOnReply: e.target.checked })}
          />
          <span>回复时 @ 提问者</span>
        </label>
      </div>

      <div className="card">
        <h2 className="card-title">人设与参数</h2>
        <div className="field">
          <label>系统提示词（人设）</label>
          <textarea
            rows={6}
            value={ai.systemPrompt}
            onChange={(e) => patchAI({ systemPrompt: e.target.value })}
          />
          <p className="hint">
            建议写清「身份、语气、长度限制、不要编造」。默认已包含「不要输出命令和
            Markdown」的约束。
          </p>
        </div>

        <div className="row-flex">
          <div className="field" style={{ maxWidth: 160 }}>
            <label>温度（0-2）</label>
            <input
              type="number"
              step="0.1"
              min={0}
              max={2}
              value={ai.temperature}
              onChange={(e) => patchAI({ temperature: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label>最大 token</label>
            <input
              type="number"
              value={ai.maxTokens}
              onChange={(e) => patchAI({ maxTokens: Number(e.target.value) || 500 })}
            />
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label>上下文轮数</label>
            <input
              type="number"
              min={0}
              value={ai.contextTurns}
              onChange={(e) => patchAI({ contextTurns: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label>超时（毫秒）</label>
            <input
              type="number"
              value={ai.timeoutMs}
              onChange={(e) => patchAI({ timeoutMs: Number(e.target.value) || 20000 })}
            />
          </div>
          <div className="field" style={{ maxWidth: 180 }}>
            <label>每人每日次数（0=不限）</label>
            <input
              type="number"
              min={0}
              value={ai.dailyQuotaPerUser}
              onChange={(e) => patchAI({ dailyQuotaPerUser: Number(e.target.value) || 0 })}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">在这里试问（不经过 QQ）</h2>
        <p className="hint">用来调人设。这里的问题不会发到任何群，也不占用群成员的配额。</p>
        <div className="row-flex">
          <div className="field" style={{ flex: 1 }}>
            <input
              value={question}
              placeholder="例如：服务器有什么规则？"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doAsk();
              }}
            />
          </div>
          <button className="btn primary" onClick={() => void doAsk()} disabled={asking}>
            {asking ? '思考中…' : '发送'}
          </button>
        </div>
        {answer && (
          <pre
            className="hint"
            style={{ whiteSpace: 'pre-wrap', marginTop: 10, color: 'var(--text)' }}
          >
            {answer}
          </pre>
        )}
      </div>
    </>
  );
}
