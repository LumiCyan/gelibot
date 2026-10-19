/**
 * 在线人数图片卡片：渲染器（数据 → PNG）。
 *
 * 渲染走 Electron 自带的 Chromium —— 隐藏窗口加载一段 HTML 再 capturePage，
 * 零第三方依赖、中文字体直接吃系统字体、不被 asar 打包影响。
 *
 * 已验证过的坑（来自 .stage/card-v2 可行性验证）：
 *  - 隐藏 + 透明窗口可以直接截出透明圆角，无需显示窗口
 *  - 输出按系统缩放系数放大（125% → 600 CSS px 出 750 物理 px），天然高清
 *  - 内容是活的（人数会变），必须「先量高、再定窗口尺寸、再截图」
 *
 * 落盘与 CQ 码组装见 card-file.ts（纯 Node，可单元测试）。
 */
import { BrowserWindow } from 'electron';
import { buildCardHtml, type CardData } from './card-template';

export interface CardRendererOptions {
  /** 正式图标的 data URI（由调用方读取资源文件后传入，便于测试与换图） */
  iconUri: string;
  /** 卡片宽度（CSS px），默认 600 */
  width?: number;
  /** 单次渲染的整体超时，默认 15 秒；超时抛错由调用方降级 */
  timeoutMs?: number;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class CardRenderer {
  private iconUri: string;
  private width: number;
  private timeoutMs: number;
  private win: BrowserWindow | null = null;
  /**
   * 渲染串行队列。
   *
   * 整个进程共用同一个隐藏窗口，而「在线卡片」和「通用回复卡片」可能同时
   * 触发（有人在群里连发 /在线 和 /tps）。并发会互相 loadURL 打断，
   * 截出对方的内容。串行化是最简单可靠的解法，代价只是几毫秒排队。
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: CardRendererOptions) {
    this.iconUri = opts.iconUri;
    this.width = opts.width ?? 600;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  /** 渲染一张在线人数卡片，返回 PNG 数据与输出尺寸 */
  async render(data: CardData): Promise<{ png: Buffer; width: number; height: number }> {
    return this.renderHtml(
      buildCardHtml(data, { iconUri: this.iconUri, width: this.width }),
    );
  }

  /**
   * 渲染任意 HTML（通用入口）。
   *
   * 抽出来的原因：在线卡片只是「一种」内容，现在群里的指令结果、帮助菜单、
   * 统计榜、AI 回答都要出图，没必要为每种内容复制一遍窗口/截图/量高逻辑。
   * 只要 HTML 里有一个 `.card` 元素即可，高度按它自适应。
   */
  async renderHtml(html: string): Promise<{ png: Buffer; width: number; height: number }> {
    // 排到队尾；前一次失败也不能阻断后续渲染
    const job = () => this.renderWithTimeout(html);
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** 真正的渲染 + 超时保护 */
  private renderWithTimeout(
    html: string,
  ): Promise<{ png: Buffer; width: number; height: number }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // 超时后销毁窗口，避免污染下一次渲染
        this.destroy();
        reject(new Error(`卡片渲染超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
    });
    try {
      return Promise.race([this.doRenderHtml(html), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 销毁隐藏窗口（退出或超时后调用） */
  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.destroy();
      } catch {
        /* ignore */
      }
    }
    this.win = null;
  }

  // ---------------------------------------------------------------- 内部

  private doRenderHtml(
    html: string,
  ): Promise<{ png: Buffer; width: number; height: number }> {
    const run = async (): Promise<{ png: Buffer; width: number; height: number }> => {
      const win = this.ensureWindow();
      const url =
        'data:text/html;charset=utf-8;base64,' +
        Buffer.from(html, 'utf8').toString('base64');

      await win.loadURL(url);
      await this.waitReady(win);

      // 先量真实高度，再定窗口大小（内容是活的）
      const hRaw = await win.webContents.executeJavaScript(
        'Math.ceil(document.querySelector(".card").getBoundingClientRect().height)',
      );
      const height = Math.max(120, Math.min(Number(hRaw) || 300, 6000));
      win.setContentSize(this.width, height);
      await delay(90); // 等 resize 后重排稳定

      const img = await win.webContents.capturePage();
      const size = img.getSize();
      return { png: img.toPNG(), width: size.width, height: size.height };
    };
    return run();
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      show: false,
      width: this.width,
      height: 600,
      useContentSize: true,
      resizable: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      skipTaskbar: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win.on('closed', () => {
      this.win = null;
    });
    return this.win;
  }

  /** 等页面把 title 置为 ready（模板最后一步），最多约 800ms */
  private async waitReady(win: BrowserWindow): Promise<void> {
    for (let i = 0; i < 20; i++) {
      try {
        const t = await win.webContents.executeJavaScript('document.title');
        if (t === 'ready') return;
      } catch {
        /* 重试 */
      }
      await delay(40);
    }
  }
}
