/**
 * MCP 工具定义
 *
 * 每个工具同时声明:
 *  - inputSchema  —— JSON Schema, 含 min/max/minLength 等约束 (与服务端 MAX_* 常量一致)
 *  - outputSchema —— 响应 data 字段的结构 (与 src/main/mcp/types.ts 对应)
 *  - annotations  —— readOnlyHint / destructiveHint / idempotentHint / openWorldHint
 *  - title        —— 短的人类标签 (中英结合, 便于客户端 UI)
 *
 * 服务端的 MAX_COMMAND_TIMEOUT_MS / MAX_READ_FILE_BYTES 等常量保持不变, 作为最终防线。
 *
 * 工具名统一以 lyshell_ 为前缀。旧名作为 ALIAS_DEFINITIONS 数组在 ListTools 中一起返回，
 * 但 description 以 [DEPRECATED, use lyshell_<x>] 为前缀，引导 agent 自动选新名。
 */

/** 通用 sessionId 字段定义 (支持 'current' 字面量, 在 mcp-server/index.ts 内解析) */
const sessionIdField = {
  type: 'string',
  minLength: 1,
  description:
    "The session ID to target. Pass 'current' (only when running inside a LyShell-spawned PTY) " +
    'to use the session that owns this MCP server process.'
}

/** 通用文件路径字段 */
const remotePathField = (desc: string) => ({
  type: 'string',
  minLength: 1,
  description: desc
})

// ====================== 输出 schema 子片段 ======================

const sessionInfoSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    type: { type: 'string', enum: ['ssh', 'telnet', 'serial', 'local'] },
    status: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'number' },
    group: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    capabilities: {
      type: 'object',
      properties: {
        sendInput: { type: 'boolean' },
        executeCommand: { type: 'boolean' },
        fileOperations: { type: 'boolean' },
        readOutput: { type: 'boolean' }
      },
      required: ['sendInput', 'executeCommand', 'fileOperations', 'readOutput']
    },
    // 协议专属字段
    username: { type: 'string' },
    path: { type: 'string' },
    baudRate: { type: 'number' },
    shell: { type: 'string' },
    cwd: { type: 'string' },
    // 辅助 agent 识别与排序
    summary: { type: 'string' },
    pinned: { type: 'boolean' },
    connectCount: { type: 'number' },
    updatedAt: { type: 'string' }
  },
  required: ['id', 'name', 'type', 'status', 'tags', 'capabilities']
}

const sessionNotesSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string' },
    summary: { type: 'string' },
    usageNotes: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    hasTags: { type: 'boolean' },
    updatedAt: { type: 'string' },
    isEmpty: { type: 'boolean' }
  },
  required: ['sessionId', 'tags', 'hasTags', 'updatedAt', 'isEmpty']
}

const fileEntrySchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    path: { type: 'string' },
    type: { type: 'string', enum: ['file', 'directory', 'symlink'] },
    size: { type: 'number' },
    mtime: { type: 'string' },
    mode: { type: 'number' },
    uid: { type: 'number' },
    gid: { type: 'number' }
  }
}

// ====================== 主工具定义 (lyshell_* 前缀) ======================

export const TOOL_DEFINITIONS = [
  // ---------- 会话管理 ----------
  {
    name: 'lyshell_list_sessions',
    title: '列出 LyShell 会话',
    description:
      'List LyShell sessions shown in the left sidebar. By default only connected or pinned sessions are returned, ' +
      'to keep the result focused and avoid overwhelming context. Pass includeAll=true to list every saved session, including disconnected ones. ' +
      'This is the primary discovery tool: call it first to see what sessions exist and pick a target sessionId for other tools. ' +
      'Each entry includes id, name, type (ssh/telnet/serial/local), live status, host/port or path/shell, tags, pinned flag, ' +
      'connectCount, updatedAt, summary, and capabilities. Use summary to understand what a session is for without extra calls. ' +
      'Default sort: connected first, then pinned, then most recently updated. ' +
      'Requires the read MCP capability for global tokens; LyShell-spawned PTY tokens bypass capability checks. ' +
      'Supports optional filter parameters: status, type, tag, pinned, search, includeAll, limit, offset.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['connected', 'disconnected', 'connecting', 'error'], description: 'Filter by session connection status. NOTE: the default visibility filter already excludes disconnected sessions, so status=disconnected returns nothing unless you also pass includeAll=true.' },
        type: { type: 'string', enum: ['ssh', 'telnet', 'serial', 'local'], description: 'Filter by connection type.' },
        tag: { type: 'string', description: 'Filter by tag name.' },
        pinned: { type: 'boolean', description: 'Filter by pinned state (true = pinned, false = unpinned).' },
        search: { type: 'string', description: 'Substring search against session name, host, summary, and tags.' },
        includeAll: { type: 'boolean', description: 'If true, return every saved session including disconnected ones. Default false (connected or pinned only).' },
        limit: { type: 'number', minimum: 1, maximum: 500, description: 'Max results (default 50).' },
        offset: { type: 'number', minimum: 0, description: 'Pagination offset (default 0).' }
      },
      required: [] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        sessions: { type: 'array', items: sessionInfoSchema },
        total: { type: 'number' },
        offset: { type: 'number' },
        limit: { type: 'number' }
      },
      required: ['sessions', 'total', 'offset', 'limit']
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'lyshell_reconnect_session',
    title: '重连会话',
    description:
      'Reconnect a disconnected/errored session, or refresh an already-connected one. ' +
      'Useful when send_input/execute_command returns "Session not connected" after an SSH drop. ' +
      'Idempotent: calling on a connected session disconnects then reconnects fresh. ' +
      'Requires the sessionControl MCP capability. ' +
      'NOTE: returns as soon as the connect call is dispatched — for SSH/Telnet the actual handshake completes ' +
      "asynchronously, so the response status may still be 'connecting'. " +
      'Poll lyshell_list_sessions (filter by id) or call lyshell_wait_for_prompt to confirm the session is ready before sending input.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField
      },
      required: ['sessionId'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' },
        status: { type: 'string' }
      },
      required: ['sessionId', 'status']
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'lyshell_close_session',
    title: '关闭会话连接（scope-limited）',
    description:
      'Close (disconnect) a session\'s live terminal connection. The saved session entry is NOT deleted — ' +
      'call lyshell_reconnect_session to restore it later. ' +
      'SCOPE: a LyShell-spawned PTY token (sessionId="current") can only close its OWN session; ' +
      'a global token can close any session (requires the sessionControl capability). ' +
      'Closing an already-disconnected session is a no-op returning status=not_connected. ' +
      'Use this to cleanly tear down a session you opened via lyshell_create_session when done.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField
      },
      required: ['sessionId'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' },
        status: { type: 'string', enum: ['disconnected', 'not_connected'], description: 'disconnected=closed a live connection; not_connected=there was no live connection to close.' }
      },
      required: ['sessionId', 'status']
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'lyshell_open_connection_dialog',
    title: '打开新建连接对话框',
    description:
      'Open the LyShell "new connection" dialog so the USER can fill in connection details and credentials interactively. ' +
      'Use this when you need credentials that MCP cannot accept (e.g. creating an SSH session to a new host — ' +
      'lyshell_create_session never accepts passwords/keys, so a brand-new SSH session cannot auto-connect). ' +
      'Hand off to the user with this tool, then poll lyshell_list_sessions to find the newly connected session. ' +
      'This tool carries NO credentials through the MCP channel — the dialog is filled entirely in the LyShell UI. ' +
      'CRITICAL: ask the user / explain why the dialog is opening before calling, then set userConfirmed=true.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        userConfirmed: {
          type: 'boolean',
          description: 'Set to true only after telling the user the connection dialog is about to open and why.'
        }
      },
      required: ['userConfirmed'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        opened: { type: 'boolean', description: 'true if the open-dialog signal was dispatched to the LyShell UI.' },
        message: { type: 'string', description: 'Next-step guidance for the agent.' }
      },
      required: ['opened', 'message']
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },

  // ---------- 会话摘要与使用说明 ----------
  {
    name: 'lyshell_read_session_notes',
    title: '读取会话摘要和使用说明',
    description:
      'Read the summary, usage notes, and tags of a LyShell session. ' +
      'CRITICAL: If `isEmpty` is true (both summary and usageNotes are missing/empty), ' +
      'you MUST ask the user to describe this session before writing anything. ' +
      'Ask for: (1) a one-sentence summary of its purpose; (2) usage notes, common commands, or precautions; ' +
      '(3) tags describing what kind of device/server this is. ' +
      'Suggested tags if unclear: compile-server, build-server, ips-device, firewall, router, switch, ' +
      'database-server, k8s-node, bastion, test-env, prod-env, staging. ' +
      'Note: `pinned` is a system tag (set via the LyShell UI to pin a session to the top), not user content — do not treat it as a user-defined tag. ' +
      'Do not invent content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField
      },
      required: ['sessionId'] as string[]
    },
    outputSchema: sessionNotesSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'lyshell_write_session_notes',
    title: '写入会话摘要和使用说明',
    description:
      'Write or update the summary, usage notes, and tags of a LyShell session. ' +
      'CRITICAL: Before calling this tool, you MUST ask the user for the following key information ' +
      'and only proceed after explicit approval: ' +
      '(1) target session — confirm the exact sessionId or session name; ' +
      '(2) exact summary text, or confirmation to keep/clear the existing summary; ' +
      '(3) exact usage notes text, or confirmation to keep/clear the existing usage notes; ' +
      '(4) complete list of tags (tags are fully replaced, not merged); ' +
      '(5) whether to overwrite existing non-empty summary/usage notes. ' +
      'Set `userConfirmed=true` only after the user explicitly approves. ' +
      'Semantics: missing field = unchanged, "" = clear, tags provided = full replacement. ' +
      'The `pinned` tag is a system tag and is preserved automatically even when you replace all tags — do not include it in your tags array. ' +
      'If the session currently has no notes, first call lyshell_read_session_notes to confirm `isEmpty=true`, ' +
      'then ask the user for the missing information.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        summary: {
          type: 'string',
          maxLength: 500,
          description: 'Summary text. Omit to keep existing. Pass empty string to clear.'
        },
        usageNotes: {
          type: 'string',
          maxLength: 10000,
          description: 'Usage notes text. Omit to keep existing. Pass empty string to clear.'
        },
        tags: {
          type: 'array',
          items: { type: 'string', maxLength: 50 },
          maxItems: 20,
          description: 'Complete list of tags to set. Omit to keep existing tags unchanged.'
        },
        overwrite: {
          type: 'boolean',
          description: 'Allow overwriting existing non-empty summary/usage notes. Default false.'
        },
        userConfirmed: {
          type: 'boolean',
          description: 'Set to true only after explicitly asking the user for all key information and receiving approval.'
        }
      },
      required: ['sessionId', 'userConfirmed'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' },
        summary: { type: 'string' },
        usageNotes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        hasTags: { type: 'boolean' },
        updatedAt: { type: 'string' },
        isEmpty: { type: 'boolean' }
      },
      required: ['sessionId', 'tags', 'hasTags', 'updatedAt', 'isEmpty']
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'lyshell_create_session',
    title: '创建新会话（不含凭据）',
    description:
      'Create or reuse a LyShell session (SSH / Telnet / Serial / Local) and optionally open a connected terminal.\n\n' +
      'REUSE: if a saved session pointing at the same target already exists (SSH/Telnet by host:port, Serial by path), ' +
      'it is reused as-is — its saved credentials/notes win and any notes you pass are ignored (use lyshell_write_session_notes ' +
      'to update them). Only when no match exists is a new saved session created. Local sessions are never deduped (always fresh).\n\n' +
      'AUTO-CONNECT: by default (connect=true) the session is connected and its terminal opened. SSH auto-connects only if that ' +
      'session already has saved credentials (password/privateKey); a brand-new SSH session has no credentials — this tool NEVER ' +
      'accepts them — so it will NOT connect, and the user must fill password/key in the LyShell dialog and connect manually. ' +
      'Telnet/Serial/Local need no credentials and always auto-connect. Set connect=false to just save/reuse without connecting.\n\n' +
      'SECURITY: This tool NEVER accepts credentials. Fields `password`, `privateKey`, `passphrase` are rejected by design.\n\n' +
      'REQUIRES: the `sessionControl` MCP capability (same as lyshell_reconnect_session). Creating a session is a control ' +
      'operation and is NOT governed by the session-notes-write toggle — enabling notes-write alone will not allow creation.\n\n' +
      'CRITICAL: Before calling this tool, you MUST ask the user for the following and only proceed after explicit approval:\n' +
      '  (1) session type — ssh / telnet / serial / local;\n' +
      '  (2) connection target — host+port (ssh/telnet), device path (serial), or shell/cwd (local);\n' +
      '  (3) session name (or confirm auto-derive from host);\n' +
      '  (4) summary — a one-sentence description of the purpose;\n' +
      '  (5) usage notes — common commands, precautions;\n' +
      '  (6) tags — what kind of device/server (e.g. compile-server, ips-device, firewall, router, switch, database-server, k8s-node, bastion, test-env, prod-env, staging);\n' +
      '  (7) startup commands — optional, one per array element.\n' +
      'Set `userConfirmed=true` only after the user approves all fields.\n' +
      'Do not invent connection targets or notes — always ask.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          maxLength: 200,
          description: 'Session name. Omit to auto-derive from host/path/type.'
        },
        type: {
          type: 'string',
          enum: ['ssh', 'telnet', 'serial', 'local'],
          description: 'Connection type.'
        },
        ssh: {
          type: 'object',
          additionalProperties: false,
          properties: {
            host: { type: 'string', minLength: 1, description: 'SSH host (IP or hostname).' },
            port: { type: 'number', minimum: 1, maximum: 65535, description: 'SSH port (default 22).' },
            username: { type: 'string', description: 'SSH username.' },
            shellEnterCommands: { type: 'string', description: 'Commands to send right after login (multi-line, one per line).' },
            shellEnterWait: { type: 'number', minimum: 0, maximum: 60000, description: 'Wait ms after each shell-init line.' }
          },
          required: ['host'],
          description: 'SSH connection details. Required when type=ssh. Credentials (password/privateKey) are NOT accepted here.'
        },
        telnet: {
          type: 'object',
          additionalProperties: false,
          properties: {
            host: { type: 'string', minLength: 1, description: 'Telnet host.' },
            port: { type: 'number', minimum: 1, maximum: 65535, description: 'Telnet port (default 23).' }
          },
          required: ['host'],
          description: 'Telnet connection details. Required when type=telnet.'
        },
        serial: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', minLength: 1, description: 'Device path, e.g. COM5 / /dev/ttyUSB0.' },
            baudRate: { type: 'number', minimum: 300, description: 'Baud rate (default 9600).' }
          },
          required: ['path'],
          description: 'Serial connection details. Required when type=serial.'
        },
        local: {
          type: 'object',
          additionalProperties: false,
          properties: {
            shell: { type: 'string', description: 'Absolute path to the shell binary, e.g. powershell / pwsh / cmd.exe / bash. Omit for default.' },
            cwd: { type: 'string', description: 'Working directory. Omit for user home.' }
          },
          description: 'Local PTY details. Optional when type=local.'
        },
        summary: { type: 'string', maxLength: 500, description: 'One-sentence summary. Omit to leave empty.' },
        usageNotes: { type: 'string', maxLength: 10000, description: 'Multi-line usage notes / precautions.' },
        tags: {
          type: 'array',
          items: { type: 'string', maxLength: 50 },
          maxItems: 20,
          description: 'Tags. Complete list (not merged with anything, since the session is new).'
        },
        startupCommands: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 50,
          description: 'Commands to run automatically after the session connects (one per array element).'
        },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'gbk', 'gb2312'],
          description: 'Terminal charset (default utf-8).'
        },
        userConfirmed: {
          type: 'boolean',
          description: 'Set to true only after asking the user for all key fields listed in the description and receiving approval.'
        },
        connect: {
          type: 'boolean',
          description: 'Whether to auto-connect and open the terminal after create/reuse (default true). SSH auto-connects only if saved credentials exist; a new SSH session has none and will not connect regardless.'
        },
        waitForReady: {
          type: 'boolean',
          description: 'If true (and connect=true with credentials available), block until the connection handshake completes before returning — status=connected on success, status=error on failure. Default false returns immediately with status=connecting. Use true when the next step needs the session to be actually connected (e.g. execute_command right after). No-op for SSH without saved creds (stays disconnected) or connect=false.'
        }
      },
      required: ['type', 'userConfirmed'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'ID of the created or reused session.' },
        name: { type: 'string' },
        type: { type: 'string' },
        notes: sessionNotesSchema,
        created: { type: 'boolean', description: 'true if a new saved session was created; false if an existing same-target session was reused.' },
        status: { type: 'string', enum: ['connecting', 'connected', 'disconnected', 'error'], description: 'Connection status after the call.' },
        message: { type: 'string', description: 'Present when not auto-connected, explaining why (e.g. missing credentials, connect=false).' }
      },
      required: ['sessionId', 'name', 'type', 'notes', 'created', 'status']
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'lyshell_send_input',
    title: '向终端发送输入',
    description:
      'Send text input directly to an interactive terminal session, as if the user typed it. ' +
      'Works with ALL session types (SSH, Telnet, Serial, Local). ' +
      'Use this to interact with interactive CLI programs like codex, vim, htop, gdb, etc. ' +
      'Supports escape sequences: \\n for Enter, \\r for carriage return, \\x03 for Ctrl+C, \\x1a for Ctrl+Z, \\t for Tab. ' +
      'For non-interactive commands where you need the output, use execute_command instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        text: {
          type: 'string',
          description: 'The text to send. Use \\n for Enter, \\x03 for Ctrl+C, \\x1a for Ctrl+Z, \\t for Tab.'
        }
      },
      required: ['sessionId', 'text'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        sent: { type: 'boolean' },
        bytes: { type: 'number' }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'lyshell_execute_command',
    title: '执行命令并捕获输出',
    description:
      'Execute a command on a connected session and capture the output. ' +
      'IMPORTANT for SSH sessions: uses a DEDICATED exec channel — a fresh channel that does NOT inherit the interactive terminal\'s cwd, environment, or any sub-shell you have entered interactively (e.g. if you ran `cd` or `docker exec` in the interactive PTY, execute_command will NOT see that context and may report host-level instead of container-level tools/binaries). ' +
      'To run a command in the interactive PTY\'s current context instead, use send_and_wait (which writes directly to the PTY, inheriting its cwd and env). ' +
      'For local sessions, uses child_process.exec. ' +
      'Telnet and serial sessions are not supported. ' +
      'Returns the command output as a string.\n\n' +
      'STREAMING: pass stream=true to receive output incrementally via MCP progress notifications ' +
      '(each stdout/stderr chunk surfaces as a progress message while the command runs). The final result ' +
      'still contains the complete output and exitCode. Useful for long-running commands where you want ' +
      'live visibility. Note: progress notifications are shown to the user/client; the model receives only ' +
      'the final result. For mid-command reactivity (e.g. interrupt on partial output), use send_and_wait + ' +
      'read_output/tail_until polling instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        command: {
          type: 'string',
          minLength: 1,
          description: 'The shell command to execute'
        },
        timeout: {
          type: 'number',
          minimum: 100,
          maximum: 120000,
          description: 'Timeout in milliseconds (default 30000, max 120000)'
        },
        stream: {
          type: 'boolean',
          description: 'If true, stream stdout/stderr chunks via MCP progress notifications while the command runs (default false). The final result is unchanged.'
        }
      },
      required: ['sessionId', 'command'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        output: { type: 'string' },
        exitCode: { type: 'number' }
      },
      required: ['output', 'exitCode']
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'lyshell_read_output',
    title: '读取终端最近输出',
    description:
      'Read recent output from an interactive terminal session. ' +
      'Returns the most recent terminal output with ANSI escape codes stripped by default (clean readable text). ' +
      'Works with ALL session types (SSH, Local, Telnet, Serial) when connected. ' +
      'Use this after send_input to see what the terminal responded, or to inspect current terminal state. ' +
      'The output buffer captures all terminal data; returns the most recent N lines (default 100).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        lines: {
          type: 'number',
          minimum: 1,
          maximum: 1000,
          description: 'Number of recent lines to return (default 100, max 1000)'
        },
        raw: {
          type: 'boolean',
          description: 'Return raw ANSI data instead of clean text (default false)'
        }
      },
      required: ['sessionId'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        output: { type: 'string' },
        lines: { type: 'number' },
        totalBufferSize: { type: 'number' }
      },
      required: ['output', 'lines', 'totalBufferSize']
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'lyshell_send_and_wait',
    title: '发送并等待响应',
    description:
      'Send input to an interactive terminal and wait for the response, returning the captured output. ' +
      'Works with ALL session types (SSH, Local, Telnet, Serial). ' +
      'Supports escape sequences: \\n for Enter, \\r for carriage return, \\x03 for Ctrl+C, \\x1a for Ctrl+Z, \\t for Tab. ' +
      'By default (autoNewline=true) a trailing \\n is appended automatically when the text ends in a normal character, so you do NOT need to add \\n yourself for a plain command — set autoNewline=false to disable (e.g. when sending raw control sequences). ' +
      'Returns the terminal output produced after the input was sent, with ANSI codes stripped. ' +
      'The `output` field includes the echoed input (terminals echo what you type); prefer the `cleanOutput` field which has the echoed command lines stripped from the front. ' +
      'The tool waits until output settles (no new data for idleMs) or until a timeout. ' +
      'Optionally returns early when a regex pattern (waitForPattern) appears in the output. ' +
      'Prefer this over send_input + read_output when you need the terminal response. ' +
      'Best for line-oriented programs; full-screen apps (vim/htop) may produce garbled output.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        text: {
          type: 'string',
          description: 'The text to send. Use \\n for Enter, \\x03 for Ctrl+C, \\x1a for Ctrl+Z, \\t for Tab.'
        },
        waitMs: {
          type: 'number',
          minimum: 0,
          maximum: 300000,
          description: 'Minimum time to wait for output to settle in ms (default 2000)'
        },
        idleMs: {
          type: 'number',
          minimum: 0,
          maximum: 300000,
          description: 'Idle threshold in ms: no new output for this long means settled (default 300)'
        },
        maxWaitMs: {
          type: 'number',
          minimum: 0,
          maximum: 300000,
          description: 'Maximum time to wait in ms regardless of idle detection (default 10000)'
        },
        waitForPattern: {
          type: 'string',
          description: 'Regex pattern to wait for in output. Returns immediately when matched.'
        },
        autoNewline: {
          type: 'boolean',
          description: 'When true (default), append a trailing \\n if the text ends in a normal character, so the command is submitted automatically. Set false for raw control sequences.'
        },
        captureExitCode: {
          type: 'boolean',
          description: 'Best-effort capture of the command exit code (POSIX shells only: bash/zsh/sh). When true, appends `printf \'__LYSHELL_EXIT_%d__\' $?` after the command and parses the marker from the output. Returns exitCode in the result (null if the marker is not found, e.g. non-POSIX shell or command not submitted). Only meaningful for simple shell commands; do not use with interactive programs (vim/htop). For a reliable exit code on SSH/local without cwd inheritance, use execute_command instead.'
        }
      },
      required: ['sessionId', 'text'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        output: { type: 'string' },
        cleanOutput: { type: 'string', description: 'Output with echoed input lines stripped from the front. INVARIANT: cleanOutput is always derived from output by (a) stripping leading lines that exactly match the echoed command lines, then (b) when captureExitCode=true, stripping the trailing __LYSHELL_EXIT_N__ marker. It never contains content not present in output (modulo line-ending normalization to \\n). When echo stripping cannot match a line, it falls back to output with line endings normalized to \\n. Prefer cleanOutput for parsing command results (no echo); use output for raw terminal state including echoes. Do not compare with cleanOutput === output (line endings differ).' },
        settled: { type: 'boolean' },
        patternMatched: { type: 'boolean' },
        elapsedMs: { type: 'number' },
        exitCode: { type: ['number', 'null'], description: 'Best-effort exit code. Present only when captureExitCode=true and the POSIX marker was parsed; null otherwise. send_and_wait cannot natively capture exit codes (PTY semantics) — for guaranteed exit codes use execute_command.' }
      },
      required: ['output', 'cleanOutput', 'settled', 'patternMatched', 'elapsedMs']
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },

  // ---------- 文件操作 (SSH only) ----------
  {
    name: 'lyshell_list_files',
    title: '列出远程目录',
    description:
      'List files and directories in a remote path. SSH sessions only. ' +
      'Returns file name, path, size, modification time, permissions, owner, and group.\n\n' +
      'RECURSIVE: pass recursive=true to walk into subdirectories and return a flat list of all entries ' +
      '(directories are included as entries, symlinks are NOT followed to avoid cycles). ' +
      'GLOB: pass a glob pattern (e.g. "*.log", "**/*.conf", "src/**/*.ts") to filter entries by their path. ' +
      'glob supports *, ** (across path separators), ?, and [abc] character classes; matching is case-sensitive ' +
      'on the path relative to the listed directory. Combine recursive=true + glob to find files by pattern ' +
      'across a tree (e.g. recursive=true, glob="**/*.log" lists all log files under the path). ' +
      'Without recursive, glob matches only the immediate directory. ' +
      'maxEntries (default 5000) caps the result size for recursive/glob walks over huge trees.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        path: remotePathField('The remote directory path to list'),
        recursive: {
          type: 'boolean',
          description: 'If true, recursively walk subdirectories and return a flat list. Symlinks are not followed. Default false.'
        },
        glob: {
          type: 'string',
          maxLength: 500,
          description: 'Optional glob filter applied to each entry\'s path (relative to the listed directory). Supports *, **, ?, [abc]. Case-sensitive.'
        },
        maxEntries: {
          type: 'number',
          minimum: 1,
          maximum: 50000,
          description: 'Cap on returned entries for recursive/glob walks (default 5000). Prevents huge-tree response blowup.'
        }
      },
      required: ['sessionId', 'path'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        entries: { type: 'array', items: fileEntrySchema },
        truncated: { type: 'boolean', description: 'true if the result hit maxEntries and was truncated.' }
      },
      required: ['entries'] as string[]
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'lyshell_read_file',
    title: '读取远程文件',
    description:
      'Read the content of a remote file. SSH sessions only. ' +
      'Best suited for text files. For binary files or large files, use download_file instead. ' +
      'Default max file size is 1MB.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        path: remotePathField('The remote file path to read'),
        maxSize: {
          type: 'number',
          minimum: 1,
          maximum: 1048576,
          description: 'Maximum file size in bytes to read (default 1048576 = 1MB)'
        }
      },
      required: ['sessionId', 'path'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string' },
        size: { type: 'number' }
      },
      required: ['content', 'size']
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'lyshell_download_file',
    title: '下载远程文件',
    description:
      'Download a remote file to a local path. SSH sessions only. ' +
      'Returns the MD5 hash of the downloaded file if available. ' +
      'Supports SFTP or exec-based transfer (auto-detected).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        remotePath: remotePathField('The remote file path to download'),
        localPath: remotePathField('The local file path to save to')
      },
      required: ['sessionId', 'remotePath', 'localPath'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        md5: { type: 'string' },
        remotePath: { type: 'string' },
        localPath: { type: 'string' }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'lyshell_upload_file',
    title: '上传文件到远程',
    description:
      'Upload a local file to a remote path. SSH sessions only. ' +
      'Supports SFTP or exec-based transfer (auto-detected).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        localPath: remotePathField('The local file path to upload'),
        remotePath: remotePathField('The remote destination path')
      },
      required: ['sessionId', 'localPath', 'remotePath'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        remotePath: { type: 'string' },
        localPath: { type: 'string' },
        md5: { type: 'string' }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'lyshell_stat_file',
    title: '查询远程文件元数据',
    description:
      'Get metadata (size, permissions, owner, modification time) for a remote file or directory. SSH sessions only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        path: remotePathField('The remote file or directory path')
      },
      required: ['sessionId', 'path'] as string[]
    },
    outputSchema: fileEntrySchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },

  // ---------- P1 高层 workflow 工具 ----------
  {
    name: 'lyshell_wait_for_prompt',
    title: '等待终端出现指定模式',
    description:
      'Wait for a regex pattern to appear in a session\'s recent terminal output WITHOUT sending any input. ' +
      'Use to detect a shell prompt is ready, a long-running command finished, or a log line appeared. ' +
      'The pattern is OPTIONAL: if omitted, defaults to a common shell-prompt regex ([$#>%]\\s*$) matching $ / # / > / % at the end of the buffer. ' +
      'Checks the recent buffer (up to 1000 lines of scrollback) first and returns immediately if the pattern is already present (e.g. prompt already ready); otherwise waits for new output to match. ' +
      'Note: because the fast path scans existing scrollback, a custom pattern may match stale history rather than newly produced output — if you need to wait for a fresh occurrence, ensure the pattern is not already in the visible buffer, or use send_and_wait which only scans output produced after the call. ' +
      'For "send something then wait" use send_and_wait instead. Returns as soon as the pattern matches or timeoutMs elapses.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        pattern: { type: 'string', description: 'Regex to match against the session output buffer. Optional; defaults to a common shell-prompt regex ([$#>%]\\s*$).' },
        timeoutMs: { type: 'number', minimum: 100, maximum: 120000, description: 'Max time to wait in ms (default 30000).' },
        idleMs: { type: 'number', minimum: 50, maximum: 10000, description: 'Idle threshold for the underlying settle detection (default 500).' }
      },
      required: ['sessionId'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        output: { type: 'string' },
        cleanOutput: { type: 'string', description: 'Equal to output — wait_for_prompt sends no input, so there is no echo to strip. Present for shape consistency with send_and_wait.' },
        settled: { type: 'boolean' },
        patternMatched: { type: 'boolean' },
        elapsedMs: { type: 'number' }
      },
      required: ['output', 'cleanOutput', 'settled', 'patternMatched', 'elapsedMs']
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'lyshell_run_on_sessions',
    title: '在多个会话上并发执行命令',
    description:
      'Run the same command on multiple sessions concurrently (max concurrency 10, max 50 sessions per call). ' +
      'Each session is authorized and routed independently — a failure on one session does NOT stop others. ' +
      'Telnet/Serial sessions are skipped with an error entry. Use this for fleet-wide checks like `uptime`, `df -h`, etc.\n\n' +
      'DRY RUN: pass dryRun=true to preview which sessions would receive the command WITHOUT executing. ' +
      'Returns { dryRun: true, command, targets: [{ sessionId, sessionName, sessionType, status, wouldExecute }] } ' +
      'instead of results. Recommended before destructive or fleet-wide commands — verify the blast radius first. ' +
      'dryRun does not trigger the destructive-command confirmation (no execution occurs).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionIds: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'string', minLength: 1 },
          description: 'Array of session IDs (cannot contain "current"; resolve it client-side first).'
        },
        command: { type: 'string', minLength: 1, description: 'Shell command to run on every session.' },
        timeout: { type: 'number', minimum: 100, maximum: 120000, description: 'Per-session timeout in ms (default 30000).' },
        dryRun: {
          type: 'boolean',
          description: 'If true, preview the target sessions and wouldExecute flags without executing the command (default false).'
        }
      },
      required: ['sessionIds', 'command'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              output: { type: 'string' },
              exitCode: { type: 'number' },
              error: { type: 'string' }
            }
          }
        }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'lyshell_tail_until',
    title: '监控会话输出直到匹配',
    description:
      'Poll a session\'s output buffer until a regex pattern matches OR timeoutMs elapses. ' +
      'Use for log-tailing scenarios: "wait until the deploy log contains ERROR". ' +
      'Unlike wait_for_prompt which uses settle detection, this re-reads the buffer every pollMs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        pattern: { type: 'string', minLength: 1, description: 'Regex to look for in the recent output.' },
        timeoutMs: { type: 'number', minimum: 500, maximum: 120000, description: 'Max wall time in ms (default 30000).' },
        pollMs: { type: 'number', minimum: 100, maximum: 5000, description: 'How often to re-check the buffer (default 500).' }
      },
      required: ['sessionId', 'pattern'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        matched: { type: 'boolean' },
        elapsedMs: { type: 'number' },
        output: { type: 'string' },
        reason: { type: 'string' }
      }
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  }
]

// ====================== 旧名别名（DEPRECATED） ======================
// 同时返回新旧两套工具名，旧名 description 前缀 [DEPRECATED, use lyshell_<x>]。
// agent 会自动选新名；调旧名时 CallTool 处理器会打印 deprecation warning。

const deprecate = (oldName: string, newName: string, tool: any) => ({
  ...tool,
  name: oldName,
  description: `[DEPRECATED, use ${newName}] ${tool.description}`,
  title: `${tool.title} (deprecated)`
})

// 新名 → 旧名映射（供 CallTool 处理器的名称转换使用）
export const ALIAS_TO_NEW: Record<string, string> = {}

/** 旧名别名定义列表（用于 ListTools 一起返回） */
export const ALIAS_DEFINITIONS = (() => {
  const oldNew: Array<[string, string]> = [
    ['list_sessions', 'lyshell_list_sessions'],
    ['reconnect_session', 'lyshell_reconnect_session'],
    ['send_input', 'lyshell_send_input'],
    ['execute_command', 'lyshell_execute_command'],
    ['read_output', 'lyshell_read_output'],
    ['send_and_wait', 'lyshell_send_and_wait'],
    ['list_files', 'lyshell_list_files'],
    ['read_file', 'lyshell_read_file'],
    ['download_file', 'lyshell_download_file'],
    ['upload_file', 'lyshell_upload_file'],
    ['stat_file', 'lyshell_stat_file'],
    ['wait_for_prompt', 'lyshell_wait_for_prompt'],
    ['run_on_sessions', 'lyshell_run_on_sessions'],
    ['tail_until', 'lyshell_tail_until']
  ]

  const mainNames = new Map(TOOL_DEFINITIONS.map(t => [t.name, t]))

  const aliases: any[] = []
  for (const [old, newName] of oldNew) {
    const tool = mainNames.get(newName)
    if (tool) {
      ALIAS_TO_NEW[old] = newName
      aliases.push(deprecate(old, newName, tool))
    }
  }
  return aliases
})()