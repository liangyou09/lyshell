// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TaskDefinition } from '@shared/task-workbench'
import { useTaskWorkbench } from '../../stores/task-workbench'
import { TaskWorkbenchDetails } from './TaskWorkbenchDetails'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'zh' } }) }))
vi.mock('../../stores/pane-store', () => ({ usePaneStore: { getState: () => ({}) } }))
vi.mock('../../stores/workbench-activity', () => ({ activityDirectoryKey: (value: string) => value.toLowerCase(), useWorkbenchActivity: { getState: () => ({}) } }))
const request = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  useTaskWorkbench.setState({ snapshot: { revision: 0, maxActive: 2, queueEnabled: false, entries: [], submissions: [], results: [] }, error: null, busy: false, pending: null })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskWorkbenchRequest: request } })
})
afterEach(cleanup)
describe('task workbench user intent', () => {
  it('keeps the original operation retry available when a pending receipt has no visible error', async () => {
    const pending = { kind: 'start' as const, entryId: 'entry', expectedRevision: 1, operationId: 'original-start-operation' }
    useTaskWorkbench.setState({ pending, error: null, busy: false })
    request.mockResolvedValue({ ok: true, entityId: 'submission', snapshot: useTaskWorkbench.getState().snapshot })
    render(<TaskWorkbenchDetails workspace="D:/workspace" />)
    fireEvent.click(screen.getByRole('button', { name: /任务工作台/ }))
    const retry = screen.getByRole('button', { name: '核对上次操作' }) as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    expect(request).not.toHaveBeenCalled()
    fireEvent.click(retry)
    await waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(request).toHaveBeenCalledWith(pending)
    expect(request.mock.calls[0][0].operationId).toBe('original-start-operation')
  })

  it('opening and editing create no execution and saving preserves the chosen approval policy and resource IDs', async () => {
    let definition: TaskDefinition | undefined
    request.mockImplementation(async input => {
      if (input.kind === 'save') definition = input.definition
      return { ok: true, entityId: 'entry', snapshot: { revision: 1, queueEnabled: false, maxActive: 2, entries: [], submissions: [], results: [] } }
    })
    render(<TaskWorkbenchDetails workspace="D:/workspace" />)
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(request).not.toHaveBeenCalled()
    expect((screen.getByLabelText('审批策略') as HTMLSelectElement).value).toBe('auto-allow')
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Analyze results' } })
    fireEvent.change(screen.getByLabelText('任务目标'), { target: { value: 'Compare component throughput' } })
    const resources = screen.getByLabelText('独占资源 ID（每行一个，可留空）') as HTMLTextAreaElement
    fireEvent.change(resources, { target: { value: 'env-a\n' } })
    expect(resources.value).toBe('env-a\n')
    fireEvent.change(resources, { target: { value: 'env-a\nenv-b\nenv-a' } })
    fireEvent.change(screen.getByLabelText('审批策略'), { target: { value: 'manual' } })
    fireEvent.click(screen.getByRole('button', { name: '保存任务' }))
    await waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(request.mock.calls[0][0].kind).toBe('save')
    expect(definition).toMatchObject({ workspace: 'D:/workspace', resourceIds: ['env-a', 'env-b'], approvalPolicy: 'manual' })
    expect(request.mock.calls.some(([input]) => input.kind === 'start')).toBe(false)
  })
})
