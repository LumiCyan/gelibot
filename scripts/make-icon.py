"""纯 Python 生成 ICO（不依赖 Pillow）。

ICO 内嵌 BMP（DIB）：BITMAPINFOHEADER + BGRA 像素（自下而上）+ AND 掩码。

GeLi Bot 图标：
  - 白色圆角方块 + 极浅蓝描边
  - 中央蓝色实心圆角方块（"应用块"）
  - 块内白色「G」，用**极坐标扫描**判定：在圆环范围内、且不在右侧开口扇区内 → 白
    G 的缺口用「扇区 + 半径阈值」表达，横杠单独补一条矩形
  - 右上角浅绿在线点

关键：G 由「圆环 - 右侧开口 + 中横杠 + 右短竖」构成，全部用解析式判定，
不使用面积填充，避免出现「蓝底白缺口」这种反相观感。
"""
import os
import struct

WHITE = (255, 255, 255)
BLUE = (37, 99, 235)        # #2563eb
GREEN = (16, 185, 129)      # #10b981
BORDER = (219, 234, 254)    # #dbeafe


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    if r <= 0:
        return True
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def render(size):
    w = h = size
    px = [[(0, 0, 0, 0)] * w for _ in range(h)]

    simple = size <= 24
    pad = size * 0.035
    radius = size * 0.235
    border_w = max(1.0, size * 0.028)

    # ---- 1. 白色圆角底 ----
    for y in range(h):
        for x in range(w):
            if inside_round_rect(x + 0.5, y + 0.5, pad, pad, size - 1 - pad, size - 1 - pad, radius):
                px[y][x] = (*WHITE, 255)

    # ---- 2. 浅蓝描边 ----
    for y in range(h):
        for x in range(w):
            if px[y][x][3] == 0:
                continue
            fx, fy = x + 0.5, y + 0.5
            if inside_round_rect(fx, fy, pad, pad, size - 1 - pad, size - 1 - pad, radius) and not \
               inside_round_rect(fx, fy,
                                 pad + border_w, pad + border_w,
                                 size - 1 - pad - border_w, size - 1 - pad - border_w,
                                 max(0.0, radius - border_w)):
                px[y][x] = (*BORDER, 255)

    # ---- 3. 蓝色圆角块 ----
    bx0, by0 = size * 0.165, size * 0.165
    bx1, by1 = size * 0.835, size * 0.835
    brad = size * 0.20

    for y in range(h):
        for x in range(w):
            if inside_round_rect(x + 0.5, y + 0.5, bx0, by0, bx1, by1, brad):
                px[y][x] = (*BLUE, 255)

    # ---- 4. 白色 G ----
    # 归一化到蓝色块内部，0~1
    span = bx1 - bx0
    cx = cy = 0.5
    R = 0.255
    thick = 0.145 if simple else 0.125
    # 右侧开口的角范围（屏幕坐标：atan2(dy, dx)，x 右 y 下）
    # 开口大致在 -38° ~ +38°
    import math
    open_lo = math.radians(-40)
    open_hi = math.radians(40)

    def in_G(fx, fy):
        nx = (fx - bx0) / span
        ny = (fy - by0) / span
        dx, dy = nx - cx, ny - cy
        d = math.hypot(dx, dy)

        # (a) 圆环主体
        if abs(d - R) <= thick:
            ang = math.atan2(dy, dx)
            # 右侧开口：只有当环位于开口扇区且 |dy| 不大时挖掉
            if open_lo <= ang <= open_hi:
                pass
            else:
                return True

        # (b) 中横杠：从圆心右侧开始，向右延伸
        bar_y0, bar_y1 = cy - thick * 0.62, cy + thick * 0.62
        if bar_y0 <= ny <= bar_y1 and cx <= nx <= R + thick * 0.9:
            return True

        # (c) 右短竖：从横杠右端向下，封住开口下缘
        stem_x0 = R - thick * 0.15
        stem_x1 = R + thick * 0.95
        if stem_x0 <= nx <= stem_x1 and cy <= ny <= cy + R * 0.86:
            return True

        return False

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[y][x]
            if a == 0 or (r, g, b) != BLUE:
                continue
            if in_G(x + 0.5, y + 0.5):
                px[y][x] = (*WHITE, 255)

    # ---- 5. 浅绿在线点 ----
    if not simple:
        dcx, dcy = size * 0.775, size * 0.225
        dr = size * 0.105
        for y in range(h):
            for x in range(w):
                if px[y][x][3] == 0:
                    continue
                fx, fy = x + 0.5, y + 0.5
                d = math.hypot(fx - dcx, fy - dcy)
                if d <= dr * 1.42:
                    px[y][x] = (*WHITE, 255)
        for y in range(h):
            for x in range(w):
                if px[y][x][3] == 0:
                    continue
                fx, fy = x + 0.5, y + 0.5
                if math.hypot(fx - dcx, fy - dcy) <= dr:
                    px[y][x] = (*GREEN, 255)

    out = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[y][x]
            out += bytes((b, g, r, a))
    return w, h, bytes(out)


def bmp_payload(size):
    w, h, bgra = render(size)
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    mask_row = ((w + 31) // 32) * 4
    return header + bgra + bytes(mask_row * h)


def build_ico(path, sizes):
    images = [(s, bmp_payload(s)) for s in sizes]
    offset = 6 + 16 * len(images)
    entries = b''
    data = b''
    for s, payload in images:
        v = 0 if s >= 256 else s
        entries += struct.pack('<BBBBHHII', v, v, 0, 0, 1, 32, len(payload), offset)
        data += payload
        offset += len(payload)
    with open(path, 'wb') as f:
        f.write(struct.pack('<HHH', 0, 1, len(images)) + entries + data)
    return os.path.getsize(path)


def render_png(size, path):
    import zlib

    w, h, bgra = render(size)
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            i = (y * w + x) * 4
            b, g, r, a = bgra[i], bgra[i + 1], bgra[i + 2], bgra[i + 3]
            raw += bytes((r, g, b, a))

    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', zlib.crc32(tag + payload) & 0xFFFFFFFF))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    return len(png)


if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    build_dir = os.path.join(root, 'build')
    os.makedirs(build_dir, exist_ok=True)

    out = os.path.join(build_dir, 'icon.ico')
    n = build_ico(out, [16, 24, 32, 48, 64, 128, 256])
    print(f'icon.ico: {n} bytes -> {out}')

    for s in (256, 64, 32, 16):
        p = os.path.join(build_dir, f'icon-preview-{s}.png')
        print(f'预览 {s}x{s}: {render_png(s, p)} bytes -> {p}')
