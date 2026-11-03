// Read-only native MCP diagnostic for an explicitly supplied independent Host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'
import { NativeRelayWakeSource } from '../src/wake/relay-client.js'

test('independent existing-version Relay is reachable through the native proxy', async () => {
  const root = process.env.RELAY_WAKE_TEST_ROOT
  const descriptorPath = process.env.RELAY_WAKE_TEST_DESCRIPTOR
  if (!root || !descriptorPath) throw new Error('explicit independent test root and descriptor required; no production discovery')
  const canonical = await realpath(descriptorPath)
  const part = relative(await realpath(root), canonical)
  assert.ok(!part.startsWith('..') && !isAbsolute(part))
  const descriptor = JSON.parse(await readFile(canonical, 'utf8')) as { authorityId: string; mcpUrl: string }
  assert.notEqual(new URL(descriptor.mcpUrl).port, '3080')
  const source = await NativeRelayWakeSource.connect({ descriptorFile: canonical, clientPrincipalId: 'wake-isolated-test', requestTimeoutMs: 5000, autoStart: false })
  try {
    const diagnostic = await source.diagnose()
    assert.equal(diagnostic.connected, true)
    console.log(JSON.stringify({ independentNativeMcp: true, authorityId: descriptor.authorityId, ...diagnostic,
      credentialsCopied: false, realDshRunSubmitted: false, authenticationProven: false }))
  } finally { await source.close() }
})
