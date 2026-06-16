/**
 * LyShell MCP Server 入口
 * 独立的 Node.js 进程，通过 stdio 与 AI Agent 通信
 * 通过 HTTP API 调用 LyShell 主进程
 *
 * 此文件不依赖 Electron，仅使用 Node.js 内置模块和 @modelcontextprotocol/sdk
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { readPortFile, LyShellHttpClient } from './http-client'
import { TOOL_DEFINITIONS } from './tools'

async function main(): Promise<void> {
  // 1. 读取端口文件，发现 LyShell
  const portInfo = readPortFile()
  if (!portInfo) {
    console.error('LyShell is not running. Please start LyShell first.')
    process.exit(1)
  }

  // 2. 创建 HTTP 客户端
  const httpClient = new LyShellHttpClient(portInfo.port, portInfo.token)

  // 3. 健康检查
  const healthy = await httpClient.healthCheck()
  if (!healthy) {
    console.error('LyShell API is not responding. Please check if LyShell is running correctly.')
    process.exit(1)
  }

  console.error(`[lyshell-mcp] Connected to LyShell on port ${portInfo.port}`)

  // 4. 创建 MCP Server（使用底层 Server 类，支持原始 JSON Schema）
  const server = new Server(
    { name: 'lyshell', version: '1.0.0' },
    {
      capabilities: {
        tools: {}
      },
      instructions:
        'LyShell MCP Server - Provides terminal session management and remote file operations. ' +
        'Use list_sessions to discover available sessions, then use session IDs to execute commands, ' +
        'list/read/download/upload files on remote servers.'
    }
  )

  // 5. 注册工具列表处理器
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS
  }))

  // 6. 注册工具调用处理器
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      // list_sessions 使用 GET
      if (name === 'list_sessions') {
        const result = await httpClient.get('/api/sessions')
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }]
        }
      }

      // 其他工具使用 POST
      const apiPath = getApiPath(name)
      if (!apiPath) {
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
          isError: true
        }
      }

      const result = await httpClient.post(apiPath, args || {})
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }]
      }
    } catch (err: any) {
      // 脱敏：避免暴露内部路径、堆栈等敏感信息
      const safeMessage = err.message
        ? err.message.replace(/(?:C:\\|\/home\/|\/Users\/|\/root\/)[^\s"']*/g, '[path]')
        : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Error: ${safeMessage}` }],
        isError: true
      }
    }
  })

  // 7. 启动 stdio 传输
  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error('[lyshell-mcp] Server started, waiting for connections...')
}

/**
 * 工具名到 API 路径的映射
 */
function getApiPath(toolName: string): string | null {
  const map: Record<string, string> = {
    execute_command: '/api/execute',
    list_files: '/api/files/list',
    read_file: '/api/files/read',
    download_file: '/api/files/download',
    upload_file: '/api/files/upload',
    stat_file: '/api/files/stat',
    delete_file: '/api/files/delete',
    rename_file: '/api/files/rename',
    create_directory: '/api/files/mkdir',
    get_file_md5: '/api/files/md5'
  }
  return map[toolName] || null
}

main().catch(err => {
  console.error('[lyshell-mcp] Fatal error:', err)
  process.exit(1)
})