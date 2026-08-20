import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { assertSafeLocalPath } from './path-safety'

// 这些测试锁定 assertSafeLocalPath 的安全不变量，防止日后被弱化：
//   - download（write:true）必须把 localPath 限定在下载根目录内，防写到 Startup 等位置（RCE/持久化）
//   - upload（write:false）必须拦截私钥/凭据等敏感路径，防外泄
// 对应 round-4 🔴🔴 修复。

describe('assertSafeLocalPath', () => {
  describe('write 模式（download 写本地，containment）', () => {
    it('落在下载根目录内的路径通过校验', () => {
      const root = path.resolve('test-downloads')
      const file = path.join(root, 'sub', 'file.txt')
      expect(() => assertSafeLocalPath(file, { write: true, containmentRoot: root })).not.toThrow()
    })

    it('绝对路径落在下载根目录外被拒（防写到 Startup / 系统目录）', () => {
      const root = path.resolve('test-downloads')
      const evil = process.platform === 'win32'
        ? 'C:\\Users\\victim\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\evil.bat'
        : '/etc/cron.d/evil'
      expect(() => assertSafeLocalPath(evil, { write: true, containmentRoot: root })).toThrow(/download directory/)
    })

    it('用 .. 逃逸下载根目录被拒', () => {
      const root = path.resolve('test-downloads')
      const escape = path.join(root, '..', '..', 'evil.txt')
      expect(() => assertSafeLocalPath(escape, { write: true, containmentRoot: root })).toThrow(/download directory/)
    })

    it('含 .. 但解析后仍在根目录内的路径通过', () => {
      const root = path.resolve('test-downloads')
      const file = path.join(root, 'sub', '..', 'file.txt')
      expect(() => assertSafeLocalPath(file, { write: true, containmentRoot: root })).not.toThrow()
    })

    it('根目录内以 .. 开头的合法文件名通过', () => {
      const root = path.resolve('test-downloads')
      for (const name of ['..foo', '...log']) {
        const file = path.join(root, name)
        expect(() => assertSafeLocalPath(file, { write: true, containmentRoot: root })).not.toThrow()
      }
    })

    it('未提供 containmentRoot 时不做 contain 校验（仅 resolve）', () => {
      const evil = process.platform === 'win32' ? 'C:\\Users\\x\\evil.txt' : '/tmp/evil.txt'
      expect(() => assertSafeLocalPath(evil, { write: true })).not.toThrow()
    })
  })

  describe('read 模式（upload 读本地，敏感路径拦截）', () => {
    it('.ssh 私钥路径被拦截（防外泄）', () => {
      const key = process.platform === 'win32' ? 'C:\\Users\\victim\\.ssh\\id_rsa' : '/home/victim/.ssh/id_rsa'
      expect(() => assertSafeLocalPath(key, { write: false })).toThrow(/sensitive location/)
    })

    it('.aws 凭据路径被拦截', () => {
      const cred = process.platform === 'win32' ? 'C:\\Users\\victim\\.aws\\credentials' : '/home/victim/.aws/credentials'
      expect(() => assertSafeLocalPath(cred, { write: false })).toThrow(/sensitive location/)
    })

    it('任意目录下的安全密钥文件名被拦截', () => {
      const dir = path.resolve('copied-keys')
      for (const name of ['id_ed25519_sk', 'id_ecdsa_sk']) {
        expect(() => assertSafeLocalPath(path.join(dir, name), { write: false })).toThrow(/sensitive location/)
      }
    })

    it.skipIf(process.platform !== 'win32')('Windows Startup 目录被拦截', () => {
      const startup = 'C:\\Users\\victim\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\evil.bat'
      expect(() => assertSafeLocalPath(startup, { write: false })).toThrow(/sensitive location/)
    })

    it('普通项目文件路径通过', () => {
      const normal = process.platform === 'win32'
        ? 'C:\\projects\\app\\src\\index.ts'
        : '/home/user/projects/app/src/index.ts'
      expect(() => assertSafeLocalPath(normal, { write: false })).not.toThrow()
    })

    it('下载目录内的普通文件通过', () => {
      const root = path.resolve('test-downloads')
      const file = path.join(root, 'report.pdf')
      expect(() => assertSafeLocalPath(file, { write: false })).not.toThrow()
    })
  })

  describe('大小写/跨平台', () => {
    it.skipIf(process.platform !== 'win32')('win32 下根目录大小写不敏感匹配', () => {
      const root = 'C:\\Users\\Test\\Downloads'
      const file = 'c:\\users\\test\\downloads\\sub\\file.txt'
      expect(() => assertSafeLocalPath(file, { write: true, containmentRoot: root })).not.toThrow()
    })
  })
})

// 符号链接/junction 防护测试：词法校验通过的路径可能经符号链接逃逸根目录或指向敏感文件。
// 目录链接在 Windows 用 junction（无需管理员），在 *nix 用 symlink；文件 symlink 在 Windows
// 需管理员/开发者模式，不支持时跳过对应用例。
describe('assertSafeLocalPath 符号链接防护', () => {
  const isWin = process.platform === 'win32'
  const dirLinkType = isWin ? 'junction' : 'dir'

  // 探测目录链接是否可用（junction 在 Windows 恒可用）
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyshell-symlink-probe-'))
  let dirLinkWorks = true
  try {
    fs.symlinkSync(probeDir, path.join(probeDir, 'probe'), dirLinkType)
  } catch {
    dirLinkWorks = false
  }
  fs.rmSync(probeDir, { recursive: true, force: true })

  // 探测文件 symlink 是否可用（Windows 需管理员/开发者模式）
  const probeFileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyshell-file-probe-'))
  const probeFile = path.join(probeFileDir, 'probe.txt')
  fs.writeFileSync(probeFile, 'x')
  let fileLinkWorks = true
  try {
    fs.symlinkSync(probeFile, path.join(probeFileDir, 'probe.lnk'), 'file')
  } catch {
    fileLinkWorks = false
  }
  fs.rmSync(probeFileDir, { recursive: true, force: true })

  let tmpDir: string
  let root: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyshell-pathsafety-'))
    root = path.join(tmpDir, 'downloads')
    fs.mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it.skipIf(!dirLinkWorks)('write: 指向根目录外的符号链接/junction 目录被拒（防经链接写到 Startup 等）', () => {
    const outside = path.join(tmpDir, 'outside')
    fs.mkdirSync(outside)
    const link = path.join(root, 'lnk')
    fs.symlinkSync(outside, link, dirLinkType)
    // 词法校验通过（lnk 在 root 内），但 realpath(lnk)=outside 不在 root 内 -> 拒绝
    const target = path.join(link, 'evil.bat')
    expect(() => assertSafeLocalPath(target, { write: true, containmentRoot: root })).toThrow(/download directory/)
  })

  it.skipIf(!fileLinkWorks)('write: 根目录内的目标文件符号链接指向根目录外时被拒', () => {
    const outside = path.join(tmpDir, 'outside.txt')
    fs.writeFileSync(outside, 'outside')
    const link = path.join(root, 'report.txt')
    fs.symlinkSync(outside, link, 'file')
    expect(() => assertSafeLocalPath(link, { write: true, containmentRoot: root })).toThrow(/download directory/)
  })

  it.skipIf(!fileLinkWorks)('write: 最终目标是指向根目录外不存在文件的断链时被拒', () => {
    const missingOutside = path.join(tmpDir, 'missing', 'outside.txt')
    const link = path.join(root, 'report.txt')
    fs.symlinkSync(missingOutside, link, 'file')
    expect(() => assertSafeLocalPath(link, { write: true, containmentRoot: root })).toThrow(/download directory/)
  })

  it.skipIf(!fileLinkWorks)('read: 普通名称的符号链接指向 .ssh 私钥被拒（防经链接外泄）', () => {
    const sshDir = path.join(tmpDir, '.ssh')
    fs.mkdirSync(sshDir)
    const keyFile = path.join(sshDir, 'id_rsa')
    fs.writeFileSync(keyFile, 'fake-key')
    const link = path.join(tmpDir, 'innocent_key')
    fs.symlinkSync(keyFile, link, 'file')
    // 词法校验通过（innocent_key 无敏感模式），但 realpath=.ssh/id_rsa 命中敏感模式 -> 拒绝
    expect(() => assertSafeLocalPath(link, { write: false })).toThrow(/sensitive location/)
  })

  it('write: 根目录内的正常子目录（非链接）通过', () => {
    const sub = path.join(root, 'sub')
    fs.mkdirSync(sub)
    const target = path.join(sub, 'file.txt')
    expect(() => assertSafeLocalPath(target, { write: true, containmentRoot: root })).not.toThrow()
  })
})
