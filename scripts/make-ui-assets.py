"""生成 UI 用的小图标 PNG（顶栏 brand、窗口图标）。

与 build/icon.ico 同源，但用途不同：
  - brand-64.png：顶栏左上角那个小方块，64px 足够（CSS 显示 23px，2x 屏用）
  - window-256.png：BrowserWindow 的 icon 参数用
"""
import importlib.util
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "mk", os.path.join(ROOT, "scripts", "make-icon.py")
)
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


def main():
    out_dir = os.path.join(ROOT, "src", "renderer", "assets")
    os.makedirs(out_dir, exist_ok=True)

    sw, sh, rows = M.load_source(M.SRC)
    mask, ink = M.extract_pigeon(rows, sw, sh)
    box = M.bbox(mask, sw, sh)
    cache = {}

    # 顶栏小图：64px 用 level 0（保留速度线与眼睛，缩到 23px 时细节丰富）
    for size, name in ((64, "brand-64.png"), (32, "brand-32.png")):
        rr = M.render_icon(size, mask, ink, sw, sh, box, cache)
        p = os.path.join(out_dir, name)
        print(f"{name}: {M.write_png(p, size, rr)} bytes -> {p}")

    # 窗口图标：256px 也是完整版
    rr = M.render_icon(256, mask, ink, sw, sh, box, cache)
    p = os.path.join(out_dir, "window-256.png")
    print(f"window-256.png: {M.write_png(p, 256, rr)} bytes -> {p}")


if __name__ == "__main__":
    main()
