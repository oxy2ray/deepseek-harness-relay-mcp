// EXPERIMENTAL AND DISABLED: do not load this provider in a candidate Host.
// It reads the shared credential document and must remain unused until the
// source is moved behind a private broker inaccessible to candidate tools.
import { stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider, { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import Schema from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'

const sharedReferences = new Set(['ARK_API_KEY', 'OPENCODE_GO_API_KEY', 'DEEPSEEK_API_KEY'])

export default class CandidateReadonlyRefCredentials extends CredentialProvider {
  static Config = Schema.object({ sourcePath: Schema.string(), privatePath: Schema.string() })

  constructor(ctx, config) {
    super(ctx)
    this.sourcePath = config.sourcePath
    this.privatePath = config.privatePath
    this.privateStore = undefined
  }

  async *[Service.init]() {
    // A fresh public Cordis context gives the writable record provider a separate credentials-service scope.
    const privateScope = new Context()
    const fiber = privateScope.plugin(LocalCredentialProvider, { path: this.privatePath, watch: false })
    await fiber
    this.privateStore = privateScope.credentials
    yield async () => { await fiber.dispose() }
  }

  async resolve(reference) {
    const ref = credentialRef(String(reference))
    const local = await this.localStore().resolve(ref)
    if (local !== undefined) return local
    const shared = await this.readSharedRef(String(ref))
    return shared === undefined ? undefined : { value: shared, source: 'authorized-read-only-reference' }
  }

  async describe(reference) {
    const ref = credentialRef(String(reference))
    const local = await this.localStore().describe(ref)
    if (local.configured) return { ...local, writable: true }
    const shared = await this.readSharedRef(String(ref))
    return shared === undefined
      ? { configured: false, writable: true }
      : { configured: true, source: 'authorized-read-only-reference', writable: true }
  }

  async availableSharedReferences() {
    const details = await stat(this.sourcePath)
    if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) throw new Error('private permissions required')
    const parsed = parseCredentialsDocument(await readFile(this.sourcePath, 'utf8'), 'authorized read-only reference source')
    const references = [...parsed.refs.keys()].filter(reference => sharedReferences.has(reference)).sort()
    parsed.refs.clear()
    parsed.records.clear()
    return { sourceFileSize: details.size, references }
  }

  async set(reference, value) {
    const ref = credentialRef(String(reference))
    await this.localStore().set(ref, value)
    this.notifyUpdated(ref)
  }

  async unset(reference) {
    const ref = credentialRef(String(reference))
    const before = await this.localStore().resolve(ref)
    await this.localStore().unset(ref)
    if (before !== undefined) this.notifyUpdated(ref)
  }

  readRecord(key) { return this.localStore().readRecord(parseCredentialKey(String(key))) }
  describeRecord(key) { return this.localStore().describeRecord(parseCredentialKey(String(key))) }
  listRecords() { return this.localStore().listRecords() }

  async modifyRecord(key, mutate) {
    const parsedKey = parseCredentialKey(String(key))
    const before = await this.localStore().readRecord(parsedKey)
    const result = await this.localStore().modifyRecord(parsedKey, mutate)
    if (JSON.stringify(before) !== JSON.stringify(result)) this.notifyRecordUpdated(parsedKey)
    return result
  }

  async deleteRecord(key) {
    const parsedKey = parseCredentialKey(String(key))
    const before = await this.localStore().readRecord(parsedKey)
    await this.localStore().deleteRecord(parsedKey)
    if (before !== undefined) this.notifyRecordUpdated(parsedKey)
  }

  localStore() {
    if (this.privateStore === undefined) throw new Error('candidate-private credential store is not ready')
    return this.privateStore
  }

  async readSharedRef(reference) {
    if (!sharedReferences.has(reference)) return undefined
    try {
      const details = await stat(this.sourcePath)
      if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) throw new Error('private permissions required')
      const parsed = parseCredentialsDocument(await readFile(this.sourcePath, 'utf8'), 'authorized read-only reference source')
      const value = parsed.refs.get(reference)
      // Never admit shared browser records into the private candidate provider.
      parsed.records.clear()
      return value
    } catch {
      throw new Error('authorized read-only credential reference unavailable')
    }
  }
}
