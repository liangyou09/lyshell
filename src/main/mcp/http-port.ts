// 端口状态独立于 HTTP 服务实现，供终端读取，避免反向加载服务端及其依赖。
let httpPort: number | null = null

export function getMcpHttpPort(): number | null {
  return httpPort
}

export function setMcpHttpPort(port: number | null): void {
  httpPort = port
}
