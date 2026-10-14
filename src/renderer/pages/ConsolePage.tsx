import React, { useState } from 'react';

/**
 * 指令控制台：手动执行 RCON 命令，并可直接向指定群/私聊发送测试消息。
 * 所有手动执行的命令同样记入审计日志。
 */
export function ConsolePage() {
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);

  const [targetType, setTargetType] = useState<'group' | 'private'>('group');
  const [targetId, setTargetId] = useState('');
  const [message, setMessage] = useState('');
  const [sendMsg, setSendMsg] = useState('');

  const run = async () => {
    const cmd = command.trim();
    if (!cmd) return;
    setBusy(true);
    setOutput(`> ${cmd}\n执行中…`);
    const res = await window.bridge.executeRcon(cmd);
    setOutput(
      `> ${cmd}\n${res.success ? res.response || '（无输出）' : `✘ ${res.error ?? '执行失败'}`}`,
    );
    setBusy(false);
  };

  const send = async () => {
    if (!targetId.trim() || !message.trim()) {
      setSendMsg('请填写目标 ID 与消息内容');
      return;
    }
    const res = await window.bridge.sendTestMessage(
      targetType,
      targetId.trim(),
      message.trim(),
    );
    setSendMsg(res.ok ? '✔ 已发送' : `✘ ${res.error ?? '发送失败'}`);
  };

  const quick = [
    { label: '查看在线', cmd: 'list' },
    { label: '查看白名单', cmd: 'whitelist list' },
    { label: '重载白名单', cmd: 'whitelist reload' },
    { label: '保存世界', cmd: 'save-all' },
  ];

  return (
    <>
      <h1 className="page-title">指令控制台</h1>
      <p className="page-desc">
        手动向 Minecraft 服务器发送 RCON 命令，或向指定 QQ 会话发送消息，用于调试链路。
      </p>

      <div className="card">
        <h2 className="card-title">RCON 命令</h2>
        <p className="card-desc">
          此处的命令以管理员身份直接执行，绕过权限校验，但同样会记录审计日志。
        </p>

        <div className="field">
          <label>命令内容（不需要加斜杠）</label>
          <input
            type="text"
            className="mono"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run();
            }}
            placeholder="whitelist add Steve"
          />
        </div>

        <div className="btn-row">
          <button className="btn primary" disabled={busy} onClick={run}>
            执行
          </button>
          {quick.map((q) => (
            <button
              key={q.cmd}
              className="btn"
              onClick={() => setCommand(q.cmd)}
            >
              {q.label}
            </button>
          ))}
        </div>

        {output && <div className="output">{output}</div>}
      </div>

      <div className="card">
        <h2 className="card-title">发送测试消息</h2>
        <p className="card-desc">验证 QQ 通道是否打通。消息会以机器人身份发出。</p>

        <div className="grid-2">
          <div className="field">
            <label>目标类型</label>
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as 'group' | 'private')}
            >
              <option value="group">群聊</option>
              <option value="private">私聊</option>
            </select>
          </div>
          <div className="field">
            <label>{targetType === 'group' ? '群号' : 'QQ 号'}</label>
            <input
              type="text"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="123456789"
            />
          </div>
        </div>

        <div className="field">
          <label>消息内容</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="机器人连通性测试"
          />
        </div>

        <div className="btn-row">
          <button className="btn primary" onClick={send}>
            发送
          </button>
        </div>

        {sendMsg && <p className="hint">{sendMsg}</p>}
      </div>
    </>
  );
}
