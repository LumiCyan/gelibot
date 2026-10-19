import React, { useState } from 'react';
import type { PageProps } from '../App';
import type { ImageReplyConfig } from '../../shared/types';

/** 几段有代表性的回复，一键填入看效果 */
const SAMPLES: Array<{ label: string; text: string }> = [
  {
    label: 'RCON 查询结果',
    text:
      '/在线 执行结果：\nThere are 3 of a max of 20 players online: Steve, Alex, Notch',
  },
  {
    label: '帮助菜单',
    text:
      '可用指令：\n/在线  -  查询服务器当前在线玩家\n/tps  -  查询服务器 TPS\n/绑定  -  绑定你的游戏账号\n/解绑  -  解除绑定\n/我的绑定  -  查看已绑定账号\n\n—— 账号绑定 ——\n/绑定 <验证码>  -  双向验证：先在服务器内取码，再在群内绑定',
  },
  {
    label: '绑定列表',
    text:
      '你已绑定 2 个账号：\n- Steve（绑定于 2026-10-01）\n- Alex（绑定于 2026-10-12）\n\n玩家ID：Steve\n绑定QQ：10001\n来源群：123456',
  },
  {
    label: '失败提示',
    text:
      '执行 /加白 失败：\n玩家 Steve 已在白名单中\n请确认玩家 ID 拼写无误，或先执行 /移除白名单 Steve',
  },
];

/**
 * 图片回复设置页。
 *
 * 这一页的作用是让用户决定：哪些回复值得「出一张图」。
 * 短回复出图反而更难读（群里看一行字比点开一张图快），
 * 所以默认阈值是「3 行或 60 字」。
 */
export function ImageReplyPage({ config, patch }: PageProps) {
  const cfg = config.imageReply;
  const [sample, setSample] = useState(SAMPLES[1].text);
  const [preview, setPreview] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const patchCfg = (partial: Partial<ImageReplyConfig>) => {
    patch({ imageReply: { ...cfg, ...partial } });
  };

  const doPreview = async () => {
    setLoading(true);
    setError('');
    setPreview('');
    const res = await window.bridge.previewImageReply(sample);
    setLoading(false);
    if (res.ok && res.dataUrl) setPreview(res.dataUrl);
    else setError(res.error ?? '渲染失败');
  };

  return (
    <>
      <div className="card">
        <h2 className="card-title">图片回复</h2>
        <p className="hint">
          把指令结果、帮助菜单、绑定列表、AI 回答等回复渲染成一张卡片图再发到群里。
          图片渲染失败会自动回退成纯文本，不会让用户收不到结果。
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => patchCfg({ enabled: e.target.checked })}
          />
          <span>启用图片回复</span>
        </label>

        <div className="field" style={{ maxWidth: 340 }}>
          <label>作用范围</label>
          <select
            value={cfg.scope}
            onChange={(e) => patchCfg({ scope: e.target.value as ImageReplyConfig['scope'] })}
          >
            <option value="command">只转换指令/查询的回复（推荐）</option>
            <option value="all">所有功能回复都转（含事件通知）</option>
          </select>
        </div>
        <p className="hint">
          游戏内聊天同步永远保持文字 —— 群里每条聊天一张图会把对话刷没。
        </p>

        <div className="row-flex">
          <div className="field" style={{ maxWidth: 200 }}>
            <label>至少多少行才出图</label>
            <input
              type="number"
              min={1}
              value={cfg.minLines}
              onChange={(e) => patchCfg({ minLines: Number(e.target.value) || 1 })}
            />
          </div>
          <div className="field" style={{ maxWidth: 200 }}>
            <label>或至少多少字符才出图</label>
            <input
              type="number"
              min={0}
              value={cfg.minChars}
              onChange={(e) => patchCfg({ minChars: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="field" style={{ maxWidth: 200 }}>
            <label>卡片文件保留数量</label>
            <input
              type="number"
              min={10}
              value={cfg.keepFiles}
              onChange={(e) => patchCfg({ keepFiles: Number(e.target.value) || 60 })}
            />
          </div>
        </div>
        <p className="hint">
          两个阈值是「或」的关系：行数够 <b>或</b> 字数够就出图。
          短回复（比如「操作太频繁」）保持文字，读起来更快。
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={cfg.showTime}
            onChange={(e) => patchCfg({ showTime: e.target.checked })}
          />
          <span>卡片底部显示生成时间</span>
        </label>
      </div>

      <div className="card">
        <h2 className="card-title">视觉风格</h2>
        <p className="hint">
          这些设置只影响卡片外观，预览会实时跟着变。
        </p>

        <div className="row-flex">
          <div className="field" style={{ maxWidth: 200 }}>
            <label>主题</label>
            <select
              value={cfg.theme}
              onChange={(e) => patchCfg({ theme: e.target.value as ImageReplyConfig['theme'] })}
            >
              <option value="dark">深色（默认）</option>
              <option value="light">浅色</option>
            </select>
          </div>
          <div className="field" style={{ maxWidth: 200 }}>
            <label>卡片宽度</label>
            <select
              value={cfg.width}
              onChange={(e) => patchCfg({ width: Number(e.target.value) })}
            >
              <option value={480}>480（紧凑）</option>
              <option value={600}>600（默认）</option>
              <option value={720}>720（宽屏）</option>
            </select>
          </div>
          <div className="field" style={{ maxWidth: 200 }}>
            <label>字号</label>
            <select
              value={cfg.scale}
              onChange={(e) => patchCfg({ scale: Number(e.target.value) })}
            >
              <option value={0.9}>紧凑（0.9）</option>
              <option value={1}>标准（1.0）</option>
              <option value={1.1}>宽松（1.1）</option>
            </select>
          </div>
        </div>

        <div className="field" style={{ maxWidth: 320 }}>
          <label>水印（显示在底部右侧，留空则不显示）</label>
          <input
            value={cfg.watermark}
            placeholder="例如：我的世界 · 生存服"
            onChange={(e) => patchCfg({ watermark: e.target.value })}
          />
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">预览</h2>
        <p className="hint">
          预览不受阈值限制，会强制出图，方便看排版。这里的内容不会发送到群里。
        </p>

        <div className="row-flex" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {SAMPLES.map((s) => (
            <button key={s.label} className="btn" onClick={() => setSample(s.text)}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="field">
          <label>模拟一段回复</label>
          <textarea rows={8} value={sample} onChange={(e) => setSample(e.target.value)} />
        </div>

        <div className="btn-row">
          <button className="btn primary" onClick={() => void doPreview()} disabled={loading}>
            {loading ? '渲染中…' : '生成预览'}
          </button>
        </div>

        {error && <div className="banner err" style={{ marginTop: 10 }}>{error}</div>}

        {preview && (
          <div style={{ marginTop: 14 }}>
            <img
              src={preview}
              alt="预览"
              style={{ maxWidth: '100%', borderRadius: 12, border: '1px solid var(--border)' }}
            />
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">解析规则</h2>
        <p className="hint">文本会被自动识别排版，不需要改任何功能代码：</p>
        <table>
          <thead>
            <tr>
              <th>文本形态</th>
              <th>渲染成</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>/在线 执行结果：</code>
              </td>
              <td>卡片副标题</td>
            </tr>
            <tr>
              <td>
                <code>/在家  -  说明文字</code>
              </td>
              <td>列表项</td>
            </tr>
            <tr>
              <td>
                <code>- 某一条</code> 或 <code>• 某一条</code>
              </td>
              <td>列表项</td>
            </tr>
            <tr>
              <td>
                <code>玩家ID：Steve</code>
              </td>
              <td>键值行（左标签右值）</td>
            </tr>
            <tr>
              <td>空行</td>
              <td>分隔线</td>
            </tr>
            <tr>
              <td>其他</td>
              <td>普通段落</td>
            </tr>
          </tbody>
        </table>
        <p className="hint">
          MC 颜色码（<code>§c</code> 这类）会在出图前被剥掉，卡片里按统一配色显示。
        </p>
      </div>
    </>
  );
}
