// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webTerminalInputScript, webTerminalClearScript } from './web-terminal-input'

class Transfer {
  value = ''
  setData(_type: string, value: string): void { this.value = value }
  getData(): string { return this.value }
}
class PasteEvent extends Event {
  clipboardData: Transfer
  constructor(type: string, options: EventInit & {clipboardData: Transfer}) { super(type, options); this.clipboardData = options.clipboardData }
}
const key = Symbol.for('lyshell.web-terminal.v1')
const state = globalThis as typeof globalThis & { [key: symbol]: unknown }
let target: HTMLTextAreaElement
let root: HTMLDivElement
let received: string[]
const token = 'a'.repeat(32)
const run = (text: string, enter = true, expires = Date.now()+1000): {ok:boolean;partial:boolean} =>
  (0, eval)(webTerminalInputScript({text,enter,token,expires,href:location.href}))

beforeEach(() => {
  vi.stubGlobal('DataTransfer', Transfer)
  vi.stubGlobal('ClipboardEvent', PasteEvent)
  root = document.createElement('div')
  root.className = 'xterm'
  root.getBoundingClientRect = () => ({width:100,height:100}) as DOMRect
  target = document.createElement('textarea')
  target.className = 'xterm-helper-textarea'
  root.append(target)
  document.body.append(root)
  target.setAttribute('data-lyshell-terminal', token)
  document.documentElement.setAttribute('data-lyshell-terminal', token)
  state[key] = {token,target:new WeakRef(target),root:new WeakRef(root)}
  received = []
  target.addEventListener('paste', event => { received.push((event as unknown as PasteEvent).clipboardData.getData()) })
  target.addEventListener('keydown', event => { if(event.key === 'Enter')received.push('\r') })
})
afterEach(() => { document.body.innerHTML=''; document.documentElement.removeAttribute('data-lyshell-terminal'); delete state[key]; vi.unstubAllGlobals() })

describe('xterm frame 内输入', () => {
  it('文本作为数据，保留中文、引号与转义，不执行命令内容中的 JS', () => {
    const text = 'echo 中文\';globalThis.__injected=1;//\\`$()'
    expect(run(text)).toEqual({ok:true,partial:true})
    expect(received).toEqual([text,'\r'])
    expect((globalThis as Record<string,unknown>).__injected).toBeUndefined()
  })
  it('仅输入不回车；空行可以只发回车', () => {
    expect(run('hello',false).ok).toBe(true)
    expect(run('',true).ok).toBe(true)
    expect(received).toEqual(['hello','\r'])
  })
  it('迟到的发送不会输入或抢焦点', () => {
    const other=document.createElement('input');document.body.append(other);other.focus()
    expect(run('danger',true,Date.now()-1)).toEqual({ok:false,partial:false})
    expect(document.activeElement).toBe(other)
    expect(received).toEqual([])
  })
  it('复制相同标记的替换元素不能接收绑定输入', () => {
    const clone=target.cloneNode() as HTMLTextAreaElement
    root.replaceChild(clone,target)
    expect(run('danger')).toEqual({ok:false,partial:false})
    expect(received).toEqual([])
  })
  it('粘贴处理器替换终端后不再发送回车，报告部分输入', () => {
    target.addEventListener('paste',()=>target.remove())
    expect(run('echo')).toEqual({ok:false,partial:true})
    expect(received).toEqual(['echo'])
  })
  it('旧释放不能撤销新绑定', () => {
    const oldRelease = webTerminalClearScript('b'.repeat(32))
    ;(0,eval)(oldRelease)
    expect(state[key]).toBeDefined()
    ;(0,eval)(webTerminalClearScript(token))
    expect(state[key]).toBeUndefined()
    expect(target.hasAttribute('data-lyshell-terminal')).toBe(false)
  })
})
