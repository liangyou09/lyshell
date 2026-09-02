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
 * ls 命令行目录提取：`fenghuiyu@docker-IPS:~$ ls project/6080/` → `project/6080/`。
 * 普通多列 ls 输出没有目录头行（matchDirHeader 不认），列表里裸文件名的
 * 目录上下文在其上方第一条命令行（提示符行）里。
 *
 * 保守取舍（猜错与否由调用方 stat 验证兜底，这里只挡明显非命令行形态）：
 * - 只认独立词 ls / ll（大小写敏感）；la/dir 等别名易与普通文本混淆不认。
 *   提示符里的 ls 不会独立成词（`~/ls-test$` 的 ls 后跟 -，lookahead 挡掉）。
 * - 取最后一个命令词（`a; ls b/` 认 b —— 其输出在行下方），参数解析在
 *   |;&<> 管道/续接符处截止（`ls a/ | head` 只认 a/）。
 * - 跳过 - 选项，取最后一个路径形态参数；尾分隔符有无都认（`ls project/6080/`
 *   的 tab 补全形态与 `ls project/6080` 手打形态 —— 参数是否真是目录由调用方
 *   stat 判定，`ls notes.md` 文件参数拼出的路径 stat 不过自然回落）。
 * - 参数字符限定 SEG + 可选盘符/~/根前缀：`$HOME/docs/`、`*.md`、跨空格
 *   引号目录这类非字面路径不认。
 */
const LS_CMD_RE = /\b(?:ls|ll)(?=\s|$)/g
const LS_DIR_ARG_RE = new RegExp(`^(?:[A-Za-z]:[\\\\/]|~[\\\\/]|/)?(?:${SEG}[\\\\/])*${SEG}[\\\\/]?$`)

/** 剥掉整体包裹的成对引号（tab 补全含特殊字符目录时 shell 会补引号） */
function stripQuotes(token: string): string {
  if (token.length >= 2 && ((token[0] === '"' && token.endsWith('"')) || (token[0] === "'" && token.endsWith("'")))) {
    return token.slice(1, -1)
  }
  return token
}

/**
 * 从终端行提取 ls/ll 命令的目录参数；无命令词或参数非字面路径形态返回 null。
 * 返回目录保留原样（相对/绝对/~/盘符皆可，尾分隔符可有可无），归并交调用方。
 */
export function matchLsDir(line: string): string | null {
  // 取最后一个命令词（g 正则手动迭代；lastIndex 复位防跨调用串位）
  let last: RegExpExecArray | null = null
  LS_CMD_RE.lastIndex = 0
  for (let m = LS_CMD_RE.exec(line); m !== null; m = LS_CMD_RE.exec(line)) last = m
  if (!last) return null
  // 命令参数段：命令词之后到首个管道/续接符
  const args = line.slice(last.index + last[0].length).split(/[|;&<>]/)[0]
  let dir: string | null = null
  for (const tok of args.trim().split(/\s+/)) {
    const t = stripQuotes(tok)
    if (!t || t.startsWith('-')) continue // 空段 / 选项
    if (!LS_DIR_ARG_RE.test(t)) continue // 非字面路径形态（变量 / 通配符 / 引号断段）
    dir = t // 取最后一个路径参数（多目录参数输出自带分节头，归 matchDirHeader）
  }
  return dir
}

/**
 * 远端提示符行提取交互 shell 的用户与 cwd：`fenghuiyu@docker-IPS:~/project/6080$ ls`
 * → `{ user: 'fenghuiyu', cwd: '~/project/6080' }`。bash/Debian 默认 PS1
 * （\u@\h:\w\$）把交互 shell 的当前目录嵌在提示符里 —— 这正是 filePwd 给不了的
 * 东西（文件连接器 shell 的 pwd 是登录目录，交互终端 cd 之后两者就分道了）。
 * user 用于与 会话 SSH 用户比对：不一致（终端里 su 换身份）说明 ~ 形态的
 * 提示符 cwd 不属于登录用户，调用方弃用它（读取跟随登录用户）。
 * 只认 user@host:PATH$ / # 形态，PATH 须以 / 或 ~ 开头（\w 的输出形态）；
 * 自定义提示符（starship ❯、zsh %）、相对 cwd、~user 形态不认，返回 null
 * 交回调用方走 filePwd 的登录目录 cwd —— 宁可不猜。
 */
const REMOTE_PROMPT_RE = /([\w.-]+)@[\w.-]+:([^$#\n]+?)[$#](?=\s|$)/

/** 提示符行提取结果：交互 shell 的当前用户与 cwd */
export interface RemotePromptInfo {
  user: string
  cwd: string
}

export function matchRemotePrompt(line: string): RemotePromptInfo | null {
  const m = REMOTE_PROMPT_RE.exec(line)
  if (!m) return null
  const p = m[2]
  if (!p.startsWith('/') && !p.startsWith('~')) return null
  return { user: m[1], cwd: p }
}

/** cwd-only 投影（matchRemotePrompt 的便捷形态） */
export function matchRemotePromptCwd(line: string): string | null {
  return matchRemotePrompt(line)?.cwd ?? null
}

/**
 * 用户的惯例家目录：root 特判 /root，其余 /home/<user>（Linux 惯例 —— macOS 是
 * /Users/<user>、NFS 等自定义布局会猜错）。按会话 SSH 用户取用：filePwd 失败
 * 拿不到登录 home 时作 ~ 的展开基准。该基准只在 filePwd 已失败的分支生效，
 * 猜错也只让错误页签里的候选路径不准（stat 探测随之落空），不会读错文件。
 */
export function conventionalHome(user: string): string {
  return user === 'root' ? '/root' : `/home/${user}`
}

/**
 * 提示符 cwd 的 ~ 展开：`~` / `~/x` 按登录目录（文件连接器 pwd，即 home）拼
 * 绝对路径；绝对路径原样；`~user/x`（他人家目录）、无 home 可依的 ~ 形态、
 * 相对形态一律返回 null（该 cwd 候选放弃，不硬猜）。
 */
export function expandPromptTilde(promptCwd: string, home: string | undefined): string | null {
  if (promptCwd.startsWith('/')) return promptCwd
  if (promptCwd === '~') return home ?? null
  if (promptCwd.startsWith('~/')) return home ? home + promptCwd.slice(1) : null
  return null
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
