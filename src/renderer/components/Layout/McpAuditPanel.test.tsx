// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpAuditPanel } from './McpAuditPanel'

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key })
}))

const getRetention = vi.fn()
const setRetention = vi.fn()
const getRecords = vi.fn()
const getFacets = vi.fn()
let savedLimit: number

beforeEach(() => {
  vi.clearAllMocks()
  savedLimit = 5000
  getRetention.mockReset().mockImplementation(async () => savedLimit)
  setRetention.mockReset().mockImplementation(async (limit: number) => {
    savedLimit = limit
    return { success: true, limit }
  })
  getRecords.mockReset().mockResolvedValue({ records: [], total: 1200 })
  getFacets.mockReset().mockResolvedValue({ operations: [], sessions: [] })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    getMcpAuditRetention: getRetention, setMcpAuditRetention: setRetention,
    getMcpAudit: getRecords, getMcpAuditFacets: getFacets
  } })
})
afterEach(cleanup)

const selector = () => screen.getByLabelText('mcpAudit.retentionLabel') as HTMLSelectElement
const ready = async () => waitFor(() => expect(selector().disabled).toBe(false))

describe('MCP 活动保留条数设置', () => {
  it('加载保存值并提供四个档位，保存后刷新第一页，重新打开仍显示新值', async () => {
    const view = render(<McpAuditPanel onClose={vi.fn()} />)
    await ready()
    expect(selector().value).toBe('5000')
    expect(Array.from(selector().options).map(option => option.value)).toEqual(['1000', '5000', '10000', '20000'])
    fireEvent.click(screen.getByRole('button', { name: '›' }))
    await waitFor(() => expect(getRecords).toHaveBeenLastCalledWith({ limit: 50, offset: 50 }))
    fireEvent.change(selector(), { target: { value: '1000' } })
    await waitFor(() => expect(setRetention).toHaveBeenCalledWith(1000))
    await ready()
    expect(selector().value).toBe('1000')
    expect(getRecords).toHaveBeenLastCalledWith({ limit: 50, offset: 0 })
    expect(getFacets).toHaveBeenCalledTimes(2)
    view.unmount()
    render(<McpAuditPanel onClose={vi.fn()} />)
    await ready()
    expect(selector().value).toBe('1000')
  })

  it('保存失败保留原选项，显示错误并允许重新选择', async () => {
    setRetention.mockResolvedValueOnce({ success: false })
    render(<McpAuditPanel onClose={vi.fn()} />)
    await ready()
    fireEvent.change(selector(), { target: { value: '1000' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('mcpAudit.retentionSaveFailed'))
    expect(selector().value).toBe('5000')
    expect(selector().disabled).toBe(false)
    expect(getRecords).toHaveBeenCalledTimes(1)
    fireEvent.change(selector(), { target: { value: '1000' } })
    await waitFor(() => expect(selector().value).toBe('1000'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('调低上限后忽略较晚返回的旧记录和旧筛选选项', async () => {
    let finishRecords!: (result: { records: never[]; total: number }) => void
    let finishFacets!: (result: { operations: string[]; sessions: never[] }) => void
    getRecords.mockImplementationOnce(() => new Promise(resolve => { finishRecords = resolve }))
    getFacets.mockImplementationOnce(() => new Promise(resolve => { finishFacets = resolve }))
    getRecords.mockResolvedValue({ records: [], total: 1000 })
    getFacets.mockResolvedValue({ operations: ['current_operation'], sessions: [] })
    render(<McpAuditPanel onClose={vi.fn()} />)
    await ready()
    fireEvent.change(selector(), { target: { value: '1000' } })
    await waitFor(() => expect(selector().value).toBe('1000'))
    await ready()
    expect(screen.getByText('1–50 / 1000')).toBeTruthy()
    await act(async () => {
      finishRecords({ records: [], total: 1200 })
      finishFacets({ operations: ['retired_operation'], sessions: [] })
    })
    expect(screen.getByText('1–50 / 1000')).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'retired_operation' })).toBeNull()
    expect(screen.getByRole('option', { name: 'current_operation' })).toBeTruthy()
  })

  it('加载失败时禁用选择，重试后恢复已保存档位', async () => {
    savedLimit = 20000
    getRetention.mockRejectedValueOnce(new Error('offline'))
    render(<McpAuditPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(selector().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'mcpAudit.retentionRetry' }))
    await ready()
    expect(selector().value).toBe('20000')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('保存期间显示状态并禁止重入和重复提交', async () => {
    let finish!: (result: { success: boolean; limit: number }) => void
    setRetention.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<McpAuditPanel onClose={vi.fn()} />)
    await ready()
    fireEvent.change(selector(), { target: { value: '10000' } })
    expect(selector().disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('mcpAudit.retentionSaving')
    fireEvent.change(selector(), { target: { value: '20000' } })
    expect(setRetention).toHaveBeenCalledTimes(1)
    await act(async () => finish({ success: true, limit: 10000 }))
    await ready()
    expect(selector().value).toBe('10000')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('区分尚未提交和保存失败，刷新确认成功后清除状态', async () => {
    const state = { currentRevision: 2, committedRevision: 1, dirtySince: 10, activeWrite: false, lastFailure: null, serializationMs: 1, writeMs: 1 }
    getRecords.mockResolvedValueOnce({ records: [], total: 0, persistence: state })
    getRecords.mockResolvedValue({ records: [], total: 0, persistence: { ...state, committedRevision: 2, dirtySince: null } })
    render(<McpAuditPanel onClose={vi.fn()} />)
    await ready()
    expect(screen.getByRole('status').textContent).toBe('mcpAudit.persistencePending')
    fireEvent.click(screen.getByRole('button', { name: 'mcpAudit.refresh' }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    getRecords.mockResolvedValue({ records: [], total: 0, persistence: { ...state, lastFailure: { revision: 2, phase: 'primary', code: 'PERSISTENCE_FAILED' } } })
    fireEvent.click(screen.getByRole('button', { name: 'mcpAudit.refresh' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('mcpAudit.persistenceFailed'))
  })

  it('日志提交失败时显示后端确认的保留设置值，不谎报设置未变', async () => {
    setRetention.mockResolvedValueOnce({ success: false, limit: 1000 })
    render(<McpAuditPanel onClose={vi.fn()} />)
    await ready()
    fireEvent.change(selector(), { target: { value: '1000' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('mcpAudit.retentionSaveFailed'))
    expect(selector().value).toBe('1000')
  })
})
