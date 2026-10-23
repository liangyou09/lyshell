export const MCP_CONFIRMATION_CHANNEL = 'mcp:confirmation'
export const MCP_CONFIRMATION_THEME = 'mcp:confirmation:theme'

export interface McpConfirmationContent {
  title: string
  message: string
  operation: string
  source: string
  targets: Array<{ name: string; type?: string }>
  content: string
  contentKind: 'command' | 'content'
  rules?: Array<{ name: string; description: string; snippet: string }>
}
export interface McpConfirmationData extends McpConfirmationContent {
  locale: 'zh' | 'en'
  theme: 'light' | 'dark'
}
export type McpConfirmationRequest = { kind: 'get' | 'ready' | 'reject' | 'allow' | 'copy' }
export type McpConfirmationReply = McpConfirmationData | boolean | null
export interface McpConfirmationAPI {
  request(request: McpConfirmationRequest): Promise<McpConfirmationReply>
  onTheme(callback: (theme: 'light' | 'dark') => void): () => void
}
