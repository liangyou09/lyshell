import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BROWSER_SETTINGS_URI,
  type DefaultBrowserStatus
} from '@shared/default-browser'
import {
  assertExecutablePath,
  buildRegistrationValues,
  createDefaultBrowserActions,
  createWindowsRegApi,
  evaluateDefaultBrowserStatus,
  executableFromCommand,
  isCommandForExecutable,
  parseRegistryKeyPath,
  readRegistryString,
  resolveLaunchExecutable,
  type DefaultBrowserProbe,
  type DefaultBrowserRuntime,
  type RegistryValue,
  type WindowsRegApi,
  type WindowsRegValue
} from './default-browser'

const mocks = vi.hoisted(() => ({
  appPath: String.raw`C:\Program Files\LyShell\LyShell.exe`,
  packaged: false,
  openExternal: vi.fn()
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.packaged
    },
    getPath: () => mocks.appPath
  },
  shell: { openExternal: mocks.openExternal }
}))

const EXE = String.raw`C:\Program Files\LyShell 应用\LyShell.exe`
const PORTABLE = String.raw`D:\绿色 便携\LyShell 1.2\LyShell.exe`
const CLIENT = String.raw`HKCU\Software\Clients\StartMenuInternet\LyShell`
const REGISTRATION_PATH = String.raw`Software\Clients\StartMenuInternet\LyShell\Capabilities`
const URL_ASSOCIATIONS = String.raw`HKCU\Software\Clients\StartMenuInternet\LyShell\Capabilities\URLAssociations`
const REGISTERED_APPLICATIONS = String.raw`HKCU\Software\RegisteredApplications`
const PROG_ID = String.raw`HKCU\Software\Classes\LyShellURL`
const USER_CHOICE = String.raw`HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations`

function entry(key: string, name: string | null): string {
  return `${key}\u0000${name ?? ''}`
}

const goodProbe: DefaultBrowserProbe = {
  registrationComplete: true,
  registeredApplication: REGISTRATION_PATH,
  httpAssociation: 'LyShellURL',
  httpsAssociation: 'LyShellURL',
  progIdCommand: `"${EXE}" --open-url "%1"`,
  httpUserChoice: 'LyShellURL',
  httpsUserChoice: 'LyShellURL'
}

const packedRuntime = {
  platform: 'win32' as NodeJS.Platform,
  isPackaged: true,
  executablePath: EXE
}

function valueMap(values: RegistryValue[]): Map<string, string> {
  return new Map(values.map((value) => [`${value.key}\u0000${value.name ?? ''}`, value.value]))
}

function fakeRuntime(overrides: Partial<DefaultBrowserRuntime> = {}) {
  const store = new Map<string, string>()
  const writes: RegistryValue[] = []
  const opened: string[] = []
  const runtime: DefaultBrowserRuntime = {
    platform: 'win32',
    isPackaged: true,
    executablePath: EXE,
    async read(key, name) {
      return store.get(`${key}\u0000${name ?? ''}`) ?? null
    },
    async write(value) {
      writes.push(value)
      store.set(`${value.key}\u0000${value.name ?? ''}`, value.value)
    },
    async openExternal(url) {
      opened.push(url)
    },
    ...overrides
  }
  return { runtime, store, writes, opened }
}

function fakeApi(result: WindowsRegValue | (() => WindowsRegValue)): WindowsRegApi {
  return { read: () => (typeof result === 'function' ? result() : result) }
}

beforeEach(() => {
  mocks.packaged = false
  mocks.openExternal.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('默认浏览器注册值', () => {
  it('只注册 HTTP/HTTPS，并指向当前安装路径的专用命令', () => {
    const values = buildRegistrationValues(EXE)
    const map = valueMap(values)

    // RegisteredApplications 的值必须是相对 HKCU 的路径，不能带 hive 前缀。
    expect(map.get(entry(REGISTERED_APPLICATIONS, 'LyShell'))).toBe(REGISTRATION_PATH)
    expect(map.get(entry(REGISTERED_APPLICATIONS, 'LyShell'))).not.toMatch(/^(HKCU|HKLM|HKEY_)/i)
    expect(map.get(entry(URL_ASSOCIATIONS, 'http'))).toBe('LyShellURL')
    expect(map.get(entry(URL_ASSOCIATIONS, 'https'))).toBe('LyShellURL')
    expect(map.get(entry(PROG_ID, null))).toBe('LyShell URL')
    // URL Protocol 为空值才代表“可处理协议”；不写任何 .html / FileAssociations。
    expect(map.get(entry(PROG_ID, 'URL Protocol'))).toBe('')
    expect(values.some((value) => /\.html|FileAssociations/i.test(value.key))).toBe(false)
    expect(values.some((value) => /UserChoice/i.test(value.key))).toBe(false)

    const command = map.get(entry(`${PROG_ID}\\shell\\open\\command`, null))
    expect(command).toBe(`"${EXE}" --open-url "%1"`)
    expect(command).toContain('--open-url')
  })

  it('RegisteredApplications 最后写入，避免列表先看到半成品', () => {
    const values = buildRegistrationValues(EXE)
    const registeredIndex = values.findIndex(
      (value) => value.key === REGISTERED_APPLICATIONS && value.name === 'LyShell'
    )
    expect(registeredIndex).toBe(values.length - 1)
    expect(values.slice(0, -1).some((value) => value.key === REGISTERED_APPLICATIONS)).toBe(false)
    // 先写 ProgID/客户端/能力项，最后才对外登记。
    expect(values[0].key).toBe(PROG_ID)
    expect(values.some((value) => value.key === URL_ASSOCIATIONS)).toBe(true)
  })

  it('图标位于 DefaultIcon 子键的默认值，而不是父键的命名值', () => {
    const map = valueMap(buildRegistrationValues(PORTABLE))

    expect(map.get(entry(`${PROG_ID}\\DefaultIcon`, null))).toBe(`"${PORTABLE}",0`)
    expect(map.get(entry(`${CLIENT}\\DefaultIcon`, null))).toBe(`"${PORTABLE}",0`)
    expect(map.get(entry(PROG_ID, 'DefaultIcon'))).toBeUndefined()
    expect(map.get(entry(CLIENT, 'DefaultIcon'))).toBeUndefined()
  })

  it('带空格与中文的路径仍然整体加引号，图标与命令一致', () => {
    const map = valueMap(buildRegistrationValues(PORTABLE))

    expect(map.get(entry(`${CLIENT}\\shell\\open\\command`, null))).toBe(`"${PORTABLE}"`)
    expect(map.get(entry(`${PROG_ID}\\shell\\open\\command`, null))).toBe(
      `"${PORTABLE}" --open-url "%1"`
    )
  })

  it('拒绝相对路径、引号、换行与目录路径', () => {
    expect(() => assertExecutablePath('LyShell.exe')).toThrow(/无效/)
    expect(() => assertExecutablePath(String.raw`C:\LyShell\bad"name.exe`)).toThrow(/无效/)
    expect(() => assertExecutablePath('C:\\LyShell\\line\nbreak.exe')).toThrow(/无效/)
    expect(() => assertExecutablePath('C:\\LyShell\\')).toThrow(/无效/)
    expect(() => buildRegistrationValues('')).toThrow(/无效/)
    expect(assertExecutablePath(String.raw`C:\LyShell\LyShell.exe`)).toBe(
      String.raw`C:\LyShell\LyShell.exe`
    )
  })
})

describe('注册表读取与命令解析', () => {
  it('只接受 HKCU/HKLM 的绝对路径，不接受带 hive 前缀的 Capabilities 值', () => {
    expect(parseRegistryKeyPath(REGISTERED_APPLICATIONS)).toEqual({
      hive: 'HKCU',
      subKey: String.raw`Software\RegisteredApplications`
    })
    expect(parseRegistryKeyPath(String.raw`HKLM\Software\LyShell`)).toEqual({
      hive: 'HKLM',
      subKey: String.raw`Software\LyShell`
    })
    expect(parseRegistryKeyPath(REGISTRATION_PATH)).toBeNull()
    expect(parseRegistryKeyPath(String.raw`HKEY_CURRENT_USER\Software`)).toBeNull()
  })

  it('缺失返回 null，权限/类型/未知错误抛出而不是伪装成未注册', async () => {
    const read = (result: WindowsRegValue) =>
      readRegistryString(fakeApi(result), REGISTERED_APPLICATIONS, 'LyShell')

    await expect(read({ code: 2, type: 0, data: null })).resolves.toBeNull()
    await expect(read({ code: 3, type: 0, data: null })).resolves.toBeNull()
    await expect(read({ code: 5, type: 0, data: null })).rejects.toThrow(/被拒绝/)
    await expect(read({ code: 1630, type: 0, data: null })).rejects.toThrow(/REG_SZ/)
    await expect(read({ code: 87, type: 0, data: null })).rejects.toThrow(/错误码 87/)
    // 成功但类型不是 REG_SZ（例如 REG_DWORD=4）同样报错。
    await expect(read({ code: 0, type: 4, data: '1' })).rejects.toThrow(/REG_SZ/)
    await expect(read({ code: 0, type: 1, data: 'LyShell' })).resolves.toBe('LyShell')
    await expect(read({ code: 0, type: 1, data: '' })).resolves.toBe('')
  })

  it('默认值与命名值使用不同的读取路径', async () => {
    const calls: Array<{ key: string; name: string | null }> = []
    const api: WindowsRegApi = {
      read: (hive, subKey, valueName) => {
        calls.push({ key: `${hive}\\${subKey}`, name: valueName })
        return { code: valueName === null ? 0 : 2, type: 1, data: 'command' }
      }
    }

    await expect(readRegistryString(api, PROG_ID, null)).resolves.toBe('command')
    await expect(readRegistryString(api, PROG_ID, 'URL Protocol')).resolves.toBeNull()
    expect(calls).toEqual([
      { key: PROG_ID, name: null },
      { key: PROG_ID, name: 'URL Protocol' }
    ])
  })

  it('从带引号或不带引号的命令中取出可执行文件', () => {
    expect(executableFromCommand(`"${EXE}" --open-url "%1"`)).toBe(EXE)
    expect(executableFromCommand(String.raw`C:\LyShell\LyShell.exe --open-url "%1"`)).toBe(
      String.raw`C:\LyShell\LyShell.exe`
    )
    expect(executableFromCommand(`"${EXE} --open-url`)).toBeNull()
    expect(executableFromCommand('')).toBeNull()

    expect(isCommandForExecutable(`"${EXE}" --open-url "%1"`, EXE)).toBe(true)
    expect(isCommandForExecutable(`"${EXE.toUpperCase()}" --open-url "%1"`, EXE)).toBe(true)
    expect(isCommandForExecutable(`"${EXE}" --open-url "%1"`, PORTABLE)).toBe(false)
    expect(isCommandForExecutable(null, EXE)).toBe(false)
  })
})

describe('默认浏览器状态判定', () => {
  it('HTTP 与 HTTPS 都选中且注册路径匹配才算默认', () => {
    const status = evaluateDefaultBrowserStatus(packedRuntime, goodProbe)
    expect(status).toEqual({
      supported: true,
      registered: true,
      isDefault: true,
      canRegister: true
    })
  })

  it('只有 HTTP 或只有 HTTPS 时不能报告为默认', () => {
    expect(
      evaluateDefaultBrowserStatus(packedRuntime, { ...goodProbe, httpsUserChoice: 'ChromeHTML' })
        .isDefault
    ).toBe(false)
    expect(
      evaluateDefaultBrowserStatus(packedRuntime, { ...goodProbe, httpUserChoice: 'ChromeHTML' })
        .isDefault
    ).toBe(false)
    expect(
      evaluateDefaultBrowserStatus(packedRuntime, { ...goodProbe, httpsUserChoice: null }).isDefault
    ).toBe(false)
  })

  it('仅 ProgID 相同但注册命令属于别的路径时，不得误报默认', () => {
    const status = evaluateDefaultBrowserStatus(packedRuntime, {
      ...goodProbe,
      progIdCommand: `"${PORTABLE}" --open-url "%1"`
    })
    expect(status.registered).toBe(false)
    expect(status.isDefault).toBe(false)
  })

  it('RegisteredApplications 带 hive 前缀时视为未注册', () => {
    expect(
      evaluateDefaultBrowserStatus(packedRuntime, {
        ...goodProbe,
        registeredApplication: `HKCU\\${REGISTRATION_PATH}`
      }).registered
    ).toBe(false)
  })

  it('缺少 RegisteredApplications、任一协议或 UserChoice 时降级', () => {
    expect(
      evaluateDefaultBrowserStatus(packedRuntime, {
        ...goodProbe,
        registeredApplication: null
      }).registered
    ).toBe(false)
    expect(
      evaluateDefaultBrowserStatus(packedRuntime, { ...goodProbe, httpAssociation: 'ChromeHTML' })
        .registered
    ).toBe(false)
    expect(
      evaluateDefaultBrowserStatus(packedRuntime, { ...goodProbe, progIdCommand: null }).registered
    ).toBe(false)
    expect(
      evaluateDefaultBrowserStatus(packedRuntime, { ...goodProbe, httpUserChoice: null }).isDefault
    ).toBe(false)
  })

  it('开发模式与其它平台一律不注册、不报告默认', () => {
    const dev: DefaultBrowserStatus = evaluateDefaultBrowserStatus(
      { ...packedRuntime, isPackaged: false },
      goodProbe
    )
    expect(dev).toEqual({
      supported: true,
      registered: false,
      isDefault: false,
      canRegister: false
    })

    const linux = evaluateDefaultBrowserStatus(
      { ...packedRuntime, platform: 'linux' },
      goodProbe
    )
    expect(linux).toEqual({
      supported: false,
      registered: false,
      isDefault: false,
      canRegister: false
    })
  })
})

describe('默认浏览器注册动作', () => {
  it('非 Windows 与开发模式先拒绝：不写注册表、不打开设置', async () => {
    const linux = fakeRuntime({ platform: 'linux' })
    await expect(createDefaultBrowserActions(linux.runtime).request()).rejects.toThrow(/不支持/)
    expect(linux.writes).toEqual([])
    expect(linux.opened).toEqual([])

    const dev = fakeRuntime({ isPackaged: false })
    await expect(createDefaultBrowserActions(dev.runtime).request()).rejects.toThrow(/开发模式/)
    expect(dev.writes).toEqual([])
    expect(dev.opened).toEqual([])

    await expect(
      createDefaultBrowserActions(fakeRuntime({ platform: 'linux' }).runtime).getStatus()
    ).resolves.toEqual({
      supported: false,
      registered: false,
      isDefault: false,
      canRegister: false
    })
  })

  it('开发模式查询状态不读注册表，直接给出固定结果', async () => {
    const read = vi.fn(async () => {
      throw new Error('开发模式不应读取注册表')
    })
    const { runtime } = fakeRuntime({ isPackaged: false, read })

    await expect(createDefaultBrowserActions(runtime).getStatus()).resolves.toEqual({
      supported: true,
      registered: false,
      isDefault: false,
      canRegister: false
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('写入全部注册值并校验后才打开默认应用设置页', async () => {
    const { runtime, writes, opened } = fakeRuntime()
    const actions = createDefaultBrowserActions(runtime)

    await actions.request()

    expect(writes).toHaveLength(buildRegistrationValues(EXE).length)
    expect(writes.at(-1)).toEqual({
      key: REGISTERED_APPLICATIONS,
      name: 'LyShell',
      value: REGISTRATION_PATH
    })
    expect(opened).toEqual([DEFAULT_BROWSER_SETTINGS_URI])
    expect(DEFAULT_BROWSER_SETTINGS_URI).toBe('ms-settings:defaultapps?registeredAppUser=LyShell')

    const status = await actions.getStatus()
    expect(status.registered).toBe(true)
    // 注册完成不等于已被用户选中。
    expect(status.isDefault).toBe(false)
  })

  it('已完整注册时不重复写入，但仍然打开设置页', async () => {
    const { runtime, store, writes, opened } = fakeRuntime()
    for (const value of buildRegistrationValues(EXE)) {
      store.set(entry(value.key, value.name), value.value)
    }

    await createDefaultBrowserActions(runtime).request()

    expect(writes).toEqual([])
    expect(opened).toEqual([DEFAULT_BROWSER_SETTINGS_URI])
  })

  it('注册说明缺失或命令丢失 URL 参数时，重新补齐而不误报默认', async () => {
    for (const broken of ['description', 'command']) {
      const { runtime, store, writes } = fakeRuntime()
      for (const value of buildRegistrationValues(EXE)) store.set(entry(value.key, value.name), value.value)
      store.set(entry(`${USER_CHOICE}\\http\\UserChoice`, 'ProgId'), 'LyShellURL')
      store.set(entry(`${USER_CHOICE}\\https\\UserChoice`, 'ProgId'), 'LyShellURL')
      if (broken === 'description') store.delete(entry(`HKCU\\${REGISTRATION_PATH}`, 'ApplicationDescription'))
      else store.set(entry(`${PROG_ID}\\shell\\open\\command`, null), `"${EXE}"`)
      const actions = createDefaultBrowserActions(runtime)
      expect((await actions.getStatus()).isDefault).toBe(false)
      await actions.request()
      expect(writes).toHaveLength(buildRegistrationValues(EXE).length)
      expect((await actions.getStatus()).isDefault).toBe(true)
    }
  })

  it('并发请求串行执行：只写一次，每次请求都打开设置', async () => {
    const { runtime, writes, opened } = fakeRuntime()
    let active = 0
    let maxActive = 0
    const baseWrite = runtime.write.bind(runtime)
    runtime.write = async (value) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      try {
        await baseWrite(value)
      } finally {
        active -= 1
      }
    }

    const actions = createDefaultBrowserActions(runtime)
    await Promise.all([actions.request(), actions.request(), actions.request()])

    expect(maxActive).toBe(1)
    expect(writes).toHaveLength(buildRegistrationValues(EXE).length)
    expect(opened).toEqual(Array(3).fill(DEFAULT_BROWSER_SETTINGS_URI))
  })

  it('写入失败时抛错且不打开设置页', async () => {
    const { runtime, opened } = fakeRuntime({
      async write() {
        throw new Error('拒绝访问')
      }
    })
    await expect(createDefaultBrowserActions(runtime).request()).rejects.toThrow('拒绝访问')
    expect(opened).toEqual([])
  })

  it('写入后回读校验失败时抛错且不打开设置页', async () => {
    const { runtime, store, opened } = fakeRuntime()
    const originalRead = runtime.read
    runtime.read = async (key, name) =>
      key.endsWith('URLAssociations') && name === 'https' ? null : originalRead(key, name)

    await expect(createDefaultBrowserActions(runtime).request()).rejects.toThrow(/校验失败/)
    expect(store.size).toBeGreaterThan(0)
    expect(opened).toEqual([])
  })

  it('便携版用 PORTABLE_EXECUTABLE_FILE 注册，真实双协议选择后为默认', async () => {
    const { runtime, store, writes } = fakeRuntime({ executablePath: PORTABLE })
    store.set(`${USER_CHOICE}\\http\\UserChoice\u0000ProgId`, 'LyShellURL')
    store.set(`${USER_CHOICE}\\https\\UserChoice\u0000ProgId`, 'LyShellURL')
    const actions = createDefaultBrowserActions(runtime)

    await actions.request()

    expect(
      writes.find(
        (value) => value.key.endsWith('LyShellURL\\shell\\open\\command') && value.name === null
      )?.value
    ).toBe(`"${PORTABLE}" --open-url "%1"`)
    expect((await actions.getStatus()).isDefault).toBe(true)
  })
})

// 真实注册表往返需显式开启；常规测试不修改开发者的系统注册表。
const describeWindows = process.platform === 'win32' && process.env.LYSHELL_TEST_WINDOWS_REGISTRY === '1' ? describe : describe.skip

describeWindows('Windows 注册表读取（真实 WinAPI）', () => {
  const key = `HKCU\\Software\\LyShellDefaultBrowserQA-${process.pid}-${Date.now()}`
  const regExe = join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'reg.exe')
  const unicodeValue = String.raw`D:\程序 数据\LyShell 浏览器\LyShell.exe`

  function addValue(name: string, value: string): void {
    execFileSync(regExe, ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], {
      windowsHide: true
    })
  }

  it('Unicode 路径按宽字符往返，缺失与空值可区分', async () => {
    try {
      addValue('Unicode', unicodeValue)
      addValue('Empty', '')

      const api = await createWindowsRegApi()
      await expect(readRegistryString(api, key, 'Unicode')).resolves.toBe(unicodeValue)
      await expect(readRegistryString(api, key, 'Empty')).resolves.toBe('')
      await expect(readRegistryString(api, key, 'Missing')).resolves.toBeNull()
      await expect(readRegistryString(api, key, null)).resolves.toBeNull()
    } finally {
      // 只清理由本次测试创建的临时键，绝不触碰真实的默认应用注册项。
      execFileSync(regExe, ['delete', key, '/f'], { windowsHide: true, stdio: 'ignore' })
    }
  })
})

describe('启动文件解析', () => {
  it('便携版优先使用 PORTABLE_EXECUTABLE_FILE，非法值回退到 app.getPath', () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', PORTABLE)
    expect(resolveLaunchExecutable()).toBe(PORTABLE)

    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', 'relative\\LyShell.exe')
    expect(resolveLaunchExecutable()).toBe(String.raw`C:\Program Files\LyShell\LyShell.exe`)

    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', '')
    expect(resolveLaunchExecutable()).toBe(String.raw`C:\Program Files\LyShell\LyShell.exe`)
  })

  it('开发模式下 requestDefaultBrowser 直接拒绝且不打开设置', async () => {
    const module = await import('./default-browser')
    mocks.packaged = false
    await expect(module.requestDefaultBrowser()).rejects.toThrow(/开发模式|不支持/)
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})
