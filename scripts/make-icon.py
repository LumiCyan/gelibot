"""GeLi Bot 图标生成器 —— 基于用户提供的鸽子图（APNG 首帧）。

思路：
  1. 解码源 APNG 的静态首帧（1280x1280 RGBA）
  2. 分离「鸽子剪影」与「背景渐变」：鸽子是黑色主体 + 白色镂空/速度线，
     背景是绿->青的对角渐变。判据 = 像素是否属于背景渐变的解析式。
  3. 面积平均重采样到目标尺寸（预乘 alpha，避免透明边缘发黑）
  4. 小尺寸（<=32px）自动精简：对鸽子做形态学收放，去掉速度线细部，
     保证 16px 下仍然清晰可辨
  5. 合成圆角渐变底 + 鸽子，输出 ICO（7 档）与 PNG 预览

不依赖 Pillow，纯手写字节流。
"""

import math
import os
import struct
import zlib

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.stage', 'source-icon.png')

# 鸽子躯体右边界约 x=835，速度线伸到 x=1041。小尺寸下从这个位置裁掉
# 速度线伸出段（见 trim_speedlines 的说明）。
SPEEDLINE_X_CUT = 845

# ---------------------------------------------------------------- PNG 解码

def parse_chunks(data):
    pos = 8
    out = []
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8].decode("latin1")
        out.append((typ, data[pos + 8:pos + 8 + ln]))
        pos += 12 + ln
        if typ == "IEND":
            break
    return out


def unfilter(raw, width, height, bpp):
    stride = width * bpp
    rows = []
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        ft = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ft != 0:
            raise ValueError(f"未知过滤类型 {ft}")
        rows.append(line)
        prev = line
    return rows


def load_source(path):
    """返回 (w, h, rows)，rows 为逐行 bytearray RGBA。"""
    data = open(path, "rb").read()
    chunks = parse_chunks(data)
    ihdr = next(p for t, p in chunks if t == "IHDR")
    w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", ihdr)
    if depth != 8 or ctype != 6 or interlace != 0:
        raise ValueError(f"源图格式不支持: depth={depth} ctype={ctype} interlace={interlace}")
    idat = b"".join(p for t, p in chunks if t == "IDAT")
    return w, h, unfilter(zlib.decompress(idat), w, h, 4)


# ---------------------------------------------------------------- 图像合成

def png_chunk(tag, payload):
    return (struct.pack('>I', len(payload)) + tag + payload
            + struct.pack('>I', zlib.crc32(tag + payload) & 0xFFFFFFFF))


def write_png(path, size, rgba_rows):
    raw = bytearray()
    for r in rgba_rows:
        raw.append(0)
        raw += r
    png = b'\x89PNG\r\n\x1a\n'
    png += png_chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += png_chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += png_chunk(b'IEND', b'')
    open(path, 'wb').write(png)
    return len(png)


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    if r <= 0:
        return True
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def gradient(u, v):
    """源图背景：**纯水平**渐变，左绿 -> 右青。

    实测采样（1280x1280，避开鸽子）：
      左上 #96fe90 / 左下 #96ff8f  -> 左端同一个绿
      右上 #8dfffb / 右下 #8cfffa  -> 右端同一个青
      上中 #91ffc5 / 下中 #93fec5  -> 中点上下一致
    说明只有水平分量，v 不参与。早期误判为对角渐变，导致色带断层。
    """
    t = max(0.0, min(1.0, u))
    left = (150, 255, 143)    # #96ff8f
    mid = (146, 255, 197)     # #92ffc5
    right = (141, 255, 250)   # #8dfffa
    if t < 0.5:
        k = t / 0.5
        c = tuple(left[i] + (mid[i] - left[i]) * k for i in range(3))
    else:
        k = (t - 0.5) / 0.5
        c = tuple(mid[i] + (right[i] - mid[i]) * k for i in range(3))
    return tuple(int(x + 0.5) for x in c)


# ---------------------------------------------------------------- 鸽子提取

def extract_pigeon(rows, w, h):
    """把源图拆成 (mask, ink)。

    mask[y][x] = 鸽子覆盖率 0..255
    ink[y][x]  = 鸽子颜色 (r,g,b) —— 大部分是黑，含少量白色速度线
    """
    mask = [[0] * w for _ in range(h)]
    ink = [[(0, 0, 0)] * w for _ in range(h)]

    for y in range(h):
        r = rows[y]
        for x in range(w):
            i = x * 4
            pr, pg, pb, pa = r[i], r[i + 1], r[i + 2], r[i + 3]
            u, v = x / (w - 1), y / (h - 1)
            br, bg, bb = gradient(u, v)
            # 与背景渐变的距离：小 => 背景，大 => 鸽子。
            # 源图背景是亮绿青（G 分量恒为 255 左右），鸽子是纯黑，
            # 用「亮度差 + 蓝色通道差」组合判定比纯 RGB 欧氏距离更稳。
            d = math.sqrt((pr - br) ** 2 + (pg - bg) ** 2 + (pb - bb) ** 2)
            if d > 110:
                mask[y][x] = 255
                ink[y][x] = (pr, pg, pb)
            elif d > 45:
                # 抗锯齿边缘：用距离做覆盖率的软过渡
                cov = (d - 45) / (110 - 45)
                mask[y][x] = int(cov * 255)
                ink[y][x] = (pr, pg, pb)
    return mask, ink


def bbox(mask, w, h, thr=150):
    """求鸽子的紧致包围盒。

    thr 取高值（默认 150）而不是 40：低阈值会把喙尖、底座圆角处的
    抗锯齿软过渡像素也算进来，使包围盒虚胖一圈，导致最终鸽子被缩小且偏移。
    用 150 只取「实心主体」，边缘的软过渡留给重采样阶段处理。
    """
    # 按列/行统计实心像素数，再要求覆盖率超过一个下限，滤掉孤立噪点
    col_cov = [sum(1 for y in range(h) if mask[y][x] > thr) for x in range(w)]
    row_cov = [sum(1 for x in range(w) if mask[y][x] > thr) for y in range(h)]

    def span(cov, limit=6):
        idx = [i for i, c in enumerate(cov) if c >= limit]
        return (idx[0], idx[-1] + 1) if idx else (0, len(cov))

    x0, x1 = span(col_cov)
    y0, y1 = span(row_cov)
    return x0, y0, x1, y1


# ---------------------------------------------------------------- 形态学精简

def morph_close(mask, w, h, r):
    """形态学闭运算：先膨胀 r 像素填平细缝，再腐蚀 r 像素还原外轮廓。

    用于小尺寸精简。注意只对 mask 有效——白色速度线在数据上是
    「前景里的白色像素」，不是 mask 的洞，所以它另有 flatten_ink 处理。
    """
    if r <= 0:
        return [row[:] for row in mask]

    def dilate(src):
        out = [[0] * w for _ in range(h)]
        for y in range(h):
            srow = src[y]
            for x in range(w):
                v = srow[x]
                if v == 0:
                    continue
                for dy in range(-r, r + 1):
                    yy = y + dy
                    if yy < 0 or yy >= h:
                        continue
                    orow = out[yy]
                    for dx in range(-r, r + 1):
                        xx = x + dx
                        if 0 <= xx < w and v > orow[xx]:
                            orow[xx] = v
        return out

    def erode(src):
        out = [[0] * w for _ in range(h)]
        for y in range(h):
            for x in range(w):
                m = 255
                for dy in range(-r, r + 1):
                    yy = y + dy
                    if yy < 0 or yy >= h:
                        m = 0
                        break
                    srow = src[yy]
                    for dx in range(-r, r + 1):
                        xx = x + dx
                        if xx < 0 or xx >= w:
                            m = 0
                            break
                        if srow[xx] < m:
                            m = srow[xx]
                    if m == 0:
                        break
                out[y][x] = m
        return out

    return erode(dilate(mask))


def trim_speedlines(mask, w, h, x_max):
    """裁掉主体右侧伸出的速度线区域（仅小尺寸使用）。

    实测：鸽子躯体右边界稳定在 x≈829~835，而白色速度线一直伸到 x=1041，
    超出躯体约 210px。缩到 32px 时那截只剩 ~7px，而且因为抗锯齿过渡色
    既不够黑也不够白，既压不黑也认不出，最后就是一块脏灰点。
    与其保留脏点，不如在小尺寸下直接裁掉——剪影更干净，辨识度更高。
    """
    out = [row[:] for row in mask]
    for y in range(h):
        for x in range(x_max, w):
            out[y][x] = 0
    return out


def keep_main_blob(mask, w, h, min_ratio=0.02):
    """只保留最大的连通域，丢掉游离碎块。

    小尺寸下速度线末端那截会脱离鸽子主体，缩到 32px 就是一团 1~2px 的
    灰点，既看不清又脏。用泛洪找连通域，保留面积最大的那个。
    眼睛是「主体内部的洞」，不受影响（它不与主体连通）。
    """
    thr = 128
    seen = [[False] * w for _ in range(h)]
    best = None
    best_area = 0

    for sy in range(h):
        for sx in range(w):
            if seen[sy][sx] or mask[sy][sx] < thr:
                continue
            # 泛洪（显式栈，避免深递归）
            stack = [(sx, sy)]
            seen[sy][sx] = True
            area = 0
            while stack:
                x, y = stack.pop()
                area += 1
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and mask[ny][nx] >= thr:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            if area > best_area:
                best_area = area
                best = (sx, sy)

    if best is None:
        return mask

    # 以 best 为种子重新泛洪出主体，其余清空
    out = [[0] * w for _ in range(h)]
    stack = [best]
    out[best[1]][best[0]] = mask[best[1]][best[0]]
    visited = {best}
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if (0 <= nx < w and 0 <= ny < h and (nx, ny) not in visited
                    and mask[ny][nx] >= thr):
                visited.add((nx, ny))
                out[ny][nx] = mask[ny][nx]
                stack.append((nx, ny))
    return out


def simplify_level(size):
    """按目标尺寸决定精简等级。

    实测结论：**不要对 mask 做闭运算**。
    鸽子眼睛在原图里是「背景色镂空」（约 100px 宽），在 32px 画布上
    只剩 ~2.5px，闭运算 r>=2 就会把它整个填平，鸽子变成没有眼睛的黑团。
    真正需要处理的是白色速度线——它在数据上是前景内的白像素（ink），
    不是 mask 的洞，所以只需 flatten_ink 把白压黑即可。

    等级只用来控制 flatten_ink 的激进程度：
      48+ : 0（保留速度线与眼睛）
      32  : 1（压掉速度线，保留眼睛）
      24  : 2
      16  : 3
    """
    if size >= 48:
        return 0
    if size >= 32:
        return 1
    if size >= 24:
        return 2
    return 3


def flatten_ink(ink, mask, w, h, level):
    """精简等级 >0 时，把前景内的白色细部（速度线、眼睛高光）压成黑色。

    这样小尺寸下得到的是实心剪影，不再有糊成一团的灰条纹。

    判据用「亮度下限 + 低饱和」而不是 r,g,b 全部 >190：
    速度线的边缘有大量抗锯齿过渡像素（如 #c0e0d0），只卡 190 会漏掉，
    在 32px 上就表现为一条灰色残留。放宽到 150 并检查通道接近程度，
    能连过渡带一起压掉。
    """
    if level <= 0:
        return ink
    out = [row[:] for row in ink]
    for y in range(h):
        mrow = mask[y]
        orow = out[y]
        for x in range(w):
            if mrow[x] == 0:
                continue
            r, g, b = orow[x]
            lo, hi = min(r, g, b), max(r, g, b)
            # 亮且不偏色（白/灰）-> 视为细部，压黑
            if lo >= 150 and (hi - lo) <= 60:
                orow[x] = (0, 0, 0)
    return out


# ---------------------------------------------------------------- 重采样

def resample(mask, ink, w, h, box, out_size, content=0.80, level=0):
    """从源图 box 区域重采样到 out_size 画布，鸽子占 content 比例。

    预乘 alpha 做面积平均，避免透明边缘发黑。
    level > 0 时掩码已由调用方做过形态学精简，这里只降低阈值让边缘更实。
    """
    bx0, by0, bx1, by1 = box
    bw, bh = bx1 - bx0, by1 - by0
    side = max(bw, bh)

    target = out_size * content
    scale = target / side
    dcx, dcy = (bx0 + bx1) / 2.0, (by0 + by1) / 2.0
    c = out_size / 2.0

    # 精简档位越高，阈值越低：让边缘更实、轮廓更连贯
    thr = 40 if level > 0 else 40

    out = []
    for oy in range(out_size):
        line = bytearray()
        for ox in range(out_size):
            sx0 = (ox - c) / scale + dcx
            sy0 = (oy - c) / scale + dcy
            sx1 = (ox + 1 - c) / scale + dcx
            sy1 = (oy + 1 - c) / scale + dcy
            ix0, ix1 = int(math.floor(sx0)), int(math.ceil(sx1))
            iy0, iy1 = int(math.floor(sy0)), int(math.ceil(sy1))

            acc_w = 0.0
            acc_r = acc_g = acc_b = 0.0
            n = 0
            for yy in range(max(0, iy0), min(h, iy1)):
                for xx in range(max(0, ix0), min(w, ix1)):
                    m = mask[yy][xx]
                    if m < thr:
                        n += 1
                        continue
                    cov = m / 255.0
                    ir, ig, ib = ink[yy][xx]
                    acc_r += ir * cov
                    acc_g += ig * cov
                    acc_b += ib * cov
                    acc_w += cov
                    n += 1
            if n == 0 or acc_w <= 0:
                line += b'\x00\x00\x00\x00'
                continue
            a = min(255, int(acc_w / n * 255 + 0.5))
            line += bytes((
                int(acc_r / acc_w + 0.5),
                int(acc_g / acc_w + 0.5),
                int(acc_b / acc_w + 0.5),
                a,
            ))
        out.append(line)
    return out


# ---------------------------------------------------------------- 图标渲染

def render_icon(size, pigeon_mask, pigeon_ink, sw, sh, box, cache=None):
    """合成最终图标：圆角渐变底 + 鸽子。

    size <= 32 时启用形态学精简：掩码做闭运算去掉细缝，ink 里的白色
    细部压成黑色，得到干净的实心剪影。精简结果按 level 缓存复用。
    """
    simple = size <= 32
    pad = size * 0.02
    radius = size * 0.22

    level = simplify_level(size)

    mask, ink = pigeon_mask, pigeon_ink
    if level > 0:
        key = ('flat', level)
        if cache is not None and key in cache:
            mask, ink = cache[key]
        else:
            # 只压白，不动 mask —— 保住眼睛镂空
            ink = flatten_ink(pigeon_ink, pigeon_mask, sw, sh, level)
            mask = pigeon_mask
            # 32px 及以下：裁掉右侧速度线伸出段，避免糊成脏灰点
            mask = trim_speedlines(mask, sw, sh, SPEEDLINE_X_CUT)
            if level >= 2:
                mask = keep_main_blob(mask, sw, sh)
            if cache is not None:
                cache[key] = (mask, ink)

        use_box = bbox(mask, sw, sh, thr=120) if level >= 1 else box
    else:
        use_box = box

    pigeon = resample(mask, ink, sw, sh, use_box, size,
                      content=0.84 if simple else 0.80, level=level)

    rows = []
    for y in range(size):
        line = bytearray()
        for x in range(size):
            fx, fy = x + 0.5, y + 0.5
            if not inside_round_rect(fx, fy, pad, pad, size - 1 - pad, size - 1 - pad, radius):
                line += b'\x00\x00\x00\x00'
                continue
            u, v = x / (size - 1), y / (size - 1)
            br, bg, bb = gradient(u, v)
            i = x * 4
            dr, dg, db, da = pigeon[y][i], pigeon[y][i + 1], pigeon[y][i + 2], pigeon[y][i + 3]
            if da == 0:
                line += bytes((br, bg, bb, 255))
            else:
                k = da / 255.0
                line += bytes((
                    int(dr * k + br * (1 - k) + 0.5),
                    int(dg * k + bg * (1 - k) + 0.5),
                    int(db * k + bb * (1 - k) + 0.5),
                    255,
                ))
        rows.append(line)
    return rows


# ---------------------------------------------------------------- 输出

def ico_payload(size, rgba_rows):
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    body = bytearray()
    for y in range(size - 1, -1, -1):
        r = rgba_rows[y]
        for x in range(size):
            i = x * 4
            body += bytes((r[i + 2], r[i + 1], r[i], r[i + 3]))
    mask_row = ((size + 31) // 32) * 4
    return header + bytes(body) + bytes(mask_row * size)


def build_ico(path, payloads):
    offset = 6 + 16 * len(payloads)
    entries, data = b'', b''
    for size, payload in payloads:
        v = 0 if size >= 256 else size
        entries += struct.pack('<BBBBHHII', v, v, 0, 0, 1, 32, len(payload), offset)
        data += payload
        offset += len(payload)
    open(path, 'wb').write(struct.pack('<HHH', 0, 1, len(payloads)) + entries + data)
    return os.path.getsize(path)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    build_dir = os.path.join(root, 'build')
    os.makedirs(build_dir, exist_ok=True)

    sw, sh, rows = load_source(SRC)
    print(f'源图: {sw}x{sh}')
    mask, ink = extract_pigeon(rows, sw, sh)

    box = bbox(mask, sw, sh)
    print(f'鸽子包围盒: {box}  尺寸 {box[2]-box[0]}x{box[3]-box[1]}')

    cache = {}
    sizes = [16, 24, 32, 48, 64, 128, 256]
    payloads = []
    for s in sizes:
        rr = render_icon(s, mask, ink, sw, sh, box, cache)
        payloads.append((s, ico_payload(s, rr)))
        print(f'  {s:3d}x{s:<3d} 精简等级 {simplify_level(s)}')

    out = os.path.join(build_dir, 'icon.ico')
    n = build_ico(out, payloads)
    print(f'icon.ico: {n} bytes -> {out}')

    for s in (16, 32, 64, 256):
        rr = render_icon(s, mask, ink, sw, sh, box, cache)
        p = os.path.join(build_dir, f'icon-preview-{s}.png')
        print(f'预览 {s}x{s}: {write_png(p, s, rr)} bytes -> {p}')


if __name__ == '__main__':
    main()
