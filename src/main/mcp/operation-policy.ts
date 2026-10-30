import type { McpCapability } from '@shared/api-routes'
import { ConnectionType } from '@shared/types'

/** 按真实效果授权：Shell 的原始输入同样具有本地/远端执行能力。 */
export function operationCapabilities(capability: McpCapability, type?: ConnectionType): readonly McpCapability[] {
  if (capability !== 'interactiveWrite') return [capability]
  if (type === ConnectionType.LOCAL) return [capability, 'localExecute']
  if (type === ConnectionType.SSH || type === ConnectionType.TELNET) return [capability, 'execute']
  return [capability] // 串口保留显式设备控制语义。
}

export interface CapabilitySettings {
  allowRead?: boolean
  allowInteractiveInput?: boolean
  allowSshExecute?: boolean
  allowLocalExecute?: boolean
  allowFileWrite?: boolean
  allowSessionControl?: boolean
  allowSessionMetadataWrite?: boolean
}

export function capabilityEnabled(settings: CapabilitySettings, capability: McpCapability): boolean {
  switch (capability) {
    case 'read': return settings.allowRead === true
    case 'interactiveWrite': return settings.allowInteractiveInput === true
    case 'execute': return settings.allowSshExecute === true
    case 'localExecute': return settings.allowLocalExecute === true
    case 'fileWrite': return settings.allowFileWrite === true
    case 'sessionControl': return settings.allowSessionControl === true
    case 'sessionMetadataWrite': return settings.allowSessionMetadataWrite === true
    default: return false
  }
}
