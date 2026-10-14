import React, { useCallback, useEffect, useState } from 'react';
import type { BindCodeRecord, Binding, CardUpdatePolicy } from '../../shared/types';
import type { PageProps } from '../App';

/** 把一行一个 ID 的文本转成数组 */
function parseIds(text: string): string[] {
  return text
    .split(/[\n,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 剩余秒数 → 人话 */
function remainText(expiresAt: string): string {
  const left = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000);
  if (left <= 0) return '已过期';
  const m = Math.floor(left / 60);
  const s = left % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/**
 * 账号绑定页。
 *
 * 对齐 EasyBot 的能力：
 * - 双向验证模式：服务器取码 → 群内发「绑定 <验证码>」
 * - 社交平台信任模式：群内直接发「绑定 <玩家ID>」
 * - 强制绑定：列表中的服务器必须绑定才可进入，解绑即踢出
 * - 退群自动解绑、绑定后改群名片
 */
export function BindingsPage({ config, patch }: PageProps) {
  const b = config.binding;
  const [list, setList] = useState<Binding[]>([]);
  const [pending, setPending] = useState<BindCodeRecord[]>([]);
  const [qq, setQq] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [msg, setMsg] = useState('');
  const [issued, setIssued] = useState('');
  const [filter, setFilter] = useState('');

  const refresh = useCallback(async () => {
    const [bindings, codes] = await Promise.all([
      window.bridge.listBindings(),
      window.bridge.listPendingCodes(),
    ]);
    setList(bindings);
    setPending(codes);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 待验证码会随有效期变化，定时刷新让剩余时间保持准确
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const add = async () => {
    if (!qq.trim() || !playerId.trim()) {
      setMsg('请填写 QQ 号与玩家 ID');
      return;
    }
    const res = await window.bridge.addBinding(qq.trim(), playerId.trim());
    if (res.ok) {
      setMsg(`已绑定 ${qq.trim()} ↔ ${playerId.trim()}`);
      setPlayerId('');
      await refresh();
    } else {
      setMsg(res.error ?? '绑定失败');
    }
  };

  const remove = async (b: Binding) => {
    const res = await window.bridge.removeBinding(b.qq, b.playerId);
    setMsg(res.ok ? `已解除 ${b.playerId}` : res.error ?? '解绑失败');
    await refresh();
  };

  const issue = async () => {
    const id = playerId.trim();
    if (!id) {
      setIssued('请先在上方填写玩家 ID');
      return;
    }
    const res = await window.bridge.issueCode(id);
    if (res.ok && res.code) {
      setIssued(`已为 ${id} 签发验证码：${res.code}（在群内发送「绑定 ${res.code}」）`);
      await refresh();
    } else {
      setIssued(res.error ?? '签发失败');
    }
  };

  const cancelCode = async (code: string) => {
    const res = await window.bridge.cancelPendingCode(code);
    setMsg(res.ok ? `已撤销验证码 ${code}` : res.error ?? '撤销失败');
    await refresh();
  };

  const filtered = filter.trim()
    ? list.filter(
        (x) =>
          x.qq.includes(filter.trim()) ||
          x.playerId.toLowerCase().includes(filter.trim().toLowerCase()),
      )
    : list;

  return (
    <>
      <h1 className="page-title">账号绑定</h1>
      <p className="page-desc">
        建立 QQ 号与 Minecraft 玩家 ID 的对应关系。绑定模式、验证码规则与强制绑定策略均在此配置。
      </p>

      {/* ---------- 绑定模式 ---------- */}
      <div className="card">
        <h2 className="card-title">绑定模式</h2>
        <p className="card-desc">
          两种模式互斥。双向验证更安全（需要游戏内与社交平台两侧确认），信任模式更轻便。
        </p>

        <div className="mode-picker">
          <label className={`mode-card ${b.mode === 'code' ? 'active' : ''}`}>
            <input
              type="radio"
              name="bind-mode"
              checked={b.mode === 'code'}
              onChange={() => patch({ binding: { ...b, mode: 'code' } })}
            />
            <div className="mode-body">
              <div className="mode-name">双向验证模式</div>
              <div className="mode-desc">
                玩家在服务器内执行 <span className="mono">/{b.serverBindCommand}</span>{' '}
                获取验证码，再在群内发送「绑定 &lt;验证码&gt;」完成绑定。
              </div>
            </div>
          </label>

          <label className={`mode-card ${b.mode === 'trust' ? 'active' : ''}`}>
            <input
              type="radio"
              name="bind-mode"
              checked={b.mode === 'trust'}
              onChange={() => patch({ binding: { ...b, mode: 'trust' } })}
            />
            <div className="mode-body">
              <div className="mode-name">社交平台信任模式</div>
              <div className="mode-desc">
                玩家直接在群内发送「绑定 &lt;玩家ID&gt;」即可完成绑定，无需进服取码。
              </div>
            </div>
          </label>
        </div>
      </div>

      {/* ---------- 双向验证参数（仅 code 模式显示） ---------- */}
      {b.mode === 'code' && (
        <div className="card">
          <h2 className="card-title">验证码规则</h2>
          <p className="card-desc">
            验证码一次性有效，同一玩家重新取码时旧码立即作废，避免多个有效码并存。
          </p>

          <div className="grid-3">
            <div className="field">
              <label>验证码位数</label>
              <input
                type="number"
                min={4}
                max={12}
                value={b.codeLength}
                onChange={(e) =>
                  patch({
                    binding: {
                      ...b,
                      codeLength: Math.min(12, Math.max(4, Number(e.target.value) || 6)),
                    },
                  })
                }
              />
            </div>
            <div className="field">
              <label>验证码类型</label>
              <select
                value={b.codeFormat}
                onChange={(e) =>
                  patch({
                    binding: { ...b, codeFormat: e.target.value as typeof b.codeFormat },
                  })
                }
              >
                <option value="number">纯数字</option>
                <option value="letter">纯字母</option>
                <option value="mixed">数字 + 字母</option>
              </select>
            </div>
            <div className="field">
              <label>有效期（秒）</label>
              <input
                type="number"
                min={30}
                value={b.codeTtlSeconds}
                onChange={(e) =>
                  patch({
                    binding: {
                      ...b,
                      codeTtlSeconds: Math.max(30, Number(e.target.value) || 300),
                    },
                  })
                }
              />
            </div>
          </div>

          <div className="field">
            <label>服务器内取码指令</label>
            <input
              type="text"
              className="mono"
              value={b.serverBindCommand}
              onChange={(e) =>
                patch({ binding: { ...b, serverBindCommand: e.target.value } })
              }
              placeholder="easybot bind"
            />
          </div>

          <div className="check-row">
            <input
              id="push-code"
              type="checkbox"
              checked={b.pushCodeToServer}
              onChange={(e) =>
                patch({ binding: { ...b, pushCodeToServer: e.target.checked } })
              }
            />
            <label htmlFor="push-code">
              通过 RCON 把验证码播报到游戏内（tellraw 到玩家本人）
            </label>
          </div>
        </div>
      )}

      {/* ---------- 通用开关 ---------- */}
      <div className="card">
        <h2 className="card-title">绑定策略</h2>

        <div className="grid-2">
          <div className="field">
            <label>单个 QQ 最多可绑定的玩家 ID 数量</label>
            <input
              type="number"
              min={1}
              value={b.maxBindingsPerQQ}
              onChange={(e) =>
                patch({
                  binding: {
                    ...b,
                    maxBindingsPerQQ: Math.max(1, Number(e.target.value) || 1),
                  },
                })
              }
            />
          </div>
          <div className="field">
            <label>绑定超限时的行为</label>
            <input type="text" value="拒绝新绑定，需先使用 /解绑 释放名额" disabled />
          </div>
        </div>

        <div className="check-row">
          <input
            id="allow-self-bind"
            type="checkbox"
            checked={b.allowSelfBind}
            onChange={(e) =>
              patch({ binding: { ...b, allowSelfBind: e.target.checked } })
            }
          />
          <label htmlFor="allow-self-bind">
            允许玩家自助绑定（关闭后仅可通过本页面的管理员操作绑定）
          </label>
        </div>

        <div className="check-row">
          <input
            id="allow-self-unbind"
            type="checkbox"
            checked={b.allowSelfUnbind}
            onChange={(e) =>
              patch({ binding: { ...b, allowSelfUnbind: e.target.checked } })
            }
          />
          <label htmlFor="allow-self-unbind">允许玩家自助解绑</label>
        </div>

        <div className="check-row">
          <input
            id="require-binding"
            type="checkbox"
            checked={b.requireBindingForCommands}
            onChange={(e) =>
              patch({
                binding: { ...b, requireBindingForCommands: e.target.checked },
              })
            }
          />
          <label htmlFor="require-binding">
            执行指令前必须先绑定游戏账号（管理员的指令不受此限制）
          </label>
        </div>

        <div className="check-row">
          <input
            id="mention-reply"
            type="checkbox"
            checked={b.mentionOnReply}
            onChange={(e) =>
              patch({ binding: { ...b, mentionOnReply: e.target.checked } })
            }
          />
          <label htmlFor="mention-reply">
            绑定类回复时 @ 触发者（群聊内生效）
          </label>
        </div>
      </div>

      {/* ---------- 强制绑定 ---------- */}
      <div className="card">
        <h2 className="card-title">强制绑定</h2>
        <p className="card-desc">
          列表中的服务器要求玩家必须完成绑定。玩家解绑或未绑定时会被拒绝进入，在线解绑后立即踢出。
        </p>

        <div className="check-row">
          <input
            id="force-bind-enabled"
            type="checkbox"
            checked={b.forceBind.enabled}
            onChange={(e) =>
              patch({
                binding: {
                  ...b,
                  forceBind: { ...b.forceBind, enabled: e.target.checked },
                },
              })
            }
          />
          <label htmlFor="force-bind-enabled">启用强制绑定</label>
        </div>

        <div className="field">
          <label>
            生效的服务器标识（每行一个；留空表示当前所有服务器）
          </label>
          <textarea
            value={b.forceBind.servers.join('\n')}
            onChange={(e) =>
              patch({
                binding: {
                  ...b,
                  forceBind: {
                    ...b.forceBind,
                    servers: parseIds(e.target.value),
                  },
                },
              })
            }
            placeholder={'main\nsurvival'}
            disabled={!b.forceBind.enabled}
          />
        </div>

        <div className="field">
          <label>踢出提示（支持 MC 颜色码，如 &amp;c）</label>
          <input
            type="text"
            value={b.messages.kickMessage}
            onChange={(e) =>
              patch({
                binding: {
                  ...b,
                  messages: { ...b.messages, kickMessage: e.target.value },
                },
              })
            }
            disabled={!b.forceBind.enabled}
          />
        </div>
      </div>

      {/* ---------- 事件与群名片 ---------- */}
      <div className="card">
        <h2 className="card-title">事件与群名片</h2>

        <div className="check-row">
          <input
            id="unbind-on-leave"
            type="checkbox"
            checked={b.unbindOnGroupLeave}
            onChange={(e) =>
              patch({ binding: { ...b, unbindOnGroupLeave: e.target.checked } })
            }
          />
          <label htmlFor="unbind-on-leave">
            成员退群时自动解绑其所有账号（对齐 EasyBot 的「退群事件」）
          </label>
        </div>

        <div className="grid-2" style={{ marginTop: 12 }}>
          <div className="field">
            <label>群名片改名策略</label>
            <select
              value={b.cardUpdate}
              onChange={(e) =>
                patch({
                  binding: { ...b, cardUpdate: e.target.value as CardUpdatePolicy },
                })
              }
            >
              <option value="off">不修改群名片</option>
              <option value="on_bind">绑定/解绑成功后改名</option>
              <option value="on_message">玩家发消息时检查并更新</option>
            </select>
          </div>
          <div className="field">
            <label>群名片前缀（可留空）</label>
            <input
              type="text"
              value={b.cardPrefix}
              onChange={(e) => patch({ binding: { ...b, cardPrefix: e.target.value } })}
              placeholder="如 [玩家] "
            />
          </div>
        </div>
        <p className="hint">
          「发消息时更新」每次消息都会触发一次数据库查询与 API 调用，可能影响响应速度。
        </p>
      </div>

      {/* ---------- 消息模板 ---------- */}
      <div className="card">
        <h2 className="card-title">消息模板</h2>
        <p className="card-desc">
          占位符：<span className="mono">#player</span> 玩家ID、<span className="mono">#qq</span>{' '}
          QQ号、<span className="mono">#code</span> 验证码、<span className="mono">#time</span>{' '}
          有效期、<span className="mono">#current</span>/<span className="mono">#max</span>{' '}
          已绑数量/上限、<span className="mono">#why</span> 失败原因。
        </p>

        <div className="field">
          <label>绑定成功</label>
          <input
            type="text"
            value={b.messages.bindSuccess}
            onChange={(e) =>
              patch({
                binding: {
                  ...b,
                  messages: { ...b.messages, bindSuccess: e.target.value },
                },
              })
            }
          />
        </div>

        <div className="field">
          <label>绑定失败</label>
          <input
            type="text"
            value={b.messages.bindFail}
            onChange={(e) =>
              patch({
                binding: {
                  ...b,
                  messages: { ...b.messages, bindFail: e.target.value },
                },
              })
            }
          />
        </div>

        <div className="field">
          <label>解绑成功</label>
          <input
            type="text"
            value={b.messages.unbindSuccess}
            onChange={(e) =>
              patch({
                binding: {
                  ...b,
                  messages: { ...b.messages, unbindSuccess: e.target.value },
                },
              })
            }
          />
        </div>

        {b.mode === 'code' && (
          <>
            <div className="field">
              <label>服务器内展示的验证码提示</label>
              <input
                type="text"
                value={b.messages.serverHint}
                onChange={(e) =>
                  patch({
                    binding: {
                      ...b,
                      messages: { ...b.messages, serverHint: e.target.value },
                    },
                  })
                }
              />
            </div>
            <div className="field">
              <label>群内提示「去取码」</label>
              <input
                type="text"
                value={b.messages.bindStart}
                onChange={(e) =>
                  patch({
                    binding: {
                      ...b,
                      messages: { ...b.messages, bindStart: e.target.value },
                    },
                  })
                }
              />
            </div>
          </>
        )}
      </div>

      {/* ---------- 待验证码 ---------- */}
      {b.mode === 'code' && (
        <div className="card">
          <div className="row-flex" style={{ marginBottom: 12 }}>
            <h2 className="card-title" style={{ flex: 1, margin: 0 }}>
              待验证码（{pending.length}）
            </h2>
            <button className="btn" onClick={() => void refresh()}>
              刷新
            </button>
          </div>
          <p className="card-desc">
            当前已签发但尚未使用的验证码。可手动撤销，撤销后玩家需要重新取码。
          </p>

          {pending.length === 0 ? (
            <div className="empty">当前没有待验证的验证码</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 110 }}>验证码</th>
                  <th style={{ width: 150 }}>玩家 ID</th>
                  <th style={{ width: 130 }}>发起群</th>
                  <th style={{ width: 110 }}>剩余时间</th>
                  <th style={{ width: 70 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.code}>
                    <td className="mono" style={{ fontWeight: 600 }}>
                      {p.code}
                    </td>
                    <td className="mono">{p.playerId}</td>
                    <td>{p.groupId ?? '—'}</td>
                    <td>{remainText(p.expiresAt)}</td>
                    <td>
                      <button
                        className="btn danger"
                        onClick={() => void cancelCode(p.code)}
                      >
                        撤销
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---------- 管理员操作 ---------- */}
      <div className="card">
        <h2 className="card-title">管理员操作</h2>
        <p className="card-desc">
          管理员绑定会覆盖该玩家 ID 原有的归属，且不受「自助绑定」开关与数量上限限制。
        </p>

        <div className="grid-2">
          <div className="field">
            <label>QQ 号</label>
            <input
              type="text"
              value={qq}
              onChange={(e) => setQq(e.target.value)}
              placeholder="10001"
            />
          </div>
          <div className="field">
            <label>Minecraft 玩家 ID</label>
            <input
              type="text"
              value={playerId}
              onChange={(e) => setPlayerId(e.target.value)}
              placeholder="Steve"
            />
          </div>
        </div>

        <div className="btn-row">
          <button className="btn primary" onClick={add}>
            建立绑定
          </button>
          {b.mode === 'code' && (
            <button className="btn" onClick={issue}>
              签发验证码（仅用玩家 ID）
            </button>
          )}
        </div>

        {msg && <p className="hint">{msg}</p>}
        {issued && <div className="output">{issued}</div>}
      </div>

      {/* ---------- 绑定列表 ---------- */}
      <div className="card">
        <div className="row-flex" style={{ marginBottom: 12 }}>
          <h2 className="card-title" style={{ flex: 1, margin: 0 }}>
            绑定列表（{filtered.length}
            {filter.trim() ? ` / 共 ${list.length}` : ''}）
          </h2>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按 QQ 或玩家ID 筛选"
            style={{ width: 220 }}
          />
          <button className="btn" onClick={() => void refresh()}>
            刷新
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="empty">
            {list.length === 0 ? '暂无绑定记录' : '没有匹配的记录'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 120 }}>QQ 号</th>
                <th style={{ width: 150 }}>玩家 ID</th>
                <th style={{ width: 110 }}>来源群</th>
                <th style={{ width: 90 }}>服务器</th>
                <th>创建时间</th>
                <th style={{ width: 70 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((x) => (
                <tr key={`${x.qq}-${x.playerId}`}>
                  <td className="mono">{x.qq}</td>
                  <td className="mono">{x.playerId}</td>
                  <td>{x.fromGroup ?? '—'}</td>
                  <td>{x.serverId ?? '—'}</td>
                  <td>{new Date(x.createdAt).toLocaleString('zh-CN')}</td>
                  <td>
                    <button className="btn danger" onClick={() => void remove(x)}>
                      解绑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
