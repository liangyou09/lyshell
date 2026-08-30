/**
 * 终端输出内的文档路径识别 —— 纯函数（link provider 与单测共用）。
 *
 * 六种形态按保守优先级匹配：Windows 盘符 / ~ 家目录 / unix 绝对 /
 * ./ ../ 相对 / 多段相对（无 ./ 前缀，如 src/assets/README.md）/ 裸文件名。
 * URL 靠 lookbehind 挡（前置 / . \w 等路径字符的起点不匹配），带协议的
 * https://…/README.md 全程无起点可匹配。已知取舍：无协议的
 * example.com/a.md 会当相对路径命中（点了读不到是显式报错，可接受）。
 */
import { docKindFromPath } from '@shared/types'

/** 文档扩展名（顺序无妨，回溯可覆盖 markdown/html 前缀重叠） */
const EXT = '(?:markdown|md|html|htm|txt)'

/** 路径合法字符（不含分隔符与 ~，~ 单独出现在段首形态里） */
const SEG = '[A-Za-z0-9._+@%\\-]+'

/** 前置守卫：匹配起点前一个字符不得是路径字符（否则是更长 token 的中段/URL 的斜杠尾巴） */
const NOT_PATH_BEFORE = '(?<![\\w./\\\\~+@%\\-])'

const DOC_PATH_RE = new RegExp(
  [
    `[A-Za-z]:[\\\\/]` + `(?:${SEG}[\\\\/])*` + `${SEG}\\.${EXT}\\b`, // C:\docs\a.md / C:/docs/a.md
    `${NOT_PATH_BEFORE}~[\\\\/](?:${SEG}[\\\\/])*${SEG}\\.${EXT}\\b`, // ~/docs/a.md
    `${NOT_PATH_BEFORE}/(?:${SEG}/)*${SEG}\\.${EXT}\\b`, // /srv/app/README.md
    `\\.{1,2}[\\\\/](?:${SEG}[\\\\/])*${SEG}\\.${EXT}\\b`, // ./a.md ../docs/a.md
    `${NOT_PATH_BEFORE}(?:${SEG}[\\\\/])+${SEG}\\.${EXT}\\b`, // src/assets/README.md（无 ./ 前缀的多段相对）
    `${NOT_PATH_BEFORE}${SEG}\\.${EXT}\\b` // README.md（裸名，前置须为非路径字符）
  ].join('|'),
  'gi'
)

/** 一次匹配结果：path 在 text 中的区间 [start, end) 与原文 */
export interface DocPathMatch {
  start: number
  end: number
  path: string
}

/** 扫描整行文本，返回全部文档路径匹配（非重叠，按出现序） */
export function matchDocPaths(text: string): DocPathMatch[] {
  const out: DocPathMatch[] = []
  DOC_PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DOC_PATH_RE.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, path: m[0] })
  }
  return out
}

/**
 * 路径归并：绝对路径（unix / Windows 盘符）与 ~ 开头原样返回；
 * 相对路径（./ ../ 裸名）按 posix 语义并进 cwd；无 cwd 的相对路径返回 null。
 * 本地会话没有 pwd 通道，相对路径用 guessLocalCwd 的结果走 localJoin。
 */
export function resolveDocPath(path: string, cwd: string | undefined): string | null {
  if (/^[A-Za-z]:[\\/]/.test(path)) return path
  if (path.startsWith('/') || path.startsWith('~/') || path.startsWith('~\\')) return path
  if (!cwd) return null
  const base = cwd.replace(/\/+$/, '').split('/')
  for (const seg of path.replace(/^\.?\//, '').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (base.length > 1) base.pop()
      continue
    }
    base.push(seg)
  }
  return base.join('/')
}

/**
 * 从提示符行提取本地 cwd：PowerShell 默认提示符 `PS D:\docs>` 与
 * cmd 默认提示符 `D:\docs>`。不锚定行尾 —— 提示符后跟已执行命令
 * （`PS D:\docs> rg --files`）也认；posh-git 的 ` [branch]` 状态段剥掉。
 * 其余（starship/oh-my-posh 等自定义提示符）不认，返回 null 交回调用方
 * 走失败路径 —— 宁可不开也不错开。
 */
export function matchPromptCwd(line: string): string | null {
  const ps = /^\s*PS\s+([A-Za-z]:[\\/][^>]*)>/.exec(line)
  if (ps) return cleanPromptCwd(ps[1])
  const cmd = /^\s*([A-Za-z]:[\\/][^>]*)>/.exec(line)
  if (cmd) return cleanPromptCwd(cmd[1])
  return null
}

/** 剥离 posh-git 等附加在路径后的 ` [branch]` 状态段 */
function cleanPromptCwd(p: string): string {
  return p.replace(/\s+\[[^\]]*\]\s*$/, '').trim()
}

/**
 * 弹点/列表符号直接贴着路径时（`-.claude/x.md`，列表输出常见）剥掉单个前导 `-`。
 * 只影响解析，不影响终端里的选中区间。名为 `-x.md` 的真实文件更罕见，
 * 剥错也只是显式 loadError。
 */
export function stripLeadingDash(path: string): string {
  return path.startsWith('-') && path.length > 1 ? path.slice(1) : path
}

/**
 * 目录头行识别：分组文件列表里裸文件名的所属目录。形态如
 * `prototypes/（2 个）`、`docs/ (1 item)`、`src/renderer/:`（ls -R 风格）、
 * `~/docs/`、`design/（9 个）— UI 方向探索`（计数后带 `—` 描述）。
 * 返回带尾分隔符的目录；非目录头行（文件条目、表格行、普通句子）返回 null。
 * 尾部描述必须以分隔符（— – - : ： · |）起头 —— 无分隔符的行内提及
 * （`see docs/ for details`）与多段路径条目（`- src/a/README.md — 说明`）
 * 都靠这点挡在门外。
 */
const DIR_HEADER_RE = new RegExp(
  `^[\\s>*·•\\-]*((?:[A-Za-z]:[\\\\/]|~[\\\\/]|/|(?:${SEG}[\\\\/]))(?:${SEG}[\\\\/])*)` +
    `\\s*(?:[（(]\\s*\\d+\\s*(?:个|items?|files?)?\\s*[）)])?\\s*[:：]?\\s*(?:[—–\\-:：·|].*)?$`
)

export function matchDirHeader(line: string): string | null {
  const m = DIR_HEADER_RE.exec(line)
  return m ? m[1] : null
}

/**
 * 本地（Windows）相对路径归并：cwd + 裸名/./x/../x，反斜杠拼接。
 * `..` 不越出盘符根。
 */
export function localJoin(cwd: string, rel: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('\\')
}

/** 文档路径 → 所在目录（`/srv/docs/a.md` → `/srv/docs`；`/a.md` → `/`；`D:\a.md` → `D:\`；无分隔符 → ''） */
export function docDirFromPath(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i < 0) return ''
  if (i === 0) return '/'
  if (/^[A-Za-z]:[\\/]$/.test(p.slice(0, i + 1))) return p.slice(0, i + 1)
  return p.slice(0, i)
}

/**
 * md 文档内的链接 → 可打开的文档路径。只吃「文件」链接：外链（http/mailto）、
 * 纯锚点（#x）、非文档扩展名一律返回 null（保持只读渲染）。相对路径按当前
 * 文档所在目录归并（./ ../ 子目录/裸名；远端 posix 语义、本地反斜杠），
 * 绝对路径透传。href 做 percent-decode（`my%20file.md` 这类转义）。
 */
export function docLinkTarget(href: string, isLocal: boolean, docDir: string): string | null {
  if (!href || /^(https?:|mailto:|ftp:|file:|#)/i.test(href)) return null
  let p = href.split('#')[0].trim()
  try { p = decodeURIComponent(p) } catch { /* 转义非法就按原文用 */ }
  if (!p || !docKindFromPath(p)) return null
  if (isLocal) {
    if (/^[A-Za-z]:[\\/]/.test(p)) return p
    if (p.startsWith('~')) return null // 本地无 ~ 展开语义，不当文件跳转
    return docDir ? localJoin(docDir, p) : null
  }
  // 远端：绝对 / ~ 透传；相对并入当前文档目录
  if (p.startsWith('/') || p.startsWith('~')) return p
  return docDir ? resolveDocPath(p, docDir) : null
}
