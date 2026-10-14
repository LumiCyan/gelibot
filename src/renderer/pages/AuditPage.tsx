import React, { useCallback, useEffect, useState } from 'react';
import type { AuditEntry } from '../../shared/types';

/**
 * 审计日志页：展示所有 RCON 命令的执行记录，包含来源、触发者与结果。
 */
export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setEntries(await window.bridge.listAudit(300));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 定时刷新，便于观察实时执行情况
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [autoRefresh, refresh]);

  const clear = async () => {
    await window.bridge.clearAudit();
    await refresh();
  };

  const failed = entries.filter((e) => !e.success).length;

  return (
    <>
      <h1 className="page-title">审计日志</h1>
      <p className="page-desc">
        记录每一条真正投递到服务器的 RCON 命令：谁在哪个群触发了什么、执行结果如何。
      </p>

      <div className="card">
        <div className="row-flex" style={{ marginBottom: 12 }}>
          <h2 className="card-title" style={{ flex: 1, margin: 0 }}>
            执行记录（{entries.length} 条{failed > 0 ? `，其中 ${failed} 条失败` : ''}）
          </h2>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            自动刷新
          </label>
          <button className="btn" onClick={() => void refresh()}>
            刷新
          </button>
          <button className="btn danger" onClick={clear}>
            清空
          </button>
        </div>

        {entries.length === 0 ? (
          <div className="empty">暂无执行记录</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 138 }}>时间</th>
                <th style={{ width: 92 }}>来源</th>
                <th style={{ width: 120 }}>触发者</th>
                <th>命令</th>
                <th style={{ width: 62 }}>结果</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <React.Fragment key={e.id}>
                  <tr
                    style={{ cursor: 'pointer' }}
                    onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  >
                    <td>{new Date(e.timestamp).toLocaleTimeString('zh-CN')}</td>
                    <td>
                      <span className="tag">
                        {e.sourceType === 'group'
                          ? `群 ${e.sourceId}`
                          : e.sourceId === 'console'
                            ? '控制台'
                            : '私聊'}
                      </span>
                    </td>
                    <td className="mono">{e.userId}</td>
                    <td className="mono">{e.command}</td>
                    <td>
                      <span className={`tag ${e.success ? 'ok' : 'fail'}`}>
                        {e.success ? '成功' : '失败'}
                      </span>
                    </td>
                  </tr>
                  {expanded === e.id && (
                    <tr>
                      <td colSpan={5} style={{ background: '#fafbfc' }}>
                        <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                          <div>
                            <span style={{ color: 'var(--text-muted)' }}>原始消息：</span>
                            <span className="mono">{e.rawMessage}</span>
                          </div>
                          <div style={{ marginTop: 4 }}>
                            <span style={{ color: 'var(--text-muted)' }}>返回内容：</span>
                            <span className="mono">{e.result || '（无）'}</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
