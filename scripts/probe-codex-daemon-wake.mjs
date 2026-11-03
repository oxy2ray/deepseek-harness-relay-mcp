#!/usr/bin/env node
/**
 * Read-only probe for an ALREADY RUNNING Codex app-server daemon.
 *
 * It opens one short-lived WebSocket over the daemon's AF_UNIX control socket
 * (official transport: HTTP Upgrade at `ws://localhost/` over the Unix stream),
 * runs the `initialize` handshake, then `thread/read` with `includeTurns: false`
 * for the requested thread. It prints daemon connection facts and a whitelisted
 * thread metadata/status projection only — never previews, turns, items or other
 * conversation contents.
 *
 * The raw `codex app-server proxy` stdio path is retired: the official proxy only
 * copies raw bytes and performs no HTTP Upgrade, so it cannot carry this protocol.
 * The probe never starts a proxy or the daemon, reads/copies auth files, approves
 * requests, changes thread settings, submits turns, or connects to Relay RPC.
 */
import { parseArgs } from 'node:util'
import { CodexDaemonClient, createCodexUnixWebSocketTransport } from '../src/wake/codex-daemon-client.ts'

const HELP = `probe-codex-daemon-wake.mjs — read-only Codex daemon wake probe

Connects to an ALREADY RUNNING Codex app-server daemon through its official
transport: one WebSocket over the AF_UNIX control socket ('ws://localhost/'
HTTP Upgrade on the Unix stream). The probe closes only its own WebSocket on
exit; the daemon itself is never started, restarted, stopped or reconfigured.

It performs 'initialize' + 'initialized', then 'thread/read' with
'includeTurns: false', and prints one JSON report with daemon connection facts
and matching thread metadata/status (no conversation contents).

Exact invocation (tsx is an installed dev dependency and resolves the TS client):

  npx tsx scripts/probe-codex-daemon-wake.mjs --socket /path/to/daemon.sock --thread <thread-id>

Node >= 23.6 can also strip types natively:

  node scripts/probe-codex-daemon-wake.mjs --socket /path/to/daemon.sock --thread <thread-id>

Options:
  --socket PATH    absolute filesystem socket of the running daemon (required)
  --thread ID      thread id whose metadata should be read (required)
  --timeout MS     per-request timeout in milliseconds, 1000..60000 (default 10000)
  -h, --help       print this help and exit 0

Exit codes: 0 report printed, 1 probe failed (bounded diagnostic on stderr), 2 usage error.

Read-only guarantees: no approval responses, no thread settings or turn writes,
no auth-file access, no Relay RPC, no daemon lifecycle commands.
`

const MAX_TEXT = 300

function bounded(value, max = MAX_TEXT) {
  return String(value).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, max)
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function usageError(message) {
  process.stderr.write(`probe-codex-daemon-wake: ${bounded(message, 200)}\n\n${HELP}`)
  process.exitCode = 2
}

function parseTimeout(raw) {
  if (raw === undefined) return 10000
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 60000) {
    throw new Error('--timeout must be an integer between 1000 and 60000')
  }
  return parsed
}

function parseThreadId(raw) {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 200) {
    throw new Error('--thread requires a single-line thread id of at most 200 characters')
  }
  if (/[\u0000-\u001f\u007f]/u.test(raw)) throw new Error('--thread must be a single-line thread id')
  return raw
}

function parseSocket(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
    throw new Error('--socket requires a filesystem path to the running daemon socket')
  }
  if (/[\u0000\r\n]/u.test(raw)) throw new Error('--socket must be a single-line filesystem path')
  return raw
}

function projectStatus(status) {
  if (!isRecord(status) || typeof status.type !== 'string') return { type: 'unknown' }
  const type = bounded(status.type, 32)
  const activeFlags = Array.isArray(status.activeFlags)
    ? status.activeFlags.filter(flag => typeof flag === 'string').slice(0, 8).map(flag => bounded(flag, 32))
    : undefined
  return activeFlags ? { type, activeFlags } : { type }
}

/**
 * Whitelist projection. Deliberately excludes `preview`, `turns`, `environments`,
 * `extra` and any other field that can carry conversation contents.
 */
function projectThread(thread) {
  if (!isRecord(thread)) return null
  return {
    id: typeof thread.id === 'string' ? bounded(thread.id, 200) : null,
    name: typeof thread.name === 'string' ? bounded(thread.name, 200) : null,
    status: projectStatus(thread.status),
    ephemeral: thread.ephemeral === true,
    createdAt: isFiniteNumber(thread.createdAt) ? thread.createdAt : null,
    updatedAt: isFiniteNumber(thread.updatedAt) ? thread.updatedAt : null,
    modelProvider: typeof thread.modelProvider === 'string' ? bounded(thread.modelProvider, 64) : null,
    model: typeof thread.model === 'string' ? bounded(thread.model, 128) : null,
    cwd: typeof thread.cwd === 'string' ? bounded(thread.cwd, 300) : null,
    canAcceptDirectInput: typeof thread.canAcceptDirectInput === 'boolean' ? thread.canAcceptDirectInput : null,
  }
}

async function main() {
  let values
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        socket: { type: 'string' },
        thread: { type: 'string' },
        timeout: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error))
    return
  }

  if (values.help) {
    process.stdout.write(HELP)
    return
  }
  if (values.socket === undefined || values.thread === undefined) {
    usageError('both --socket and --thread are required')
    return
  }

  let socket
  let threadId
  let timeoutMs
  try {
    socket = parseSocket(values.socket)
    threadId = parseThreadId(values.thread)
    timeoutMs = parseTimeout(values.timeout)
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error))
    return
  }

  const transport = createCodexUnixWebSocketTransport({ socket })
  const client = new CodexDaemonClient({
    transport,
    requestTimeoutMs: timeoutMs,
    clientInfo: { name: 'dsh-relay-codex-daemon-wake-probe', title: null, version: '1' },
  })
  let transportClosed = false
  const shutdown = async (code) => {
    try { await client.close(); transportClosed = transport.closed } catch { /* bounded shutdown */ }
    process.exit(code)
  }
  process.once('SIGINT', () => { void shutdown(130) })
  process.once('SIGTERM', () => { void shutdown(143) })

  let outcome = null
  let failure = null
  try {
    const summary = await client.initialize()
    const response = await client.request('thread/read', { threadId, includeTurns: false })
    if (!isRecord(response) || !isRecord(response.thread)) {
      throw new Error('daemon returned no thread metadata for the requested thread')
    }
    const thread = projectThread(response.thread)
    if (thread === null || thread.id !== threadId) {
      throw new Error('daemon returned metadata for a different thread')
    }
    outcome = { summary, thread }
  } catch (error) {
    failure = error
  }

  try {
    await client.close()
    transportClosed = transport.closed
  } catch {
    transportClosed = false
  }

  if (failure) {
    const message = failure instanceof Error ? bounded(failure.message, 200) : 'unknown probe failure'
    process.stderr.write(`probe-codex-daemon-wake: ${message}\n`)
    process.exitCode = 1
    return
  }

  const report = {
    probe: 'codex-daemon-wake',
    readOnly: true,
    includeTurns: false,
    daemon: {
      socket,
      transport: 'unix-websocket',
      userAgent: outcome.summary.userAgent,
      platformFamily: outcome.summary.platformFamily,
      platformOs: outcome.summary.platformOs,
      closed: transportClosed,
    },
    thread: {
      requestedThreadId: threadId,
      found: true,
      ...outcome.thread,
    },
    serverRequestsObserved: client.serverRequestCount,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

await main()
