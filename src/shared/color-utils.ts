/**
 * 颜色亮度工具 -- 纯函数,零依赖。
 * 供渲染层(theme-store / TerminalView)共用,把"亮度阈值"收敛到一处,避免漂移。
 * 早期 FOUC 脚本(theme-init.ts)为保持自包含仍内联一份,其注释标注了须与本处阈值同步。
 */

/** #RGB / #RRGGBB -> [r,g,b](0-255);非法输入返回 [0,0,0] */
function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '')
  const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m
  const v = parseInt(full, 16)
  if (isNaN(v)) return [0, 0, 0]
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

/** Rec.601 加权亮度,0~1 */
export function hexLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

/** 浅底判定阈值(> 视为浅底)。改阈值只改这一处(及 theme-init 内联副本)。 */
export const LIGHT_LUMINANCE_THRESHOLD = 0.55

/** 是否浅底 -- 决定终端画布深/浅配色集、custom chrome 派生方向 */
export function isLightColor(hex: string): boolean {
  return hexLuminance(hex) > LIGHT_LUMINANCE_THRESHOLD
}
