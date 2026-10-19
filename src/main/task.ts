/**
 * 定时任务调度。
 *
 * 支持两种触发方式（可同时配置）：
 *   - intervalMinutes：每 N 分钟一次
 *   - dailyAt：每天固定时刻（HH:mm）一次
 *
 * 调度粒度是 1 分钟（定时器每秒 tick 一次但只在「分钟变化」时求值），
 * 对于 MC 服务器的定时重启/备份/播报这个精度足够，也避免高频空转。
 *
 * 判定函数 shouldRun 是纯函数，便于单测时间边界。
 */

import type { ScheduledTask, TaskConfig } from '../shared/types';

/** 解析 "HH:mm"，非法返回 null */
export function parseDailyAt(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * 判断某个任务在当前时刻是否应当执行。
 *
 * @param now 当前时间
 * @returns true 表示本次触发
 *
 * 规则：
 *   - dailyAt 优先：分钟精确命中且「今天还没跑过」才执行
 *   - 否则看 intervalMinutes：从未执行过则立即执行一次，之后按间隔
 *   - 两者都未配置 → 永不执行
 */
export function shouldRun(task: ScheduledTask, now: Date): boolean {
  if (!task.enabled) return false;
  const last = task.lastRunAt ? Date.parse(task.lastRunAt) : null;
  const nowMs = now.getTime();

  // 每日定点
  const at = task.dailyAt ? parseDailyAt(task.dailyAt) : null;
  if (at) {
    if (now.getHours() !== at.hour || now.getMinutes() !== at.minute) return false;
    if (last === null) return true;
    const lastDate = new Date(last);
    // 同一分钟内已经跑过就不再重复（防止 tick 抖动导致一分钟内触发多次）
    return !(
      lastDate.getFullYear() === now.getFullYear() &&
      lastDate.getMonth() === now.getMonth() &&
      lastDate.getDate() === now.getDate() &&
      lastDate.getHours() === now.getHours() &&
      lastDate.getMinutes() === now.getMinutes()
    );
  }

  // 间隔触发
  if (task.intervalMinutes > 0) {
    if (last === null) return true;
    return nowMs - last >= task.intervalMinutes * 60_000;
  }

  return false;
}

/** 任务执行器（由主进程注入，负责真正发 RCON / 发群消息） */
export interface TaskRunner {
  run(task: ScheduledTask): Promise<void>;
}

/** 定时任务调度器 */
export class TaskScheduler {
  private config: TaskConfig;
  private runner: TaskRunner;
  private timer: NodeJS.Timeout | null = null;
  /** 上一次求值时的「分钟编号」，避免同一分钟内重复求值 */
  private lastMinuteKey = '';
  /** 执行历史（最近 100 条，仅内存展示） */
  private history: Array<{ at: string; taskId: string; name: string; ok: boolean; error?: string }> = [];

  constructor(config: TaskConfig, runner: TaskRunner) {
    this.config = config;
    this.runner = runner;
  }

  updateConfig(config: TaskConfig): void {
    this.config = config;
    if (config.enabled) this.start();
    else this.stop();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 每秒 tick 一次，但只在跨分钟时真正求值 */
  private tick(): void {
    if (!this.config.enabled) return;
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (key === this.lastMinuteKey) return;
    this.lastMinuteKey = key;

    for (const task of this.config.tasks) {
      if (!shouldRun(task, now)) continue;
      // 先记时间再执行：即使执行失败也不要每分钟重试轰炸
      task.lastRunAt = now.toISOString();
      void this.execute(task);
    }
  }

  private async execute(task: ScheduledTask): Promise<void> {
    try {
      await this.runner.run(task);
      this.pushHistory(task, true);
    } catch (err) {
      const msg = (err as Error).message;
      this.pushHistory(task, false, msg);
      console.error(`[tasks] ${task.name} 执行失败:`, msg);
    }
  }

  private pushHistory(task: ScheduledTask, ok: boolean, error?: string): void {
    this.history.push({
      at: new Date().toISOString(),
      taskId: task.id,
      name: task.name,
      ok,
      error,
    });
    if (this.history.length > 100) this.history = this.history.slice(-100);
  }

  /** 手动立即执行一条任务（界面上「立即运行」按钮） */
  async runNow(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.config.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: '任务不存在' };
    try {
      await this.runner.run(task);
      task.lastRunAt = new Date().toISOString();
      this.pushHistory(task, true);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      this.pushHistory(task, false, msg);
      return { ok: false, error: msg };
    }
  }

  getHistory(): Array<{ at: string; taskId: string; name: string; ok: boolean; error?: string }> {
    return [...this.history].reverse();
  }
}
