export const BROWSER_LAUNCH_TAKE = 'browser:launch-take'
export const BROWSER_LAUNCH_PENDING = 'browser:launch-pending'

/** 系统传入的链接必须是完整网页地址，不走地址栏的搜索/补全规则。 */
export function externalBrowserUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 16384 || !/^https?:\/\//i.test(value)) return null
  if (Array.from(value).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function parseBrowserLaunchUrls(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--open-url') { values.push(args[++index] ?? ''); continue }
    if (arg.startsWith('--open-url=')) values.push(arg.slice('--open-url='.length))
    else if (/^https?:\/\//i.test(arg)) values.push(arg)
  }
  return values.map(externalBrowserUrl).filter((url): url is string => url !== null).slice(0, 32)
}
