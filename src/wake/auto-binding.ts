import { isAbsolute, relative, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import { CodexDaemonClient, createCodexUnixWebSocketTransport } from './codex-daemon-client.js'
import { codexServerIdentity, type ExistingCodexClient } from './existing-codex-host.js'
import type { WakeBinding, WakeRunSnapshot } from './schema.js'
import type { WakeOutbox } from './outbox.js'

/** Explicit operator opt-in: these canonical workspace roots may auto-enroll new threads, for this long. */
export interface AutoBindPolicy {
  workspaceRoots: string[]
  ttlMs: number
}

/** Trusted control-plane input. `threadId` comes from host request `_meta`, never from model text. */
export interface AutoBindInput {
  outbox: WakeOutbox
  socket: string
  principal: string
  policy: AutoBindPolicy
  threadId: string
  run: WakeRunSnapshot
}

/** Short-lived client used only to read the daemon identity and one exact thread. */
export interface AutoBindClient extends ExistingCodexClient {
  close(): Promise<void> | void
}

/** Injection seam for tests: no live daemon, socket or Relay connection is required. */
export interface AutoBindDeps {
  connect(socket: string): AutoBindClient
  uid(): number | string
}

export const defaultAutoBindDeps: AutoBindDeps = {
  connect: socket => new CodexDaemonClient({ transport: createCodexUnixWebSocketTransport({ socket }) }),
  uid: () => process.getuid?.() ?? 0,
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const threadReadShape = z.object({
  thread: z.object({
    id: z.string(),
    cwd: z.string(),
    /** Only an idle, directly addressable main thread can carry a wake delivery. */
    canAcceptDirectInput: z.literal(true),
  }).passthrough(),
}).passthrough()
const initializeShape = z.object({ codexHome: z.string().min(1) }).passthrough()

/**
 * Auto-enrolls one newly opened existing Codex conversation.
 *
 * The daemon is read through a fresh short-lived Unix WebSocket client: initialize
 * publishes `codexHome`, then `thread/read` proves the exact UUID is directly
 * addressable and reports its actual cwd. The cwd must be normalized and, after
 * realpath, physically lie under one configured canonical workspace root.
 *
 * Any persisted binding already owning this thread + principal + server wins and is
 * returned unchanged (disabled and expired rows included); a mismatch is rejected.
 * Nothing is ever re-enabled, replaced, renewed or retargeted, and a global operator
 * pause prevents new auto registration.
 */
export async function ensureAutoBinding(input: AutoBindInput): Promise<WakeBinding> {
  return ensureAutoBindingWith(input, defaultAutoBindDeps)
}

export async function ensureAutoBindingWith(input: AutoBindInput, deps: AutoBindDeps): Promise<WakeBinding> {
  if (typeof input.threadId !== 'string' || !uuidPattern.test(input.threadId)) throw new Error('auto binding requires an explicit thread UUID')
  const policy = validatePolicy(input.policy)
  if (typeof input.principal !== 'string' || input.principal.length === 0) throw new Error('auto binding requires a principal')
  if (typeof input.socket !== 'string' || input.socket.length === 0 || /[\u0000\r\n]/u.test(input.socket)) throw new Error('auto binding requires an explicit daemon socket')
  const runWorkspace = normalizeRunWorkspace(input.run)
  const canonicalRoots = await canonicalizeRoots(policy.workspaceRoots)

  const client = deps.connect(input.socket)
  try {
    const initialized = initializeShape.parse(await client.initialize())
    if (client.disconnected) throw new Error('existing Codex daemon client is disconnected')
    const codexHome = resolve(initialized.codexHome)
    const serverIdentity = codexServerIdentity({ socket: input.socket, codexHome, uid: deps.uid() })

    const { thread } = threadReadShape.parse(await client.request('thread/read', { threadId: input.threadId, includeTurns: false }))
    if (thread.id !== input.threadId) throw new Error('existing Codex thread identity mismatch')
    if (!isAbsolute(thread.cwd) || resolve(thread.cwd) !== thread.cwd) throw new Error('daemon thread cwd must be absolute and normalized')
    const workspace = resolve(thread.cwd)
    const physicalCwd = await realpath(workspace).catch(() => { throw new Error('daemon thread cwd is physically unavailable') })
    if (!canonicalRoots.some(root => containsPhysicalPath(root, physicalCwd))) {
      throw new Error('daemon thread cwd is outside the configured auto-bind workspace roots')
    }

    // First persisted row wins: an existing binding is never re-enabled, replaced,
    // renewed or retargeted, even when it is currently disabled or expired.
    const state = await input.outbox.store.read()
    const existing = await resolveExisting(state.bindings, input.threadId, serverIdentity, input.principal, runWorkspace, physicalCwd)
    if (existing) return existing

    if (!state.enabled) throw new Error('wake is globally paused; auto binding is not registered')
    const bindingId = `auto-${input.threadId}`
    if (state.bindings.some(binding => binding.bindingId === bindingId)) {
      throw new Error('auto binding id is already used by a different thread or daemon')
    }
    const mapped = runWorkspace !== workspace
    if (mapped) await validateMappedRun(workspace, runWorkspace, input.run)
    const expiresAt = input.outbox.now() + policy.ttlMs
    if (!Number.isSafeInteger(expiresAt)) throw new Error('auto binding expiry is not representable')
    const binding: WakeBinding = {
      bindingId, threadId: input.threadId, principal: input.principal, workspace,
      ...(mapped ? { relayWorkspace: runWorkspace } : {}),
      serverIdentity, enabled: true, expiresAt,
    }
    try {
      await input.outbox.registerBinding(binding)
    } catch (error) {
      // A concurrent conversation may have won the same thread first. Return the
      // winner unchanged if it is compatible; otherwise the immutable-row error stands.
      const raced = await resolveExisting((await input.outbox.store.read()).bindings, input.threadId,
        serverIdentity, input.principal, runWorkspace, physicalCwd)
      if (raced) return raced
      throw error
    }
    const persisted = (await input.outbox.store.read()).bindings.find(row => row.bindingId === bindingId)
    if (!persisted) throw new Error('auto binding registration was not durable')
    return persisted
  } finally {
    await Promise.resolve().then(() => client.close()).catch(() => undefined)
  }
}

function validatePolicy(policy: AutoBindPolicy): AutoBindPolicy {
  if (policy === null || typeof policy !== 'object' || !Array.isArray(policy.workspaceRoots)) throw new Error('auto binding policy requires workspace roots')
  if (policy.workspaceRoots.length === 0) throw new Error('auto binding policy requires at least one workspace root')
  for (const root of policy.workspaceRoots) {
    if (typeof root !== 'string' || !isAbsolute(root) || /[\u0000\r\n]/u.test(root)) throw new Error('auto binding workspace roots must be absolute paths')
  }
  if (!Number.isSafeInteger(policy.ttlMs) || policy.ttlMs <= 0) throw new Error('auto binding ttlMs must be a positive integer')
  return policy
}

async function canonicalizeRoots(roots: string[]): Promise<string[]> {
  return Promise.all(roots.map(async root => realpath(root).catch(() => {
    throw new Error('auto binding workspace root is physically unavailable')
  })))
}

function normalizeRunWorkspace(run: WakeRunSnapshot): string {
  if (typeof run.workspace !== 'string' || !isAbsolute(run.workspace) || resolve(run.workspace) !== run.workspace) {
    throw new Error('run workspace must be absolute and normalized')
  }
  return run.workspace
}

/**
 * Returns the persisted binding that already owns this thread, principal and daemon
 * server, or null when this thread is still unbound. A row that does not describe
 * this exact run mapping is a mismatch, not something to overwrite.
 */
async function resolveExisting(
  bindings: WakeBinding[], threadId: string, serverIdentity: string, principal: string,
  runWorkspace: string, physicalCwd: string,
): Promise<WakeBinding | null> {
  const owned = bindings.filter(binding => binding.threadId === threadId && binding.serverIdentity === serverIdentity)
  if (owned.length === 0) return null
  if (owned.length > 1) throw new Error('multiple persisted bindings own this thread')
  const existing = owned[0]!
  if (existing.principal !== principal) throw new Error('thread is already bound to a different principal')
  // The outbox authorizes watches by exact `relayWorkspace ?? workspace` text, so a
  // mismatched effective workspace can never be repaired without a new binding id.
  if (resolve(existing.relayWorkspace ?? existing.workspace) !== runWorkspace) {
    throw new Error('existing thread binding does not map this run workspace')
  }
  const physicalExisting = await realpath(existing.workspace).catch(() => null)
  if (physicalExisting === null || physicalExisting !== physicalCwd) {
    throw new Error('existing thread binding workspace does not match the daemon cwd')
  }
  // Keep the existing row exactly as persisted: expired and disabled holds stay untouched.
  return existing
}

/**
 * Mirrors the outbox's read-only mapped-run constraint before an immutable row
 * exists. A run that cannot satisfy it is rejected before any binding is created.
 */
async function validateMappedRun(workspace: string, sourceRoot: string, run: WakeRunSnapshot): Promise<void> {
  if (run.permissionPreset !== 'read-only') throw new Error('mapped auto-bound runs must use read-only permission')
  const scope = run.taskScope
  if (!scope || !scope.reviewTargets.length || !scope.contextReadScope.length || scope.writeScope.length !== 0
    || scope.enforcement !== 'instruction-only') throw new Error('mapped auto-bound run requires a complete read-only taskScope')
  const [physicalSourceRoot, physicalTargetRoot] = await Promise.all([
    realpath(sourceRoot).catch(() => { throw new Error('mapped Relay workspace is physically unavailable') }),
    realpath(workspace).catch(() => { throw new Error('mapped binding workspace is physically unavailable') }),
  ])
  const normalize = async (entries: string[], field: string): Promise<string[]> => Promise.all(entries.map(async entry => {
    if (!entry || entry.trim() !== entry || entry.includes('\0')) throw new Error(`invalid mapped ${field} path`)
    const absolute = resolve(sourceRoot, entry)
    const local = relative(sourceRoot, absolute)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`mapped ${field} escapes Relay workspace`)
    const canonical = local === '' ? '.' : local.replaceAll('\\', '/')
    if (entry !== canonical) throw new Error(`mapped ${field} must be normalized`)
    let physicalPath: string
    try { physicalPath = await realpath(absolute) }
    catch { throw new Error(`mapped ${field} path is physically unavailable`) }
    if (!containsPhysicalPath(physicalSourceRoot, physicalPath)) throw new Error(`mapped ${field} escapes Relay workspace through a symlink`)
    if (!containsPhysicalPath(physicalTargetRoot, physicalPath)) throw new Error(`mapped ${field} escapes binding workspace through a symlink`)
    return canonical
  }))
  const targets = await normalize(scope.reviewTargets, 'reviewTargets')
  const reads = await normalize(scope.contextReadScope, 'contextReadScope')
  const excluded = await normalize(scope.excludedPaths, 'excludedPaths')
  if (targets.some(target => !reads.some(context => contains(context, target)) || excluded.some(path => contains(path, target)))) {
    throw new Error('mapped reviewTargets must be readable and not excluded')
  }
}

function containsPhysicalPath(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function contains(parent: string, child: string): boolean {
  return parent === '.' || parent === child || child.startsWith(`${parent}/`)
}
