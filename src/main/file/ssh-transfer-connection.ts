import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import type { SSHConfig } from '@shared/types'
import {
  assertHostKeyMatches,
  createSsh2HostVerifier,
  isSshHostKeyError,
  normalizeSshEndpoint,
  SSH_FINGERPRINT_PATTERN,
  SshHostKeyError,
  type Ssh2HostVerifier,
  type TransferHostKeyExpectation
} from '../security/ssh-host-key'

type ConnectionLog = (level: 'info' | 'warn', message: string) => void
type ConnectionError = Error & { code?: string; level?: string }

/**
 * 只重试连接阶段的暂时故障，认证拒绝、算法不兼容等确定错误不重试。
 * 主机密钥拒绝（SshHostKeyError）必须显式排除：它是安全结论，重试只会重复被拒。
 */
function canRetry(error: ConnectionError): boolean {
  if (isSshHostKeyError(error)) return false
  return error.level === 'client-timeout' ||
    error.message.startsWith('Timed out while waiting for handshake') ||
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(error.code ?? '')
}

/**
 * 上传开始前建立连接：暂时故障最多重试一次，避免每次遇到慢握手都让用户重新拖放。
 * 无显式配置时第二次放宽到 60 秒；显式 readyTimeout 保持原值。
 * 返回已认证 client，文件传输错误不会进入本重试流程（防止重复覆盖远端文件）。
 *
 * `hostKey` 是主进程在 dispatch 前从可信记录读出的固定指纹（Worker 不读盘、不读
 * Electron、不信任请求自报的指纹）。缺失或不一致时在建连之前就拒绝。
 */
export async function connectTransferSSH(
  config: SSHConfig,
  log: ConnectionLog,
  hostKey: TransferHostKeyExpectation
): Promise<Client> {
  const endpoint = normalizeSshEndpoint(config.host, config.port)
  if (!hostKey || !hostKey.fingerprint || !SSH_FINGERPRINT_PATTERN.test(hostKey.fingerprint)) {
    throw new SshHostKeyError('SSH_HOST_KEY_UNAVAILABLE', `缺少可信主机密钥指纹，已拒绝连接（${endpoint}）`, {
      host: config.host,
      port: config.port,
      endpoint
    })
  }
  if (hostKey.endpoint !== endpoint) {
    throw new SshHostKeyError('SSH_HOST_KEY_INVALID', `注入的可信指纹与连接目标不一致（${hostKey.endpoint} ≠ ${endpoint}），已拒绝连接`, {
      host: config.host,
      port: config.port,
      endpoint
    })
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const readyTimeout = config.readyTimeout ?? (attempt === 1 ? 30000 : 60000)
    const connectionConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout,
      keepaliveInterval: config.keepaliveInterval ?? 10000,
      keepaliveCountMax: 3
    }
    if (config.password) connectionConfig.password = config.password
    else if (config.privateKey) {
      connectionConfig.privateKey = config.privateKey
      if (config.passphrase) connectionConfig.passphrase = config.passphrase
    }

    log('info', `Connecting to ${config.host}:${config.port} as ${config.username} (attempt ${attempt}/2, timeout ${readyTimeout}ms)`)
    try {
      return await connectOnce(connectionConfig, log, hostKey)
    } catch (error) {
      const err = error as ConnectionError
      if (attempt === 2 || !canRetry(err)) throw err
      log('warn', `SSH connection attempt failed: ${err.message}; retrying in 1000ms`)
      await new Promise<void>(resolve => setTimeout(resolve, 1000))
    }
  }
  throw new Error('SSH connection failed')
}

function connectOnce(
  config: ConnectConfig,
  log: ConnectionLog,
  hostKey: TransferHostKeyExpectation
): Promise<Client> {
  const client = new Client()
  const startTime = Date.now()
  let phase = 'connection/key exchange'
  /** 实际收到的主机公钥与固定指纹不一致时的明确原因 */
  let hostKeyFailure: SshHostKeyError | null = null

  // 必须显式配置 hostVerifier：ssh2 未配置时默认接受任何主机密钥（README R10）。
  const hostVerifier: Ssh2HostVerifier = createSsh2HostVerifier({
    host: config.host,
    port: config.port,
    decide: async (key) => {
      assertHostKeyMatches(key, config.host, config.port, hostKey.fingerprint)
    },
    onReject: (error) => {
      hostKeyFailure = isSshHostKeyError(error)
        ? error
        : new SshHostKeyError('SSH_HOST_KEY_REJECTED', `SSH 主机密钥校验失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const connectionConfig: ConnectConfig & { hostVerifier: Ssh2HostVerifier } = { ...config, hostVerifier }

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: ConnectionError) => {
      if (settled) return
      settled = true
      // 主机密钥拒绝直接上抛原始错误（带 code 与指纹），不套「stage/elapsed」——
      // 否则重试判断与界面提示都会把它当成普通握手失败。
      const surfaced: ConnectionError = hostKeyFailure ?? Object.assign(
        new Error(`${error.message} (stage: ${phase}, elapsed: ${Date.now() - startTime}ms)`),
        { code: error.code, level: error.level }
      )
      // 超时/关闭后的 socket 不留到下一次尝试；保留 error 监听以吸收销毁时的后续错误。
      client.destroy()
      reject(surfaced)
    }
    client.once('handshake', () => {
      phase = 'authentication'
      log('info', `SSH key exchange completed after ${Date.now() - startTime}ms; waiting for authentication`)
    })
    client.on('error', fail)
    client.once('close', () => fail(Object.assign(new Error('SSH connection closed before authentication completed'), { code: 'ECONNRESET' })))
    client.once('ready', () => {
      if (settled) return
      settled = true
      resolve(client)
    })
    try {
      client.connect(connectionConfig)
    } catch (error) {
      fail(error as ConnectionError)
    }
  })
}
