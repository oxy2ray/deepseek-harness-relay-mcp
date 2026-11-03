import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRoutingFacade, type SessionSummary } from '../src/session-routing/index.js'

const workspace = {
  workspaceId: 'workspace-1',
  path: 'D:\\AI\\proflow',
  sessionIds: ['latest', 'running', 'blank', 'archived', 'older'],
}

test('lists only direct workspace sessions and marks archived entries', async () => {
  const routing = new SessionRoutingFacade(client([
    summary('other', 99, { cwd: 'D:\\AI\\other' }),
    { ...summary('latest', 50), projections: { values: { title: 'must not escape' } } } as SessionSummary,
    summary('archived', 40),
    summary('subagent', 60, { origin: 'subagent' }),
  ]))

  const sessions = await routing.list(workspace, ['archived'])

  assert.deepEqual(sessions.map(session => [session.sessionId, session.archived]), [
    ['latest', false],
    ['archived', true],
  ])
  assert.equal('projections' in sessions[0]!, false)
})

test('latest-idle reuses the newest nonblank idle unarchived session', async () => {
  let creates = 0
  const routing = new SessionRoutingFacade(client([
    summary('running', 90, { running: true }),
    summary('blank', 80, { blank: true }),
    summary('archived', 70),
    summary('older', 60),
    summary('latest', 100, { agentPreset: 'standard' }),
  ], () => { creates += 1 }))

  const result = await routing.resolve(workspace, {
    sessionMode: 'latest-idle',
    archivedSessionIds: ['archived'],
  })

  assert.deepEqual(result, { sessionId: 'latest', reused: true, agentPreset: 'standard' })
  assert.equal(creates, 0)
})

test('latest-idle creates a fresh session when no reusable conversation exists', async () => {
  const routing = new SessionRoutingFacade(client([
    summary('running', 90, { running: true }),
    summary('blank', 80, { blank: true }),
  ]))

  const result = await routing.resolve(workspace, {
    sessionMode: 'latest-idle',
    archivedSessionIds: [],
  })

  assert.deepEqual(result, { sessionId: 'created', reused: false, agentPreset: null })
})

test('fresh session rejects a Host response that commits a different selected preset', async () => {
  const requests: Array<{ workspaceId: string; agentPreset?: string }> = []
  const routing = new SessionRoutingFacade({
    async listSessions() { return [] },
    async createSession(request) {
      requests.push(request)
      return { sessionId: 'native-session-id', agentPreset: 'host-normalized-preset' }
    },
  })

  await assert.rejects(
    routing.resolve(workspace, { agentPreset: 'selected-preset', archivedSessionIds: [] }),
    /different agentPreset than requested/iu,
  )

  assert.deepEqual(requests, [{ workspaceId: workspace.workspaceId, agentPreset: 'selected-preset' }])
})

test('fresh session succeeds when the Host response confirms the exact requested preset', async () => {
  const routing = new SessionRoutingFacade({
    async listSessions() { throw new Error('creation response already confirms the preset') },
    async createSession(request) {
      assert.deepEqual(request, { workspaceId: workspace.workspaceId, agentPreset: 'selected-preset' })
      return { sessionId: 'native-session-id', agentPreset: 'selected-preset' }
    },
  })

  const result = await routing.resolve(workspace, { agentPreset: 'selected-preset', archivedSessionIds: [] })

  assert.deepEqual(result, { sessionId: 'native-session-id', reused: false, agentPreset: 'selected-preset' })
})

test('missing create preset is verified from the exact new main session in the selected workspace', async () => {
  let listCalls = 0
  const routing = new SessionRoutingFacade({
    async listSessions() {
      listCalls += 1
      return [
        summary('unrelated', 99, { agentPreset: 'selected-preset' }),
        summary('new-session', 1, { agentPreset: 'selected-preset' }),
      ]
    },
    async createSession() { return { sessionId: 'new-session' } },
  })

  const result = await routing.resolve(workspace, { agentPreset: 'selected-preset', archivedSessionIds: [] })

  assert.equal(listCalls, 1)
  assert.deepEqual(result, { sessionId: 'new-session', reused: false, agentPreset: 'selected-preset' })
})

test('missing create preset fails when live projection is absent or reports a different preset', async () => {
  const cases: Array<{ name: string; listed: SessionSummary[]; message: RegExp }> = [
    { name: 'no exact new session', listed: [summary('other', 1, { agentPreset: 'selected-preset' })], message: /could not be verified in the selected workspace/iu },
    { name: 'different actual preset', listed: [summary('new-session', 1, { agentPreset: 'host-default' })], message: /different agentPreset than requested/iu },
    { name: 'preset absent from projection', listed: [summary('new-session', 1)], message: /could not be verified$/iu },
  ]
  for (const scenario of cases) {
    const routing = new SessionRoutingFacade({
      async listSessions() { return scenario.listed },
      async createSession() { return { sessionId: 'new-session' } },
    })
    await assert.rejects(
      routing.resolve(workspace, { agentPreset: 'selected-preset', archivedSessionIds: [] }),
      scenario.message,
      scenario.name,
    )
  }
})

test('missing create preset is not verified from a subagent or another workspace path', async () => {
  const noCwd = summary('new-session', 1, { agentPreset: 'selected-preset' })
  delete noCwd.cwd
  for (const listed of [
    [summary('new-session', 1, { agentPreset: 'selected-preset', origin: 'subagent' })],
    [summary('new-session', 1, { agentPreset: 'selected-preset', cwd: 'D:\\AI\\other' })],
    [noCwd],
  ]) {
    const routing = new SessionRoutingFacade({
      async listSessions() { return listed },
      async createSession() { return { sessionId: 'new-session' } },
    })
    await assert.rejects(
      routing.resolve(workspace, { agentPreset: 'selected-preset', archivedSessionIds: [] }),
      /could not be verified in the selected workspace/iu,
    )
  }
})

test('selected preset with latest-idle creates a fresh session instead of reusing a different preset', async () => {
  const requests: Array<{ workspaceId: string; agentPreset?: string }> = []
  const routing = new SessionRoutingFacade({
    async listSessions() { return [summary('latest', 100, { agentPreset: 'existing-preset' })] },
    async createSession(request) {
      requests.push(request)
      return { sessionId: 'new-session', agentPreset: 'selected-preset' }
    },
  })

  const result = await routing.resolve(workspace, {
    sessionMode: 'latest-idle', agentPreset: 'selected-preset', archivedSessionIds: [],
  })

  assert.deepEqual(requests, [{ workspaceId: workspace.workspaceId, agentPreset: 'selected-preset' }])
  assert.deepEqual(result, { sessionId: 'new-session', reused: false, agentPreset: 'selected-preset' })
})

test('explicit reuse preserves the existing preset and rejects a different requested preset without creating', async () => {
  let creates = 0
  const routing = new SessionRoutingFacade(client([
    summary('latest', 100, { agentPreset: 'cordis' }),
  ], () => { creates += 1 }))

  const samePreset = await routing.resolve(workspace, {
    sessionId: 'latest', agentPreset: 'cordis', archivedSessionIds: [],
  })
  assert.deepEqual(samePreset, { sessionId: 'latest', reused: true, agentPreset: 'cordis' })
  await assert.rejects(
    routing.resolve(workspace, { sessionId: 'latest', agentPreset: 'standard', archivedSessionIds: [] }),
    /agentPreset can only be selected when creating a fresh session/iu,
  )
  assert.equal(creates, 0, 'explicit reuse never replaces the existing composition')
})

test('omitting the preset forwards no override and reports the Host default', async () => {
  const requests: Array<{ workspaceId: string; agentPreset?: string }> = []
  const routing = new SessionRoutingFacade({
    async listSessions() { return [] },
    async createSession(request) {
      requests.push(request)
      return { sessionId: 'host-default-session', agentPreset: 'host-default-preset' }
    },
  })

  const result = await routing.resolve(workspace, { archivedSessionIds: [] })

  assert.deepEqual(requests, [{ workspaceId: workspace.workspaceId }], 'an omitted preset must not override the Host default')
  assert.deepEqual(result, { sessionId: 'host-default-session', reused: false, agentPreset: 'host-default-preset' })
})

test('explicit reuse rejects archived, missing, and running sessions', async () => {
  const routing = new SessionRoutingFacade(client([
    summary('running', 90, { running: true }),
    summary('latest', 80),
  ]))

  await assert.rejects(
    routing.resolve(workspace, { sessionId: 'archived', archivedSessionIds: ['archived'] }),
    /session is archived/iu,
  )
  await assert.rejects(
    routing.resolve(workspace, { sessionId: 'older', archivedSessionIds: [] }),
    /not available for reuse/iu,
  )
  await assert.rejects(
    routing.resolve(workspace, { sessionId: 'running', archivedSessionIds: [] }),
    /already running/iu,
  )
})

function summary(
  sessionId: string,
  updatedAt: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId,
    updatedAt,
    running: false,
    blank: false,
    cwd: workspace.path,
    ...overrides,
  }
}

function client(items: SessionSummary[], created?: () => void) {
  return {
    async listSessions(): Promise<SessionSummary[]> {
      return items
    },
    async createSession(): Promise<{ sessionId: string }> {
      created?.()
      return { sessionId: 'created' }
    },
  }
}
