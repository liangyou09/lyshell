#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""braille-wall: 跨终端 3D 线框立方体 demo,stage-and-release 同步(远程 SSH 会话版)。

N 个终端并排,各自渲染一个旋转线框立方体在全局盲文画布上的一片竖切片。
- 切片:本终端画全局列 [INDEX*cols .. (INDEX+1)*cols],全局宽 = TOTAL*cols(假设各终端等宽)。
- 无延时同步:插件先把同一脚本发到各会话,python 打印 READY 后阻塞读 stdin;等所有
  READY 到齐,插件同时向所有会话发一个触发字节,各 python 收到后立刻开跑。
  不依赖 NTP/时钟,跨机也同步(误差只剩触发字节到达的几十 ms)。
- 零反斜杠:ESC/换行用 bytes([N]) 拼,send_input 转义处理器对命令本体 no-op。
  脚本经 base64 嵌在 python3 -c 里传 stdin,远程不落盘。INDEX/TOTAL 由插件经 env 注入。
"""

import sys
import os
import time
import math
import select

ESC = bytes([27])
NL = bytes([10])
HOME = ESC + b'[H'
CLEAR = ESC + b'[2J' + HOME
ENTER_ALT = ESC + b'[?1049h'
LEAVE_ALT = ESC + b'[?1049l'
HIDE = ESC + b'[?25l'
SHOW = ESC + b'[?25h'

READY_MARKER = 'LYSHELL_WALL_READY'
TRIGGER_TIMEOUT = 30.0
DURATION = 12.0
FPS = 20

DOT = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
]

VERTICES = [
    (-1.0, -1.0, -1.0), (1.0, -1.0, -1.0), (1.0, 1.0, -1.0), (-1.0, 1.0, -1.0),
    (-1.0, -1.0, 1.0), (1.0, -1.0, 1.0), (1.0, 1.0, 1.0), (-1.0, 1.0, 1.0)
]

EDGES = [
    (0, 1), (1, 2), (2, 3), (3, 0),
    (4, 5), (5, 6), (6, 7), (7, 4),
    (0, 4), (1, 5), (2, 6), (3, 7)
]


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


def rotate(x, y, z, ax, ay, az):
    y1 = y * math.cos(ax) - z * math.sin(ax)
    z1 = y * math.sin(ax) + z * math.cos(ax)
    x2 = x * math.cos(ay) + z1 * math.sin(ay)
    z2 = -x * math.sin(ay) + z1 * math.cos(ay)
    x3 = x2 * math.cos(az) - y1 * math.sin(az)
    y3 = x2 * math.sin(az) + y1 * math.cos(az)
    return x3, y3, z2


def project(x, y, z, center_x, center_y, scale):
    d = z + 4.0
    if d < 0.5:
        d = 0.5
    return x * scale / d + center_x, y * scale / d + center_y


def draw_line(x0, y0, x1, y1, dots):
    x0 = int(round(x0))
    y0 = int(round(y0))
    x1 = int(round(x1))
    y1 = int(round(y1))
    dx = abs(x1 - x0)
    dy = abs(y1 - y0)
    sx = 1
    if x0 > x1:
        sx = -1
    sy = 1
    if y0 > y1:
        sy = -1
    err = dx - dy
    while True:
        dots.add((x0, y0))
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err = err - dy
            x0 = x0 + sx
        if e2 < dx:
            err = err + dx
            y0 = y0 + sy


def build_frame(t, cols, rows):
    gcols = TOTAL * cols
    W = gcols * 2
    H = rows * 4
    center_x = W / 2.0 + W * 0.4 * math.sin(t * 0.5)
    center_y = H / 2.0 + H * 0.1 * math.sin(t * 0.3)
    scale = H * 0.35

    ax = t * 0.5
    ay = t * 0.8
    az = t * 0.3

    dots = set()
    for edge in EDGES:
        i0, i1 = edge
        x0, y0, z0 = VERTICES[i0]
        x1, y1, z1 = VERTICES[i1]
        x0, y0, z0 = rotate(x0, y0, z0, ax, ay, az)
        x1, y1, z1 = rotate(x1, y1, z1, ax, ay, az)
        sx0, sy0 = project(x0, y0, z0, center_x, center_y, scale)
        sx1, sy1 = project(x1, y1, z1, center_x, center_y, scale)
        draw_line(sx0, sy0, sx1, sy1, dots)

    out = []
    x0 = INDEX * cols * 2
    for row in range(rows):
        cells = []
        for col in range(cols):
            gx = x0 + col * 2
            gy = row * 4
            mask = 0
            for dy in range(4):
                for dx in range(2):
                    if (gx + dx, gy + dy) in dots:
                        mask = mask | DOT[dy][dx]
            cells.append(chr(0x2800 + mask))
        out.append(''.join(cells))
    return out


def write(b):
    sys.stdout.buffer.write(b)
    sys.stdout.buffer.flush()


def wait_for_trigger():
    # 在 alt 屏上打印 READY,插件 read_output 能捕获;立即清掉,用户几乎看不到。
    print(READY_MARKER)
    sys.stdout.flush()
    write(HOME + CLEAR)
    ready, _, _ = select.select([sys.stdin], [], [], TRIGGER_TIMEOUT)
    if ready:
        sys.stdin.buffer.read(1)


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
            rows_out = build_frame(t, cols, rows)
            buf = bytearray(HOME)
            for i, r in enumerate(rows_out):
                buf += r.encode('utf-8')
                if i < len(rows_out) - 1:
                    buf += NL
            write(bytes(buf))
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
