import { execFile } from 'child_process'
import { join, win32 } from 'path'
import { app, shell } from 'electron'
import {
  DEFAULT_BROWSER_APP_NAME,
  DEFAULT_BROWSER_DESCRIPTION,
  DEFAULT_BROWSER_PROG_ID,
  DEFAULT_BROWSER_SETTINGS_URI,
  type DefaultBrowserStatus
} from '@shared/default-browser'

/**
 * Windows 默认浏览器注册与状态查询。
 *
 * 只写 HKCU：
 * - RegisteredApplications\LyShell 指向 Capabilities（值是相对 HKCU 的路径）
 * - Clients\StartMenuInternet\LyShell 提供应用信息与启动命令
 * - Classes\LyShellURL 是仅服务 HTTP/HTTPS 的 ProgID
 *
 * 绝不写入 UserChoice，也不接管 .html 文件关联；最终选择由用户在
 * Windows 设置中完成。安装版由安装器注册，便携版只在用户明确点击
 * 设置入口后由本模块注册。
 *
 * 读取走 WinAPI RegGetValueW：reg.exe 的输出是控制台代码页（本机 CP936），
 * 用 UTF-8 解码会破坏中文路径；写入仍用无 shell 的 reg.exe，因为 Node 以
 * UTF-16 传递命令行参数，宽字符不会丢失。
 */

const REGISTRY_TIMEOUT_MS = 5_000
const REGISTRY_MAX_BUFFER = 1024 * 1024

const REGISTERED_APPLICATIONS_KEY = 'HKCU\\Software\\RegisteredApplications'
// RegisteredApplications 的值是相对 HKCU/HKLM 的路径，不能带 hive 前缀。
const CAPABILITIES_PATH = `Software\\Clients\\StartMenuInternet\\${DEFAULT_BROWSER_APP_NAME}\\Capabilities`
const CLIENT_PATH = `Software\\Clients\\StartMenuInternet\\${DEFAULT_BROWSER_APP_NAME}`
const CLIENT_KEY = `HKCU\\${CLIENT_PATH}`
const CLIENT_COMMAND_KEY = `${CLIENT_KEY}\\shell\\open\\command`
const CAPABILITIES_KEY = `HKCU\\${CAPABILITIES_PATH}`
const URL_ASSOCIATIONS_KEY = `${CAPABILITIES_KEY}\\URLAssociations`
const PROG_ID_KEY = `HKCU\\Software\\Classes\\${DEFAULT_BROWSER_PROG_ID}`
const PROG_ID_COMMAND_KEY = `${PROG_ID_KEY}\\shell\\open\\command`
const USER_CHOICE_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations'

const HKEY_CURRENT_USER = 0x80000001
const HKEY_LOCAL_MACHINE = 0x80000002
/** RRF_RT_REG_SZ：只接受 REG_SZ，其它类型由系统返回 ERROR_UNSUPPORTED_TYPE。 */
const RRF_RT_REG_SZ = 0x0000_0002
const REG_SZ = 1
const ERROR_SUCCESS = 0
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5
const ERROR_MORE_DATA = 234
const ERROR_UNSUPPORTED_TYPE = 1630
/** 只用于状态查询的短字符串；超过该长度说明读错了值，直接按异常处理。 */
const MAX_REGISTRY_VALUE_BYTES = 64 * 1024

export type RegistryHive = 'HKCU' | 'HKLM'

export interface RegistryValue {
  key: string
  /** null 表示该键的默认值。 */
  name: string | null
  value: string
}

export interface DefaultBrowserProbe {
  registrationComplete: boolean
  registeredApplication: string | null
  httpAssociation: string | null
  httpsAssociation: string | null
  progIdCommand: string | null
  httpUserChoice: string | null
  httpsUserChoice: string | null
}

export interface DefaultBrowserRuntime {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** 当前实例真正的启动文件：安装版为安装目录 exe，便携版为便携包装 exe。 */
  executablePath: string
  read(key: string, name: string | null): Promise<string | null>
  write(value: RegistryValue): Promise<void>
  openExternal(url: string): Promise<void>
}

/** WinAPI 读取结果的原始形态；code 为 Win32 LSTATUS，0 表示成功。 */
export interface WindowsRegValue {
  code: number
  /** REG_* 类型；失败时为 0。 */
  type: number
  /** 成功时的字符串，缺失或失败为 null。 */
  data: string | null
}

/**
 * 可注入的注册表读取接口。生产实现绑定 advapi32!RegGetValueW；
 * 测试可注入固定返回码，验证权限/未知错误不会被伪装成“未注册”。
 */
export interface WindowsRegApi {
  read(hive: RegistryHive, subKey: string, valueName: string | null): WindowsRegValue
}

/** 校验并规范化可执行文件路径；含引号/换行会使命令被截断，直接拒绝。 */
export function assertExecutablePath(executablePath: string): string {
  if (
    !executablePath ||
    !win32.isAbsolute(executablePath) ||
    /["\0\r\n]/.test(executablePath) ||
    executablePath.endsWith('\\')
  ) {
    throw new Error(`无效的默认可执行文件路径：${executablePath}`)
  }
  return win32.normalize(executablePath)
}

/**
 * 注册表里需要写入的完整值集合；顺序固定，测试据此核对契约。
 *
 * 顺序也是写入顺序：先 ProgID/客户端/能力项，最后才写 RegisteredApplications，
 * 这样 Windows 不会在列表里提前看到能力项缺失的半成品。
 */
export function buildRegistrationValues(executablePath: string): RegistryValue[] {
  const executable = assertExecutablePath(executablePath)
  const quoted = `"${executable}"`

  return [
    // ProgID：URL Protocol 为空值表示可处理 URL 协议，不声明文件类型。
    { key: PROG_ID_KEY, name: null, value: `${DEFAULT_BROWSER_APP_NAME} URL` },
    { key: PROG_ID_KEY, name: 'URL Protocol', value: '' },
    // 图标必须写在 DefaultIcon 子键的默认值上，不能是父键上名为 DefaultIcon 的值。
    { key: `${PROG_ID_KEY}\\DefaultIcon`, name: null, value: `${quoted},0` },
    { key: PROG_ID_COMMAND_KEY, name: null, value: `${quoted} --open-url "%1"` },
    // StartMenuInternet 客户端信息，供 Windows 设置读取显示名与图标。
    { key: CLIENT_KEY, name: null, value: DEFAULT_BROWSER_APP_NAME },
    { key: `${CLIENT_KEY}\\DefaultIcon`, name: null, value: `${quoted},0` },
    { key: CLIENT_COMMAND_KEY, name: null, value: quoted },
    // Capabilities：ApplicationDescription 是微软文档要求的必填项。
    { key: CAPABILITIES_KEY, name: 'ApplicationName', value: DEFAULT_BROWSER_APP_NAME },
    {
      key: CAPABILITIES_KEY,
      name: 'ApplicationDescription',
      value: DEFAULT_BROWSER_DESCRIPTION
    },
    { key: CAPABILITIES_KEY, name: 'ApplicationIcon', value: `${quoted},0` },
    { key: URL_ASSOCIATIONS_KEY, name: 'http', value: DEFAULT_BROWSER_PROG_ID },
    { key: URL_ASSOCIATIONS_KEY, name: 'https', value: DEFAULT_BROWSER_PROG_ID },
    // 最后登记到“默认应用”列表。
    {
      key: REGISTERED_APPLICATIONS_KEY,
      name: DEFAULT_BROWSER_APP_NAME,
      value: CAPABILITIES_PATH
    }
  ]
}

/** 从 shell 命令中取出可执行文件；支持带引号与不带引号的写法。 */
export function executableFromCommand(command: string | null): string | null {
  if (!command) return null
  const trimmed = command.trim()
  if (trimmed.startsWith('"')) {
    const closing = trimmed.indexOf('"', 1)
    return closing > 1 ? trimmed.slice(1, closing) : null
  }
  const match = /^(.+?\.exe)(?:\s|$)/i.exec(trimmed)
  return match ? match[1] : null
}

/** 命令中的可执行文件是否就是当前实例的启动文件（大小写不敏感）。 */
export function isCommandForExecutable(command: string | null, executablePath: string): boolean {
  const executable = executableFromCommand(command)
  if (!executable || !executablePath) return false
  return win32
    .normalize(executable)
    .toLowerCase() === win32.normalize(executablePath).toLowerCase()
}

/**
 * 把 RegGetValueW 的返回码分类：0 成功，2/3 表示值或键不存在（返回 null），
 * 其它错误必须抛出，不能伪装成“尚未注册”。
 */
export function classifyRegistryReadError(
  code: number,
  keyPath: string,
  valueName: string | null
): Error | null {
  if (code === ERROR_SUCCESS || code === ERROR_FILE_NOT_FOUND || code === ERROR_PATH_NOT_FOUND) {
    return null
  }
  const target = valueName === null ? `${keyPath}（默认值）` : `${keyPath}\\${valueName}`
  if (code === ERROR_ACCESS_DENIED) {
    return new Error(`读取注册表被拒绝：${target}`)
  }
  if (code === ERROR_UNSUPPORTED_TYPE) {
    return new Error(`注册表值不是 REG_SZ 类型：${target}`)
  }
  return new Error(`读取注册表失败（错误码 ${code}）：${target}`)
}

/** 解析 `HKCU\...` / `HKLM\...`；其它 hive 直接拒绝。 */
export function parseRegistryKeyPath(
  keyPath: string
): { hive: RegistryHive; subKey: string } | null {
  const match = /^(HKCU|HKLM)\\(.+)$/i.exec(keyPath.trim())
  if (!match) return null
  return {
    hive: match[1].toUpperCase() as RegistryHive,
    subKey: match[2]
  }
}

/**
 * 通过注入的 WinAPI 读取一个 REG_SZ 值。
 * 缺失（键或值不存在）返回 null；权限、类型或未知错误抛出。
 */
export async function readRegistryString(
  api: WindowsRegApi,
  keyPath: string,
  valueName: string | null
): Promise<string | null> {
  const parsed = parseRegistryKeyPath(keyPath)
  if (!parsed) {
    throw new Error(`不支持的注册表路径：${keyPath}`)
  }

  const result = api.read(parsed.hive, parsed.subKey, valueName)
  const error = classifyRegistryReadError(result.code, keyPath, valueName)
  if (error) throw error
  if (result.code !== ERROR_SUCCESS) return null
  if (result.type !== REG_SZ) {
    throw new Error(`注册表值不是 REG_SZ 类型：${keyPath}\\${valueName ?? '（默认值）'}`)
  }
  return result.data ?? ''
}

/**
 * 绑定 advapi32!RegGetValueW。只有真正需要读注册表时才加载 koffi，
 * 非 Windows 构建/测试不会触碰原生模块与 advapi32.dll。
 */
export async function createWindowsRegApi(): Promise<WindowsRegApi> {
  if (process.platform !== 'win32') {
    throw new Error('默认浏览器注册表读取仅支持 Windows')
  }

  const { default: koffi } = await import('koffi')
  const advapi32 = koffi.load('advapi32.dll')
  const regGetValueW = advapi32.func(
    'int __stdcall RegGetValueW(uintptr_t key, const void *subKey, const void *value, uint32_t flags, void *type, void *data, void *size)'
  )

  function read(hive: RegistryHive, subKey: string, valueName: string | null): WindowsRegValue {
    const hiveHandle = hive === 'HKCU' ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE
    const subKeyBuffer = Buffer.from(`${subKey}\0`, 'utf16le')
    const valueBuffer = valueName === null ? null : Buffer.from(`${valueName}\0`, 'utf16le')
    const typeBuffer = Buffer.alloc(4)
    const sizeBuffer = Buffer.alloc(4)

    // 第一次调用只问长度；pvData 为 NULL 时系统返回所需字节数。
    sizeBuffer.writeUInt32LE(0, 0)
    let code = Number(
      regGetValueW(
        hiveHandle,
        subKeyBuffer,
        valueBuffer,
        RRF_RT_REG_SZ,
        typeBuffer,
        null,
        sizeBuffer
      )
    )
    const type = typeBuffer.readUInt32LE(0)
    if (code !== ERROR_SUCCESS && code !== ERROR_MORE_DATA) {
      return { code, type, data: null }
    }
    if (type !== REG_SZ) {
      return { code: ERROR_UNSUPPORTED_TYPE, type, data: null }
    }

    const required = sizeBuffer.readUInt32LE(0)
    if (required === 0) return { code: ERROR_SUCCESS, type, data: '' }
    if (required > MAX_REGISTRY_VALUE_BYTES) {
      // 状态查询只读取短字符串；异常长度按“缓冲不足”报错，避免无界分配。
      return { code: ERROR_MORE_DATA, type, data: null }
    }

    const data = Buffer.alloc(required)
    sizeBuffer.writeUInt32LE(required, 0)
    code = Number(
      regGetValueW(
        hiveHandle,
        subKeyBuffer,
        valueBuffer,
        RRF_RT_REG_SZ,
        typeBuffer,
        data,
        sizeBuffer
      )
    )
    if (code !== ERROR_SUCCESS) {
      return { code, type: typeBuffer.readUInt32LE(0), data: null }
    }

    const bytes = Math.min(sizeBuffer.readUInt32LE(0), data.length)
    const raw = data.toString('utf16le', 0, bytes)
    const terminator = raw.indexOf('\0')
    return { code: ERROR_SUCCESS, type, data: terminator === -1 ? raw : raw.slice(0, terminator) }
  }

  return { read }
}

let windowsRegApiPromise: Promise<WindowsRegApi> | null = null

/** 进程内复用同一份 advapi32 绑定；加载失败不缓存，允许下次重试。 */
export function getWindowsRegApi(): Promise<WindowsRegApi> {
  if (!windowsRegApiPromise) {
    windowsRegApiPromise = createWindowsRegApi().catch((error: unknown) => {
      windowsRegApiPromise = null
      throw error
    })
  }
  return windowsRegApiPromise
}

async function readSystemRegistryValue(key: string, name: string | null): Promise<string | null> {
  return readRegistryString(await getWindowsRegApi(), key, name)
}

export function evaluateDefaultBrowserStatus(
  runtime: Pick<DefaultBrowserRuntime, 'platform' | 'isPackaged' | 'executablePath'>,
  probe: DefaultBrowserProbe
): DefaultBrowserStatus {
  if (runtime.platform !== 'win32') {
    return { supported: false, registered: false, isDefault: false, canRegister: false }
  }

  const canRegister = runtime.isPackaged
  const registered =
    canRegister &&
    probe.registrationComplete &&
    sameText(probe.registeredApplication, CAPABILITIES_PATH) &&
    sameText(probe.httpAssociation, DEFAULT_BROWSER_PROG_ID) &&
    sameText(probe.httpsAssociation, DEFAULT_BROWSER_PROG_ID) &&
    isCommandForExecutable(probe.progIdCommand, runtime.executablePath)

  // ProgID 只能说明“曾注册过”，必须同时核对 HTTP 与 HTTPS 的真实选择。
  const isDefault =
    registered &&
    sameText(probe.httpUserChoice, DEFAULT_BROWSER_PROG_ID) &&
    sameText(probe.httpsUserChoice, DEFAULT_BROWSER_PROG_ID)

  return { supported: true, registered, isDefault, canRegister }
}

export interface DefaultBrowserActions {
  getStatus(): Promise<DefaultBrowserStatus>
  request(): Promise<void>
}

/** 请求串行队列：并发点击只会有一次写入，后续请求复用已完成的注册。 */
let requestQueue: Promise<unknown> = Promise.resolve()

function enqueueRequest<T>(task: () => Promise<T>): Promise<T> {
  const run = requestQueue.then(task, task)
  // 队列自身吞掉失败，避免一次失败让后续请求永远被拒绝。
  requestQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function createDefaultBrowserActions(
  runtime: DefaultBrowserRuntime
): DefaultBrowserActions {
  async function readProbe(): Promise<DefaultBrowserProbe> {
    const expected = buildRegistrationValues(runtime.executablePath)
    const [actual, httpUserChoice, httpsUserChoice] = await Promise.all([
      Promise.all(expected.map(value => runtime.read(value.key, value.name))),
      runtime.read(`${USER_CHOICE_KEY}\\http\\UserChoice`, 'ProgId'),
      runtime.read(`${USER_CHOICE_KEY}\\https\\UserChoice`, 'ProgId')
    ])
    const values = new Map(expected.map((value, index) => [`${value.key}\0${value.name ?? ''}`, actual[index]]))
    const read = (key: string, name: string | null) => values.get(`${key}\0${name ?? ''}`) ?? null
    return {
      // Windows 列表还依赖说明、客户端命令和图标；缺少任何项都应修复，
      // 不能只凭 ProgID 与两个协议存在就跳过注册。
      registrationComplete: expected.every((value, index) => sameText(actual[index], value.value)),
      registeredApplication: read(REGISTERED_APPLICATIONS_KEY, DEFAULT_BROWSER_APP_NAME),
      httpAssociation: read(URL_ASSOCIATIONS_KEY, 'http'),
      httpsAssociation: read(URL_ASSOCIATIONS_KEY, 'https'),
      progIdCommand: read(PROG_ID_COMMAND_KEY, null),
      httpUserChoice,
      httpsUserChoice
    }
  }

  return {
    async getStatus() {
      if (runtime.platform !== 'win32') {
        return { supported: false, registered: false, isDefault: false, canRegister: false }
      }
      // 开发模式直接返回固定结果，不查询系统注册表：权限或异常不应掩盖
      // “开发版不可注册”的说明。
      if (!runtime.isPackaged) {
        return { supported: true, registered: false, isDefault: false, canRegister: false }
      }
      return evaluateDefaultBrowserStatus(runtime, await readProbe())
    },

    request() {
      return enqueueRequest(async () => {
        if (runtime.platform !== 'win32') {
          throw new Error('当前平台不支持注册默认浏览器')
        }
        if (!runtime.isPackaged) {
          throw new Error('开发模式不注册默认浏览器，请使用安装版或打包后的便携版')
        }

        // 已完整注册（且属于当前 exe）时不再重写，但仍需打开设置页让用户选择。
        const before = evaluateDefaultBrowserStatus(runtime, await readProbe())
        if (!before.registered) {
          // buildRegistrationValues 已按“ProgID/客户端/能力项在前、RegisteredApplications 在最后”排序。
          for (const value of buildRegistrationValues(runtime.executablePath)) {
            await runtime.write(value)
          }

          const after = evaluateDefaultBrowserStatus(runtime, await readProbe())
          if (!after.registered) {
            throw new Error('默认浏览器注册写入后校验失败，请检查 HKCU 注册表权限')
          }
        }

        await runtime.openExternal(DEFAULT_BROWSER_SETTINGS_URI)
      })
    }
  }
}

/** 便携包由 electron-builder 包装器启动，真实文件在 PORTABLE_EXECUTABLE_FILE。 */
export function resolveLaunchExecutable(): string {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  if (
    portable &&
    win32.isAbsolute(portable) &&
    !/["\0\r\n]/.test(portable) &&
    !portable.endsWith('\\')
  ) {
    return win32.normalize(portable)
  }
  return win32.normalize(app.getPath('exe'))
}

function sameText(left: string | null, right: string): boolean {
  return left !== null && left.trim().toLowerCase() === right.toLowerCase()
}

function regExePath(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  return systemRoot ? join(systemRoot, 'System32', 'reg.exe') : 'reg.exe'
}

/**
 * 写入仍通过无 shell 的 execFile 调用 reg.exe：参数不经 cmd 解析，路径里的
 * & | ^ 等字符不会被当作命令；Node 以 UTF-16 传递命令行，中文与空格路径不会
 * 像读取输出那样受控制台代码页影响。隐藏窗口并限制超时与输出体积。
 */
function runReg(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      regExePath(),
      args,
      {
        windowsHide: true,
        timeout: REGISTRY_TIMEOUT_MS,
        maxBuffer: REGISTRY_MAX_BUFFER
      },
      (error, _stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        resolve({ code, stderr: stderr ?? '' })
      }
    )
  })
}

async function writeRegistryValue(value: RegistryValue): Promise<void> {
  const args = ['add', value.key]
  if (value.name === null) {
    args.push('/ve')
  } else {
    args.push('/v', value.name)
  }
  args.push('/t', 'REG_SZ', '/d', value.value, '/f')
  const { code, stderr } = await runReg(args)
  if (code !== 0) {
    const detail = stderr.trim().slice(0, 200)
    throw new Error(
      `写入默认浏览器注册表失败：${value.key}\\${value.name ?? '(Default)'}${
        detail ? `（${detail}）` : ''
      }`
    )
  }
}

function createSystemRuntime(): DefaultBrowserRuntime {
  return {
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: resolveLaunchExecutable(),
    read: readSystemRegistryValue,
    write: writeRegistryValue,
    openExternal: (url) => shell.openExternal(url)
  }
}

/** 查询默认浏览器状态；不写注册表，非 Windows 直接返回不支持。 */
export async function getDefaultBrowserStatus(): Promise<DefaultBrowserStatus> {
  return createDefaultBrowserActions(createSystemRuntime()).getStatus()
}

/**
 * 确保当前实例已完成 HTTP/HTTPS 注册，然后打开 Windows 默认应用设置。
 * 非 Windows 或开发模式下先抛错，绝不写注册表，也不打开设置页。
 */
export async function requestDefaultBrowser(): Promise<void> {
  await createDefaultBrowserActions(createSystemRuntime()).request()
}
