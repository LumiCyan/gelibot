import React, { useCallback, useEffect, useState } from 'react';
import type {
  AppConfig,
  DataDirInfo,
  DataTransferResult,
  PresencePreview,
  SnowLumaStatus,
} from '../../shared/types';
import type { PageProps } from '../App';
import { SnowLumaCard } from './SnowLumaCard';

/** 把字节数显示成人看得懂的形式 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 把一次导出/导入/迁移的结果整成可读文本 */
function renderTransferResult(title: string, res: DataTransferResult): string {
  if (!res.ok) return `✘ ${title}：${res.error ?? '未知错误'}`;
  return [`✔ ${title}`, ...(res.lines ?? []).map((l) => `· ${l}`)].join('\n');
}

export function ConnectionPage({
  config,
  status,
  patch,
  snowluma,
  onReset,
  onReload,
}: PageProps & {
  snowluma: SnowLumaStatus | null;
  onReset: () => void;
  /** 导入配置成功后重新拉取配置 */
  onReload: () => void;
}) {
  const [testOutput, setTestOutput] = useState('');
  const [verifyOutput, setVerifyOutput] = useState('');
  const [busy, setBusy] = useState(false);

  // ---------- 数据与备份 ----------
  const [dataInfo, setDataInfo] = useState<DataDirInfo | null>(null);
  const [dataOutput, setDataOutput] = useState('');
  const [dataBusy, setDataBusy] = useState(false);
  const [withSecrets, setWithSecrets] = useState(false);

  // ---------- 在线展示 ----------
  const [preview, setPreview] = useState<PresencePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const patchPresence = (p: Partial<AppConfig['presence']>) =>
    patch({ presence: { ...config.presence, ...p } });

  const runPreview = async () => {
    setPreviewBusy(true);
    setPreview(null);
    try {
      // 传当前界面上的草稿配置：改了没保存也能预览到真实效果
      setPreview(await window.bridge.previewPresence(config.presence));
    } catch (err) {
      setPreview({ ok: false, demo: false, error: (err as Error).message });
    } finally {
      setPreviewBusy(false);
    }
  };

  const refreshDataInfo = useCallback(() => {
    void window.bridge.getDataDirInfo().then(setDataInfo);
  }, []);

  useEffect(() => {
    refreshDataInfo();
  }, [refreshDataInfo]);

  const runDataAction = async (
    title: string,
    action: () => Promise<DataTransferResult>,
    opts: { reload?: boolean } = {},
  ) => {
    setDataBusy(true);
    setDataOutput(`正在执行：${title} …`);
    try {
      const res = await action();
      setDataOutput(renderTransferResult(title, res));
      if (res.ok) {
        refreshDataInfo();
        // 导入会整体替换配置，必须让上层重新拉一次，否则界面还显示旧值
        if (opts.reload) onReload();
      }
    } catch (err) {
      setDataOutput(`✘ ${title}：${(err as Error).message}`);
    } finally {
      setDataBusy(false);
    }
  };

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

  const testRconVerify = async () => {
    setBusy(true);
    setVerifyOutput('正在执行 list …');
    const res = await window.bridge.testRconVerify();
    setVerifyOutput(
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
        请务必只在 <span className="mono">127.0.0.1</span> 监听，不要将 25575 / 25576
        端口暴露到公网。跨机部署请通过 SSH 隧道或内网连接。
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
        <h2 className="card-title">验证服（双服务器绑定流程）</h2>
        <p className="card-desc">
          启用后，绑定流程改为：玩家先登录<strong>验证服</strong> → 在 QQ
          发「绑定 &lt;玩家ID&gt;」→ 本程序经验证服 RCON 把验证码发到该玩家的游戏内对话框 →
          玩家在 QQ 回填验证码 → 验证通过后经<strong>主服</strong> RCON
          执行 <span className="mono">whitelist add</span>，把玩家放进真正的服务器。
        </p>
        <p className="card-desc">
          两个 RCON 完全独立：上面那个负责日常指令与加白，这一个只负责发验证码。
          验证服和主服可以在同一台机器上（用不同端口），也可以是两台机器。
        </p>

        <div className="check-row">
          <input
            id="verify-enabled"
            type="checkbox"
            checked={config.verifyServer.enabled}
            onChange={(e) =>
              patch({
                verifyServer: { ...config.verifyServer, enabled: e.target.checked },
              })
            }
          />
          <label htmlFor="verify-enabled">
            启用双服验证流程（关闭时使用旧的「服务器内取码」路线）
          </label>
        </div>

        {config.verifyServer.enabled && (
          <>
            <div className="grid-2">
              <div className="field">
                <label>主机地址</label>
                <input
                  type="text"
                  value={config.verifyServer.rcon.host}
                  onChange={(e) =>
                    patch({
                      verifyServer: {
                        ...config.verifyServer,
                        rcon: { ...config.verifyServer.rcon, host: e.target.value },
                      },
                    })
                  }
                  placeholder="127.0.0.1"
                />
              </div>
              <div className="field">
                <label>端口</label>
                <input
                  type="number"
                  value={config.verifyServer.rcon.port}
                  onChange={(e) =>
                    patch({
                      verifyServer: {
                        ...config.verifyServer,
                        rcon: {
                          ...config.verifyServer.rcon,
                          port: Number(e.target.value) || 25576,
                        },
                      },
                    })
                  }
                />
              </div>
            </div>

            <div className="field">
              <label>RCON 密码</label>
              <input
                type="password"
                value={config.verifyServer.rcon.password}
                onChange={(e) =>
                  patch({
                    verifyServer: {
                      ...config.verifyServer,
                      rcon: {
                        ...config.verifyServer.rcon,
                        password: e.target.value,
                      },
                    },
                  })
                }
                placeholder="验证服 server.properties 中的 rcon.password"
              />
            </div>

            <div className="grid-2">
              <div className="field">
                <label>命令超时（毫秒）</label>
                <input
                  type="number"
                  value={config.verifyServer.rcon.timeoutMs}
                  onChange={(e) =>
                    patch({
                      verifyServer: {
                        ...config.verifyServer,
                        rcon: {
                          ...config.verifyServer.rcon,
                          timeoutMs: Number(e.target.value) || 8000,
                        },
                      },
                    })
                  }
                />
              </div>
              <div className="field">
                <label>断线重连间隔（毫秒，0 = 不重连）</label>
                <input
                  type="number"
                  value={config.verifyServer.rcon.reconnectIntervalMs}
                  onChange={(e) =>
                    patch({
                      verifyServer: {
                        ...config.verifyServer,
                        rcon: {
                          ...config.verifyServer.rcon,
                          reconnectIntervalMs: Number(e.target.value) || 0,
                        },
                      },
                    })
                  }
                />
              </div>
            </div>

            <div className="check-row">
              <input
                id="verify-auto-whitelist"
                type="checkbox"
                checked={config.verifyServer.autoWhitelist}
                onChange={(e) =>
                  patch({
                    verifyServer: {
                      ...config.verifyServer,
                      autoWhitelist: e.target.checked,
                    },
                  })
                }
              />
              <label htmlFor="verify-auto-whitelist">
                验证通过后自动把玩家加入主服白名单
              </label>
            </div>

            {config.verifyServer.autoWhitelist && (
              <div className="field">
                <label>加白命令模板</label>
                <input
                  type="text"
                  className="mono"
                  value={config.verifyServer.whitelistAddCommand}
                  onChange={(e) =>
                    patch({
                      verifyServer: {
                        ...config.verifyServer,
                        whitelistAddCommand: e.target.value,
                      },
                    })
                  }
                  placeholder="whitelist add {player}"
                />
                <p className="hint">
                  <span className="mono">{'{player}'}</span>{' '}
                  会被替换成已通过验证的玩家 ID，命令发往<strong>主服</strong> RCON。
                </p>
              </div>
            )}

            <div className="btn-row">
              <button className="btn" disabled={busy} onClick={testRconVerify}>
                测试连接（执行 list）
              </button>
              <button
                className="btn"
                onClick={() => void window.bridge.reconnectRconVerify()}
              >
                立即重连
              </button>
            </div>

            {verifyOutput && <div className="output">{verifyOutput}</div>}
            {status?.rconVerify?.lastError && (
              <div className="banner err">
                <strong>验证服连接失败：</strong>
                {status.rconVerify.lastError}
              </div>
            )}
          </>
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

      <div className="card">
        <h2 className="card-title">数据与备份</h2>
        <p className="card-desc">
          配置、绑定关系、审计记录与待发验证码都存在下面这个目录里。
          <strong>把它和 exe 放在一起，换任何版本、任何电脑都不需要重新配置。</strong>
        </p>

        {!dataInfo ? (
          <p className="hint">正在读取数据目录信息…</p>
        ) : (
          <>
            <div className="field">
              <label>当前数据目录</label>
              <div className="data-path-row">
                <input
                  type="text"
                  className="mono"
                  readOnly
                  value={dataInfo.dir}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  className="btn"
                  onClick={() => void window.bridge.openDataDir()}
                >
                  打开目录
                </button>
              </div>
              <p className="hint">
                {dataInfo.source === 'portable' ? (
                  <span className="tag ok">跟随程序</span>
                ) : (
                  <span className="tag">系统用户目录</span>
                )}{' '}
                {dataInfo.reason}
              </p>
            </div>

            {dataInfo.warning && <div className="banner warn">{dataInfo.warning}</div>}

            {dataInfo.files.length > 0 && (
              <p className="hint">
                目录内文件：
                {dataInfo.files
                  .map((f) => `${f.name}（${formatSize(f.size)}）`)
                  .join('、')}
              </p>
            )}

            <div className="btn-row">
              <button
                className="btn"
                disabled={dataBusy}
                onClick={() =>
                  void runDataAction(
                    '导出配置',
                    () => window.bridge.exportData(withSecrets),
                  )
                }
              >
                导出配置…
              </button>
              <label className="data-check">
                <input
                  type="checkbox"
                  checked={withSecrets}
                  onChange={(e) => setWithSecrets(e.target.checked)}
                />
                包含 RCON 密码等敏感信息
              </label>
            </div>
            <p className="hint">
              导出一个 JSON 文件，跨版本、跨电脑都能用。不勾选时会剔除密码，
              导入到新机器后需要重新填写一次。
            </p>

            <div className="btn-row">
              <button
                className="btn"
                disabled={dataBusy}
                onClick={() =>
                  void runDataAction('导入配置', () => window.bridge.importData(), {
                    reload: true,
                  })
                }
              >
                导入配置…
              </button>
              {dataInfo.canMoveToPortable && (
                <button
                  className="btn"
                  disabled={dataBusy}
                  onClick={() =>
                    void runDataAction('把配置存到程序目录', () =>
                      window.bridge.moveDataToPortable(),
                    )
                  }
                >
                  把配置存到程序目录（绿色版）
                </button>
              )}
            </div>

            {dataInfo.portableDir && (
              <p className="hint">
                程序目录：<span className="mono">{dataInfo.portableDir}</span>
                {dataInfo.canMoveToPortable
                  ? '　—— 点「把配置存到程序目录」并重启后，配置就会跟随程序，以后换版本不用重新配置。'
                  : ''}
              </p>
            )}

            {dataOutput && <div className="output">{dataOutput}</div>}
          </>
        )}
      </div>

      {/* ---------- 在线展示 ---------- */}
      <div className="card">
        <h2 className="card-title">在线展示（/在线 图片卡片）</h2>
        <p className="hint">
          启用后，群里的 <span className="mono">/在线</span> 会改发一张图片卡片：
          服务器名、在线人数、玩家头像（取绑定 QQ 的头像，未绑定的显示首字母）。
          数据来自主服 RCON 的 <span className="mono">list</span>，不需要服务端插件。
        </p>

        <label className="data-check" style={{ marginTop: 6 }}>
          <input
            type="checkbox"
            checked={config.presence.enabled}
            onChange={(e) => patchPresence({ enabled: e.target.checked })}
          />
          启用在线展示（关闭后 /在线 与旧版行为完全一致）
        </label>

        {config.presence.enabled && (
          <>
            <div className="field" style={{ maxWidth: 320 }}>
              <label>服务器名（显示在卡片标题）</label>
              <input
                value={config.presence.serverName}
                onChange={(e) => patchPresence({ serverName: e.target.value })}
                placeholder="生存服"
              />
            </div>

            <label className="data-check">
              <input
                type="checkbox"
                checked={config.presence.sendImage}
                onChange={(e) => patchPresence({ sendImage: e.target.checked })}
              />
              发送图片卡片（关闭则只发文字模板）
            </label>

            <label className="data-check">
              <input
                type="checkbox"
                checked={config.presence.showAvatars}
                onChange={(e) => patchPresence({ showAvatars: e.target.checked })}
              />
              卡片里显示玩家头像（绑定过的 QQ 头像，取不到时显示首字母）
            </label>

            <div className="field">
              <label>文字模板（发送图片被关闭或渲染失败时的回复）</label>
              <textarea
                rows={3}
                value={config.presence.textTemplate}
                onChange={(e) => patchPresence({ textTemplate: e.target.value })}
              />
            </div>
            <p className="hint">
              可用变量：
              <span className="mono">
                {' '}
                {'{server}'} {'{online}'} {'{max}'} {'{players}'}
              </span>
            </p>

            <div className="btn-row">
              <button className="btn" disabled={previewBusy} onClick={() => void runPreview()}>
                {previewBusy ? '渲染中…' : '预览卡片'}
              </button>
            </div>
            <p className="hint">
              预览优先使用真实数据（会当场查一次 RCON）；查不到时用演示数据渲染，
              方便先调样式。发送到群里的图片与此预览完全一致。
            </p>

            {preview && (
              <div style={{ marginTop: 12 }}>
                {preview.summary && <p className="hint">{preview.summary}</p>}
                {preview.ok && preview.dataUrl ? (
                  <img className="card-preview" src={preview.dataUrl} alt="在线人数卡片预览" />
                ) : (
                  <div className="output">✘ 预览失败：{preview.error ?? '未知错误'}</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
