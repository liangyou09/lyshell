export interface ActivityBackendIdentity { instanceId: string; instanceEpoch: number }
export type ActivityNavigationRequest =
  | { kind: 'open'; identity: ActivityBackendIdentity; sessionId: string }
  | { kind: 'navigation'; identity: ActivityBackendIdentity; sessionId: string; requestId: string }
export type ActivityNavigationResult =
  | { success: false; error: string }
  | { success: true; requestId: string; navigation: 'pending' | 'navigated' | 'failed'; url?: string; cwd?: string }
