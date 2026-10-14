import React, { useCallback, useEffect, useState } from 'react';
import type { AppConfig, RuntimeStatus, SnowLumaStatus } from '../shared/types';
import { ConnectionPage } from './pages/ConnectionPage';
import { WhitelistPage } from './pages/WhitelistPage';
import { CommandsPage } from './pages/CommandsPage';
import { BindingsPage } from './pages/BindingsPage';
import { ConsolePage } from './pages/ConsolePage';
import { AuditPage } from './pages/AuditPage';

export type PageKey =
  | 'connection'
  | 'whitelist'
  | 'commands'
  | 'bindings'
  | 'console'
  | 'audit';

const NAV: Array<{ key: PageKey; label: string }> = [
  { key: 'connection', label: '连接设置' },
  { key: 'whitelist', label: '群 / 私聊白名单' },
  { key: 'commands', label: '指令管理' },
  { key: 'bindings', label: '账号绑定' },
  { key: 'console', label: '指令控制台' },
  { key: 'audit', label: '审计日志' },
];

export interface PageProps {
  config: AppConfig;
  status: RuntimeStatus | null;
  /** 修改配置的局部字段（不自动保存） */
  patch: (partial: Partial<AppConfig>) => void;
}

/** SnowLuma 状态文案 */
function snowLumaText(s: SnowLumaStatus | null): string {
  if (!s) return '—';
  switch (s.state) {
    case 'running':
      return '运行中';
    case 'starting':
      return s.listening ? '运行中' : '启动中…';
    case 'exited':
      return '已退出';
    case 'error':
      return '异常';
    default:
      return '未启动';
  }
}

function snowLumaDotClass(s: SnowLumaStatus | null): string {
  if (!s) return '';
  if (s.state === 'running' || (s.state === 'starting' && s.listening)) return 'connected';
  if (s.state === 'starting') return 'connecting';
  if (s.state === 'error' || s.state === 'exited') return 'error';
  return '';
}

export function App() {
  const [page, setPage] = useState<PageKey>('connection');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [snowluma, setSnowluma] = useState<SnowLumaStatus | null>(null);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    void window.bridge.getConfig().then(setConfig);
    void window.bridge.getStatus().then(setStatus);
    void window.bridge.getSnowLumaStatus().then(setSnowluma);
    const offStatus = window.bridge.onStatusChange(setStatus);
    const offSnow = window.bridge.onSnowLumaStatus(setSnowluma);
    return () => {
      offStatus();
      offSnow();
    };
  }, []);

  const showToast = useCallback((type: 'ok' | 'err', text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 2600);
  }, []);

  const patch = useCallback((partial: Partial<AppConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...partial } : prev));
    setDirty(true);
  }, []);

  /** 保存当前配置 */
  const save = useCallback(async () => {
    if (!config) return;
    const res = await window.bridge.saveConfig(config);
    if (res.ok) {
      setDirty(false);
      showToast('ok', '配置已保存并生效');
    } else {
      showToast('err', `保存失败：${res.error}`);
    }
  }, [config, showToast]);

  /** 恢复默认配置 */
  const reset = useCallback(async () => {
    const fresh = await window.bridge.resetConfig();
    setConfig(fresh);
    setDirty(false);
    showToast('ok', '已恢复默认配置');
  }, [showToast]);

  if (!config) {
    return <div className="empty">正在加载配置…</div>;
  }

  const pageProps: PageProps = { config, status, patch };

  return (
    <>
      <div className="topbar">
        <span className="brand">
          <span className="brand-mark">G</span>
          GeLi Bot
        </span>

        <div className="status-group">
          <div className="status-pill">
            <span className={`dot ${snowLumaDotClass(snowluma)}`} />
            <span className="status-label">SnowLuma</span>
            <span className="status-value">{snowLumaText(snowluma)}</span>
          </div>
          <div className="status-pill">
            <span className={`dot ${status?.rcon.state ?? ''}`} />
            <span className="status-label">RCON</span>
            <span
              className="status-value"
              title={status?.rcon.lastError || status?.rcon.message || ''}
            >
              {status?.rcon.message ?? '—'}
            </span>
          </div>
          <div className="status-pill">
            <span className={`dot ${status?.onebot.state ?? ''}`} />
            <span className="status-label">QQ</span>
            <span
              className="status-value"
              title={status?.onebot.lastError || status?.onebot.message || ''}
            >
              {status?.onebot.state === 'connected' && status.onebot.selfName
                ? `${status.onebot.selfName}（${status.onebot.selfId}）`
                : status?.onebot.message ?? '—'}
            </span>
          </div>
          <button
            className={`btn primary${dirty ? '' : ' saved'}`}
            onClick={save}
            disabled={!dirty}
          >
            {dirty ? '保存配置' : '已保存'}
          </button>
        </div>
      </div>

      <div className="body">
        <nav className="sidebar">
          {NAV.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${page === item.key ? 'active' : ''}`}
              onClick={() => setPage(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <main className="content">
          {toast && (
            <div className={`banner ${toast.type === 'ok' ? 'ok' : 'err'}`}>
              {toast.text}
            </div>
          )}

          {page === 'connection' && (
            <ConnectionPage {...pageProps} snowluma={snowluma} onReset={reset} />
          )}
          {page === 'whitelist' && <WhitelistPage {...pageProps} />}
          {page === 'commands' && <CommandsPage {...pageProps} />}
          {page === 'bindings' && <BindingsPage {...pageProps} />}
          {page === 'console' && <ConsolePage />}
          {page === 'audit' && <AuditPage />}
        </main>
      </div>
    </>
  );
}
