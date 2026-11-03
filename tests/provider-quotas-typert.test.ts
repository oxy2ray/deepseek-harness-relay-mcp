import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessGatewayFacade } from '../src/harness-gateway/harness-gateway-facade.js'
import { TypertHarnessGateway, type TypertGatewayPort, type TypertPeerScope } from '../src/harness-gateway/typert-harness-gateway.js'
import { PermissionGatewayFacade, type PermissionProvider } from '../src/permission-gateway/index.js'

const peer: TypertPeerScope = {
  id: 'quota-peer', ctx: {}, principal: { kind: 'owner' },
  signal: new AbortController().signal, interactions: 'none', async dispose() {},
}

test('Typert quota adapter calls only fixed native namespaces through the admitted peer', async () => {
  const typert = new RecordingGateway()
  const gateway = new TypertHarnessGateway(typert, permissions(), peer)

  await gateway.readProviderQuota('opencode-go')
  await gateway.readProviderQuota('ark')
  assert.equal(await gateway.readProviderQuota('deepseek-official'), undefined)
  assert.equal(await gateway.readProviderQuota('toString'), undefined)
  assert.equal(await gateway.readProviderQuota('__proto__'), undefined)
  assert.deepEqual(typert.calls.map(call => ({
    namespace: call.namespace,
    method: call.method,
    args: call.args,
    samePeer: call.peer === peer,
    hasBoundedSignal: call.signal instanceof AbortSignal,
  })), [
    { namespace: 'opencodeUsage', method: 'usage', args: {}, samePeer: true, hasBoundedSignal: true },
    { namespace: 'arkAgentPlanUsage', method: 'usage', args: {}, samePeer: true, hasBoundedSignal: true },
  ])
})

test('missing native quota method is unsupported and old gateway providers remain compatible', async () => {
  const typert = new RecordingGateway()
  typert.error = Object.assign(new Error('missing method'), { code: 'METHOD_NOT_FOUND' })
  const gateway = new TypertHarnessGateway(typert, permissions(), peer)
  assert.equal(await gateway.readProviderQuota('opencode-go'), undefined)

  const legacy = new HarnessGatewayFacade({} as never)
  assert.equal(await legacy.readProviderQuota('opencode-go'), undefined)
})

class RecordingGateway implements TypertGatewayPort {
  calls: Array<{ namespace: string; method: string; args: Readonly<Record<string, unknown>>; peer: TypertPeerScope; signal?: AbortSignal }> = []
  error: unknown

  async invoke(request: Parameters<TypertGatewayPort['invoke']>[0]): Promise<unknown> {
    this.calls.push(request)
    if (this.error !== undefined) throw this.error
    return {
      configured: true,
      reason: null,
      error: null,
      usage: null,
      apiKey: 'never forward this secret',
    }
  }

  async stream(): Promise<AsyncIterable<unknown>> {
    return { async *[Symbol.asyncIterator]() {} }
  }
}

function permissions(): PermissionGatewayFacade {
  const provider: PermissionProvider = {
    async readCurrent() { return 'read-only' },
    async select() { return { accepted: true } },
  }
  return new PermissionGatewayFacade(provider)
}
