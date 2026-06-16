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
      'List all terminal sessions in LyShell with their connection status. ' +
      'Returns session ID, name, type (ssh/telnet/serial/local), status, host, and port. ' +
      'Use the session ID in other tools to target a specific session.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[]
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