/**
 * 插件视图图标读取与净化（main 侧，docs/plugin-ui-views-plan.md §三「图标入口」）
 *
 * ActivityRail 的 CSS maskImage 走主 renderer 默认 session，插件专属 partition 上的
 * lyshell-plugin:// 协议够不着，因此图标走受限 IPC 入口（PLUGIN_VIEW_ICON）：
 *   - 只接收 pluginId/viewId，main 在已注册视图定义中查出 icon 相对路径，
 *     不接收 renderer 传来的任意文件路径；
 *   - realpath 确认图标真实路径仍在插件真实根目录内（防 dev 插件 symlink 越界），
 *     拒绝隐藏文件与 views/ 之外的意外形态由注册表校验保证，这里双保险；
 *   - 只接受 .svg/.png，限制大小；SVG 剥离脚本/事件属性/外链/实体等活动内容，
 *     以 data URL 返回供 maskImage 与 <img> 使用。
 *
 * 纯净化逻辑（sanitizeSvgForIcon）与常量独立导出供 vitest 直测；文件读取依赖
 * view-registry 单例（未初始化时按「图标不可用」降级为 null，不抛错）。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { isAbsolute, join, relative } from 'path'
import { getPluginViewRegistry } from './view-registry'

/** 图标字节上限（与资源协议 MAX_RESOURCE_BYTES 相比收得更紧：图标只是装饰） */
export const MAX_VIEW_ICON_BYTES = 256 * 1024

/** 允许的图标扩展名 → MIME（manifest 校验同款白名单） */
export const VIEW_ICON_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}

/**
 * SVG 图标净化（纯函数，可测）：按「剥活动内容、留形状」的思路做白名单式删除，
 * 不试图完整解析 XML —— 图标消费面是 CSS maskImage/<img>，脚本本就不会执行，
 * 这里是纵深防御：
 *   - <script> 元素连同内容整段删除；
 *   - <foreignObject>（可嵌 HTML）整段删除；
 *   - on* 事件属性 / javascript: 等危险 URL / <use href> 外链引用 / <!ENTITY> 实体；
 *   - 注释一并去掉（可藏构造向量）。
 */
export function sanitizeSvgForIcon(source: string): string {
  let out = source
  // 注释与 DOCTYPE/ENTITY 声明（实体展开攻击面）
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  out = out.replace(/<!DOCTYPE[\s\S]*?>/gi, '')
  out = out.replace(/<!ENTITY[\s\S]*?>/gi, '')
  // script / foreignObject 连内容整段删除（宽松闭合容忍：恶意 SVG 本就不讲规矩）
  out = out.replace(/<script[\s\S]*?<\/script\s*>/gi, '')
  out = out.replace(/<script\b[^>]*\/?>/gi, '')
  out = out.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
  out = out.replace(/<foreignObject\b[^>]*\/?>/gi, '')
  // 危险协议 URL（href/xlink:href/src/style 内均可出现）
  out = out.replace(/(href|src)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1=""')
  // on* 事件属性
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // <use> 外链引用只允许同文档 #fragment（组1=带引号前缀、组2=引号本身，重写为 #）
  out = out.replace(/(<use\b[^>]*\b(?:xlink:)?href\s*=\s*("|'))(?!#)[^"']*\2/gi, '$1#$2')
  return out
}

/**
 * 读取并净化一个视图图标，返回 data URL；任何一步不可用（注册表未初始化、视图
 * 不存在、未声明 icon、文件缺失/越界/超限/扩展名不符）返回 null —— 调用方回退
 * IconPlugins，不区分失败原因（轨道图标不该有错误对话框）。
 */
export function readPluginViewIconDataUrl(pluginId: string, viewId: string): string | null {
  let registry: ReturnType<typeof getPluginViewRegistry>
  try {
    registry = getPluginViewRegistry()
  } catch {
    return null
  }
  const view = registry.getView(pluginId, viewId)
  if (!view || !view.icon) return null
  const ext = view.icon.slice(view.icon.lastIndexOf('.')).toLowerCase()
  const mime = VIEW_ICON_MIME[ext]
  if (!mime) return null
  const pluginDir = registry.getPluginDir(pluginId)
  if (!pluginDir) return null
  // realpath 包围：图标真实路径必须位于插件真实根目录内（symlink/junction 越界拒绝）
  let realRoot: string
  try {
    realRoot = realpathSync(pluginDir)
  } catch {
    return null
  }
  const iconPath = join(realRoot, view.icon)
  if (!existsSync(iconPath)) return null
  let realIcon: string
  try {
    realIcon = realpathSync(iconPath)
  } catch {
    return null
  }
  const rel = relative(realRoot, realIcon)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  // 隐藏文件双保险（注册表已拒，此处防缓存/时序缝隙）
  const base = rel.replace(/\\/g, '/').split('/').pop() ?? ''
  if (base.startsWith('.')) return null
  try {
    const st = statSync(realIcon)
    if (!st.isFile() || st.size === 0 || st.size > MAX_VIEW_ICON_BYTES) return null
  } catch {
    return null
  }
  let buf: Buffer
  try {
    buf = readFileSync(realIcon)
  } catch {
    return null
  }
  if (ext === '.svg') {
    const cleaned = sanitizeSvgForIcon(buf.toString('utf-8'))
    if (!cleaned.trim()) return null
    return `data:${mime};base64,${Buffer.from(cleaned, 'utf-8').toString('base64')}`
  }
  return `data:${mime};base64,${buf.toString('base64')}`
}
