import { describe, expect, it } from 'vitest'
import { OscCwdTracker } from './osc-cwd-tracker'

// PSReadLine(ConEmu 风格)实发形态:双引号包裹的 Windows 路径 + ST 结尾
const pwsh = (path: string) => `\x1b]9;9;"${path}"\x1b\\`
// iTerm2 风格:file:// URI + BEL 结尾
const osc7 = (uri: string) => `\x1b]7;${uri}\x07`

describe('OscCwdTracker — OSC 9;9(ConEmu/PSReadLine)', () => {
  it('带引号 + ST 结尾:检出引号内的路径', () => {
    const t = new OscCwdTracker()
    expect(t.push(`PS C:\\> ${pwsh('C:\\Users\\me\\Documents')}\r\n`)).toBe('C:\\Users\\me\\Documents')
    expect(t.getCwd()).toBe('C:\\Users\\me\\Documents')
  })

  it('不带引号 + BEL 结尾:同样检出', () => {
    const t = new OscCwdTracker()
    expect(t.push(`\x1b]9;9;C:\\tools\x07`)).toBe('C:\\tools')
  })

  it('序列跨 chunk 分裂(数据段中间断开):拼接后检出', () => {
    const t = new OscCwdTracker()
    expect(t.push(`\x1b]9;9;"C:\\Users\\m`)).toBeNull()
    expect(t.push(`e\\Documents"\x1b\\`)).toBe('C:\\Users\\me\\Documents')
  })

  it('ST 被拆成半个(尾巴正好停在 ESC):不丢序列起点,下轮拼全', () => {
    const t = new OscCwdTracker()
    expect(t.push(`${pwsh('C:\\a')}`.slice(0, -1))).toBeNull() // 去掉 ST 的 '\\',剩 '\x1b'
    expect(t.push('\\')).toBe('C:\\a')
  })

  it('同 chunk 多条报告:取流内位置最靠后的(时间最新)', () => {
    const t = new OscCwdTracker()
    expect(t.push(`${pwsh('C:\\first')}${pwsh('C:\\second')}`)).toBe('C:\\second')
  })

  it('同值去重:与当前值相同返回 null', () => {
    const t = new OscCwdTracker('C:\\a')
    expect(t.push(pwsh('C:\\a'))).toBeNull() // 与种子相同
    expect(t.push(pwsh('C:\\b'))).toBe('C:\\b')
    expect(t.push(pwsh('C:\\b'))).toBeNull() // 与上次相同
    expect(t.push(pwsh('C:\\a'))).toBe('C:\\a') // 回到旧值仍算变化
  })

  it('种子:未检出前 getCwd 返回种子', () => {
    const t = new OscCwdTracker('C:\\home')
    expect(t.getCwd()).toBe('C:\\home')
    expect(t.push('普通输出,无序列')).toBeNull()
    expect(t.getCwd()).toBe('C:\\home')
  })
})

describe('OscCwdTracker — OSC 7(iTerm2 风格 file:// URI)', () => {
  it('取 pathname 并解码 percent-encoding,host 段丢弃', () => {
    const t = new OscCwdTracker()
    expect(t.push(osc7('file://myhost/Users/me/My%20Docs'))).toBe('/Users/me/My Docs')
  })

  it('空 host(file:///path)同样检出', () => {
    const t = new OscCwdTracker()
    expect(t.push(osc7('file:///home/me'))).toBe('/home/me')
  })

  it('非 file:// 的 OSC 7 data:忽略不误检', () => {
    const t = new OscCwdTracker()
    expect(t.push('\x1b]7;not-a-uri\x07')).toBeNull()
    expect(t.push('\x1b]7;http://x/y\x07')).toBeNull()
  })

  it('跨 chunk 分裂同样检出', () => {
    const t = new OscCwdTracker()
    expect(t.push('\x1b]7;file://localh')).toBeNull()
    expect(t.push('/Users/me\x07')).toBe('/Users/me')
  })
})

describe('OscCwdTracker — 抗噪音', () => {
  it('其他 OSC(标题/进度)不干扰、不误检', () => {
    const t = new OscCwdTracker()
    expect(t.push('\x1b]0;window title\x07\x1b]9;4;3;100\x1b\\')).toBeNull()
    expect(t.push(pwsh('C:\\real'))).toBe('C:\\real')
  })

  it('垃圾尾巴超上限(无终止符的连续流)截断,不崩且后续照常检出', () => {
    const t = new OscCwdTracker()
    // 2KB 无终止符的 \x1b] 起头垃圾 → 尾巴被 TAIL_LIMIT 丢弃
    expect(t.push('\x1b]9;9;"' + 'x'.repeat(2048))).toBeNull()
    expect(t.push(pwsh('C:\\after-garbage'))).toBe('C:\\after-garbage')
  })

  it('普通转义序列(CSI/标题)混在序列前后都正常', () => {
    const t = new OscCwdTracker()
    expect(t.push('\x1b[?25l\x1b]0;prompt\x07' + pwsh('C:\\mixed') + '\x1b[0m')).toBe('C:\\mixed')
  })

  it('全屏 TUI 的备用屏序列流过不误检,退出后 prompt 报告照常', () => {
    const t = new OscCwdTracker('C:\\a')
    expect(t.push('\x1b[?1049h\x1b[2J\x1b[H vim 画面…… \x1b[?1049l')).toBeNull()
    expect(t.push(pwsh('C:\\a'))).toBeNull() // vim 前后没 cd,同值
    expect(t.push(pwsh('C:\\after-vim'))).toBe('C:\\after-vim')
  })
})
