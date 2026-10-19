import React, { useEffect, useState } from 'react';
import type { PageProps } from '../App';

/** 逗号/换行/空格分隔的字符串 ↔ 数组 */
function parseList(text: string): string[] {
  return text
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 消息互通页：日志监听 + 群服双向同步 + 事件通知。
 *
 * 三者放在一起是因为它们共用同一个前提——**必须能读到服务端日志**。
 * 把「日志监听」放在最上面，用户按顺序配置即可跑通。
 */
export function ChatBridgePage({ config, patch }: PageProps) {
  const [logStatus, setLogStatus] = useState<{
    running: boolean;
    path: string | null;
    offset: number;
    lastError: string | null;
  } | null>(null);
  const [probe, setProbe] = useState<{ path: string; exists: boolean } | null>(null);

  useEffect(() => {
    void window.bridge.getLogWatcherStatus().then(setLogStatus);
    const timer = setInterval(() => {
      void window.bridge.getLogWatcherStatus().then(setLogStatus);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const lw = config.logWatcher;
  const cb = config.chatBridge;
  const nt = config.notify;

  const patchLog = (partial: Partial<typeof lw>) => {
    patch({ logWatcher: { ...lw, ...partial } });
  };
  const patchBridge = (partial: Partial<typeof cb>) => {
    patch({ chatBridge: { ...cb, ...partial } });
  };
  const patchNotify = (partial: Partial<typeof nt>) => {
    patch({ notify: { ...nt, ...partial } });
  };

  const doProbe = async () => {
    if (!lw.serverDir.trim()) return;
    const res = await window.bridge.probeLogPath(lw.serverDir.trim());
    setProbe(res);
  };

  return (
    <>
      <div className="card">
        <h2 className="card-title">服务端日志监听</h2>
        <p className="hint">
          群服消息同步、进服/退服/死亡通知都依赖它。程序通过读取服务端的
          <code> logs/latest.log </code>获知游戏内发生了什么（RCON 只能发命令，收不到事件）。
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={lw.enabled}
            onChange={(e) => patchLog({ enabled: e.target.checked })}
          />
          <span>启用日志监听</span>
        </label>

        <div className="row-flex">
          <div className="field" style={{ flex: 1 }}>
            <label>服务端根目录（含 server.properties 的目录）</label>
            <input
              value={lw.serverDir}
              placeholder="例如 D:\MC\server"
              onChange={(e) => patchLog({ serverDir: e.target.value })}
            />
          </div>
          <button className="btn" onClick={() => void doProbe()} style={{ alignSelf: 'flex-end' }}>
            探测
          </button>
        </div>
        {probe && (
          <p className={probe.exists ? 'hint' : 'hint warn'}>
            {probe.exists ? '✔ 已找到日志：' : '✘ 未找到日志：'}
            {probe.path}
          </p>
        )}

        <div className="field">
          <label>日志文件路径（留空则用上面目录下的 logs/latest.log）</label>
          <input
            value={lw.logPath}
            placeholder="留空自动探测"
            onChange={(e) => patchLog({ logPath: e.target.value })}
          />
        </div>

        <div className="row-flex">
          <label className="check-row">
            <input
              type="checkbox"
              checked={lw.replayHistory}
              onChange={(e) => patchLog({ replayHistory: e.target.checked })}
            />
            <span>启动时重放历史（首次接入时想看旧记录再勾）</span>
          </label>
        </div>

        <div className="row-flex">
          <label className="check-row">
            <input
              type="checkbox"
              checked={lw.filterBots}
              onChange={(e) => patchLog({ filterBots: e.target.checked })}
            />
            <span>过滤假人（Carpet 等模组的机器人玩家）</span>
          </label>
        </div>

        <div className="field" style={{ maxWidth: 420 }}>
          <label>假人名称前缀（逗号分隔）</label>
          <input
            value={lw.botPrefixes.join(', ')}
            placeholder="Bot_, BOT_, bot_"
            onChange={(e) => patchLog({ botPrefixes: parseList(e.target.value) })}
          />
        </div>

        <div className="banner ok" style={{ marginTop: 12 }}>
          状态：{logStatus?.running ? '监听中' : '未监听'}
          {logStatus?.path ? ` · ${logStatus.path}` : ''}
          {logStatus?.lastError ? ` · 错误：${logStatus.lastError}` : ''}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">群服消息双向同步</h2>
        <label className="check-row">
          <input
            type="checkbox"
            checked={cb.enabled}
            onChange={(e) => patchBridge({ enabled: e.target.checked })}
          />
          <span>启用消息同步</span>
        </label>

        <h3 style={{ marginTop: 16 }}>游戏内 → QQ 群</h3>
        <label className="check-row">
          <input
            type="checkbox"
            checked={cb.gameToChat.enabled}
            onChange={(e) =>
              patchBridge({ gameToChat: { ...cb.gameToChat, enabled: e.target.checked } })
            }
          />
          <span>启用</span>
        </label>
        <div className="field">
          <label>目标群号（逗号分隔）</label>
          <input
            value={cb.gameToChat.groups.join(', ')}
            placeholder="123456789, 987654321"
            onChange={(e) =>
              patchBridge({ gameToChat: { ...cb.gameToChat, groups: parseList(e.target.value) } })
            }
          />
        </div>
        <div className="field">
          <label>消息模板（变量：{'{player}'} {'{message}'}）</label>
          <input
            value={cb.gameToChat.template}
            onChange={(e) =>
              patchBridge({ gameToChat: { ...cb.gameToChat, template: e.target.value } })
            }
          />
        </div>

        <h3 style={{ marginTop: 16 }}>QQ 群 → 游戏内</h3>
        <label className="check-row">
          <input
            type="checkbox"
            checked={cb.chatToGame.enabled}
            onChange={(e) =>
              patchBridge({ chatToGame: { ...cb.chatToGame, enabled: e.target.checked } })
            }
          />
          <span>启用</span>
        </label>
        <div className="field">
          <label>来源群号（逗号分隔，只接收这些群）</label>
          <input
            value={cb.chatToGame.groups.join(', ')}
            placeholder="123456789"
            onChange={(e) =>
              patchBridge({ chatToGame: { ...cb.chatToGame, groups: parseList(e.target.value) } })
            }
          />
        </div>
        <div className="field">
          <label>消息模板（变量：{'{nickname}'} {'{message}'}）</label>
          <input
            value={cb.chatToGame.template}
            onChange={(e) =>
              patchBridge({ chatToGame: { ...cb.chatToGame, template: e.target.value } })
            }
          />
        </div>
        <div className="row-flex">
          <label className="check-row">
            <input
              type="checkbox"
              checked={cb.chatToGame.skipCommands}
              onChange={(e) =>
                patchBridge({
                  chatToGame: { ...cb.chatToGame, skipCommands: e.target.checked },
                })
              }
            />
            <span>跳过以 / 或 !! 开头的消息</span>
          </label>
          <div className="field" style={{ maxWidth: 220 }}>
            <label>合并窗口（毫秒，0 = 不合并）</label>
            <input
              type="number"
              value={cb.chatToGame.mergeWindowMs}
              onChange={(e) =>
                patchBridge({
                  chatToGame: {
                    ...cb.chatToGame,
                    mergeWindowMs: Number(e.target.value) || 0,
                  },
                })
              }
            />
          </div>
        </div>

        <h3 style={{ marginTop: 16 }}>过滤</h3>
        <div className="field">
          <label>屏蔽正则（每行一条，命中的消息不转发）</label>
          <textarea
            rows={3}
            value={cb.blockPatterns.join('\n')}
            placeholder="广告|加群|代练"
            onChange={(e) =>
              patchBridge({
                blockPatterns: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
              })
            }
          />
        </div>
        <div className="row-flex">
          <div className="field" style={{ maxWidth: 160 }}>
            <label>静音起始小时</label>
            <input
              type="number"
              min={0}
              max={23}
              value={cb.quietHours.start}
              onChange={(e) =>
                patchBridge({
                  quietHours: { ...cb.quietHours, start: Number(e.target.value) || 0 },
                })
              }
            />
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label>静音结束小时</label>
            <input
              type="number"
              min={0}
              max={23}
              value={cb.quietHours.end}
              onChange={(e) =>
                patchBridge({
                  quietHours: { ...cb.quietHours, end: Number(e.target.value) || 0 },
                })
              }
            />
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label>单条最大长度</label>
            <input
              type="number"
              value={cb.maxLength}
              onChange={(e) => patchBridge({ maxLength: Number(e.target.value) || 200 })}
            />
          </div>
        </div>
        <p className="hint">静音起止小时相同表示不启用静音。支持跨零点（如 23 → 7）。</p>
      </div>

      <div className="card">
        <h2 className="card-title">玩家事件通知</h2>
        <p className="hint">
          把进服 / 退服 / 死亡 / 成就 / 服务器启动推送到群。依赖上面的日志监听。
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={nt.enabled}
            onChange={(e) => patchNotify({ enabled: e.target.checked })}
          />
          <span>启用事件通知</span>
        </label>
        <div className="field">
          <label>目标群号（逗号分隔）</label>
          <input
            value={nt.groups.join(', ')}
            placeholder="123456789"
            onChange={(e) => patchNotify({ groups: parseList(e.target.value) })}
          />
        </div>

        {(
          [
            ['join', '进服通知', '{player}'],
            ['leave', '退服通知', '{player}'],
            ['death', '死亡通知', '{player} {detail}'],
            ['advancement', '成就通知', '{player} {detail}'],
            ['serverStart', '服务器启动', '—'],
          ] as const
        ).map(([key, label, vars]) => (
          <div key={key} className="row-flex" style={{ alignItems: 'flex-end', gap: 12 }}>
            <label className="check-row" style={{ minWidth: 130 }}>
              <input
                type="checkbox"
                checked={nt[key].enabled}
                onChange={(e) =>
                  patchNotify({ [key]: { ...nt[key], enabled: e.target.checked } } as never)
                }
              />
              <span>{label}</span>
            </label>
            <div className="field" style={{ flex: 1 }}>
              <input
                value={nt[key].template}
                placeholder={`可用变量：${vars}`}
                onChange={(e) =>
                  patchNotify({ [key]: { ...nt[key], template: e.target.value } } as never)
                }
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
