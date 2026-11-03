#!/usr/bin/env node
// P0 fixture: independent read-only MCP context probe (NOT a Relay client).
// Purpose: observe how the real Codex daemon binds an MCP stdio server per thread.
// It reports ONLY:
//   - CODEX_THREAD_ID / CODEX_SESSION_ID, and only when they are UUID-shaped (else null)
//   - host-authored request.params._meta.threadId, only if UUID-shaped
//   - all other request.params._meta KEY NAMES only (never their values)
// It performs no filesystem writes, no network, no subprocesses, no model calls,
// no config/auth access, and never touches a running daemon.
//
// Second tool: `codex_queue_probe_wait` — zero-argument, read-only, holds the
// current turn busy for 2000 ms. It echoes no identifiers. The context probe
// above does not expose arbitrary metadata values.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const SERVER_NAME = 'mcp-thread-context-probe'
const SERVER_VERSION = '0.0.1'
const TOOL_NAME = 'codex_thread_context_probe'
const WAIT_TOOL_NAME = 'codex_queue_probe_wait'
const WAIT_MS = 2000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const uuidOrNull = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return UUID_RE.test(trimmed) ? trimmed : null
}

const metaKeysOf = (meta) => {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return []
  return Object.keys(meta).sort()
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

server.registerTool(
  TOOL_NAME,
  {
    title: 'Codex thread context probe',
    description:
      'Read-only probe. Returns CODEX_THREAD_ID and CODEX_SESSION_ID only when UUID-shaped (otherwise null), ' +
      'plus a UUID-only host _meta.threadId and the key names of request._meta. No writes, no network, no subprocesses.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (_args, extra) => {
    const payload = {
      server: SERVER_NAME,
      tool: TOOL_NAME,
      codexThreadId: uuidOrNull(process.env.CODEX_THREAD_ID),
      metaThreadId: uuidOrNull(extra?._meta?.threadId),
      codexSessionId: uuidOrNull(process.env.CODEX_SESSION_ID),
      metaKeys: metaKeysOf(extra?._meta),
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  },
)

server.registerTool(
  WAIT_TOOL_NAME,
  {
    title: 'Codex queue probe wait',
    description:
      'Zero-argument, read-only probe tool. Holds the current turn busy for exactly 2000 ms so a second client can ' +
      'observe queue/start busy rejection. No writes, no network, no subprocesses, and it echoes no identifiers.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, WAIT_MS)
    })
    const payload = { server: SERVER_NAME, tool: WAIT_TOOL_NAME, waitedMs: WAIT_MS }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  },
)

await server.connect(new StdioServerTransport())
