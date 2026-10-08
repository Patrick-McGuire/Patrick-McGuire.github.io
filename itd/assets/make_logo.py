#!/usr/bin/env python3
"""Generate the ITD page's logo assets from its-that-deep-source.svg (the KiCad white logo).

The source is a raster trace: hundreds of 1-pixel-tall <rect>s. This merges them into one path
(stacking rows that share the same span into taller rectangles), so the page can inline it with
fill="currentColor" and tint it like text. Outputs, next to this script:

  logo-mark.svg         the ITD mark with the sound waves (no tagline): tab bar
  logo-full.svg         mark + "IT'S THAT DEEP": empty-state watermark
  favicon.svg           the mark, white on a dark rounded tile
  apple-touch-icon.png  180x180 version of the favicon (iOS home screen)

Run after replacing the source:  python itd/assets/make_logo.py
"""

import re
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "its-that-deep-source.svg"
MARK_ROWS = (33, 164)   # the mark; the tagline is rows 171-220 (the plug on its D starts at 171)
TILE = "#0b0e12"        # the page background


def load_spans():
    text = SRC.read_text(encoding="utf-8-sig")
    spans = []
    for x, y, w, h in re.findall(r'<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"', text):
        x, y, w, h = map(int, (x, y, w, h))
        for yy in range(y, y + h):
            spans.append((yy, x, w))
    return spans


def merge(spans):
    """(y, x, w) runs -> rectangles, stacking identical spans on consecutive rows."""
    open_rects = {}   # (x, w) -> [x, y0, w, h]
    done = []
    for y in sorted({s[0] for s in spans}):
        row = {(x, w) for yy, x, w in spans if yy == y}
        for key in list(open_rects):
            r = open_rects[key]
            if key in row and r[1] + r[3] == y:
                r[3] += 1
                row.discard(key)
            else:
                done.append(open_rects.pop(key))
        for x, w in row:
            open_rects[(x, w)] = [x, y, w, 1]
    done.extend(open_rects.values())
    return sorted(done, key=lambda r: (r[1], r[0]))


def path_d(rects):
    return "".join(f"M{x} {y}h{w}v{h}h-{w}z" for x, y, w, h in rects)


def bbox(rects, pad):
    x0 = min(r[0] for r in rects) - pad
    y0 = min(r[1] for r in rects) - pad
    x1 = max(r[0] + r[2] for r in rects) + pad
    y1 = max(r[1] + r[3] for r in rects) + pad
    return x0, y0, x1 - x0, y1 - y0


def svg(rects, title, pad=2):
    x, y, w, h = bbox(rects, pad)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x} {y} {w} {h}" role="img" '
            f'aria-label="{title}"><title>{title}</title>'
            f'<path fill="currentColor" d="{path_d(rects)}"/></svg>\n')


def tile_geometry(rects, size):
    """Square tile around the mark: returns (viewBox origin x, y, side) with ~16% margin."""
    x, y, w, h = bbox(rects, 0)
    side = max(w, h) * 1.32
    return x + w / 2 - side / 2, y + h / 2 - side / 2, side


def favicon(rects):
    ox, oy, side = tile_geometry(rects, 0)
    r = side * 0.2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{ox:.1f} {oy:.1f} {side:.1f} {side:.1f}">'
            f'<rect x="{ox:.1f}" y="{oy:.1f}" width="{side:.1f}" height="{side:.1f}" rx="{r:.1f}" fill="{TILE}"/>'
            f'<path fill="#ffffff" d="{path_d(rects)}"/></svg>\n')


def png(rects, size):
    """Rasterise the favicon (box-filtered 4x supersampling), no imaging library needed."""
    ox, oy, side = tile_geometry(rects, 0)
    ss = 4
    n = size * ss
    cover = bytearray(n * n)
    for x, y, w, h in rects:
        c0 = int((x - ox) / side * n); c1 = int((x + w - ox) / side * n)
        r0 = int((y - oy) / side * n); r1 = int((y + h - oy) / side * n)
        for rr in range(max(0, r0), min(n, r1)):
            cover[rr * n + max(0, c0): rr * n + min(n, c1)] = b"\x01" * (min(n, c1) - max(0, c0))
    bg = tuple(int(TILE[i:i + 2], 16) for i in (1, 3, 5))
    rad = size * 0.2
    raw = bytearray()
    for py in range(size):
        raw.append(0)
        for px in range(size):
            cov = sum(cover[(py * ss + a) * n + px * ss + b] for a in range(ss) for b in range(ss)) / (ss * ss)
            # rounded-corner alpha
            dx = max(rad - px - 0.5, px + 0.5 - (size - rad), 0)
            dy = max(rad - py - 0.5, py + 0.5 - (size - rad), 0)
            alpha = 255 if (dx * dx + dy * dy) <= rad * rad else 0
            raw += bytes(round(bg[i] + (255 - bg[i]) * cov) for i in range(3)) + bytes([alpha])
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def main():
    spans = load_spans()
    full = merge(spans)
    mark = merge([s for s in spans if MARK_ROWS[0] <= s[0] <= MARK_ROWS[1]])
    (HERE / "logo-full.svg").write_text(svg(full, "ITD - It's That Deep"), encoding="utf-8")
    (HERE / "logo-mark.svg").write_text(svg(mark, "ITD"), encoding="utf-8")
    (HERE / "favicon.svg").write_text(favicon(mark), encoding="utf-8")
    (HERE / "apple-touch-icon.png").write_bytes(png(mark, 180))
    for f in ("logo-full.svg", "logo-mark.svg", "favicon.svg", "apple-touch-icon.png"):
        print(f"{f}: {(HERE / f).stat().st_size:,} bytes")
    print(f"{len(spans)} source rows -> {len(full)} rectangles")


if __name__ == "__main__":
    main()
