import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { EventEmitter } from 'node:events'
import { link, lstat, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJson, FileLockFacade } from '../state-repository/index.js'

export interface IsolatedCodexOptions {
  testRoot: string
  stateDirectory: string
  workspace: string
  codexMode?: 'private-state' | 'current-runtime'
  codexExecutable?: string
  network: 'isolated' | 'model-access'
}

export type CodexRequestRejectionCategory = 'workspace-routing' | 'authentication-refresh' | 'readonly-state' | 'network' | 'unsupported' | 'unknown'

export function classifyCodexNetworkFailure(message: string): { kind: 'dns' | 'timeout' | 'refused' | 'tls' | 'proxy' | 'upstream' | 'other'; host: string | null } {
  const lower = message.toLowerCase()
  const kind = /dns|name resolution|failed to lookup|no such host/u.test(lower) ? 'dns'
    : /timed? ?out|deadline exceeded/u.test(lower) ? 'timeout'
      : /connection refused|econnrefused/u.test(lower) ? 'refused'
        : /tls|certificate|handshake/u.test(lower) ? 'tls'
          : /proxy|407/u.test(lower) ? 'proxy'
            : /error sending request|upstream|http status|status code/u.test(lower) ? 'upstream' : 'other'
  const url = /https?:\/\/[^\s)\]}>,]+/iu.exec(message)?.[0]
  let host: string | null = null
  if (url) {
    try {
      const parsed = new URL(url.replace(/[.,;]+$/u, ''))
      if (!parsed.username && !parsed.password) host = parsed.host.slice(0, 255)
    } catch { /* Do not surface malformed or credential-bearing URL fragments. */ }
  }
  return { kind, host }
}

export function summarizeCodexDiagnostic(message: string): { category: CodexRequestRejectionCategory; code: string | null; httpStatus: number | null; host: string | null } | null {
  if (!/error|fail|fatal|panic|denied|refused|timeout|timed out|429|401|403/iu.test(message)) return null
  const scrubbed = message.replace(/\b(?:access[_-]?token|refresh[_-]?token|token|password|api[_-]?key)\s*[:=]\s*[^,\s]+/giu, '')
  const code = /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EACCES|EROFS|CERTIFICATE_VERIFY_FAILED)\b/iu.exec(message)?.[1]?.toUpperCase() ?? null
  const status = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:_code)?[=: ]+)([1-5]\d\d)\b/iu.exec(message)?.[1]
  let category = classifyCodexRequestRejection(scrubbed)
  if (category === 'unknown' && status && [408, 429, 500, 502, 503, 504].includes(Number(status))) category = 'network'
  const network = category === 'network' ? classifyCodexNetworkFailure(message) : undefined
  return { category, code, httpStatus: status ? Number(status) : null, host: network?.host ?? null }
}

export function classifyCodexRequestRejection(message: string): CodexRequestRejectionCategory {
  if (/auth|oauth|token|credential|refresh|account|login/iu.test(message)) return 'authentication-refresh'
  if (/read.?only|permission denied|e(rofs|acces)|sqlite|database|state file/iu.test(message)) return 'readonly-state'
  if (/network|connect|socket|proxy|dns|timed? ?out|refused|unreachable/iu.test(message)) return 'network'
  if (/workspace (?:routing|root|discovery)|(?:failed|unable) to (?:discover|resolve) (?:the )?workspace|workspace (?:outside|not found|unavailable|invalid)/iu.test(message)) return 'workspace-routing'
  if (/not supported|unsupported|unknown method/iu.test(message)) return 'unsupported'
  return 'unknown'
}

export function buildCodexEnvironment(network: 'isolated' | 'model-access', source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: source.PATH ?? '/usr/bin:/bin', LANG: source.LANG ?? 'C.UTF-8' }
  if (network === 'isolated') return environment
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    const value = source[key]
    if (!value) continue
    validateProxyUrl(value)
    environment[key] = value
  }
  const exclusions = [...(source.NO_PROXY ?? '').split(','), ...(source.no_proxy ?? '').split(','), 'localhost', '127.0.0.1', '::1', '[::1]']
    .map(item => item.trim()).filter(Boolean)
  const merged = [...new Map(exclusions.map(item => [item.toLowerCase(), item])).values()].join(',')
  environment.NO_PROXY = merged
  environment.no_proxy = merged
  return environment
}

function validateProxyUrl(value: string): void {
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol)
      || !url.hostname || url.username || url.password || url.search || url.hash
      || /[?#]/u.test(value) || (url.pathname !== '' && url.pathname !== '/')) {
      throw new Error('invalid')
    }
  } catch {
    // Never echo proxy values: they may contain credentials even when malformed.
    throw new Error('invalid model-access proxy environment URL')
  }
}

/** Private stdin is the only control connection; never attaches to a user's daemon. */
export class CodexProcess extends EventEmitter {
  private readonly pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>()
  private nextId = 0
  private buffer = ''
  private stderrBuffer = ''
  private closed = false
  private childClosed = false
  readonly serverRequests = new Map<string | number, { method: string; params: unknown }>()

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly cleanupMountpoints: () => Promise<void>) {
    super()
    child.stdout.setEncoding('utf8')
    child.stdin.on('error', () => this.disconnect())
    child.stdout.on('data', (chunk: string) => this.receive(chunk))
    // Consume stderr only to emit finite diagnostics; never retain or log raw provider/tool text.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.receiveStderr(chunk))
    child.once('error', () => this.disconnect())
    child.once('exit', () => this.disconnect())
    child.once('close', () => {
      this.childClosed = true
      this.stderrBuffer = ''
      void this.cleanupMountpoints().catch(() => this.emit('mountpointCleanupError'))
    })
  }

  static async validate(options: IsolatedCodexOptions): Promise<{ state: string; workspace: string; root: string }> {
    if (!['isolated', 'model-access'].includes(options.network)) throw new Error('explicit network policy required')
    if (!['private-state', 'current-runtime'].includes(options.codexMode ?? 'private-state')) throw new Error('explicit supported Codex runtime mode required')
    if (![options.testRoot, options.stateDirectory, options.workspace].every(isAbsolute)) throw new Error('explicit absolute isolated paths required')
    const [state, workspace, shared, root] = await Promise.all([
      realpath(options.stateDirectory), realpath(options.workspace), realpath(join(homedir(), '.codex')).catch(() => join(homedir(), '.codex')),
      realpath(options.testRoot),
    ])
    const contained = (value: string) => { const part = relative(root, value); return !isAbsolute(part) && part.split(sep)[0] !== '..' }
    if (root === '/' || root === homedir() || root === shared || !contained(state) || !contained(workspace)
      || state === shared || state.startsWith(`${shared}${sep}`) || workspace === root) throw new Error('shared or overly broad state/workspace rejected')
    if (relative(workspace, state).split(sep)[0] !== '..' && !isAbsolute(relative(workspace, state))) throw new Error('authentication state must be outside the model workspace')
    if (relative(state, workspace).split(sep)[0] !== '..' && !isAbsolute(relative(state, workspace))) throw new Error('state and workspace must be disjoint')
    return { state, workspace, root }
  }

  static async launch(options: IsolatedCodexOptions): Promise<CodexProcess> {
    const { state, workspace, root } = await this.validate(options)
    // Retain host PIDs so the native MCP proxy can verify the independent DSH owner's PID.
    const command = await buildCodexArgs(options, root, state, workspace)
    try {
      return new CodexProcess(spawn('bwrap', command.args, {
        env: buildCodexEnvironment(options.network), stdio: ['pipe', 'pipe', 'pipe'],
      }), command.cleanup)
    } catch (error) {
      await command.cleanup()
      throw error
    }
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'dsh-relay-wake-console', version: '1' }, capabilities: { experimentalApi: true } })
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
  }

  request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    if (this.closed || this.pending.size >= 64) return Promise.reject(new Error('Codex transport unavailable'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request outcome uncertain')) }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) this.disconnect()
      })
    })
  }

  answer(id: string | number, result: unknown): void {
    if (!this.serverRequests.delete(id)) throw new Error('approval/request is stale or not owned by this console')
    this.child.stdin.write(JSON.stringify({ id, result }) + '\n')
  }

  async close(): Promise<void> {
    this.disconnect()
    if (!this.childClosed && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end()
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000)
        this.child.once('close', () => { clearTimeout(timer); resolve() })
        this.child.kill('SIGTERM')
      })
    }
    await this.cleanupMountpoints()
  }

  private disconnect(): void {
    if (this.closed) return
    this.closed = true
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Codex connection lost; outcome uncertain')) }
    this.pending.clear()
    this.serverRequests.clear()
    this.emit('disconnected')
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) { void this.close(); return }
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let message: Record<string, unknown>
      try { message = JSON.parse(line) as Record<string, unknown> } catch { continue }
      const request = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
      if (request && ('result' in message || 'error' in message)) {
        this.pending.delete(message.id as number)
        clearTimeout(request.timer)
        if ('error' in message) {
          const error = message.error as { code?: unknown; message?: unknown }
          const errorMessage = typeof error?.message === 'string' ? error.message : ''
          const rejectionCategory = classifyCodexRequestRejection(errorMessage)
          const networkFailure = rejectionCategory === 'network' ? classifyCodexNetworkFailure(errorMessage) : undefined
          const code = typeof error?.code === 'number' && Number.isSafeInteger(error.code) ? error.code : null
          this.emit('requestRejected', { method: request.method, code, category: rejectionCategory, ...(networkFailure ? { networkFailure } : {}) })
          const category = /not materialized|no rollout/iu.test(errorMessage) ? 'history-not-materialized'
            : rejectionCategory === 'unsupported' ? 'unsupported' : 'rejected'
          request.reject(new Error(`Codex request ${category}; code=${typeof error?.code === 'number' ? error.code : 'unknown'}`))
        }
        else request.resolve(message.result)
      } else if (typeof message.method === 'string') {
        if (typeof message.id === 'string' || typeof message.id === 'number') {
          if (this.serverRequests.size >= 128) { void this.close(); return }
          this.serverRequests.set(message.id, { method: message.method, params: message.params })
          this.emit('serverRequest', { id: message.id, method: message.method, params: message.params })
        } else this.emit('notification', { method: message.method, params: message.params })
      }
    }
  }

  private receiveStderr(chunk: string): void {
    this.stderrBuffer += chunk
    if (Buffer.byteLength(this.stderrBuffer) > 64 * 1024) this.stderrBuffer = this.stderrBuffer.slice(-32 * 1024)
    let end: number
    while ((end = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, end)
      this.stderrBuffer = this.stderrBuffer.slice(end + 1)
      const diagnostic = summarizeCodexDiagnostic(line)
      if (diagnostic) this.emit('stderrDiagnostic', diagnostic)
    }
  }
}

/** Build an isolated App Server command. Current-runtime auth files are read-only overlays inside this child's namespace. */
export async function buildCodexArgs(
  options: IsolatedCodexOptions,
  root: string,
  state: string,
  workspace: string,
  currentCodexDirectory = join(homedir(), '.codex'),
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const mode = options.codexMode ?? 'private-state'
  if (!['private-state', 'current-runtime'].includes(mode)) throw new Error('explicit supported Codex runtime mode required')
  const codexDirectory = join(homedir(), '.codex')
  let runtimeMount: string | undefined
  let runtimeExecutable: string | undefined
  if (options.codexExecutable !== undefined) {
    if (!isAbsolute(options.codexExecutable)) throw new Error('Codex executable must be an absolute canonical path')
    const executable = await realpath(options.codexExecutable)
    const executableInfo = await stat(executable)
    const releaseDirectory = join(executable, '..', '..')
    const release = await realpath(releaseDirectory)
    if (executable !== options.codexExecutable || !executableInfo.isFile() || !(executableInfo.mode & 0o111)
      || relative(release, executable) !== join('bin', 'codex') || !(await stat(join(release, 'codex-resources')).catch(() => null))
      || !release.includes(`${sep}.codex${sep}packages${sep}app-server-daemon${sep}releases${sep}`)) {
      throw new Error('Codex executable must be an installed canonical App Server release binary')
    }
    runtimeMount = await mkdtemp(join(root, '.relay-wake-codex-runtime-'))
    runtimeExecutable = join(runtimeMount, 'bin', 'codex')
  }
  const args = ['--unshare-user', '--new-session', '--die-with-parent',
    ...(options.network === 'isolated' ? ['--unshare-net'] : []),
    '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', root, root,
    '--bind', state, codexDirectory]
  if (runtimeMount) args.push('--ro-bind', join(options.codexExecutable!, '..', '..'), runtimeMount)
  let cleanup = async () => {}
  if (mode === 'current-runtime') {
    const overlays = await readonlyCurrentRuntimeFileMounts(state, currentCodexDirectory)
    args.push(...overlays.args)
    cleanup = overlays.cleanup
  }
  args.push('--bind', workspace, workspace,
    '--proc', '/proc', '--dev', '/dev', '--chdir', workspace, '--',
    runtimeExecutable ?? 'codex', '-c', 'cli_auth_credentials_store="file"', 'app-server', '--listen', 'stdio://')
  return { args, cleanup: async () => {
    await cleanup()
    if (runtimeMount) await rm(runtimeMount, { recursive: true, force: true })
  } }
}

type MountpointName = 'config.toml' | 'auth.json'
type MountpointIdentity = { name: MountpointName; dev: number; ino: number }
type MountpointOwner = { ownerToken: string; processId: number; processStartedAt: string | null }
type MountpointManifest = { schemaVersion: 1; owner: MountpointOwner; entries: MountpointIdentity[] }
type MountpointManifestSnapshot = { manifest: MountpointManifest; dev: number; ino: number; text: string }

const mountpointManifestName = '.relay-wake-current-runtime-mountpoints.json'
const mountpointNames = new Set<MountpointName>(['config.toml', 'auth.json'])

async function readonlyCurrentRuntimeFileMounts(state: string, sourceDirectory: string): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const owner = await currentRuntimeOwner(state)
  const manifestPath = join(state, mountpointManifestName)
  const previous = await readMountpointManifest(manifestPath)
  const owned: MountpointIdentity[] = []
  const blocked = new Set<MountpointName>()
  let reusedCurrentOwner = false

  if (previous) {
    if (previous.manifest.owner.ownerToken === owner.ownerToken) {
      reusedCurrentOwner = true
      for (const entry of previous.manifest.entries) {
        if (!await hasExactEmptyMountpoint(join(state, entry.name), entry)) throw new Error('current-runtime mountpoint ownership is ambiguous')
        owned.push(entry)
      }
    } else {
      // The caller holds the exclusive live owner lease. A different recorded token
      // therefore belongs to a released or proven-dead owner and cannot race cleanup.
      for (const entry of previous.manifest.entries) {
        const outcome = await removeExactEmptyFile(join(state, entry.name), entry)
        if (outcome === 'mismatch') blocked.add(entry.name)
      }
      await removeManifestSnapshot(manifestPath, previous)
    }
  }

  const mounts: string[] = []
  const created: MountpointIdentity[] = []
  try { for (const name of ['config.toml', 'auth.json']) {
    const mountName = name as MountpointName
    if (blocked.has(mountName)) continue
    let source: string
    try { source = await realpath(join(sourceDirectory, name)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!(await stat(source)).isFile()) continue
    const mountpoint = join(state, name)
    if (reusedCurrentOwner) {
      if (owned.some(entry => entry.name === mountName)) mounts.push('--ro-bind', source, join(join(homedir(), '.codex'), name))
      continue
    }
    let handle
    try { handle = await open(mountpoint, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      const identity = await handle.stat()
      created.push({ name: mountName, dev: identity.dev, ino: identity.ino })
    } finally { await handle.close() }
    mounts.push('--ro-bind', source, join(join(homedir(), '.codex'), name))
  } } catch (error) {
    await cleanupOwnedMountpoints(state, created)
    throw error
  }

  const entries = reusedCurrentOwner ? owned : created
  if (!reusedCurrentOwner && entries.length > 0) {
    try {
      await atomicWriteJson(manifestPath, { schemaVersion: 1, owner, entries } satisfies MountpointManifest)
    } catch (error) {
      // If promotion succeeded but its directory sync failed, leave the marker
      // in place so the next serialized owner can recover its exact identities.
      await cleanupOwnedMountpoints(state, created).catch(() => undefined)
      throw error
    }
  }

  let cleanupPromise: Promise<void> | undefined
  const cleanup = () => cleanupPromise ??= (async () => {
    await cleanupOwnedMountpoints(state, entries)
    if (entries.length > 0) {
      const current = await readMountpointManifest(manifestPath)
      if (current?.manifest.owner.ownerToken === owner.ownerToken) await removeManifestSnapshot(manifestPath, current)
    }
  })().catch(error => {
    cleanupPromise = undefined
    throw error
  })
  return { args: mounts, cleanup }
}

async function currentRuntimeOwner(state: string): Promise<MountpointOwner> {
  try {
    const inspection = await new FileLockFacade().inspect(join(state, 'relay-wake-owner.lock'))
    const record = inspection.record
    if (!inspection.present || !inspection.valid || inspection.ownerState !== 'alive' || record === null || record.processId !== process.pid) {
      throw new Error('current-runtime owner lease required')
    }
    return { ownerToken: record.ownerToken, processId: record.processId, processStartedAt: record.processStartedAt }
  } catch {
    throw new Error('current-runtime owner lease required')
  }
}

async function readMountpointManifest(path: string): Promise<MountpointManifestSnapshot | null> {
  try {
    const initial = await lstat(path)
    if (initial.isSymbolicLink() || !initial.isFile()) throw new Error('current-runtime mountpoint manifest is invalid')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof Error && error.message.startsWith('current-runtime mountpoint manifest')) throw error
    throw new Error('current-runtime mountpoint manifest is unreadable')
  }
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('current-runtime mountpoint manifest is unreadable')
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) throw new Error('current-runtime mountpoint manifest is invalid')
    const text = await handle.readFile({ encoding: 'utf8' })
    const after = await lstat(path)
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino) throw new Error('current-runtime mountpoint manifest is ambiguous')
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new Error('current-runtime mountpoint manifest is malformed') }
    const manifest = parseMountpointManifest(parsed)
    return { manifest, dev: before.dev, ino: before.ino, text }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('current-runtime mountpoint manifest')) throw error
    throw new Error('current-runtime mountpoint manifest is unreadable')
  } finally { await handle.close() }
}

function parseMountpointManifest(value: unknown): MountpointManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.owner) || !Array.isArray(value.entries)
    || Object.keys(value).some(key => !['schemaVersion', 'owner', 'entries'].includes(key))
    || Object.keys(value.owner).some(key => !['ownerToken', 'processId', 'processStartedAt'].includes(key))) {
    throw new Error('current-runtime mountpoint manifest is malformed')
  }
  const owner = value.owner
  if (typeof owner.ownerToken !== 'string' || !/^[0-9a-f-]{36}$/iu.test(owner.ownerToken)
    || !Number.isSafeInteger(owner.processId) || (owner.processId as number) <= 0
    || !(owner.processStartedAt === null || (typeof owner.processStartedAt === 'string' && Number.isFinite(Date.parse(owner.processStartedAt))))) {
    throw new Error('current-runtime mountpoint manifest is malformed')
  }
  const seen = new Set<string>()
  const entries: MountpointIdentity[] = []
  for (const item of value.entries) {
    if (!isRecord(item) || Object.keys(item).some(key => !['name', 'dev', 'ino'].includes(key))
      || typeof item.name !== 'string' || !mountpointNames.has(item.name as MountpointName)
      || !Number.isSafeInteger(item.dev) || (item.dev as number) < 0
      || !Number.isSafeInteger(item.ino) || (item.ino as number) <= 0 || seen.has(item.name)) {
      throw new Error('current-runtime mountpoint manifest is malformed')
    }
    seen.add(item.name)
    entries.push({ name: item.name as MountpointName, dev: item.dev as number, ino: item.ino as number })
  }
  if (entries.length === 0 || entries.length > mountpointNames.size) throw new Error('current-runtime mountpoint manifest is malformed')
  return { schemaVersion: 1, owner: {
    ownerToken: owner.ownerToken, processId: owner.processId as number,
    processStartedAt: owner.processStartedAt as string | null,
  }, entries }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function hasExactEmptyMountpoint(path: string, expected: MountpointIdentity): Promise<boolean> {
  try {
    const current = await lstat(path)
    return current.isFile() && current.size === 0 && current.dev === expected.dev && current.ino === expected.ino
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function removeExactEmptyFile(path: string, expected: { dev: number; ino: number }): Promise<'removed' | 'missing' | 'mismatch'> {
  let current
  try { current = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw new Error('current-runtime mountpoint cleanup failed')
  }
  if (!current.isFile() || current.size !== 0 || current.dev !== expected.dev || current.ino !== expected.ino) return 'mismatch'

  const tombstone = `${path}.relay-wake-cleanup-${randomUUID()}`
  try { await rename(path, tombstone) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw new Error('current-runtime mountpoint cleanup failed')
  }
  let claimed
  try { claimed = await lstat(tombstone) }
  catch { await restoreTombstone(tombstone, path); throw new Error('current-runtime mountpoint cleanup failed') }
  if (!claimed.isFile() || claimed.size !== 0 || claimed.dev !== expected.dev || claimed.ino !== expected.ino) {
    await restoreTombstone(tombstone, path)
    return 'mismatch'
  }
  try { await unlink(tombstone) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('current-runtime mountpoint cleanup failed')
  }
  return 'removed'
}

async function restoreTombstone(tombstone: string, original: string): Promise<void> {
  try {
    await link(tombstone, original)
    await unlink(tombstone)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('current-runtime mountpoint cleanup failed')
  }
}

async function removeManifestSnapshot(path: string, snapshot: MountpointManifestSnapshot): Promise<void> {
  const tombstone = `${path}.cleanup-${randomUUID()}`
  try { await rename(path, tombstone) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('current-runtime mountpoint manifest changed during cleanup')
  }
  try {
    const claimed = await lstat(tombstone)
    if (claimed.isSymbolicLink() || !claimed.isFile() || claimed.dev !== snapshot.dev || claimed.ino !== snapshot.ino) {
      await restoreTombstone(tombstone, path)
      throw new Error('current-runtime mountpoint manifest changed during cleanup')
    }
    const text = await readFile(tombstone, 'utf8')
    if (text !== snapshot.text) {
      await restoreTombstone(tombstone, path)
      throw new Error('current-runtime mountpoint manifest changed during cleanup')
    }
    await unlink(tombstone)
  } catch (error) {
    if (error instanceof Error && error.message === 'current-runtime mountpoint manifest changed during cleanup') throw error
    throw new Error('current-runtime mountpoint manifest cleanup failed')
  }
}

async function cleanupOwnedMountpoints(state: string, created: MountpointIdentity[]): Promise<void> {
  let failure: unknown
  for (const entry of created) {
    await removeExactEmptyFile(join(state, entry.name), entry).catch(error => { failure ??= error })
  }
  if (failure) throw failure
}
