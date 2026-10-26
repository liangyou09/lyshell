import { execFile } from 'child_process'
import { resolve } from 'path'
import { promisify } from 'util'
import { expect, it } from 'vitest'

// 独立 Node runner 的黑盒用例经此入口纳入 npm test，避免 Vitest 将 node:test 文件当成空 suite。
it('runs notification helper black-box subprocess and HTTP tests', async () => {
  const result = await promisify(execFile)(process.execPath, ['--test', resolve('resources/tui-activity/notify.node-test.cjs')], { timeout: 60000, windowsHide: true })
  expect(result.stdout).toMatch(/(?:#|ℹ) pass 16/u)
  expect(result.stderr).toBe('')
}, 65000)
