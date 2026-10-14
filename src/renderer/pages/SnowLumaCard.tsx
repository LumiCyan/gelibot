import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig, SnowLumaStatus } from '../../shared/types';

interface Props {
  config: AppConfig;
  snowluma: SnowLumaStatus | null;
  patch: (partial: Partial<AppConfig>) => void;
}

const STATE_LABEL: Record<SnowLumaStatus['state'], string> = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  exited: '已退出',
  error: '异常',
};

function stateTagClass(s: SnowLumaStatus | null): string {
  if (!s) return '';
  if (s.state === 'running' || (s.state === 'starting' && s.listening)) return 'ok';
  if (s.state === 'error' || s.state === 'exited') return 'fail';
  return '';
}

/** SnowLuma 启动器：一键起停 + 打开后台 + 首启凭据与启动日志 */
export function SnowLumaCard({ config, snowluma, patch }: Props) {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [bundledDir, setBundledDir] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [showLog, setShowLog] = useState(true);
  const logRef = useRef<HTMLDivElement | null>(null);

  const active = snowluma?.state === 'running' || snowluma?.state === 'starting';

  const loadLog = useCallback(async () => {
    setLog(await window.bridge.getSnowLumaLog());
  }, []);

  useEffect(() => {
    void window.bridge.getBundledSnowLumaDir().then(setBundledDir);
    void loadLog();
  }, [loadLog]);

  // 运行中/启动中时密集刷新日志，停止后就不用再轮询了
  useEffect(() => {
    if (!active) {
      void loadLog();
      return;
    }
    const t = setInterval(() => void loadLog(), 1000);
    return () => clearInterval(t);
  }, [active, loadLog]);

  // 新日志进来时自动滚到底
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setBusy(true);
    setNotice('');
    try {
      const res = await fn();
      setNotice(res.ok ? okText : `失败：${res.error ?? '未知错误'}`);
    } finally {
      setBusy(false);
      void loadLog();
    }
  };

  const pickDir = async () => {
    const dir = await window.bridge.pickSnowLumaDir();
    if (dir) {
      patch({ snowluma: { ...config.snowluma, dir } });
      setNotice(`已选择目录：${dir}（记得点右上角「保存配置」）`);
    }
  };

  const copyCred = async () => {
    if (!snowluma?.password) return;
    const text = `${snowluma.adminUser ?? 'admin'} / ${snowluma.password}`;
    try {
      await navigator.clipboard.writeText(text);
      setNotice('账号密码已复制到剪贴板');
    } catch {
      setNotice('复制失败，请手动选中复制');
    }
  };

  return (
    <div className="card">
      <h2 className="card-title">
        SnowLuma 启动器
        <span className={`tag ${stateTagClass(snowluma)}`} style={{ marginLeft: 8 }}>
          {snowluma ? STATE_LABEL[snowluma.state] : '未知'}
        </span>
      </h2>
      <p className="card-desc">
        直接在这里启动 SnowLuma，不用再去手工解压运行 <span className="mono">launcher.bat</span>。
        启动成功后会自动用浏览器打开它的管理后台，首次登录的账号密码就在下面。
      </p>

      <div className="sl-status">
        <div className="sl-status-item">
          <span className="sl-label">程序目录</span>
          <span className="sl-value mono">
            {snowluma?.resolvedDir ?? '—'}
            {snowluma?.dirSource === 'bundled' && <span className="tag ok">内置</span>}
            {snowluma?.dirSource === 'custom' && <span className="tag">自定义</span>}
          </span>
        </div>
        <div className="sl-status-item">
          <span className="sl-label">数据目录</span>
          <span className="sl-value mono">{snowluma?.dataDir ?? '—'}</span>
        </div>
        <div className="sl-status-item">
          <span className="sl-label">进程</span>
          <span className="sl-value mono">
            {active && snowluma?.pid ? `PID ${snowluma.pid}` : '—'}
          </span>
        </div>
      </div>

      {snowluma?.password && (
        <div className="cred-box">
          <div className="cred-row">
            <span className="sl-label">后台登录</span>
            <span className="mono cred-text">
              {snowluma.adminUser ?? 'admin'} / {snowluma.password}
            </span>
          </div>
          <button className="btn" onClick={() => void copyCred()}>
            复制
          </button>
        </div>
      )}

      <div className="btn-row">
        <button
          className="btn primary"
          disabled={busy || active}
          onClick={() => void run(() => window.bridge.startSnowLuma(), '已发起启动，请看下方日志')}
        >
          启动 SnowLuma
        </button>
        <button
          className="btn"
          disabled={busy || !active}
          onClick={() => void run(() => window.bridge.stopSnowLuma(), '已停止')}
        >
          停止
        </button>
        <button
          className="btn"
          onClick={() => void run(() => window.bridge.openSnowLumaWeb(), '已在浏览器打开后台')}
        >
          打开后台
        </button>
      </div>

      {notice && <p className="hint">{notice}</p>}
      {snowluma?.lastError && <p className="hint">当前错误：{snowluma.lastError}</p>}

      <div className="section-label">启动选项</div>

      <div className="field">
        <label>SnowLuma 程序目录（留空 = 使用内置版本）</label>
        <div className="row-flex">
          <input
            type="text"
            value={config.snowluma.dir}
            onChange={(e) => patch({ snowluma: { ...config.snowluma, dir: e.target.value } })}
            placeholder={bundledDir ? `内置：${bundledDir}` : '请指定 SnowLuma 目录'}
          />
          <button className="btn" onClick={() => void pickDir()}>
            浏览…
          </button>
          {config.snowluma.dir && (
            <button
              className="btn"
              onClick={() => patch({ snowluma: { ...config.snowluma, dir: '' } })}
            >
              用内置
            </button>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label>后台地址</label>
          <input
            type="text"
            value={config.snowluma.webUrl}
            onChange={(e) =>
              patch({ snowluma: { ...config.snowluma, webUrl: e.target.value } })
            }
            placeholder="http://127.0.0.1:5099"
          />
        </div>
        <div className="field">
          <label>程序来源</label>
          <input
            type="text"
            value={bundledDir ? '内置完整版（含 node.exe）' : '未内置，需手动指定目录'}
            readOnly
          />
        </div>
      </div>

      <div className="check-row">
        <input
          id="sl-auto-open"
          type="checkbox"
          checked={config.snowluma.autoOpen}
          onChange={(e) =>
            patch({ snowluma: { ...config.snowluma, autoOpen: e.target.checked } })
          }
        />
        <label htmlFor="sl-auto-open">启动成功后自动打开浏览器后台</label>
      </div>

      <div className="check-row">
        <input
          id="sl-stop-with-app"
          type="checkbox"
          checked={config.snowluma.stopWithApp}
          onChange={(e) =>
            patch({ snowluma: { ...config.snowluma, stopWithApp: e.target.checked } })
          }
        />
        <label htmlFor="sl-stop-with-app">
          关闭本程序时一并停止 SnowLuma（取消勾选则让它继续在后台运行）
        </label>
      </div>

      <div className="section-label" style={{ display: 'flex', alignItems: 'center' }}>
        <span>启动日志</span>
        <button
          className="btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowLog((v) => !v)}
        >
          {showLog ? '收起' : '展开'}
        </button>
      </div>

      {showLog && (
        <div className="output" ref={logRef}>
          {log.length > 0 ? log.join('\n') : '（暂无日志，点「启动 SnowLuma」后这里会显示输出）'}
        </div>
      )}

      <p className="hint">
        首次进入后台需要先同意 EULA / 隐私条款才能解锁面板。改过密码后，
        日志里这份临时密码就失效了，改密后请自行保管。
      </p>
    </div>
  );
}
