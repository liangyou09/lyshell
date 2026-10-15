import type { TokenBinding } from '../mcp/auth'
import type { HarnessEnvProfile } from '@shared/harness'
import type { McpCapability } from '@shared/api-routes'

interface PetLLMDeps {
  plugin(id: string): { enabled: boolean; grantedCapabilities: McpCapability[] } | undefined
  activeProfile(): HarnessEnvProfile | undefined
}

/** Only the enabled PetLink host may read the active profile's model credentials. */
export function readPetLLMConfig(binding: TokenBinding, deps: PetLLMDeps) {
  const plugin = deps.plugin('aipet')
  if (binding.kind !== 'plugin' || binding.tokenSource !== 'host' || binding.pluginId !== 'aipet'
    || !plugin?.enabled || !binding.capabilities?.includes('read') || !plugin.grantedCapabilities.includes('read')) {
    return { status: 403, body: { success: false, error: 'PetLink host authorization required' } }
  }
  const profile = deps.activeProfile()
  if (!profile) return { status: 200, body: { success: true, data: null } }
  // Return only the selected model connection, never arbitrary environment variables or other profiles.
  const env = profile.env
  return {
    status: 200,
    body: {
      success: true,
      data: {
        profileId: profile.id,
        baseURL: profile.baseUrl || env.OPENAI_BASE_URL || env.DEEPSEEK_BASE_URL || '',
        apiKey: profile.apiKey || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || '',
        model: env.OPENAI_MODEL || env.DEEPSEEK_MODEL || '',
        models: profile.models ?? []
      }
    }
  }
}
