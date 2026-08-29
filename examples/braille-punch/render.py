#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
braille-punch: 第一人称 3D 出拳效果(demo, 自适应终端尺寸)

POV 视角:摄像头在原点看向 -z。一只红色拳套 + 前臂悬在身前(收势位),按组合拳
节奏向观察者突刺--透视下越近越大,击中瞬间屏震 + 爆闪 + 粒子迸射,再收回。

每帧查 PTY 实际尺寸(os.get_terminal_size(1)),画面按 min(PW,PH)/88 缩放,
窗口拖动缩放逐帧跟上(无需 SIGWINCH)。cols-1 留一列防末列自动换行。

纯程序生成、零素材:拳套=球面点云,前臂=圆柱点云,法线 dot 光向算明暗,
真彩色每格上色 + 盲文 8 点。经 heredoc 投到远程 python3 stdin 跑。

源码刻意零反斜杠:ESC/换行用 bytes([27])/bytes([10]) 拼,真彩色转义用 bytes 的 %
格式化,send_input 的转义处理器对本体是 no-op,heredoc 体逐字到远程。
"""
import sys
import os
import time
import math
import random

ESC = bytes([27])
NL = bytes([10])
HOME = ESC + b'[H'
CLEAR = ESC + b'[2J' + HOME
ENTER_ALT = ESC + b'[?1049h'
LEAVE_ALT = ESC + b'[?1049l'
HIDE = ESC + b'[?25l'
SHOW = ESC + b'[?25h'

FOCAL = 140.0
REF = 88.0          # 参考最小边(PW,PH 的 min),缩放基准。88 对应原始 78x22 画布。
DURATION = 18.0
FPS = 20

# 盲文点掩码(2 宽 x 4 高)。
DOT = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
]

# 光向(指向光源),z>0 让正对摄像头的面被照亮。
_LX, _LY, _LZ = 0.35, 0.5, 0.78
_ln = math.sqrt(_LX * _LX + _LY * _LY + _LZ * _LZ)
LX, LY, LZ = _LX / _ln, _LY / _ln, _LZ / _ln

RG = 13.0           # 拳套半径


def fib_sphere(n):
    """fib 球面均匀采样 n 个单位球点。"""
    pts = []
    ga = math.pi * (3.0 - math.sqrt(5.0))
    for i in range(n):
        y = 1.0 - (i / float(n - 1)) * 2.0
        r = math.sqrt(max(0.0, 1.0 - y * y))
        th = ga * i
        pts.append((math.cos(th) * r, y, math.sin(th) * r))
    return pts


GLOVE = [(p[0] * RG, p[1] * RG, p[2] * RG) for p in fib_sphere(150)]

# 前臂点云:圆柱,从拳套沿 +z(向摄像头)延伸并收细;存径向法线用于明暗。
ARM = []
for s in range(6):
    tt = s / 5.0
    z = tt * 34.0
    rr = RG * (1.0 - 0.35 * tt)
    for k in range(12):
        a = (k / 12.0) * 2.0 * math.pi
        ARM.append((math.cos(a) * rr, math.sin(a) * rr, z, math.cos(a), math.sin(a)))


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


def clamp(v):
    v = int(v)
    if v < 0:
        return 0
    if v > 255:
        return 255
    return v


def shade_glove(nx, ny, nz):
    d = nx * LX + ny * LY + nz * LZ
    if d < 0.0:
        d = 0.0
    d = int(d * 5.0) / 5.0   # 量化 6 级
    return (90 + int(150 * d), 15 + int(35 * d), 15 + int(35 * d))


def shade_arm(nx, ny):
    d = nx * LX + ny * LY
    if d < 0.0:
        d = 0.0
    d = int(d * 5.0) / 5.0
    return (120 + int(90 * d), 85 + int(65 * d), 55 + int(45 * d))


def color(r, g, b):
    return ESC + (b'[38;2;%d;%d;%dm' % (clamp(r), clamp(g), clamp(b)))


CYCLE = 1.8   # 每拳周期(秒)


def smooth(a, b, t):
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    k = t * t * (3.0 - 2.0 * t)
    return a + (b - a) * k


def punch(thrust, kind):
    # thrust: -0.15(收) .. 1.0(全刺出)。kind: 0=直拳 1=左刺 2=右勾
    gz = -120.0
    sz = -48.0
    if kind == 1:
        sx, sy = -7.0, 0.0
    elif kind == 2:
        sx, sy, sz = 9.0, -2.0, -54.0
    else:
        sx, sy = 0.0, 0.0
    gx, gy = 0.0, 16.0
    fx = smooth(gx, sx, thrust)
    fy = smooth(gy, sy, thrust)
    fz = smooth(gz, sz, thrust)
    if thrust < 0.0:
        fz = gz + thrust * 16.0    # 收势微后拉
    return fx, fy, fz


def thrust_for(tp):
    c = tp / CYCLE
    if c < 0.12:
        return smooth(0.0, -0.15, c / 0.12)
    if c < 0.26:
        return smooth(-0.15, 1.0, (c - 0.12) / 0.14)
    if c < 0.34:
        return 1.0
    if c < 0.60:
        return smooth(1.0, 0.0, (c - 0.34) / 0.26)
    return 0.0


class State:
    def __init__(self):
        self.particles = []
        self.shake = 0.0
        self.flash = 0.0
        self.last_hold = False


def render_frame(t, st):
    """渲染一帧,返回 bytes(含 HOME 前缀)。每帧查终端尺寸自适应;更新 st 的粒子/震屏/爆闪。"""
    cols, rows = term_size()
    PW = cols * 2
    PH = rows * 4
    S = min(PW, PH) / REF
    focal = FOCAL * S

    tp = t % CYCLE
    kind = int(t / CYCLE) % 3
    thr = thrust_for(tp)
    in_hold = 0.26 <= (tp / CYCLE) < 0.34
    fx, fy, fz = punch(thr, kind)

    if in_hold and not st.last_hold:
        st.shake = 6.0
        st.flash = 1.0
        for _ in range(34):
            ang = random.random() * 2.0 * math.pi
            sp = 18.0 + random.random() * 40.0
            st.particles.append([fx, fy, fz, math.cos(ang) * sp, math.sin(ang) * sp,
                                 random.uniform(-6.0, 26.0), 1.0])
    st.last_hold = in_hold
    st.shake *= 0.82
    st.flash *= 0.86

    ox = (random.random() * 2.0 - 1.0) * st.shake * S
    oy = (random.random() * 2.0 - 1.0) * st.shake * S

    def proj(x, y, z):
        zz = z if z < -1.0 else -1.0
        s = focal / (-zz)
        return x * s + PW * 0.5 + ox, y * s + PH * 0.5 + oy

    mask = [[0] * cols for _ in range(rows)]
    cr = [[0] * cols for _ in range(rows)]
    cg = [[0] * cols for _ in range(rows)]
    cb = [[0] * cols for _ in range(rows)]

    pts = []
    for (px, py, pz) in GLOVE:
        r, g, b = shade_glove(px / RG, py / RG, pz / RG)
        pts.append((fz + pz, fx + px, fy + py, r, g, b))
    for (px, py, pz, nx, ny) in ARM:
        r, g, b = shade_arm(nx, ny)
        pts.append((fz + pz, fx + px, fy + py, r, g, b))
    alive = []
    for p in st.particles:
        p[0] += p[3] * 0.05
        p[1] += p[4] * 0.05
        p[2] += p[5] * 0.05
        p[6] *= 0.90
        if p[6] > 0.08:
            pts.append((p[2], p[0], p[1], 255, 200 + int(55 * p[6]), int(40 * p[6])))
            alive.append(p)
    st.particles = alive
    pts.sort(key=lambda q: q[0])

    for (wz, wx, wy, r, g, b) in pts:
        sx, sy = proj(wx, wy, wz)
        ix, iy = int(sx), int(sy)
        if 0 <= ix < PW and 0 <= iy < PH:
            cx, cy = ix // 2, iy // 4
            mask[cy][cx] |= DOT[iy % 4][ix % 2]
            cr[cy][cx], cg[cy][cx], cb[cy][cx] = r, g, b

    if st.flash > 0.05:
        fx2, fy2 = proj(fx, fy, fz)
        rad = (6.0 + 26.0 * (1.0 - st.flash)) * S
        for a in range(0, 360, 18):
            ar = a * math.pi / 180.0
            for rr in (rad * 0.4, rad * 0.75, rad):
                ix = int(fx2 + math.cos(ar) * rr)
                iy = int(fy2 + math.sin(ar) * rr * 0.7)
                if 0 <= ix < PW and 0 <= iy < PH:
                    cx, cy = ix // 2, iy // 4
                    mask[cy][cx] |= DOT[iy % 4][ix % 2]
                    br = clamp(255 * st.flash)
                    cr[cy][cx], cg[cy][cx], cb[cy][cx] = 255, br, 30

    buf = bytearray(HOME)
    last = None
    for row in range(rows):
        for col in range(cols):
            m = mask[row][col]
            if m == 0:
                buf += b' '
            else:
                key = (cr[row][col], cg[row][col], cb[row][col])
                if key != last:
                    buf += color(key[0], key[1], key[2])
                    last = key
                buf += chr(0x2800 + m).encode('utf-8')
        if row < rows - 1:
            buf += NL
    return bytes(buf)


def main():
    out = sys.stdout.buffer

    def write(b):
        out.write(b)
        out.flush()

    write(ENTER_ALT + HIDE + CLEAR)
    start = time.time()
    st = State()
    try:
        while True:
            t = time.time() - start
            if t > DURATION:
                break
            write(render_frame(t, st))
            time.sleep(1.0 / FPS)
    except (KeyboardInterrupt, BrokenPipeError, OSError):
        pass
    finally:
        try:
            # 清主屏擦掉 heredoc 首行命令的回显;用 ANSI 不依赖 clear 二进制(嵌入式 busybox 常缺)
            write(SHOW + LEAVE_ALT + CLEAR)
        except (BrokenPipeError, OSError):
            pass


if __name__ == '__main__':
    main()
