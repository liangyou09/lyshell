/**
 * 破坏性命令内容扫描（B1: prompt-injection 防御层）
 *
 * 纯函数，无 IO，便于单测。在 http-server.ts 的 confirmDestructiveIfNeeded 中调用。
 *
 * 设计原则：高精准优先于高召回。宁可漏过一些"看起来危险"的命令，
 * 也不要误伤 agent 的正常工作流——误伤会让用户直接关掉 confirmDestructiveCommands，
 * 防御层就形同虚设。只覆盖"几乎一定是灾难性"的模式：
 *   删根/家目录、写块设备、mkfs、fork bomb、关机重启、chmod 根目录。
 *
 * 文字参数放行：grep/rg/echo/printf 的参数是纯文字数据，不会被 shell 执行，
 * 因此 `grep -iE 'compose|docker|reboot'` 这类只读排查不应触发关机重启确认。
 * 放行范围刻意收得很窄（见 collectLiteralTextRanges），且只作用于"裸命令词"型
 * 规则（shutdown-reboot / mkfs）：
 *   - 命令词必须是 grep/rg/echo/printf（及其 egrep/fgrep 别名），未知命令保持原文匹配；
 *   - 任意段出现命令替换 `$(...)` 或反引号则全部不放行（echo "$(reboot)" 仍命中）；
 *   - 管道下游只允许已知文字处理命令；解释器或未知下游均不放行（echo reboot | sh 仍命中）；
 *   - 重定向目标不在放行范围内（echo reboot > /dev/sda 仍命中写块设备）。
 * 结构性规则（rm -rf /、dd of=、> /dev/sdX、fork bomb、chmod /）一律按原文匹配、
 * 不放宽——例如 echo 'rm -rf /' 仍然会提示，这是刻意保留的保守行为。
 *
 * 已知限制：
 *   - 无法捕获跨多次 send_input 拼装的命令（如逐字符发送 rm -rf /）。
 *   - 文字放行只覆盖确定是只读搜索/输出的命令，awk/sed/xargs 等仍按原文匹配。
 *   - 本层不做完整 shell 解析，动态拼接命令仍受原有文本扫描局限约束。
 *
 * 注：pattern 清单为代码内置常量，刻意不暴露给用户/agent 编辑，
 *     避免被 prompt-injection 后的 agent 自行关掉。
 */

export interface DestructiveMatch {
  /** 命中的 pattern 名，用于弹窗展示 */
  name: string
  /** 人类可读说明 */
  description: string
  /** 命中的文本片段（截断展示） */
  snippet: string
}

interface DestructivePattern {
  name: string
  description: string
  pattern: RegExp
  /**
   * 命中完全落在"纯文字参数"内时放行（见 collectLiteralTextRanges）。
   * 只对裸命令词型规则开启（shutdown-reboot / mkfs）——这类词最常出现在
   * grep/rg/echo 的搜索词里；结构性规则保持原文匹配，绝不放宽。
   */
  literalTextArgs?: boolean
}

/**
 * 内置破坏性命令 pattern 清单。新增条目时务必在 destructive-check.test.ts
 * 补充正例/反例，保证精准度。
 */
export const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
  {
    name: 'rm-rf-root',
    description: 'rm -rf 删除根目录 / 家目录 / 根下所有内容',
    // 仅匹配裸 /、裸 ~、/* 、~/* —— 精准排除 /tmp/x、~/foo 这类正常清理。
    // 尾边界允许空格/行尾/; & | 等 shell 分隔符，但不允许字母（排除 /tmp）。
    pattern: /\brm\s+-\w*(?:r\w*f|f\w*r)\w*\s+(?:\/\*|~\/\*|\/|~)(?=[\s;&|]|$)/
  },
  {
    name: 'dd-to-block-device',
    description: 'dd 写入块设备（覆盖磁盘数据）',
    // of= 指向 /dev/ 下的块设备；[^|;&\n]* 不跨越命令边界
    pattern: /\bdd\b[^|;&\n]*\bof\s*=\s*\/dev\/(?:sd|nvme|vd|hd|disk|loop)/
  },
  {
    name: 'mkfs',
    description: 'mkfs 格式化文件系统',
    pattern: /\bmkfs(?:\.\w+)?\b/,
    // grep/rg/echo 里出现 mkfs 字样属于只读排查
    literalTextArgs: true
  },
  {
    name: 'write-to-block-device',
    description: '重定向写入块设备（覆盖磁盘数据）',
    // > /dev/sdX、2> /dev/sdX 等；/dev/null 不在清单内，正常放行
    pattern: />\s*\/dev\/(?:sd|nvme|vd|hd|disk|loop)/
  },
  {
    name: 'fork-bomb',
    description: 'fork bomb（耗尽进程表）',
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/
  },
  {
    name: 'shutdown-reboot',
    description: '关机 / 重启',
    // \b 边界排除 reboot_count、halted 之类的子串
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/,
    // crontab | grep 'reboot' 这类只读排查属于文字参数
    literalTextArgs: true
  },
  {
    name: 'chmod-root',
    description: 'chmod 修改根目录权限',
    // 仅匹配裸 / 作为目标，排除 /usr/bin/foo 这类具体路径；尾边界同 rm-rf-root
    pattern: /\bchmod\s+(?:-\w*R\w*\s+)?[0-7]{3,4}\s+\/(?=[\s;&|]|$)/
  }
]

const MAX_SNIPPET_LEN = 80

/** 搜索 / 输出类命令：参数是纯文字数据，shell 不会执行它们 */
const TEXT_ARG_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'echo', 'printf'])

/** 不改变被调用命令的普通前缀词 */
const COMMAND_PREFIXES = new Set(['sudo', 'doas', 'command', 'time', 'nohup'])

/** 这些前缀选项自带取值：跳过选项时还要跳过它后面的参数 */
const PREFIX_VALUE_OPTIONS = new Set(['-u', '-g', '-p', '-C', '-h', '-t', '-U', '-r', '-D'])

/** 管道只能流向已知的纯文字处理命令；未知下游可能把输出作为代码执行。 */
const TEXT_PIPE_COMMANDS = new Set([...TEXT_ARG_COMMANDS, 'cat', 'head', 'tail', 'sort', 'uniq', 'wc', 'cut', 'tr'])
const CODE_COMMANDS = new Set(['eval', 'source', '.', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'python', 'python3', 'perl', 'ruby', 'node', 'awk', 'gawk', 'xargs'])

interface ShellWord {
  start: number
  end: number
  /** 含命令替换或反引号——可能带出可执行内容 */
  dynamic: boolean
}

interface ShellSegment {
  words: ShellWord[]
  /** 第一个重定向符出现时的词数；之后的词是重定向目标，不参与文字放行 */
  argLimit: number
  /** 该段以单个 `|` 结尾，与下一段同属一条管道 */
  pipedToNext: boolean
}

/**
 * 极简分词：按引号感知的 `;` `&&` `||` `|` `&` 换行切段，段内再切词。
 * 只求支撑"这段参数是纯文字"，不追求完整 shell 语义——遇到拿不准的写法
 * 一律退化成原文匹配（保守，不放大误报）。
 */
function splitShellSegments(text: string): ShellSegment[] {
  const segments: ShellSegment[] = []
  let words: ShellWord[] = []
  let argLimit = -1
  let wordStart = -1
  let wordDynamic = false
  let quote: '"' | "'" | null = null

  const flushWord = (end: number): void => {
    if (wordStart < 0) return
    words.push({ start: wordStart, end, dynamic: wordDynamic })
    wordStart = -1
    wordDynamic = false
  }
  const endSegment = (pipedToNext: boolean): void => {
    if (words.length > 0) {
      segments.push({ words, argLimit: argLimit >= 0 ? argLimit : words.length, pipedToNext })
    }
    words = []
    argLimit = -1
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (quote === "'") {
      // 单引号内一切原样，$() 与反引号都只是文字
      if (ch === "'") quote = null
      i += 1
      continue
    }
    if (quote === '"') {
      // 双引号内反斜杠转义，$() 与反引号仍会执行
      if (ch === '\\') { i += 2; continue }
      if (ch === '"') { quote = null; i += 1; continue }
      if (ch === '`' || (ch === '$' && text[i + 1] === '(')) wordDynamic = true
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      if (wordStart < 0) wordStart = i
      quote = ch
      i += 1
      continue
    }
    if (ch === '\\') {
      if (wordStart < 0) wordStart = i
      i += 2
      continue
    }
    if (ch === '#' && wordStart < 0) {
      // 注释里的引号不能吞掉下一行真正执行的命令。
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '(' || ch === ')') wordDynamic = true
    // 引号外的命令替换 / 反引号：词里可能带出可执行内容
    if (ch === '`' || (ch === '$' && text[i + 1] === '(')) {
      if (wordStart < 0) wordStart = i
      wordDynamic = true
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flushWord(i)
      i += 1
      continue
    }
    if (ch === '\n' || ch === '\r' || ch === ';') {
      flushWord(i)
      endSegment(false)
      i += 1
      continue
    }
    if (ch === '&') {
      // && 与 & 都切断命令；&> 之类的重定向目标交给后面的 > 分支处理
      flushWord(i)
      i += text[i + 1] === '&' ? 2 : 1
      endSegment(false)
      continue
    }
    if (ch === '|') {
      flushWord(i)
      const single = text[i + 1] !== '|'
      i += single ? 1 : 2
      endSegment(single)
      continue
    }
    if (ch === '>' || ch === '<') {
      flushWord(i)
      if (argLimit < 0) argLimit = words.length
      i += 1
      while (i < text.length && (text[i] === '>' || text[i] === '<' || text[i] === '&')) i += 1
      continue
    }
    if (wordStart < 0) wordStart = i
    i += 1
  }
  flushWord(text.length)
  endSegment(false)
  return segments
}

/** 仅识别标准系统目录；任意路径下同名程序仍视为未知命令。 */
function readCommandName(word: ShellWord, text: string): string {
  return text.slice(word.start, word.end).replace(/^['"]+|['"]+$/g, '').replace(/^\/(?:usr\/)?bin\//, '')
}

/** 定位真正的命令词下标：跳过前置赋值（FOO=bar）与 sudo 等前缀及其选项 */
function commandWordIndex(segment: ShellSegment, text: string): number {
  const limit = segment.argLimit
  let idx = 0
  while (idx < limit) {
    const word = text.slice(segment.words[idx].start, segment.words[idx].end)
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) break
    idx += 1
  }
  while (idx < limit) {
    if (!COMMAND_PREFIXES.has(readCommandName(segment.words[idx], text))) break
    idx += 1
    while (idx < limit) {
      const option = text.slice(segment.words[idx].start, segment.words[idx].end)
      if (!option.startsWith('-')) break
      idx += 1
      if (PREFIX_VALUE_OPTIONS.has(option)) idx += 1
    }
  }
  return idx < limit ? idx : -1
}

/**
 * 收集"确定为纯文字参数"的字符区间。只有 grep/rg/echo/printf 的参数区
 * （且不含命令替换、整条管道不流向解释器、不越过重定向符）算纯文字。
 */
function collectLiteralTextRanges(text: string): Array<[number, number]> {
  // Ctrl+C、退格等会改变 PTY 正在编辑的命令，不能按纯 shell 参数推断。
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return []
  const segments = splitShellSegments(text)
  const ranges: Array<[number, number]> = []
  // 替换内的输出可再次交给 eval / sh 执行，不能只检查当前段。无法完整解析时回退原规则。
  if (segments.some(segment => segment.words.some(word => word.dynamic))) return ranges
  // 明确存在再次解释文字 / 动态命令名时，不猜测跨段的数据流。
  if (segments.some(segment => {
    const idx = commandWordIndex(segment, text)
    if (idx < 0) return false
    const command = readCommandName(segment.words[idx], text)
    return CODE_COMMANDS.has(command) || command.includes('$') ||
      // rg 的预处理器和主机名程序会执行参数，不能当成搜索文字。
      command === 'rg' && segment.words.slice(idx + 1).some(word =>
        /^--(?:pre|hostname-bin)(?:=|$)/.test(readCommandName(word, text))) ||
      command === 'printf' && segment.words.slice(idx + 1).some(word => text.slice(word.start, word.end) === '-v')
  })) return ranges

  // 管道分组：下游无法确定是纯文字处理时，整条管道都不放行
  let groupStart = 0
  while (groupStart < segments.length) {
    let groupEnd = groupStart
    while (groupEnd < segments.length - 1 && segments[groupEnd].pipedToNext) groupEnd += 1

    let executesDownstream = false
    for (let i = groupStart + 1; i <= groupEnd; i++) {
      const cmdIndex = commandWordIndex(segments[i], text)
      if (cmdIndex < 0 || !TEXT_PIPE_COMMANDS.has(readCommandName(segments[i].words[cmdIndex], text))) {
        executesDownstream = true
      }
    }

    if (!executesDownstream) {
      for (let i = groupStart; i <= groupEnd; i++) {
        const segment = segments[i]
        const cmdIndex = commandWordIndex(segment, text)
        if (cmdIndex < 0) continue
        if (!TEXT_ARG_COMMANDS.has(readCommandName(segment.words[cmdIndex], text))) continue
        // 段内出现命令替换/反引号：可能藏可执行内容，整段不放行
        if (segment.words.some(word => word.dynamic)) continue
        for (let w = cmdIndex + 1; w < segment.argLimit; w++) {
          ranges.push([segment.words[w].start, segment.words[w].end])
        }
      }
    }

    groupStart = groupEnd + 1
  }
  return ranges
}

/** 取 pattern 的第一个"不在纯文字参数内"的命中；全都落在文字里则视为未命中 */
function firstExecutableMatch(
  pattern: RegExp,
  text: string,
  literalRanges: ReadonlyArray<[number, number]>
): RegExpExecArray | null {
  if (literalRanges.length === 0) return pattern.exec(text)
  const global = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g')
  // 区间与匹配均按原文顺序排列，单向推进，避免长参数列表退化为平方扫描。
  let rangeIndex = 0
  let match = global.exec(text)
  while (match !== null) {
    const start = match.index
    const end = start + match[0].length
    while (rangeIndex < literalRanges.length && literalRanges[rangeIndex][1] <= start) rangeIndex += 1
    const range = literalRanges[rangeIndex]
    if (!range || start < range[0] || end > range[1]) {
      return match
    }
    if (match[0].length === 0) global.lastIndex += 1
    match = global.exec(text)
  }
  return null
}

/**
 * 扫描文本是否含破坏性命令。返回命中的 pattern 列表（空数组 = 安全）。
 * 每个 pattern 至多记一条命中（取首次匹配），避免重复刷屏。
 */
export function scanDestructiveCommand(text: string): DestructiveMatch[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const matches: DestructiveMatch[] = []
  // 文字区间按需计算一次（只有 literalTextArgs 规则用得到）
  let literalRanges: Array<[number, number]> | null = null
  for (const p of DESTRUCTIVE_PATTERNS) {
    const m = p.literalTextArgs
      ? firstExecutableMatch(p.pattern, text, (literalRanges ??= collectLiteralTextRanges(text)))
      : p.pattern.exec(text)
    if (m) {
      const snippet = m[0].length > MAX_SNIPPET_LEN
        ? m[0].slice(0, MAX_SNIPPET_LEN) + '...'
        : m[0]
      matches.push({ name: p.name, description: p.description, snippet })
    }
  }
  return matches
}
