/**
 * glob → 正则编译（A5：list_files 的 glob 过滤）。
 *
 * 支持：
 *   - **  跨分隔符任意（含 /）
 *   - *   非分隔符任意
 *   - ?   单个非分隔符
 *   - [abc] / [!abc]  字符类（! 取反）
 * 大小写敏感，锚定整条路径。未闭合的 [ 按字面量处理。
 *
 * 不引入 minimatch 依赖：list_files 的过滤场景只需要常见模式。
 */

export function compileGlob(pattern: string): (p: string) => boolean {
  let re = '^'
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i += 2
      if (pattern[i] === '/') i++ // **/ 的分隔符交给 .* 吸收
    } else if (c === '*') {
      re += '[^/]*'
      i++
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end === -1) {
        re += '\\['
        i++
      } else {
        let inner = pattern.slice(i + 1, end)
        if (inner.startsWith('!')) inner = '^' + inner.slice(1)
        inner = inner.replace(/\\/g, '\\\\')
        re += '[' + inner + ']'
        i = end + 1
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i++
    }
  }
  re += '$'
  const regex = new RegExp(re)
  return (p: string) => regex.test(p)
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
