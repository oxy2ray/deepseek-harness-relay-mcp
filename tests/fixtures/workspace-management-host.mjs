// Native DSH Host fixture: create a private registered Workspace and two blank Sessions without starting a model task.
import { writeFile } from 'node:fs/promises'
import { dirname, relative, isAbsolute, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export default class WorkspaceManagementHostFixture extends Service {
  static Config = Schema.object({
    workspacePath: Schema.string(),
    evidencePath: Schema.string(),
  })

  static inject = ['workspaceController', 'sessionController']

  constructor(ctx, config) {
    super(ctx)
    this.workspacePath = config.workspacePath
    this.evidencePath = config.evidencePath
  }

  async *[Service.init]() {
    const dshHome = process.env.DSH_HOME
    if (!dshHome || !isAbsolute(dshHome)) throw new Error('private DSH_HOME is required for workspace management fixture')
    const [privateHome, workspacePath, evidenceParent] = await Promise.all([
      realpath(dshHome), realpath(this.workspacePath), realpath(dirname(this.evidencePath)),
    ])
    const candidateRoot = await realpath(dirname(privateHome))
    if (!contains(privateHome, evidenceParent) || !contains(candidateRoot, workspacePath)) {
      throw new Error('workspace management fixture paths must remain under the private candidate Host')
    }

    const registration = await this.ctx.workspaceController.create({ path: workspacePath })
    const archiveSession = await this.ctx.sessionController.create({ workspaceId: registration.workspace.workspaceId })
    const untouchedSession = await this.ctx.sessionController.create({ workspaceId: registration.workspace.workspaceId })
    if (archiveSession.sessionId === untouchedSession.sessionId) throw new Error('native Session controller reused a fixture identity')

    const listed = await this.ctx.sessionController.list({}, new AbortController().signal)
    const archiveRow = listed.items.find(item => item.sessionId === archiveSession.sessionId)
    const untouchedRow = listed.items.find(item => item.sessionId === untouchedSession.sessionId)
    for (const row of [archiveRow, untouchedRow]) {
      if (row === undefined || row.running || !row.blank) throw new Error('native Session fixture must be blank and idle')
      if (row.cwd !== undefined && row.cwd !== workspacePath) throw new Error('native Session fixture belongs to a different directory')
    }

    const evidence = {
      schemaVersion: 1,
      workspace: {
        workspaceId: registration.workspace.workspaceId,
        path: registration.workspace.path,
        created: registration.created,
      },
      archiveSessionId: archiveSession.sessionId,
      untouchedSessionId: untouchedSession.sessionId,
      sessionsVerifiedBlankAndIdle: true,
      modelTaskSubmitted: false,
      credentialsCopied: false,
    }
    await writeFile(this.evidencePath, `${JSON.stringify(evidence)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  }
}

function contains(parent, candidate) {
  const suffix = relative(parent, candidate)
  return suffix === '' || (!isAbsolute(suffix) && suffix.split(sep)[0] !== '..')
}
