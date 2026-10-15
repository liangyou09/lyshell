/**
 * 源码 PS7 启动器逻辑回归（examples/lyshell-src-ps7 + petlink-src-ps7 共用 launcher.js）。
 *
 * 在 Node 里用 mock 的 window/document/lyshellView 驱动页面 IIFE，断言
 * 「点图标 → 找/建保存会话 → openTerminal」的调用序列。launcher 是页面脚本
 * 不是 src 模块，故走 vm 域执行；config.js 与 launcher.js 必须分两次 runInContext
 * （与浏览器两个 <script src> 一致，ASI 不跨文件）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const EXAMPLES = dirname(fileURLToPath(import.meta.url))

interface Call { tool: string; args: Record<string, unknown> }

interface SavedSession { id: string; name: string; inTerminal: boolean; type?: string; shell?: string; cwd?: string }

const localTarget = { type: 'local', shell: 'pwsh', cwd: 'D:\\workspace\\claude\\LyShell' }

function makeHarness(opts: { savedSessions?: SavedSession[]; createResult?: Record<string, unknown> }) {
  const calls: Call[] = []
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const docListeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const el = (id: string) => ({
    id,
    textContent: '',
    className: '',
    disabled: false,
    addEventListener: (ev: string, fn: (...a: unknown[]) => void) => {
      (listeners[`${id}:${ev}`] ||= []).push(fn)
    }
  })
  const els: Record<string, ReturnType<typeof el>> = {
    status: el('status'), open: el('open'), title: el('title'), path: el('path')
  }

  const callApi = (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args })
    if (tool === 'lyshell_list_sessions') {
      const saved = opts.savedSessions ?? []
      return Promise.resolve({ sessions: saved, total: saved.length })
    }
    if (tool === 'lyshell_create_session') {
      return Promise.resolve(opts.createResult ?? {})
    }
    return Promise.reject(new Error(`unexpected tool ${tool}`))
  }
  const openTerminal = (sessionId: string) => {
    calls.push({ tool: 'openTerminal', args: { sessionId } })
    return Promise.resolve({ ok: true })
  }

  const sandbox: Record<string, unknown> = {
    window: {
      LAUNCHER_CONFIG: undefined,
      lyshellView: {
        bootstrap: () => Promise.resolve({ theme: 'dark' }),
        callApi,
        openTerminal,
        onEvent: () => () => {}
      },
      addEventListener: (ev: string, fn: (...a: unknown[]) => void) => {
        (listeners[`window:${ev}`] ||= []).push(fn)
      }
    },
    document: {
      getElementById: (id: string) => els[id],
      addEventListener: (ev: string, fn: (...a: unknown[]) => void) => {
        (docListeners[ev] ||= []).push(fn)
      },
      documentElement: { dataset: {} as Record<string, string> },
      visibilityState: 'visible'
    },
    Promise, setTimeout, clearTimeout, console
  }
  ;(sandbox.window as Record<string, unknown>).document = sandbox.document

  return {
    sandbox, calls, listeners, docListeners, els,
    fireWindow: (ev: string) => (listeners[`window:${ev}`] || []).forEach(f => f()),
    fireClick: () => (listeners['open:click'] || []).forEach(f => f()),
    tools: () => calls.map(c => c.tool)
  }
}

/** 装载 config.js + launcher.js 并触发 DOMContentLoaded（分两次 run，同浏览器） */
async function load(pluginDir: string, h: ReturnType<typeof makeHarness>): Promise<void> {
  vm.createContext(h.sandbox)
  vm.runInContext(readFileSync(join(EXAMPLES, pluginDir, 'views', 'config.js'), 'utf-8'), h.sandbox)
  vm.runInContext(readFileSync(join(EXAMPLES, pluginDir, 'views', 'launcher.js'), 'utf-8'), h.sandbox)
  h.fireWindow('DOMContentLoaded')
  await new Promise(r => setTimeout(r, 20))
}

describe('src-ps7 启动器（lyshell-src-ps7）', () => {
  const DIR = 'lyshell-src-ps7'

  it('无保存会话时 create_session(connect:false) 后 openTerminal', async () => {
    const h = makeHarness({ savedSessions: [], createResult: { sessionId: 'new-1' } })
    await load(DIR, h)
    expect(h.tools()[0]).toBe('lyshell_list_sessions')
    expect(h.tools()).toContain('lyshell_create_session')
    expect(h.tools()[h.tools().length - 1]).toBe('openTerminal')

    const create = h.calls.find(c => c.tool === 'lyshell_create_session')!
    expect(create.args.userConfirmed).toBe(true)
    expect(create.args.connect).toBe(false)
    expect((create.args.local as Record<string, unknown>).shell).toBe('pwsh')
    expect((create.args.local as Record<string, unknown>).cwd).toBe('D:\\workspace\\claude\\LyShell')

    expect(h.calls.find(c => c.tool === 'openTerminal')!.args.sessionId).toBe('new-1')
  })

  it('已开在终端里时自动触发跳过，不新开页签', async () => {
    const h = makeHarness({
      savedSessions: [{ ...localTarget, id: 's-1', name: 'LyShell 源码 PS7', inTerminal: true }],
      createResult: { sessionId: 'unused' }
    })
    await load(DIR, h)
    expect(h.tools()).not.toContain('openTerminal')
    expect(h.tools()).not.toContain('lyshell_create_session')
    expect(h.els.status.textContent).toContain('已在主区域打开')
  })

  it('未开终端时复用保存项 openTerminal；按钮 force 另开一个', async () => {
    const h = makeHarness({
      savedSessions: [{ ...localTarget, id: 's-2', name: 'LyShell 源码 PS7', inTerminal: false }],
      createResult: { sessionId: 'unused' }
    })
    await load(DIR, h)
    expect(h.tools()).toContain('openTerminal')
    expect(h.tools()).not.toContain('lyshell_create_session')
    expect(h.calls.find(c => c.tool === 'openTerminal')!.args.sessionId).toBe('s-2')

    // 切到「已开」后 force 仍应新开（按钮语义）
    const before = h.calls.filter(c => c.tool === 'openTerminal').length
    ;(h.sandbox.window as { lyshellView: { callApi: (tool: string, args: Record<string, unknown>) => Promise<unknown> } }).lyshellView.callApi = ((tool, args) => {
      h.calls.push({ tool, args })
      return Promise.resolve(tool === 'lyshell_list_sessions'
        ? { sessions: [{ ...localTarget, id: 's-2', name: 'LyShell 源码 PS7', inTerminal: true }] }
        : { sessionId: 'x' })
    }) as never
    h.fireClick()
    await new Promise(r => setTimeout(r, 20))
    expect(h.calls.filter(c => c.tool === 'openTerminal').length).toBe(before + 1)
  })

  it('会话名精确匹配，不误用子串命中的其它会话', async () => {
    const h = makeHarness({
      savedSessions: [
        { ...localTarget, id: 'other', name: 'LyShell 源码 PS7 备份', inTerminal: false },
        { ...localTarget, id: 'ssh', type: 'ssh', name: 'LyShell 源码 PS7', inTerminal: false },
        { ...localTarget, id: 'other-dir', cwd: 'D:\\other', name: 'LyShell 源码 PS7', inTerminal: false },
        { ...localTarget, id: 'other-shell', shell: 'cmd', name: 'LyShell 源码 PS7', inTerminal: false },
        { ...localTarget, id: 'exact', name: 'LyShell 源码 PS7', inTerminal: false }
      ],
      createResult: { sessionId: 'unused' }
    })
    await load(DIR, h)
    expect(h.calls.find(c => c.tool === 'openTerminal')!.args.sessionId).toBe('exact')
  })

  it('visibilitychange 监听已挂上（面板切回可见是重复触发入口）', async () => {
    const h = makeHarness({
      savedSessions: [{ ...localTarget, id: 's-3', name: 'LyShell 源码 PS7', inTerminal: false }],
      createResult: { sessionId: 'unused' }
    })
    await load(DIR, h)
    expect(h.docListeners.visibilitychange).toHaveLength(1)
    expect(h.calls.filter(c => c.tool === 'openTerminal')).toHaveLength(1)
  })
})

describe('src-ps7 启动器（petlink-src-ps7）', () => {
  it('目标目录/会话名指向 PetLink 源码', async () => {
    const h = makeHarness({ savedSessions: [], createResult: { sessionId: 'p-1' } })
    await load('petlink-src-ps7', h)
    const create = h.calls.find(c => c.tool === 'lyshell_create_session')!
    expect((create.args.local as Record<string, unknown>).cwd).toBe('D:\\workspace\\claude\\AIPet')
    expect(create.args.name).toBe('PetLink 源码 PS7')
    expect(h.calls.find(c => c.tool === 'openTerminal')!.args.sessionId).toBe('p-1')
  })
})
