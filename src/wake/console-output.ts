export interface ConsoleOutputOptions {
  json: boolean
  write: (text: string) => void
}

interface StreamedAssistantTurn {
  text: string
  truncated: boolean
}

const assistantTextLimit = 64 * 1024
const turnLimit = 64

/** Renders the console protocol as stable JSON or concise, safe human output. */
export function createConsoleOutput(options: ConsoleOutputOptions): {
  emit(type: string, data: unknown): void
  close(): void
} {
  const turns = new Map<string, StreamedAssistantTurn>()
  const completedTurns = new Set<string>()
  const completedTurnNotifications = new Set<string>()
  let activeAssistantMessage: string | null = null
  let assistantLineOpen = false
  let wakeErrorLatched = false

  const writeLine = (text: string) => {
    endAssistantLine()
    options.write(`${text}\n`)
  }

  function endAssistantLine(): void {
    if (!assistantLineOpen) return
    options.write('\n')
    assistantLineOpen = false
    activeAssistantMessage = null
  }

  function emitCodex(data: unknown): void {
    if (!isRecord(data) || typeof data.method !== 'string' || !isRecord(data.params)) return
    const method = data.method.toLowerCase()
    const params = data.params
    const turnId = readTurnId(params)

    if (method.includes('agentmessage') && method.includes('delta')) {
      const delta = extractText(params)
      if (!delta || !turnId) return
      const itemId = readItemId(params.itemId ?? params.item)
      const messageKey = assistantMessageKey(turnId, itemId)
      let turn = turns.get(messageKey)
      if (!turn) {
        turn = { text: '', truncated: false }
        turns.set(messageKey, turn)
        boundTurns(turns)
      }
      if (!assistantLineOpen || activeAssistantMessage !== messageKey) {
        endAssistantLine()
        options.write('Codex: ')
        activeAssistantMessage = messageKey
        assistantLineOpen = true
      }
      options.write(sanitizeTerminalText(delta))
      if (!turn.truncated) {
        const remaining = assistantTextLimit - turn.text.length
        if (delta.length <= remaining) turn.text += delta
        else {
          turn.text += delta.slice(0, Math.max(0, remaining))
          turn.truncated = true
        }
      }
      return
    }

    if (method === 'item/completed' && isAgentMessageItem(params.item)) {
      const text = extractText(params.item)
      if (!text) return
      const itemId = readItemId(params.item)
      const messageKey = assistantMessageKey(turnId, itemId)
      const completionKey = assistantCompletionKey(turnId, itemId, text)
      if (completedTurns.has(completionKey)) return
      const turn = turns.get(messageKey)
      if (!turn || turn.text.length === 0) {
        writeLine(`Codex: ${sanitizeTerminalText(text)}`)
      } else {
        if (!assistantLineOpen || activeAssistantMessage !== messageKey) {
          endAssistantLine()
          options.write('Codex: ')
          activeAssistantMessage = messageKey
          assistantLineOpen = true
        }
        if (!turn.truncated && text.startsWith(turn.text)) options.write(sanitizeTerminalText(text.slice(turn.text.length)))
        endAssistantLine()
      }
      turns.delete(messageKey)
      completedTurns.add(completionKey)
      boundSet(completedTurns)
      return
    }

    if (method === 'turn/completed') {
      const completionKey = turnId ?? 'unknown-turn'
      if (completedTurnNotifications.has(completionKey)) return
      const turn = isRecord(params.turn) ? params.turn : undefined
      const status = typeof turn?.status === 'string' ? turn.status : isRecord(turn?.status) && typeof turn.status.type === 'string' ? turn.status.type : ''
      if (['completed', 'failed', 'interrupted'].includes(status)) {
        completedTurnNotifications.add(completionKey)
        boundSet(completedTurnNotifications)
        if (status === 'completed') writeLine('Codex turn complete.')
        else if (status === 'failed') writeLine('Codex turn failed; check the console status before continuing.')
        else writeLine('Codex turn interrupted.')
      }
    }
  }

  function emitApproval(data: unknown): void {
    if (!isRecord(data)) return
    const id = safeIdentifier(data.id)
    const method = safeMethod(data.method)
    if (!id || !method) {
      writeLine('Manual approval required. The request identity is unavailable; no action was taken.')
      return
    }
    const params = isRecord(data.params) ? data.params : {}
    const summary = approvalSummary(method.toLowerCase(), params)
    const lines = [
      `Manual approval required — request ${id} (${method}).`,
      ...summary.lines,
      ...(summary.supported
        ? [`Review the request before using /respond ${id} <json>. No approval was sent.`]
        : [`Details are unavailable in human view. Do not approve from this summary. Use --json at startup for full protocol details on a future request, or let this request expire. No approval was sent.`]),
    ]
    for (const line of lines) writeLine(line)
  }

  function emitHuman(type: string, data: unknown): void {
    if (type === 'codex') { emitCodex(data); return }
    if (type === 'manual-response-required') { emitApproval(data); return }

    if (type === 'console-bound') {
      const threadId = isRecord(data) ? safeIdentifier(data.threadId) : null
      writeLine(threadId ? `Wake console bound to thread ${threadId}.` : 'Wake console bound to its private thread.')
      return
    }
    if (type === 'readiness') {
      const authenticated = isRecord(data) && data.authenticated === true
      const relay = isRecord(data) && data.relayConfigured === true
      if (authenticated && relay) wakeErrorLatched = false
      writeLine(`Readiness: Codex ${authenticated ? 'authenticated' : 'not ready'}; Relay ${relay ? 'configured' : 'not configured'}.`)
      return
    }
    if (type === 'status') {
      if (!isRecord(data)) { writeLine('Status unavailable.'); return }
      const state = data.enabled === true ? 'enabled' : 'paused'
      writeLine(`Queue ${state} · watching ${count(data.watching)}/${count(data.watches)} · queued ${count(data.queuedEvents)} · acknowledged ${count(data.acknowledged)} · held ${count(data.held)} · failed ${count(data.deadLetters)}.`)
      return
    }
    if (type === 'help') {
      writeLine('Commands: /status, /pause, /resume, /watch RUN KEY, /recover ID, /respond ID JSON, /quit. Plain text sends a user message when the thread is idle.')
      return
    }
    if (type === 'user-admission') {
      const kind = isRecord(data) && typeof data.kind === 'string' ? data.kind : ''
      if (kind === 'accepted') writeLine('Message accepted.')
      else if (kind === 'busy') writeLine('Thread is busy; the message was not admitted.')
      else if (kind) writeLine('Message was not admitted; check the current status.')
      return
    }
    if (type === 'watch-registered') {
      const runId = isRecord(data) ? safeIdentifier(data.runId) : null
      writeLine(runId ? `Now watching run ${runId}.` : 'Run watch registered.')
      return
    }
    if (type === 'wake-tick') {
      if (!isRecord(data)) return
      const collected = count(data.collected), started = count(data.started), failed = count(data.failed)
      if (data.ready === true && failed === 0) wakeErrorLatched = false
      if (collected > 0) writeLine(`Received ${collected} event${collected === 1 ? '' : 's'}.`)
      if (started > 0) writeLine(`Started ${started} wake turn${started === 1 ? '' : 's'}.`)
      if (failed > 0) emitWakeError()
      return
    }
    if (type === 'wake-paused-by-error') { emitWakeError(); return }
    if (type === 'held-recovery') {
      const recovered = isRecord(data) && data.recovered === true
      writeLine(recovered ? 'Held wake recovered from durable history; no new turn was submitted.' : 'Held wake remains unresolved; inspect /status before continuing.')
      return
    }
    if (type === 'command-rejected') { writeLine('Command not accepted; check its syntax, readiness, or pending request ID.'); return }
    if (type === 'cleanup-warning') { writeLine('Cleanup reported a warning; inspect private process and lock state.'); return }
    if (type === 'preflight') {
      const ok = isRecord(data) && data.authenticated === true && data.relayConnected === true
      writeLine(`Preflight ${ok ? 'passed' : 'failed'}: authentication and Relay connectivity ${ok ? 'ready' : 'not ready'}.`)
    }
    // Internal protocol records and tool results are intentionally not rendered.
  }

  function emitWakeError(): void {
    if (wakeErrorLatched) return
    wakeErrorLatched = true
    writeLine('Wake processing paused after an error; queued work is preserved. Check /status.')
  }

  return {
    emit(type, data) {
      if (options.json) options.write(`${JSON.stringify({ type, data })}\n`)
      else emitHuman(type, data)
    },
    close() { endAssistantLine() },
  }
}

function approvalSummary(method: string, params: Record<string, unknown>): { lines: string[]; supported: boolean } {
  if (!isSupportedApprovalMethod(method)) return { lines: [], supported: false }
  const lines: string[] = []
  let supported = false
  const reason = safeSummary(params.reason)
  if (reason) { lines.push(`Reason: ${reason}`); supported = true }
  const command = safeCommand(params.command)
  if (command) { lines.push(`Command: ${command}`); supported = true }
  const path = safePath(params.path ?? params.grantRoot ?? params.cwd)
  if (path) { lines.push(`Path: ${path}`); supported = true }

  if (method.includes('commandexecution') && isRecord(params.networkApprovalContext)) {
    const context = params.networkApprovalContext
    const host = safeHost(context.host)
    const protocol = safeProtocol(context.protocol)
    if (host && protocol) { lines.push(`Network target: ${protocol} ${host}`); supported = true }
  }
  if (method.includes('permissions') || method.includes('requestpermission')) {
    const permissions = isRecord(params.permissions) ? params.permissions : null
    if (permissions) {
      if (isRecord(permissions.network) && permissions.network.enabled === true) {
        lines.push('Requested network access: enabled'); supported = true
      }
      const filesystem = isRecord(permissions.fileSystem) ? permissions.fileSystem : null
      if (filesystem) {
        const read = safePathList(filesystem.read)
        const write = safePathList(filesystem.write)
        const entries = safeFilesystemEntries(filesystem.entries)
        if (read.length) { lines.push(`Requested filesystem read: ${read.join(', ')}`); supported = true }
        if (write.length) { lines.push(`Requested filesystem write: ${write.join(', ')}`); supported = true }
        if (entries.length) { lines.push(`Requested filesystem access: ${entries.join(', ')}`); supported = true }
      }
    }
  }
  if (method.includes('mcpserver') && method.includes('elicitation')) {
    const server = safeSummary(params.serverName)
    if (server) { lines.push(`MCP server: ${server}`); supported = true }
    const message = safeSummary(params.message)
    if (message) { lines.push(`Request: ${message}`); supported = true }
    if (params.mode === 'url') {
      const target = safeUrlHost(params.url)
      if (target) { lines.push(`URL target: ${target}`); supported = true }
    } else if (isRecord(params.requestedSchema)) {
      const fields = safeSchemaFields(params.requestedSchema)
      if (fields.length) { lines.push(`Requested fields: ${fields.join('; ')}`); supported = true }
    }
  }
  if (method.includes('requestuserinput')) {
    const questions = safeQuestions(params.questions)
    if (questions.length) { lines.push(...questions); supported = true }
  }
  return { lines: lines.slice(0, 24), supported }
}

function isSupportedApprovalMethod(method: string): boolean {
  return [
    'item/commandexecution/requestapproval',
    'item/filechange/requestapproval',
    'item/permissions/requestapproval',
    'mcpserver/elicitation/request',
    'item/tool/requestuserinput',
  ].includes(method)
}

function safeQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const lines: string[] = []
  for (const entry of value.slice(0, 8)) {
    if (!isRecord(entry)) continue
    const header = safeSummary(entry.header)
    const questionText = safeSummary(entry.question)
    const question = entry.isSecret === true ? null : questionText
    const options = entry.isSecret === true ? [] : Array.isArray(entry.options)
      ? entry.options.slice(0, 8).flatMap(option => isRecord(option) && typeof option.label === 'string' ? [safeSummary(option.label)].filter((label): label is string => Boolean(label)) : [])
      : []
    if (!header && !questionText && !options.length) continue
    const parts = [header, question].filter((part): part is string => Boolean(part))
    if (entry.isSecret === true) parts.push('secret answer requested; input will not be echoed')
    else if (options.length) parts.push(`options: ${options.join(', ')}`)
    lines.push(`Question: ${parts.join(' — ')}`)
  }
  return lines
}

function safeSchemaFields(schema: Record<string, unknown>): string[] {
  if (!isRecord(schema.properties)) return []
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [])
  return Object.entries(schema.properties).slice(0, 12).flatMap(([name, field]) => {
    if (!/^[A-Za-z0-9_. -]{1,64}$/u.test(name) || !isRecord(field)) return []
    const type = ['string', 'number', 'integer', 'boolean'].includes(String(field.type)) ? String(field.type) : 'value'
    return [`${name} (${type}${required.has(name) ? ', required' : ', optional'})`]
  })
}

function safePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).flatMap(item => {
    const path = safePath(item)
    return path ? [path] : []
  })
}

function safeFilesystemEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).flatMap(entry => {
    if (!isRecord(entry)) return []
    let path: string | null = safePath(entry.path)
    if (isRecord(entry.path)) {
      if (entry.path.type === 'path') path = safePath(entry.path.path)
      else if (entry.path.type === 'glob_pattern') path = safeSummary(entry.path.pattern)
      else if (entry.path.type === 'special') path = safeSummary(entry.path.value)
      else path = null
    }
    const access = safeSummary(entry.access)
    return path && access ? [`${access}: ${path}`] : []
  })
}

function safeProtocol(value: unknown): string | null {
  return ['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(String(value)) ? String(value) : null
}

function safeHost(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 255 || /[\s/@?#\\]/u.test(value)) return null
  try {
    const parsed = new URL(`http://${value}`)
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
  } catch { return null }
}

function safeUrlHost(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return `${parsed.protocol}//${parsed.host}`
  } catch { return null }
}

function isAgentMessageItem(value: unknown): boolean {
  return isRecord(value) && value.type === 'agentMessage'
}

function readTurnId(params: Record<string, unknown>): string | null {
  if (typeof params.turnId === 'string' && params.turnId.length <= 160) return params.turnId
  if (isRecord(params.turn) && typeof params.turn.id === 'string' && params.turn.id.length <= 160) return params.turn.id
  return null
}

function readItemId(value: unknown): string | null {
  if (isRecord(value)) return safeIdentifier(value.id)
  return safeIdentifier(value)
}

function assistantMessageKey(turnId: string | null, itemId: string | null): string {
  return `${turnId ?? 'unknown-turn'}:${itemId ?? 'single-message'}`
}

function assistantCompletionKey(turnId: string | null, itemId: string | null, text: string): string {
  return itemId ? `${turnId ?? 'unknown-turn'}:${itemId}` : `${turnId ?? 'unknown-turn'}:${text}`
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, assistantTextLimit)
  if (Array.isArray(value)) return value.map(extractText).join('').slice(0, assistantTextLimit)
  if (!isRecord(value)) return ''
  const parts: string[] = []
  for (const key of ['delta', 'text', 'message']) if (typeof value[key] === 'string') parts.push((value[key] as string).slice(0, assistantTextLimit))
  if (Array.isArray(value.content)) parts.push(extractText(value.content))
  if (isRecord(value.item)) parts.push(extractText(value.item))
  return parts.join('').slice(0, assistantTextLimit)
}

function boundTurns(turns: Map<string, StreamedAssistantTurn>): void {
  while (turns.size > turnLimit) turns.delete(turns.keys().next().value!)
}

function boundSet(values: Set<string>): void {
  while (values.size > turnLimit) values.delete(values.values().next().value!)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(1_000_000, Math.floor(value)) : 0
}

function safeIdentifier(value: unknown): string | null {
  return (typeof value === 'string' || typeof value === 'number') && /^[A-Za-z0-9_.:-]{1,160}$/u.test(String(value)) ? String(value) : null
}

function safeMethod(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_./:-]{0,100}$/u.test(value) ? value : null
}

function safeSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const summary = sanitizeTerminalText(redact(value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim())).slice(0, 180)
  return summary || null
}

function safeCommand(value: unknown): string | null {
  if (typeof value === 'string') return safeSummary(value)
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return safeSummary(value.join(' '))
  return null
}

function safePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 1024) return null
  const clean = sanitizeTerminalText(redact(value.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' '))).slice(0, 180)
  return clean || null
}

/** Make untrusted text inert in a terminal, even when control sequences span deltas. */
function sanitizeTerminalText(value: string): string {
  let safe = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    const control = (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a)
      || (codePoint >= 0x7f && codePoint <= 0x9f)
    const bidi = codePoint === 0x061c || codePoint === 0x200e || codePoint === 0x200f
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x206f)
    safe += control || bidi ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}` : character
  }
  return safe
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/gu, '[redacted-token]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)(\s*[:=]\s*|\s+)[^\s,;]+/giu, '$1$2[redacted]')
    .replace(/https?:\/\/[^\s]+/giu, '[URL]')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
