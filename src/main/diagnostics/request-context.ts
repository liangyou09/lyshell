import { AsyncLocalStorage } from 'async_hooks'
import type { CallContext } from '@shared/operation'

const requests = new AsyncLocalStorage<CallContext>()
export function runWithRequestContext<T>(context: CallContext, action: () => T): T { return requests.run(context, action) }
export function currentRequestContext(): CallContext | undefined { return requests.getStore() }
