import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** 页面在导航里的先后顺序，用来判断切换方向 */
const NAV_INDEX = new Map<PageKey, number>(NAV.map((n, i) => [n.key, i]));

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
  /**
   * 切页方向：1 = 沿导航往下走，-1 = 往上走。
   * 内容进场时据此决定从下浮起还是从上落下，让「翻页」有前后之分。
   */
  const [dir, setDir] = useState<1 | -1>(1);
  /** 配置是否已就绪。未就绪时整页只渲染「正在加载配置…」，侧边栏还没进 DOM */
  const hasConfig = config !== null;

  const contentRef = useRef<HTMLElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const navBarRef = useRef<HTMLSpanElement | null>(null);
  /** 滑块首帧不做过渡，否则会从顶部滑下来 */
  const navBarSettled = useRef(false);

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

  /** 切页：先记下方向，再换页。方向交给 CSS 决定内容从哪一侧浮起 */
  const goto = useCallback(
    (next: PageKey) => {
      if (next === page) return;
      setDir((NAV_INDEX.get(next) ?? 0) > (NAV_INDEX.get(page) ?? 0) ? 1 : -1);
      setPage(next);
    },
    [page],
  );

  // 切页后回到顶部，否则新区块会停在上一页的滚动位置
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [page]);

  // 侧边栏高亮滑块：量出当前项的位置，让它平移到新项身上
  useLayoutEffect(() => {
    const nav = navRef.current;
    const bar = navBarRef.current;
    if (!nav || !bar) return;
    const active = nav.querySelector<HTMLElement>('.nav-item.active');
    if (!active) return;

    // 首帧直接落位，不播「从顶部滑下来」那一段
    if (!navBarSettled.current) bar.style.transition = 'none';

    const navRect = nav.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    bar.style.height = `${Math.round(rect.height)}px`;
    // 加 scrollTop 换成内容坐标，滑块随侧边栏一起滚动
    bar.style.transform = `translateY(${Math.round(rect.top - navRect.top + nav.scrollTop)}px)`;
    bar.style.opacity = '1';

    if (!navBarSettled.current) {
      navBarSettled.current = true;
      requestAnimationFrame(() => {
        bar.style.transition = '';
      });
    }
    // 依赖里必须带上「配置到没到」：
    // 配置未就绪时整页只渲染一行「正在加载配置…」，侧边栏还不存在，
    // 那次测量拿不到节点；等配置到了要再量一次，否则滑块一直不出现。
  }, [page, hasConfig]);

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
        <nav className="sidebar" ref={navRef}>
          {/* 跟随当前项滑动的高亮块（位置由 JS 量出来写进 transform） */}
          <span className="nav-indicator" ref={navBarRef} aria-hidden="true" />
          {NAV.map((item, i) => {
            // 分组标题：与上一条的 group 不同时插一行小标题
            const prev = i > 0 ? NAV[i - 1].group : undefined;
            const showGroup = item.group && item.group !== prev;
            return (
              <React.Fragment key={item.key}>
                {showGroup && <div className="nav-group">{item.group}</div>}
                <button
                  className={`nav-item ${page === item.key ? 'active' : ''}`}
                  onClick={() => goto(item.key)}
                >
                  {item.label}
                </button>
              </React.Fragment>
            );
          })}
        </nav>

        <main className="content" ref={contentRef}>
          {toast && (
            <div className={`banner toast ${toast.type === 'ok' ? 'ok' : 'err'}`}>
              {toast.text}
            </div>
          )}

          {/*
            key={page} 让每次切页都重建这一层，进场动画才会重播。
            enter-up / enter-down 只改变位移方向，其余交给 CSS。
          */}
          <div
            className={`page-stage ${dir > 0 ? 'enter-up' : 'enter-down'}`}
            key={page}
          >
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
          </div>
        </main>
      </div>
    </>
  );
}
