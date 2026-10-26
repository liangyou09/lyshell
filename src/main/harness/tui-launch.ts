import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import type { TuiActivitySource } from '@shared/tui-activity'

const COMMON_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd']
const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`
const shQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
const encodedPowerShell = (script: string) => `powershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
// TOML literal strings have no escaping; fall back to basic strings for embedded apostrophes.
const tomlString = (value: string) => !/[\r\n']/u.test(value) ? `'${value}'` : JSON.stringify(value)
const transientFiles = new Set<string>()
export async function releaseTuiLaunchFiles(files: readonly string[]): Promise<void> {
  await Promise.all(files.map(async file => { if (transientFiles.has(file)) { await rm(file, { force: true }); transientFiles.delete(file) } }))
}
export function cleanupTuiLaunchFiles(): Promise<void> { return releaseTuiLaunchFiles([...transientFiles]) }

export interface TuiLaunchOptions {
  source: TuiActivitySource
  terminalId: string
  command: string
  dataDir: string
  helperPath: string
  executable: string
  platform: NodeJS.Platform
  shell?: string
}

/** 只给本次启动加通知钩子，不改写用户配置、模型、权限模式或 hooks 信任。 */
export async function prepareTuiLaunch(options: TuiLaunchOptions): Promise<{ command: string; settingsPath?: string; launchPath?: string }> {
  const { source, platform, executable, helperPath } = options
  const hookCommand = platform === 'win32'
    ? encodedPowerShell(`$env:ELECTRON_RUN_AS_NODE='1'; & ${psQuote(executable)} ${psQuote(helperPath)} hook`)
    : `ELECTRON_RUN_AS_NODE=1 ${shQuote(executable)} ${shQuote(helperPath)} hook`
  const events = [...COMMON_EVENTS, ...(source === 'claude' ? ['Notification', 'StopFailure', 'PostToolUseFailure'] : ['Interrupt'])]
  const quote = platform === 'win32' ? psQuote : shQuote
  const args: string[] = []
  let settingsPath: string | undefined
  if (source === 'claude') {
    const directory = join(options.dataDir, 'tui-activity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    settingsPath = join(directory, `${options.terminalId}.json`)
    const hooks = Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command: hookCommand, timeout: 3, onFailure: 'continue' }] }]]))
    await writeFile(settingsPath, JSON.stringify({ hooks }), { mode: 0o600, flag: 'wx' })
    transientFiles.add(settingsPath)
    args.push('--settings', settingsPath)
  } else {
    // 独立运行期保留当前 PTY 的通知凭据，避免共享 daemon 沿用另一启动的环境。
    args.push('--no-daemon')
    for (const event of events) args.push('-c', `hooks.${event}=[{hooks=[{type='command',command=${tomlString(hookCommand)},timeout=3}]}]`)
  }
  const command = `${options.command} ${args.map(quote).join(' ')}`
  if (platform === 'win32') {
    const directory = join(options.dataDir, 'tui-activity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const launchPath = join(directory, `${options.terminalId}.launch.txt`)
    try { await writeFile(launchPath, command, { mode: 0o600, flag: 'wx' }); transientFiles.add(launchPath) }
    catch (error) { if (settingsPath) await releaseTuiLaunchFiles([settingsPath]); throw error }
    // 短入口避免 cmd 的 8191 字符限制和终端长行回显；配置数据只含本次原有命令与通知定义。
    return { command: encodedPowerShell(`& ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(launchPath)})))`), settingsPath, launchPath }
  }
  return { command, settingsPath }
}
