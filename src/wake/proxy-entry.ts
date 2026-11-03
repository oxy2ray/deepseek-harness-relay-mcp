import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StdioProxyFacade } from '../stdio-proxy/index.js'
import { readConsoleConfig } from './console-config.js'
import { WakeStore } from './store.js'
import { WakeOutbox } from './outbox.js'

const path = process.argv[2]
if (!path) throw new Error('explicit isolated console configuration required')
const config = await readConsoleConfig(path)
if (!config.relayDescriptor) throw new Error('independent Relay descriptor required')
const proxy = new StdioProxyFacade({
  descriptorFile: config.relayDescriptor, clientPrincipalId: config.principal,
  requestTimeoutMs: 5000, autoStart: false,
  wake: { outbox: new WakeOutbox(new WakeStore(config.wakeState)), bindingId: config.bindingId },
})
await proxy.connect(new StdioServerTransport())
