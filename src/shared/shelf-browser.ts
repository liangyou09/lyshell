export type ShelfBrowserSource = 'explicitMain' | 'explicitShelf' | 'bulkVisible'
export interface ShelfBrowserToken { scopeId: string; resourceId: string; instanceGeneration: number; navigationGeneration: number; demandRevision: number }
export type ShelfBrowserRequest =
  | { kind: 'permit'; resourceId: string; url: string; taskId?: string; source: ShelfBrowserSource; readonlyMode?: boolean }
  | { kind: 'demand'; resourceId: string; main: boolean; shelf: boolean }
  | { kind: 'wake'; resourceId: string; source: ShelfBrowserSource }
  | { kind: 'reloadPolicy'; resourceId: string; enabled: boolean; url: string }
  | { kind: 'inspect'; resourceId: string }
  | { kind: 'presented'; resourceId: string; token: ShelfBrowserToken; geometryRevision: number; width: number; height: number; dpr: number }
export type ShelfBrowserResult =
  | { success: false; error: string }
  | { success: true; permitId?: string; partition?: string; url?: string; readonlyMode?: boolean; reloadableMode?: boolean; canRestore?: boolean; state?: string; restoreStatus?: string; presentationOwner?: string; presentationReady?: boolean; token?: ShelfBrowserToken; geometryRevision?: number; idleLabel?: boolean; deepSleepSupported: boolean; sleepReason?: string }
