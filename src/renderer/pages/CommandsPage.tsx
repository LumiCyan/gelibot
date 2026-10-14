import React from 'react';
import type { CommandRule } from '../../shared/types';
import type { PageProps } from '../App';

/** 生成一个稳定的 ID */
function newId(): string {
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 指令管理页。
 *
 * 安全关键：所有投递到 RCON 的指令都必须以「模板」形式定义，
 * 玩家输入只作为参数代入，无法拼接出模板之外的命令。
 */
export function CommandsPage({ config, patch }: PageProps) {
  const commands = config.commands;

  const update = (id: string, partial: Partial<CommandRule>) => {
    patch({
      commands: commands.map((c) => (c.id === id ? { ...c, ...partial } : c)),
    });
  };

  const remove = (id: string) => {
    patch({ commands: commands.filter((c) => c.id !== id) });
  };

  const add = () => {
    patch({
      commands: [
        ...commands,
        {
          id: newId(),
          name: '新指令',
          template: 'say hello',
          scope: 'both',
          adminOnly: true,
          allowArgs: false,
          enabled: true,
          description: '请填写说明',
        },
      ],
    });
  };

  return (
    <>
      <h1 className="page-title">指令管理</h1>
      <p className="page-desc">
        定义群成员可以用哪些指令、分别对应什么 RCON 命令、以及需要什么权限。
      </p>

      <div className="banner info">
        <strong>如何安全地配置指令：</strong>
        在「命令模板」中写死真正要执行的 RCON 命令，用{' '}
        <span className="mono">{'{arg0}'}</span>、<span className="mono">{'{arg1}'}</span> 或{' '}
        <span className="mono">{'{args}'}</span> 表示玩家传入的参数。
        例如模板 <span className="mono">whitelist add {'{arg0}'}</span>，
        玩家发 <span className="mono">/加白 Steve</span> 时，实际执行的是{' '}
        <span className="mono">whitelist add Steve</span>。
        参数会强制校验为合法玩家 ID，无法注入其它命令。
      </div>

      <div className="card">
        <h2 className="card-title">绑定类指令</h2>
        <p className="card-desc">
          <span className="mono">/绑定</span>、<span className="mono">/解绑</span>、
          <span className="mono">/我的绑定</span>、<span className="mono">/查询绑定</span>、
          <span className="mono">/帮助</span> 为内置指令，由程序直接处理，不投递 RCON。
          它们的行为随「账号绑定」页的绑定模式变化：
        </p>
        <p className="hint">
          {config.binding.mode === 'code' ? (
            <>
              <strong>当前为双向验证模式：</strong>玩家先在服务器内执行{' '}
              <span className="mono">/{config.binding.serverBindCommand}</span> 获取验证码，
              再在群内发送「绑定 &lt;验证码&gt;」完成绑定。
            </>
          ) : (
            <>
              <strong>当前为社交平台信任模式：</strong>玩家直接在群内发送「绑定 &lt;玩家ID&gt;」
              即可完成绑定，无需进服取码。
            </>
          )}
        </p>
      </div>

      <div className="card">
        <div className="row-flex" style={{ marginBottom: 12 }}>
          <h2 className="card-title" style={{ flex: 1, margin: 0 }}>
            RCON 指令列表（{commands.length}）
          </h2>
          <button className="btn primary" onClick={add}>
            新增指令
          </button>
        </div>

        {commands.length === 0 && <div className="empty">暂无指令，点击右上角新增</div>}

        {commands.map((cmd) => (
          <div
            key={cmd.id}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '12px 14px',
              marginBottom: 10,
              background: cmd.enabled ? 'var(--surface)' : '#fafbfc',
              opacity: cmd.enabled ? 1 : 0.68,
            }}
          >
            <div className="row-flex" style={{ marginBottom: 10 }}>
              <input
                type="text"
                value={cmd.name}
                onChange={(e) => update(cmd.id, { name: e.target.value })}
                placeholder="触发命令名，如：加白"
                style={{ flex: 1 }}
              />
              <select
                value={cmd.scope}
                onChange={(e) => update(cmd.id, { scope: e.target.value as CommandRule['scope'] })}
                style={{ width: 110 }}
              >
                <option value="both">群+私聊</option>
                <option value="group">仅群聊</option>
                <option value="private">仅私聊</option>
              </select>
              <button className="btn danger" onClick={() => remove(cmd.id)}>
                删除
              </button>
            </div>

            <div className="field">
              <label>命令模板（真正投递给 RCON 的内容）</label>
              <input
                type="text"
                className="mono"
                value={cmd.template}
                onChange={(e) => update(cmd.id, { template: e.target.value })}
                placeholder="whitelist add {arg0}"
              />
            </div>

            <div className="field">
              <label>说明（显示在 /帮助 中）</label>
              <input
                type="text"
                value={cmd.description}
                onChange={(e) => update(cmd.id, { description: e.target.value })}
              />
            </div>

            <div className="row-flex" style={{ flexWrap: 'wrap', gap: 16 }}>
              <label style={{ fontSize: 12, color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={cmd.enabled}
                  onChange={(e) => update(cmd.id, { enabled: e.target.checked })}
                />
                启用
              </label>
              <label style={{ fontSize: 12, color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={cmd.adminOnly}
                  onChange={(e) => update(cmd.id, { adminOnly: e.target.checked })}
                />
                仅管理员
              </label>
              <label style={{ fontSize: 12, color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={cmd.allowArgs}
                  onChange={(e) => update(cmd.id, { allowArgs: e.target.checked })}
                />
                允许携带参数
              </label>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
