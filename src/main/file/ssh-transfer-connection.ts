import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import type { SSHConfig } from '@shared/types'

type ConnectionLog = (level: 'info' | 'warn', message: string) => void
type ConnectionError = Error & { code?: string; level?: string }

/** 只重试连接阶段的暂时故障，认证拒绝、算法不兼容等确定错误不重试。 */
function canRetry(error: ConnectionError): boolean {
  return error.level === 'client-timeout' ||
    error.message.startsWith('Timed out while waiting for handshake') ||
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(error.code ?? '')
}

/**
 * 上传开始前建立连接：暂时故障最多重试一次，避免每次遇到慢握手都让用户重新拖放。
 * 无显式配置时第二次放宽到 60 秒；显式 readyTimeout 保持原值。
 * 返回已认证 client，文件传输错误不会进入本重试流程（防止重复覆盖远端文件）。
 */
export async function connectTransferSSH(config: SSHConfig, log: ConnectionLog): Promise<Client> {
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
      return await connectOnce(connectionConfig, log)
    } catch (error) {
      const err = error as ConnectionError
      if (attempt === 2 || !canRetry(err)) throw err
      log('warn', `SSH connection attempt failed: ${err.message}; retrying in 1000ms`)
      await new Promise<void>(resolve => setTimeout(resolve, 1000))
    }
  }
  throw new Error('SSH connection failed')
}

function connectOnce(config: ConnectConfig, log: ConnectionLog): Promise<Client> {
  const client = new Client()
  const startTime = Date.now()
  let phase = 'connection/key exchange'
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: ConnectionError) => {
      if (settled) return
      settled = true
      const err = Object.assign(new Error(`${error.message} (stage: ${phase}, elapsed: ${Date.now() - startTime}ms)`), {
        code: error.code,
        level: error.level
      })
      // 超时/关闭后的 socket 不留到下一次尝试；保留 error 监听以吸收销毁时的后续错误。
      client.destroy()
      reject(err)
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
      client.connect(config)
    } catch (error) {
      fail(error as ConnectionError)
    }
  })
}
