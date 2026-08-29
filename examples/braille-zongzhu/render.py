#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""braille-zongzhu: 终端 Braille 点阵「铁山靠」/「打篮球」动画 demo。

随 main.js 经 heredoc 投到远程 python3 stdin 运行,远程不落盘。
源码刻意零反斜杠:ESC/换行用 bytes([N]) 拼,send_input 的转义处理器对本体是 no-op。
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
HIDE = ESC + b'[?25l'
SHOW = ESC + b'[?25h'

DURATION = 12.0
BASKETBALL_PERIOD = 9.5
FPS = 15

# 盲文点掩码(2 宽 x 4 高)。
DOT = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
]


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


def draw_line(x0, y0, x1, y1, dots, thick=1.0):
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
        if thick <= 1.0:
            dots.add((x0, y0))
        else:
            r = int(math.ceil((thick - 1.0) / 2.0))
            for yy in range(y0 - r, y0 + r + 1):
                for xx in range(x0 - r, x0 + r + 1):
                    dots.add((xx, yy))
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err = err - dy
            x0 = x0 + sx
        if e2 < dx:
            err = err + dx
            y0 = y0 + sy


def circle(cx, cy, r, dots, fill=False):
    cx = int(round(cx))
    cy = int(round(cy))
    rr = int(math.ceil(r))
    for y in range(cy - rr, cy + rr + 1):
        for x in range(cx - rr, cx + rr + 1):
            d = math.hypot(x - cx, y - cy)
            if fill:
                if d <= r:
                    dots.add((x, y))
            else:
                if abs(d - r) < 0.6:
                    dots.add((x, y))


def smooth(a, b, t):
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    k = t * t * (3.0 - 2.0 * t)
    return a + (b - a) * k


def stick_figure(cx, cy, scale, dots, lean=0.0, bend=0.0, arm_left=0.0, arm_right=0.0,
                 leg_left=0.0, leg_right=0.0, head_offset=(0, 0),
                 draw_left_arm=True, draw_right_arm=True):
    """画一个简笔人物。lean 让身体整体侧倾,bend 让身体向前弯腰(弧度),
    arm_* 控制手臂摆动角度(-1..1),leg_* 控制腿部分开/弯曲,
    head_offset 微调头部位置。
    draw_left_arm/draw_right_arm 为 False 时可由调用方自己绘制更精细的手臂。"""
    # 臀部中心
    hip_y = cy + scale * 6
    hip_cx = cx - lean * scale * 2
    shoulder_w = scale * 9
    hip_w = scale * 5

    # 躯干长度
    torso_len = scale * 18
    neck_len = scale * 6

    # 肩膀位置:相对臀部向上 torso_len,再按 bend 旋转
    shoulder_dx = math.sin(bend) * torso_len
    shoulder_dy = -(math.cos(bend) - 1.0) * torso_len
    shoulder_cx = hip_cx + lean * scale * 12 + shoulder_dx
    shoulder_y = hip_y - torso_len + shoulder_dy

    # 头部位置:相对肩膀向上 neck_len,再按 bend 旋转
    head_dx = math.sin(bend) * neck_len
    head_dy = -(math.cos(bend) - 1.0) * neck_len
    hx = shoulder_cx + head_offset[0] * scale + head_dx
    hy = shoulder_y - neck_len + head_offset[1] * scale + head_dy

    # 头
    circle(hx, hy, scale * 5, dots, fill=True)

    # 脖子
    neck_top_y = hy + scale * 5
    neck_bottom_y = shoulder_y
    draw_line(hx, neck_top_y, hx + lean * scale * 2, neck_bottom_y, dots, thick=1.5)

    # 躯干(梯形)
    draw_line(shoulder_cx - shoulder_w, shoulder_y,
              hip_cx - hip_w, hip_y, dots, thick=2.0)
    draw_line(shoulder_cx + shoulder_w, shoulder_y,
              hip_cx + hip_w, hip_y, dots, thick=2.0)
    # 躯干中线
    draw_line(shoulder_cx, shoulder_y, hip_cx, hip_y, dots, thick=1.0)

    if draw_left_arm:
        # 左臂
        la_shoulder_x = shoulder_cx - shoulder_w
        la_shoulder_y = shoulder_y
        la_elbow_x = la_shoulder_x - scale * 8 - arm_left * scale * 6
        la_elbow_y = la_shoulder_y + scale * 8 + abs(arm_left) * scale * 3
        la_hand_x = la_elbow_x - scale * 4 - arm_left * scale * 10
        la_hand_y = la_elbow_y + scale * 8
        draw_line(la_shoulder_x, la_shoulder_y, la_elbow_x, la_elbow_y, dots, thick=2.0)
        draw_line(la_elbow_x, la_elbow_y, la_hand_x, la_hand_y, dots, thick=2.0)

    if draw_right_arm:
        # 右臂
        ra_shoulder_x = shoulder_cx + shoulder_w
        ra_shoulder_y = shoulder_y
        ra_elbow_x = ra_shoulder_x + scale * 8 + arm_right * scale * 6
        ra_elbow_y = ra_shoulder_y + scale * 8 + abs(arm_right) * scale * 3
        ra_hand_x = ra_elbow_x + scale * 4 + arm_right * scale * 10
        ra_hand_y = ra_elbow_y + scale * 8
        draw_line(ra_shoulder_x, ra_shoulder_y, ra_elbow_x, ra_elbow_y, dots, thick=2.0)
        draw_line(ra_elbow_x, ra_elbow_y, ra_hand_x, ra_hand_y, dots, thick=2.0)

    # 左腿
    ll_hip_x = hip_cx - hip_w
    ll_hip_y = hip_y
    ll_knee_x = ll_hip_x - scale * 4 - leg_left * scale * 3
    # leg_left < 0 时膝盖降低,形成真正弯曲
    ll_knee_y = ll_hip_y + scale * 10 + abs(leg_left) * scale * 10
    ll_foot_x = ll_knee_x - scale * 2 + leg_left * scale * 2
    # 脚固定在地面上,不随膝盖降低而下降
    ll_foot_y = hip_y + scale * 22
    draw_line(ll_hip_x, ll_hip_y, ll_knee_x, ll_knee_y, dots, thick=2.5)
    draw_line(ll_knee_x, ll_knee_y, ll_foot_x, ll_foot_y, dots, thick=2.5)

    # 右腿
    rl_hip_x = hip_cx + hip_w
    rl_hip_y = hip_y
    rl_knee_x = rl_hip_x + scale * 4 + leg_right * scale * 3
    rl_knee_y = rl_hip_y + scale * 10 + abs(leg_right) * scale * 10
    rl_foot_x = rl_knee_x + scale * 2 - leg_right * scale * 2
    rl_foot_y = hip_y + scale * 22
    draw_line(rl_hip_x, rl_hip_y, rl_knee_x, rl_knee_y, dots, thick=2.5)
    draw_line(rl_knee_x, rl_knee_y, rl_foot_x, rl_foot_y, dots, thick=2.5)


def render_tieshankao(cols, rows, t):
    """铁山靠:侧身顶肩,重心左右切换。"""
    W = cols * 2
    H = rows * 4
    cx = W * 0.5
    cy = H * 0.45
    scale = min(W, H) / 72.0

    dots = set()

    # 节奏放慢:约 2 秒一个来回,顶肩更稳
    raw = math.sin(t * 1.5)
    # 非线性让两端(顶肩位)停留稍久
    phase = math.copysign(abs(raw) ** 0.7, raw)
    lean = phase * 0.22
    side = 1 if phase > 0 else -1

    # 头部随身体小幅移动
    head_off = (side * 0.08, abs(phase) * 0.04)

    # 腿:顶肩对侧腿微弯支撑,顶肩侧腿蹬直
    if side == 1:
        leg_left = -0.25
        leg_right = 0.0
    else:
        leg_left = 0.0
        leg_right = -0.25

    # 身体重心横向移动减半,脚更稳
    cx_stable = cx - lean * scale * 4

    # 不画手臂,自己绘制铁山靠特有的手臂姿势
    stick_figure(cx_stable, cy, scale, dots, lean=lean,
                 arm_left=0.0, arm_right=0.0,
                 leg_left=leg_left, leg_right=leg_right,
                 head_offset=head_off,
                 draw_left_arm=False, draw_right_arm=False)

    # 计算肩膀位置(与 stick_figure 内部一致)
    hip_cx = cx_stable - lean * scale * 2
    hip_y = cy + scale * 6
    shoulder_cx = hip_cx + lean * scale * 12
    shoulder_y = hip_y - scale * 18
    shoulder_w = scale * 9

    if side == 1:
        # 向右靠:右臂垂直,前臂内弯;左臂弯曲握住右手
        r_shoulder_x = shoulder_cx + shoulder_w
        r_shoulder_y = shoulder_y
        r_elbow_x = r_shoulder_x
        r_elbow_y = r_shoulder_y + scale * 10
        r_hand_x = r_elbow_x - scale * 6
        r_hand_y = r_elbow_y - scale * 2
        draw_line(r_shoulder_x, r_shoulder_y, r_elbow_x, r_elbow_y, dots, thick=2.5)
        draw_line(r_elbow_x, r_elbow_y, r_hand_x, r_hand_y, dots, thick=2.5)

        l_shoulder_x = shoulder_cx - shoulder_w
        l_shoulder_y = shoulder_y
        l_elbow_x = l_shoulder_x + scale * 8
        l_elbow_y = l_shoulder_y + scale * 6
        l_hand_x = r_hand_x
        l_hand_y = r_hand_y
        draw_line(l_shoulder_x, l_shoulder_y, l_elbow_x, l_elbow_y, dots, thick=2.5)
        draw_line(l_elbow_x, l_elbow_y, l_hand_x, l_hand_y, dots, thick=2.5)
    else:
        # 向左靠:左臂垂直,前臂内弯;右臂弯曲握住左手
        l_shoulder_x = shoulder_cx - shoulder_w
        l_shoulder_y = shoulder_y
        l_elbow_x = l_shoulder_x
        l_elbow_y = l_shoulder_y + scale * 10
        l_hand_x = l_elbow_x + scale * 6
        l_hand_y = l_elbow_y - scale * 2
        draw_line(l_shoulder_x, l_shoulder_y, l_elbow_x, l_elbow_y, dots, thick=2.5)
        draw_line(l_elbow_x, l_elbow_y, l_hand_x, l_hand_y, dots, thick=2.5)

        r_shoulder_x = shoulder_cx + shoulder_w
        r_shoulder_y = shoulder_y
        r_elbow_x = r_shoulder_x - scale * 8
        r_elbow_y = r_shoulder_y + scale * 6
        r_hand_x = l_hand_x
        r_hand_y = l_hand_y
        draw_line(r_shoulder_x, r_shoulder_y, r_elbow_x, r_elbow_y, dots, thick=2.5)
        draw_line(r_elbow_x, r_elbow_y, r_hand_x, r_hand_y, dots, thick=2.5)

    # 顶肩方向加几道气势线
    impact = abs(phase)
    if impact > 0.5:
        base_x = cx + side * scale * 26
        base_y = cy - scale * 8
        for i in range(3):
            ox = side * (4 + i * 5) * scale * impact
            oy = (i - 1) * scale * 5
            draw_line(base_x, base_y + oy,
                      base_x + ox * 0.6, base_y + oy + (i - 1) * scale * 3, dots, thick=1.0)

    return dots


def render_basketball(cols, rows, t):
    """打篮球:胯下运球 -> 丢球 -> 铁山靠,播完一次即停。"""
    W = cols * 2
    H = rows * 4
    cx = W * 0.5
    cy = H * 0.55
    scale = min(W, H) / 72.0

    dots = set()
    p = t % BASKETBALL_PERIOD

    if p < 6.0:
        # 阶段1: 弯腰胯下运球 6 次
        sub = p % 1.0
        direction = 1 if int(p) % 2 == 0 else -1
        body_dy = scale * 3
        knee_bend = 0.9
        bend = 0.55

        stick_figure(cx, cy + body_dy, scale, dots, lean=0.0, bend=bend,
                     arm_left=0.0, arm_right=0.0,
                     leg_left=-knee_bend, leg_right=-knee_bend,
                     head_offset=(0, 0),
                     draw_left_arm=False, draw_right_arm=False)

        # 计算弯腰后的肩膀位置(与 stick_figure 内部一致)
        hip_cx = cx
        hip_y = cy + body_dy + scale * 6
        torso_len = scale * 18
        shoulder_dx = math.sin(bend) * torso_len
        shoulder_dy = -(math.cos(bend) - 1.0) * torso_len
        shoulder_cx = hip_cx + shoulder_dx
        shoulder_y = hip_y - torso_len + shoulder_dy

        # 球沿弧形轨迹穿过身体前方胯下:手的高位 -> 接近地面的低位 -> 手的高位
        if direction == 1:
            start_x = shoulder_cx + scale * 16
            start_y = shoulder_y + scale * 2
            end_x = shoulder_cx - scale * 16
            end_y = shoulder_y + scale * 2
        else:
            start_x = shoulder_cx - scale * 16
            start_y = shoulder_y + scale * 2
            end_x = shoulder_cx + scale * 16
            end_y = shoulder_y + scale * 2

        u = sub
        mid_x = shoulder_cx + scale * 4
        mid_y = hip_y + scale * 18
        ball_x = (1 - u) * (1 - u) * start_x + 2 * (1 - u) * u * mid_x + u * u * end_x
        ball_y = (1 - u) * (1 - u) * start_y + 2 * (1 - u) * u * mid_y + u * u * end_y

        circle(ball_x, ball_y, scale * 4.5, dots, fill=True)

        # 双手在身体前方下垂,只在送球/接球时小幅下压,不黏球
        r_hand_ref_x = shoulder_cx + scale * 16
        r_hand_ref_y = shoulder_y + scale * 2
        l_hand_ref_x = shoulder_cx - scale * 16
        l_hand_ref_y = shoulder_y + scale * 2

        if direction == 1:
            if u < 0.5:
                r_reach = smooth(0.0, 1.0, u * 2.0)
                l_reach = 0.0
            else:
                r_reach = smooth(1.0, 0.0, (u - 0.5) * 2.0)
                l_reach = smooth(0.0, 1.0, (u - 0.5) * 2.0)
        else:
            if u < 0.5:
                l_reach = smooth(0.0, 1.0, u * 2.0)
                r_reach = 0.0
            else:
                l_reach = smooth(1.0, 0.0, (u - 0.5) * 2.0)
                r_reach = smooth(0.0, 1.0, (u - 0.5) * 2.0)

        # 右手
        r_shoulder_x = shoulder_cx + scale * 9
        r_shoulder_y = shoulder_y
        r_hand_x = r_hand_ref_x
        r_hand_y = r_hand_ref_y + r_reach * scale * 14
        r_elbow_x = (r_shoulder_x + r_hand_x) * 0.5 + scale * 2
        r_elbow_y = (r_shoulder_y + r_hand_y) * 0.5
        draw_line(r_shoulder_x, r_shoulder_y, r_elbow_x, r_elbow_y, dots, thick=2.0)
        draw_line(r_elbow_x, r_elbow_y, r_hand_x, r_hand_y, dots, thick=2.0)

        # 左手
        l_shoulder_x = shoulder_cx - scale * 9
        l_shoulder_y = shoulder_y
        l_hand_x = l_hand_ref_x
        l_hand_y = l_hand_ref_y + l_reach * scale * 14
        l_elbow_x = (l_shoulder_x + l_hand_x) * 0.5 - scale * 2
        l_elbow_y = (l_shoulder_y + l_hand_y) * 0.5
        draw_line(l_shoulder_x, l_shoulder_y, l_elbow_x, l_elbow_y, dots, thick=2.0)
        draw_line(l_elbow_x, l_elbow_y, l_hand_x, l_hand_y, dots, thick=2.0)

    elif p < 6.5:
        # 阶段2: 把球丢向画面右上方
        st = (p - 6.0) / 0.5
        body_dy = scale * 3 * (1.0 - st)

        stick_figure(cx, cy + body_dy, scale, dots, lean=0.0,
                     arm_left=0.0, arm_right=0.0,
                     leg_left=-0.4, leg_right=-0.4,
                     head_offset=(0, 0),
                     draw_left_arm=False, draw_right_arm=False)

        start_x = cx + scale * 18
        start_y = cy + scale * 4
        end_x = cx + scale * 55
        end_y = cy - scale * 25
        ball_x = smooth(start_x, end_x, st)
        ball_y = smooth(start_y, end_y, st) - math.sin(st * math.pi) * scale * 15
        circle(ball_x, ball_y, scale * 4.5, dots, fill=True)

        # 双手张开,做出丢球后的舒展姿势
        r_shoulder_x = cx + scale * 9
        r_shoulder_y = cy - scale * 12 + body_dy
        r_hand_x = cx + scale * 25
        r_hand_y = cy - scale * 5
        r_elbow_x = (r_shoulder_x + r_hand_x) * 0.5
        r_elbow_y = (r_shoulder_y + r_hand_y) * 0.5
        draw_line(r_shoulder_x, r_shoulder_y, r_elbow_x, r_elbow_y, dots, thick=2.0)
        draw_line(r_elbow_x, r_elbow_y, r_hand_x, r_hand_y, dots, thick=2.0)

        l_shoulder_x = cx - scale * 9
        l_shoulder_y = cy - scale * 12 + body_dy
        l_hand_x = cx - scale * 5
        l_hand_y = cy - scale * 8
        l_elbow_x = (l_shoulder_x + l_hand_x) * 0.5
        l_elbow_y = (l_shoulder_y + l_hand_y) * 0.5
        draw_line(l_shoulder_x, l_shoulder_y, l_elbow_x, l_elbow_y, dots, thick=2.0)
        draw_line(l_elbow_x, l_elbow_y, l_hand_x, l_hand_y, dots, thick=2.0)

    else:
        # 阶段3: 球已飞出画面,开始铁山靠
        st = p - 6.5
        phase = math.sin(st * 2.5)
        lean = phase * 0.35
        side = 1 if phase > 0 else -1

        head_off = (side * 0.12, abs(phase) * 0.08)
        arm_left = -0.6 * side
        arm_right = 0.9 * side
        leg_left = -0.5 * side
        leg_right = 0.4 * side

        stick_figure(cx, cy, scale, dots, lean=lean,
                     arm_left=arm_left, arm_right=arm_right,
                     leg_left=leg_left, leg_right=leg_right,
                     head_offset=head_off)

        # 顶肩方向加几道气势线
        if abs(phase) > 0.5:
            base_x = cx + side * scale * 28
            base_y = cy - scale * 8
            for i in range(3):
                ox = side * (4 + i * 5) * scale * abs(phase)
                oy = (i - 1) * scale * 5
                draw_line(base_x, base_y + oy,
                          base_x + ox * 0.6, base_y + oy + (i - 1) * scale * 3, dots, thick=1.0)

    return dots


def dots_to_rows(dots, cols, rows):
    out = []
    for row in range(rows):
        cells = []
        for col in range(cols):
            gx = col * 2
            gy = row * 4
            mask = 0
            for dy in range(4):
                for dx in range(2):
                    if (gx + dx, gy + dy) in dots:
                        mask = mask | DOT[dy][dx]
            cells.append(chr(0x2800 + mask))
        out.append(''.join(cells))
    return out


def build_frame(cols, rows, t, mode):
    if mode == 'both':
        mode = 'tieshankao' if int(t / 6.0) % 2 == 0 else 'basketball'

    if mode == 'basketball':
        dots = render_basketball(cols, rows, t)
    else:
        dots = render_tieshankao(cols, rows, t)

    return dots_to_rows(dots, cols, rows)


def main():
    mode = os.environ.get('MODE', 'tieshankao').lower()
    if mode not in ('tieshankao', 'basketball', 'both'):
        mode = 'tieshankao'

    out = sys.stdout.buffer

    def write(b):
        out.write(b)
        out.flush()

    write(ENTER_ALT + HIDE + CLEAR)
    start = time.time()
    frame = 0
    # basketball 模式播完一个完整周期(运球+丢球+铁山靠)即停
    limit = BASKETBALL_PERIOD if mode == 'basketball' else DURATION
    try:
        while True:
            t = time.time() - start
            if t > limit:
                break
            cols, rows = term_size()
            rows_out = build_frame(cols, rows, t, mode)
            buf = bytearray(HOME)
            for i, r in enumerate(rows_out):
                buf += r.encode('utf-8')
                if i < len(rows_out) - 1:
                    buf += NL
            write(bytes(buf))
            frame = frame + 1
            target = start + frame / float(FPS)
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
