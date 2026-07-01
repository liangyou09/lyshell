/**
 * MCP HTTP 服务端 —— 无 MCP 构建的 no-op stub
 *
 * 与 src/main/mcp/http-server.ts 保持相同的导出签名，
 * 但在 no-MCP 构建中不启动任何 HTTP 服务。
 */

export function getMcpHttpPort(): number | null {
  return null
}

export async function startMcpHttpServer(): Promise<void> {
  // no-op
}

export async function stopMcpHttpServer(): Promise<void> {
  // no-op
}
