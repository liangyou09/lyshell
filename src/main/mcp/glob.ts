/**
 * glob → 无回溯状态机（A5：list_files 的 glob 过滤）。
 *
 * 支持：
 *   - **  跨分隔符任意（含 /）
 *   - *   非分隔符任意
 *   - ?   单个非分隔符
 *   - [abc] / [!abc]  字符类（! 取反）
 * 大小写敏感，锚定整条路径。未闭合的 [ 按字面量处理。
 *
 * 不引入 minimatch 依赖：list_files 的过滤场景只需要常见模式。
 *
 * 模式长度上限（UTF-16 码元）在编译分配 token/闭包之前检查：匹配阶段的无回溯
 * 保证不了编译阶段的内存，逐字符 token 对超长输入是线性放大，必须在入口先拒绝。
 */

/** glob 模式的 UTF-16 码元上限；HTTP 入口与编译器共用，避免两处漂移。 */
export const GLOB_PATTERN_MAX_LENGTH = 4096

/** 超长模式的错误信息；只带长度，不回显模式内容。 */
export function globPatternTooLongMessage(length: number): string {
  return `glob pattern exceeds ${GLOB_PATTERN_MAX_LENGTH} UTF-16 characters (received ${length})`
}

/** 在编译分配前拒绝超长模式；带类型便于入口区分 400 与真实故障。 */
export class GlobPatternTooLongError extends Error {
  readonly length: number

  constructor(length: number) {
    super(globPatternTooLongMessage(length))
    this.name = 'GlobPatternTooLongError'
    this.length = length
  }
}

function assertGlobPatternLength(pattern: string): void {
  if (pattern.length > GLOB_PATTERN_MAX_LENGTH) throw new GlobPatternTooLongError(pattern.length)
}

type GlobToken = { repeat: boolean; accepts: (char: string) => boolean }
interface GlobMatcher {
  (path: string): boolean
  /** 分片推进同一状态机；undefined 表示调用方预算已耗尽。 */
  matchAsync(path: string, stopped: () => boolean): Promise<boolean | undefined>
}

export function compileGlob(pattern: string): GlobMatcher {
  // 必须在分配 tokens 之前：这是唯一一处为每个模式字符创建对象/闭包的代码。
  assertGlobPatternLength(pattern)
  const tokens: GlobToken[] = []
  const nonSeparator = (char: string) => char !== '/'
  const dot = (char: string) => !'\n\r\u2028\u2029'.includes(char)
  let i = 0
  let noClosingBracket = false
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      tokens.push({ repeat: true, accepts: dot })
      i += 2
      if (pattern[i] === '/') i++ // **/ 的分隔符交给 .* 吸收
    } else if (c === '*') {
      tokens.push({ repeat: true, accepts: nonSeparator })
      i++
    } else if (c === '?') {
      tokens.push({ repeat: false, accepts: nonSeparator })
      i++
    } else if (c === '[') {
      const end = noClosingBracket ? -1 : pattern.indexOf(']', i + 1)
      if (end === -1) {
        noClosingBracket = true
        tokens.push({ repeat: false, accepts: char => char === '[' })
        i++
      } else {
        let inner = pattern.slice(i + 1, end)
        if (inner.startsWith('!')) inner = '^' + inner.slice(1)
        inner = inner.replace(/\\/g, '\\\\')
        // 只用正则判断单个 UTF-16 字符的字符类，没有量词或回溯分支。
        const characterClass = new RegExp('^[' + inner + ']$')
        tokens.push({ repeat: false, accepts: char => characterClass.test(char) })
        i = end + 1
      }
    } else {
      tokens.push({ repeat: false, accepts: char => char === c })
      i++
    }
  }
  // NFA 动态规划：每个字符最多推进 tokens.length 个状态，空间 O(pattern)。
  // 不枚举 * 的分割组合，避免连续星号/字面量造成指数回溯。
  function* match(path: string): Generator<void, boolean> {
    let previous = new Uint8Array(tokens.length + 1)
    let next = new Uint8Array(tokens.length + 1)
    let work = 0
    previous[0] = 1
    for (let j = 0; j < tokens.length; j++) {
      previous[j + 1] = Number(tokens[j].repeat && previous[j] === 1)
      if (++work % 4096 === 0) yield
    }
    for (let k = 0; k < path.length; k++) {
      next[0] = 0
      for (let j = 0; j < tokens.length; j++) {
        const token = tokens[j]
        next[j + 1] = Number(token.repeat
          ? next[j] === 1 || (previous[j + 1] === 1 && token.accepts(path[k]))
          : previous[j] === 1 && token.accepts(path[k]))
        if (++work % 4096 === 0) yield
      }
      const swap = previous
      previous = next
      next = swap
    }
    return previous[tokens.length] === 1
  }
  const matcher = (path: string) => {
    const steps = match(path)
    let step = steps.next()
    while (!step.done) step = steps.next()
    return step.value
  }
  return Object.assign(matcher, {
    async matchAsync(path: string, stopped: () => boolean) {
      const steps = match(path)
      while (!stopped()) {
        const step = steps.next()
        if (step.done) return step.value
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      return undefined
    }
  })
}

/**
 * 计算 absPath 相对 root 的路径（用于 glob 匹配）；无前缀时原样返回。
 * 例：relPath('/var/log', '/var/log/app/server.log') → 'app/server.log'
 *
 * 边界：用 root + '/' 做前缀判断，避免 /var/log 与 /var/logs 被误判为父子。
 * root 为 '/' 时 endsWith('/') 已满足，prefix 即 '/'。
 */
export function relPath(root: string, absPath: string): string {
  if (absPath === root) return ''
  const prefix = root.endsWith('/') ? root : root + '/'
  if (absPath.startsWith(prefix)) {
    return absPath.slice(prefix.length)
  }
  return absPath
}
