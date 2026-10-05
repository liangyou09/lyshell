import { describe, expect, it } from 'vitest'
import type { PluginViewMeta } from './plugin-types'
import { matchesPluginWebOrigin, pluginWebOwner, uniquePluginWebOrigins } from './plugin-web-resources'

const view = (pluginId: string, ...connectOrigins: string[]): PluginViewMeta => ({
  pluginId, id: 'chat', title: '聊天', entry: 'views/chat.html', source: 'manifest', connectOrigins
})

describe('插件聊天服务归属', () => {
  it('按完整来源匹配，拒绝相似域名、其他端口、远程来源及畸形端口', () => {
    const origins = ['http://127.0.0.1:99999', 'http://127.0.0.1:31517']
    expect(matchesPluginWebOrigin('http://127.0.0.1:31517/ui/chat/', origins)).toBe(true)
    expect(matchesPluginWebOrigin('http://127.0.0.1:31518/ui/chat/', origins)).toBe(false)
    expect(matchesPluginWebOrigin('http://127.0.0.1.example.com:31517/', origins)).toBe(false)
    expect(matchesPluginWebOrigin('https://example.com/', ['https://example.com'])).toBe(false)
    expect(matchesPluginWebOrigin('not a url', origins)).toBe(false)
    expect(matchesPluginWebOrigin('http://[::1]/chat', ['http://[::1]'])).toBe(true)
  })

  it('默认端口归一化后共用的来源也不能独占或自动认领', () => {
    const views = [view('a', 'http://localhost:80', 'http://localhost:31517'), view('b', 'http://localhost')]
    expect(uniquePluginWebOrigins(views, 'a')).toEqual(['http://localhost:31517'])
    expect(pluginWebOwner('http://localhost/chat', views)).toBeUndefined()
    expect(pluginWebOwner('http://localhost:31517/chat', views)).toBe('a')
    expect(uniquePluginWebOrigins([view('a', 'http://localhost:99999', 'ws://localhost:31517')], 'a')).toEqual([])
  })
})
