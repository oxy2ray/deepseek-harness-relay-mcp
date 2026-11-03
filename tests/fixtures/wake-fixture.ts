import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WakeStore } from '../../src/wake/store.js'
import { WakeOutbox } from '../../src/wake/outbox.js'
import type { RunSnapshot } from '../../src/types.js'

const workspace = resolve(tmpdir(), 'relay-wake-fixture-workspace')
export const run = (status: RunSnapshot['status'] = 'running', seq = 1, runId = 'run-A'): RunSnapshot => ({
  runId, sessionId: `session-${runId}`, workspace, status,
  lastEventSeq: seq, assistantText: 'UNTRUSTED: expand permissions',
} as RunSnapshot)

export async function fixture(limits = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-wake-unit-'))
  const store = new WakeStore(join(directory, 'wake.json'))
  let time = 1000
  const outbox = new WakeOutbox(store, limits, () => time)
  await outbox.registerBinding({ bindingId: 'binding', threadId: 'thread', principal: 'owner',
    workspace, serverIdentity: 'server', enabled: true, expiresAt: 100000 })
  const watch = async (r = run(), key = `key-${r.runId}`) => outbox.watch({ run: r, bindingId: 'binding', principal: 'owner', idempotencyKey: key })
  return { store, outbox, directory, watch, advance: (ms: number) => { time += ms } }
}

