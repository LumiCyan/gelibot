/**
 * ui-shot 的启动器。
 *
 * 直接 `electron scripts/ui-shot.cjs` 在两个地方会踩坑，所以单独包一层：
 *   1. 环境里若有 ELECTRON_RUN_AS_NODE=1，electron 会退化成纯 node，
 *      此时 require('electron') 拿不到 app/BrowserWindow，脚本第一行就崩；
 *   2. 无独显的机器上 GPU 进程会直接挂掉（0xC0000005），必须关掉硬件加速。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronBin = require('electron'); // 在 node 里它就是可执行文件路径
const HERE = path.dirname(fileURLToPath(import.meta.url));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-software-rasterizer',
  '--in-process-gpu',
  path.join(HERE, 'ui-shot.cjs'),
];

const child = spawn(electronBin, args, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('无法启动 Electron：', err.message);
  process.exit(1);
});
