import test from 'node:test'
import assert from 'node:assert/strict'
import { createConsoleOutput } from '../src/wake/console-output.js'

function makeOutput(json = false) {
  const chunks: string[] = []
  return { chunks, output: createConsoleOutput({ json, write: text => chunks.push(text) }) }
}

function itemDelta(turnId: string, delta: string, itemId?: string) {
  return { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId, ...(itemId ? { itemId } : {}), delta } }
}

function completedAgentMessage(turnId: string, text: string, itemId?: string) {
  return { method: 'item/completed', params: { threadId: 'thread-1', turnId, item: { type: 'agentMessage', ...(itemId ? { id: itemId } : {}), text } } }
}

test('human output streams two wake replies once and does not repeat completed text', () => {
  const { chunks, output } = makeOutput()
  output.emit('codex', itemDelta('wake-1', 'First wake: '))
  output.emit('codex', itemDelta('wake-1', 'verified'))
  output.emit('codex', completedAgentMessage('wake-1', 'First wake: verified'))
  output.emit('codex', completedAgentMessage('wake-1', 'First wake: verified'))
  output.emit('codex', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'wake-1', status: 'completed' } } })
  output.emit('codex', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'wake-1', status: 'completed' } } })

  output.emit('codex', itemDelta('wake-2', 'Second wake: '))
  output.emit('codex', completedAgentMessage('wake-2', 'Second wake: acknowledged'))
  output.emit('codex', itemDelta('wake-3', '哈'))
  output.emit('codex', itemDelta('wake-3', '哈'))
  output.emit('codex', completedAgentMessage('wake-3', '哈哈'))
  output.emit('codex', itemDelta('wake-4', 'Commentary first. ', 'message-1'))
  output.emit('codex', completedAgentMessage('wake-4', 'Commentary first. ', 'message-1'))
  output.emit('codex', itemDelta('wake-4', 'Final answer second. ', 'message-2'))
  output.emit('codex', completedAgentMessage('wake-4', 'Final answer second. ', 'message-2'))
  output.emit('codex', completedAgentMessage('wake-4', 'Final answer second. ', 'message-2'))
  output.close()

  const text = chunks.join('')
  assert.equal(occurrences(text, 'First wake: verified'), 1)
  assert.equal(occurrences(text, 'Second wake: acknowledged'), 1)
  assert.equal(occurrences(text, '哈哈'), 1, 'identical consecutive chunks are legitimate text and must both be retained')
  assert.equal(occurrences(text, 'Commentary first.'), 1)
  assert.equal(occurrences(text, 'Final answer second.'), 1, 'distinct assistant messages in one turn must both be shown once')
  assert.equal(occurrences(text, 'Codex turn complete.'), 1)
})

test('human status output reports counts on demand and coalesces repeated wake errors', () => {
  const { chunks, output } = makeOutput()
  const privateDiagnostic = 'provider traceback and secret=must-not-appear'
  output.emit('wake-paused-by-error', privateDiagnostic)
  output.emit('wake-paused-by-error', privateDiagnostic)
  output.emit('wake-tick', { collected: 2, failed: 1, started: 0, ready: true, raw: privateDiagnostic })
  output.emit('wake-tick', { collected: 0, failed: 1, started: 0, ready: true, raw: privateDiagnostic })
  output.emit('status', { enabled: false, watches: 3, watching: 2, queuedEvents: 2, acknowledged: 1, held: 1, deadLetters: 0 })
  output.emit('readiness', { authenticated: true, relayConfigured: true })
  output.emit('wake-paused-by-error', privateDiagnostic)
  output.emit('readiness', { authenticated: true, relayConfigured: true })
  output.emit('held-recovery', { recovered: true })

  const text = chunks.join('')
  assert.equal(occurrences(text, 'Wake processing paused after an error'), 2)
  assert.match(text, /Received 2 events\./u)
  assert.match(text, /Queue paused · watching 2\/3 · queued 2 · acknowledged 1 · held 1 · failed 0\./u)
  assert.match(text, /Relay configured\./u)
  assert.match(text, /Held wake recovered from durable history; no new turn was submitted\./u)
  assert.equal(text.includes(privateDiagnostic), false)
  assert.equal(text.includes('must-not-appear'), false)
})

test('human output hides arbitrary Codex tool payloads and redacts approval details', () => {
  const { chunks, output } = makeOutput()
  output.emit('codex', { method: 'item/completed', params: { item: { type: 'mcpToolCall', tool: 'get_run', result: 'private-tool-result' } } })
  output.emit('codex', { method: 'turn/completed', params: { turn: { id: 'turn-3', status: 'completed', output: 'private-turn-output' } } })
  output.emit('manual-response-required', {
    id: 47,
    method: 'item/commandExecution/requestApproval',
    params: {
      reason: 'Inspect a file using token=top-secret-value',
      command: ['curl', 'https://example.invalid/?api_key=very-secret', '--password', 'another-secret'],
      cwd: '/workspace/case-file.json',
      arguments: { token: 'never-print-tool-arguments' },
    },
  })
  const text = chunks.join('')
  assert.match(text, /Manual approval required — request 47 \(item\/commandExecution\/requestApproval\)\./u)
  assert.match(text, /Reason: Inspect a file using token=\[redacted\]/u)
  assert.match(text, /Command: curl \[URL\] --password \[redacted\]/u)
  assert.match(text, /Path: \/workspace\/case-file\.json/u)
  assert.match(text, /No approval was sent\./u)
  for (const forbidden of ['private-tool-result', 'private-turn-output', 'top-secret-value', 'very-secret', 'another-secret', 'never-print-tool-arguments', 'https://']) {
    assert.equal(text.includes(forbidden), false, `human output must hide ${forbidden}`)
  }
})

test('human approval summaries expose only actionable supported permission, network, MCP and question details', () => {
  const { chunks, output } = makeOutput()
  output.emit('manual-response-required', {
    id: 'network-1', method: 'item/commandExecution/requestApproval',
    params: { networkApprovalContext: { host: 'api.example.test:8443', protocol: 'https' } },
  })
  output.emit('manual-response-required', {
    id: 'permissions-1', method: 'item/permissions/requestApproval',
    params: { permissions: {
      network: { enabled: true },
      fileSystem: { read: ['/repo/src'], write: ['/repo/out'], entries: [{ path: { type: 'glob_pattern', pattern: '/repo/cache/**' }, access: 'read' }] },
    } },
  })
  output.emit('manual-response-required', {
    id: 'elicitation-1', method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'calendar', mode: 'form', message: 'Choose a date',
      requestedSchema: { type: 'object', required: ['date'], properties: { date: { type: 'string', format: 'date' }, note: { type: 'string' } } },
    },
  })
  output.emit('manual-response-required', {
    id: 'elicitation-url-1', method: 'mcpServer/elicitation/request',
    params: { serverName: 'auth-provider', mode: 'url', message: 'Continue sign-in', url: 'https://user:pass@example.test:9443/authorize?access_token=private' },
  })
  output.emit('manual-response-required', {
    id: 'input-1', method: 'item/tool/requestUserInput',
    params: { questions: [
      { header: 'Region', question: 'Choose a region', options: [{ label: 'West', description: 'western region' }, { label: 'East', description: 'eastern region' }] },
      { header: 'Credential', question: 'Enter the secret', isSecret: true, options: [{ label: 'Never show this' }] },
    ] },
  })

  const text = chunks.join('')
  assert.match(text, /Network target: https api\.example\.test:8443/u)
  assert.match(text, /Requested network access: enabled/u)
  assert.match(text, /Requested filesystem read: \/repo\/src/u)
  assert.match(text, /Requested filesystem write: \/repo\/out/u)
  assert.match(text, /read: \/repo\/cache\/\*\*/u)
  assert.match(text, /MCP server: calendar/u)
  assert.match(text, /Requested fields: date \(string, required\); note \(string, optional\)/u)
  assert.match(text, /URL target: https:\/\/example\.test:9443/u)
  assert.match(text, /Choose a region.*options: West, East/u)
  assert.match(text, /secret answer requested; input will not be echoed/u)
  for (const forbidden of ['user:pass', 'access_token', 'private', 'western region', 'Never show this', 'Enter the secret']) {
    assert.equal(text.includes(forbidden), false, `human approval output must hide ${forbidden}`)
  }
})

test('human approval requests with no recognized actionable summary fail closed', () => {
  const { chunks, output } = makeOutput()
  output.emit('manual-response-required', { id: 'opaque-1', method: 'unknown/request', params: { reason: 'partial context only' } })
  output.emit('manual-response-required', { id: 'input-2', method: 'item/tool/requestUserInput', params: { questions: [{ isSecret: true }] } })
  const text = chunks.join('')
  assert.equal(occurrences(text, 'Details are unavailable in human view. Do not approve from this summary.'), 2)
  assert.match(text, /Use --json at startup for full protocol details on a future request/u)
  assert.equal(text.includes('Review the request before using'), false)
  assert.equal(text.includes('partial context only'), false, 'unrecognized methods do not expose partial context as a safe summary')
})

test('human assistant output escapes terminal controls across split deltas and preserves Unicode and newlines', () => {
  const { chunks, output } = makeOutput()
  const raw = 'Safe\nline\rreturn\t🙂\u001b]0;spoof title\u0007 after \u009b31mred\u001b[2J\u0008 \u202Ertl\u2066inside\u2069'
  const first = 'Safe\nline\rreturn\t🙂'
  const second = '\u001b'
  const third = raw.slice(first.length + second.length)
  output.emit('codex', itemDelta('safe-terminal', first))
  output.emit('codex', itemDelta('safe-terminal', second))
  output.emit('codex', itemDelta('safe-terminal', third))
  output.emit('codex', completedAgentMessage('safe-terminal', raw))
  output.close()

  const text = chunks.join('')
  const visible = 'Safe\nline\\u000Dreturn\t🙂\\u001B]0;spoof title\\u0007 after \\u009B31mred\\u001B[2J\\u0008 \\u202Ertl\\u2066inside\\u2069'
  assert.equal(occurrences(text, visible), 1, 'completion deduplication must compare the unsanitized source text')
  for (const unsafe of ['\r', '\u001b', '\u0007', '\u009b', '\u0008', '\u202e', '\u2066', '\u2069']) {
    assert.equal(text.includes(unsafe), false, `human terminal output must not contain U+${unsafe.codePointAt(0)!.toString(16)}`)
  }
  assert.ok(text.includes('Safe\nline\\u000Dreturn\t🙂'), 'ordinary Unicode, line feeds and tabs remain readable while carriage return is escaped')
})

test('JSON output preserves the existing line protocol exactly, including internal events', () => {
  const { chunks, output } = makeOutput(true)
  const event = { type: 'status', data: { enabled: false, events: [{ id: 'private-id' }], text: '\u001b]0;json-stays-exact\u0007\u202e' } }
  output.emit(event.type, event.data)
  output.emit('codex', { method: 'custom/protocol', params: { value: 1 } })
  assert.deepEqual(chunks, [`${JSON.stringify(event)}\n`, `${JSON.stringify({ type: 'codex', data: { method: 'custom/protocol', params: { value: 1 } } })}\n`])
})

function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1
}
