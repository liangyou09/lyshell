/**
 * MCP 鉴权令牌管理
 *
 * 维护三类 token：
 *
 *   - global: LyShell 启动时生成；写入端口文件后任何能读到端口文件的本机进程都可使用。
 *             默认不写入端口文件（由 settings.security.mcp.allowExternalMcpClients 控制），
 *             此模式下全局 token 在内存中无效，等价于"外部访问关闭"。
 *
 *   - session: LyShell 启动本地 PTY（LOCAL 会话）时为该 PTY 单独生成；
 *             经 LYSHELL_MCP_TOKEN 环境变量注入 PTY 进程组。
 *             PTY 内孵出的 Claude Code / MCP Server 自动继承该变量，
 *             外部进程（不在该 PTY 子树）天然拿不到 —— 实现"只对 LyShell 内部终端开放"。
 *             PTY 关闭/会话删除时自动撤销。
 *
 *   - plugin: plugin host 里的 contributor 插件使用（见 docs/plugin-system-design.md §7/§8）。
 *             绑定 pluginId + 用户安装时批准的 capability 子集（grantedCapabilities）。
 *             不要求 allowExternalMcpClients（plugin 是内部 host，非外部 client），
 *             不受 settings.allow* 控制（grantedCapabilities 是独立授权）。
 *             插件启用/禁用/卸载时撤销（revokePluginToken，§8.4 三步撤销的第 2 步）。
 */

import * as crypto from 'crypto'
import log from 'electron-log'
import type { McpCapability } from '@shared/api-routes'

export type TokenKind = 'global' | 'session' | 'plugin'

export interface TokenBinding {
  kind: TokenKind
  /** 当 kind === 'session' 时，发起请求的 PTY 会话 ID（用于审计溯源） */
  originSessionId?: string
  /** 当 kind === 'plugin' 时，插件 ID（用于审计溯源 + 卸载时撤销） */
  pluginId?: string
  /** 当 kind === 'plugin' 时，用户安装时批准的 capability 子集 */
  capabilities?: McpCapability[]
  /**
   * 当 kind === 'plugin' 时，token 来源：'host' = 插件宿主进程凭据（运行时视图注册
   * 路由只接受它），'ui' = 界面视图页面凭据（callApi 回环用）。缺省视为 'host'
   * （兼容既有调用方）。鉴权能力集两者同权，均按 pluginId 路由 grantedCapabilities。
   */
  tokenSource?: 'host' | 'ui'
}

const sessionTokens = new Map<string, string>()  // sessionId -> token
const pluginTokens = new Map<string, { token: string; capabilities: McpCapability[] }>()  // pluginId -> { token, capabilities } —— 仅 host token
// UI token（插件界面视图专用凭据，docs/plugin-ui-views-plan.md §二）：与 host token 分表，
// 同一插件可同时持有两者，二次 bind 互不覆盖。token 只留在 main，不下发给 renderer/guest/插件宿主。
const pluginUiTokens = new Map<string, { token: string; capabilities: McpCapability[] }>()  // pluginId -> { token, capabilities }
let globalToken: string | null = null

/**
 * 旋转全局 token —— LyShell 启动时调用。
 * 是否写入端口文件由调用方根据用户设置决定；
 * 即使生成了也可通过 clearGlobalToken() 立即作废。
 */
export function rotateGlobalToken(): string {
  globalToken = crypto.randomBytes(32).toString('hex')
  return globalToken
}

export function getGlobalToken(): string | null {
  return globalToken
}

export function clearGlobalToken(): void {
  globalToken = null
}

/**
 * 为指定 PTY 会话生成 per-session token。
 * 调用方负责将其注入 PTY 的 env (LYSHELL_MCP_TOKEN)。
 * 重复绑定同一 sessionId 会先撤销旧 token。
 */
export function bindSessionToken(sessionId: string): string {
  revokeSessionToken(sessionId)
  const token = crypto.randomBytes(32).toString('hex')
  sessionTokens.set(sessionId, token)
  log.info(`[MCP][auth] bound session token for ${sessionId}`)
  return token
}

/**
 * 撤销指定会话的 token（PTY 关闭 / 会话删除 / 重连前调用）。
 */
export function revokeSessionToken(sessionId: string): void {
  if (sessionTokens.delete(sessionId)) {
    log.info(`[MCP][auth] revoked session token for ${sessionId}`)
  }
}

/**
 * 为指定插件生成 plugin token（plugin host 启动/启用插件时调用）。
 * 绑定 pluginId + 用户安装时批准的 capability 子集（grantedCapabilities）。
 * 重复绑定同一 pluginId 会先撤销旧 token。
 */
export function bindPluginToken(pluginId: string, capabilities: McpCapability[]): string {
  revokePluginToken(pluginId)
  const token = crypto.randomBytes(32).toString('hex')
  pluginTokens.set(pluginId, { token, capabilities })
  log.info(`[MCP][auth] bound plugin token for ${pluginId} (capabilities: ${capabilities.join(',')})`)
  return token
}

/**
 * 撤销指定插件的 token（插件禁用 / 卸载时调用，见 §8.4 三步撤销的第 2 步）。
 * 仅撤 host token —— 不碰 UI token（host-mgr.stop()/restart() 逐插件撤 host token
 * 时不得误撤仍启用插件的 UI token）。整插件撤销用 revokeAllPluginTokens。
 */
export function revokePluginToken(pluginId: string): void {
  if (pluginTokens.delete(pluginId)) {
    log.info(`[MCP][auth] revoked plugin token for ${pluginId}`)
  }
}

/**
 * 为指定插件生成 UI token（界面视图专用凭据：每个已启用且有视图的插件一个，
 * 含无 main 与 oneshot；动态注册首个视图时建立，注销最后一个视图时撤销）。
 * 与 host token 分表并存，互不覆盖。重复绑定同一 pluginId 会先撤销旧 UI token。
 */
export function bindPluginUiToken(pluginId: string, capabilities: McpCapability[]): string {
  revokePluginUiToken(pluginId)
  const token = crypto.randomBytes(32).toString('hex')
  pluginUiTokens.set(pluginId, { token, capabilities })
  log.info(`[MCP][auth] bound plugin UI token for ${pluginId} (capabilities: ${capabilities.join(',')})`)
  return token
}

/** 撤销指定插件的 UI token（注销最后一个视图 / 禁用 / 卸载 / 权限重签前调用）。 */
export function revokePluginUiToken(pluginId: string): void {
  if (pluginUiTokens.delete(pluginId)) {
    log.info(`[MCP][auth] revoked plugin UI token for ${pluginId}`)
  }
}

/** 插件当前是否持有 UI token（生命周期判定：有无视图凭据） */
export function hasPluginUiToken(pluginId: string): boolean {
  return pluginUiTokens.has(pluginId)
}

/** 取插件 UI token 明文（仅 main 进程内 callApi 回环调用使用，不下发任何进程） */
export function getPluginUiToken(pluginId: string): string | null {
  return pluginUiTokens.get(pluginId)?.token ?? null
}

/**
 * 整插件撤销：host token + UI token 一起撤（禁用/卸载/权限变更重签前的三步撤销）。
 */
export function revokeAllPluginTokens(pluginId: string): void {
  revokePluginToken(pluginId)
  revokePluginUiToken(pluginId)
}

/**
 * 在 LyShell 退出时清空所有 token。
 */
export function clearAllTokens(): void {
  sessionTokens.clear()
  pluginTokens.clear()
  pluginUiTokens.clear()
  globalToken = null
}

/**
 * 解析请求 token。无效返回 null。
 *
 * 单次解析需扫描全局 token + 所有在线 session + plugin token。每次比较都用 timingSafeEqual，
 * 单次成本 ~O(token_len)，在线 session 数远少于 100 —— 总耗时仍在微秒级。
 * 跨 token 候选者间不强求严格恒等时间：本地 loopback 鉴权场景下时序侧信道不实际成立。
 */
export function resolveToken(token: string | string[] | undefined): TokenBinding | null {
  if (typeof token !== 'string' || token.length === 0) return null

  const candidate = Buffer.from(token, 'utf8')

  if (globalToken) {
    const expected = Buffer.from(globalToken, 'utf8')
    if (expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)) {
      return { kind: 'global' }
    }
  }

  for (const [sessionId, sessionToken] of sessionTokens) {
    const expected = Buffer.from(sessionToken, 'utf8')
    if (expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)) {
      return { kind: 'session', originSessionId: sessionId }
    }
  }

  for (const [pluginId, { token: pluginToken, capabilities }] of pluginTokens) {
    const expected = Buffer.from(pluginToken, 'utf8')
    if (expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)) {
      return { kind: 'plugin', pluginId, capabilities, tokenSource: 'host' }
    }
  }

  for (const [pluginId, { token: uiToken, capabilities }] of pluginUiTokens) {
    const expected = Buffer.from(uiToken, 'utf8')
    if (expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)) {
      return { kind: 'plugin', pluginId, capabilities, tokenSource: 'ui' }
    }
  }

  return null
}
