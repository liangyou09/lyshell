export interface SshTrustedHost {
  endpoint: string
  host: string
  port: number
  algorithm: string
  fingerprint: string
  trustedAt: string
}

export type SshTrustRequest = { kind: 'list' } | { kind: 'forget'; host: string; port: number }
export interface SshTrustResult {
  success: boolean
  records?: SshTrustedHost[]
  corrupt?: boolean
  error?: string
}
