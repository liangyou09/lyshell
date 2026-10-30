/**
 * 致命退出子进程夹具（仅测试使用，不进入应用 bundle）。
 *
 * 用真实 `process.exit` 验证 R2 4.3：未知 uncaughtException / unhandledRejection
 * 必须非零退出；诊断落盘或日志失败也必须退出；致命路径不执行正常退出清理。
 *
 * 由 `fatal-error.test.ts` 用 esbuild 打包后 spawn，环境变量：
 * - `FATAL_FIXTURE_MODE`：uncaught | rejection | log-failure | persist-failure
 * - `FATAL_FIXTURE_USER_DATA`：写入标记文件的临时目录
 */
import { join } from 'path'
import { writeFileSync } from 'fs'
import { AppLifecycle } from '../app-lifecycle'
import { installFatalHandlers } from '../fatal-error'
import { writeFatalState } from '../lifecycle-state'

const mode = process.env.FATAL_FIXTURE_MODE ?? 'uncaught'
const userData = process.env.FATAL_FIXTURE_USER_DATA

if (!userData) throw new Error('FATAL_FIXTURE_USER_DATA is required')

function mark(name: string): void {
  writeFileSync(join(userData!, name), '1', 'utf-8')
}

const lifecycle = new AppLifecycle({ logger: { info: (): void => {}, warn: (): void => {} } })

// 正常退出步骤：致命路径绝不应执行到这里（不能批量保存业务仓库）。
lifecycle.registerStep('final', 'business-archive', () => {
  mark('business-shutdown-ran')
})

installFatalHandlers({
  lifecycle,
  persist: report => {
    if (mode === 'persist-failure') throw new Error('diagnostic disk is full')
    writeFatalState(userData, report)
  },
  log: () => {
    mark('log-ran')
    if (mode === 'log-failure') throw new Error('log sink failed')
  },
  onFatalSync: [() => { mark('sync-hook-ran') }]
})

// 保活：若致命处理器没有退出进程，测试会以错误退出码/超时发现，而不是静默结束。
setInterval(() => { /* keep alive */ }, 1000)
setTimeout(() => { process.exit(0) }, 5000).unref?.()

if (mode === 'rejection') {
  setTimeout(() => { void Promise.reject(new Error('rejected fixture token=secret-456')) }, 10)
} else {
  setTimeout(() => { throw new Error('uncaught fixture token=secret-123') }, 10)
}
