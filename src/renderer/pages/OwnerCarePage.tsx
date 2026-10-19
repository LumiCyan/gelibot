import React, { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import type { OwnerCareConfig, OwnerCareStatus } from '../../shared/types';

/** 逗号/空格分隔 → 数组 */
function parseList(text: string): string[] {
  return text
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 慰问服主。
 *
 * 一个带点仪式感的小功能：每天定点在群里报一次「服主离开第 N 天」。
 * 起始日当天算第 1 天 —— 所以今天启用的话，今天就是第 1 天。
 */
export function OwnerCarePage({ config, patch }: PageProps) {
  const cfg = config.ownerCare;
  const [status, setStatus] = useState<OwnerCareStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void window.bridge.getOwnerCareStatus().then(setStatus);
    const timer = setInterval(() => {
      void window.bridge.getOwnerCareStatus().then(setStatus);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const patchCfg = (partial: Partial<OwnerCareConfig>) => {
    patch({ ownerCare: { ...cfg, ...partial } });
  };

  const sendNow = async () => {
    setBusy(true);
    const res = await window.bridge.sendOwnerCareNow();
    setBusy(false);
    setMsg(
      res.ok
        ? { ok: true, text: '已发送到目标群' }
        : { ok: false, text: res.error ?? '发送失败' },
    );
    void window.bridge.getOwnerCareStatus().then(setStatus);
  };

  const resetStart = async () => {
    if (!confirm('把起始日重置为今天？天数会重新从第 1 天开始算。')) return;
    const s = await window.bridge.resetOwnerCareStart();
    setStatus(s);
    // 后端已落盘，本地配置同步一下，避免界面还显示旧日期
    patchCfg({ startDate: s.startDate });
    setMsg({ ok: true, text: `起始日已重置为 ${s.startDate}` });
  };

  const days = status?.days ?? 0;

  return (
    <>
      <div className="card">
        <h2 className="card-title">慰问服主</h2>
        <p className="hint">
          每天定点在群里报一次「服主离开第 N 天」。起始日当天算第 1 天，
          所以今天开始的话，今天就是第 1 天。
        </p>

        <div
          style={{
            margin: '18px 0 6px',
            padding: '22px 24px',
            borderRadius: 14,
            background: 'linear-gradient(135deg, #f1f5f9, #e8eef6)',
            border: '1px solid var(--border)',
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {cfg.ownerName.trim() || '服主'}离开
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 52, fontWeight: 700, color: 'var(--primary)', lineHeight: 1 }}>
              {days > 0 ? days : '—'}
            </span>
            <span style={{ fontSize: 18, color: 'var(--text-muted)' }}>天</span>
            {status?.sentToday && (
              <span className="hint" style={{ marginLeft: 'auto' }}>
                今天已播报
              </span>
            )}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            起始日 {cfg.startDate || '未设置'}
            {status?.nextAt ? ` · 每天 ${status.nextAt} 播报` : ' · 未启用自动播报'}
          </div>
        </div>

        <label className="check-row">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => patchCfg({ enabled: e.target.checked })}
          />
          <span>启用慰问播报</span>
        </label>
      </div>

      <div className="card">
        <h2 className="card-title">播报设置</h2>

        <div className="row-flex">
          <div className="field" style={{ maxWidth: 220 }}>
            <label>起始日期（当天算第 1 天）</label>
            <input
              type="date"
              value={cfg.startDate}
              onChange={(e) => patchCfg({ startDate: e.target.value })}
            />
          </div>
          <div className="field" style={{ maxWidth: 180 }}>
            <label>每天播报时刻（HH:mm）</label>
            <input
              value={cfg.dailyAt}
              placeholder="20:00"
              onChange={(e) => patchCfg({ dailyAt: e.target.value })}
            />
          </div>
          <button className="btn" onClick={() => void resetStart()} style={{ alignSelf: 'flex-end' }}>
            重置为今天
          </button>
        </div>
        <p className="hint">
          时刻留空则关闭自动播报，只保留手动 <code>/慰问</code> 查询。
        </p>

        <div className="field">
          <label>目标群号（逗号分隔）</label>
          <input
            value={cfg.groups.join(', ')}
            placeholder="123456789"
            onChange={(e) => patchCfg({ groups: parseList(e.target.value) })}
          />
        </div>

        <div className="field">
          <label>播报文案（变量：{'{days}'} {'{owner}'} {'{startDate}'}）</label>
          <textarea
            rows={2}
            value={cfg.template}
            onChange={(e) => patchCfg({ template: e.target.value })}
          />
        </div>

        <div className="row-flex">
          <div className="field" style={{ maxWidth: 200 }}>
            <label>服主称呼（{'{owner}'}）</label>
            <input
              value={cfg.ownerName}
              placeholder="服主"
              onChange={(e) => patchCfg({ ownerName: e.target.value })}
            />
          </div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label>服主 QQ（用于 @，可空）</label>
            <input
              value={cfg.ownerQQ}
              placeholder="10001"
              onChange={(e) => patchCfg({ ownerQQ: e.target.value })}
            />
          </div>
          <label className="check-row" style={{ alignSelf: 'flex-end' }}>
            <input
              type="checkbox"
              checked={cfg.mentionOwner}
              onChange={(e) => patchCfg({ mentionOwner: e.target.checked })}
            />
            <span>播报时 @ 服主</span>
          </label>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">预览与手动播报</h2>
        <p className="hint">下面是按当前配置生成的内容（未保存也会跟随输入实时变化）。</p>
        <div
          style={{
            padding: '14px 16px',
            borderRadius: 10,
            background: '#f8fafc',
            border: '1px solid var(--border)',
            fontSize: 14,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
          }}
        >
          {cfg.mentionOwner && cfg.ownerQQ.trim() ? `@${cfg.ownerQQ} ` : ''}
          {cfg.template
            .split('{days}')
            .join(String(days > 0 ? days : '?'))
            .split('{owner}')
            .join(cfg.ownerName.trim() || '服主')
            .split('{startDate}')
            .join(cfg.startDate)}
        </div>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={() => void sendNow()} disabled={busy}>
            {busy ? '发送中…' : '立即播报一次'}
          </button>
        </div>

        {msg && (
          <div className={`banner ${msg.ok ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>
            {msg.text}
          </div>
        )}

        <p className="hint">
          群成员也可以随时发 <code>/慰问</code> 查询当前天数（不需要管理员权限）。
        </p>
      </div>
    </>
  );
}
