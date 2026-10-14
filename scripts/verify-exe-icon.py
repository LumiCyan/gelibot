"""从 exe 的 PE 资源里提取内嵌图标，与 build/icon.ico 对比，确认打包用的是新图标。

关键：PE 资源目录里的 **子目录与叶子节点偏移是相对于资源段基址**的，
不是 RVA。早期按 RVA 解析会算出 NullType 错误。
"""
import struct
import sys

EXE = sys.argv[1] if len(sys.argv) > 1 else 'dist-release-v1151/win-unpacked/GeLi Bot.exe'
ICO = 'build/icon.ico'


def read_pe(path):
    d = open(path, 'rb').read()
    e_lfanew = struct.unpack('<I', d[0x3C:0x40])[0]
    assert d[e_lfanew:e_lfanew + 4] == b'PE\x00\x00', '不是 PE 文件'
    coff = e_lfanew + 4
    nsec, = struct.unpack('<H', d[coff + 2:coff + 4])
    opt_size, = struct.unpack('<H', d[coff + 16:coff + 18])
    opt = coff + 20
    magic, = struct.unpack('<H', d[opt:opt + 2])
    # PE32+ 数据目录从 opt+112 开始；PE32 从 opt+96
    dd = opt + (112 if magic == 0x20B else 96)
    res_rva, res_size = struct.unpack('<II', d[dd + 2 * 8:dd + 2 * 8 + 8])

    secs = []
    spos = opt + opt_size
    for i in range(nsec):
        s = spos + i * 40
        name = d[s:s + 8].rstrip(b'\x00')
        vsize, vaddr, rawsize, rawptr = struct.unpack('<IIII', d[s + 8:s + 24])
        secs.append((name, vaddr, vsize, rawptr, rawsize))
    return d, res_rva, res_size, secs


def rva_to_off(rva, secs):
    for _, vaddr, vsize, rawptr, rawsize in secs:
        if vaddr <= rva < vaddr + max(vsize, rawsize):
            return rawptr + (rva - vaddr)
    return None


def find_resource(d, res_rva, res_size, secs, type_id=3):
    """type_id=3 是 RT_ICON，14 是 RT_GROUP_ICON。

    返回 [(资源ID, 语言ID, data_offset, size)]。
    注意三级结构：type -> name(ID) -> language -> data entry。
    资源 ID 在第二级，语言 ID 在第三级，别把语言 ID 当成资源 ID。
    """
    base = rva_to_off(res_rva, secs)
    results = []

    def walk(off, level, res_id):
        n_named, n_id = struct.unpack('<HH', d[off + 12:off + 16])
        total = n_named + n_id
        for i in range(total):
            ent = off + 16 + i * 8
            name_id, data_off = struct.unpack('<II', d[ent:ent + 8])
            # 高位为 1 表示按名字索引，否则是 ID
            is_id = (name_id & 0x80000000) == 0
            ident = name_id & 0x7FFFFFFF if is_id else None
            # 子目录/叶子偏移都相对于资源段基址
            child = base + (data_off & 0x7FFFFFFF)
            if level == 0:
                if ident == type_id:
                    walk(child, 1, None)
            elif level == 1:
                walk(child, 2, ident)
            else:
                # 叶子：IMAGE_RESOURCE_DATA_ENTRY
                data_rva, size = struct.unpack('<II', d[child:child + 8])
                doff = rva_to_off(data_rva, secs)
                if doff is not None:
                    results.append((res_id, ident, doff, size))

    walk(base, 0, None)
    return results


def decode_dib_rgba(dib, W):
    """把 ICO 里的 DIB 负载解成自上而下的 RGBA 列表。

    DIB 布局：BITMAPINFOHEADER(40B) + 自下而上的 BGRA 行 + AND 掩码行。
    """
    if dib is None or len(dib) < 40:
        return None
    hdr_size, w, h2 = struct.unpack('<Iii', dib[:12])
    bi_bitcount, = struct.unpack('<H', dib[14:16])
    if bi_bitcount != 32:
        return None
    H = h2 // 2  # 高度存的是 2 倍（含 AND 掩码）
    px = dib[hdr_size:]
    rows = []
    for y in range(H - 1, -1, -1):  # 自下而上
        row = px[y * W * 4:(y + 1) * W * 4]
        rows.append([tuple(row[x * 4:x * 4 + 4]) for x in range(W)])  # BGRA
    return rows


def decode_png_rgba(data, W):
    """极简 PNG 解码：只支持 8bit RGBA / RGB（Windows 写图标就是这么存的）。"""
    import zlib

    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    off = 8
    idat = b''
    ct = bd = None
    iw = ih = 0
    while off < len(data):
        ln, = struct.unpack('>I', data[off:off + 4])
        typ = data[off + 4:off + 8]
        chunk = data[off + 8:off + 8 + ln]
        if typ == b'IHDR':
            iw, ih, bd, ct, comp, filt, inter = struct.unpack('>IIBBBBB', chunk)
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
        off += 12 + ln
    if bd != 8 or ct not in (2, 6) or iw != W or ih != W:
        return None
    nch = 3 if ct == 2 else 4
    raw = zlib.decompress(idat)
    stride = iw * nch
    out = []
    prev = bytearray(stride)

    def paeth(a, b, c):
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        if pa <= pb and pa <= pc:
            return a
        return b if pb <= pc else c

    pos = 0
    for _ in range(ih):
        ft = raw[pos]
        pos += 1
        cur = bytearray(raw[pos:pos + stride])
        pos += stride
        for i in range(stride):
            a = cur[i - nch] if i >= nch else 0
            b = prev[i]
            c = prev[i - nch] if i >= nch else 0
            if ft == 1:
                cur[i] = (cur[i] + a) & 0xFF
            elif ft == 2:
                cur[i] = (cur[i] + b) & 0xFF
            elif ft == 3:
                cur[i] = (cur[i] + ((a + b) >> 1)) & 0xFF
            elif ft == 4:
                cur[i] = (cur[i] + paeth(a, b, c)) & 0xFF
        row = []
        for x in range(iw):
            p = cur[x * nch:x * nch + nch]
            if nch == 4:
                # PNG 是 RGBA；转成 BGRA 以便和 DIB 对齐
                r, g, b, a = p
                row.append((b, g, r, a))
            else:
                r, g, b = p
                row.append((b, g, r, 255))
        out.append(row)
        prev = cur
    return out


def compare_png_vs_dib(png_data, dib_data, W):
    """比较内嵌 PNG 与本地 DIB 是否表示同一张图。返回 (是否一致, 说明)。"""
    png_rows = decode_png_rgba(png_data, W)
    dib_rows = decode_dib_rgba(dib_data, W)
    if png_rows is None or dib_rows is None:
        return False, '无法解码'
    if len(png_rows) != len(dib_rows):
        return False, f'行数不同 {len(png_rows)}/{len(dib_rows)}'
    diff = 0
    for pr, dr in zip(png_rows, dib_rows):
        for p, q in zip(pr, dr):
            if p != q:
                diff += 1
    total = W * W
    if diff == 0:
        return True, f'{total} 像素全等'
    # 允许极少量抗锯齿边缘差异（<0.5% 视为一致）
    ratio = diff / total
    if ratio < 0.005:
        return True, f'{diff}/{total} 像素微差({ratio*100:.2f}%)'
    return False, f'{diff}/{total} 像素不同({ratio*100:.2f}%)'


def main():
    d, res_rva, res_size, secs = read_pe(EXE)
    print(f'exe: {EXE}')
    print(f'资源段 RVA=0x{res_rva:x} size={res_size}')

    icons = find_resource(d, res_rva, res_size, secs, type_id=3)
    groups = find_resource(d, res_rva, res_size, secs, type_id=14)
    print(f'\nRT_ICON 条目: {len(icons)}')
    print(f'RT_GROUP_ICON 条目: {len(groups)}')

    # 从 GROUP_ICON 读出该图标组包含哪些尺寸
    print('\n=== RT_GROUP_ICON 内容（内嵌图标的尺寸清单）===')
    for gid, glang, goff, gsize in groups:
        grp = d[goff:goff + gsize]
        rcount, = struct.unpack('<H', grp[4:6])
        print(f'  组 {gid}: {rcount} 档')
        total = 0
        for i in range(rcount):
            e = grp[6 + i * 14:6 + (i + 1) * 14]
            w, h, cc, r, planes, bpp, nbytes, resid = struct.unpack('<BBBBHHIH', e[:14])
            W = w if w else 256
            H = h if h else 256
            total += nbytes
            print(f'    {W:3d}x{H:<3d} 位深{bpp:3d} 字节{nbytes:8d} 资源ID={resid}')
        print(f'    合计 {total} 字节')

    # 对比：build/icon.ico 的尺寸清单
    ico = open(ICO, 'rb').read()
    _, _, cnt = struct.unpack('<HHH', ico[:6])
    ico_sizes = []
    ico_total = 0
    for i in range(cnt):
        off = 6 + i * 16
        w, h, cc, r, planes, bpp, size, dataoff = struct.unpack('<BBBBHHII', ico[off:off + 16])
        W = w if w else 256
        ico_sizes.append((W, bpp, size))
        ico_total += size
    print(f'\n=== build/icon.ico：{cnt} 档，合计 {ico_total} 字节 ===')
    for W, bpp, size in ico_sizes:
        print(f'    {W:3d}x{W:<3d} 位深{bpp:3d} 字节{size:8d}')

    # 逐档比对像素数据。
    #
    # 注意：Windows 在 exe 资源里存 128/256 这类大尺寸图标时会改用 PNG 压缩，
    # 而 build/icon.ico 里存的是未压缩 DIB（BITMAPINFOHEADER + BGRA）。
    # 两者字节不同但图像一致，所以这里分两种情况判定：
    #   - 内嵌以 \x89PNG 开头 -> 解 PNG 得到 RGBA，与本地 DIB 解出的 RGBA 比像素
    #   - 否则直接比字节
    print('\n=== 逐档像素数据比对 ===')
    ico_map = {}
    for i in range(cnt):
        off = 6 + i * 16
        w, h, cc, r, planes, bpp, size, dataoff = struct.unpack('<BBBBHHII', ico[off:off + 16])
        W = w if w else 256
        ico_map[W] = ico[dataoff:dataoff + size]

    ok_all = True
    for gid, glang, goff, gsize in groups:
        grp = d[goff:goff + gsize]
        rcount, = struct.unpack('<H', grp[4:6])
        for i in range(rcount):
            e = grp[6 + i * 14:6 + (i + 1) * 14]
            w, h, cc, r, planes, bpp, nbytes, resid = struct.unpack('<BBBBHHIH', e[:14])
            W = w if w else 256
            match = [t for t in icons if t[0] == resid]
            if not match:
                print(f'  {W:3d}x{W:<3d} 资源ID {resid} 未找到  FAIL')
                ok_all = False
                continue
            _, _, doff, dsize = match[0]
            embedded = d[doff:doff + dsize]
            local = ico_map.get(W)
            if embedded[:4] == b'\x89PNG':
                # 内嵌是 PNG：解出 RGBA 与本地 DIB 解出的 RGBA 比像素
                same, note = compare_png_vs_dib(embedded, local, W)
                print(
                    f'  {W:3d}x{W:<3d} 内嵌PNG{dsize:7d} 本地DIB{len(local) if local else 0:8d} '
                    f'像素一致={same}  {note}  {"OK" if same else "FAIL"}'
                )
            else:
                same = (local is not None and embedded == local)
                print(
                    f'  {W:3d}x{W:<3d} 内嵌DIB{dsize:8d} 本地DIB{len(local) if local else 0:8d} '
                    f'字节一致={same}  {"OK" if same else "FAIL"}'
                )
            if not same:
                ok_all = False

    print()
    if ok_all:
        print('结论：exe 内嵌图标的每一档都与 build/icon.ico 图像一致')
    else:
        print('结论：存在不一致，需排查')


if __name__ == '__main__':
    main()
