import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

export default defineConfig({
  // 主进程构建配置
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          worker: resolve(__dirname, 'src/main/file/download-worker.ts'),
          uploadWorker: resolve(__dirname, 'src/main/file/upload-worker.ts'),
          mcpServer: resolve(__dirname, 'src/main/mcp-server/index.ts'),
          pluginHost: resolve(__dirname, 'src/main/plugin-host/index.ts'),
          pluginHostOneshot: resolve(__dirname, 'src/main/plugin-host/oneshot.ts')
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
    }
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
    root: resolve(__dirname, 'src/renderer'),
    server: {
      host: '127.0.0.1'
    },
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