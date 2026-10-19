import React, { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import type { ScheduledTask } from '../../shared/types';

function newId(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 定时任务页。
 *
 * 两种触发条件可并存：每 N 分钟 / 每天 HH:mm。
 * 动作只有两类：发 RCON 命令、发群消息。
 *
 * 刻意不提供「任意脚本执行」——这个程序的安全边界是「模板化 + 可审计」，
 * 定时任务也必须落在这条线上。
 */
export function TaskPage({ config, patch }: PageProps) {
  const cfg = config.tasks;
  const [history, setHistory] = useState<
    Array<{ at: string; taskId: string; name: string; ok: boolean; error?: string }>
  >([]);
  const [busy, setBusy] = useState<string | null>(null);

  const loadHistory = () => {
    void window.bridge.getTaskHistory().then(setHistory);
  };

  useEffect(() => {
    loadHistory();
    const timer = setInterval(loadHistory, 5000);
    return () => clearInterval(timer);
  }, []);

  const patchCfg = (partial: Partial<typeof cfg>) => {
    patch({ tasks: { ...cfg, ...partial } });
  };

  const updateTask = (id: string, partial: Partial<ScheduledTask>) => {
    patchCfg({ tasks: cfg.tasks.map((t) => (t.id === id ? { ...t, ...partial } : t)) });
  };

  const addTask = () => {
    const task: ScheduledTask = {
      id: newId(),
      name: '新任务',
      enabled: true,
      intervalMinutes: 0,
      dailyAt: '',
      action: { type: 'rcon', command: 'list' },
    };
    patchCfg({ tasks: [...cfg.tasks, task] });
  };

  const runNow = async (id: string) => {
    setBusy(id);
    const res = await window.bridge.runTaskNow(id);
    setBusy(null);
    if (!res.ok) alert(`执行失败：${res.error ?? '未知错误'}`);
    loadHistory();
  };

  return (
    <>
      <div className="card">
        <h2 className="card-title">定时任务</h2>
        <p className="hint">
          定时执行服务器命令或群消息。例如每天 4:00 执行 <code>save-all</code>、
          每 30 分钟播报一次公告。任务配置需保存后生效。
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => patchCfg({ enabled: e.target.checked })}
          />
          <span>启用定时任务</span>
        </label>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={addTask}>
            新增任务
          </button>
        </div>
      </div>

      {cfg.tasks.length === 0 && (
        <div className="card">
          <p className="hint">还没有任务。点上面的「新增任务」开始。</p>
        </div>
      )}

      {cfg.tasks.map((task, idx) => (
        <div className="card" key={task.id}>
          <h2 className="card-title">
            任务 {idx + 1}
            <span className="hint" style={{ marginLeft: 8 }}>{task.name}</span>
          </h2>

          <div className="row-flex">
            <label className="check-row">
              <input
                type="checkbox"
                checked={task.enabled}
                onChange={(e) => updateTask(task.id, { enabled: e.target.checked })}
              />
              <span>启用</span>
            </label>
            <div className="field" style={{ maxWidth: 220 }}>
              <label>任务名</label>
              <input
                value={task.name}
                onChange={(e) => updateTask(task.id, { name: e.target.value })}
              />
            </div>
          </div>

          <div className="row-flex">
            <div className="field" style={{ maxWidth: 200 }}>
              <label>每隔多少分钟（0 = 不用）</label>
              <input
                type="number"
                min={0}
                value={task.intervalMinutes}
                onChange={(e) =>
                  updateTask(task.id, { intervalMinutes: Number(e.target.value) || 0 })
                }
              />
            </div>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>每天定点（HH:mm，留空 = 不用）</label>
              <input
                value={task.dailyAt}
                placeholder="04:00"
                onChange={(e) => updateTask(task.id, { dailyAt: e.target.value })}
              />
            </div>
          </div>

          <div className="row-flex">
            <div className="field" style={{ maxWidth: 200 }}>
              <label>动作类型</label>
              <select
                value={task.action.type}
                onChange={(e) => {
                  const type = e.target.value as 'rcon' | 'chat';
                  updateTask(task.id, {
                    action:
                      type === 'rcon'
                        ? { type: 'rcon', command: 'list' }
                        : { type: 'chat', targetType: 'group', targetId: '', text: '' },
                  });
                }}
              >
                <option value="rcon">执行服务器命令</option>
                <option value="chat">发送群消息</option>
              </select>
            </div>
            {task.action.type === 'rcon' ? (
              <div className="field" style={{ flex: 1 }}>
                <label>RCON 命令</label>
                <input
                  value={task.action.command}
                  placeholder="save-all"
                  onChange={(e) =>
                    updateTask(task.id, {
                      action: { type: 'rcon', command: e.target.value },
                    })
                  }
                />
              </div>
            ) : (
              <>
                <div className="field" style={{ maxWidth: 160 }}>
                  <label>目标类型</label>
                  <select
                    value={task.action.targetType}
                    onChange={(e) =>
                      updateTask(task.id, {
                        action: {
                          type: 'chat',
                          targetType: e.target.value as 'group' | 'private',
                          targetId:
                            task.action.type === 'chat' ? task.action.targetId : '',
                          text: task.action.type === 'chat' ? task.action.text : '',
                        },
                      })
                    }
                  >
                    <option value="group">群</option>
                    <option value="private">私聊</option>
                  </select>
                </div>
                <div className="field" style={{ maxWidth: 180 }}>
                  <label>目标号</label>
                  <input
                    value={task.action.targetId}
                    placeholder="123456789"
                    onChange={(e) =>
                      updateTask(task.id, {
                        action: {
                          type: 'chat',
                          targetType:
                            task.action.type === 'chat' ? task.action.targetType : 'group',
                          targetId: e.target.value,
                          text: task.action.type === 'chat' ? task.action.text : '',
                        },
                      })
                    }
                  />
                </div>
              </>
            )}
          </div>

          {task.action.type === 'chat' && (
            <div className="field">
              <label>消息内容</label>
              <textarea
                rows={2}
                value={task.action.text}
                onChange={(e) =>
                  updateTask(task.id, {
                    action: {
                      type: 'chat',
                      targetType:
                        task.action.type === 'chat' ? task.action.targetType : 'group',
                      targetId: task.action.type === 'chat' ? task.action.targetId : '',
                      text: e.target.value,
                    },
                  })
                }
              />
            </div>
          )}

          <p className="hint">
            上次执行：{task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : '从未'}
          </p>

          <div className="btn-row">
            <button
              className="btn"
              onClick={() => void runNow(task.id)}
              disabled={busy === task.id}
            >
              {busy === task.id ? '执行中…' : '立即执行一次'}
            </button>
            <button
              className="btn danger"
              onClick={() => patchCfg({ tasks: cfg.tasks.filter((t) => t.id !== task.id) })}
            >
              删除任务
            </button>
          </div>
        </div>
      ))}

      <div className="card">
        <h2 className="card-title">执行历史</h2>
        {history.length === 0 ? (
          <p className="hint">暂无执行记录（仅记录本次运行期间的任务）。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>任务</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={`${h.at}-${i}`}>
                  <td>{new Date(h.at).toLocaleString()}</td>
                  <td>{h.name}</td>
                  <td>{h.ok ? '✔ 成功' : `✘ ${h.error ?? '失败'}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
