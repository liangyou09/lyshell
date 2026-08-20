import { describe, it, expect } from 'vitest'
import { compileGlob, relPath } from './glob'

describe('compileGlob', () => {
  it('matches a simple extension pattern', () => {
    const m = compileGlob('*.log')
    expect(m('server.log')).toBe(true)
    expect(m('app.log')).toBe(true)
    expect(m('server.txt')).toBe(false)
    // * 不跨分隔符
    expect(m('dir/server.log')).toBe(false)
  })

  it('matches ** across path separators', () => {
    const m = compileGlob('**/*.conf')
    expect(m('app.conf')).toBe(true)
    expect(m('etc/app.conf')).toBe(true)
    expect(m('etc/sub/app.conf')).toBe(true)
    expect(m('app.txt')).toBe(false)
  })

  it('matches a nested suffix pattern with **', () => {
    const m = compileGlob('src/**/*.ts')
    expect(m('src/index.ts')).toBe(true)
    expect(m('src/a/b/c.ts')).toBe(true)
    // ** 后的 / 被吸收，但 src 之外不匹配
    expect(m('test/index.ts')).toBe(false)
  })

  it('matches ? as a single non-separator', () => {
    const m = compileGlob('?.txt')
    expect(m('a.txt')).toBe(true)
    expect(m('ab.txt')).toBe(false)
    expect(m('/.txt')).toBe(false)
  })

  it('matches character classes', () => {
    const m = compileGlob('*.[ch]')
    expect(m('main.c')).toBe(true)
    expect(m('main.h')).toBe(true)
    expect(m('main.cpp')).toBe(false)
  })

  it('matches negated character classes', () => {
    const m = compileGlob('*.[!ch]')
    expect(m('main.c')).toBe(false)
    expect(m('main.h')).toBe(false)
    expect(m('main.o')).toBe(true)
  })

  it('escapes regex metacharacters in literal segments', () => {
    const m = compileGlob('app+.log')
    expect(m('app+.log')).toBe(true)
    expect(m('apppp.log')).toBe(false)
  })

  it('treats unclosed [ as a literal', () => {
    const m = compileGlob('[abc.log')
    expect(m('[abc.log')).toBe(true)
    expect(m('a.log')).toBe(false)
  })

  it('is case-sensitive', () => {
    const m = compileGlob('*.LOG')
    expect(m('a.LOG')).toBe(true)
    expect(m('a.log')).toBe(false)
  })
})

describe('relPath', () => {
  it('strips the root prefix', () => {
    expect(relPath('/var/log', '/var/log/app/server.log')).toBe('app/server.log')
    expect(relPath('/var/log', '/var/log/x')).toBe('x')
  })

  it('returns empty for the root itself', () => {
    expect(relPath('/var/log', '/var/log')).toBe('')
  })

  it('returns the path verbatim when it does not start with root', () => {
    expect(relPath('/var/log', '/etc/passwd')).toBe('/etc/passwd')
  })

  it('does not false-match a sibling that shares a longer prefix', () => {
    // /var/logs 不是 /var/log 的子项——边界判断必须用 root + '/'
    expect(relPath('/var/log', '/var/logs/app.log')).toBe('/var/logs/app.log')
    expect(relPath('/var/log', '/var/log/app.log')).toBe('app.log')
  })

  it('handles root with trailing slash normalization via slice', () => {
    // root 不带尾斜杠；带前缀的子路径正常剥离
    expect(relPath('/home/u', '/home/u/a/b')).toBe('a/b')
  })

  it('handles root being /', () => {
    expect(relPath('/', '/a/b')).toBe('a/b')
    expect(relPath('/', '/')).toBe('')
  })
})
