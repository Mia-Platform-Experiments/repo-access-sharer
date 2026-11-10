'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildApp } = require('../src/app')
const { loadConfig } = require('../src/config')
const { computeSignature } = require('../src/signature')

const SECRET = 'test-secret'
const TENANT = 'b933f1ef-5b8e-4adf-a346-24a3b03d13e8'
const ORG = 'Mia-Platform-Experiments'
const REPO = `https://github.com/${ORG}/repo-access-sharer`

const config = loadConfig({
  REPOSITORY_PROVIDER: 'github',
  GITHUB_TOKEN: 'tok',
  GITHUB_ORG: ORG,
  TARGET_TEAM_SLUG: 'care-dev',
  WEBHOOK_SECRET: SECRET,
  ALLOWED_TENANT_IDS: TENANT,
  LOG_LEVEL: 'silent',
})

function fakeClient (shareResult = { outcome: 'shared', status: 204, attempts: 1 }, targetResult = { ok: true, status: 200, target: `${ORG}/care-dev` }) {
  const calls = []
  return {
    calls,
    grantAccess: async (...args) => { calls.push(args); return shareResult },
    checkTarget: async () => targetResult,
  }
}

// Same shape as the sample body sent by the Console.
function event (overrides = {}) {
  return {
    eventName: 'service_created',
    eventTimestamp: 1794299397043,
    payload: {
      projectId: '6af2d8ad629fd2fa0c87ee2c',
      repositoryURL: REPO,
      serviceName: 'repo-access-sharer',
      templateId: '67a4ed58d38aa6c26d280217',
      templateUrn: 'urn:mia-platform:mktp:scratch-template?=version=1.0.0',
      tenantId: TENANT,
      ...overrides,
    },
    user: { id: '69832f4103b3805406b3ba07', name: 'Test', email: 'test@example.invalid' },
  }
}

async function send (app, body, { sign = true, secret = SECRET } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const headers = { 'content-type': 'application/json' }
  if (sign) headers['x-mia-signature'] = computeSignature(raw, secret)
  return app.inject({ method: 'POST', url: '/webhooks/service-created', headers, payload: raw })
}

test('shares the repository from a valid signed event', async () => {
  const gl = fakeClient()
  const res = await send(buildApp(config, gl), event())
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().status, 'shared')
  assert.deepEqual(gl.calls, [[`${ORG}/repo-access-sharer`]])
  assert.equal(res.json().target, `${ORG}/care-dev`)
})

test('also served on /service-created (gateway rewrites /webhooks to /)', async () => {
  const gl = fakeClient()
  const raw = JSON.stringify(event())
  const res = await buildApp(config, gl).inject({
    method: 'POST',
    url: '/service-created',
    headers: { 'content-type': 'application/json', 'x-mia-signature': computeSignature(raw, SECRET) },
    payload: raw,
  })
  assert.equal(res.statusCode, 200)
  assert.equal(gl.calls.length, 1)
})

test('already shared is a success (GitLab 409)', async () => {
  const res = await send(buildApp(config, fakeClient({ outcome: 'already_shared', status: 409, attempts: 1 })), event())
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().status, 'already_shared')
})

test('rejects missing or wrong signature without calling GitHub', async () => {
  const gl = fakeClient()
  const app = buildApp(config, gl)
  assert.equal((await send(app, event(), { sign: false })).statusCode, 401)
  assert.equal((await send(app, event(), { secret: 'wrong' })).statusCode, 401)
  assert.equal(gl.calls.length, 0)
})

test('ignores other events, tenants, hosts and owners without calling GitHub', async () => {
  const gl = fakeClient()
  const app = buildApp(config, gl)
  const cases = [
    [{ ...event(), eventName: 'project_created' }, 'unsupported_event'],
    [event({ tenantId: 'another-tenant' }), 'tenant_not_allowed'],
    [event({ repositoryURL: `https://evil.example.com/${ORG}/x` }), 'host_not_allowed'],
    [event({ repositoryURL: 'https://github.com/another-org/x' }), 'owner_not_allowed'],
  ]
  for (const [body, reason] of cases) {
    const res = await send(app, body)
    assert.equal(res.statusCode, 200, reason)
    assert.deepEqual(res.json(), { status: 'ignored', reason })
  }
  assert.equal(gl.calls.length, 0)
})

test('400 on malformed body or repositoryURL', async () => {
  const app = buildApp(config, fakeClient())
  assert.equal((await send(app, '{not json')).statusCode, 400)
  assert.equal((await send(app, { eventName: 'service_created' })).statusCode, 400)
  assert.equal((await send(app, event({ repositoryURL: 'nope' }))).statusCode, 400)
})

test('502 when GitHub fails, so the failure is visible', async () => {
  const res = await send(buildApp(config, fakeClient({ outcome: 'failed', status: 403, attempts: 1, message: 'Forbidden' })), event())
  assert.equal(res.statusCode, 502)
  assert.equal(res.json().providerStatus, 403)
})

test('probes: healthz always OK, ready depends on access to the target team', async () => {
  const okApp = buildApp(config, fakeClient())
  assert.equal((await okApp.inject('/-/healthz')).statusCode, 200)
  assert.equal((await okApp.inject('/-/ready')).statusCode, 200)

  const koApp = buildApp(config, fakeClient(undefined, { ok: false, status: 401 }))
  const res = await koApp.inject('/-/ready')
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().providerStatus, 401)
})
