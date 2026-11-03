import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const DSH_PACKAGE = '/home/zer0in/.local/share/dsh-purge/hosts/fa44c1bff65c2601a67f/dsh/package.json'
const WORKSPACE_PATH = '/home/zer0in/deepseek-harness-relay-mcp/.runtime/current-service-delegation-oct30/workspace'
const EVIDENCE_PATH = '/home/zer0in/deepseek-harness-relay-mcp/.runtime/current-service-delegation-oct30/control/workspace-registration.json'
const FAILURE_PATH = '/home/zer0in/deepseek-harness-relay-mcp/.runtime/current-service-delegation-oct30/control/workspace-registration-failure.json'
const CONTROLLER_READY_TIMEOUT_MS = 30_000

const requireFromDsh = createRequire(DSH_PACKAGE)
const profileBootUrl = pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh/profile-boot'))
const appBootUrl = pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-app-boot'))
const [{ runProfile }, { loadLayeredEnv }] = await Promise.all([
  import(profileBootUrl.href),
  import(appBootUrl.href),
])
const registrationPluginUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'wake-register-workspace-plugin.mjs'))
const { apply: registerFixtureWorkspace } = await import(registrationPluginUrl.href)

/**
 * Start the official DSH Web profile and register its one authorized fixture
 * through the returned Host's official Workspace Controller service.
 */
export async function runCurrentHost() {
  let stage = 'environment'
  try {
    const environment = loadLayeredEnv('dsh', process.cwd(), () => {})
    stage = 'profile-boot'
    const { ctx } = await withMutedStartupOutput(() => runProfile({
      environment,
      profile: 'web',
      patchFiles: [],
      args: ['--host', '127.0.0.1', '--port', '3080', '--no-open'],
    }))

    stage = 'workspace-controller-readiness'
    const controller = await waitForWorkspaceController(ctx)
    stage = 'fixture-workspace-registration'
    await registerFixtureWorkspace({ workspaceController: controller }, {
      workspacePath: WORKSPACE_PATH,
      evidencePath: EVIDENCE_PATH,
    })
    await removeFailureEvidence()
    process.stdout.write('wake_host_registration=complete\n')
  } catch {
    const category = stage === 'workspace-controller-readiness'
      ? 'workspace-controller-not-ready'
      : stage === 'fixture-workspace-registration'
        ? 'fixture-registration-failed'
        : stage === 'profile-boot'
          ? 'profile-boot-failed'
          : 'environment-load-failed'
    await persistFailure(stage, category)
    process.stderr.write(`wake_host_registration=${category}\n`)
    // The root Host and its HTTP listener stay running when registration fails.
    // The caller owns any later recovery or shutdown decision.
  }
}

async function waitForWorkspaceController(ctx) {
  const deadline = Date.now() + CONTROLLER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const controller = ctx.get('workspaceController')
    if (controller && typeof controller.follow === 'function' && typeof controller.create === 'function') {
      return controller
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('workspaceController readiness timeout')
}

async function withMutedStartupOutput(start) {
  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write
  process.stdout.write = () => true
  process.stderr.write = () => true
  try {
    return await start()
  } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
  }
}

async function persistFailure(stage, category) {
  try {
    await mkdir(dirname(FAILURE_PATH), { recursive: true, mode: 0o700 })
    await writeFile(FAILURE_PATH, `${JSON.stringify({
      schemaVersion: 1,
      status: 'failed',
      stage,
      category,
      at: new Date().toISOString(),
      workspacePath: WORKSPACE_PATH,
    }, null, 2)}\n`, { mode: 0o600 })
  } catch {
    process.stderr.write('wake_host_registration=failure-evidence-write-failed\n')
  }
}

async function removeFailureEvidence() {
  const { unlink } = await import('node:fs/promises')
  try {
    await unlink(FAILURE_PATH)
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
  }
}

const invokedPath = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) await runCurrentHost()
