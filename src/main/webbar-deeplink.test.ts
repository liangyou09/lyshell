/**
 * webbar 深链 scheme 接管的结构断言。
 *
 * main/index.ts 是 app 入口（import 即触发 Electron 引导），无法在测试里整树
 * 挂载 —— 对源码做收窄的结构断言（先例：PaneTabBar.topbar.test.tsx 对
 * MainWindow / globals.css 的读法），不逐字匹配无关样式。
 * WEBBAR_DEEPLINK_SCHEMES 放 @shared 的动机正是本测试：纯常量模块可被测试
 * import，入口模块不行（见常量定义处的放置说明）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { WEBBAR_DEEPLINK_SCHEMES } from '@shared/constants'

const MAIN = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf-8')

describe('webbar 深链 scheme 接管', () => {
  it('主进程经 protocol.handle 对 WEBBAR_DEEPLINK_SCHEMES 全量注册', () => {
    // 从 @shared 导入（而非入口内字面量数组）—— 常量抽离不回退
    expect(MAIN).toMatch(/from '@shared\/constants'/)
    expect(MAIN).toContain('WEBBAR_DEEPLINK_SCHEMES')
    // 注册循环消费的是共享常量本身:删循环或退回本地数组都会在此断
    expect(MAIN).toMatch(/for \(const scheme of WEBBAR_DEEPLINK_SCHEMES\)/)
    expect(MAIN).toContain('protocol.handle(scheme')
  })

  it('列表条目是合法 scheme 名（小写字母起头，scheme 字符集），协议层拒收会在注册期炸出', () => {
    for (const scheme of WEBBAR_DEEPLINK_SCHEMES) {
      expect(scheme).toMatch(/^[a-z][a-z0-9+.-]*$/)
    }
  })
})
