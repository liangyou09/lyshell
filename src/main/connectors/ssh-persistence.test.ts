import { describe, expect, it } from 'vitest'
import {
  buildTmuxAttachCommand,
  buildTmuxEnsureSessionCommand,
  buildTmuxKillSessionCommand,
  buildTmuxProbeCommand,
  deriveRemoteSessionName,
  isSafeRemoteSessionName,
  parseTmuxPath,
  REMOTE_SESSION_NAME_PREFIX,
  sanitizeRemoteSessionName,
  shellQuote,
  TMUX_EXIT_SESSION_MISSING
} from './ssh-persistence'

describe('远端会话名白名单', () => {
  it.each(['lyshell-123', 'abc', 'A_b-9', 'a'.repeat(64)])('接受 %s', name => {
    expect(isSafeRemoteSessionName(name)).toBe(true)
  })

  it.each([
    '',
    'a'.repeat(65),
    '-starts-with-dash',
    'has space',
    'has;rm',
    'has$(id)',
    'has`id`',
    'has\'quote',
    'has"quote',
    'has/slash',
    '有中文',
    'has\nnewline',
    'has\\backslash'
  ])('拒绝 %s', name => {
    expect(isSafeRemoteSessionName(name)).toBe(false)
  })

  it('sanitize 只允许首尾空白，其余一律拒绝', () => {
    expect(sanitizeRemoteSessionName('  abc-123 \n')).toBe('abc-123')
    expect(sanitizeRemoteSessionName('abc; rm -rf /')).toBeNull()
    expect(sanitizeRemoteSessionName('   ')).toBeNull()
    // 不能做「过滤非法字符后再执行」的猜测式修复
    expect(sanitizeRemoteSessionName('abc$(id)')).toBeNull()
  })
})

describe('会话名派生', () => {
  it('同一 runtime id 派生稳定名字，可重复附着', () => {
    const first = deriveRemoteSessionName('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')
    expect(first).toBe(deriveRemoteSessionName('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'))
    expect(first.startsWith(REMOTE_SESSION_NAME_PREFIX)).toBe(true)
    expect(isSafeRemoteSessionName(first)).toBe(true)
  })

  it('不同 runtime id 派生不同名字，终端之间不撞车', () => {
    expect(deriveRemoteSessionName('session-a')).not.toBe(deriveRemoteSessionName('session-b'))
    expect(deriveRemoteSessionName('a/b')).not.toBe(deriveRemoteSessionName('a.b'))
    expect(deriveRemoteSessionName('x'.repeat(100) + 'a')).not.toBe(deriveRemoteSessionName('x'.repeat(100) + 'b'))
  })

  it('非法/超长 id 也派生安全名（不能把任意 id 拼成命令）', () => {
    for (const id of ['a b; rm -rf /', '有中文', '-', '', 'x'.repeat(300), '$(id)`id`']) {
      const name = deriveRemoteSessionName(id)
      expect(isSafeRemoteSessionName(name)).toBe(true)
      expect(name.length).toBeLessThanOrEqual(64)
      expect(name).not.toMatch(/[^A-Za-z0-9_-]/)
    }
  })
})

describe('shell 转义', () => {
  it('单引号包裹并转义内部单引号', () => {
    expect(shellQuote('abc')).toBe("'abc'")
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
    expect(shellQuote('$(id); rm -rf /')).toBe("'$(id); rm -rf /'")
  })

  it('反引号/双引号/换行都锁在单引号里，不会被解释', () => {
    const quoted = shellQuote('`id` "x" \n ;')
    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted.endsWith("'")).toBe(true)
    // 除末尾和转义用的引号外，不出现裸露的双引号解释
    expect(quoted).toBe(`'\`id\` "x" \n ;'`)
  })
})

describe('tmux 命令构造', () => {
  it('探测脚本包含 PATH 探测与常见绝对路径候选', () => {
    const script = buildTmuxProbeCommand()
    expect(script).toContain('command -v tmux')
    expect(script).toContain('/usr/local/bin/tmux')
    expect(script).toContain('/opt/homebrew/bin/tmux')
    expect(script).not.toContain('tmux new-session')
  })

  it('parseTmuxPath 只接受绝对路径，忽略噪声', () => {
    expect(parseTmuxPath('/usr/bin/tmux\n')).toBe('/usr/bin/tmux')
    expect(parseTmuxPath('\n  /opt/homebrew/bin/tmux  \n')).toBe('/opt/homebrew/bin/tmux')
    expect(parseTmuxPath('tmux\n')).toBeNull()
    expect(parseTmuxPath('alias tmux=...')).toBeNull()
    expect(parseTmuxPath('')).toBeNull()
  })

  it('恢复模式（create=false）绝不包含 new-session，只做 has-session', () => {
    const script = buildTmuxEnsureSessionCommand({ tmuxPath: '/usr/bin/tmux', sessionName: 'abc', create: false })
    expect(script).toContain('has-session')
    expect(script).not.toContain('new-session')
    expect(script).toContain(`exit ${TMUX_EXIT_SESSION_MISSING}`)
    expect(script).toContain("'=abc'")
  })

  it('新建模式包含 new-session，目标同样用精确匹配', () => {
    const script = buildTmuxEnsureSessionCommand({ tmuxPath: '/usr/bin/tmux', sessionName: 'abc', create: true })
    expect(script).toContain('has-session')
    expect(script).toContain('new-session -d -s')
    expect(script).toContain("printf 'existing\\n'")
    expect(script).toContain("printf 'created\\n'")
    expect(script).not.toContain('attach-session')
  })

  it('附着/销毁命令使用绝对路径与 = 精确目标', () => {
    expect(buildTmuxAttachCommand({ tmuxPath: '/usr/bin/tmux', sessionName: 'abc' })).toBe(
      "'/usr/bin/tmux' attach-session -t '=abc'"
    )
    expect(buildTmuxKillSessionCommand({ tmuxPath: '/usr/bin/tmux', sessionName: 'abc' })).toBe(
      "'/usr/bin/tmux' kill-session -t '=abc'"
    )
  })

  it('名字里的危险字符进不了 ensure 脚本（白名单在上一层就已拒绝）', () => {
    const script = buildTmuxEnsureSessionCommand({
      tmuxPath: '/usr/bin/tmux',
      sessionName: "abc'; rm -rf / #",
      create: true
    })
    // 即使被直接调用，也只会作为转义后的单引号字符串出现
    expect(script).toContain(`'abc'\\''; rm -rf / #'`)
  })
})
