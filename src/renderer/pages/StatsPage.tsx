import React, { useCallback, useEffect, useState } from 'react';
import type { PageProps } from '../App';
import type { PlayerStats } from '../../shared/types';

/** 秒数 → 「3天2小时15分」（与主进程 stats.ts 的实现保持一致） */
function fmtOnline(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}小时`);
  if (m > 0) parts.push(`${m}分`);
  return parts.length > 0 ? parts.join('') : `${s}秒`;
}

type SortBy = 'onlineSeconds' | 'chatCount' | 'commandCount' | 'joinCount';

const SORTS: Array<{ key: SortBy; label: string }> = [
  { key: 'onlineSeconds', label: '在线时长' },
  { key: 'chatCount', label: '发言数' },
  { key: 'commandCount', label: '指令数' },
  { key: 'joinCount', label: '进服次数' },
];

/**
 * 玩家统计页。
 *
 * 数据完全来自日志监听（进服/退服/聊天）与指令路由，
 * 所以必须先在上面「消息互通 → 服务端日志监听」里启用并填对路径。
 */
export function StatsPage({ config, patch }: PageProps) {
  const [rows, setRows] = useState<PlayerStats[]>([]);
  const [sortBy, setSortBy] = useState<SortBy>('onlineSeconds');
  const cfg = config.stats;

  const load = useCallback(async (by: SortBy = sortBy) => {
    const list = await window.bridge.getStatsTop(by, 200);
    setRows(list);
  }, [sortBy]);

  useEffect(() => {
    void load(sortBy);
    const timer = setInterval(() => void load(sortBy), 5000);
    return () => clearInterval(timer);
  }, [load, sortBy]);

  const clearAll = async () => {
    if (!confirm('确定清空全部统计数据？此操作不可恢复。')) return;
    await window.bridge.clearStats();
    void load(sortBy);
  };

  return (
    <>
      <div className="card">
        <h2 className="card-title">玩家统计</h2>
        <p className="hint">
          在线时长、发言数、指令使用次数、进服次数。数据来自服务端日志监听，
          需要先在「消息互通」里启用日志监听并填对日志路径。
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => patch({ stats: { ...cfg, enabled: e.target.checked } })}
          />
          <span>启用统计（关闭后不再记录新数据）</span>
        </label>

        <div className="field" style={{ maxWidth: 240 }}>
          <label>最多保留玩家数</label>
          <input
            type="number"
            min={1}
            value={cfg.maxPlayers}
            onChange={(e) =>
              patch({ stats: { ...cfg, maxPlayers: Number(e.target.value) || 2000 } })
            }
          />
        </div>

        <div className="row-flex" style={{ marginTop: 12 }}>
          {SORTS.map((s) => (
            <button
              key={s.key}
              className={`btn ${sortBy === s.key ? 'primary' : ''}`}
              onClick={() => setSortBy(s.key)}
            >
              {s.label}
            </button>
          ))}
          <button className="btn danger" onClick={() => void clearAll()}>
            清空统计
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">排行榜（{rows.length} 位玩家）</h2>
        {rows.length === 0 ? (
          <p className="hint">
            暂无数据。确认日志监听已启用且服务端目录正确，然后让玩家进服/聊天试试。
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>玩家</th>
                <th>在线时长</th>
                <th>发言</th>
                <th>指令</th>
                <th>进服</th>
                <th>最后出现</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.playerId}>
                  <td>{i + 1}</td>
                  <td>{r.playerId}</td>
                  <td>{fmtOnline(r.onlineSeconds)}</td>
                  <td>{r.chatCount}</td>
                  <td>{r.commandCount}</td>
                  <td>{r.joinCount}</td>
                  <td>{new Date(r.lastSeen).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
