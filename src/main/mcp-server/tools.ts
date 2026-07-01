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
    }
  },
  required: ['id', 'name', 'type', 'status', 'tags', 'capabilities']
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
      'List all terminal sessions in LyShell with their connection status and capabilities. ' +
      'Returns session ID, name, type (ssh/telnet/serial/local), status, host, port, and capabilities. ' +
      'Check capabilities before calling other tools: sendInput (all types), executeCommand (SSH/Local), fileOperations (SSH only). ' +
      'Use the session ID in other tools to target a specific session. ' +
      'Supports optional filter parameters: status, type, tag, search, limit, offset.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['connected', 'disconnected', 'connecting', 'error'], description: 'Filter by session connection status.' },
        type: { type: 'string', enum: ['ssh', 'telnet', 'serial', 'local'], description: 'Filter by connection type.' },
        tag: { type: 'string', description: 'Filter by tag name.' },
        search: { type: 'string', description: 'Substring search against session name and host.' },
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

  // ---------- 终端交互 ----------
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
      'Returns the command output as a string.',
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
        }
      },
      required: ['sessionId', 'text'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        output: { type: 'string' },
        cleanOutput: { type: 'string', description: 'Output with echoed input lines stripped from the front. Best-effort: plain command lines and caret-echoed control chars (e.g. ^C) are stripped; Tab expansion or prompt-prefixed echoes may not match, in which case cleanOutput falls back to the full output with line endings normalized to \\n (so it may NOT be byte-identical to `output`, which preserves original \\r\\n / \\r endings — do not compare with cleanOutput === output).' },
        settled: { type: 'boolean' },
        patternMatched: { type: 'boolean' },
        elapsedMs: { type: 'number' }
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
      'Returns file name, path, size, modification time, permissions, owner, and group.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: sessionIdField,
        path: remotePathField('The remote directory path to list')
      },
      required: ['sessionId', 'path'] as string[]
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        entries: { type: 'array', items: fileEntrySchema }
      },
      required: ['entries']
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
      'Telnet/Serial sessions are skipped with an error entry. Use this for fleet-wide checks like `uptime`, `df -h`, etc.',
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
        timeout: { type: 'number', minimum: 100, maximum: 120000, description: 'Per-session timeout in ms (default 30000).' }
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