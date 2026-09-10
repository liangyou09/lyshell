/**
 * sanitizeSessionEncoding 单测 —— 白名单回落 / local 归一化 / 历史脏数据三组行为。
 * 净化器是存盘收口(repository load/save)与 IPC 信任边界(create/update)共用的
 * 唯一 choke point,这里的用例直接对应三类入站来源:UI 表单、导入文件、历史盘数据。
 */
import { describe, it, expect } from 'vitest'
import { sanitizeSessionEncoding } from './encoding'
import { ConnectionType } from './types'
import type { SessionConfig } from './types'

/** 造一份最小合法 SessionConfig(terminal 允许后续按用例改写) */
const baseConfig = (type: ConnectionType): SessionConfig => ({
  id: 's1',
  name: 'test',
  type,
  terminal: {
    fontFamily: 'Consolas',
    fontSize: 14,
    theme: {} as SessionConfig['terminal']['theme'],
    cursorStyle: 'bar',
    cursorBlink: false,
    scrollback: 1000,
    encoding: 'utf-8'
  },
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date()
})

describe('sanitizeSessionEncoding 白名单', () => {
  it('白名单内的值原样保留', () => {
    for (const enc of ['utf-8', 'gbk', 'gb2312'] as const) {
      const config = baseConfig(ConnectionType.SSH)
      config.terminal.encoding = enc
      sanitizeSessionEncoding(config)
      expect(config.terminal.encoding).toBe(enc)
    }
  })

  it('白名单外的字符串回落 utf-8', () => {
    const config = baseConfig(ConnectionType.SSH)
    config.terminal.encoding = 'big5' as SessionConfig['terminal']['encoding']
    sanitizeSessionEncoding(config)
    expect(config.terminal.encoding).toBe('utf-8')
  })

  it('undefined / 数字等非法值回落 utf-8(历史盘数据)', () => {
    for (const bad of [undefined, 0, null, '']) {
      const config = baseConfig(ConnectionType.SSH)
      // 历史数据里 terminal.encoding 可能是任意 JSON
      ;(config.terminal as unknown as Record<string, unknown>).encoding = bad
      sanitizeSessionEncoding(config)
      expect(config.terminal.encoding).toBe('utf-8')
    }
  })
})

describe('sanitizeSessionEncoding local 归一化', () => {
  it('local + gbk 归一为 utf-8(ConPTY 恒 UTF-8,存别的值是脏数据)', () => {
    const config = baseConfig(ConnectionType.LOCAL)
    config.terminal.encoding = 'gbk'
    sanitizeSessionEncoding(config)
    expect(config.terminal.encoding).toBe('utf-8')
  })

  it('local + 非法值同样归一为 utf-8', () => {
    const config = baseConfig(ConnectionType.LOCAL)
    ;(config.terminal as unknown as Record<string, unknown>).encoding = 'big5'
    sanitizeSessionEncoding(config)
    expect(config.terminal.encoding).toBe('utf-8')
  })

  it('ssh/telnet/serial 的合法非 UTF-8 值不受 local 归一化影响', () => {
    for (const type of [ConnectionType.SSH, ConnectionType.TELNET, ConnectionType.SERIAL]) {
      const config = baseConfig(type)
      config.terminal.encoding = 'gbk'
      sanitizeSessionEncoding(config)
      expect(config.terminal.encoding).toBe('gbk')
    }
  })
})

describe('sanitizeSessionEncoding 形状容错', () => {
  it('terminal 缺省 / 非对象时静默放过,不抛错', () => {
    for (const bad of [undefined, null, 'utf-8', 42]) {
      const config = baseConfig(ConnectionType.SSH)
      ;(config as unknown as Record<string, unknown>).terminal = bad
      expect(() => sanitizeSessionEncoding(config)).not.toThrow()
      expect((config as unknown as Record<string, unknown>).terminal).toBe(bad)
    }
  })
})
