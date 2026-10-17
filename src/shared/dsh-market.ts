/** 左侧市场只接受固定操作，不允许渲染层传 URL、包名或 shell 命令。 */
export const DSH_MARKET_CHANNEL = 'dsh:market'
export const DSH_MARKET_ACTIONS = ['open', 'install', 'release'] as const
export type DshMarketAction = typeof DSH_MARKET_ACTIONS[number]
export const DSH_MARKET_PACKAGE = 'dshmarket@1.66.21'
export type DshMarketResult =
  | { success: true; url?: string; needsInstall?: boolean; restartRequired?: boolean }
  | { success: false; error: string }
