import { WakeStore } from './store.js'
import { WakeOutbox } from './outbox.js'
import { wakeDiagnostics } from './diagnostics.js'

// Explicit local state path only. No discovery of production Host or Codex sessions.
const [command, stateFile, bindingId, expiresAt] = process.argv.slice(2)
if (!stateFile || !['status', 'pause', 'resume', 'compact', 'renew'].includes(command ?? '')) {
  console.error('Usage: dsh-relay-wake-control <status|pause|resume|compact|renew> <absolute-test-state-file> [bindingId|beforeEpochMs] [newExpiryEpochMs]')
  process.exitCode = 2
} else {
  try {
    const store = new WakeStore(stateFile)
    if (command === 'compact') console.log(JSON.stringify(await new WakeOutbox(store).compactAcknowledged(Number(bindingId))))
    else if (command === 'renew') {
      if (!bindingId) throw new Error('binding ID required')
      await new WakeOutbox(store).renewBinding(bindingId, Number(expiresAt))
    }
    else if (command !== 'status') await new WakeOutbox(store).setEnabled(command === 'resume', bindingId)
    console.log(JSON.stringify(wakeDiagnostics(await store.read()), null, 2))
  } catch {
    // State may be corrupt or locked; do not leak its contents or remote error messages.
    console.error('Wake control failed: check the explicit state path, schema and lock ownership. No live service was discovered or modified.')
    process.exitCode = 1
  }
}
