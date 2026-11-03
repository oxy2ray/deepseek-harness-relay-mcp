import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

const absolute = z.string().refine(isAbsolute, 'absolute path required')
const identifier = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
/** One week: the default lifetime of an auto-discovered thread binding. */
export const DEFAULT_AUTO_BIND_TTL_MS = 604_800_000
const schema = z.object({
  schemaVersion: z.literal(1), socket: absolute, wakeState: absolute,
  relayDescriptor: absolute, principal: identifier, enabled: z.boolean(),
  bindings: z.array(z.object({
    bindingId: identifier, threadId: z.uuid(), workspace: absolute,
    relayWorkspace: absolute.optional(), expiresAt: z.number().int().positive(),
  }).strict()).max(100),
  // Optional operator opt-in: deliver later pending events into one still in-progress
  // automatic turn instead of waiting for it to end. Absence/false keeps the idle-only path.
  continueAutomaticTurns: z.boolean().optional(),
  // Optional opt-in for auto-binding newly opened conversations. Its absence keeps
  // the file strictly static: only the explicit `bindings` list is ever attached.
  autoBind: z.object({
    workspaceRoots: z.array(absolute).min(1).max(100),
    ttlMs: z.number().int().positive().default(DEFAULT_AUTO_BIND_TTL_MS),
  }).strict().optional(),
}).strict()
export type ExistingWakeConfig = z.infer<typeof schema>

/** Operator opt-in: static bindings by default; autoBind permits host-metadata enrollment in its roots. */
export function existingWakeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_RELAY_WAKE_CONFIG ?? join(homedir(), '.local/state/dsh-relay-wake/existing-daemon.json')
}
export async function readExistingWakeConfig(path: string): Promise<ExistingWakeConfig | null> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  return schema.parse(JSON.parse(text))
}
