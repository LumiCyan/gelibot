import React, { useState } from 'react';
import type { SnowLumaStatus } from '../../shared/types';
import type { PageProps } from '../App';
import { SnowLumaCard } from './SnowLumaCard';

export function ConnectionPage({
  config,
  status,
  patch,
  snowluma,
  onReset,
}: PageProps & { snowluma: SnowLumaStatus | null; onReset: () => void }) {
  const [testOutput, setTestOutput] = useState('');
  const [busy, setBusy] = useState(false);

  const testRcon = async () => {
    setBusy(true);
    setTestOutput('正在执行 list …');
    const res = await window.bridge.testRcon();
    setTestOutput(
      res.success
        ? `✔ 成功\n${res.response || '（无输出）'}`
        : `✘ 失败\n${res.error ?? '未知错误'}`,
    );
    setBusy(false);
  };

  return (
    <>
      <h1 className="page-title">连接设置</h1>
      <p className="page-desc">
        分别配置 Minecraft 服务器的 RCON 通道与 SnowLuma 提供的 OneBot v11 通道。
        保存后会自动重连生效。
      </p>

      <div className="banner warn">
        <strong>安全提醒：</strong>RCON 使用明文 TCP 传输密码，持有密码即等于拥有服务器控制台权限。
        请务必只在 <span className="mono">127.0.0.1</span> 监听，不要将 25575 端口暴露到公网。
        跨机部署请通过 SSH 隧道或内网连接。
      </div>

      <SnowLumaCard config={config} snowluma={snowluma} patch={patch} />

      <div className="card">
        <h2 className="card-title">Minecraft 服务器（RCON）</h2>
        <p className="card-desc">
          需在服务端的 <span className="mono">server.properties</span> 中设置{' '}
          <span className="mono">enable-rcon=true</span>、
          <span className="mono">rcon.port=25575</span>、
          <span className="mono">rcon.password=&lt;强随机串&gt;</span>。
        </p>

        <div className="grid-2">
          <div className="field">
            <label>主机地址</label>
            <input
              type="text"
              value={config.rcon.host}
              onChange={(e) => patch({ rcon: { ...config.rcon, host: e.target.value } })}
              placeholder="127.0.0.1"
            />
          </div>
          <div className="field">
            <label>端口</label>
            <input
              type="number"
              value={config.rcon.port}
              onChange={(e) =>
                patch({ rcon: { ...config.rcon, port: Number(e.target.value) || 25575 } })
              }
            />
          </div>
        </div>

        <div className="field">
          <label>RCON 密码</label>
          <input
            type="password"
            value={config.rcon.password}
            onChange={(e) => patch({ rcon: { ...config.rcon, password: e.target.value } })}
            placeholder="与 server.properties 中 rcon.password 一致"
          />
        </div>

        <div className="grid-2">
          <div className="field">
            <label>命令超时（毫秒）</label>
            <input
              type="number"
              value={config.rcon.timeoutMs}
              onChange={(e) =>
                patch({ rcon: { ...config.rcon, timeoutMs: Number(e.target.value) || 8000 } })
              }
            />
          </div>
          <div className="field">
            <label>断线重连间隔（毫秒，0 = 不重连）</label>
            <input
              type="number"
              value={config.rcon.reconnectIntervalMs}
              onChange={(e) =>
                patch({
                  rcon: { ...config.rcon, reconnectIntervalMs: Number(e.target.value) || 0 },
                })
              }
            />
          </div>
        </div>

        <div className="btn-row">
          <button className="btn" disabled={busy} onClick={testRcon}>
            测试连接（执行 list）
          </button>
          <button
            className="btn"
            onClick={() => void window.bridge.reconnectRcon()}
          >
            立即重连
          </button>
        </div>

        {testOutput && <div className="output">{testOutput}</div>}
        {status?.rcon.lastError && (
          <div className="banner err">
            <strong>连接失败：</strong>
            {status.rcon.lastError}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">OneBot v11 连接</h2>
        <p className="card-desc">
          上面的 SnowLuma 启动后，在它的后台里进入节点配置 → WS 服务端，
          记下端口与 Token 后填入此处，本程序就能通过 OneBot 协议收发 QQ 消息了。
        </p>

        <div className="field">
          <label>WebSocket 地址</label>
          <input
            type="text"
            value={config.onebot.wsUrl}
            onChange={(e) => patch({ onebot: { ...config.onebot, wsUrl: e.target.value } })}
            placeholder="ws://127.0.0.1:3001"
          />
        </div>

        <div className="grid-2">
          <div className="field">
            <label>访问令牌（可留空）</label>
            <input
              type="password"
              value={config.onebot.accessToken}
              onChange={(e) =>
                patch({ onebot: { ...config.onebot, accessToken: e.target.value } })
              }
            />
          </div>
          <div className="field">
            <label>重连间隔（毫秒）</label>
            <input
              type="number"
              value={config.onebot.reconnectIntervalMs}
              onChange={(e) =>
                patch({
                  onebot: {
                    ...config.onebot,
                    reconnectIntervalMs: Number(e.target.value) || 5000,
                  },
                })
              }
            />
          </div>
        </div>

        <div className="check-row">
          <input
            id="onebot-auto-reconnect"
            type="checkbox"
            checked={config.onebot.autoReconnect}
            onChange={(e) =>
              patch({ onebot: { ...config.onebot, autoReconnect: e.target.checked } })
            }
          />
          <label htmlFor="onebot-auto-reconnect">断线后自动重连</label>
        </div>

        <div className="btn-row">
          <button className="btn" onClick={() => void window.bridge.reconnectOneBot()}>
            立即重连
          </button>
        </div>

        {status?.onebot.lastError && (
          <div className="banner err">
            <strong>连接失败：</strong>
            {status.onebot.lastError}
          </div>
        )}

        <details className="field-help">
          <summary>连不上？按这三步排查</summary>
          <ol>
            <li>
              <strong>Token 必须与服务端完全一致。</strong>
              SnowLuma 后台 → 节点配置 → <span className="mono">WS 服务端</span>，
              那里有一个 <span className="mono">accessToken</span>，复制到上面的「访问令牌」。
              留空而服务端设了 Token，握手会直接返回 <span className="mono">401</span>。
            </li>
            <li>
              <strong>端口要填 WS 服务端的端口</strong>（默认 <span className="mono">3001</span>），
              不是 WebUI 的 <span className="mono">5099</span>。
              填错会看到 <span className="mono">426 Upgrade Required</span> 或 404。
            </li>
            <li>
              <strong>确认 WS 服务端已启用</strong>，且 host 是{' '}
              <span className="mono">127.0.0.1</span>。可在 SnowLuma 后台的节点状态里看到监听地址。
            </li>
          </ol>
        </details>
      </div>

      <div className="card">
        <h2 className="card-title">其他</h2>
        <div className="field" style={{ maxWidth: 320 }}>
          <label>同一用户的指令冷却时间（毫秒）</label>
          <input
            type="number"
            value={config.rateLimitMs}
            onChange={(e) => patch({ rateLimitMs: Number(e.target.value) || 0 })}
          />
        </div>
        <p className="hint">防止群内刷指令导致 RCON 被高频调用。</p>

        <div className="btn-row">
          <button className="btn danger" onClick={onReset}>
            恢复默认配置
          </button>
        </div>
      </div>
    </>
  );
}
