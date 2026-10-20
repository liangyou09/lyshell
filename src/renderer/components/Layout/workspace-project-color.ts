// 配色只由目录身份决定，跨面板、重排与重命名保持稳定，不需要写回用户配置。
const PROJECT_HUES = [215, 160, 275, 35, 190, 315] as const

export function workspaceProjectHue(directory: string): number {
  let key = directory.trim().replace(/[\\/]+$/, '')
  if (/^[a-z]:|^\\\\/i.test(key)) key = key.replace(/\\/g, '/').toLowerCase()
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0
  return PROJECT_HUES[hash % PROJECT_HUES.length]
}
