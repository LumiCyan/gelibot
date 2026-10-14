import { build } from 'esbuild';
import path from 'node:path';

/**
 * 打包渲染进程。
 * 通过 esbuild 的 JS API 调用，避免依赖 postinstall 生成的 wrapper ；
 * 平台二进制位于 @esbuild/<platform>/esbuild.exe。
 */
await build({
  entryPoints: [path.join(process.cwd(), 'src', 'renderer', 'main.tsx')],
  bundle: true,
  outfile: path.join(process.cwd(), 'dist', 'renderer', 'renderer.js'),
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome120',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});
