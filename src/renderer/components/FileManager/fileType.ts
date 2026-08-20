/**
 * 文件类型分类 / 格式化工具
 * 服务于 FileBrowser 的 3px 类型色条、size 列、mtime 列
 */

import i18n from '../../i18n'

export type FileCategory = 'dir' | 'src' | 'log' | 'arch' | 'img' | 'bin' | 'other'

const SRC_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp',
  'java', 'kt', 'swift', 'rb', 'php', 'lua',
  'conf', 'cfg', 'json', 'yaml', 'yml', 'toml', 'ini', 'env',
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  'md', 'rst', 'txt',
  'html', 'htm', 'css', 'scss', 'less',
  'xml', 'sql'
])

const LOG_EXTS = new Set(['log', 'out', 'err'])

const ARCH_EXTS = new Set(['tar', 'gz', 'tgz', 'zip', 'rar', '7z', 'bz2', 'xz', 'tbz', 'tbz2'])

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'pdf'])

const BIN_EXTS = new Set(['so', 'dll', 'exe', 'bin', 'o', 'a', 'dylib'])

/**
 * 从文件名取扩展（小写，不含点）；无扩展返回 ''
 */
function extOf(name: string): string {
  // 隐藏文件（.bashrc）不视为扩展
  const idx = name.lastIndexOf('.')
  if (idx <= 0) return ''
  return name.slice(idx + 1).toLowerCase()
}

// 无扩展但属于"代码/配置"的常见文件（按文件名匹配，不依赖扩展）
const SRC_NAMES = new Set([
  'makefile', 'dockerfile', 'rakefile', 'gemfile', 'procfile', 'caddyfile',
  'license', 'readme', 'changelog', 'authors', 'contributors', 'notice',
  'jenkinsfile', 'vagrantfile'
])

/**
 * 文件分类 — 决定行最左 3px 色条颜色
 */
export function categorizeFile(name: string, isDir: boolean): FileCategory {
  if (isDir) return 'dir'
  const ext = extOf(name)
  if (!ext) {
    // 无扩展兜底：先查常见无扩展源码/文档名（Makefile / Dockerfile / LICENSE …），
    // 命中归 src；否则归 other。绝不再无脑归 bin —— 那会把全大写文档染成紫色二进制条。
    const base = name.toLowerCase()
    if (SRC_NAMES.has(base)) return 'src'
    return 'other'
  }
  if (LOG_EXTS.has(ext)) return 'log'
  if (ARCH_EXTS.has(ext)) return 'arch'
  if (IMG_EXTS.has(ext)) return 'img'
  if (BIN_EXTS.has(ext)) return 'bin'
  if (SRC_EXTS.has(ext)) return 'src'
  return 'other'
}

/**
 * 格式化字节大小 — 设计稿无 'B' 后缀（"42.3M" / "1.2G"）
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return i18n.t('common.sizeB', { n: bytes })
  if (bytes < 1024 * 1024) return i18n.t('common.sizeK', { n: (bytes / 1024).toFixed(1) })
  if (bytes < 1024 * 1024 * 1024) return i18n.t('common.sizeM', { n: (bytes / (1024 * 1024)).toFixed(1) })
  return i18n.t('common.sizeG', { n: (bytes / (1024 * 1024 * 1024)).toFixed(2) })
}

export type MtimeTier = 'recent' | 'fresh' | ''

/**
 * 相对时间格式化 — "2m ago" / "5h ago" / "3d ago" / "2mo ago"
 * tier: recent (<1h, 绿) · fresh (<24h, 白) · '' (其他, 灰)
 */
export function formatMtime(date: Date | string | number | undefined | null): { text: string; tier: MtimeTier } {
  if (date == null) return { text: '—', tier: '' }
  const t = date instanceof Date ? date.getTime() : new Date(date).getTime()
  if (!Number.isFinite(t) || t <= 0) return { text: '—', tier: '' }

  const now = Date.now()
  const diff = Math.max(0, now - t)

  const sec = Math.floor(diff / 1000)
  const min = Math.floor(sec / 60)
  const hour = Math.floor(min / 60)
  const day = Math.floor(hour / 24)
  const month = Math.floor(day / 30)
  const year = Math.floor(day / 365)

  if (sec < 60)  return { text: i18n.t('common.relTimeSeconds', { count: sec }), tier: 'recent' }
  if (min < 60)  return { text: i18n.t('common.relTimeMinutes', { count: min }), tier: 'recent' }
  if (hour < 24) return { text: i18n.t('common.relTimeHours', { count: hour }), tier: 'fresh' }
  if (day < 30)  return { text: i18n.t('common.relTimeDays', { count: day }), tier: '' }
  if (month < 12) return { text: i18n.t('common.relTimeMonths', { count: month }), tier: '' }
  return { text: i18n.t('common.relTimeYears', { count: year }), tier: '' }
}

/**
 * 短化本地路径 — 将 $HOME 前缀替换成 ~（用于底部传输条显示）
 */
export function shortenLocalPath(localPath: string, home?: string): string {
  if (!localPath) return ''
  if (home && localPath.startsWith(home)) {
    return '~' + localPath.slice(home.length)
  }
  // 没拿到 home 时退化：只显示最后两段
  const sep = localPath.includes('\\') ? '\\' : '/'
  const parts = localPath.split(sep).filter(Boolean)
  if (parts.length <= 2) return localPath
  return '…' + sep + parts.slice(-2).join(sep)
}

/**
 * 把 POSIX 绝对路径切成面包屑段
 * '/var/log/nginx' → [{label:'/', abs:'/'}, {label:'var', abs:'/var'}, {label:'log', abs:'/var/log'}, {label:'nginx', abs:'/var/log/nginx'}]
 */
export interface PathSegment {
  label: string
  abs: string
}

export function pathSegments(absPath: string): PathSegment[] {
  if (!absPath || absPath === '/') return [{ label: '/', abs: '/' }]
  const cleaned = absPath.replace(/\/+$/, '') || '/'
  const parts = cleaned.split('/').filter(Boolean)
  const segs: PathSegment[] = [{ label: '/', abs: '/' }]
  let acc = ''
  for (const p of parts) {
    acc += '/' + p
    segs.push({ label: p, abs: acc })
  }
  return segs
}
