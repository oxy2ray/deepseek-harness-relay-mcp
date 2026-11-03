import { FileLockFacade } from '../../src/state-repository/index.js'

const path = process.argv[2]
if (!path) throw new Error('explicit isolated state path required')
const locks = new FileLockFacade()
for (const suffix of ['.lock', '.worker.lock', '.dispatch.lock']) await locks.acquire(`${path}${suffix}`)
process.stdout.write('READY\n')
setInterval(() => undefined, 1000)
