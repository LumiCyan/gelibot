/**
 * 服务端日志监听：把 Minecraft 服务端日志变成游戏内事件流。
 *
 * 为什么需要它：本项目通过 RCON 与服务器通信，RCON 只能「发命令」，
 * 拿不到任何主动事件（谁进服、谁说了话、谁死了）。而 EasyBot 之所以能
 * 做消息同步与玩家事件，是因为它跑在 MCDR 里、有事件钩子。
 * 我们的替代方案是 tail `logs/latest.log`，用正则解析出事件。
 *
 * 设计要点：
 * 1. 解析函数是纯函数（parseLogLine），可独立单测，不依赖 fs。
 * 2. 增量读取：记住文件偏移，只读新增字节；文件被轮转/截断时自动归零。
 * 3. 多服务端格式兼容：Vanilla / Paper / Spigot / Forge / Fabric 的日志前缀
 *    差异只在「时间戳 + 线程 + 等级」这一段，先统一剥掉再匹配正文。
 * 4. 假人过滤：Carpet 等模组的假玩家名带固定前缀，按配置过滤。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GameEvent, LogWatcherConfig } from '../shared/types';

/** 玩家名（MC 规则：3-16 位字母数字下划线，这里放宽到 1 位以兼容部分服务端） */
const NAME = '([A-Za-z0-9_.-]{1,16})';

/** 聊天：<玩家> 内容 */
const RE_CHAT = new RegExp(`^<${NAME}> ?(.*)$`);

/** 进服 / 退服 */
const RE_JOIN = new RegExp(`^${NAME} joined the game\\.?$`);
const RE_LEAVE = new RegExp(`^${NAME} left the game\\.?$`);

/** 成就 */
const RE_ADVANCEMENT = new RegExp(
  `^${NAME} has (made the advancement|completed the challenge|reached the goal) \\[(.+)\\]$`,
);

/** 服务器就绪 */
const RE_SERVER_START = /^Done \([\d.]+s\)! For help, type "help"/;

/**
 * 死亡消息的多语言模式。
 *
 * MC 的死亡消息由「死因」模板生成，英文有几十种、中文也有对应表达，
 * 不可能穷举。这里用「玩家名开头 + 命中死亡关键词」的组合判断：
 * 关键词表覆盖常见死因的动词/名词，误判率足够低（只有聊天和事件行会被看到，
 * 而聊天行已被 `<名字>` 形式先截走）。
 */
const DEATH_KEYWORDS_EN = [
  'was slain by',
  'was shot by',
  'was blown up by',
  'was fireballed by',
  'was pummeled by',
  'was impaled by',
  'was killed by',
  'was struck by lightning',
  'was squashed by',
  'was pricked to death',
  'was stung to death',
  'was mauled by',
  'was burnt to death',
  'was frozen to death',
  'was doomed to fall',
  'drowned',
  'died',
  'burned to death',
  'burned to a crisp',
  'bled to death',
  'starved to death',
  'suffocated in a wall',
  'tried to swim in lava',
  'fell from a high place',
  'fell off a ladder',
  'fell off some vines',
  'fell off some twisting vines',
  'fell off scaffolding',
  'fell while climbing',
  'hit the ground too hard',
  'fell out of the world',
  'went up in flames',
  'withered away',
  'froze to death',
  'experienced kinetic energy',
  'discovered the floor was lava',
  'didn\'t want to live in the same world as',
  'left the confines of this world',
];

const DEATH_KEYWORDS_ZH = [
  '被杀死了',
  '被击杀了',
  '被射杀',
  '被炸死',
  '淹死了',
  '摔死了',
  '摔了下来',
  '烧死了',
  '饿死了',
  '窒息而死',
  '在岩浆里游泳',
  '被岩浆烧死',
  '被闪电劈死',
  '死了',
  '身亡',
];

/**
 * 去掉日志行前面的「时间戳 / 线程 / 等级」前缀，只留正文。
 *
 * 覆盖的形态（实测常见）：
 *   [19:44:15] [Server thread/INFO]: <Steve> hi          ← Vanilla
 *   [19:44:15 INFO]: <Steve> hi                          ← Paper 1.19+
 *   [17Oct2026 19:44:15.123] [Server thread/INFO] [xxx/]: <Steve> hi  ← Forge
 *   [19:44:15] [Server thread/INFO] [minecraft/DedicatedServer]: <Steve> hi
 */
export function stripLogPrefix(line: string): string {
  let rest = line;
  // 反复剥掉开头的 [..] 段（最多 4 段，避免病态输入）
  for (let i = 0; i < 4; i++) {
    const m = /^\s*\[[^\]]*\]\s*:?\s*/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return rest.trim();
}

/** 判断一个名字是否命中假人前缀 */
export function isBotName(name: string, prefixes: string[], filterBots: boolean): boolean {
  if (!filterBots) return false;
  return prefixes.some((p) => p && name.startsWith(p));
}

/**
 * 把一行日志解析成游戏事件；不是事件行则返回 null。
 *
 * @param line 原始日志行（含前缀）
 * @param opts 假人过滤配置
 */
export function parseLogLine(
  line: string,
  opts: { botPrefixes?: string[]; filterBots?: boolean } = {},
): GameEvent | null {
  const raw = line.replace(/\r$/, '');
  if (!raw.trim()) return null;

  const body = stripLogPrefix(raw);
  if (!body) return null;

  const botPrefixes = opts.botPrefixes ?? [];
  const filterBots = opts.filterBots ?? true;
  const at = new Date().toISOString();

  // 服务器就绪
  if (RE_SERVER_START.test(body)) {
    return { kind: 'server-start', player: '', detail: '', raw, at };
  }

  // 聊天（先于死亡判断：聊天里的内容再怎么写也不会被误判，
  // 因为 <名字> 的尖括号形式是服务端独有的）
  const chat = RE_CHAT.exec(body);
  if (chat) {
    const player = chat[1];
    if (isBotName(player, botPrefixes, filterBots)) return null;
    return { kind: 'chat', player, detail: chat[2], raw, at };
  }

  const join = RE_JOIN.exec(body);
  if (join) {
    if (isBotName(join[1], botPrefixes, filterBots)) return null;
    return { kind: 'join', player: join[1], detail: '', raw, at };
  }

  const leave = RE_LEAVE.exec(body);
  if (leave) {
    if (isBotName(leave[1], botPrefixes, filterBots)) return null;
    return { kind: 'leave', player: leave[1], detail: '', raw, at };
  }

  const adv = RE_ADVANCEMENT.exec(body);
  if (adv) {
    if (isBotName(adv[1], botPrefixes, filterBots)) return null;
    return { kind: 'advancement', player: adv[1], detail: adv[3], raw, at };
  }

  // 死亡：名字开头 + 命中死因关键词
  const nameMatch = new RegExp(`^${NAME}\\s+(.+)$`).exec(body);
  if (nameMatch) {
    const player = nameMatch[1];
    if (!isBotName(player, botPrefixes, filterBots)) {
      const rest = nameMatch[2];
      const lower = rest.toLowerCase();
      const hit =
        DEATH_KEYWORDS_EN.some((kw) => lower.includes(kw)) ||
        DEATH_KEYWORDS_ZH.some((kw) => rest.includes(kw));
      if (hit) {
        return { kind: 'death', player, detail: rest, raw, at };
      }
    }
  }

  return null;
}

/** 事件回调 */
export type GameEventListener = (ev: GameEvent) => void;

/**
 * 日志文件监听器（tail -f 的轮询实现）。
 *
 * 为什么用轮询而不是 fs.watch：
 * - fs.watch 在 Windows 上对「文件被截断/重建」的行为不稳定，
 *   服务端重启（日志轮转）后经常收不到新内容。
 * - 500ms 轮询一次 stat + 增量 read 的开销可以忽略，且行为可预测。
 */
export class LogWatcher {
  private config: LogWatcherConfig;
  private listeners = new Set<GameEventListener>();
  private timer: NodeJS.Timeout | null = null;
  /** 当前读到的文件偏移 */
  private offset = 0;
  /** 未成行的残留缓冲 */
  private pending = '';
  /** 实际监听的日志文件绝对路径 */
  private resolvedPath: string | null = null;
  /** 最近一次错误（供界面展示） */
  private lastError: string | null = null;
  /** 是否已开始（首帧是否已完成历史重放） */
  private started = false;

  constructor(config: LogWatcherConfig) {
    this.config = config;
  }

  onEvent(cb: GameEventListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getStatus(): {
    running: boolean;
    path: string | null;
    offset: number;
    lastError: string | null;
  } {
    return {
      running: this.timer !== null,
      path: this.resolvedPath,
      offset: this.offset,
      lastError: this.lastError,
    };
  }

  updateConfig(config: LogWatcherConfig): void {
    const wasRunning = this.timer !== null;
    const pathChanged = this.resolvePath(config) !== this.resolvedPath;
    this.config = config;
    if (wasRunning) {
      if (!config.enabled) {
        this.stop();
      } else if (pathChanged) {
        // 换了日志文件，重开
        this.stop();
        this.start();
      }
    } else if (config.enabled) {
      this.start();
    }
  }

  /**
   * 解析出实际要监听的日志文件。
   * 优先用显式 logPath；否则用 serverDir/logs/latest.log。
   */
  private resolvePath(cfg: LogWatcherConfig = this.config): string | null {
    const explicit = cfg.logPath.trim();
    if (explicit) return path.resolve(explicit);
    const dir = cfg.serverDir.trim();
    if (!dir) return null;
    return path.resolve(path.join(dir, 'logs', 'latest.log'));
  }

  start(): void {
    if (this.timer) return;
    const target = this.resolvePath();
    if (!target) {
      this.lastError = '未配置服务端目录或日志路径';
      return;
    }
    if (!fs.existsSync(target)) {
      this.lastError = `日志文件不存在：${target}`;
      return;
    }
    this.resolvedPath = target;
    this.lastError = null;

    try {
      const size = fs.statSync(target).size;
      // 不重放历史时，从文件末尾开始，避免一启动就把几十万行历史事件全抛出去
      this.offset = this.config.replayHistory ? 0 : size;
      this.pending = '';
    } catch (err) {
      this.lastError = (err as Error).message;
      return;
    }

    this.started = true;
    this.timer = setInterval(() => this.tick(), 500);
    // 立刻跑一次，减少启动延迟
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** 一次轮询：读新增字节，按行解析并派发 */
  private tick(): void {
    const target = this.resolvedPath;
    if (!target) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      this.lastError = `读取日志失败：${(err as Error).message}`;
      return;
    }

    // 文件被截断或轮转（尺寸变小）→ 从头开始
    if (stat.size < this.offset) {
      this.offset = 0;
      this.pending = '';
    }
    if (stat.size === this.offset) return;

    const len = stat.size - this.offset;
    const buf = Buffer.alloc(len);
    let fd: number | null = null;
    try {
      fd = fs.openSync(target, 'r');
      fs.readSync(fd, buf, 0, len, this.offset);
    } catch (err) {
      this.lastError = `读取日志失败：${(err as Error).message}`;
      return;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* 忽略 */
        }
      }
    }

    this.offset = stat.size;
    this.lastError = null;

    const text = this.pending + buf.toString('utf8');
    const lines = text.split('\n');
    // 最后一段可能是半行，留到下次
    this.pending = lines.pop() ?? '';

    for (const line of lines) {
      const ev = parseLogLine(line, {
        botPrefixes: this.config.botPrefixes,
        filterBots: this.config.filterBots,
      });
      if (!ev) continue;
      for (const cb of this.listeners) {
        try {
          cb(ev);
        } catch (err) {
          console.error('[logwatcher] 监听器抛错:', err);
        }
      }
    }
  }
}
