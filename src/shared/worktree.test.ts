import { describe, it, expect } from 'vitest'
import { generateWorktreeCode, generateWorktreeKey, joinWorktreePath, validateWorktreeKey } from './worktree'

/** 悬空代理检测：先剔除完整代理对，仍剩代理单元才真悬空（会渲染成 U+FFFD） */
const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))

describe('generateWorktreeCode', () => {
  it('恒为默认 4 位小写字母数字', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateWorktreeCode()).toMatch(/^[a-z0-9]{4}$/)
    }
  })

  it('自定义长度生效', () => {
    expect(generateWorktreeCode(8)).toMatch(/^[a-z0-9]{8}$/)
  })
})

describe('generateWorktreeKey', () => {
  it('常规名：kind-名称-代号', () => {
    expect(generateWorktreeKey('claude', 'lyshell', 'x7k2')).toBe('claude-lyshell-x7k2')
  })

  it('ref 非法字符与空白折叠、大小写保留', () => {
    expect(generateWorktreeKey('dsh', 'My Repo~2', 'ab12')).toBe('dsh-My-Repo-2-ab12')
    expect(generateWorktreeKey('codex', '-lead.', 'ab12')).toBe('codex-lead-ab12')
  })

  it('空名/纯空白名 → kind-代号', () => {
    expect(generateWorktreeKey('claude', '', 'x7k2')).toBe('claude-x7k2')
    expect(generateWorktreeKey('claude', '   ', 'x7k2')).toBe('claude-x7k2')
  })

  it('全折叠名（sanitize 兜底 wt 伪影）丢弃名称段 → kind-代号', () => {
    expect(generateWorktreeKey('claude', '~~~', 'x7k2')).toBe('claude-x7k2')
    expect(generateWorktreeKey('claude', '..--', 'x7k2')).toBe('claude-x7k2')
  })

  it("字面 'wt' 名正常保留（非伪影）", () => {
    expect(generateWorktreeKey('claude', 'wt', 'x7k2')).toBe('claude-wt-x7k2')
  })

  it('超长名按总长 64 预算截断', () => {
    const long = 'a'.repeat(200)
    for (const kind of ['dsh', 'codex', 'claude']) {
      const key = generateWorktreeKey(kind, long, 'x7k2')
      expect(key.length).toBeLessThanOrEqual(64)
      expect(key).toBe(`${kind}-${'a'.repeat(64 - kind.length - 6)}-x7k2`)
    }
  })

  it('截断边界落在代理对中间时摘除悬空高位代理（不产生 U+FFFD）', () => {
    // claude/x7k2 的名称预算 = 64-6-4-2 = 52；51 个 x 后恰好是 🤖 的高位代理
    const key = generateWorktreeKey('claude', 'x'.repeat(51) + '🤖', 'x7k2')
    expect(key).toBe(`claude-${'x'.repeat(51)}-x7k2`)
    expect(hasLoneSurrogate(key)).toBe(false)
    expect(validateWorktreeKey(key).ok).toBe(true)
  })

  it('预算内的 emoji 完整保留', () => {
    const key = generateWorktreeKey('claude', 'repo-🤖', 'x7k2')
    expect(key).toBe('claude-repo-🤖-x7k2')
    expect(hasLoneSurrogate(key)).toBe(false)
  })

  it('病态超长 kind 的 64 兜底截断同样不产生悬空代理', () => {
    // name 参与时总长恒 ≤ 64，进不了兜底分支；兜底只由超长 kind/code 触发。
    // kind = 'a'×63 + 🤖（65 units）→ key 超长，slice(0,64) 恰好截在 🤖 的代理对中间
    const key = generateWorktreeKey('a'.repeat(63) + '🤖', 'name', 'b'.repeat(10))
    expect(key).toBe('a'.repeat(63))
    expect(hasLoneSurrogate(key)).toBe(false)
    expect(validateWorktreeKey(key).ok).toBe(true)
  })

  it('核心不变量：对抗样本批量恒过 validateWorktreeKey', () => {
    const adversarial = [
      '', ' ', '\t', '~~~', '^', ':', '?', '*', '[', '\\', '/', 'a/b', 'a\\b', '..', '.', '-x-', '.x.',
      'name with spaces', '中文工作区', 'mixed-中文~x', 'a.b_c-d', 'CTRL\x01char', '  padded  ',
      'e'.repeat(100), 'emoji-🤖-name', 'tab\tsep', 'tilde~', 'colon:', 'star*', 'brack[', 'back\\',
      'x'.repeat(51) + '🤖', '🤖'.repeat(60)
    ]
    for (const name of adversarial) {
      for (const kind of ['dsh', 'codex', 'claude']) {
        const key = generateWorktreeKey(kind, name, 'ab12')
        // 截断不得产生悬空代理（渲染成 U+FFFD）；完整代理对（emoji）不受影响
        expect(hasLoneSurrogate(key)).toBe(false)
        // 失败时把 kind/name/key 带进断言信息，便于定位是哪个样本破防
        expect({ kind, name, key, ok: validateWorktreeKey(key).ok }).toEqual({ kind, name, key, ok: true })
      }
    }
  })

  it('核心不变量对任意 kind/code 输入也成立（未来暴露为通用 API 的兜底）', () => {
    const hostileSegments = [
      '', '/', '\\', 'a/b', 'a\\b', '~~~', '..', '.', '-x-', 'CTRL\x01', 'Kind With Space', '中文',
      'a'.repeat(100)
    ]
    for (const kind of hostileSegments) {
      for (const code of hostileSegments) {
        const key = generateWorktreeKey(kind, 'lyshell', code)
        // 失败时把 kind/code/key 带进断言信息，便于定位是哪个样本破防
        expect({ kind, code, key, ok: validateWorktreeKey(key).ok }).toEqual({ kind, code, key, ok: true })
      }
    }
  })
})

describe('joinWorktreePath', () => {
  it('win32 根路径沿用反斜杠拼接', () => {
    expect(joinWorktreePath('D:\\repo\\.lyshell-worktrees', 'claude-lyshell-x7k2'))
      .toBe('D:\\repo\\.lyshell-worktrees\\claude-lyshell-x7k2')
  })

  it('POSIX 根路径沿用正斜杠拼接', () => {
    expect(joinWorktreePath('/home/user/repo/.lyshell-worktrees', 'claude-lyshell-x7k2'))
      .toBe('/home/user/repo/.lyshell-worktrees/claude-lyshell-x7k2')
  })
})
