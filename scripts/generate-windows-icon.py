"""从原始 PNG 生成减少留白的 Windows 图标（需要 Pillow）。

在仓库根目录执行：python scripts/generate-windows-icon.py
保留原图，窗口和安装包统一使用生成的 icon-windows.ico。
"""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "resources" / "icons"
CANVAS_SIZE = 512
MARGIN = 16
# 覆盖 Windows 小/大图标及常见 DPI 缩放，避免任务栏重复缩放。
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def main() -> None:
    source = Image.open(ICON_DIR / "icon.png").convert("RGBA")
    # 原图边缘有离散的低透明度像素；用可见主体定位，再留 2px 保留抗锯齿边缘。
    bounds = source.getchannel("A").point(lambda alpha: 255 if alpha >= 64 else 0).getbbox()
    if bounds is None:
        raise ValueError("原始图标没有可见内容")
    left, top, right, bottom = bounds
    artwork = source.crop((max(0, left - 2), max(0, top - 2),
                           min(source.width, right + 2), min(source.height, bottom + 2)))
    scale = (CANVAS_SIZE - MARGIN * 2) / max(artwork.size)
    artwork = artwork.resize(
        (round(artwork.width * scale), round(artwork.height * scale)),
        Image.Resampling.LANCZOS,
    )
    icon = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    icon.alpha_composite(artwork, ((CANVAS_SIZE - artwork.width) // 2,
                                 (CANVAS_SIZE - artwork.height) // 2))
    icon.save(ICON_DIR / "icon-windows.png")
    icon.save(ICON_DIR / "icon-windows.ico", sizes=[(size, size) for size in ICO_SIZES])
    print(f"Windows 图标已生成：原始主体 {bounds}，缩放 {scale:.2f} 倍，ICO 尺寸 {ICO_SIZES}")


if __name__ == "__main__":
    main()
