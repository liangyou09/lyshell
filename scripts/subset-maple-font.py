#!/usr/bin/env python3
"""
Maple Mono NF CN 子集化 + WOFF2 转换脚本。

用途: 把 Maple Mono NF CN 的 Regular/Bold ttf 压缩成随 app 打包的 woff2,
砍掉终端用不到的稀有字符, 使安装包体积从 ~40MB 降到 ~10MB 级。

依赖: pip install "fonttools[woff]"

用法: python scripts/subset-maple-font.py [源目录]
  从源目录读取 Regular/Bold ttf, 子集化后输出 woff2 到 src/renderer/fonts/。
  源目录按优先级解析: CLI 参数 → 环境变量 MAPLE_SRC_DIR → 仓库内 fonts-src/(已 gitignore)。

字符集策略(终端场景, 中文优先):
  - 保留: ASCII + 拉丁/希腊/西里尔 + 全部标点/符号/箭头/数学 + 制表符/块元素
    (TUI 进度条/边框必需) + CJK 统一表意汉字(全量, 用户会打任意汉字) + 假名 +
    全角形式 + Nerd Font PUA 图标(私有区 E000-F8FF 与补充私有区 F0000-F0FFF)。
  - 丢弃: CJK 扩展 A/B 及之后的生僻字(3400-4DBF、20000+), 这些在终端日志/代码里
    几乎不出现, 却占字体内相当一部分体积。
"""
import os
import sys
from fontTools.subset import main as subset_main
from fontTools.ttLib import TTFont

OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src", "renderer", "fonts"))


def resolve_src_dir() -> str:
    """解析 Maple 源 ttf 所在目录: CLI 参数 > 环境变量 MAPLE_SRC_DIR > 仓库内 fonts-src/。"""
    if len(sys.argv) > 1:
        return os.path.abspath(sys.argv[1])
    env = os.environ.get("MAPLE_SRC_DIR")
    if env:
        return os.path.abspath(env)
    default = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fonts-src"))
    if os.path.isdir(default):
        return default
    raise SystemExit(
        "未指定 Maple 源目录。请任选其一:\n"
        "  1) CLI 参数:  python scripts/subset-maple-font.py <目录>\n"
        "  2) 环境变量:  MAPLE_SRC_DIR=<目录> python scripts/subset-maple-font.py\n"
        "  3) 仓库内建 fonts-src/ 并放入 MapleMono-NF-CN-{Regular,Bold}.ttf(已 gitignore)"
    )


SRC_DIR = resolve_src_dir()

# 终端字符集(以逗号分隔的 Unicode 范围, 见文件头说明)
UNICODE_RANGES = (
    "U+0000-007E,"  # ASCII 可打印
    "U+00A0-024F,"  # Latin-1 补充 + 拉丁扩展 A/B
    "U+0300-036F,"  # 组合附加符号(声调/重音)
    "U+0370-03FF,"  # 希腊
    "U+0400-04FF,"  # 西里尔
    "U+1E00-1EFF,"  # 拉丁扩展附加
    "U+2000-206F,"  # 通用标点
    "U+2070-209F,"  # 上下标
    "U+20A0-20CF,"  # 货币符号
    "U+2100-214F,"  # 字母式符号
    "U+2150-218F,"  # 数字形式
    "U+2190-21FF,"  # 箭头
    "U+2200-22FF,"  # 数学运算符
    "U+2300-23FF,"  # 杂项技术符号
    "U+2460-24FF,"  # 带圈字母数字
    "U+2500-257F,"  # 制表符(框线)
    "U+2580-259F,"  # 块元素(进度条/Claude Code 绘制)
    "U+25A0-25FF,"  # 几何图形
    "U+2600-26FF,"  # 杂项符号
    "U+2700-27BF,"  # Dingbats(✓ ✗ 等)
    "U+27C0-27EF,"  # 杂项数学符号 A
    "U+27F0-27FF,"  # 补充箭头 A
    "U+2900-297F,"  # 补充箭头 B
    "U+2B00-2BFF,"  # 杂项符号与箭头
    "U+2E80-2EFF,"  # CJK 部首补充
    "U+2F00-2FDF,"  # 康熙部首
    "U+3000-303F,"  # CJK 标点(。「」『』等)
    "U+3040-309F,"  # 平假名
    "U+30A0-30FF,"  # 片假名
    "U+3100-312F,"  # 注音符号
    "U+3130-318F,"  # 谚文兼容字母
    "U+3190-319F,"  # 汉文训读符号
    "U+31A0-31BF,"  # 注音扩展
    "U+3200-32FF,"  # 带圈 CJK 字母月份
    "U+3300-33FF,"  # CJK 兼容
    "U+4E00-9FFF,"  # CJK 统一表意汉字(全量保留)
    "U+F900-FAFF,"  # CJK 兼容表意
    "U+FB00-FB4F,"  # 字母表现形式(连字)
    "U+FE00-FE0F,"  # 变体选择符
    "U+FE10-FE1F,"  # 竖排形式
    "U+FE20-FE2F,"  # 组合半角标记
    "U+FE30-FE4F,"  # CJK 兼容形式
    "U+FE50-FE6F,"  # 小写形式变体
    "U+FF00-FFEF,"  # 半角/全角形式
    "U+FFF0-FFFF,"  # 特殊字符(BOM/替换符)
    "U+E000-F8FF,"  # 私有区: Nerd Font 图标
    "U+F0000-F0FFF,"  # 补充私有区: Nerd Font 补充图标
    "U+E0100-E01EF"  # 补充变体选择符
)

WEIGHTS = {
    "MapleMono-NF-CN-Regular.ttf": "MapleMono-NF-CN-Regular.woff2",
    "MapleMono-NF-CN-Bold.ttf": "MapleMono-NF-CN-Bold.woff2",
}


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    generated = 0
    for src_name, dst_name in WEIGHTS.items():
        src_path = os.path.join(SRC_DIR, src_name)
        dst_path = os.path.join(OUT_DIR, dst_name)
        if not os.path.exists(src_path):
            print(f"[skip] 找不到源字体: {src_path}", file=sys.stderr)
            continue

        args = [
            src_path,
            f"--unicodes={UNICODE_RANGES}",
            "--flavor=woff2",
            "--no-hinting",       # 去掉 TrueType hinting, 屏幕渲染不需要, 能再省 15~25%
            "--name-IDs=*",       # 保留完整 name 表, 确保浏览器按 'Maple Mono NF CN' 匹配
            f"--output-file={dst_path}",
        ]
        print(f"子集化 {src_name} ...")
        subset_main(args)

        # 校验输出: family 名 + 字形数 + 体积
        font = TTFont(dst_path)
        family = font["name"].getDebugName(1)
        subfamily = font["name"].getDebugName(2)
        glyph_count = len(font.getGlyphOrder())
        size_mb = os.path.getsize(dst_path) / 1024 / 1024
        print(f"  -> {dst_name}: {size_mb:.2f} MB | family='{family}' | {subfamily} | {glyph_count} 字形")
        generated += 1

    if generated == 0:
        print("错误: 未生成任何字体, 请检查源目录路径与 ttf 文件名", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
