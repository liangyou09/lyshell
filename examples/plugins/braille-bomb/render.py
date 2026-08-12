#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""braille-bomb: 跨终端炸弹投掷 demo, stage-and-release 同步(远程 SSH 会话版)。

两个终端并排:pane0(左侧)抛出炸弹,沿抛物线飞到 pane1(右侧),命中后
爆闪 + 粒子迸射 + 显示 "BOOM"。
- 切片:本终端画全局列 [INDEX*cols .. (INDEX+1)*cols],全局宽 = TOTAL*cols。
- 同步:插件先把同一脚本发到两个会话,python 打印 READY 后阻塞读 stdin;
  等两边 READY 到齐,插件同时发触发字节,两终端同步开跑。
- 零反斜杠:ESC/换行用 bytes([N]) 拼,send_input 转义处理器对命令本体 no-op。
"""

import sys
import os
import time
import math
import random
import select

ESC = bytes([27])
NL = bytes([10])
HOME = ESC + b'[H'
CLEAR = ESC + b'[2J' + HOME
ENTER_ALT = ESC + b'[?1049h'
LEAVE_ALT = ESC + b'[?1049l'
HIDE = ESC + b'[?25l'
SHOW = ESC + b'[?25h'
RESET = ESC + b'[0m'

READY_MARKER = 'LYSHELL_BOMB_READY'
TRIGGER_TIMEOUT = 30.0
DURATION = 6.5
FPS = 25

DOT = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
]

IMPACT_T = 2.0
EXPLOSION_T = 2.2
BOMB_R = 7.0

random.seed(0xB0B0)


def env_int(name, default):
    v = os.environ.get(name)
    if v is None:
        return default
    try:
        return int(v)
    except ValueError:
        return default


INDEX = env_int('INDEX', 0)
TOTAL = max(env_int('TOTAL', 1), 1)


def term_size():
    cols, rows = 80, 24
    try:
        c, r = os.get_terminal_size(1)
        cols, rows = c, r
    except OSError:
        c = os.environ.get('COLUMNS')
        r = os.environ.get('LINES')
        if c and r:
            try:
                cols, rows = int(c), int(r)
            except ValueError:
                pass
    cols = cols - 1
    if cols < 20:
        cols = 20
    if rows < 6:
        rows = 6
    return cols, rows


def clamp(v):
    v = int(v)
    if v < 0:
        return 0
    if v > 255:
        return 255
    return v


def color(r, g, b):
    return ESC + (b'[38;2;%d;%d;%dm' % (clamp(r), clamp(g), clamp(b)))


def bomb_pos(t, W, H):
    """抛物线:从左 pane 下方起飞,命中右 pane 中部偏右。"""
    p = min(t / IMPACT_T, 1.0)
    x0 = W * 0.12
    y0 = H * 0.72
    x1 = W * 0.82
    y1 = H * 0.52
    peak = H * 0.18
    x = x0 + (x1 - x0) * p
    # 抛物线高度偏移:4 * h * p * (1-p)
    y = y0 + (y1 - y0) * p - 4.0 * (y0 - peak) * p * (1.0 - p)
    return x, y


def add_dot(dots, x, y, col):
    """dots: dict[(gx,gy)] -> (r,g,b),后写入者覆盖。"""
    ix = int(round(x))
    iy = int(round(y))
    dots[(ix, iy)] = col


def add_disc(dots, cx, cy, r, col_func):
    rr = r * r
    y0 = int(cy - r - 1)
    y1 = int(cy + r + 1)
    x0 = int(cx - r - 1)
    x1 = int(cx + r + 1)
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            dx = x - cx
            dy = y - cy
            d2 = dx * dx + dy * dy
            if d2 <= rr:
                col = col_func(dx, dy, math.sqrt(d2))
                dots[(x, y)] = col


def add_fuse_spark(dots, x, y, intensity):
    r = 220 + int(35 * intensity)
    g = 100 + int(80 * intensity)
    b = 30
    dots[(int(round(x)), int(round(y)))] = (r, g, b)


LETTER_POINTS = {
    'B': [
        (0, 0), (0, 1), (0, 2), (0, 3), (0, 4),
        (1, 0), (1, 2), (1, 4),
        (2, 0), (2, 1), (2, 2), (2, 3), (2, 4),
    ],
    'O': [
        (0, 1), (0, 2), (0, 3),
        (1, 0), (1, 4),
        (2, 0), (2, 4),
        (3, 1), (3, 2), (3, 3),
    ],
    'M': [
        (0, 0), (0, 1), (0, 2), (0, 3), (0, 4),
        (1, 1), (2, 2), (3, 1),
        (4, 0), (4, 1), (4, 2), (4, 3), (4, 4),
    ],
}


def add_boom(dots, cx, cy, scale):
    word = 'BOOM'
    letter_w = 5
    letter_h = 5
    gap = 1
    total_w = len(word) * letter_w + (len(word) - 1) * gap
    start_x = cx - total_w * scale / 2.0
    start_y = cy - letter_h * scale / 2.0
    for li, ch in enumerate(word):
        if ch not in LETTER_POINTS:
            continue
        base_x = start_x + li * (letter_w + gap) * scale
        for (px, py) in LETTER_POINTS[ch]:
            gx = base_x + px * scale
            gy = start_y + py * scale
            # 每个点画成 2x2 粗点,避免细线条在 Braille 上太稀疏
            for dy in range(2):
                for dx in range(2):
                    add_dot(dots, gx + dx, gy + dy, (255, 200, 40))


PARTICLES = []
for _ in range(90):
    ang = random.random() * 2.0 * math.pi
    sp = 3.0 + random.random() * 7.0
    PARTICLES.append({
        'vx': math.cos(ang) * sp,
        'vy': math.sin(ang) * sp,
        'size': 1.0 + random.random() * 1.5,
    })


def build_frame(t, cols, rows):
    gcols = TOTAL * cols
    W = gcols * 2
    H = rows * 4
    x0 = INDEX * cols * 2

    dots = {}  # (gx,gy) -> (r,g,b)
    flash = 0.0

    if t < IMPACT_T:
        bx, by = bomb_pos(t, W, H)

        def body_col(dx, dy, d):
            shine = max(0.0, 1.0 - d / BOMB_R)
            v = 40 + int(60 * shine)
            return (v, v, v)

        add_disc(dots, bx, by, BOMB_R, body_col)

        # 引线棍子:从弹体顶部伸出,朝向左上方
        fuse_len = BOMB_R * 1.2
        steps = int(fuse_len * 2)
        for i in range(steps):
            tt = i / float(steps)
            fx = bx - 0.4 * BOMB_R - tt * fuse_len * 0.7
            fy = by - BOMB_R - tt * fuse_len * 0.7
            dots[(int(round(fx)), int(round(fy)))] = (180, 120, 60)

        # 引线火花 + 拖尾
        spark_x = bx - 0.4 * BOMB_R - fuse_len * 0.7
        spark_y = by - BOMB_R - fuse_len * 0.7
        trail_len = 22
        for i in range(trail_len):
            tt = i / float(trail_len)
            tx = spark_x - (spark_x - W * 0.04) * tt * 0.45
            ty = spark_y - (spark_y - H * 0.85) * tt * 0.45
            intensity = 1.0 - tt
            # 火花核更亮、更大
            for dy in range(-1, 2):
                for dx in range(-1, 2):
                    r = 255
                    g = int(80 + 160 * intensity)
                    b = int(20 + 80 * intensity)
                    dots[(int(round(tx)) + dx, int(round(ty)) + dy)] = (r, g, b)
    else:
        et = t - IMPACT_T
        impact_x = W * 0.82
        impact_y = H * 0.52

        # 爆闪只在前 0.3s
        flash = max(0.0, 1.0 - et / 0.3)

        if et < EXPLOSION_T:
            # 粒子
            for p in PARTICLES:
                life = max(0.0, 1.0 - et / EXPLOSION_T)
                if life <= 0.05:
                    continue
                px = impact_x + p['vx'] * et
                py = impact_y + p['vy'] * et - 3.0 * et * et  # 重力下坠
                size = p['size'] * (0.6 + 0.4 * life)
                rr = size * size
                by0 = int(py - size - 1)
                by1 = int(py + size + 1)
                bx0 = int(px - size - 1)
                bx1 = int(px + size + 1)
                for y in range(by0, by1 + 1):
                    for x in range(bx0, bx1 + 1):
                        dx = x - px
                        dy = y - py
                        if dx * dx + dy * dy <= rr:
                            r = 255
                            g = int(40 + 200 * life)
                            b = int(20 + 80 * life)
                            dots[(x, y)] = (r, g, b)

            # BOOM 文字缩放出现(限制在右 pane 内)
            if et < 1.4:
                s = 2.0 + 1.5 * (et / 1.4)
                add_boom(dots, impact_x, impact_y, s)

    # 切片输出
    out_cells = []
    out_colors = []
    for row in range(rows):
        cells = []
        colors = []
        for col in range(cols):
            gx = x0 + col * 2
            gy = row * 4
            mask = 0
            cr = cg = cb = 0
            for dy in range(4):
                for dx in range(2):
                    key = (gx + dx, gy + dy)
                    if key in dots:
                        mask |= DOT[dy][dx]
                        cr, cg, cb = dots[key]
            cells.append(chr(0x2800 + mask))
            colors.append((cr, cg, cb))
        out_cells.append(cells)
        out_colors.append(colors)
    return out_cells, out_colors, flash


def write(b):
    sys.stdout.buffer.write(b)
    sys.stdout.buffer.flush()


def wait_for_trigger():
    print(READY_MARKER)
    sys.stdout.flush()
    write(HOME + CLEAR)
    ready, _, _ = select.select([sys.stdin], [], [], TRIGGER_TIMEOUT)
    if ready:
        sys.stdin.buffer.read(1)


def render_to_bytes(cells, colors, flash):
    # 爆闪只作用在目标 pane(pane1),避免左侧源 pane 也被照亮得像在爆炸
    effective_flash = flash if INDEX == 1 else 0.0
    buf = bytearray(HOME)
    last = None
    for ri, row in enumerate(cells):
        for ci, ch in enumerate(row):
            r, g, b = colors[ri][ci]
            # 盲文空白(U+2800)与 ASCII 空格都视为空 cell
            is_empty = (ch == ' ' or ch == '⠀')
            if effective_flash > 0.05:
                # 爆闪时整体提亮
                r = clamp(r + int(255 * effective_flash))
                g = clamp(g + int(220 * effective_flash))
                b = clamp(b + int(120 * effective_flash))
            if is_empty:
                if effective_flash > 0.05:
                    # 空 cell 也带爆闪颜色
                    key = (r, g, b)
                    if key != last:
                        buf += color(r, g, b)
                        last = key
                    buf += ' '.encode('utf-8')
                else:
                    buf += b' '
            else:
                key = (r, g, b)
                if key != last:
                    buf += color(r, g, b)
                    last = key
                buf += ch.encode('utf-8')
        if ri < len(cells) - 1:
            buf += NL
    return bytes(buf)


def main():
    write(ENTER_ALT + HIDE + CLEAR)
    wait_for_trigger()
    t0 = time.time()
    try:
        frame = 0
        while True:
            t = time.time() - t0
            if t > DURATION:
                break
            cols, rows = term_size()
            cells, colors, flash = build_frame(t, cols, rows)
            write(render_to_bytes(cells, colors, flash) + RESET)
            frame += 1
            target = t0 + frame / float(FPS)
            dt = target - time.time()
            if dt > 0:
                time.sleep(dt)
    except (KeyboardInterrupt, BrokenPipeError, OSError):
        pass
    finally:
        try:
            write(SHOW + LEAVE_ALT + CLEAR)
        except (BrokenPipeError, OSError):
            pass


if __name__ == '__main__':
    main()
