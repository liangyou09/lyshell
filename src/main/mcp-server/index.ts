/**
 * LyShell MCP Server 入口
 * 独立的 Node.js 进程，通过 stdio 与 AI Agent 通信
 * 通过 HTTP API 调用 LyShell 主进程
 *
 * 支持的工具: 会话管理、终端输入/输出、文件操作 + resources/prompts (P1)
 *
 * 此文件不依赖 Electron，仅使用 Node.js 内置模块和 @modelcontextprotocol/sdk
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

import { discoverLyshell, LyShellHttpClient } from './http-client'
import { TOOL_DEFINITIONS, ALIAS_DEFINITIONS, ALIAS_TO_NEW, HIDDEN_FROM_LIST_TOOLS } from './tools'

// ====================== 'current' 解析 ======================

/**
 * 把 'current' / '@current' 解析为 LYSHELL_MCP_SESSION_ID env 注入的真实 ID。
 * 其它值原样返回。env 缺失时抛错（提示客户端走 list_sessions 拿到的真实 ID）。
 *
 * 单一来源：CallTool 路径和 ReadResource 路径都走它，避免漏改。
 */
function resolveCurrentLiteral(sessionId: unknown): unknown {
  if (sessionId !== 'current' && sessionId !== '@current') return sessionId
  const envId = process.env.LYSHELL_MCP_SESSION_ID
  if (!envId) {
    throw new Error(
      "sessionId='current' is only valid when MCP server runs inside a LyShell PTY (LYSHELL_MCP_SESSION_ID not set)."
    )
  }
  return envId
}

/**
 * 在工具参数对象上替换 sessionId='current'（不可变更新；非对象/无 sessionId 时透传）。
 */
function resolveSessionId(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return args
  const resolved = resolveCurrentLiteral(args.sessionId)
  return resolved === args.sessionId ? args : { ...args, sessionId: resolved }
}

// ====================== 错误提示增强 ======================

function appendHint(safeMessage: string): string {
  const lower = safeMessage.toLowerCase()
  let hint = ''
  if (lower.includes('session not connected')) {
    hint = 'Call lyshell_reconnect_session to restore the connection, or lyshell_list_sessions to inspect status.'
  } else if (lower.includes('session not found')) {
    hint = 'Call lyshell_list_sessions to get current session IDs.'
  } else if (lower.includes('unauthorized') || lower.includes('permission')) {
    hint = 'Check Settings → Security → MCP in LyShell to grant the required capability.'
  } else if (lower.includes('only valid when mcp server runs inside a lyshell pty')) {
    hint = 'Pass an explicit sessionId from lyshell_list_sessions instead of "current".'
  } else if (lower.includes('not supported')) {
    hint = "This session type doesn't support the requested operation; check capabilities via lyshell_list_sessions."
  }
  return hint ? `${safeMessage}\nHint: ${hint}` : safeMessage
}

// ====================== 基于规则的 {{var}} 提取 ======================

/**
 * 从文本中提取 {{var_name}} 占位符，返回 MCP PromptArgument 数组（去重、有序）。
 *
 * 注：required 一律 false —— 我们没有"必填"信号(quick-command 只是一段命令模板,
 * 客户端可能确实想保留原始占位符)。未替换的 {{var}} 会原样进入最终命令文本,
 * description 已说明这一点,由 agent 决定是否补全。
 */
function detectTemplateVars(text: string): Array<{ name: string; description?: string; required?: boolean }> {
  const names = new Set<string>()
  const re = /\{\{\s*(\w+)\s*\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    names.add(m[1])
  }
  return Array.from(names).map(name => ({
    name,
    description: `Template variable: ${name}. If omitted, {{${name}}} stays in the rendered text verbatim.`,
    required: false
  }))
}

// ====================== main ======================

async function main(): Promise<void> {
  // 1. 发现 LyShell
  const conn = discoverLyshell()
  if (!conn) {
    console.error('LyShell is not running, or external MCP access is disabled.')
    process.exit(1)
  }

  // 2. 创建 HTTP 客户端
  const httpClient = new LyShellHttpClient(conn.port, conn.token)

  // 3. 健康检查
  const healthy = await httpClient.healthCheck()
  if (!healthy) {
    console.error('LyShell API is not responding. Please check if LyShell is running correctly.')
    process.exit(1)
  }

  console.error(`[lyshell-mcp] Connected to LyShell on port ${conn.port}`)

  // 4. 创建 MCP Server（注册 tools + resources + prompts）
  const server = new Server(
    { name: 'lyshell', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      },
      instructions:
        'LyShell MCP Server — terminal session management, interactive input, remote file operations, ' +
        'quick commands, AI agents, and session metadata. ' +
        'Use list_sessions to discover sessions shown in the left sidebar. By default it returns connected or pinned sessions only; pass includeAll=true to list every saved session. Use summary/status/pinned to choose a target. ' +
        "Inside a LyShell-spawned terminal, pass sessionId='current' to target the current PTY directly. " +
        'Use send_input / send_and_wait / execute_command to interact with sessions. ' +
        'Use reconnect_session to restore a dropped connection. ' +
        'Use run_on_sessions to broadcast a command across multiple servers. ' +
        'Use read_session_notes / write_session_notes to manage per-session summary, usage notes, and tags. ' +
        'Use create_session to open a session terminal: it reuses an existing saved session for the same target (host:port / serial path) ' +
        'or creates a new one, then auto-connects when credentials allow (SSH needs saved creds; telnet/serial/local always connect). ' +
        'New SSH sessions have no credentials and stay disconnected until the user fills them in LyShell. ' +
        'File tools cover what shell cannot do safely or efficiently: binary transfer (upload/download), ' +
        'structured listing/stat, and bounded text read. For mutating operations (rm, mv, mkdir, chmod, md5sum, ...) ' +
        'use execute_command — the SSH/PTY permission model already governs them. ' +
        'Resources: lyshell://sessions (list), lyshell://sessions/{id}/output (recent output), ' +
        'lyshell://quick-commands, lyshell://agents. ' +
        'Prompts: each quick-command is available as a template prompt via qc_* names. ' +
        'Tool annotations declare readOnly/destructive/idempotent — respect them in confirmation flows.'
    }
  )

  // ====================== Tools ======================

  // 部分 MCP 客户端（如 Claude Code 当前版本）对 outputSchema/structuredContent 支持不完整，
  // ListTools 时去掉 outputSchema，避免 "tools fetch failed"。CallTool 仍可用 structuredContent。
  //
  // A4：LYSHELL_MCP_HIDE_DEPRECATED=1/true 时不返回旧名别名，减少工具列表噪声、
  // 强制 agent 使用 lyshell_* 新名。旧名调用仍由 CallTool 的 ALIAS_TO_NEW 兼容（不会因隐藏而失效）。
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const hideDeprecated =
      process.env.LYSHELL_MCP_HIDE_DEPRECATED === '1' || process.env.LYSHELL_MCP_HIDE_DEPRECATED === 'true'
    const enableExecute =
      process.env.LYSHELL_MCP_ENABLE_EXECUTE === '1' || process.env.LYSHELL_MCP_ENABLE_EXECUTE === 'true'
    const all = hideDeprecated ? TOOL_DEFINITIONS : [...TOOL_DEFINITIONS, ...ALIAS_DEFINITIONS]
    const visible = enableExecute
      ? all
      : all.filter((tool) => !HIDDEN_FROM_LIST_TOOLS.has(tool.name))
    return { tools: visible.map(({ outputSchema: _, ...tool }) => tool) }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: requestedName, arguments: rawArgs } = request.params

    // P2: 旧名兼容 —— 转译为新名并打印 deprecation warning
    let name = requestedName
    if (ALIAS_TO_NEW[requestedName]) {
      const newName = ALIAS_TO_NEW[requestedName]
      console.error(`[lyshell-mcp] DEPRECATED tool name "${requestedName}", use "${newName}" instead.`)
      name = newName
    }

    try {
      const args = resolveSessionId(rawArgs as Record<string, unknown> | undefined)

      // lyshell_list_sessions: 使用 POST 支持过滤；空参数时等价于 GET 全量
      if (name === 'lyshell_list_sessions') {
        const result = await httpClient.post('/api/sessions', args || {})
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
          structuredContent: result.data
        }
      }

      // lyshell_read_session_notes: GET /api/sessions/:id/notes
      if (name === 'lyshell_read_session_notes') {
        const { sessionId } = (args || {}) as { sessionId: string }
        const result = await httpClient.get(`/api/sessions/${encodeURIComponent(sessionId)}/notes`)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
          structuredContent: result.data
        }
      }

      // lyshell_write_session_notes: POST /api/sessions/:id/notes
      if (name === 'lyshell_write_session_notes') {
        const { sessionId, ...body } = (args || {}) as { sessionId: string }
        const result = await httpClient.post(`/api/sessions/${encodeURIComponent(sessionId)}/notes`, body)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
          structuredContent: result.data
        }
      }

      // lyshell_create_session: POST /api/sessions/create
      if (name === 'lyshell_create_session') {
        const result = await httpClient.post('/api/sessions/create', args || {})
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
          structuredContent: result.data
        }
      }

      // lyshell_execute_command stream 模式：SSE 流式 + MCP progress notification 增量推送（A1）
      // progress notification 供客户端向用户展示实时输出；最终 CallToolResult 仍含完整 output/exitCode。
      if (name === 'lyshell_execute_command' && (args as Record<string, unknown> | undefined)?.stream === true) {
        const progressToken = (request.params as { _meta?: { progressToken?: unknown } })?._meta?.progressToken
        const result = await httpClient.postStream('/api/execute-stream', args || {}, async (evt) => {
          if (evt.type === 'chunk' && evt.chunk && progressToken !== undefined) {
            try {
              // progress 不递增：流式命令无已知总量，progress:0 仅作"心跳"让客户端展示；
              // 真正的增量输出由 message 承载（每个 stdout/stderr chunk 一条 progress notification）。
              await server.notification({
                method: 'notifications/progress',
                params: { progressToken, progress: 0, message: evt.chunk }
              })
            } catch {
              // 客户端可能未订阅 progress，忽略发送失败
            }
          }
        })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result
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
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
        structuredContent: result.data
      }
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : 'Unknown error'
      const safeMessage = rawMessage.replace(/(?:C:\\|\/home\/|\/Users\/|\/root\/)[^\s"']*/g, '[path]')
      const withHint = appendHint(safeMessage)
      return {
        content: [{ type: 'text' as const, text: `Error: ${withHint}` }],
        isError: true
      }
    }
  })

  // ====================== Resources (P1) ======================

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'lyshell://sessions',
        name: 'All LyShell sessions',
        description: 'All terminal sessions with their status, type, and capabilities.',
        mimeType: 'application/json'
      },
      {
        uri: 'lyshell://quick-commands',
        name: 'Quick commands',
        description: 'User-defined quick commands grouped by category.',
        mimeType: 'application/json'
      },
      {
        uri: 'lyshell://agents',
        name: 'AI Agent configurations',
        description: 'Pre-configured AI Agent launchers (Claude Code, Aider, etc.). Secrets redacted.',
        mimeType: 'application/json'
      }
      // 动态 resource lyshell://sessions/{id}/output 在 resourceTemplates 中声明（见下）
    ]
  }))

  // 资源 URI 模板 — 客户端凭此发现"会话最近输出"这一类参数化 resource
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: 'lyshell://sessions/{sessionId}/output',
        name: 'Session recent output',
        description:
          'Recent terminal output of a session (ANSI-stripped). ' +
          "Replace {sessionId} with an id from lyshell://sessions, or 'current' inside a LyShell-spawned PTY. " +
          'Append ?lines=N (1-1000, default 200) to control the window.',
        mimeType: 'application/json'
      }
    ]
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri

    try {
      // lyshell://sessions
      if (uri === 'lyshell://sessions') {
        const result = await httpClient.get('/api/sessions')
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result.data, null, 2) }]
        }
      }

      // lyshell://quick-commands
      if (uri === 'lyshell://quick-commands') {
        const result = await httpClient.get('/api/quick-commands')
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result.data, null, 2) }]
        }
      }

      // lyshell://agents
      if (uri === 'lyshell://agents') {
        const result = await httpClient.get('/api/agents')
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result.data, null, 2) }]
        }
      }

      // lyshell://sessions/{id}/output[?lines=N]
      {
        const [base, query] = uri.split('?')
        const m = base.match(/^lyshell:\/\/sessions\/([^/]+)\/output$/)
        if (m) {
          const sid = resolveCurrentLiteral(m[1]) as string
          const lines = new URLSearchParams(query || '').get('lines') || '200'
          const result = await httpClient.get(`/api/sessions/${encodeURIComponent(sid)}/output?lines=${encodeURIComponent(lines)}`)
          return {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result.data, null, 2) }]
          }
        }
      }

      return {
        contents: [],
        isError: true,
        description: `Unknown resource URI: ${uri}`
      }
    } catch (err: unknown) {
      return {
        contents: [],
        isError: true,
        description: err instanceof Error ? err.message : 'Unknown error'
      }
    }
  })

  // ====================== Prompts (P1) ======================

  /**
   * prompt list 从 quick-commands 动态拉取。
   * 使用缓存避免每次 list 都走 HTTP 调用（但确保首次和 refresh 实时）。
   * commandText 暂存用于 getPrompt 替换占位符。
   */
  let qcCache: Array<{ id: string; name: string; content: string }> | null = null
  const qcCacheText = new Map<string, string>() // promptName -> raw content

  async function refreshQcCache(): Promise<void> {
    try {
      const result = await httpClient.get('/api/quick-commands')
      if (result?.data?.commands) {
        qcCache = result.data.commands
        qcCacheText.clear()
        for (const cmd of result.data.commands) {
          const pName = `qc_${cmd.id.slice(0, 8)}`
          qcCacheText.set(pName, cmd.content)
        }
      }
    } catch {
      qcCache = qcCache || []
    }
  }

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    await refreshQcCache()
    const prompts = (qcCache || []).map(cmd => ({
      name: `qc_${cmd.id.slice(0, 8)}`,
      description: `[Quick Command] ${cmd.name}`,
      arguments: detectTemplateVars(cmd.content)
    }))
    return { prompts }
  })

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const raw = qcCacheText.get(name)
    if (!raw) {
      return {
        messages: [],
        description: `Unknown prompt: ${name}. Call prompts/list to see available quick-command prompts.`,
        isError: true
      }
    }

    // 填充 {{var}} 占位符
    let rendered = raw
    if (args) {
      for (const [key, val] of Object.entries(args)) {
        if (typeof val === 'string') {
          rendered = rendered.replace(new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, 'g'), val)
        }
      }
    }

    return {
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: rendered }
        }
      ]
    }
  })

  // ====================== 启动传输 ======================

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error('[lyshell-mcp] Server started, waiting for connections...')
}

// ====================== 工具 API 路径映射 ======================

function getApiPath(toolName: string): string | null {
  const map: Record<string, string> = {
    lyshell_send_input: '/api/send-input',
    lyshell_execute_command: '/api/execute',
    lyshell_read_output: '/api/read-output',
    lyshell_send_and_wait: '/api/send-and-wait',
    lyshell_reconnect_session: '/api/sessions/reconnect',
    lyshell_close_session: '/api/sessions/close',
    lyshell_open_connection_dialog: '/api/sessions/open-dialog',
    lyshell_wait_for_prompt: '/api/wait-for-prompt',
    lyshell_run_on_sessions: '/api/run-on-sessions',
    lyshell_tail_until: '/api/tail-until',
    lyshell_list_files: '/api/files/list',
    lyshell_read_file: '/api/files/read',
    lyshell_download_file: '/api/files/download',
    lyshell_upload_file: '/api/files/upload',
    lyshell_stat_file: '/api/files/stat'
  }
  return map[toolName] || null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

main().catch(err => {
  console.error('[lyshell-mcp] Fatal error:', err)
  process.exit(1)
})