import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import pkg from './package.json'

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
          'koffi',
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
          index: resolve(__dirname, 'src/preload/index.ts'),
          // 插件视图 guest 页面专用 preload（pluginView.js）：guest sandboxed preload，
          // 只经 contextBridge 暴露 window.lyshellView（bootstrap/callApi/动作/弹窗）
          pluginView: resolve(__dirname, 'src/preload/plugin-view.ts'),
          browserLogin: resolve(__dirname, 'src/preload/browser-login.ts'),
          browserPrompt: resolve(__dirname, 'src/preload/browser-prompt.ts'),
          browserMenu: resolve(__dirname, 'src/preload/browser-menu.ts'),
          mcpConfirmation: resolve(__dirname, 'src/preload/mcp-confirmation.ts')
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
    // 编译期注入版本号 —— 只带一个字符串常量进 bundle,
    // 避免 import package.json 把全部依赖/scripts 打进渲染产物
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10))
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      // 输出目录必须走 Vite 原生 outDir 键,不能只写 rollupOptions.output.dir:
      // emptyOutDir 的清场只认 build.outDir —— 此前目录挂在 output 下,Vite 每次
      // 清的都是 electron-vite 默认的 out/renderer(不存在),dist/renderer 从未被
      // 清,带 hash 的陈旧 chunk 越攒越多,还随 dist/**/* 全部进了安装包
      outDir: 'dist/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          scrollArtPreview: resolve(__dirname, 'src/renderer/scroll-art-preview.html'),
          browserPrompt: resolve(__dirname, 'src/renderer/browser-prompt.html'),
          browserMenu: resolve(__dirname, 'src/renderer/browser-menu.html'),
          mcpConfirmation: resolve(__dirname, 'src/renderer/mcp-confirmation.html')
        },
        output: {
          format: 'esm',
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
          manualChunks: {
            'xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search'],
            'react': ['react', 'react-dom'],
            // 目录提取与文档渲染共用的 Markdown 解析器独立打包，避免进入主入口。
            // 保留同步解析和 MarkdownDoc 的 lazy 边界，不改变目录/文档加载时序。
            'markdown-parser': ['unified', 'remark-parse', 'remark-gfm'],
            // 大段静态更新日志独立打包，设置面板仍同步挂载以保持插件打开回执时序。
            'release-notes': [resolve(__dirname, 'CHANGELOG.md') + '?raw'],
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
