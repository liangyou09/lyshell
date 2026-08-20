import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// vitest 默认不读 electron.vite.config.ts 的路径别名；现有测试都用相对路径故未暴露。
// plugin-host/api.ts 等 production 代码用 @shared / @main 别名，测试需同步解析。
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@': resolve(__dirname, 'src/renderer')
    }
  }
})
