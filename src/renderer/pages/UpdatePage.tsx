import React, { useCallback, useEffect, useState } from 'react';
import type { UpdateStatus } from '../../shared/types';

/** 把字节数显示成人看得懂的形式 */
function formatSize(bytes: number | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 状态 → 文案与配色 */
function stateMeta(s: UpdateStatus | null) {
  if (!s) return { text: '—', cls: '' };
  switch (s.state) {
    case 'checking':
      return { text: '检查中…', cls: 'connecting' };
    case 'available':
      return { text: '有可用更新', cls: 'connecting' };
    case 'downloading':
      return { text: '下载中…', cls: 'connecting' };
    case 'ready':
      return { text: '已就绪', cls: 'connected' };
    case 'applying':
      return { text: '应用更新中…', cls: 'connecting' };
    case 'done':
      return { text: '更新完成', cls: 'connected' };
    case 'error':
      return { text: '出错', cls: 'error' };
    default:
      return { text: s.message || '空闲', cls: '' };
  }
}

export function UpdatePage() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');

  useEffect(() => {
    void window.bridge.getUpdateStatus().then(setStatus);
    const off = window.bridge.onUpdateStatus(setStatus);
    return off;
  }, []);

  const meta = stateMeta(status);

  const check = useCallback(async () => {
    setBusy(true);
    setOutput('正在检查更新…');
    try {
      const res = await window.bridge.checkUpdate();
      if (res.error) {
        setOutput(`✘ 检查失败：${res.error}`);
      } else if (res.hasUpdate && res.info) {
        setOutput(
          `✔ 发现新版本 v${res.info.latest}（当前 v${res.info.current}）\n` +
            `· ${res.info.patchAvailable ? '有差量更新' : '需下载完整包'}${res.info.patchSize != null ? `，差量 ${formatSize(res.info.patchSize)}` : ''}` +
            (res.info.fullSize != null ? `，完整 ${formatSize(res.info.fullSize)}` : '') +
            (res.info.notes ? `\n· 更新说明：${res.info.notes}` : ''),
        );
      } else {
        setOutput(`✔ 已是最新版本（v${res.info?.latest ?? status?.info?.latest ?? '?'}）`);
      }
    } catch (err) {
      setOutput(`✘ 检查失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [status]);

  const download = useCallback(async () => {
    setBusy(true);
    setOutput('正在下载更新…');
    try {
      const res = await window.bridge.downloadUpdate();
      if (res.ok) {
        setOutput(
          res.fullDownload
            ? '✔ 完整包已就绪，可点击「重启更新」应用'
            : '✔ 差量包已就绪，可点击「重启更新」应用',
        );
      } else {
        setOutput(`✘ 下载失败：${res.error ?? '未知错误'}`);
      }
    } catch (err) {
      setOutput(`✘ 下载失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const apply = useCallback(async () => {
    setBusy(true);
    setOutput('正在应用更新并重启…');
    try {
      const res = await window.bridge.applyUpdate();
      if (!res.ok) {
        setOutput(`✘ 应用失败：${res.error ?? '未知错误'}`);
        setBusy(false);
      }
      // 成功时主进程会重启，这里不结束 busy，避免界面闪烁
    } catch (err) {
      setOutput(`✘ 应用失败：${(err as Error).message}`);
      setBusy(false);
    }
  }, []);

  return (
    <>
      <h1 className="page-title">软件更新</h1>
      <p className="page-desc">
        GeLi Bot 支持差量更新：优先下载从当前版本到最新版的小型补丁，
        失败时自动回退到完整包。更新源默认指向 GitHub Releases，可在
        「连接设置」里改为自建静态源。
      </p>

      <div className="card">
        <h2 className="card-title">更新状态</h2>
        <div className="sl-status">
          <div className="sl-status-item">
            <span className="sl-label">当前状态</span>
            <span className="sl-value">
              <span className={`dot ${meta.cls}`} />
              {meta.text}
            </span>
          </div>
          {status?.info && (
            <>
              <div className="sl-status-item">
                <span className="sl-label">当前版本</span>
                <span className="sl-value mono">v{status.info.current}</span>
              </div>
              <div className="sl-status-item">
                <span className="sl-label">最新版本</span>
                <span className="sl-value mono">v{status.info.latest}</span>
              </div>
            </>
          )}
          {status?.progress != null && status.state === 'downloading' && (
            <div className="sl-status-item">
              <span className="sl-label">进度</span>
              <span className="sl-value">
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${status.progress}%` }}
                  />
                </div>
                <span className="mono">{status.progress}%</span>
              </span>
            </div>
          )}
          {status?.message && status.state !== 'idle' && (
            <div className="sl-status-item">
              <span className="sl-label">说明</span>
              <span className="sl-value">{status.message}</span>
            </div>
          )}
        </div>

        <div className="btn-row">
          <button className="btn" disabled={busy} onClick={() => void check()}>
            检查更新
          </button>
          <button
            className="btn primary"
            disabled={busy || !status || status.state !== 'available'}
            onClick={() => void download()}
          >
            下载更新
          </button>
          <button
            className="btn danger"
            disabled={busy || !status || status.state !== 'ready'}
            onClick={() => void apply()}
          >
            重启更新
          </button>
        </div>

        {status?.state === 'error' && (
          <div className="banner err" style={{ marginTop: 12 }}>
            <strong>更新出错：</strong>
            {status.message || status.error || '未知错误'}
          </div>
        )}

        {output && <div className="output">{output}</div>}
      </div>
    </>
  );
}
