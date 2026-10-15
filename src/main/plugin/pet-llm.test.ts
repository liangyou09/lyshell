import { describe, expect, it, vi } from 'vitest'
import type { TokenBinding } from '../mcp/auth'
import type { HarnessEnvProfile } from '@shared/harness'
import { readPetLLMConfig } from './pet-llm'

const host: TokenBinding = { kind: 'plugin', tokenSource: 'host', pluginId: 'aipet', capabilities: ['read'] }
const profile: HarnessEnvProfile = {
  id: 'active', name: 'Selected', order: 0, baseUrl: 'https://models.example/v1', apiKey: 'test-secret',
  env: { PRIVATE_OTHER_VALUE: 'must-not-leak', OPENAI_MODEL: 'model-a' }, models: ['model-a', 'model-b']
}
function setup() {
  return {
    plugin: vi.fn(() => ({ enabled: true, grantedCapabilities: ['read'] as ['read'] })),
    activeProfile: vi.fn((): HarnessEnvProfile | undefined => profile)
  }
}
describe('PetLink active ENV profile', () => {
  it('returns only the selected connection; does not export arbitrary environment variables', () => {
    const result = readPetLLMConfig(host, setup())
    expect(result).toEqual({ status: 200, body: { success: true, data: {
      profileId: 'active', baseURL: profile.baseUrl, apiKey: profile.apiKey, model: 'model-a', models: ['model-a', 'model-b']
    } } })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
  })
  it.each([
    { ...host, kind: 'global' as const }, { ...host, kind: 'session' as const },
    { ...host, tokenSource: 'ui' as const }, { ...host, tokenSource: undefined },
    { ...host, pluginId: 'other' }, { ...host, capabilities: [] }
  ])('rejects credentials outside the PetLink host boundary', binding => {
    const deps = setup()
    expect(readPetLLMConfig(binding, deps).status).toBe(403)
    expect(deps.activeProfile).not.toHaveBeenCalled()
  })
  it('rechecks enabled status and current grants on every request', () => {
    const deps = setup()
    deps.plugin.mockReturnValue({ enabled: false, grantedCapabilities: ['read'] })
    expect(readPetLLMConfig(host, deps).status).toBe(403)
    deps.plugin.mockReturnValue({ enabled: true, grantedCapabilities: [] as unknown as ['read'] })
    expect(readPetLLMConfig(host, deps).status).toBe(403)
  })
  it('reports no enabled profile explicitly and reads changes without restart', () => {
    const deps = setup()
    deps.activeProfile.mockReturnValue(undefined)
    expect(readPetLLMConfig(host, deps).body).toEqual({ success: true, data: null })
    deps.activeProfile.mockReturnValue({ ...profile, id: 'next', apiKey: 'rotated' })
    expect(readPetLLMConfig(host, deps).body.data?.apiKey).toBe('rotated')
  })
  it('accepts legacy OpenAI and DeepSeek env fields while preferring the structured core', () => {
    const deps = setup()
    deps.activeProfile.mockReturnValue({ ...profile, baseUrl: undefined, apiKey: undefined,
      env: { DEEPSEEK_BASE_URL: 'https://legacy.example/v1', DEEPSEEK_API_KEY: 'legacy-key', DEEPSEEK_MODEL: 'legacy-model' } })
    expect(readPetLLMConfig(host, deps).body.data).toMatchObject({ baseURL: 'https://legacy.example/v1', apiKey: 'legacy-key', model: 'legacy-model' })
  })
})
