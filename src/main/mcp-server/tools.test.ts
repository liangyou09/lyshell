import { describe, it, expect } from 'vitest'
import { API_ROUTES, MCP_TOOL_DEFINITIONS, PATH_BY_NAME } from '@shared/api-routes'
import {
  TOOL_DEFINITIONS,
  ALIAS_TO_NEW,
  ALIAS_DEFINITIONS,
  HIDDEN_FROM_LIST_TOOLS
} from './tools'

/**
 * tools.ts -> api-routes.ts 迁移契约不变量(纯逻辑、无 IO)。
 *
 * Step 1.5 把 ~千行 schema 从 tools.ts 迁到 @shared/api-routes.ts 作为真相源,tools.ts
 * 退化为投影 + 旧名别名。迁移本身此前零回归测试 -- 本文件锁住契约:投影完整、字段不被
 * 悄悄改、transports 标对、PATH_BY_NAME 覆盖、旧名/隐藏名齐全。防止未来改 API_ROUTES 时
 * MCP 工具列表静默退化(入参校验失效/工具消失/路由元数据泄露给客户端)。
 */

describe('api-routes 迁移契约(tools.ts -> API_ROUTES 投影)', () => {
  it('TOOL_DEFINITIONS 与 MCP_TOOL_DEFINITIONS 逐字段相等(投影完整,tools.ts 未重新发散)', () => {
    // 当前 TOOL_DEFINITIONS = MCP_TOOL_DEFINITIONS(同引用);用 toEqual 锁内容,
    // 即便未来 tools.ts 改为浅拷贝也仍要求内容逐字段一致。
    expect(TOOL_DEFINITIONS).toEqual(MCP_TOOL_DEFINITIONS)
  })

  it('API_ROUTES[stdio-mcp] 与 MCP_TOOL_DEFINITIONS 双向一一对应', () => {
    const stdioRoutes = API_ROUTES.filter((r) => r.transports.includes('stdio-mcp'))
    expect(MCP_TOOL_DEFINITIONS.length).toBe(stdioRoutes.length)
    const mcpNames = new Set(MCP_TOOL_DEFINITIONS.map((t) => t.name))
    const routeNames = new Set(stdioRoutes.map((r) => r.name))
    for (const r of stdioRoutes) expect(mcpNames.has(r.name)).toBe(true)
    for (const t of MCP_TOOL_DEFINITIONS) expect(routeNames.has(t.name)).toBe(true)
  })

  it('投影只 pick MCP 标准字段,不泄露路由元数据(path/method/capabilities/transports)', () => {
    const leaked = ['path', 'method', 'capabilities', 'transports'] as const
    for (const t of MCP_TOOL_DEFINITIONS) {
      for (const key of leaked) expect(t).not.toHaveProperty(key)
    }
  })

  it('投影字段与源路由同引用(迁移中 schema 未被复制改写)', () => {
    const routeByName = new Map(API_ROUTES.map((r) => [r.name, r]))
    for (const t of MCP_TOOL_DEFINITIONS) {
      const r = routeByName.get(t.name)
      expect(r).toBeDefined()
      expect(t.title).toBe(r!.title)
      expect(t.description).toBe(r!.description)
      expect(t.inputSchema).toBe(r!.inputSchema)
      expect(t.outputSchema).toBe(r!.outputSchema)
      expect(t.annotations).toBe(r!.annotations)
    }
  })

  it('每条 API_ROUTES 形状完整(method 合法、capabilities/transports 非空、schema 对象)', () => {
    for (const r of API_ROUTES) {
      expect(r.name).toMatch(/^lyshell_/)
      expect(typeof r.path).toBe('string')
      expect(r.path.length).toBeGreaterThan(0)
      expect(['GET', 'POST']).toContain(r.method)
      expect(Array.isArray(r.capabilities)).toBe(true)
      expect(r.capabilities.length).toBeGreaterThan(0)
      expect(Array.isArray(r.transports)).toBe(true)
      expect(r.transports.length).toBeGreaterThan(0)
      expect(typeof r.title).toBe('string')
      expect(typeof r.description).toBe('string')
      expect(r.inputSchema).toBeTypeOf('object')
      expect(r.inputSchema).not.toBeNull()
      expect(r.outputSchema).toBeTypeOf('object')
      expect(r.outputSchema).not.toBeNull()
      expect(r.annotations).toBeTypeOf('object')
      expect(r.annotations).not.toBeNull()
    }
  })

  it('每个 MCP 工具 name 非空,annotations 四个 hint 均为 boolean', () => {
    for (const t of MCP_TOOL_DEFINITIONS) {
      expect(typeof t.name).toBe('string')
      expect(t.name.length).toBeGreaterThan(0)
      expect(typeof t.title).toBe('string')
      expect(typeof t.description).toBe('string')
      const hints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const
      for (const key of hints) expect(typeof t.annotations[key]).toBe('boolean')
    }
  })

  it('API_ROUTES.name 唯一', () => {
    const names = API_ROUTES.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('PATH_BY_NAME 覆盖所有 API_ROUTES.name 且映射正确', () => {
    expect(PATH_BY_NAME.size).toBe(API_ROUTES.length)
    for (const r of API_ROUTES) {
      expect(PATH_BY_NAME.has(r.name)).toBe(true)
      expect(PATH_BY_NAME.get(r.name)).toBe(r.path)
    }
  })

  it('19 个已知 lyshell_ 工具名全部存在(防迁移中工具被静默删除)', () => {
    const expected = [
      'lyshell_list_sessions', 'lyshell_reconnect_session', 'lyshell_close_session',
      'lyshell_open_connection_dialog', 'lyshell_read_session_notes', 'lyshell_write_session_notes',
      'lyshell_create_session', 'lyshell_send_input', 'lyshell_execute_command',
      'lyshell_read_output', 'lyshell_send_and_wait', 'lyshell_list_files',
      'lyshell_read_file', 'lyshell_download_file', 'lyshell_upload_file',
      'lyshell_stat_file', 'lyshell_wait_for_prompt', 'lyshell_run_on_sessions',
      'lyshell_tail_until'
    ]
    const names = new Set(API_ROUTES.map((r) => r.name))
    for (const n of expected) expect(names.has(n)).toBe(true)
    expect(API_ROUTES.length).toBe(expected.length)
  })

  it('旧名别名:14 个已知旧名全部映射到正确的 lyshell_ 新名', () => {
    const expected: Record<string, string> = {
      list_sessions: 'lyshell_list_sessions',
      reconnect_session: 'lyshell_reconnect_session',
      send_input: 'lyshell_send_input',
      execute_command: 'lyshell_execute_command',
      read_output: 'lyshell_read_output',
      send_and_wait: 'lyshell_send_and_wait',
      list_files: 'lyshell_list_files',
      read_file: 'lyshell_read_file',
      download_file: 'lyshell_download_file',
      upload_file: 'lyshell_upload_file',
      stat_file: 'lyshell_stat_file',
      wait_for_prompt: 'lyshell_wait_for_prompt',
      run_on_sessions: 'lyshell_run_on_sessions',
      tail_until: 'lyshell_tail_until'
    }
    for (const [old, newName] of Object.entries(expected)) {
      expect(ALIAS_TO_NEW[old]).toBe(newName)
    }
    expect(Object.keys(ALIAS_TO_NEW).length).toBe(Object.keys(expected).length)
  })

  it('ALIAS_DEFINITIONS 与 ALIAS_TO_NEW 一致,旧名 description 带 [DEPRECATED 前缀', () => {
    expect(ALIAS_DEFINITIONS.length).toBe(Object.keys(ALIAS_TO_NEW).length)
    const aliasOldNames = new Set(ALIAS_DEFINITIONS.map((a) => a.name))
    for (const old of Object.keys(ALIAS_TO_NEW)) {
      expect(aliasOldNames.has(old)).toBe(true)
    }
    for (const a of ALIAS_DEFINITIONS) {
      expect(a.description.startsWith('[DEPRECATED, use lyshell_')).toBe(true)
    }
  })

  it('HIDDEN_FROM_LIST_TOOLS 为预期的 4 个(execute 及其 stream 变体,新旧名)', () => {
    expect([...HIDDEN_FROM_LIST_TOOLS].sort()).toEqual(
      ['execute_command', 'execute_stream', 'lyshell_execute_command', 'lyshell_execute_stream'].sort()
    )
  })
})
