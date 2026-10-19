import React, { useState } from 'react';
import type { PageProps } from '../App';
import type { ResponderRule } from '../../shared/types';

/** 生成一个稳定唯一的规则 id */
function newId(): string {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 自动回复页：关键词 / 正则 / 完全匹配。
 *
 * 对应 EasyBot 的「回复预设的文本（支持关键词、正则）」。
 * 安全约束：只产出纯文本，不触发任何 RCON 命令。
 */
export function ResponderPage({ config, patch }: PageProps) {
  const cfg = config.responder;
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<string>('');

  const patchCfg = (partial: Partial<typeof cfg>) => {
    patch({ responder: { ...cfg, ...partial } });
  };

  const updateRule = (id: string, partial: Partial<ResponderRule>) => {
    patchCfg({
      rules: cfg.rules.map((r) => (r.id === id ? { ...r, ...partial } : r)),
    });
  };

  const addRule = () => {
    const rule: ResponderRule = {
      id: newId(),
      name: '新规则',
      enabled: true,
      matchType: 'keyword',
      pattern: '',
      reply: '',
      toGame: false,
      adminOnly: false,
      cooldownSeconds: 10,
    };
    patchCfg({ rules: [...cfg.rules, rule] });
  };

  const removeRule = (id: string) => {
    patchCfg({ rules: cfg.rules.filter((r) => r.id !== id) });
  };

  const doTest = async () => {
    const res = await window.bridge.testResponder(testText);
    if (res.hit) {
      setTestResult(`✔ 命中规则「${res.ruleName}」\n回复：${res.reply}`);
    } else {
      setTestResult('✘ 没有规则命中（注意：配置需先保存才生效）');
    }
  };

  return (
    <>
      <div className="card">
        <h2 className="card-title">自动回复</h2>
        <p className="hint">
          群里出现指定关键词 / 匹配正则时自动回复。只发文本，不会执行任何服务器命令。
          多条规则同时命中时只回第一条，避免刷屏。
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => patchCfg({ enabled: e.target.checked })}
          />
          <span>启用自动回复</span>
        </label>

        <div className="row-flex" style={{ marginTop: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>测试一句话，看看会命中哪条规则</label>
            <input
              value={testText}
              placeholder="例如：服务器怎么进"
              onChange={(e) => setTestText(e.target.value)}
            />
          </div>
          <button className="btn" onClick={() => void doTest()} style={{ alignSelf: 'flex-end' }}>
            测试
          </button>
        </div>
        {testResult && (
          <pre className="hint" style={{ whiteSpace: 'pre-wrap' }}>{testResult}</pre>
        )}

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={addRule}>
            新增规则
          </button>
        </div>
      </div>

      {cfg.rules.length === 0 && (
        <div className="card">
          <p className="hint">还没有规则。点上面的「新增规则」开始。</p>
        </div>
      )}

      {cfg.rules.map((rule, idx) => (
        <div className="card" key={rule.id}>
          <h2 className="card-title">
            规则 {idx + 1}
            <span className="hint" style={{ marginLeft: 8 }}>{rule.name}</span>
          </h2>

          <div className="row-flex">
            <label className="check-row">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
              />
              <span>启用</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={rule.adminOnly}
                onChange={(e) => updateRule(rule.id, { adminOnly: e.target.checked })}
              />
              <span>仅管理员</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={rule.toGame}
                onChange={(e) => updateRule(rule.id, { toGame: e.target.checked })}
              />
              <span>同步到游戏内</span>
            </label>
          </div>

          <div className="row-flex">
            <div className="field" style={{ maxWidth: 200 }}>
              <label>规则名</label>
              <input
                value={rule.name}
                onChange={(e) => updateRule(rule.id, { name: e.target.value })}
              />
            </div>
            <div className="field" style={{ maxWidth: 160 }}>
              <label>匹配方式</label>
              <select
                value={rule.matchType}
                onChange={(e) =>
                  updateRule(rule.id, { matchType: e.target.value as ResponderRule['matchType'] })
                }
              >
                <option value="keyword">包含关键词</option>
                <option value="exact">完全相等</option>
                <option value="regex">正则匹配</option>
              </select>
            </div>
            <div className="field" style={{ maxWidth: 140 }}>
              <label>冷却（秒）</label>
              <input
                type="number"
                min={0}
                value={rule.cooldownSeconds}
                onChange={(e) =>
                  updateRule(rule.id, { cooldownSeconds: Number(e.target.value) || 0 })
                }
              />
            </div>
          </div>

          <div className="field">
            <label>触发内容{rule.matchType === 'regex' ? '（正则表达式）' : ''}</label>
            <input
              value={rule.pattern}
              placeholder={rule.matchType === 'regex' ? '^怎么进服' : '怎么进服'}
              onChange={(e) => updateRule(rule.id, { pattern: e.target.value })}
            />
          </div>

          <div className="field">
            <label>回复内容（变量：{'{user}'} {'{nickname}'} {'{group}'}）</label>
            <textarea
              rows={3}
              value={rule.reply}
              placeholder="在群里发送「/绑定 你的ID」即可完成绑定"
              onChange={(e) => updateRule(rule.id, { reply: e.target.value })}
            />
          </div>

          <div className="btn-row">
            <button className="btn danger" onClick={() => removeRule(rule.id)}>
              删除规则
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
