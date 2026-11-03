import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

/**
 * Monitoring presentation layer.
 *
 * The live relay Host may still ship the legacy "wait_run only" monitoring
 * contract. This module:
 *  - rewrites the monitoring guidance of the catalog tools so the old remote
 *    instruction is never presented unqualified (watch-first when offered,
 *    structured acknowledgement required),
 *  - extends `wait_run` with an optional `detail` selector (compact by
 *    default, legacy full snapshot on request), and
 *  - projects `wait_run` results into bounded facts instead of
 *    echoing a multi-megabyte run snapshot.
 *
 * Everything here works off loosely typed JSON shapes: no assertion may
 * require a complete `RunSnapshot`, so fixtures and partial Host payloads
 * both project safely.
 */

export type MonitoringDetail = 'brief' | 'full'

export interface ProjectWaitResultOptions {
  readonly detail: MonitoringDetail
  readonly wakeAvailable: boolean
}

type JsonRecord = Record<string, unknown>

interface HostPollFacts {
  schemaVersion: number
  waitRunIsASlice: true
  runComplete: boolean
  hostMustCallWaitRunAgain: boolean
  doNotConcludeHostTurn: boolean
  nextTool: string
  consumeAssistantTextBeforeClosing: boolean
  requiresWatchAcknowledgement?: true
}

interface BriefWaitFacts {
  schemaVersion: 1
  detail: 'brief'
  runId: string
  status: string
  lastEventSeq: number
  resultAvailable: boolean
  resultRef: string | null
  nextTool: string
  hostPollContract: HostPollFacts
  pendingInteractionCount?: number
  assistantTextOmitted?: true
}

const WAIT_RUN = 'wait_run'
const WATCH_RUN = 'watch_run'
const GET_RUN = 'get_run'
const LIST_INTERACTIONS = 'list_run_interactions'

const TERMINAL_STATUSES = new Set(['succeeded', 'incomplete', 'failed', 'cancelled'])
const ACTIVE_STATUSES = new Set(['running', 'unknown'])

const GUIDED_TOOL_NAMES = new Set(['start_run', 'start_review', 'get_run', 'respond_to_run_interaction'])

const DETAIL_PROPERTY = {
  type: 'string',
  enum: ['brief', 'full'],
  default: 'brief',
  description: 'brief (default): compact monitoring facts only — runId, status, lastEventSeq, result availability/reference, next tool, and hostPollContract, with no task, assistantText, error body, model metadata, write scope or content blocks. full: legacy complete snapshot including the full result body; get_run always returns the full result without a detail argument.',
} as const

const WATCH_FIRST_GUIDANCE =
  'Monitoring guidance: when this proxy offers watch_run, register a durable watch and await its structured response; only a watch_run response carrying acknowledged=true and hostMayConcludeTurn=true may pause the host turn, and no other tool, timeout, or nil result grants hostMayConcludeTurn. When watch_run is not offered, unavailable, or unacknowledged, continue with wait_run and its hostPollContract. A watch acknowledgment is never task completion: read get_run and verify assistantText.'

const WAIT_RUN_PRESENTATION =
  'Detail defaults to brief: a terminal or active slice projects compact facts (runId, status, lastEventSeq, resultAvailable/resultRef, nextTool, hostPollContract) and omits task, content, assistantText, error bodies and original content blocks. A terminal status is not verified completion; call get_run to consume the full result and assistantText. detail=full preserves the legacy full snapshot.'

/** Replace legacy wait-only monitoring sentences; non-monitoring text is untouched. */
const GUIDANCE_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Do not send a final user answer, mark the delegated task complete, or skip consuming assistantText while the run is still running\./gu, 'Without an acknowledged watch handoff, do not end the host turn while the run is running. A watch handoff is not task completion; retrieve get_run and verify the full result after wake.'],
  [
    /Sharing webUrl is not completion: keep wait_run until a terminal status, then consume assistantText\./gu,
    'Sharing webUrl is not completion. When this proxy does not offer watch_run, keep wait_run until a terminal status; when it does offer watch_run, register it and await structured acknowledged=true and hostMayConcludeTurn=true, and never grant hostMayConcludeTurn without that watch_run response. Either way, then consume the full result with get_run and read assistantText.',
  ],
  [
    /After start succeeds, share webUrl and keep wait_run until succeeded\/failed\/cancelled\/needs_attention\./gu,
    'After start succeeds, share webUrl; keep wait_run until succeeded/failed/cancelled/needs_attention unless this proxy offers watch_run, in which case register the watch and await structured acknowledged=true and hostMayConcludeTurn=true; never grant hostMayConcludeTurn without that watch_run response.',
  ],
  [
    /If status is running or unknown, hostPollContract\.hostMustCallWaitRunAgain is true and the host must not conclude\./gu,
    'If status is running or unknown, register watch_run when this proxy offers it and await structured acknowledged=true and hostMayConcludeTurn=true, never granting hostMayConcludeTurn without that watch_run response; otherwise hostPollContract.hostMustCallWaitRunAgain is true and the host must not conclude.',
  ],
  [
    /If hostPollContract\.hostMustCallWaitRunAgain is true, you MUST call wait_run again immediately\./gu,
    'If hostPollContract.hostMustCallWaitRunAgain is true, you MUST call wait_run again immediately unless watch_run already returned structured acknowledged=true and hostMayConcludeTurn=true; only that watch response may permit ending the host turn, and it is still not task completion.',
  ],
  [
    /After answering, continue wait_run\./gu,
    'After answering, continue monitoring: poll wait_run, or register watch_run when this proxy offers it and await structured acknowledged=true and hostMayConcludeTurn=true; hostMayConcludeTurn is never granted without that watch_run response.',
  ],
]

export function decorateMonitoringTool(tool: Tool): Tool {
  if (tool.name === WAIT_RUN) {
    return {
      ...tool,
      description: waitRunDescription(tool.description),
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...(tool.inputSchema.properties ?? {}),
          detail: { ...DETAIL_PROPERTY },
        },
      },
    }
  }
  if (!GUIDED_TOOL_NAMES.has(tool.name)) return tool
  return {
    ...tool,
    description: conditionedDescription(tool.description),
  }
}

export function projectWaitResult(result: CallToolResult, options: ProjectWaitResultOptions): CallToolResult {
  if (result.isError === true) return result
  if (options.detail === 'full') {
    const snapshot = readSnapshot(result)
    if (snapshot === null) return result
    return options.wakeAvailable ? withWakeHint(result) : result
  }
  const snapshot = readSnapshot(result)
  if (snapshot === null) return result

  const runId = boundedIdentifier(snapshot.runId)
  const status = typeof snapshot.status === 'string' ? snapshot.status : 'unknown'
  const lastEventSeq = typeof snapshot.lastEventSeq === 'number' && Number.isFinite(snapshot.lastEventSeq)
    ? snapshot.lastEventSeq
    : 0
  const pendingInteractionCount = countPendingInteractions(snapshot)
  const terminal = TERMINAL_STATUSES.has(status)
  const active = ACTIVE_STATUSES.has(status)
  const attention = status === 'needs_attention'
  const resultAvailable = terminal
  const resultRef = resultAvailable ? `${GET_RUN}:${runId}` : null
  const nextTool = attention
    ? LIST_INTERACTIONS
    : terminal
      ? GET_RUN
      : active && options.wakeAvailable
        ? WATCH_RUN
        : WAIT_RUN

  const hostPollContract = projectHostPollContract(status, nextTool, terminal)

  const facts: BriefWaitFacts = {
    schemaVersion: 1,
    detail: 'brief',
    runId,
    status,
    lastEventSeq,
    resultAvailable,
    resultRef,
    nextTool,
    hostPollContract,
    ...(attention ? { pendingInteractionCount } : {}),
    ...(terminal ? { assistantTextOmitted: true as const } : {}),
  }

  return {
    content: [{ type: 'text', text: briefLine(facts, options.wakeAvailable) }],
    structuredContent: facts as unknown as Record<string, unknown>,
  }
}

/**
 * Attach the watch registration requirement to an active snapshot without
 * dropping any original field. Active monitoring never acknowledges a watch
 * and never grants `hostMayConcludeTurn`; terminal payloads stay untouched.
 */
export function withWakeHint(result: CallToolResult): CallToolResult {
  if (result.isError === true) return result
  const snapshot = readSnapshot(result)
  if (snapshot === null) return result
  const status = typeof snapshot.status === 'string' ? snapshot.status : 'unknown'
  if (!ACTIVE_STATUSES.has(status)) return result

  const nextTool = WATCH_RUN
  const hostPollContract = projectHostPollContract(status, nextTool, false)
  const payload: JsonRecord = { ...snapshot, hostPollContract }
  // Never carry a stale completion grant forward.
  delete payload.hostMayConcludeTurn
  delete payload.acknowledged
  payload.wakeHint = {
    available: true,
    nextTool,
    requiresWatchAcknowledgement: true,
    hostMustCallWaitRunAgain: false,
    doNotConcludeHostTurn: true,
    note: 'Register watch_run and await its structured response; only acknowledged=true plus hostMayConcludeTurn=true may permit ending the host turn, and it is not task completion.',
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

function waitRunDescription(existing: string | undefined): string {
  return `${conditionedDescription(existing)} ${WAIT_RUN_PRESENTATION}`
}

function conditionedDescription(existing: string | undefined): string {
  const description = typeof existing === 'string' ? existing : ''
  let conditioned = description
  for (const [pattern, replacement] of GUIDANCE_REWRITES) conditioned = conditioned.replace(pattern, replacement)
  if (conditioned.includes('acknowledged=true') && conditioned.includes('hostMayConcludeTurn')) return conditioned
  return conditioned.length === 0 ? WATCH_FIRST_GUIDANCE : `${conditioned} ${WATCH_FIRST_GUIDANCE}`
}

function projectHostPollContract(status: string, nextTool: string, terminal: boolean): HostPollFacts {
  const contract: HostPollFacts = {
    schemaVersion: 1,
    waitRunIsASlice: true,
    runComplete: terminal,
    hostMustCallWaitRunAgain: nextTool === WAIT_RUN,
    doNotConcludeHostTurn: true,
    nextTool,
    consumeAssistantTextBeforeClosing: terminal,
    ...(nextTool === WATCH_RUN ? { requiresWatchAcknowledgement: true as const } : {}),
  }
  return contract
}

function briefLine(facts: BriefWaitFacts, wakeAvailable: boolean): string {
  const parts = [
    `${WAIT_RUN} runId=${facts.runId}`,
    `status=${facts.status}`,
    `seq=${facts.lastEventSeq}`,
  ]
  if (facts.pendingInteractionCount !== undefined) parts.push(`pendingInteractions=${facts.pendingInteractionCount}`)
  if (facts.resultAvailable) parts.push('resultAvailable=true')
  parts.push(`next=${facts.nextTool}`)
  const notes: string[] = []
  if (facts.pendingInteractionCount !== undefined) {
    notes.push(`call ${LIST_INTERACTIONS} for details; this projection reports the count only and grants no permission`)
  } else if (facts.assistantTextOmitted === true) {
    notes.push(`assistantTextOmitted; terminal status is NOT verified completion — call ${GET_RUN} to consume the full result`)
  } else if (facts.nextTool === WATCH_RUN && wakeAvailable) {
    notes.push(`register ${WATCH_RUN} and await structured acknowledged=true and hostMayConcludeTurn=true; no acknowledgement is granted here and the host turn may not conclude yet`)
  } else {
    notes.push('keep polling; a timeout is a slice, not completion — the host turn may not conclude yet')
  }
  return oneLine(`${parts.join(' ')} — ${notes.join('; ')}`)
}

function oneLine(text: string): string {
  const flat = text.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return flat.length <= 400 ? flat : `${flat.slice(0, 397)}...`
}

function boundedIdentifier(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'unknown'
  return trimmed.length <= 160 ? trimmed : trimmed.slice(0, 160)
}

function countPendingInteractions(snapshot: JsonRecord): number {
  const interactions = snapshot.pendingInteractions
  return Array.isArray(interactions) ? interactions.length : 0
}

function readSnapshot(result: CallToolResult): JsonRecord | null {
  const structured = result.structuredContent
  if (isRecord(structured)) return structured
  const content = result.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    try {
      const parsed: unknown = JSON.parse(block.text)
      if (isRecord(parsed)) return parsed
    } catch {
      // Not a JSON projection; nothing to project.
    }
  }
  return null
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
