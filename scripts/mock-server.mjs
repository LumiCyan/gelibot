#!/usr/bin/env node
/**
 * 虚拟 Minecraft 服务器（用于本地排查，不参与打包）。
 *
 * 提供两样东西，正好对应本项目的两条通道：
 *   1. **RCON 服务端** —— 实现 Source RCON 协议（登录 + 命令 + 响应），
 *      让 RconClient / presence / router 能被真实网络往返验证，而不是 mock 掉。
 *   2. **日志写入器** —— 按固定节奏往 logs/latest.log 追加真实的日志行，
 *      让 LogWatcher 的解析链路能被真实验证。
 *
 * 用法：
 *   node scripts/mock-server.mjs [--dir .stage/mock-server] [--port 25575] [--no-events]
 *
 * 命令支持：
 *   list / tps / mspt / whitelist add|remove|list / save-all / say / tellraw
 *   / kick / time set / help / stop（不回真实退出，只回 OK）
 *
 * 设计原则：只依赖 node 内置模块，不引第三方，跑完即弃。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// ---------------------------------------------------------------- 参数
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const BASE_DIR = path.resolve(argValue('--dir', path.join('.stage', 'mock-server')));
const PORT = Number(argValue('--port', '25575'));
const PASSWORD = argValue('--password', 'mockpass');
const EVENTS_ENABLED = !args.includes('--no-events');
/** 日志事件节奏：进服→聊天→死亡→退服，循环 */
const EVENT_INTERVAL_MS = Number(argValue('--event-interval', '2500'));

const LOG_DIR = path.join(BASE_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'latest.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------- 世界状态
const MAX_PLAYERS = 20;
/** 在线玩家（有序，模拟真实 list 输出） */
let online = ['Steve', 'Alex'];
/** 假人（用于验证前缀过滤）：故意带 Bot_ 前缀 */
const BOTS = ['Bot_Farmer'];

const whitelist = new Set(['Steve', 'Alex']);

// ---------------------------------------------------------------- 日志
const pad = (n) => String(n).padStart(2, '0');
function timePrefix(d = new Date()) {
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

/** 追加一行到 latest.log（真实 MC 的 Vanilla 格式） */
function logLine(text) {
  const line = `${timePrefix()} [Server thread/INFO]: ${text}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
  return line;
}

/** 文件被外部截断时（比如测试想重放），从头写 */
function resetLog() {
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  logLine('Starting minecraft server version 1.21.1');
  logLine('Done (3.142s)! For help, type "help"');
}

// ---------------------------------------------------------------- RCON 协议
/** 包类型 */
const TYPE_RESPONSE = 0;
const TYPE_COMMAND = 2;
const TYPE_LOGIN = 3;

/**
 * 编码一个 RCON 包。
 * 布局：length(4, LE) + requestId(4) + type(4) + payload + 0x00 0x00
 * length 不包含自身那 4 字节。
 */
function encodePacket(id, type, payload) {
  const body = Buffer.from(payload, 'utf8');
  const buf = Buffer.alloc(body.length + 14);
  buf.writeInt32LE(body.length + 10, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  body.copy(buf, 12);
  buf.writeUInt8(0, 12 + body.length);
  buf.writeUInt8(0, 13 + body.length);
  return buf;
}

/** 执行一条命令，返回响应文本 */
function execCommand(cmd) {
  const raw = cmd.trim();
  const lower = raw.toLowerCase();

  if (lower === 'list') {
    const all = [...online, ...BOTS];
    // Vanilla 真实格式：There are N of a max of M players online: a, b, c
    return `There are ${all.length} of a max of ${MAX_PLAYERS} players online: ${all.join(', ')}`;
  }

  if (lower === 'tps') {
    return 'TPS from last 1m, 5m, 15m: 20.0, 19.98, 19.95';
  }
  if (lower === 'mspt') {
    return 'Server tick times (ms): 3.21, 2.88, 4.05';
  }

  if (lower.startsWith('whitelist add ')) {
    const name = raw.slice('whitelist add '.length).trim();
    if (!name) return 'Usage: whitelist add <player>';
    whitelist.add(name);
    return `Added ${name} to the whitelist`;
  }
  if (lower.startsWith('whitelist remove ')) {
    const name = raw.slice('whitelist remove '.length).trim();
    whitelist.delete(name);
    return `Removed ${name} from the whitelist`;
  }
  if (lower === 'whitelist list') {
    return `There are ${whitelist.size} whitelisted player(s): ${[...whitelist].join(', ')}`;
  }
  if (lower === 'whitelist reload') {
    return 'Reloaded the whitelist';
  }

  if (lower === 'save-all' || lower === 'save-all flush') {
    return 'Saved the game';
  }

  if (lower.startsWith('say ')) {
    logLine(`[Server] ${raw.slice(4)}`);
    return '';
  }

  if (lower.startsWith('tellraw ')) {
    // 真实服务端：玩家不在线时仍「成功」，但响应里带提示
    const target = raw.split(/\s+/)[1] ?? '@a';
    if (target !== '@a' && !online.includes(target)) {
      return `No player was found`;
    }
    return '';
  }

  if (lower.startsWith('kick ')) {
    const parts = raw.split(/\s+/);
    const name = parts[1];
    if (!online.includes(name)) return `No player was found`;
    online = online.filter((p) => p !== name);
    logLine(`${name} left the game`);
    return `Kicked ${name}`;
  }

  if (lower.startsWith('time set')) return 'Set the time to 1000';
  if (lower === 'help') return '/list /tps /mspt /whitelist /save-all /say /tellraw /kick /stop';
  if (lower === 'stop') return 'Stopping the server';

  // 未知命令：原版会回一句「未知命令」，这里保持同样语义
  return `Unknown or incomplete command, see below for error\n${raw}<--[HERE]`;
}

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let authed = false;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // 一个 TCP 包里可能有多条 RCON 包，循环拆
    for (;;) {
      if (buffer.length < 4) break;
      const len = buffer.readInt32LE(0);
      if (buffer.length < len + 4) break;

      const id = buffer.readInt32LE(4);
      const type = buffer.readInt32LE(8);
      const payload = buffer.toString('utf8', 12, 4 + len - 2);
      buffer = buffer.subarray(4 + len);

      if (type === TYPE_LOGIN) {
        if (payload === PASSWORD) {
          authed = true;
          socket.write(encodePacket(id, TYPE_COMMAND, ''));
        } else {
          // 认证失败约定：requestId = -1
          socket.write(encodePacket(-1, TYPE_COMMAND, ''));
        }
        continue;
      }

      if (type === TYPE_COMMAND) {
        if (!authed) {
          socket.write(encodePacket(-1, TYPE_COMMAND, ''));
          continue;
        }
        const out = execCommand(payload);
        socket.write(encodePacket(id, TYPE_RESPONSE, out));
      }
    }
  });

  socket.on('error', () => {
    /* 客户端断开属正常 */
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] RCON 已监听 127.0.0.1:${PORT}（密码 ${PASSWORD}）`);
  console.log(`[mock] 日志文件 ${LOG_FILE}`);
  resetLog();

  if (!EVENTS_ENABLED) {
    console.log('[mock] 已关闭事件模拟');
    return;
  }

  // 循环模拟真实玩家行为：进服 → 聊天 → 死亡 → 退服
  let step = 0;
  const players = ['Steve', 'Alex', 'Notch', 'Herobrine'];
  setInterval(() => {
    const name = players[step % players.length];
    switch (step % 4) {
      case 0:
        if (!online.includes(name)) online.push(name);
        logLine(`${name} joined the game`);
        break;
      case 1:
        logLine(`<${name}> 有人一起挖矿吗`);
        break;
      case 2:
        logLine(`${name} was slain by Zombie`);
        break;
      case 3:
        online = online.filter((p) => p !== name);
        logLine(`${name} left the game`);
        break;
      default:
        break;
    }
    step++;
  }, EVENT_INTERVAL_MS).unref();
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
