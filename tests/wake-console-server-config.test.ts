import test from 'node:test'
import assert from 'node:assert/strict'
import { createConsoleMcpConfig } from '../src/wake/console-config.js'

test('thread MCP overrides disable only configured servers and preserve the native wake Relay', () => {
  const relay = { command: '/usr/bin/node', args: ['/private/dsh-relay-wake-proxy.mjs', '/private/config.json'],
    startup_timeout_sec: 10, required: true }
  assert.deepEqual(createConsoleMcpConfig(['android-studio', 'termux', 'mt'], relay), {
    mcp_servers: {
      'android-studio': { enabled: false },
      termux: { enabled: false },
      mt: { enabled: false },
      harness_relay: relay,
    },
  })
})

test('thread MCP overrides do not add unrequested servers or alter a global Codex config', () => {
  assert.deepEqual(createConsoleMcpConfig([]), {})
  assert.deepEqual(createConsoleMcpConfig(['android-studio']), {
    mcp_servers: { 'android-studio': { enabled: false } },
  })
})
