import { configDefaults, defineConfig } from 'vitest/config'
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
  },
  test: {
    // 排除 harness worktree 隔离目录（.lyshell-worktrees/<key>/src/... 会命中默认的
    // **/*.test.ts 收集规则）：里面是主仓库各历史提交的完整检出，会把同一份测试跑多遍，
    // 且检出的可能是旧版代码 —— 损坏/过期的副本会让根目录的绿测在这里假红。
    exclude: [...configDefaults.exclude, '.lyshell-worktrees/**']
  }
})
