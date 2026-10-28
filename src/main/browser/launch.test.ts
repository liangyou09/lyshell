import { describe, expect, it } from 'vitest'
import { BrowserLaunchQueue } from './launch'

describe('外部网页链接排队', () => {
  it('主窗口尚未创建时排队，批次只能认领一次，后续请求仍可消费', () => {
    const queue = new BrowserLaunchQueue()
    queue.enqueue('https://example.com/first')
    queue.enqueue('javascript:alert(1)')
    queue.enqueue('http://localhost/second')
    queue.consumerId = 12
    expect(queue.takeAll()).toEqual(['https://example.com/first', 'http://localhost/second'])
    expect(queue.takeAll()).toEqual([])
    queue.enqueue('https://example.com/third')
    expect(queue.takeAll()).toEqual(['https://example.com/third'])
  })
  it('等待窗口时限制内存占用', () => {
    const queue = new BrowserLaunchQueue()
    for (let index = 0; index < 200; index++) queue.enqueue(`https://example.com/${index}`)
    expect(queue.takeAll()).toHaveLength(128)
  })
})
