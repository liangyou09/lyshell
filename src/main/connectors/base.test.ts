/**
 * BaseConnector 编码机制单测 —— setEncoding 的切档重建 / 同值短路 / 写方向编码。
 * 运行时编码切换(状态栏点击)的核心行为:读方向 decoder 换流后按新编码解字节,
 * 同值重设不得重建流(半截多字节会被 end() 冲成 �),写方向 gbk/gb2312 要转字节。
 * LocalConnector 的空实现语义在 local.test.ts 的 LocalConnector 语境外,此处用
 * 最小桩子类驱动 Base 基类本身。
 */
import { describe, it, expect, vi } from 'vitest'
import iconv from 'iconv-lite'

// electron-log 对齐既有测试的 mock 手法(不 mock 会在 vitest Node 环境加载失败)
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
}))

import { BaseConnector } from './base'
import type { TerminalEncoding } from '@shared/types'

/** 最小桩:抽象方法全空实现,暴露 feed(喂解码流)与 lastWrite(记录写方向产物) */
class TestConnector extends BaseConnector {
  lastWrite: string | Buffer | null = null
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  write(data: string | Buffer): void {
    this.lastWrite = this.encodeOut(data)
  }
  resize(_cols: number, _rows: number): void {}
  /** 喂解码流(真实连接器在 data 事件里做同样的事) */
  feed(chunk: Buffer): void {
    this.decoder?.write(chunk)
  }
  /** 暴露 protected replaceDecoder 供测试建立初始解码流 */
  rebuild(): void {
    this.replaceDecoder()
  }
}

/** 收集 data 事件的便捷挂载 */
const collectData = (c: BaseConnector): string[] => {
  const out: string[] = []
  c.on('data', (s: string) => out.push(s))
  return out
}

describe('BaseConnector.setEncoding 读方向', () => {
  it('切换后按新编码解码字节流', () => {
    const c = new TestConnector('s1', 'utf-8')
    c.rebuild()
    const out = collectData(c)
    c.setEncoding('gbk')
    c.feed(iconv.encode('中文', 'gbk'))
    expect(out.join('')).toBe('中文')
  })

  it('切档重建解码流:旧编码的字节不再按旧编码解', () => {
    const c = new TestConnector('s1', 'utf-8')
    c.rebuild()
    const out = collectData(c)
    // gbk 编码的「中」两个字节在 utf-8 流里必然是非法序列
    c.setEncoding('utf-8')
    c.feed(iconv.encode('中', 'gbk'))
    expect(out.join('')).not.toBe('中')
    // 换到 gbk 后同样的字节解出「中」(流已被重建,残留的 utf-8 流状态不干扰)
    c.setEncoding('gbk')
    c.feed(iconv.encode('中', 'gbk'))
    expect(out.join('')).toContain('中')
  })

  it('同值短路:重设当前编码不重建流,半截多字节序列不被冲成替换字符', () => {
    const c = new TestConnector('s1', 'gbk')
    c.rebuild()
    const out = collectData(c)
    // 「中」= gbk 0xD6 0xD0,先喂一半
    const bytes = iconv.encode('中', 'gbk')
    c.feed(Buffer.from([bytes[0]]))
    // 同值重设 —— 若未短路,replaceDecoder 会 end() 旧流(半截序列吐 �)再建新流,
    // 后半字节落在新流里也解不出原字
    c.setEncoding('gbk')
    c.feed(Buffer.from([bytes[1]]))
    expect(out.join('')).toBe('中')
  })

  it('getEncoding 反映切档后的值', () => {
    const c = new TestConnector('s1', 'utf-8')
    expect(c.getEncoding()).toBe('utf-8')
    c.setEncoding('gb2312')
    expect(c.getEncoding()).toBe('gb2312')
  })
})

describe('BaseConnector 写方向 encodeOut', () => {
  it('gbk 时字符串按 gbk 转字节(utf-8 设备上中文输入不乱码的对称路径)', () => {
    const c = new TestConnector('s1', 'gbk')
    c.write('中')
    expect(c.lastWrite).toEqual(iconv.encode('中', 'gbk'))
  })

  it('utf-8 时字符串原样透传(Node 写入即按 UTF-8 编码)', () => {
    const c = new TestConnector('s1', 'utf-8')
    c.write('中')
    expect(c.lastWrite).toBe('中')
  })

  it('Buffer 入参不转(已是字节,无须再编码)', () => {
    const c = new TestConnector('s1', 'gbk')
    const buf = Buffer.from([0x01, 0x02])
    c.write(buf)
    expect(c.lastWrite).toBe(buf)
  })
})

describe('BaseConnector 构造缺省', () => {
  it('encoding 缺省 utf-8', () => {
    const c = new TestConnector('s1')
    expect(c.getEncoding()).toBe('utf-8' as TerminalEncoding)
  })
})
