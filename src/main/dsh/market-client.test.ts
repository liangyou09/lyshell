// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { createElement, act } from 'react'
import * as React from 'react'
import { createRoot } from 'react-dom/client'

afterEach(() => { window.history.replaceState({}, '', '/'); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('市场浏览器视图', () => {
  it('使用公开 market.render，隔离工作台导航并在卸载时清理', async () => {
    window.history.replaceState({}, '', '/?lyshellView=market')
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    document.body.innerHTML = '<div id="root">official shell</div>'
    const fetchSpy = vi.spyOn(window, 'fetch').mockRejectedValue(new Error('No viewer API in market view'))
    let plugin!: { apply: (context: unknown) => void }
    ;(window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
      load: (entry: { factory: (require: (id: string) => unknown) => typeof plugin }) => {
        plugin = entry.factory(() => React)
      }
    }
    new Function(readFileSync('resources/dsh-bridge/client.js', 'utf8'))()
    const cleanup: Array<() => void> = []
    const root = createRoot(document.getElementById('root')!)
    const entries: Array<{ priority: number; component: () => React.ReactNode }> = [
      { priority: 0, component: () => 'official shell' }
    ]
    const update = () => root.render([...entries].sort((a, b) => a.priority - b.priority)[0].component())
    const context = {
      market: { render: vi.fn(() => createElement('button', null, 'Market search')) },
      slots: {
        inject: (_slot: string, callback: () => void) => callback(),
        register: (options: { name: string; priority: number }, component: () => React.ReactNode) => {
          expect(options.name).toBe('root')
          const entry = { priority: options.priority, component }
          entries.push(entry)
          update()
          return () => { entries.splice(entries.indexOf(entry), 1); update() }
        }
      },
      effect: (effect: () => () => void) => { cleanup.push(effect()) },
      inject: (services: string[], callback: (ctx: unknown) => void) => { expect(services).toEqual(['market']); callback(context) }
    }
    await act(async () => plugin.apply(context))
    expect(document.querySelector('#lyshell-market-root')?.textContent).toContain('Market search')
    expect(document.querySelector('#root')?.textContent).not.toContain('official shell')
    expect(fetchSpy).not.toHaveBeenCalled()
    await act(async () => { cleanup.reverse().forEach(dispose => dispose()) })
    expect(document.querySelector('#lyshell-market-root')).toBeNull()
    expect(document.querySelector('#root')?.textContent).toBe('official shell')
    await act(async () => root.unmount())
  })
})
