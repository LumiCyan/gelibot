/**
 * 在线展示的编排层：把「采集 → 头像 → 渲染 → 落盘」串成一步。
 *
 * 对上层（路由）只暴露一个 build()：成功返回可直接发给 OneBot 的
 * 消息文本（图片 CQ 码或文字），彻底失败返回 null（上层走原生 RCON 流程）。
 *
 * 降级链（从好看往保底退）：
 *   图片卡片  →  文字模板（同一份数据）  →  原生 list 输出（由路由处理）
 */
import type { AppConfig } from '../shared/types';
import type { PresenceService, PresenceSnapshot } from './presence';
import { renderTextTemplate } from './presence';
import type { AvatarCache } from './avatar';
import type { CardRenderer } from './card';
import { writeCardMessage } from './card-file';
import type { CardData } from './card-template';

export interface OnlineCardServiceOptions {
  presence: PresenceService;
  avatars: AvatarCache;
  renderer: CardRenderer;
  /** 取当前配置 */
  getConfig: () => AppConfig;
  /** 玩家 ID 反查绑定（未绑定返回 undefined） */
  findBinding: (playerId: string) => { qq: string } | undefined;
  /** 卡片文件目录 */
  cardDir: string;
  log?: (msg: string) => void;
}

/** 单张卡片最多展示的玩家数（防极端情况下 HTML 体积失控） */
const MAX_CARD_PLAYERS = 40;

function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export class OnlineCardService {
  private opts: OnlineCardServiceOptions;
  private log: (msg: string) => void;

  constructor(opts: OnlineCardServiceOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
  }

  /**
   * 查询并渲染。
   * 返回 null 表示「这里给不出结果」，调用方应回退到原生 RCON 流程。
   */
  async build(): Promise<string | null> {
    const cfg = this.opts.getConfig();
    const presence = cfg.presence;
    const snap = await this.opts.presence.refresh();

    // 数据都拿不到 → 交还上层（会得到原生的失败提示）
    if (!snap.ok) return null;

    const text = () =>
      renderTextTemplate(presence.textTemplate, {
        server: presence.serverName,
        online: snap.online,
        max: snap.max,
        players: snap.players,
      });

    if (!presence.sendImage) return text();

    try {
      const data = await this.buildData(snap);
      const { png } = await this.opts.renderer.render(data);
      return writeCardMessage(this.opts.cardDir, png);
    } catch (err) {
      this.log(`卡片渲染失败，降级为文字：${(err as Error).message}`);
      return text();
    }
  }

  /**
   * 把快照组装成卡片数据：逐名反查绑定 QQ 并批量拉头像。
   * 预览（IPC）与正式发送共用这一条路径，保证预览所见即所得。
   *
   * @param presenceOverride 界面草稿配置（预览用）；省略时读当前已保存配置
   */
  async buildData(
    snap: PresenceSnapshot,
    presenceOverride?: AppConfig['presence'],
  ): Promise<CardData> {
    const presence = presenceOverride ?? this.opts.getConfig().presence;

    const nameToQq = new Map<string, string>();
    if (presence.showAvatars) {
      for (const name of snap.players) {
        const rec = this.opts.findBinding(name);
        if (rec) nameToQq.set(name, rec.qq);
      }
    }
    const avatarMap =
      nameToQq.size > 0
        ? await this.opts.avatars.getMany(Array.from(nameToQq.values()))
        : new Map<string, string>();

    const shown = snap.players.slice(0, MAX_CARD_PLAYERS);
    const players = shown.map((name) => {
      const qq = nameToQq.get(name);
      return { name, avatar: qq ? avatarMap.get(qq) ?? null : null };
    });

    return {
      serverName: presence.serverName,
      online: snap.online,
      max: snap.max,
      players,
      timeText: formatTime(new Date()),
    };
  }

  /** 演示数据：RCON 不可用时预览仍能出图，界面会标注「演示数据」 */
  static demoData(serverName: string): CardData {
    const names = ['Steve', 'Alex', 'Notch', 'Herobrine', 'FeiGe'];
    return {
      serverName,
      online: names.length,
      max: 20,
      players: names.map((name) => ({ name, avatar: null })),
      timeText: formatTime(new Date()),
    };
  }
}
