import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'

const FIXTURE_WORKSPACE = '/home/zer0in/deepseek-harness-relay-mcp/.runtime/current-service-delegation-oct30/workspace'
const PRODUCTION_EVIDENCE = '/home/zer0in/deepseek-harness-relay-mcp/.runtime/current-service-delegation-oct30/control/workspace-registration.json'
const ISOLATED_SMOKE_EVIDENCE = '/home/zer0in/deepseek-harness-relay-mcp/.runtime/current-service-delegation-oct30/control/isolated-host-smoke/workspace-registration.json'

export const name = 'wake-fixture-workspace-registration'
export const inject = ['workspaceController']

/**
 * One-purpose DSH Host startup plugin: register the named fixture workspace
 * through the official Workspace Controller service and save rollback metadata.
 * The plug-in is idempotent across ordinary starts and configuration reloads.
 */
export async function apply(ctx, config) {
  const workspacePath = await validateConfiguredPath(config?.workspacePath)
  const evidencePath = validateEvidencePath(config?.evidencePath)
  const controller = ctx.workspaceController
  if (!controller || typeof controller.follow !== 'function' || typeof controller.create !== 'function') {
    throw new Error('wake workspace registration requires the official workspaceController service')
  }

  const before = await listWorkspaces(controller)
  const priorEvidence = await readEvidenceIfPresent(evidencePath, workspacePath)
  const existing = before.find((workspace) => workspace.path === workspacePath)
  const result = await controller.create({ path: workspacePath })
  const workspace = result?.workspace
  if (!workspace || typeof workspace.workspaceId !== 'string' || typeof result.created !== 'boolean') {
    throw new Error('official workspaceController.create returned an invalid workspace result')
  }
  const after = await listWorkspaces(controller)
  const beforeIds = new Set(before.map((row) => row.workspaceId))
  const afterIds = new Set(after.map((row) => row.workspaceId))
  const addedIds = [...afterIds].filter((id) => !beforeIds.has(id))
  const removedIds = [...beforeIds].filter((id) => !afterIds.has(id))
  if (removedIds.length !== 0 || addedIds.length > 1 || !afterIds.has(workspace.workspaceId)) {
    throw new Error('workspace registry changed outside the single requested registration')
  }
  const registered = after.find((row) => row.workspaceId === workspace.workspaceId)
  if (!registered || registered.path !== workspacePath) {
    throw new Error('workspace registry did not preserve the requested canonical path')
  }
  for (const previous of before) {
    const current = after.find((row) => row.workspaceId === previous.workspaceId)
    if (!current || current.path !== previous.path || current.title !== previous.title
      || current.sessionIds.length !== previous.sessionIds.length
      || current.sessionIds.some((id, index) => id !== previous.sessionIds[index])) {
      throw new Error('workspace registration changed an existing workspace or session membership')
    }
  }
  if (priorEvidence && priorEvidence.workspaceId !== workspace.workspaceId) {
    throw new Error('workspace registration evidence no longer matches the fixture workspace identity')
  }

  const created = priorEvidence?.created ?? result.created
  const preexistingIds = priorEvidence?.preexistingWorkspaceIds ?? before.map((row) => row.workspaceId)
  const evidence = {
    schemaVersion: 1,
    workspacePath,
    workspaceId: workspace.workspaceId,
    created,
    preexistingWorkspaceIds: preexistingIds,
    registeredAt: priorEvidence?.registeredAt ?? new Date().toISOString(),
    rollback: created
      ? `After confirming workspaceController.follow has a baseline row with workspaceId ${workspace.workspaceId} and path ${workspacePath}, call await ctx.workspaceController.delete({ workspaceId: '${workspace.workspaceId}' }). This removes the registration only; it leaves the directory and sessions intact.`
      : 'No rollback: this workspace was already registered before this helper ran.',
  }
  await persistEvidence(evidencePath, evidence)
}

async function listWorkspaces(controller) {
  const abort = new AbortController()
  const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || first.value?.type !== 'baseline' || !Array.isArray(first.value.value?.items)) {
      throw new Error('official workspaceController.follow did not begin with a workspace baseline')
    }
    return first.value.value.items
  } finally {
    abort.abort()
    await iterator.return?.()
  }
}

export default { name, inject, apply }

async function validateConfiguredPath(value) {
  if (value !== FIXTURE_WORKSPACE || resolve(value) !== FIXTURE_WORKSPACE) {
    throw new Error('workspace registration helper only permits its fixed fixture directory')
  }
  const canonical = await realpath(value)
  if (canonical !== FIXTURE_WORKSPACE) {
    throw new Error('fixture workspace path must resolve to its exact configured canonical path')
  }
  return canonical
}

function validateEvidencePath(value) {
  if (value !== PRODUCTION_EVIDENCE && value !== ISOLATED_SMOKE_EVIDENCE) {
    throw new Error('workspace registration helper requires one of its fixed private evidence paths')
  }
  return value
}

async function readEvidenceIfPresent(path, workspacePath) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value.schemaVersion !== 1 || value.workspacePath !== workspacePath
      || typeof value.workspaceId !== 'string' || typeof value.created !== 'boolean'
      || !Array.isArray(value.preexistingWorkspaceIds)
      || !value.preexistingWorkspaceIds.every((id) => typeof id === 'string')) {
      throw new Error('existing workspace registration evidence is invalid')
    }
    return value
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function persistEvidence(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}
