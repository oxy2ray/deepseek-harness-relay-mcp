import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

const absolute = z.string().refine(isAbsolute, 'absolute path required')
const identifier = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const schema = z.object({
  schemaVersion: z.literal(1), socket: absolute, wakeState: absolute,
  relayDescriptor: absolute, principal: identifier, enabled: z.boolean(),
  bindings: z.array(z.object({
    bindingId: identifier, threadId: z.uuid(), workspace: absolute,
    relayWorkspace: absolute.optional(), expiresAt: z.number().int().positive(),
  }).strict()).max(100),
}).strict()
export type ExistingWakeConfig = z.infer<typeof schema>

/** Presence of this operator-created file is the opt-in. No thread discovery or implicit binding. */
export function existingWakeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_RELAY_WAKE_CONFIG ?? join(homedir(), '.local/state/dsh-relay-wake/existing-daemon.json')
}
export async function readExistingWakeConfig(path: string): Promise<ExistingWakeConfig | null> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  return schema.parse(JSON.parse(text))
}
