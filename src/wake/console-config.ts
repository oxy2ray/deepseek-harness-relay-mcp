import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { readEndpointDescriptor } from '../stdio-proxy/index.js'

const absolute = z.string().refine(isAbsolute, 'absolute path required')
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const mcpServerName = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const schema = z.object({
  testRoot: absolute, codexState: absolute, workspace: absolute, relayWorkspace: absolute.optional(), wakeState: absolute,
  codexExecutable: absolute.optional(),
  disabledMcpServers: z.array(mcpServerName).max(64).default([])
    .refine(names => new Set(names).size === names.length, 'disabledMcpServers must not contain duplicates')
    .refine(names => !names.includes('harness_relay'), 'harness_relay is reserved for the configured wake proxy'),
  principal: id, bindingId: id,
  codexMode: z.enum(['private-state', 'current-runtime']).default('private-state'),
  relayDescriptor: absolute.optional(), relayAuthorityId: id.optional(),
  relayMode: z.enum(['isolated', 'existing-authorized']).default('isolated'),
  network: z.enum(['isolated', 'model-access']).default('isolated'),
  enabled: z.boolean().default(false),
}).strict()
export type ConsoleConfig = Omit<z.infer<typeof schema>, 'relayWorkspace'> & { relayWorkspace: string }
export interface ConsoleRelayMcpServer {
  command: string
  args: string[]
  startup_timeout_sec: number
  required: boolean
}

/** Build only explicit per-thread disables and this console's reserved native Relay server. */
export function createConsoleMcpConfig(disabledMcpServers: readonly string[], relay?: ConsoleRelayMcpServer): Record<string, unknown> {
  const servers: Record<string, unknown> = Object.fromEntries(disabledMcpServers.map(name => [name, { enabled: false }]))
  if (relay) servers.harness_relay = relay
  return Object.keys(servers).length ? { mcp_servers: servers } : {}
}

export async function readConsoleConfig(path: string): Promise<ConsoleConfig> {
  const config = schema.parse(JSON.parse(await readFile(path, 'utf8')))
  const root = await realpath(config.testRoot)
  if (root !== config.testRoot) throw new Error('testRoot must be a canonical absolute directory')
  if (root === '/' || root === homedir() || contained(resolve(homedir(), '.codex'), root) || contained(resolve(homedir(), '.dsh'), root)) throw new Error('dedicated test root required')
  if (resolve(config.wakeState) !== config.wakeState) throw new Error('wakeState must be an absolute normalized path')
  for (const value of [config.codexState, config.workspace, dirname(config.wakeState)]) {
    const canonical = await realpath(value)
    if (canonical !== value || !(await stat(canonical)).isDirectory()) throw new Error('test directories must be canonical absolute directories')
    if (!contained(root, canonical)) throw new Error('test path escapes isolated root')
  }
  const workspace = await realpath(config.workspace)
  if (workspace !== config.workspace) throw new Error('workspace must be a canonical absolute directory')
  const relayWorkspace = config.relayWorkspace === undefined ? config.workspace : config.relayWorkspace
  if (config.codexExecutable !== undefined) {
    const canonicalExecutable = await realpath(config.codexExecutable)
    if (canonicalExecutable !== config.codexExecutable || !(await stat(canonicalExecutable)).isFile()) {
      throw new Error('codexExecutable must be an existing canonical absolute file')
    }
  }
  if (config.relayWorkspace !== undefined) {
    const canonicalRelayWorkspace = await realpath(config.relayWorkspace)
    if (canonicalRelayWorkspace !== config.relayWorkspace || !(await stat(canonicalRelayWorkspace)).isDirectory()) {
      throw new Error('relayWorkspace must be an existing canonical absolute directory')
    }
  }
  if (contained(workspace, await realpath(config.codexState)) || contained(workspace, resolve(config.wakeState))
    || config.relayDescriptor && contained(workspace, await realpath(config.relayDescriptor))) throw new Error('control and authentication state must be outside the model workspace')
  // Existing state files must not be symlinks to another authority's state.
  try {
    const canonicalWakeState = await realpath(config.wakeState)
    if (canonicalWakeState !== config.wakeState) throw new Error('wakeState must not be a symlink or noncanonical path')
    if (!contained(root, canonicalWakeState)) throw new Error('wake state escapes isolated root')
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (Boolean(config.relayDescriptor) !== Boolean(config.relayAuthorityId)) throw new Error('Relay descriptor and exact authority identity are both required')
  if (config.relayMode === 'existing-authorized' && !config.relayDescriptor) throw new Error('existing-authorized Relay mode requires an exact descriptor and authority identity')
  if (config.relayMode === 'isolated' && config.relayDescriptor) {
    const canonicalDescriptor = await realpath(config.relayDescriptor)
    if (!contained(root, canonicalDescriptor)) throw new Error('test path escapes isolated root')
  }
  if (config.relayDescriptor) {
    const descriptor = await readEndpointDescriptor(config.relayDescriptor)
    const existingAuthorized = config.relayMode === 'existing-authorized'
    const tokenPath = await realpath(descriptor.tokenFilePath)
    if (descriptor.authorityId !== config.relayAuthorityId
      || !existingAuthorized && (new URL(descriptor.mcpUrl).port === '3080' || !contained(root, tokenPath))) {
      throw new Error('independent test Relay authority required')
    }
    if (contained(workspace, await realpath(config.relayDescriptor)) || contained(workspace, tokenPath)) {
      throw new Error('Relay descriptor and authentication state must be outside the model workspace')
    }
  }
  return { ...config, relayWorkspace }
}

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix.split(sep)[0] !== '..' && !isAbsolute(suffix)
}
