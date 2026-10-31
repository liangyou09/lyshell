import type { TaskSubmission, TaskWorkbenchManifest } from '@shared/task-workbench'

export function isWaiting(submission: TaskSubmission): boolean {
  return submission.handoffState === 'waiting' || submission.resumeIntent?.state === 'waiting'
}

export function waitingReason(manifest: TaskWorkbenchManifest, submission: TaskSubmission): 'paused' | 'capacity' | 'resource' | null {
  if (!manifest.queueEnabled) return 'paused'
  const active = manifest.submissions.filter(item => item.slotHeld).length
  if (active > manifest.maxActive || !submission.slotHeld && active >= manifest.maxActive) return 'capacity'
  const conflict = manifest.submissions.some(item => item.id !== submission.id &&
    item.resourcesHeld.some(resource => submission.frozenDefinition.resourceIds.includes(resource)))
  return conflict ? 'resource' : null
}

/** 最早可执行项优先；冲突项保持原序，允许后面的独立资源前进。 */
export function selectPendingSubmission(manifest: TaskWorkbenchManifest): TaskSubmission | undefined {
  const sequence = (item: TaskSubmission): number => item.resumeIntent?.enqueueSeq ?? item.enqueueSeq
  return manifest.submissions.filter(isWaiting).sort((left, right) => sequence(left) - sequence(right))
    .find(submission => waitingReason(manifest, submission) === null)
}
