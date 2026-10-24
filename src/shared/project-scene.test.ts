import { describe, expect, it } from 'vitest'
import { parseProjectScene, parseSceneNode, sceneWebUrl } from './project-scene'

describe('project scene archive boundary', () => {
  const scene = { version: 1, id: 'save-1', savedAt: 1, target: { presetId: 'p', cwd: '/project', isolation: 'shared' }, directory: '/project', activeLeaf: 0, root: { type: 'leaf', entries: [{ kind: 'directory' }], active: 0 } }
  it('whitelists references and drops credentials, commands and runtime state', () => {
    const safe = parseProjectScene({ ...scene, env: { API_KEY: 'secret' }, processId: 123, commands: ['deploy'], root: { ...scene.root, entries: [{ kind: 'directory', command: 'deploy', token: 'secret' }] } })
    expect(JSON.stringify(safe)).not.toMatch(/secret|deploy|processId|commands/)
    expect(parseProjectScene(JSON.parse(JSON.stringify(safe)))).toEqual(safe)
  })
  it('rejects future versions, broken active tabs and excessive trees', () => {
    expect(() => parseProjectScene({ ...scene, version: 2 })).toThrow('version')
    expect(() => parseSceneNode({ ...scene.root, active: 9 })).toThrow()
    let root: unknown = scene.root
    for (let i = 0; i < 8; i++) root = { type: 'split', direction: 'horizontal', ratio: .5, first: root, second: scene.root }
    expect(() => parseSceneNode(root)).toThrow()
    expect(() => parseProjectScene({ ...scene, target: { ...scene.target, isolation: 'worktree', worktreeKey: '../other' } })).toThrow()
  })
  it.each(['https://example.com/?token=secret', 'https://example.com/?q=anything', 'https://example.com/#access_token=secret', 'https://user:password@example.com/', 'http://127.0.0.1:1234/', 'http://localhost/', 'https://example.com/oauth/callback', 'https://example.com/invite/abc', 'file:///etc/passwd', 'javascript:alert(1)', 'https://example.com/reset-password/a'])('excludes sensitive or transient web entry %s', url => {
    expect(sceneWebUrl(url)).toBeNull()
  })
  it('keeps ordinary document web paths', () => {
    expect(sceneWebUrl('https://example.com/docs/setup')).toBe('https://example.com/docs/setup')
  })
  it.each(['http://localhost./', 'http://service.localhost/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/'])('also excludes loopback alias %s', url => {
    expect(sceneWebUrl(url)).toBeNull()
  })
})
