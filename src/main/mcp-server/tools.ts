/**
 * MCP 工具定义
 * 定义 LyShell 暴露给 AI Agent 的所有 MCP 工具
 */

/**
 * MCP 工具定义
 * 使用原始 JSON Schema 格式，兼容 MCP Server 的 ListToolsRequestSchema
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'list_sessions',
    description:
      'List all terminal sessions in LyShell with their connection status and capabilities. ' +
      'Returns session ID, name, type (ssh/telnet/serial/local), status, host, port, and capabilities. ' +
      'Check capabilities before calling other tools: sendInput (all types), executeCommand (SSH/Local), fileOperations (SSH only). ' +
      'Use the session ID in other tools to target a specific session.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[]
    }
  },
  {
    name: 'send_input',
    description:
      'Send text input directly to an interactive terminal session, as if the user typed it. ' +
      'Works with ALL session types (SSH, Telnet, Serial, Local). ' +
      'Use this to interact with interactive CLI programs like codex, vim, htop, gdb, etc. ' +
      'Supports escape sequences: \\n for Enter, \\r for carriage return, \\x03 for Ctrl+C, \\x1a for Ctrl+Z, \\t for Tab. ' +
      'For non-interactive commands where you need the output, use execute_command instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID to send input to'
        },
        text: {
          type: 'string',
          description: 'The text to send. Use \\n for Enter, \\x03 for Ctrl+C, \\x1a for Ctrl+Z, \\t for Tab.'
        }
      },
      required: ['sessionId', 'text'] as string[]
    }
  },
  {
    name: 'execute_command',
    description:
      'Execute a command on a connected session and capture the output. ' +
      'For SSH sessions, uses a dedicated exec channel (does not interfere with the interactive terminal). ' +
      'For local sessions, uses child_process.exec. ' +
      'Telnet and serial sessions are not supported. ' +
      'Returns the command output as a string.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID to execute the command on'
        },
        command: {
          type: 'string',
          description: 'The shell command to execute'
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default 30000, max 120000)'
        }
      },
      required: ['sessionId', 'command'] as string[]
    }
  },
  {
    name: 'read_output',
    description:
      'Read recent output from an interactive terminal session. ' +
      'Returns the most recent terminal output with ANSI escape codes stripped by default (clean readable text). ' +
      'Works with ALL session types (SSH, Local, Telnet, Serial) when connected. ' +
      'Use this after send_input to see what the terminal responded, or to inspect current terminal state. ' +
      'The output buffer captures all terminal data; returns the most recent N lines (default 100).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID to read output from'
        },
        lines: {
          type: 'number',
          description: 'Number of recent lines to return (default 100, max 1000)'
        },
        raw: {
          type: 'boolean',
          description: 'Return raw ANSI data instead of clean text (default false)'
        }
      },
      required: ['sessionId'] as string[]
    }
  },
  {
    name: 'send_and_wait',
    description:
      'Send input to an interactive terminal and wait for the response, returning the captured output. ' +
      'Works with ALL session types (SSH, Local, Telnet, Serial). ' +
      'Supports escape sequences: \\n for Enter, \\r for carriage return, \\x03 for Ctrl+C, \\x1a for Ctrl+Z, \\t for Tab. ' +
      'Returns the terminal output produced after the input was sent, with ANSI codes stripped. ' +
      'The tool waits until output settles (no new data for idleMs) or until a timeout. ' +
      'Optionally returns early when a regex pattern (waitForPattern) appears in the output. ' +
      'Prefer this over send_input + read_output when you need the terminal response. ' +
      'Note: the returned output includes the echoed input (terminals echo what you type). ' +
      'Best for line-oriented programs; full-screen apps (vim/htop) may produce garbled output.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID to send input to'
        },
        text: {
          type: 'string',
          description: 'The text to send. Use \\n for Enter, \\x03 for Ctrl+C, \\x1a for Ctrl+Z, \\t for Tab.'
        },
        waitMs: {
          type: 'number',
          description: 'Minimum time to wait for output to settle in ms (default 2000)'
        },
        idleMs: {
          type: 'number',
          description: 'Idle threshold in ms: no new output for this long means settled (default 300)'
        },
        maxWaitMs: {
          type: 'number',
          description: 'Maximum time to wait in ms regardless of idle detection (default 10000)'
        },
        waitForPattern: {
          type: 'string',
          description: 'Regex pattern to wait for in output. Returns immediately when matched.'
        }
      },
      required: ['sessionId', 'text'] as string[]
    }
  },
  {
    name: 'list_files',
    description:
      'List files and directories in a remote path. SSH sessions only. ' +
      'Returns file name, path, size, modification time, permissions, owner, and group.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID (SSH only)'
        },
        path: {
          type: 'string',
          description: 'The remote directory path to list'
        }
      },
      required: ['sessionId', 'path'] as string[]
    }
  },
  {
    name: 'read_file',
    description:
      'Read the content of a remote file. SSH sessions only. ' +
      'Best suited for text files. For binary files or large files, use download_file instead. ' +
      'Default max file size is 1MB.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID (SSH only)'
        },
        path: {
          type: 'string',
          description: 'The remote file path to read'
        },
        maxSize: {
          type: 'number',
          description: 'Maximum file size in bytes to read (default 1048576 = 1MB)'
        }
      },
      required: ['sessionId', 'path'] as string[]
    }
  },
  {
    name: 'download_file',
    description:
      'Download a remote file to a local path. SSH sessions only. ' +
      'Returns the MD5 hash of the downloaded file if available. ' +
      'Supports SFTP or exec-based transfer (auto-detected).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID (SSH only)'
        },
        remotePath: {
          type: 'string',
          description: 'The remote file path to download'
        },
        localPath: {
          type: 'string',
          description: 'The local file path to save to'
        }
      },
      required: ['sessionId', 'remotePath', 'localPath'] as string[]
    }
  },
  {
    name: 'upload_file',
    description:
      'Upload a local file to a remote path. SSH sessions only. ' +
      'Supports SFTP or exec-based transfer (auto-detected).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID (SSH only)'
        },
        localPath: {
          type: 'string',
          description: 'The local file path to upload'
        },
        remotePath: {
          type: 'string',
          description: 'The remote destination path'
        }
      },
      required: ['sessionId', 'localPath', 'remotePath'] as string[]
    }
  },
  {
    name: 'stat_file',
    description:
      'Get metadata (size, permissions, owner, modification time) for a remote file or directory. SSH sessions only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID (SSH only)'
        },
        path: {
          type: 'string',
          description: 'The remote file or directory path'
        }
      },
      required: ['sessionId', 'path'] as string[]
    }
  },
  {
    name: 'delete_file',
    description:
      'Delete a remote file or directory (recursively). SSH sessions only. ' +
      'DANGER: This operation is irreversible. Always confirm with the user before deleting. ' +
      'Consider using stat_file first to verify the target before deletion.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID (SSH only)'
        },
        path: {
          type: 'string',
          description: 'The remote file or directory path to delete'
        }
      },
      required: ['sessionId', 'path'] as string[]
    }
  },
  {
    name: 'rename_file',
    description:
      'Rename or move a remote file or directory. SSH sessions only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID (SSH only)'
        },
        oldPath: {
          type: 'string',
          description: 'The current remote file path'
        },
        newPath: {
          type: 'string',
          description: 'The new remote file path'
        }
      },
      required: ['sessionId', 'oldPath', 'newPath'] as string[]
    }
  },
  {
    name: 'create_directory',
    description:
      'Create a remote directory including any intermediate directories. SSH sessions only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID (SSH only)'
        },
        path: {
          type: 'string',
          description: 'The remote directory path to create'
        }
      },
      required: ['sessionId', 'path'] as string[]
    }
  },
  {
    name: 'get_file_md5',
    description:
      'Calculate the MD5 hash of a remote file. SSH sessions only. ' +
      'The remote system must have md5sum or md5 command available.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID (SSH only)'
        },
        path: {
          type: 'string',
          description: 'The remote file path'
        }
      },
      required: ['sessionId', 'path'] as string[]
    }
  }
]