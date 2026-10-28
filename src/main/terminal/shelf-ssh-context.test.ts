import { describe, expect, it } from 'vitest'
import {
  SSH_CONTEXT_LIMIT,
  buildSshDirectoryCommand,
  captureSshContext,
  normalizeSshDirectory
} from './shelf-ssh-context'

/**
 * 独立的 POSIX 单引号还原器:用来**反向验证**生成的命令确实全程被引用。
 * 遇到任何未处于单引号内、也不是 `\'` 转义的字符就直接返回 null,
 * 因此“命令里混入了裸路径字符”会被用例抓到。
 */
function unquotePosixSingleQuoted(src: string): string | null {
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src[i] === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) return null
      out += src.slice(i + 1, end)
      i = end + 1
    } else if (src[i] === '\\' && src[i + 1] === "'") {
      out += "'"
      i += 2
    } else {
      return null
    }
  }
  return out
}

/** 取命令里“参数体”部分(去掉 `cd -- ` 前缀与结尾的 \r) */
function commandBody(command: string): string {
  expect(command.startsWith('cd -- ')).toBe(true)
  expect(command.endsWith('\r')).toBe(true)
  return command.slice('cd -- '.length, -1)
}

describe('SSH_CONTEXT_LIMIT', () => {
  it('固定为 32768', () => {
    expect(SSH_CONTEXT_LIMIT).toBe(32768)
  })
})

describe('normalizeSshDirectory', () => {
  it('接受绝对 POSIX 路径并原样返回', () => {
    expect(normalizeSshDirectory('/')).toBe('/')
    expect(normalizeSshDirectory('/home/user')).toBe('/home/user')
    expect(normalizeSshDirectory('/home/user/project/')).toBe('/home/user/project/')
    expect(normalizeSshDirectory('/srv/a b/c')).toBe('/srv/a b/c')
  })

  it('保留空格/引号/美元/反引号,不做任何猜测式修正', () => {
    const raw = "/srv/it's a \"dir\" with $HOME and `id`"
    expect(normalizeSshDirectory(raw)).toBe(raw)
    // 不去尾斜杠、不 trim、不展开 ~、不归一化 . 与 ..
    expect(normalizeSshDirectory('/a/b/')).toBe('/a/b/')
    expect(normalizeSshDirectory('/a/./b/../c')).toBe('/a/./b/../c')
    expect(normalizeSshDirectory('/~/x')).toBe('/~/x')
  })

  it('拒绝非字符串与空串', () => {
    for (const value of [undefined, null, 0, 123, true, {}, []]) {
      expect(normalizeSshDirectory(value)).toBeUndefined()
    }
    expect(normalizeSshDirectory('')).toBeUndefined()
  })

  it('拒绝相对路径', () => {
    for (const value of ['home/user', './x', '../x', '~', 'C:/Users/x', 'C:\\Users\\x', ' /x']) {
      // 末项首字符是空格,不是绝对路径
      expect(normalizeSshDirectory(value)).toBeUndefined()
    }
  })

  it('拒绝 /C:/... 形式的 Windows 盘符路径', () => {
    for (const value of ['/C:/Users/x', '/c:/', '/C:\\Users\\x', '/C:', '/d:/work']) {
      expect(normalizeSshDirectory(value)).toBeUndefined()
    }
    // 冒号不在盘符位置时不算 Windows 路径
    expect(normalizeSshDirectory('/cd:/x')).toBe('/cd:/x')
    expect(normalizeSshDirectory('/a:b')).toBe('/a:b')
  })

  it('拒绝全部 ASCII 控制字符与 DEL', () => {
    expect(normalizeSshDirectory('/a\nb')).toBeUndefined()
    expect(normalizeSshDirectory('/a\rb')).toBeUndefined()
    expect(normalizeSshDirectory('/a\tb')).toBeUndefined()
    expect(normalizeSshDirectory('/a\x00b')).toBeUndefined()
    expect(normalizeSshDirectory('/a\x1bb')).toBeUndefined()
    expect(normalizeSshDirectory('/a\x7fb')).toBeUndefined()
    // 逐个覆盖 0x00-0x1F 与 0x7F
    for (let code = 0x00; code <= 0x1f; code++) {
      expect(normalizeSshDirectory(`/a${String.fromCharCode(code)}b`)).toBeUndefined()
    }
    expect(normalizeSshDirectory('/a\x7fb')).toBeUndefined()
    // 控制字符在首字符位置同样拒绝
    expect(normalizeSshDirectory('\x01/x')).toBeUndefined()
  })

  it('长度上限为 4096', () => {
    const atLimit = '/' + 'a'.repeat(4095)
    expect(atLimit).toHaveLength(4096)
    expect(normalizeSshDirectory(atLimit)).toBe(atLimit)

    const overLimit = '/' + 'a'.repeat(4096)
    expect(overLimit).toHaveLength(4097)
    expect(normalizeSshDirectory(overLimit)).toBeUndefined()
  })
})

describe('buildSshDirectoryCommand', () => {
  it('生成单条 cd -- 命令并以 \\r 结束', () => {
    expect(buildSshDirectoryCommand('/home/user')).toBe("cd -- '/home/user'\r")
    expect(buildSshDirectoryCommand('/')).toBe("cd -- '/'\r")
    expect(buildSshDirectoryCommand('/srv/a b/c')).toBe("cd -- '/srv/a b/c'\r")
  })

  it('单引号按 \'\\\'\' 转义,还原后与目录完全一致', () => {
    const command = buildSshDirectoryCommand("/tmp/it's")
    expect(command).toBe("cd -- '/tmp/it'\\''s'\r")
    expect(unquotePosixSingleQuoted(commandBody(command!))).toBe("/tmp/it's")

    // 连续单引号
    const doubled = buildSshDirectoryCommand("/a''b")
    expect(unquotePosixSingleQuoted(commandBody(doubled!))).toBe("/a''b")

    // 目录名本身就是转义片段
    const fake = buildSshDirectoryCommand("/x'\\''y")
    expect(unquotePosixSingleQuoted(commandBody(fake!))).toBe("/x'\\''y")
  })

  it('命令替换/变量/反引号/分号等特殊内容被完整引用', () => {
    const cases = [
      '/tmp/$(rm -rf ~)',
      '/tmp/`id`',
      '/tmp/${HOME}/x',
      '/tmp/a;rm -rf /',
      '/tmp/a | cat',
      '/tmp/a && whoami',
      '/tmp/a"b"c',
      '/tmp/a\\b',
      '/tmp/a=b:c,d'
    ]
    for (const directory of cases) {
      const command = buildSshDirectoryCommand(directory)
      expect(command).toBe(`cd -- '${directory}'\r`)
      // 路径整体位于单引号内 → 还原后逐字符相同
      expect(unquotePosixSingleQuoted(commandBody(command!))).toBe(directory)
    }

    // 换行目录直接不生成命令
    expect(buildSshDirectoryCommand('/tmp/a\nb')).toBeUndefined()
    expect(buildSshDirectoryCommand('/tmp/a\rb')).toBeUndefined()
  })

  it('非法目录不生成任何命令', () => {
    for (const value of [
      undefined,
      null,
      '',
      'home/user',
      'C:/Users/x',
      '/C:/Users/x',
      '/a\nb',
      '/a\x1bb',
      '/a\x7fb',
      '/' + 'a'.repeat(4096),
      123,
      {}
    ]) {
      expect(buildSshDirectoryCommand(value)).toBeUndefined()
    }
  })

  it('不生成 tmux / exec / startup 等额外命令,且只有一条命令', () => {
    const command = buildSshDirectoryCommand('/home/user')!
    expect(command).not.toContain('tmux')
    expect(command).not.toContain('exec')
    expect(command).not.toContain('sh -c')
    // 只有结尾那一个 \r,命令体内没有任何换行/回车
    const body = commandBody(command)
    expect(body).not.toMatch(/[\r\n]/)
    expect(command.match(/\r/g)).toHaveLength(1)
    // 命令体只有一段,不存在追加的第二条命令
    expect(unquotePosixSingleQuoted(body)).toBe('/home/user')
  })
})

describe('captureSshContext', () => {
  it('清洗 ANSI / OSC / DCS 序列,只留可读文本', () => {
    expect(captureSshContext('\x1b[31mred\x1b[0m')).toBe('red')
    expect(captureSshContext('\x1b[?25lhidden cursor\x1b[?25h')).toBe('hidden cursor')
    // OSC 窗口标题(BEL 结尾)与 OSC 8 超链接(ST 结尾)
    expect(captureSshContext('\x1b]0;title\x07plain')).toBe('plain')
    expect(captureSshContext('\x1b]8;;http://evil.example/x\x1b\\click\x1b]8;;\x1b\\')).toBe('click')
    // DCS 与单字符转义
    expect(captureSshContext('\x1bP1$r0m\x1b\\after')).toBe('after')
    expect(captureSshContext('\x1b(Bascii')).toBe('ascii')
    // 清屏/回车覆盖序列清空后没有可读文本
    expect(captureSshContext('\x1b[2J\x1b[H')).toBeUndefined()
  })

  it('保留换行与制表符', () => {
    expect(captureSshContext('col1\tcol2\n\tindented')).toBe('col1\tcol2\n\tindented')
    expect(captureSshContext('a\r\nb')).toBe('a\nb')
    expect(captureSshContext('line1\nline2\nline3')).toBe('line1\nline2\nline3')
  })

  it('剔除 DEL 与 C1 控制字符', () => {
    expect(captureSshContext('ab\x7fc')).toBe('abc')
    expect(captureSshContext('\x9bvisible')).toBe('visible')
    expect(captureSshContext('a\x00b')).toBe('ab')
  })

  it('大输出有界:最多 32768 码元,保留最后一段', () => {
    const huge = 'a'.repeat(40000)
    const result = captureSshContext(huge)!
    expect(result).toHaveLength(SSH_CONTEXT_LIMIT)
    expect(result).toBe('a'.repeat(SSH_CONTEXT_LIMIT))

    const lines = Array.from({ length: 4000 }, (_, i) => `\x1b[32mline ${i}\x1b[0m`).join('\n')
    const tail = captureSshContext(lines)!
    expect(tail.length).toBeLessThanOrEqual(SSH_CONTEXT_LIMIT)
    expect(tail).not.toContain('\x1b')
    expect(tail.endsWith('line 3999')).toBe(true)
    // 确实是“尾部”:最后一行在,最前面几行已被截掉
    expect(tail).toContain('line 3998')
    expect(tail.startsWith('line 0')).toBe(false)
  })

  it('emoji 边界:截断不劈开代理对', () => {
    // 布局让切点正好落在 emoji 的低代理位:start = 11 处是低代理
    const text = 'a'.repeat(10) + '😀' + 'b'.repeat(32767)
    expect(text).toHaveLength(32779)
    const result = captureSshContext(text)!
    expect(result.length).toBeLessThanOrEqual(SSH_CONTEXT_LIMIT)
    // 半个字符不会留在尾部起点
    expect(result).toBe('b'.repeat(32767))
    expect(result.startsWith('b')).toBe(true)
    // 通用检查:结果里没有孤立代理
    expect(result).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(result).not.toMatch(/^[\uDC00-\uDFFF]/)

    // 完整落在尾部内的 emoji 被保留
    const fits = captureSshContext('x'.repeat(40000) + '😀')!
    expect(fits).toHaveLength(SSH_CONTEXT_LIMIT)
    expect(fits.endsWith('😀')).toBe(true)
  })

  it('空输出/无可读输出时保留 previous 的同样规范化尾部', () => {
    expect(captureSshContext('', 'old\n/tmp/work')).toBe('old\n/tmp/work')
    expect(captureSshContext('\x1b[2J\x1b[H', 'old\n/tmp/work')).toBe('old\n/tmp/work')
    expect(captureSshContext('\n\n   \n', 'keep me')).toBe('keep me')

    // previous 也按同一规则清洗与截尾
    const prevRaw = '\x1b[1mbold\x1b[0m\n/tmp'
    expect(captureSshContext('', prevRaw)).toBe('bold\n/tmp')

    const longPrev = 'p'.repeat(40000)
    const trimmed = captureSshContext('', longPrev)!
    expect(trimmed).toHaveLength(SSH_CONTEXT_LIMIT)
  })

  it('raw 与 previous 都没有可读文本时返回 undefined', () => {
    expect(captureSshContext('')).toBeUndefined()
    expect(captureSshContext('\x1b[0m')).toBeUndefined()
    expect(captureSshContext('\x1b[2J', '')).toBeUndefined()
    expect(captureSshContext('\x1b[2J', '\x1b[H')).toBeUndefined()
  })

  it('有新的可读输出时以 raw 为准(覆盖语义)', () => {
    expect(captureSshContext('/tmp/next', '/tmp/prev')).toBe('/tmp/next')
  })

  it('不解析提示符、不改写内容', () => {
    const raw = 'user@host:~$ ls -la\ntotal 0\n/tmp'
    expect(captureSshContext(raw)).toBe(raw)
    // 形似目录的片段不会被抽出来单独处理
    expect(captureSshContext('cd /tmp/foo && ls')).toBe('cd /tmp/foo && ls')
  })

  it('非字符串输入按“无可读输出”处理,不抛异常', () => {
    expect(captureSshContext(undefined as unknown as string)).toBeUndefined()
    expect(captureSshContext(null as unknown as string, 'prev')).toBe('prev')
  })
})
