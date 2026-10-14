import fs from 'node:fs';
import path from 'node:path';

/** 把 renderer 的静态资源（html/css/图标 及打包后的 js）复制到 dist 目录 */
const root = process.cwd();
const srcRenderer = path.join(root, 'src', 'renderer');
const outRenderer = path.join(root, 'dist', 'renderer');

fs.mkdirSync(outRenderer, { recursive: true });

for (const file of ['index.html', 'styles.css']) {
  const from = path.join(srcRenderer, file);
  const to = path.join(outRenderer, file);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, to);
    console.log(`copied ${file} -> dist/renderer/`);
  }
}

// 图标资源：由 scripts/make-ui-assets.py 生成，顶栏 brand 与窗口图标都用它
const srcAssets = path.join(srcRenderer, 'assets');
const outAssets = path.join(outRenderer, 'assets');
if (fs.existsSync(srcAssets)) {
  fs.mkdirSync(outAssets, { recursive: true });
  for (const file of fs.readdirSync(srcAssets)) {
    fs.copyFileSync(path.join(srcAssets, file), path.join(outAssets, file));
    console.log(`copied assets/${file} -> dist/renderer/assets/`);
  }
}
