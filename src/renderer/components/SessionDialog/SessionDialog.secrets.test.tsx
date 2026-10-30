// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionType, type SessionPublicConfig } from '@shared/types'
import { SECRET_PLACEHOLDER } from '@shared/harness'
import { DEFAULT_THEME_DARK } from '@shared/constants'
import SessionDialog from './SessionDialog'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../hooks', () => ({ useEscDismiss: () => {} }))
afterEach(cleanup)

const fixture = (): SessionPublicConfig => ({
  id: 'saved', name: 'fixture', type: ConnectionType.SSH, tags: [], createdAt: new Date(), updatedAt: new Date(),
  terminal: { fontSize: 14, fontFamily: 'Consolas', encoding: 'utf-8', theme: DEFAULT_THEME_DARK, cursorStyle: 'block', cursorBlink: true, scrollback: 1000 },
  ssh: { host: 'fixture.invalid', port: 22, username: 'user', password: SECRET_PLACEHOLDER, privateKey: SECRET_PLACEHOLDER, passphrase: SECRET_PLACEHOLDER }
})

describe('会话编辑秘密存在状态', () => {
  it('未改的秘密保留占位符，不把存储值渲染到输入框', async () => {
    const submit = vi.fn(async (_config: SessionPublicConfig) => null)
    const view = render(<SessionDialog open onClose={() => {}} onSubmit={submit} initialConfig={fixture()} />)
    expect(view.getAllByPlaceholderText('session.secretStored')).toHaveLength(3)
    expect(view.getAllByPlaceholderText('session.secretStored').every(input => (input as HTMLInputElement).value === '')).toBe(true)
    fireEvent.submit(view.container.querySelector('form')!)
    await waitFor(() => expect(submit).toHaveBeenCalledOnce())
    expect(submit.mock.calls[0][0].ssh).toMatchObject({ password: SECRET_PLACEHOLDER, privateKey: SECRET_PLACEHOLDER, passphrase: SECRET_PLACEHOLDER })
  })
  it('明确清除锁定密码和私钥时发送空串，连同私钥口令一并清空', async () => {
    const submit = vi.fn(async (_config: SessionPublicConfig) => null)
    const config = fixture()
    config.ssh = { host: 'fixture.invalid', port: 22, username: 'user' }
    config.sshSecrets = { password: { present: true, locked: true }, privateKey: { present: true, locked: true }, passphrase: { present: true, locked: true } }
    const view = render(<SessionDialog open onClose={() => {}} onSubmit={submit} initialConfig={config} />)
    fireEvent.click(view.getAllByText('session.clearSavedSecret')[0])
    fireEvent.click(view.getByText('session.clearSavedKey'))
    fireEvent.submit(view.container.querySelector('form')!)
    await waitFor(() => expect(submit).toHaveBeenCalledOnce())
    expect(submit.mock.calls[0][0].ssh).toMatchObject({ password: '', privateKey: '', passphrase: '' })
  })
})
