import { WakeOutbox } from '../../src/wake/outbox.js'
import { WakeStore } from '../../src/wake/store.js'
import { run } from './wake-fixture.js'

const path = process.argv[2]
if (!path) throw new Error('missing isolated state path')
await new WakeOutbox(new WakeStore(path), {}, () => 2000).observe(run('succeeded', 4), 'owner')
