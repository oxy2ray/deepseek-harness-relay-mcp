import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCodexEnvironment, classifyCodexNetworkFailure, classifyCodexRequestRejection, summarizeCodexDiagnostic } from '../src/wake/codex-process.js'

test('Codex request rejection classifier emits only finite safe categories', () => {
  assert.equal(classifyCodexRequestRejection('workspace routing failed during discovery'), 'workspace-routing')
  assert.equal(classifyCodexRequestRejection('OAuth token refresh failed for account'), 'authentication-refresh')
  assert.equal(classifyCodexRequestRejection('database is read-only (EROFS)'), 'readonly-state')
  assert.equal(classifyCodexRequestRejection('network connection refused'), 'network')
  assert.deepEqual(classifyCodexNetworkFailure('error sending request for url (https://api.example.test/v1/responses): connection refused'),
    { kind: 'refused', host: 'api.example.test' })
  assert.deepEqual(classifyCodexNetworkFailure('proxy error: https://user:secret@example.test/path'),
    { kind: 'proxy', host: null })
  assert.deepEqual(summarizeCodexDiagnostic('request failed: HTTP 429 at https://api.example.test/v1/responses token=fixture-secret'),
    { category: 'network', code: null, httpStatus: 429, host: 'api.example.test' })
  assert.equal(JSON.stringify(summarizeCodexDiagnostic('request failed: HTTP 429 at https://api.example.test/v1/responses token=fixture-secret')).includes('fixture-secret'), false)
  assert.equal(classifyCodexRequestRejection('method not supported'), 'unsupported')
  assert.equal(classifyCodexRequestRejection('opaque internal server failure'), 'unknown')
})

test('only model-access Codex processes inherit proxy settings and always bypass loopback proxies', () => {
  const source = { PATH: '/fixture/bin', LANG: 'C.UTF-8', HTTPS_PROXY: 'http://proxy.fixture:8080',
    HTTP_PROXY: 'http://plain-proxy.fixture:8080', ALL_PROXY: 'socks5h://socks-proxy.fixture:1080',
    http_proxy: 'https://lower-proxy.fixture:8443', NO_PROXY: 'example.org', no_proxy: 'localhost:1234' }
  const modelAccess = buildCodexEnvironment('model-access', source)
  assert.equal(modelAccess.HTTPS_PROXY, source.HTTPS_PROXY)
  assert.equal(modelAccess.HTTP_PROXY, source.HTTP_PROXY)
  assert.equal(modelAccess.ALL_PROXY, source.ALL_PROXY)
  assert.equal(modelAccess.http_proxy, source.http_proxy)
  assert.match(modelAccess.NO_PROXY ?? '', /(?:^|,)localhost(?:,|$)/u)
  assert.match(modelAccess.NO_PROXY ?? '', /(?:^|,)127\.0\.0\.1(?:,|$)/u)
  assert.match(modelAccess.NO_PROXY ?? '', /(?:^|,)::1(?:,|$)/u)
  assert.match(modelAccess.NO_PROXY ?? '', /(?:^|,)\[::1\](?:,|$)/u)
  assert.equal(modelAccess.no_proxy, modelAccess.NO_PROXY)
  const isolated = buildCodexEnvironment('isolated', source)
  assert.deepEqual(isolated, { PATH: source.PATH, LANG: source.LANG })
})

test('model-access rejects credential-bearing and malformed proxy URLs without echoing values', () => {
  const invalidUrls = [
    'http://fixture-user@proxy.fixture:8080',
    'https://:fixture-password@proxy.fixture:8443',
    'socks5://fixture-user:fixture-password@proxy.fixture:1080',
    'http://proxy.fixture:8080/?access_token=fixture-secret',
    'http://proxy.fixture:8080/#fixture-secret',
    'http://[malformed-proxy',
  ]
  for (const value of invalidUrls) {
    assert.throws(() => buildCodexEnvironment('model-access', { PATH: '/fixture/bin', HTTPS_PROXY: value }), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'invalid model-access proxy environment URL')
      assert.ok(!error.message.includes(value))
      assert.ok(!error.message.includes('fixture-secret'))
      return true
    })
  }
  assert.deepEqual(buildCodexEnvironment('isolated', { PATH: '/fixture/bin', HTTPS_PROXY: invalidUrls[0] }), {
    PATH: '/fixture/bin', LANG: 'C.UTF-8',
  })
})
