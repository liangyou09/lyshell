/**
 * docLink 纯函数表驱动测试 —— 匹配形态 / 误报抑制 / 相对路径归并。
 * 匹配规则是「宁缺勿滥」：每一条误报用例对应一类真实终端输出场景。
 */
import { describe, expect, it } from 'vitest'
import { matchDocPaths, resolveDocPath, matchPromptCwd, localJoin, stripLeadingDash, matchDirHeader, docLinkTarget, docDirFromPath } from './docLink'

const pathsOf = (text: string): string[] => matchDocPaths(text).map(m => m.path)

describe('matchDocPaths：五种路径形态', () => {
  it('unix 绝对路径（含多级目录）', () => {
    expect(pathsOf('-rw-r--r--  1 user  8.4 KB  /srv/payment/README.md')).toEqual(['/srv/payment/README.md'])
  })

  it('家目录 ~ 前缀', () => {
    expect(pathsOf('~/docs/deploy-notes.md')).toEqual(['~/docs/deploy-notes.md'])
    expect(pathsOf('~/README.md')).toEqual(['~/README.md'])
  })

  it('相对路径 ./ 与 ../', () => {
    expect(pathsOf('cat ./config.md')).toEqual(['./config.md'])
    expect(pathsOf('see ../docs/api.html')).toEqual(['../docs/api.html'])
  })

  it('裸文件名（单段）', () => {
    expect(pathsOf('-rw-r--r--  README.md  8.4 KB')).toEqual(['README.md'])
    expect(pathsOf('CHANGELOG.md')).toEqual(['CHANGELOG.md'])
  })

  it('Windows 盘符（反斜杠 / 正斜杠）', () => {
    expect(pathsOf('type D:\\docs\\report.html')).toEqual(['D:\\docs\\report.html'])
    expect(pathsOf('D:/docs/report.html')).toEqual(['D:/docs/report.html'])
  })

  it('多段相对路径（无 ./ 前缀，正反斜杠）', () => {
    expect(pathsOf('src/renderer/assets/agent-icons/README.md')).toEqual(['src/renderer/assets/agent-icons/README.md'])
    expect(pathsOf('编译失败 src/renderer/foo.md 请检查')).toEqual(['src/renderer/foo.md'])
    expect(pathsOf('src\\renderer\\assets\\README.md')).toEqual(['src\\renderer\\assets\\README.md'])
  })

  it('带协议 URL 全程不误报', () => {
    expect(pathsOf('https://example.com/src/app/README.md')).toEqual([])
    expect(pathsOf('see https://example.com/a.md end')).toEqual([])
  })

  it('grep 风格行号后缀 / git diff 双路径', () => {
    expect(pathsOf('docs/api/guide.md:42: 注意')).toEqual(['docs/api/guide.md'])
    expect(pathsOf('diff --git a/docs/readme.md b/docs/readme.md')).toEqual(['a/docs/readme.md', 'b/docs/readme.md'])
  })

  it('无协议域名路径按相对路径命中（已知取舍）', () => {
    expect(pathsOf('example.com/README.md')).toEqual(['example.com/README.md'])
  })

  it('一行多个路径全部命中（互不吞并）', () => {
    expect(pathsOf('README.md 和 /srv/CHANGELOG.md')).toEqual(['README.md', '/srv/CHANGELOG.md'])
  })

  it('扩展名大小写不敏感；markdown/htm 变体都认', () => {
    expect(pathsOf('notes.MD')).toEqual(['notes.MD'])
    expect(pathsOf('a.markdown b.htm')).toEqual(['a.markdown', 'b.htm'])
  })
})

describe('matchDocPaths：误报抑制', () => {
  it('URL 里的文件名不匹配（裸名被前置 / lookbehind 挡掉）', () => {
    expect(pathsOf('https://example.com/README.md')).toEqual([])
    expect(pathsOf('curl -O https://raw.git.com/u/r/main/pkg.html')).toEqual([])
  })

  it('扩展名必须是词尾（.mdx / .mdown 不认半截）', () => {
    expect(pathsOf('notes.mdx')).toEqual([])
    expect(pathsOf('notes.mdown')).toEqual([])
  })

  it('长 token 的中段不单独成匹配（my-README.md 整体命中而非 README.md）', () => {
    expect(pathsOf('my-README.md')).toEqual(['my-README.md'])
  })

  it('非文档扩展名不命中', () => {
    expect(pathsOf('run.sh config.json app.js')).toEqual([])
  })

  it('行尾标点不入路径', () => {
    expect(pathsOf('see /srv/README.md.')).toEqual(['/srv/README.md'])
    expect(pathsOf('open (./a.md)')).toEqual(['./a.md'])
  })
})

describe('resolveDocPath：相对路径归并', () => {
  it('绝对路径与 ~ 原样返回', () => {
    expect(resolveDocPath('/srv/app/README.md', '/home/u')).toBe('/srv/app/README.md')
    expect(resolveDocPath('~/docs/a.md', undefined)).toBe('~/docs/a.md')
    expect(resolveDocPath('D:\\docs\\a.md', undefined)).toBe('D:\\docs\\a.md')
  })

  it('裸名并入 cwd', () => {
    expect(resolveDocPath('README.md', '/srv/payment')).toBe('/srv/payment/README.md')
  })

  it('./ 归一、../ 上跳（不越出根）', () => {
    expect(resolveDocPath('./config.md', '/srv/payment')).toBe('/srv/payment/config.md')
    expect(resolveDocPath('../docs/api.html', '/srv/payment')).toBe('/srv/docs/api.html')
    expect(resolveDocPath('../../x.md', '/srv')).toBe('/x.md')
    expect(resolveDocPath('../../x.md', '/')).toBe('/x.md')
  })

  it('cwd 带尾斜杠安全；无 cwd 的相对路径返回 null', () => {
    expect(resolveDocPath('a.md', '/srv/payment/')).toBe('/srv/payment/a.md')
    expect(resolveDocPath('./a.md', undefined)).toBeNull()
  })
})

describe('matchPromptCwd：本地提示符 cwd 提取', () => {
  it('PowerShell 默认提示符 PS D:\\path>', () => {
    expect(matchPromptCwd('PS D:\\workspace\\claude\\LyShell>')).toBe('D:\\workspace\\claude\\LyShell')
    expect(matchPromptCwd('  PS C:\\>')).toBe('C:\\')
  })

  it('cmd 默认提示符 D:\\path>', () => {
    expect(matchPromptCwd('D:\\workspace\\LyShell>')).toBe('D:\\workspace\\LyShell')
  })

  it('提示符后跟已执行命令也认（不锚定行尾）', () => {
    expect(matchPromptCwd('PS D:\\docs> rg --files src')).toBe('D:\\docs')
    expect(matchPromptCwd('PS D:\\docs> claude')).toBe('D:\\docs')
    expect(matchPromptCwd('D:\\docs>dir')).toBe('D:\\docs')
  })

  it('posh-git 的 [branch] 状态段剥掉', () => {
    expect(matchPromptCwd('PS D:\\repo [main]> git status')).toBe('D:\\repo')
    expect(matchPromptCwd('PS D:\\repo [main ≡ +1 ~0 -0]>')).toBe('D:\\repo')
  })

  it('路径内含空格可提取', () => {
    expect(matchPromptCwd('PS C:\\Program Files\\My App>')).toBe('C:\\Program Files\\My App')
  })

  it('非提示符行 / 自定义提示符返回 null（宁可不猜）', () => {
    expect(matchPromptCwd('    目录: D:\\docs')).toBeNull()
    expect(matchPromptCwd('RELEASE_NOTES_v1.0.3.md')).toBeNull()
    expect(matchPromptCwd('❯ ~/docs')).toBeNull()
    expect(matchPromptCwd('D:\\docs\\a.md')).toBeNull()
    expect(matchPromptCwd('echo D:\\x>y')).toBeNull()
    expect(matchPromptCwd('')).toBeNull()
  })
})

describe('stripLeadingDash：弹点符号剥离', () => {
  it('贴着路径的单个前导 - 剥掉', () => {
    expect(stripLeadingDash('-.claude/plans/x.md')).toBe('.claude/plans/x.md')
    expect(stripLeadingDash('-notes.md')).toBe('notes.md')
  })

  it('无前导 - / 单独 - 原样返回', () => {
    expect(stripLeadingDash('README.md')).toBe('README.md')
    expect(stripLeadingDash('./a.md')).toBe('./a.md')
    expect(stripLeadingDash('-')).toBe('-')
  })
})

describe('localJoin：本地相对路径归并', () => {
  it('裸名并入 cwd（反斜杠拼接，容忍 cwd 尾斜杠/正斜杠）', () => {
    expect(localJoin('D:\\docs', 'a.md')).toBe('D:\\docs\\a.md')
    expect(localJoin('D:\\docs\\', 'a.md')).toBe('D:\\docs\\a.md')
    expect(localJoin('D:/docs', 'a.md')).toBe('D:\\docs\\a.md')
  })

  it('./ 归一、../ 上跳不越出盘符根', () => {
    expect(localJoin('D:\\docs', './a.md')).toBe('D:\\docs\\a.md')
    expect(localJoin('D:\\docs\\sub', '../a.md')).toBe('D:\\docs\\a.md')
    expect(localJoin('D:\\', '../a.md')).toBe('D:\\a.md')
  })

  it('正斜杠相对段同样处理', () => {
    expect(localJoin('D:\\docs', 'sub/notes.md')).toBe('D:\\docs\\sub\\notes.md')
  })
})

describe('matchDirHeader：分组目录头识别', () => {
  it('带计数的目录头（全角/半角括号，个/items/files）', () => {
    expect(matchDirHeader('prototypes/（2 个）')).toBe('prototypes/')
    expect(matchDirHeader('docs/（1 个）')).toBe('docs/')
    expect(matchDirHeader('docs/ (2 items)')).toBe('docs/')
    expect(matchDirHeader('docs/ (3 files)')).toBe('docs/')
  })

  it('计数后带 — 描述 / 无计数带分隔符描述', () => {
    expect(matchDirHeader('design/（9 个）— UI 方向探索')).toBe('design/')
    expect(matchDirHeader('docs/ — 设计文档')).toBe('docs/')
    expect(matchDirHeader('docs/：全量文档')).toBe('docs/')
  })

  it('ls -R 风格冒号尾 / 裸目录行', () => {
    expect(matchDirHeader('src/renderer/:')).toBe('src/renderer/')
    expect(matchDirHeader('prototypes/')).toBe('prototypes/')
  })

  it('Windows 盘符 / ~ 家目录 / unix 绝对目录头', () => {
    expect(matchDirHeader('D:\\docs\\（3 个）')).toBe('D:\\docs\\')
    expect(matchDirHeader('~/docs/ (1 file)')).toBe('~/docs/')
    expect(matchDirHeader('/srv/app/（8 个）')).toBe('/srv/app/')
  })

  it('文件条目行 / 普通句子不误判', () => {
    // 用户实际粘贴的条目行：描述里带全角括号与多段路径，不能当目录头
    expect(matchDirHeader('- sidebar-rack.html — 侧栏 RACK v2 原型（对应记忆里的 rack-graphite/slate/carbon 主题体系）')).toBeNull()
    expect(matchDirHeader('- file-manager.html — 文件管理器原型')).toBeNull()
    // 多段路径条目：dir 会截到 `src/a/`，但剩余 `README.md — 说明` 无分隔符起头，整体不匹配
    expect(matchDirHeader('- src/a/README.md — 说明')).toBeNull()
    expect(matchDirHeader('see docs/ for details')).toBeNull()
    expect(matchDirHeader('总共 2 个')).toBeNull()
    expect(matchDirHeader('')).toBeNull()
  })

  it('表格行不是目录头（│ 起头直接排除）', () => {
    expect(matchDirHeader('│ ground-station.html │ Ground Station（地面站）整体 UI 方向初版 │')).toBeNull()
    expect(matchDirHeader('├──────────┼──────────┤')).toBeNull()
  })
})

describe('docDirFromPath：文档所在目录', () => {
  it('posix / windows / 根 / 无分隔符', () => {
    expect(docDirFromPath('/srv/docs/a.md')).toBe('/srv/docs')
    expect(docDirFromPath('D:\\docs\\a.md')).toBe('D:\\docs')
    expect(docDirFromPath('/a.md')).toBe('/')
    expect(docDirFromPath('D:\\a.md')).toBe('D:\\')
    expect(docDirFromPath('a.md')).toBe('')
  })
})

describe('docLinkTarget：md 内链接 → 可打开文档路径', () => {
  it('相对链接按当前文档目录归并（远端 posix / 本地反斜杠）', () => {
    expect(docLinkTarget('./b.md', false, '/srv/docs')).toBe('/srv/docs/b.md')
    expect(docLinkTarget('../design/x.html', false, '/srv/docs')).toBe('/srv/design/x.html')
    expect(docLinkTarget('sub/c.md', false, '/srv/docs')).toBe('/srv/docs/sub/c.md')
    expect(docLinkTarget('./b.md', true, 'D:\\docs')).toBe('D:\\docs\\b.md')
    expect(docLinkTarget('../design/x.html', true, 'D:\\docs')).toBe('D:\\design\\x.html')
  })

  it('绝对路径 / ~ 透传（远端）；本地绝对盘符透传、~ 拒绝', () => {
    expect(docLinkTarget('/srv/a.md', false, '/srv/docs')).toBe('/srv/a.md')
    expect(docLinkTarget('~/notes/b.md', false, '/srv/docs')).toBe('~/notes/b.md')
    expect(docLinkTarget('D:\\other\\a.md', true, 'D:\\docs')).toBe('D:\\other\\a.md')
    expect(docLinkTarget('~/a.md', true, 'D:\\docs')).toBeNull()
  })

  it('外链 / 锚点 / 非文档扩展名 / 空链接返回 null', () => {
    expect(docLinkTarget('https://example.com/a.md', false, '/srv/docs')).toBeNull()
    expect(docLinkTarget('mailto:x@y.z', false, '/srv/docs')).toBeNull()
    expect(docLinkTarget('#section', false, '/srv/docs')).toBeNull()
    expect(docLinkTarget('./logo.png', false, '/srv/docs')).toBeNull()
    expect(docLinkTarget('', false, '/srv/docs')).toBeNull()
  })

  it('锚点尾巴剥掉、percent-decode、无目录基准的相对链接拒绝', () => {
    expect(docLinkTarget('a.md#usage', false, '/srv/docs')).toBe('/srv/docs/a.md')
    expect(docLinkTarget('my%20file.md', false, '/srv/docs')).toBe('/srv/docs/my file.md')
    expect(docLinkTarget('a.md', false, '')).toBeNull()
    expect(docLinkTarget('a.md', true, '')).toBeNull()
  })
})
