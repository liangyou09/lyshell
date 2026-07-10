import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

// 编译开关：true 时构建不含 MCP 的版本（不打包 mcpServer.js，不启动 HTTP 服务）
const disableMcp = process.env.LYSHELL_DISABLE_MCP === 'true'

export default defineConfig({
  // 主进程构建配置
  main: {
    define: {
      __DISABLE_MCP__: JSON.stringify(disableMcp)
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          worker: resolve(__dirname, 'src/main/file/download-worker.ts'),
          uploadWorker: resolve(__dirname, 'src/main/file/upload-worker.ts'),
          ...(disableMcp ? {} : {
            mcpServer: resolve(__dirname, 'src/main/mcp-server/index.ts')
          })
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name].js',
          dir: 'dist/main'
        },
        external: [
          'electron',
          'electron-log',
          'node-pty',
          'serialport',
          'better-sqlite3',
          'ssh2'
        ]
      }
    },
    resolve: {
      alias: [
        { find: '@main', replacement: resolve(__dirname, 'src/main') },
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') }
      ]
    },
    plugins: [
      // 无 MCP 构建时把 @main/mcp/* 重定向到 no-op stub。
      // 使用自定义 pre-plugin 避免与 @main 通配 alias 的解析顺序问题。
      {
        name: 'lyshell-mcp-alias',
        enforce: 'pre',
        resolveId(id) {
          const prefix = '@main/mcp/'
          if (id.startsWith(prefix)) {
            const suffix = id.slice(prefix.length)
            const base = disableMcp ? 'src/main/mcp-noop/' : 'src/main/mcp/'
            return resolve(__dirname, base, suffix)
          }
          return null
        }
      }
    ]
  },

  // 预加载脚本构建配置
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          dir: 'dist/preload'
        }
      }
    },
    resolve: {
      alias: {
        '@preload': resolve(__dirname, 'src/preload'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },

  // 渲染进程构建配置
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        },
        output: {
          format: 'esm',
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
          dir: 'dist/renderer',
          manualChunks: {
            'xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search'],
            'react': ['react', 'react-dom'],
            'vendor': ['zustand', 'lodash-es', 'dayjs', 'classnames']
          }
        }
      },
      cssCodeSplit: false,
      assetsInlineLimit: 4096,
      target: 'es2022',
      minify: 'esbuild'
    },
    css: {
      postcss: {
        plugins: [tailwindcss, autoprefixer]
      }
    }
  }
})