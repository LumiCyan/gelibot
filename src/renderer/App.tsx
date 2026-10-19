import React, { useCallback, useEffect, useState } from 'react';
import type { AppConfig, RuntimeStatus, SnowLumaStatus } from '../shared/types';
import { ConnectionPage } from './pages/ConnectionPage';
import { WhitelistPage } from './pages/WhitelistPage';
import { CommandsPage } from './pages/CommandsPage';
import { BindingsPage } from './pages/BindingsPage';
import { ConsolePage } from './pages/ConsolePage';
import { AuditPage } from './pages/AuditPage';
import { UpdatePage } from './pages/UpdatePage';
import { ChatBridgePage } from './pages/ChatBridgePage';
import { ResponderPage } from './pages/ResponderPage';
import { StatsPage } from './pages/StatsPage';
import { TaskPage } from './pages/TaskPage';
import { AIPage } from './pages/AIPage';
import { ImageReplyPage } from './pages/ImageReplyPage';
import { OwnerCarePage } from './pages/OwnerCarePage';

export type PageKey =
  | 'connection'
  | 'bindings'
  | 'chatbridge'
  | 'responder'
  | 'ai'
  | 'imagereply'
  | 'commands'
  | 'whitelist'
  | 'console'
  | 'stats'
  | 'tasks'
  | 'ownercare'
  | 'audit'
  | 'update';

/**
 * 导航按「使用路径」排列：接入 → 身份 → 消息 → 图片 → 指令 → 数据 → AI → 自动化 → 安全 → 系统
 *
 * 图片渲染与 AI 各自独立成组，不再挂在「消息」下面：
 * 它们已经不只是「回复方式」，而是整套能力（主题/字体/水印；人设/配额/画像）。
 */
const NAV: Array<{ key: PageKey; label: string; group?: string }> = [
  { key: 'connection', label: '连接设置', group: '接入' },
  { key: 'bindings', label: '账号绑定', group: '身份与权限' },
  { key: 'chatbridge', label: '消息互通', group: '消息' },
  { key: 'responder', label: '自动回复', group: '消息' },
  { key: 'imagereply', label: '图片渲染', group: '图片与视觉' },
  { key: 'commands', label: '指令管理', group: '指令' },
  { key: 'whitelist', label: '群 / 私聊白名单', group: '指令' },
  { key: 'console', label: '指令控制台', group: '指令' },
  { key: 'stats', label: '玩家统计', group: '数据' },
  { key: 'ai', label: 'AI 助手', group: 'AI' },
  { key: 'tasks', label: '定时任务', group: '自动化' },
  { key: 'ownercare', label: '慰问服主', group: '自动化' },
  { key: 'audit', label: '审计日志', group: '安全' },
  { key: 'update', label: '软件更新', group: '系统' },
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

  /** 外部改动了配置（例如导入）后重新拉取，避免界面还显示旧值 */
  const reload = useCallback(async () => {
    const fresh = await window.bridge.getConfig();
    setConfig(fresh);
    setDirty(false);
  }, []);

  if (!config) {
    return <div className="empty">正在加载配置…</div>;
  }

  const pageProps: PageProps = { config, status, patch };

  return (
    <>
      <div className="topbar">
        <span className="brand">
          <span className="brand-mark" />
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
          {config?.verifyServer.enabled && (
            <div className="status-pill">
              <span className={`dot ${status?.rconVerify?.state ?? ''}`} />
              <span className="status-label">验证服</span>
              <span
                className="status-value"
                title={
                  status?.rconVerify?.lastError || status?.rconVerify?.message || ''
                }
              >
                {status?.rconVerify?.message ?? '—'}
              </span>
            </div>
          )}
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
          {NAV.map((item, i) => {
            // 分组标题：与上一条的 group 不同时插一行小标题
            const prev = i > 0 ? NAV[i - 1].group : undefined;
            const showGroup = item.group && item.group !== prev;
            return (
              <React.Fragment key={item.key}>
                {showGroup && <div className="nav-group">{item.group}</div>}
                <button
                  className={`nav-item ${page === item.key ? 'active' : ''}`}
                  onClick={() => setPage(item.key)}
                >
                  {item.label}
                </button>
              </React.Fragment>
            );
          })}
        </nav>

        <main className="content">
          {toast && (
            <div className={`banner ${toast.type === 'ok' ? 'ok' : 'err'}`}>
              {toast.text}
            </div>
          )}

          {page === 'connection' && (
            <ConnectionPage
              {...pageProps}
              snowluma={snowluma}
              onReset={reset}
              onReload={reload}
            />
          )}
          {page === 'whitelist' && <WhitelistPage {...pageProps} />}
          {page === 'commands' && <CommandsPage {...pageProps} />}
          {page === 'bindings' && <BindingsPage {...pageProps} />}
          {page === 'chatbridge' && <ChatBridgePage {...pageProps} />}
          {page === 'responder' && <ResponderPage {...pageProps} />}
          {page === 'ai' && <AIPage {...pageProps} />}
          {page === 'imagereply' && <ImageReplyPage {...pageProps} />}
          {page === 'stats' && <StatsPage {...pageProps} />}
          {page === 'tasks' && <TaskPage {...pageProps} />}
          {page === 'ownercare' && <OwnerCarePage {...pageProps} />}
          {page === 'console' && <ConsolePage />}
          {page === 'audit' && <AuditPage />}
          {page === 'update' && <UpdatePage />}
        </main>
      </div>
    </>
  );
}
