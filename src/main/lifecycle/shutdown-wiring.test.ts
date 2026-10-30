import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * 入口接线的结构回归：root 已核实「revoke 先 await 停服会挡住后续撤权」。
 * 这些断言直接读 `src/main/index.ts`，防止后续把 await 加回 revoke 阶段。
 */
const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf-8')

describe('index.ts 退出接线', () => {
  it('revoke 只发起停服/matcher，不在该阶段 await', () => {
    expect(source).not.toMatch(/await\s+stopMcpHttpServer\(\)/)
    expect(source).toMatch(/mcpHttpStopPromise = stopMcpHttpServer\(\)/)
    expect(source).not.toMatch(/await\s+stopPatternMatcher\(\)/)
    expect(source).toMatch(/patternMatcherStopPromise = stopPatternMatcher\(\)/)
    // 实际等待登记在 final 的专门步骤里。
    expect(source).toContain("'mcp-http-stop-wait'")
    expect(source).toContain("'pattern-matcher-wait'")
  })

  it('不再保留 matcher holder 占位，直接使用 R1 导出', () => {
    expect(source).not.toContain('patternMatcherShutdown')
  })

  it('分组清理与浏览器宿主关闭确认已接入', () => {
    expect(source).toContain("runConcurrentCleanup('Transfer cleanup'")
    expect(source).toContain("runSequentialCleanup('Terminal input revocation'")
    expect(source).toMatch(/browserHostShutdown = registerBrowserHostIpc\(\)/)
    expect(source).toContain('assertBrowserHostsClosed(await browserHostShutdown())')
  })

  it('不再按错误关键词注册进程级吞异常策略', () => {
    expect(source).not.toMatch(/process\.on\('uncaughtException'/)
    expect(source).not.toMatch(/process\.on\('unhandledRejection'/)
    expect(source).not.toContain('suppressed dialog')
  })
})
