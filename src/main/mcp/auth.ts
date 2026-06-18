/**
 * MCP 鉴权令牌管理
 *
 * 维护两类 token：
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
 */

import * as crypto from 'crypto'
import log from 'electron-log'

export type TokenKind = 'global' | 'session'

export interface TokenBinding {
  kind: TokenKind
  /** 当 kind === 'session' 时，发起请求的 PTY 会话 ID（用于审计溯源） */
  originSessionId?: string
}

const sessionTokens = new Map<string, string>()  // sessionId -> token
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
 * 在 LyShell 退出时清空所有 token。
 */
export function clearAllTokens(): void {
  sessionTokens.clear()
  globalToken = null
}

/**
 * 解析请求 token。无效返回 null。
 *
 * 单次解析需扫描全局 token + 所有在线 session token。每次比较都用 timingSafeEqual，
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

  return null
}
