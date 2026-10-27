import { join } from 'node:path'
import { startWebSshServer } from '../server'

void startWebSshServer({assetsDir:join(__dirname,'web')}).then(server => {
  console.log(`Web SSH: ${server.origin}`)
  console.log(`监听 0.0.0.0:${server.port}；局域网访问 http://本机IP:${server.port}。按 Ctrl+C 停止。`)
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void server.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGINT',stop)
  process.once('SIGTERM',stop)
}).catch(() => { console.error('Web SSH 启动失败，请检查 web 资源是否完整。'); process.exitCode=1 })
