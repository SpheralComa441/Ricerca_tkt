"""Genera le icone PNG dell'estensione (nessuna dipendenza: solo zlib).

Disegno: quadrato arrotondato blu scuro con una lente bianca e una "T" sul vetro.
Uso: python3 extension/tools/make_icons.py
"""

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "icons")

BG = (20, 33, 61)
ACCENT = (60, 130, 255)
WHITE = (255, 255, 255)


def png(path, w, h, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)


def coverage(fn, x, y, ss=4):
    """Antialiasing: frazione dei sotto-campioni dentro la forma"""
    n = 0
    for i in range(ss):
        for j in range(ss):
            if fn(x + (i + 0.5) / ss, y + (j + 0.5) / ss):
                n += 1
    return n / (ss * ss)


def make(size):
    s = size / 128.0
    r = 26 * s

    def rounded(px, py):
        cx = min(max(px, r), size - r)
        cy = min(max(py, r), size - r)
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r

    lx, ly, lr, lw = 54 * s, 54 * s, 30 * s, 11 * s

    def ring(px, py):
        d = math.hypot(px - lx, py - ly)
        return lr - lw / 2 <= d <= lr + lw / 2

    def glass(px, py):
        return math.hypot(px - lx, py - ly) < lr - lw / 2

    def handle(px, py):
        # segmento da (76,76) a (104,104), spessore 15
        ax, ay, bx, by = 74 * s, 74 * s, 104 * s, 104 * s
        t = max(0, min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
        qx, qy = ax + t * (bx - ax), ay + t * (by - ay)
        return math.hypot(px - qx, py - qy) <= 8 * s

    def tee(px, py):
        top = (40 * s <= px <= 68 * s) and (38 * s <= py <= 46 * s)
        stem = (50 * s <= px <= 58 * s) and (38 * s <= py <= 70 * s)
        return top or stem

    pix = [0] * (size * size * 4)
    for y in range(size):
        for x in range(size):
            a_bg = coverage(rounded, x, y)
            if a_bg == 0:
                continue
            col = list(BG)
            a_glass = coverage(glass, x, y)
            col = [c * (1 - a_glass) + g * a_glass for c, g in zip(col, ACCENT)]
            a_w = max(coverage(ring, x, y), coverage(handle, x, y), coverage(tee, x, y) if size >= 32 else 0)
            col = [c * (1 - a_w) + 255 * a_w for c in col]
            i = (y * size + x) * 4
            pix[i:i + 4] = [int(round(c)) for c in col] + [int(round(255 * a_bg))]
    return pix


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for n in (16, 32, 48, 128):
        png(os.path.join(OUT, f"icon{n}.png"), n, n, make(n))
        print("icon", n)
