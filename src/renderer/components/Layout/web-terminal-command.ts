import type { QuickCommand } from '@shared/types'
import { useQuickCommandsStore } from '../../stores'
import { activeWebTabId } from './web-tab-controls'

// 网页命令先进入可见草稿，绝不回落到被网页盖住的 SSH / 本地终端。
const loaders = new Map<string, (command: QuickCommand) => void>()
export function registerWebTerminalCommand(id: string, load: (command: QuickCommand) => void): () => void {
  loaders.set(id, load)
  return () => { if (loaders.get(id) === load) loaders.delete(id) }
}
export function stageWebTerminalCommand(command: QuickCommand): boolean {
  const id = activeWebTabId()
  if (!id) return false
  loaders.get(id)?.(command)
  return true
}
export function stageWebTerminalShortcut(index: number): void {
  const { commands, selectedGroupId } = useQuickCommandsStore.getState()
  const group = selectedGroupId || 'default'
  const command = commands.filter(item => group === 'default' ? !item.groupId : item.groupId === group)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[index]
  if (command) stageWebTerminalCommand(command)
}
