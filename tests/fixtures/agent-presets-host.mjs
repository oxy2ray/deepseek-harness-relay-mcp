// Private native Host fixture for agent-preset roster and selection verification.
// It only registers empty metadata-only presets and creates one blank Session.
import { readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

const PRESET_ID = 'relay-fixture-preset'

export default class AgentPresetsHostFixture extends Service {
  static Config = Schema.object({
    workspacePath: Schema.string(),
    evidencePath: Schema.string(),
    controlPath: Schema.string(),
  })

  static inject = ['workspaceController', 'sessionController', 'agentPresets']

  constructor(ctx, config) {
    super(ctx)
    this.workspacePath = config.workspacePath
    this.evidencePath = config.evidencePath
    this.controlPath = config.controlPath
  }

  async *[Service.init]() {
    let stopped = false
    let timer
    const run = async () => {
      try {
        this.stage = 'waiting-for-loader'
        await this.ctx.loader.await()
        if (stopped) return
        await this.runFixture(() => stopped)
      } catch (error) {
        try {
          await this.writeEvidence({
            schemaVersion: 1,
            phase: 'error',
            stage: this.stage ?? 'unknown',
            errorType: error instanceof Error ? error.name : 'Error',
            modelTaskSubmitted: false,
            credentialsCopied: false,
          })
        } catch {}
        this.ctx.logger?.error?.(`agent preset fixture failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // register() performs an activation diagnostic that waits for the complete
    // Cordis loader tree. One event-loop turn can still race this entry's own
    // initialization, so wait for the owning Loader's tasks to settle first.
    timer = setImmediate(run)
    yield () => {
      stopped = true
      if (timer !== undefined) clearImmediate(timer)
      void this.unregisterPreset?.()
    }
  }

  async runFixture(isStopped) {
    const dshHome = process.env.DSH_HOME
    if (!dshHome || !isAbsolute(dshHome)) throw new Error('private DSH_HOME is required')
    const [privateHome, candidateRoot, workspacePath, evidenceParent, controlParent] = await Promise.all([
      realpath(dshHome), realpath(dirname(dshHome)), realpath(this.workspacePath),
      realpath(dirname(this.evidencePath)), realpath(dirname(this.controlPath)),
    ])
    if (!contains(privateHome, evidenceParent) || !contains(privateHome, controlParent)
      || !contains(candidateRoot, workspacePath)) {
      throw new Error('fixture paths must remain inside the private candidate Host')
    }

    this.stage = 'creating-workspace'
    const registration = await this.ctx.workspaceController.create({ path: workspacePath })
    let definition = { id: PRESET_ID, name: 'Fixture name 1', description: 'Fixture desc 1', plugins: [] }
    this.stage = 'registering-first-preset'
    let disposePreset = await this.ctx.agentPresets.register(definition)
    this.unregisterPreset = disposePreset
    this.stage = 'creating-session'
    const created = await this.ctx.sessionController.create({
      workspaceId: registration.workspace.workspaceId,
      agentPreset: PRESET_ID,
    })
    if (created.agentPreset !== PRESET_ID) throw new Error('native Session did not retain the requested preset')
    this.stage = 'checking-session'
    const listed = await this.ctx.sessionController.list({}, new AbortController().signal)
    const session = listed.items.find(item => item.sessionId === created.sessionId)
    const selectedPreset = session?.projections?.values?.agentPreset ?? session?.agentPreset
    if (!session || session.running || !session.blank || selectedPreset !== PRESET_ID) {
      throw new Error('native Session must be blank, idle, and assigned to the fixture preset')
    }

    this.stage = 'reading-first-native-roster'
    const nativeRoster = await this.ctx.agentPresets.remoteExportList()
    this.stage = 'writing-first-evidence'
    await this.writeEvidence({
      schemaVersion: 1,
      phase: 1,
      workspace: { workspaceId: registration.workspace.workspaceId, path: registration.workspace.path },
      sessionId: created.sessionId,
      selectedAgentPreset: selectedPreset,
      registeredPreset: definition,
      nativeRoster,
      sessionVerifiedBlankAndIdle: true,
      modelTaskSubmitted: false,
      credentialsCopied: false,
    })

    this.stage = 'waiting-for-control'
    while (!isStopped()) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (isStopped()) return
      let control
      try {
        control = JSON.parse(await readFile(this.controlPath, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) continue
        throw error
      }
      if (!isExactPhaseTwo(control)) continue

      this.stage = 'disposing-first-preset'
      await disposePreset()
      this.unregisterPreset = undefined
      definition = { id: PRESET_ID, name: 'Fixture name 2', description: 'Fixture desc 2', plugins: [] }
      this.stage = 'registering-second-preset'
      disposePreset = await this.ctx.agentPresets.register(definition)
      this.unregisterPreset = disposePreset
      this.stage = 'reading-second-native-roster'
      const secondNativeRoster = await this.ctx.agentPresets.remoteExportList()
      this.stage = 'writing-second-evidence'
      await this.writeEvidence({
        schemaVersion: 1,
        phase: 2,
        workspace: { workspaceId: registration.workspace.workspaceId, path: registration.workspace.path },
        sessionId: created.sessionId,
        selectedAgentPreset: selectedPreset,
        registeredPreset: definition,
        nativeRoster: secondNativeRoster,
        sessionVerifiedBlankAndIdle: true,
        modelTaskSubmitted: false,
        credentialsCopied: false,
      })
      return
    }
  }

  async writeEvidence(evidence) {
    const tempPath = `${this.evidencePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, `${JSON.stringify(evidence)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(tempPath, this.evidencePath)
  }
}

function isExactPhaseTwo(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && value.phase === 2
}

function contains(parent, candidate) {
  const suffix = relative(parent, candidate)
  return suffix === '' || (!isAbsolute(suffix) && suffix.split(sep)[0] !== '..')
}
