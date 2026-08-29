#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
braille-wave 渲染脚本（demo, 自适应终端尺寸）

由 braille-wave 插件经 shell heredoc 管进远程 python3 -u - 的 stdin 运行(脚本不落盘远程)。
独占终端:进备用屏 + 藏光标,用光标归位序列(ESC [ H)原地重绘盲文点阵帧,
约 DURATION 秒后还原终端退出。Ctrl+C(BrokenPipe)也走 finally 还原,不会留在备用屏。

每帧查 PTY 实际尺寸(os.get_terminal_size(1))填满终端,空间频率按 min(PW,PH)/88
反比缩放保持波纹密度一致;窗口拖动缩放逐帧跟上。cols-1 留一列防末列自动换行。

源码刻意不含任何反斜杠:ESC 与换行用 bytes([27]) / bytes([10]) 拼,send_input 的
转义处理器对本体是 no-op,heredoc 体逐字到远程。输出走 sys.stdout.buffer.write
(原始 UTF-8 字节),绕开 Windows cmd 代码页与 LANG=C 远程的文本层编码,盲文不被破坏。
"""
import sys
import os
import time
import math

ESC = bytes([27])
NL = bytes([10])
HOME = ESC + b'[H'
CLEAR = ESC + b'[2J' + HOME
ENTER_ALT = ESC + b'[?1049h'
LEAVE_ALT = ESC + b'[?1049l'
HIDE_CURSOR = ESC + b'[?25l'
SHOW_CURSOR = ESC + b'[?25h'

REF = 88.0          # 参考最小边,波纹密度缩放基准。
DURATION = 10.0
FPS = 20

# 盲文点掩码:Unicode U+2800 起 + 8 点位掩码。视觉布局 2 宽 × 4 高:
#   0x01 0x08   (dot1 dot4)
#   0x02 0x10   (dot2 dot5)
#   0x04 0x20   (dot3 dot6)
#   0x40 0x80   (dot7 dot8)
DOT = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
]


def term_size():
    """查 PTY 尺寸 -> (cols, rows)。fd1 非 tty(重定向)时退 COLUMNS/LINES env,再退 80x24。
    cols-1 留一列边距防末列自动换行;最小 20x6 防退化。"""
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


def build_frame(t, cols, rows, S):
    """计算一帧:返回每行盲文字符串列表。三路正弦叠加 plasma + 抖动阈值。
    空间频率按 1/S 缩放,保持波纹密度随尺寸一致。"""
    out = []
    cx0, cy0 = cols, rows * 2  # 波源中心(点坐标)
    fx = 0.25 / S
    fy = 0.22 / S
    fr = 0.12 / S
    for cy in range(rows):
        cells = []
        for cx in range(cols):
            mask = 0
            for dy in range(4):
                for dx in range(2):
                    gx = cx * 2 + dx
                    gy = cy * 4 + dy
                    v = (math.sin(fx * gx + t * 1.5)
                         + math.sin(fy * gy + t * 1.1)
                         + math.sin(fr * math.hypot(gx - cx0, gy - cy0) - t * 2.5))
                    bright = (v + 3.0) / 6.0  # [-3,3] -> [0,1]
                    thr = 0.42 + 0.18 * math.sin(t * 3.0 + gx * 0.3 + gy * 0.2)
                    if bright > thr:
                        mask |= DOT[dy][dx]
            cells.append(chr(0x2800 + mask))
        out.append(''.join(cells))
    return out


def write(b):
    sys.stdout.buffer.write(b)
    sys.stdout.buffer.flush()


def main():
    write(ENTER_ALT + HIDE_CURSOR + CLEAR)
    start = time.time()
    try:
        while True:
            t = time.time() - start
            if t > DURATION:
                break
            cols, rows = term_size()
            PW = cols * 2
            PH = rows * 4
            S = min(PW, PH) / REF
            rows_out = build_frame(t, cols, rows, S)
            buf = bytearray(HOME)
            for i, r in enumerate(rows_out):
                buf += r.encode('utf-8')
                if i < len(rows_out) - 1:
                    buf += NL
            write(bytes(buf))
            time.sleep(1.0 / FPS)
    except (KeyboardInterrupt, BrokenPipeError, OSError):
        # Ctrl+C / 终端被关:静默退出,交 finally 还原。
        pass
    finally:
        try:
            # 清主屏擦掉 heredoc 首行命令的回显;用 ANSI 不依赖 clear 二进制(嵌入式 busybox 常缺)
            write(SHOW_CURSOR + LEAVE_ALT + CLEAR)
        except (BrokenPipeError, OSError):
            pass


if __name__ == '__main__':
    main()
