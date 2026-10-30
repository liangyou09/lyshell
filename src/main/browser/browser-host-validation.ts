import { OperationError } from '@shared/operation'
import type { BrowserHostRequest } from '@shared/browser-host'
const SIMPLE = new Set(['inspect', 'attach', 'detach', 'back', 'forward', 'stop', 'focus', 'capture', 'close'])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
export function validateBrowserHostRequest(raw: unknown): BrowserHostRequest {
  const invalid = (): never => { throw new OperationError('INVALID_ARGUMENT', 'Invalid browser host request') }
  if (!record(raw) || typeof raw.kind !== 'string') return invalid()
  if (raw.kind === 'capabilities') return exact(raw, ['kind']) ? raw as BrowserHostRequest : invalid()
  const url = () => typeof raw.url === 'string' && raw.url.length > 0 && raw.url.length <= 4096
  if (raw.kind === 'create-readonly-pilot') return exact(raw, ['kind', 'url']) && url() ? raw as BrowserHostRequest : invalid()
  if (!record(raw.host) || !exact(raw.host, ['hostId', 'generation', 'kind']) || typeof raw.host.hostId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.host.hostId) || !Number.isSafeInteger(raw.host.generation) || Number(raw.host.generation) < 1 || raw.host.kind !== 'web-contents-view') return invalid()
  if (SIMPLE.has(raw.kind)) return exact(raw, ['kind', 'host']) ? raw as BrowserHostRequest : invalid()
  if (raw.kind === 'navigate') return exact(raw, ['kind', 'host', 'url']) && url() ? raw as BrowserHostRequest : invalid()
  if (raw.kind === 'reload') return exact(raw, ['kind', 'host', 'ignoreCache']) && (raw.ignoreCache === undefined || typeof raw.ignoreCache === 'boolean') ? raw as BrowserHostRequest : invalid()
  if (raw.kind === 'visibility') return exact(raw, ['kind', 'host', 'visible']) && typeof raw.visible === 'boolean' ? raw as BrowserHostRequest : invalid()
  if (raw.kind === 'bounds') {
    const b = raw.bounds
    if (!exact(raw, ['kind', 'host', 'bounds']) || !record(b) || !exact(b, ['x', 'y', 'width', 'height']) || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(b[key]) && Number(b[key]) >= 0 && Number(b[key]) <= 16384) || Number(b.width) * Number(b.height) > 16 * 1024 * 1024) return invalid()
    return raw as BrowserHostRequest
  }
  return invalid()
}
