import { describe, it, expect } from 'vitest'
import { parseHarnessWorkRequest } from './harness-work'
import { API_ROUTES, MCP_TOOL_DEFINITIONS, PATH_BY_NAME } from './api-routes'

describe('原生 Harness 请求契约', () => {
  it.each([
    { kind: 'state' }, { kind: 'targets' }, { kind: 'disconnect' }, { kind: 'new' },
    { kind: 'recover' }, { kind: 'resume', sessionId: 's', taskId: 't', requestId: 'resume-r', text: 'Verified; remaining work' },
    { kind: 'new', workspace: 'D:/project' }, { kind: 'select', sessionId: 's' },
    { kind: 'submit', sessionId: 's', text: 'task', requestId: 'r' },
    { kind: 'cancel', taskId: 't' }, { kind: 'approve', id: 'a', optionId: 'rejected' },
    { kind: 'state', sessionId: 's' }, { kind: 'state', taskId: 't' },
    { kind: 'state', sessionId: 's', taskId: 't' }, { kind: 'cancel', sessionId: 's', taskId: 't' },
    { kind: 'approve', id: 'a', sessionId: 's', taskId: 't', optionId: 'rejected' }
  ])('接受合法请求 %j', value => expect(parseHarnessWorkRequest(value)).toEqual(value))
  it.each([
    null, [], {}, { kind: 'toString' }, { kind: '__proto__' }, { kind: 'acquire', epoch: 1 },
    { kind: 'recover', owner: 'forged' }, { kind: 'recover', workspace: 'D:/other' },
    { kind: 'resume', sessionId: 's', requestId: 'r', text: 'x' },
    { kind: 'resume', sessionId: 's', taskId: 't', requestId: 'r', text: '' },
    { kind: 'state', owner: 'pet' }, { kind: 'new', workspace: 'bad\0path' },
    { kind: 'submit', requestId: 'r', text: 'x' }, { kind: 'submit', sessionId: 's', requestId: 'r', text: ' ' },
    { kind: 'submit', sessionId: 's', requestId: 'r', text: 'x'.repeat(32001) },
    { kind: 'approve', id: 'a', optionId: 'always' }, { kind: 'approve', id: 'a', optionId: ['rejected'] }, { kind: 'cancel' },
    { kind: 'state', sessionId: '' }, { kind: 'state', taskId: 3 }, { kind: 'targets', taskId: 't' },
    { kind: 'cancel', taskId: 't', sessionId: [] }, { kind: 'approve', id: 'a', taskId: '', optionId: 'rejected' },
    { kind: 'state', taskId: 'x'.repeat(129) }
  ])('拒绝非法或越权字段 %j', value => expect(parseHarnessWorkRequest(value)).toBeNull())
  it('HTTP/MCP 共用唯一契约与工具名', () => {
    expect(API_ROUTES.filter(route => route.name === 'lyshell_harness_work')).toHaveLength(1)
    expect(MCP_TOOL_DEFINITIONS.find(tool => tool.name === 'lyshell_harness_work')).toBeTruthy()
    expect(PATH_BY_NAME.get('lyshell_harness_work')).toBe('/api/harness/work/request')
  })
})
