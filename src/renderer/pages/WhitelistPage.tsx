import React, { useState } from 'react';
import type { PageProps } from '../App';

/** 把一行一个 ID 的文本转成数组 */
function parseIds(text: string): string[] {
  return text
    .split(/[\n,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 群 / 私聊白名单配置页。
 * 只有白名单内的会话才会被处理；管理员不受白名单限制。
 */
export function WhitelistPage({ config, patch }: PageProps) {
  const wl = config.whitelist;
  const [groupText, setGroupText] = useState(wl.groups.join('\n'));
  const [privateText, setPrivateText] = useState(wl.privates.join('\n'));
  const [adminText, setAdminText] = useState(wl.admins.join('\n'));

  const commit = (field: 'groups' | 'privates' | 'admins', text: string) => {
    patch({ whitelist: { ...wl, [field]: parseIds(text) } });
  };

  return (
    <>
      <h1 className="page-title">群 / 私聊白名单</h1>
      <p className="page-desc">
        决定机器人在哪些聊天场景中响应。未在白名单内的消息会被直接忽略，不会产生任何 RCON 调用。
      </p>

      <div className="card">
        <h2 className="card-title">聊天源白名单</h2>
        <p className="card-desc">
          每行一个号码，也支持用逗号或空格分隔。留空表示不响应任何此类会话。
        </p>

        <div className="check-row">
          <input
            id="group-enabled"
            type="checkbox"
            checked={wl.groupEnabled}
            onChange={(e) => patch({ whitelist: { ...wl, groupEnabled: e.target.checked } })}
          />
          <label htmlFor="group-enabled">启用群聊响应</label>
        </div>

        <div className="field">
          <label>允许的群号</label>
          <textarea
            value={groupText}
            onChange={(e) => {
              setGroupText(e.target.value);
              commit('groups', e.target.value);
            }}
            placeholder={'123456789\n987654321'}
            disabled={!wl.groupEnabled}
          />
        </div>

        <div className="check-row">
          <input
            id="private-enabled"
            type="checkbox"
            checked={wl.privateEnabled}
            onChange={(e) => patch({ whitelist: { ...wl, privateEnabled: e.target.checked } })}
          />
          <label htmlFor="private-enabled">启用私聊响应</label>
        </div>

        <div className="field">
          <label>允许私聊的 QQ 号</label>
          <textarea
            value={privateText}
            onChange={(e) => {
              setPrivateText(e.target.value);
              commit('privates', e.target.value);
            }}
            placeholder={'10001\n10002'}
            disabled={!wl.privateEnabled}
          />
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">管理员</h2>
        <p className="card-desc">
          管理员不受群 / 私聊白名单限制，并可执行标记为「仅管理员」的指令。
        </p>

        <div className="field">
          <label>管理员 QQ 号</label>
          <textarea
            value={adminText}
            onChange={(e) => {
              setAdminText(e.target.value);
              commit('admins', e.target.value);
            }}
            placeholder={'10001'}
          />
        </div>
        <p className="hint">
          当前管理员数量：{wl.admins.length}　|　群：{wl.groups.length} 个　|　私聊：
          {wl.privates.length} 个
        </p>
      </div>
    </>
  );
}
