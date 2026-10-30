import { app } from 'electron'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import * as path from 'path'
import { preferencesRepository } from '../storage/repository'

export interface McpAddCommand {
  /** 主配置：通用 mcpServers JSON，用 LyShell 自带 Electron 二进制 + ELECTRON_RUN_AS_NODE=1，无需系统 Node */
  config: string
  /** 备选配置：通用 mcpServers JSON，用系统 Node.js（若检测到），主配置失效时回退 */
  systemNodeConfig?: string
  /** Claude Code 专用：claude mcp add 命令（主配置，自带 Electron 二进制） */
  claudeCommand: string
  /** Codex CLI 专用：config.toml 片段（[mcp_servers.lyshell]） */
  codexConfig: string
  /** 当前是否允许外部 MCP 客户端接入 */
  externalAccess: boolean
}

/** 配置生成核心只读取显式输入，不访问路径、设置或可执行文件。 */
export interface McpClientConfigInput {
  scriptPath: string
  userDataDir: string
  execPath: string
  systemNodePath?: string
  externalAccess: boolean
}

function tomlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function buildMcpClientConfig({ scriptPath, userDataDir, execPath, systemNodePath, externalAccess }: McpClientConfigInput): McpAddCommand {

  const config = JSON.stringify({
    mcpServers: {
      lyshell: {
        command: execPath,
        args: [scriptPath],
        env: {
          LYSHELL_USER_DATA: userDataDir,
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    },
  }, null, 2)

  let systemNodeConfig: string | undefined
  if (systemNodePath) {
    const nodePath = systemNodePath
    systemNodeConfig = JSON.stringify({
      mcpServers: {
        lyshell: {
          command: nodePath,
          args: [scriptPath],
          env: {
            LYSHELL_USER_DATA: userDataDir,
          },
        },
      },
    }, null, 2)
  }

  // Claude Code 专用：claude mcp add 命令（主配置）
  const claudeCommand =
    `claude mcp add lyshell -e LYSHELL_USER_DATA="${userDataDir}" -e ELECTRON_RUN_AS_NODE=1 -- "${execPath}" "${scriptPath}"`

  // Codex 走 ~/.codex/config.toml 的 [mcp_servers.*]（key 是下划线 mcp_servers，非 mcpServers）
  const codexConfig = [
    '[mcp_servers.lyshell]',
    `command = "${tomlEscape(execPath)}"`,
    `args = ["${tomlEscape(scriptPath)}"]`,
    `env = { LYSHELL_USER_DATA = "${tomlEscape(userDataDir)}", ELECTRON_RUN_AS_NODE = "1" }`,
  ].join('\n')

  return { config, systemNodeConfig, claudeCommand, codexConfig, externalAccess }
}

function resolveSystemNodePath(): string | undefined {
  try {
    const candidates = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    }).trim().split(/\r?\n/).filter(Boolean)
    if (candidates.length) return candidates[0]
  } catch { /* 主配置使用 Electron，无需系统 Node。 */ }
  const candidates = process.platform === 'win32' ? [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe')
  ] : ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node']
  return candidates.find(candidate => existsSync(candidate))
}

/** 运行时适配：只在调用时读取 Electron 路径，保留打包的 asar 路径。 */
export function buildMcpAddCommand(externalAccess: boolean): McpAddCommand {
  return buildMcpClientConfig({
    scriptPath: app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar', 'dist', 'main', 'mcpServer.js')
      : path.join(__dirname, 'mcpServer.js'),
    userDataDir: app.getPath('userData'),
    execPath: process.execPath,
    systemNodePath: resolveSystemNodePath(),
    externalAccess
  })
}

export function getMcpAddCommandForIpc(): McpAddCommand {
  const security = preferencesRepository.get('security') as { mcp?: { allowExternalMcpClients?: boolean } } | undefined
  const legacy = preferencesRepository.get('mcpSecurity') as { allowExternalMcpClients?: boolean } | undefined
  return buildMcpAddCommand((security?.mcp || legacy)?.allowExternalMcpClients === true)
}
