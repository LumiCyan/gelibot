/**
 * 在线人数采集。
 *
 * 走主服 RCON 执行 `list`，把各服务端五花八门的输出解析成统一快照：
 *   { ok, online, max, players[], at }
 *
 * 解析器是纯函数、单独导出，方便单元测试；服务类只管调用与缓存。
 */
import type { RconClient } from './rcon';

/** 一次在线快照 */
export interface PresenceSnapshot {
  /** 本次查询是否成功（RCON 通 + 输出可解析） */
  ok: boolean;
  online: number;
  max: number;
  /** 在线玩家名（可能与 online 不等长：部分服务端名单会被截断） */
  players: string[];
  /** 快照时间戳（ms） */
  at: number;
  /** 失败原因 */
  error?: string;
}

/** list 解析结果 */
export interface ParsedList {
  online: number;
  max: number;
  players: string[];
}

/** 去掉 Minecraft 颜色代码（§x / &x 形式） */
function stripColors(text: string): string {
  return text.replace(/\u00a7./g, '').replace(/&[0-9a-fk-or]/gi, '');
}

/**
 * 切分玩家名单。
 * 兼容逗号、中文顿号、以及部分服务端用的 “a, b and c” 写法；
 * 过滤空串与明显不是玩家名的碎片（纯数字 / 超长）。
 */
export function splitPlayerNames(text: string): string[] {
  if (!text) return [];
  return stripColors(text)
    .replace(/\s+and\s+/gi, ',')
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 16 && !/^\d+$/.test(s));
}

/**
 * 解析 `list` 的输出。
 *
 * 见过的格式：
 *   There are 3 of a max of 20 players online: Steve, Alex   ← 原版 / Paper / Spigot
 *   There are 0 of a max of 20 players online:               ← 无人时
 *   There are 3 of a maximum of 20 players online: Steve     ← 少数服务端
 *   当前有 3/20 名玩家在线：Steve, Alex                         ← 中文服务端
 *   Players online: 3/20                                     ← 部分插件
 *
 * 全部匹配不上时返回 null（调用方据此降级为原样转发）。
 */
export function parseListOutput(raw: string): ParsedList | null {
  const text = stripColors(String(raw ?? '')).trim();
  if (!text) return null;

  // 1) 英文标准格式
  let m = /there are\s+(\d+)\s+of a max(?:imum)? of\s+(\d+)\s+players?\s+online\s*[:：]?\s*(.*)$/is.exec(
    text,
  );
  if (m) {
    return {
      online: Number(m[1]),
      max: Number(m[2]),
      players: splitPlayerNames(m[3] ?? ''),
    };
  }

  // 2) 中文格式：「当前有 3/20 名玩家在线： …」
  m = /(\d+)\s*[\/／]\s*(\d+)\s*(?:名)?\s*(?:玩家)?\s*(?:在线|online)/i.exec(text);
  if (m) {
    const after = text.slice(m.index + m[0].length).replace(/^\s*[:：]\s*/, '');
    return {
      online: Number(m[1]),
      max: Number(m[2]),
      players: splitPlayerNames(after),
    };
  }

  // 3) 「players online: 3/20」等倒装说法
  m = /players?\s+online\s*[:：]?\s*(\d+)\s*(?:\/|of|out of)\s*(\d+)/i.exec(text);
  if (m) {
    return { online: Number(m[1]), max: Number(m[2]), players: [] };
  }

  return null;
}

/**
 * 查询在线人数的候选命令，按顺序尝试。
 *
 * 为什么需要多个：部分插件服会用插件接管 `/list`（例如 CMI），
 * 导致 RCON 下 `list` 返回**空字符串**，而命名空间形式 `minecraft:list`
 * 反而能正常返回「There are N of a max of M players online:」。
 * 实测环境（Paper + CMI）：list → 空；minecraft:list → 正常。
 */
const LIST_COMMANDS = ['list', 'minecraft:list'];

/**
 * 在线数据服务。
 *
 * 不做后台定时轮询 —— 只有调用方显式 refresh() 时才查一次，
 * 避免为一个没人看的数字持续占用 RCON 连接。
 */
export class PresenceService {
  private rcon: RconClient;
  private snapshot: PresenceSnapshot | null = null;
  /** 合并并发的 refresh：同一时刻只会有一次在途查询 */
  private inflight: Promise<PresenceSnapshot> | null = null;
  /** 上一次成功的查询命令，下次优先使用（避免每次都探测两条） */
  private preferred: string | null = null;

  constructor(rcon: RconClient) {
    this.rcon = rcon;
  }

  /** 最近一次快照（可能为 null，表示从未查过） */
  getSnapshot(): PresenceSnapshot | null {
    return this.snapshot;
  }

  /** 主动查一次；并发调用会共享同一个在途请求 */
  refresh(): Promise<PresenceSnapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<PresenceSnapshot> {
    const at = Date.now();
    const order = this.preferred
      ? [this.preferred, ...LIST_COMMANDS.filter((c) => c !== this.preferred)]
      : LIST_COMMANDS;
    // RCON 连接类错误优先展示（比「内容为空」更接近根因）
    let rconError: string | null = null;
    let contentError = '';

    for (const cmd of order) {
      const res = await this.rcon.execute(cmd);
      if (!res.success) {
        rconError = rconError ?? (res.error ?? 'RCON 查询失败');
        continue;
      }
      const parsed = parseListOutput(res.response ?? '');
      if (parsed) {
        this.preferred = cmd;
        return this.commit({ ok: true, ...parsed, at });
      }
      const text = (res.response ?? '').trim();
      contentError = text ? '无法解析服务器返回的 list 内容' : `服务器未返回 ${cmd} 的内容`;
    }

    return this.commit({
      ok: false,
      online: 0,
      max: 0,
      players: [],
      at,
      error: rconError ?? contentError ?? '无法获取在线人数',
    });
  }

  private commit(snap: PresenceSnapshot): PresenceSnapshot {
    this.snapshot = snap;
    return snap;
  }
}

/**
 * 把快照渲染成文字（图片不可用时的降级形态）。
 * 模板变量：{server} {online} {max} {players} {error}
 */
export function renderTextTemplate(
  template: string,
  vars: { server: string; online: number; max: number; players: string[]; error?: string },
): string {
  const players = vars.players.length > 0 ? vars.players.join('、') : '无';
  return template
    .replace(/\{server\}/g, vars.server)
    .replace(/\{online\}/g, String(vars.online))
    .replace(/\{max\}/g, String(vars.max))
    .replace(/\{players\}/g, players)
    .replace(/\{error\}/g, vars.error ?? '');
}
