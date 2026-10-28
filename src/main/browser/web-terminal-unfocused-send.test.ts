// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { webTerminalInputScript } from './web-terminal-input'

vi.mock('electron', () => ({
  session: { fromPartition: () => ({}) },
  webContents: { fromId: () => null }
}))

import { WEB_TERMINAL_ATTACH_SCRIPT, WEB_TERMINAL_CHECK_SCRIPT } from './web-terminal'

beforeEach(() => {
  document.body.innerHTML = '<input id="form"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>'
  const root = document.querySelector('.xterm')!
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ width: 500, height: 300 } as DOMRect)
  document.getElementById('form')!.focus()
})
afterEach(() => { vi.restoreAllMocks() })

it('自动附着无需预先点击终端，发现与校验不抢焦点，仅主动输入时聚焦', () => {
  const attached = (0, eval)(WEB_TERMINAL_ATTACH_SCRIPT)
  expect(attached.ok).toBe(true)
  expect(document.activeElement?.id).toBe('form')
  const checked = (0, eval)(WEB_TERMINAL_CHECK_SCRIPT)
  expect(checked.ok).toBe(true)
  expect(document.activeElement?.id).toBe('form')

  const target = document.querySelector('textarea')!
  const onEnter = vi.fn()
  target.addEventListener('keydown', onEnter)
  const result = (0, eval)(webTerminalInputScript({
    token: attached.token, text: '', enter: true,
    href: location.href, expires: Date.now() + 700
  }))
  expect(result.ok).toBe(true)
  expect(document.activeElement).toBe(target)
  expect(onEnter).toHaveBeenCalledOnce()
})
