#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""braille-rhythm: 跨终端音律跳动 demo, stage-and-release 同步(远程 SSH 会话版)。

N 个终端并排,各自渲染全局"节奏大师/音游"轨道的一片竖切片。
- 切片: 本终端画全局列 [INDEX*cols .. (INDEX+1)*cols], 全局宽 = TOTAL*cols(假设各终端等宽)。
- 无延时同步: 插件先把同一脚本发到各会话, python 打印 READY 后阻塞读 stdin;
  等所有 READY 到齐, 插件同时向所有会话发一个触发字节, 各 python 收到后立刻开跑。
  不依赖 NTP/时钟, 跨机也同步(误差只剩触发字节到达的几十 ms)。
- 画面(无颜色版): 双 pane 时 COMBO/数字、PERF/ECT 跨屏联动显示; 下落音符改成带高光
  的立体球体(kick 大球、snare 中球、hi-hat 小球), 看起来更像 3D 音游音符。
- 零反斜杠: ESC/换行/光标定位用 bytes([N]) 拼, send_input 转义处理器对命令本体 no-op。
  脚本经 base64 嵌在 python3 -c 里传 stdin, 远程不落盘。INDEX/TOTAL 由插件经 env 注入。
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

READY_MARKER = 'LYSHELL_RHYTHM_READY'
TRIGGER_TIMEOUT = 30.0
DURATION = 16.0
FPS = 15
BPM = 100

DOT = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
]

# 大字字体: 7 行 x 5 列点阵, 每个字符占 3x2 盲文单元(实际 6x8 点)
FONT = {
    'C': [
        '01110',
        '10001',
        '10000',
        '10000',
        '10000',
        '10001',
        '01110',
    ],
    'O': [
        '01110',
        '10001',
        '10001',
        '10001',
        '10001',
        '10001',
        '01110',
    ],
    'M': [
        '10001',
        '11011',
        '10101',
        '10001',
        '10001',
        '10001',
        '10001',
    ],
    'B': [
        '11110',
        '10001',
        '10001',
        '11110',
        '10001',
        '10001',
        '11110',
    ],
    'P': [
        '11110',
        '10001',
        '10001',
        '11110',
        '10000',
        '10000',
        '10000',
    ],
    'E': [
        '11111',
        '10000',
        '10000',
        '11110',
        '10000',
        '10000',
        '11111',
    ],
    'R': [
        '11110',
        '10001',
        '10001',
        '11110',
        '10010',
        '10001',
        '10001',
    ],
    'F': [
        '11111',
        '10000',
        '10000',
        '11110',
        '10000',
        '10000',
        '10000',
    ],
    'T': [
        '11111',
        '00100',
        '00100',
        '00100',
        '00100',
        '00100',
        '00100',
    ],
    '0': [
        '01110',
        '10001',
        '10011',
        '10101',
        '11001',
        '10001',
        '01110',
    ],
    '1': [
        '00100',
        '01100',
        '00100',
        '00100',
        '00100',
        '00100',
        '01110',
    ],
    '2': [
        '01110',
        '10001',
        '00001',
        '00010',
        '00100',
        '01000',
        '11111',
    ],
    '3': [
        '11110',
        '00001',
        '00010',
        '00110',
        '00001',
        '00001',
        '11110',
    ],
    '4': [
        '10001',
        '10001',
        '10001',
        '11111',
        '00001',
        '00001',
        '00001',
    ],
    '5': [
        '11111',
        '10000',
        '11110',
        '00001',
        '00001',
        '10001',
        '01110',
    ],
    '6': [
        '01110',
        '10001',
        '10000',
        '11110',
        '10001',
        '10001',
        '01110',
    ],
    '7': [
        '11111',
        '00001',
        '00010',
        '00100',
        '01000',
        '01000',
        '01000',
    ],
    '8': [
        '01110',
        '10001',
        '10001',
        '01110',
        '10001',
        '10001',
        '01110',
    ],
    '9': [
        '01110',
        '10001',
        '10001',
        '01111',
        '00001',
        '10001',
        '01110',
    ],
    ' ': [
        '00000',
        '00000',
        '00000',
        '00000',
        '00000',
        '00000',
        '00000',
    ],
}

CHAR_W = 5
CHAR_CELL_W = 7
CHAR_H = 7
MIN_LANES = 4
MAX_LANES = 10
FLASH_DURATION = 0.30
PERFECT_DURATION = 0.20
FIXED_DIGITS = 3


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


def clamp(v, lo, hi):
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def lane_count(W):
    return clamp(W // 20, MIN_LANES, MAX_LANES)


def pattern_for_i(i, L):
    """返回第 i 个八分音符对应的(乐器, 轨道, 球体半径)。"""
    step = i % 8
    if step == 0:
        return 'kick', clamp(int(L * 0.125), 0, L - 1), 4
    if step == 2:
        return 'kick', clamp(int(L * 0.375), 0, L - 1), 4
    if step == 4:
        return 'snare', clamp(int(L * 0.625), 0, L - 1), 3
    if step == 6:
        return 'snare', clamp(int(L * 0.875), 0, L - 1), 3
    return 'hat', clamp((3 + i) % L, 0, L - 1), 2


def text_width(text):
    return len(text) * CHAR_CELL_W - 2


def draw_text(text, center_x, top_y, dots, W, erase=False):
    """用盲文点阵大字把 text 画到 dots 里; erase=True 时把对应点挖掉(镂空效果)。"""
    start_x = int(round(center_x - text_width(text) / 2.0))
    for ci, ch in enumerate(text):
        bitmap = FONT.get(ch, FONT[' '])
        bx = start_x + ci * CHAR_CELL_W
        for row, line in enumerate(bitmap):
            for col, pixel in enumerate(line):
                if pixel == '1':
                    x = bx + col
                    y = top_y + row
                    if 0 <= x < W and y >= 0:
                        if erase:
                            dots.discard((x, y))
                        else:
                            dots.add((x, y))


def draw_sphere(cx, cy, r, W, dots):
    """画一个带高光的实心球体, 高光用挖掉点的方式实现。"""
    r2 = r * r + r
    for dx in range(-r, r + 1):
        for dy in range(-r, r + 1):
            if dx * dx + dy * dy <= r2:
                x = cx + dx
                y = cy + dy
                if 0 <= x < W and y >= 0:
                    dots.add((x, y))
    # 左上高光
    hr = max(1, r // 3)
    hx = cx - r // 3
    hy = cy - r // 3
    for dx in range(-hr, hr + 1):
        for dy in range(-hr, hr + 1):
            if dx * dx + dy * dy <= hr * hr:
                x = hx + dx
                y = hy + dy
                if 0 <= x < W and y >= 0:
                    dots.discard((x, y))


def add_hit_flash(lane, lane_width, age, judge_y, W, dots):
    """轨道底部实心光块。"""
    if age < 0 or age > FLASH_DURATION:
        return
    x0 = lane * lane_width
    x1 = min(W - 1, x0 + lane_width - 1)
    max_h = int(round((FLASH_DURATION - age) / FLASH_DURATION * 7)) + 2
    y_top = max(0, judge_y - max_h)
    for x in range(x0, x1 + 1):
        for y in range(y_top, judge_y + 2):
            dots.add((x, y))


def add_explosion(cx, cy, age, W, dots):
    """向上扩散的菱形光环。"""
    if age < 0 or age > 0.25:
        return
    r = int(round(age * 35)) + 1
    cy = cy - 2
    for dx in range(-r, r + 1):
        dy = r - abs(dx)
        for sx, sy in ((dx, dy), (dx, -dy)):
            x = cx + sx
            y = cy + sy
            if 0 <= x < W and 0 <= y < cy + 2:
                dots.add((x, y))


def draw_split_text(dots, W, H, combo, show_perfect):
    """双 pane 时把 COMBO/数字、PERFECT 拆到左右屏。"""
    pane_w = W // TOTAL
    pane_x0 = INDEX * pane_w
    pane_x1 = pane_x0 + pane_w - 1
    cy = H // 2
    pad = 4
    card_h = CHAR_H + 4

    left_half_w = max(text_width('COMBO'), text_width('PERF')) + pad
    right_half_w = max(text_width('0' * FIXED_DIGITS), text_width('ECT')) + pad

    # 第一行: 左屏 COMBO, 右屏 数字
    y1 = cy - 8
    if INDEX == 0:
        x0 = pane_x1 - left_half_w
        for x in range(x0, pane_x1 + 1):
            for y in range(y1 - 2, y1 + card_h - 2):
                dots.add((x, y))
        cx = pane_x1 - text_width('COMBO') // 2 - 2
        draw_text('COMBO', cx, y1, dots, W, erase=True)
    else:
        x1 = pane_x0 + right_half_w
        for x in range(pane_x0, x1 + 1):
            for y in range(y1 - 2, y1 + card_h - 2):
                dots.add((x, y))
        num = str(combo).rjust(FIXED_DIGITS, '0')
        cx = pane_x0 + text_width(num) // 2 + 2
        draw_text(num, cx, y1, dots, W, erase=True)

    # 第二行: 左屏 PERF, 右屏 ECT
    if show_perfect:
        y2 = cy + 4
        if INDEX == 0:
            x0 = pane_x1 - left_half_w
            for x in range(x0, pane_x1 + 1):
                for y in range(y2 - 2, y2 + card_h - 2):
                    dots.add((x, y))
            cx = pane_x1 - text_width('PERF') // 2 - 2
            draw_text('PERF', cx, y2, dots, W, erase=True)
        else:
            x1 = pane_x0 + right_half_w
            for x in range(pane_x0, x1 + 1):
                for y in range(y2 - 2, y2 + card_h - 2):
                    dots.add((x, y))
            cx = pane_x0 + text_width('ECT') // 2 + 2
            draw_text('ECT', cx, y2, dots, W, erase=True)


def draw_center_card(dots, W, H, combo, show_perfect):
    """非双 pane 时, 每个 pane 单独显示完整信息牌。"""
    pane_w = W // TOTAL
    pane_x0 = INDEX * pane_w
    pane_center = pane_x0 + pane_w // 2

    max_label_w = max(text_width('PERFECT'), text_width('COMBO'))
    max_num_w = text_width('0' * FIXED_DIGITS)
    card_w = max(max_label_w, max_num_w) + 10
    card_h = CHAR_H * 3 + 10
    card_w = min(card_w, pane_w - 4)
    card_h = min(card_h, H - 4)
    card_x0 = pane_center - card_w // 2
    card_y0 = (H - card_h) // 2

    for x in range(card_x0, card_x0 + card_w):
        for y in range(card_y0, card_y0 + card_h):
            if pane_x0 <= x < pane_x0 + pane_w:
                dots.add((x, y))

    draw_text('COMBO', pane_center, card_y0 + 2, dots, W, erase=True)
    draw_text(str(combo).rjust(FIXED_DIGITS, '0'), pane_center, card_y0 + CHAR_H + 4, dots, W, erase=True)
    if show_perfect:
        draw_text('PERFECT', pane_center, card_y0 + CHAR_H * 2 + 6, dots, W, erase=True)


def build_frame(t, cols, rows):
    gcols = TOTAL * cols
    W = gcols * 2
    H = rows * 4
    L = lane_count(W)
    lane_width = W // L

    eighth = 60.0 / BPM / 2.0
    judge_y = H - 3
    speed = max(judge_y / 1.6, 1.0)

    dots = set()
    combo = 0
    show_perfect = False

    # 判定线
    for x in range(W):
        dots.add((x, judge_y))
        dots.add((x, judge_y + 1))

    # 轨道分隔: 只在判定线附近显示
    for lane in range(L + 1):
        sep_x = lane * lane_width
        if sep_x >= W:
            continue
        for y in range(judge_y - 5, judge_y + 2):
            dots.add((sep_x, y))

    # 生成音符和点击特效
    lookahead = int(2.0 / eighth) + 4
    max_i = int(t / eighth) + lookahead
    for i in range(max_i):
        spawn_t = i * eighth
        if spawn_t > t + 2.0:
            continue
        fall = t - spawn_t
        if fall < 0:
            continue
        inst, lane, radius = pattern_for_i(i, L)
        cx = lane * lane_width + lane_width // 2
        hit_t = spawn_t + (judge_y + radius) / speed
        age = t - hit_t

        if age >= 0:
            combo += 1
            if 0 <= age < FLASH_DURATION:
                add_hit_flash(lane, lane_width, age, judge_y, W, dots)
                add_explosion(cx, judge_y, age, W, dots)
            if 0 <= age < PERFECT_DURATION:
                show_perfect = True

        # 绘制下落立体球体
        center_y = -radius + fall * speed
        top_y = center_y - radius
        bottom_y = center_y + radius
        if top_y > judge_y + 1:
            continue
        if bottom_y < 0:
            continue

        cy = int(round(center_y))
        # 只在可见范围内画球, 避免覆盖判定线下方
        if 0 <= cy <= judge_y + 1:
            draw_sphere(cx, cy, radius, W, dots)

    # 信息牌布局
    if TOTAL == 2:
        draw_split_text(dots, W, H, combo, show_perfect)
    else:
        draw_center_card(dots, W, H, combo, show_perfect)

    # 渲染盲文点阵
    out = []
    x0 = INDEX * cols * 2
    for row in range(rows):
        line = []
        for col in range(cols):
            gx = x0 + col * 2
            gy = row * 4
            mask = 0
            for dy in range(4):
                for dx in range(2):
                    if (gx + dx, gy + dy) in dots:
                        mask = mask | DOT[dy][dx]
            line.append(chr(0x2800 + mask))
        out.append(''.join(line))
    return out


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
