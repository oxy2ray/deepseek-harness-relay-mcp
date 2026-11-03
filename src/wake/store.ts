import { isAbsolute } from 'node:path'
import { FileLockFacade, atomicWriteJson, readUtf8File } from '../state-repository/index.js'
import { emptyState, stateSchema, type WakeState } from './schema.js'

/** Recover only this feature's proven-dead owner records; never steal a live/unknown lock. */
export async function acquireWakeLock(path: string) {
  const lock = new FileLockFacade()
  await lock.recoverStale(path)
  return lock.acquire(path)
}

/** Separate opt-in state; never reads or migrates the production Relay V3 store. */
export class WakeStore {
  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new Error('wake state path must be absolute')
  }

  async read(): Promise<WakeState> {
    const text = await readUtf8File(this.path)
    return text === null ? emptyState() : stateSchema.parse(JSON.parse(text))
  }

  async transaction<T>(action: (state: WakeState) => T): Promise<T> {
    const lease = await acquireWakeLock(`${this.path}.lock`)
    try {
      const state = await this.read()
      // Callbacks are deliberately synchronous: no network while the lock is held.
      const result = action(state)
      if (result instanceof Promise) throw new Error('wake transactions must be synchronous')
      await atomicWriteJson(this.path, stateSchema.parse(state))
      return structuredClone(result)
    } finally {
      await lease.release()
    }
  }
}
