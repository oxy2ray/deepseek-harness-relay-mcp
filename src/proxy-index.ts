import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { RelayRuntimeFacade } from './relay-runtime/index.js'
import { StdioProxyFacade } from './stdio-proxy/index.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existingWakeConfigPath, readExistingWakeConfig } from './wake/existing-config.js'
import { WakeOutbox } from './wake/outbox.js'
import { WakeStore } from './wake/store.js'

let wake: { outbox: WakeOutbox } | undefined
let wakePrincipal: string | undefined
try {
  const path = existingWakeConfigPath()
  const config = await readExistingWakeConfig(path)
  if (config) {
    const outbox = new WakeOutbox(new WakeStore(config.wakeState))
    const state = await outbox.store.read()
    // The dedicated worker survives the lifetime of this MCP stdio process.
    // Concurrent startups arbitrate through its existing durable worker lock.
    if (!state.worker || !state.worker.ready || Date.now() - state.worker.heartbeatAt > 3000) {
      const worker = spawn(process.execPath, [fileURLToPath(new URL('./dsh-relay-wake-existing.mjs', import.meta.url)), path], {
        detached: true, stdio: 'ignore',
      })
      worker.on('error', () => { /* readiness remains false; watch_run cannot acknowledge */ })
      worker.unref()
    }
    wake = { outbox }
    wakePrincipal = config.principal
  }
} catch { process.stderr.write('Existing-thread wake configuration unavailable; ordinary Relay remains available.\n') }

const runtimePaths = new RelayRuntimeFacade().resolve({ mode: 'embedded', env: process.env })
const proxy = new StdioProxyFacade({
  descriptorFile: runtimePaths.endpointDescriptorFile,
  statusFile: runtimePaths.statusFile,
  clientPrincipalId: wakePrincipal ?? (process.env.DSH_RELAY_CLIENT_PRINCIPAL_ID?.trim() || 'local-user'),
  ...(wake ? { wakeByThread: wake } : {}),
  requestTimeoutMs: integer(process.env.DSH_RELAY_PROXY_TIMEOUT_MS, 35_000, 1_000, 120_000),
  maxTaskCharacters: integer(process.env.DSH_RELAY_MAX_TASK_CHARACTERS, 100_000, 1, 1_000_000),
  autoStart: boolean(process.env.DSH_RELAY_AUTO_START, true),
  autoStartTimeoutMs: integer(process.env.DSH_RELAY_AUTO_START_TIMEOUT_MS, 120_000, 1_000, 300_000),
})
await proxy.connect(new StdioServerTransport())

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid integer setting: ${raw}`)
  return value
}

function boolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`invalid boolean setting: ${raw}`)
}
