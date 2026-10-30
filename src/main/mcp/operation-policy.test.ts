import { describe, expect, it } from 'vitest'
import { ConnectionType } from '@shared/types'
import { capabilityEnabled, operationCapabilities } from './operation-policy'

describe('按执行效果授权', () => {
  it('原始Shell输入要求相应执行权限，串口保持设备输入能力', () => {
    expect(operationCapabilities('interactiveWrite', ConnectionType.LOCAL)).toEqual(['interactiveWrite', 'localExecute'])
    for (const type of [ConnectionType.SSH, ConnectionType.TELNET]) {
      expect(operationCapabilities('interactiveWrite', type)).toEqual(['interactiveWrite', 'execute'])
    }
    expect(operationCapabilities('interactiveWrite', ConnectionType.SERIAL)).toEqual(['interactiveWrite'])
    expect(operationCapabilities('read', ConnectionType.LOCAL)).toEqual(['read'])
  })
  it('仅交互权限不能变成执行权限', () => {
    expect(operationCapabilities('interactiveWrite', ConnectionType.LOCAL).every(cap => capabilityEnabled({ allowInteractiveInput: true }, cap))).toBe(false)
    expect(operationCapabilities('interactiveWrite', ConnectionType.LOCAL).every(cap => capabilityEnabled({ allowInteractiveInput: true, allowLocalExecute: true }, cap))).toBe(true)
  })
})
