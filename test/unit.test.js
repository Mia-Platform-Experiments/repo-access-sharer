'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { computeSignature, isValidSignature } = require('../src/signature')
const { parseRepositoryUrl } = require('../src/repository')
const { loadConfig } = require('../src/config')
const { createGitlabClient } = require('../src/gitlab')
const { createGithubClient } = require('../src/github')

const PREFIX = 'clients/mia-platform/demo/demo-companies/digital-platform-c/care-service-repo-access/services/'
const opts = { provider: 'gitlab', repositoryHost: 'git.tools.mia-platform.eu', allowedPathPrefixes: [PREFIX] }
const ghOpts = { provider: 'github', repositoryHost: 'github.com', githubOrg: 'Mia-Platform-Experiments', allowedPathPrefixes: [] }

test('signature: valid, sha256= prefix, wrong secret, missing', () => {
  const body = '{"a":1}'
  const sig = computeSignature(body, 's3cret')
  assert.equal(isValidSignature(body, 's3cret', sig), true)
  assert.equal(isValidSignature(body, 's3cret', `sha256=${sig.toUpperCase()}`), true)
  assert.equal(isValidSignature(body, 'other', sig), false)
  assert.equal(isValidSignature(body + ' ', 's3cret', sig), false)
  assert.equal(isValidSignature(body, 's3cret', undefined), false)
})

test('repository: accepts allowed path, strips .git and trailing slash', () => {
  const r = parseRepositoryUrl(`https://git.tools.mia-platform.eu/${PREFIX}my-svc.git/`, opts)
  assert.deepEqual(r, { ok: true, projectPath: `${PREFIX}my-svc` })
})

test('repository: rejects other hosts (token must never leave GITLAB_BASE_URL)', () => {
  assert.equal(parseRepositoryUrl(`https://evil.example.com/${PREFIX}x`, opts).reason, 'host_not_allowed')
  assert.equal(parseRepositoryUrl(`https://git.tools.mia-platform.eu.evil.com/${PREFIX}x`, opts).reason, 'host_not_allowed')
})

test('repository: rejects paths outside the prefix, traversal and garbage', () => {
  assert.equal(parseRepositoryUrl('https://git.tools.mia-platform.eu/clients/other/project', opts).reason, 'path_not_allowed')
  assert.equal(parseRepositoryUrl(`https://git.tools.mia-platform.eu/${PREFIX.slice(0, -1)}-evil/x`, opts).reason, 'path_not_allowed')
  // WHATWG URL resolves %2E%2E segments, so traversal ends up outside the prefix
  assert.equal(parseRepositoryUrl(`https://git.tools.mia-platform.eu/${PREFIX}%2E%2E/%2E%2E/x`, opts).ok, false)
  assert.equal(parseRepositoryUrl(`https://git.tools.mia-platform.eu/${PREFIX}a/-/b`, opts).reason, 'invalid_project_path')
  assert.equal(parseRepositoryUrl('not a url', opts).reason, 'invalid_repository_url')
  assert.equal(parseRepositoryUrl('', opts).reason, 'missing_repository_url')
  assert.equal(parseRepositoryUrl(`ssh://git.tools.mia-platform.eu/${PREFIX}x`, opts).reason, 'unsupported_protocol')
})

test('repository: no prefix configured allows any path on the host', () => {
  const r = parseRepositoryUrl('https://git.tools.mia-platform.eu/group/project', { ...opts, allowedPathPrefixes: [] })
  assert.equal(r.ok, true)
})

test('config (gitlab): requires token, group and secret', () => {
  assert.throws(() => loadConfig({ REPOSITORY_PROVIDER: 'gitlab' }), /GITLAB_BASE_URL is required[\s\S]*GITLAB_TOKEN[\s\S]*TARGET_GROUP_ID[\s\S]*WEBHOOK_SECRET/)
  const c = loadConfig({
    GITLAB_BASE_URL: 'https://git.tools.mia-platform.eu/',
    GITLAB_TOKEN: 't',
    TARGET_GROUP_ID: '402038',
    WEBHOOK_SECRET: 's',
    ALLOWED_TENANT_IDS: 'a, b',
    ALLOWED_PATH_PREFIX: `/${PREFIX}`,
  })
  assert.equal(c.gitlabBaseUrl, 'https://git.tools.mia-platform.eu')
  assert.equal(c.provider, 'gitlab')
  assert.equal(c.repositoryHost, 'git.tools.mia-platform.eu')
  assert.equal(c.targetGroupId, 402038)
  assert.equal(c.groupAccessLevel, 30)
  assert.deepEqual(c.allowedTenantIds, ['a', 'b'])
  assert.deepEqual(c.allowedPathPrefixes, [PREFIX])
})

function fakeFetch (responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (next instanceof Error) throw next
    return { status: next.status, text: async () => (next.body ? JSON.stringify(next.body) : '') }
  }
  return { impl, calls }
}

const clientConfig = { gitlabBaseUrl: 'https://gl', gitlabToken: 'tok', targetGroupId: 402038, groupAccessLevel: 30, requestTimeoutMs: 1000, retryAttempts: 3, retryBaseDelayMs: 1 }
const noSleep = async () => {}

test('gitlab: share sends the right request', async () => {
  const f = fakeFetch([{ status: 201, body: {} }])
  const client = createGitlabClient(clientConfig, { fetchImpl: f.impl, sleepImpl: noSleep })
  const r = await client.grantAccess('a/b/c')
  assert.equal(r.outcome, 'shared')
  assert.equal(f.calls[0].url, 'https://gl/api/v4/projects/a%2Fb%2Fc/share')
  assert.equal(f.calls[0].init.headers['PRIVATE-TOKEN'], 'tok')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { group_id: 402038, group_access: 30 })
})

test('gitlab: 409 is idempotent success', async () => {
  const f = fakeFetch([{ status: 409, body: { message: 'Group already shared with this group' } }])
  const r = await createGitlabClient(clientConfig, { fetchImpl: f.impl, sleepImpl: noSleep }).grantAccess('a/b')
  assert.equal(r.outcome, 'already_shared')
})

test('gitlab: retries 404/5xx/network, then succeeds', async () => {
  const f = fakeFetch([{ status: 404 }, new Error('ECONNRESET'), { status: 201 }])
  const r = await createGitlabClient(clientConfig, { fetchImpl: f.impl, sleepImpl: noSleep }).grantAccess('a/b')
  assert.equal(r.outcome, 'shared')
  assert.equal(r.attempts, 3)
})

test('gitlab: 403 is not retried', async () => {
  const f = fakeFetch([{ status: 403, body: { message: '403 Forbidden' } }])
  const r = await createGitlabClient(clientConfig, { fetchImpl: f.impl, sleepImpl: noSleep }).grantAccess('a/b')
  assert.equal(r.outcome, 'failed')
  assert.equal(r.status, 403)
  assert.equal(f.calls.length, 1)
})

test('gitlab: gives up after retryAttempts', async () => {
  const f = fakeFetch([{ status: 502 }, { status: 502 }, { status: 502 }])
  const r = await createGitlabClient(clientConfig, { fetchImpl: f.impl, sleepImpl: noSleep }).grantAccess('a/b')
  assert.equal(r.outcome, 'failed')
  assert.equal(f.calls.length, 3)
})

// --- GitHub ---

test('repository (github): accepts org/repo, case-insensitive owner, strips .git', () => {
  assert.deepEqual(parseRepositoryUrl('https://github.com/Mia-Platform-Experiments/repo-access-sharer.git', ghOpts), { ok: true, projectPath: 'Mia-Platform-Experiments/repo-access-sharer' })
  assert.equal(parseRepositoryUrl('https://github.com/mia-platform-experiments/x', ghOpts).ok, true)
})

test('repository (github): rejects other hosts, other owners and nested paths', () => {
  assert.equal(parseRepositoryUrl('https://github.com.evil.com/Mia-Platform-Experiments/x', ghOpts).reason, 'host_not_allowed')
  assert.equal(parseRepositoryUrl('https://api.github.com/Mia-Platform-Experiments/x', ghOpts).reason, 'host_not_allowed')
  assert.equal(parseRepositoryUrl('https://github.com/another-org/x', ghOpts).reason, 'owner_not_allowed')
  assert.equal(parseRepositoryUrl('https://github.com/Mia-Platform-Experiments/x/tree/main', ghOpts).reason, 'invalid_project_path')
  assert.equal(parseRepositoryUrl('https://github.com/Mia-Platform-Experiments', ghOpts).reason, 'invalid_project_path')
  assert.equal(parseRepositoryUrl('https://github.com/Mia-Platform-Experiments/a%20b', ghOpts).reason, 'invalid_project_path')
  assert.equal(parseRepositoryUrl('https://github.com/Mia-Platform-Experiments/%E0%A4%A', ghOpts).reason, 'invalid_project_path')
})

test('repository (github): optional repository name prefix', () => {
  const o = { ...ghOpts, allowedPathPrefixes: ['Mia-Platform-Experiments/care-'] }
  assert.equal(parseRepositoryUrl('https://github.com/Mia-Platform-Experiments/Care-svc', o).ok, true)
  assert.equal(parseRepositoryUrl('https://github.com/Mia-Platform-Experiments/other', o).reason, 'path_not_allowed')
})

test('config (github): defaults, required fields and GHES host', () => {
  assert.throws(() => loadConfig({}), /GITHUB_TOKEN is required[\s\S]*GITHUB_ORG[\s\S]*TARGET_TEAM_SLUG[\s\S]*WEBHOOK_SECRET/)
  assert.throws(() => loadConfig({ GITHUB_TOKEN: 't', GITHUB_ORG: 'o', TARGET_TEAM_SLUG: 'x', WEBHOOK_SECRET: 's', TEAM_PERMISSION: 'write' }), /TEAM_PERMISSION/)
  assert.throws(() => loadConfig({ REPOSITORY_PROVIDER: 'bitbucket', WEBHOOK_SECRET: 's' }), /REPOSITORY_PROVIDER/)

  const c = loadConfig({ GITHUB_TOKEN: 't', GITHUB_ORG: ' Mia-Platform-Experiments ', TARGET_TEAM_SLUG: 'care-dev', WEBHOOK_SECRET: 's', RETRY_ATTEMPTS: '6' })
  assert.equal(c.provider, 'github')
  assert.equal(c.githubApiUrl, 'https://api.github.com')
  assert.equal(c.repositoryHost, 'github.com')
  assert.equal(c.githubOrg, 'Mia-Platform-Experiments')
  assert.equal(c.teamPermission, 'push')
  assert.equal(c.target, 'Mia-Platform-Experiments/care-dev')
  assert.equal(c.retryAttempts, 6)

  const ghes = loadConfig({ GITHUB_API_URL: 'https://ghe.example.com/api/v3/', GITHUB_TOKEN: 't', GITHUB_ORG: 'o', TARGET_TEAM_SLUG: 'x', WEBHOOK_SECRET: 's' })
  assert.equal(ghes.githubApiUrl, 'https://ghe.example.com/api/v3')
  assert.equal(ghes.repositoryHost, 'ghe.example.com')
})

const ghConfig = { githubApiUrl: 'https://api.gh', githubToken: 'tok', githubOrg: 'My Org', targetTeamSlug: 'care-dev', teamPermission: 'push', requestTimeoutMs: 1000, retryAttempts: 3, retryBaseDelayMs: 1 }

test('github: adds the repository to the team with the right request', async () => {
  const f = fakeFetch([{ status: 204 }])
  const r = await createGithubClient(ghConfig, { fetchImpl: f.impl, sleepImpl: noSleep }).grantAccess('My-Org/my-repo')
  assert.equal(r.outcome, 'shared')
  assert.equal(f.calls[0].url, 'https://api.gh/orgs/My%20Org/teams/care-dev/repos/My-Org/my-repo')
  assert.equal(f.calls[0].init.method, 'PUT')
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer tok')
  assert.equal(f.calls[0].init.headers['x-github-api-version'], '2022-11-28')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { permission: 'push' })
})

test('github: retries 404 (repo not visible yet), not 403/422', async () => {
  const f = fakeFetch([{ status: 404, body: { message: 'Not Found' } }, { status: 204 }])
  const r = await createGithubClient(ghConfig, { fetchImpl: f.impl, sleepImpl: noSleep }).grantAccess('o/r')
  assert.equal(r.outcome, 'shared')
  assert.equal(r.attempts, 2)

  for (const status of [403, 422]) {
    const g = fakeFetch([{ status, body: { message: 'nope' } }])
    const res = await createGithubClient(ghConfig, { fetchImpl: g.impl, sleepImpl: noSleep }).grantAccess('o/r')
    assert.equal(res.outcome, 'failed')
    assert.equal(res.status, status)
    assert.equal(res.message, 'nope')
    assert.equal(g.calls.length, 1)
  }
})

test('github: checkTarget reads the team', async () => {
  const f = fakeFetch([{ status: 200, body: { slug: 'care-dev' } }])
  const r = await createGithubClient(ghConfig, { fetchImpl: f.impl }).checkTarget()
  assert.deepEqual(r, { ok: true, status: 200, target: 'My Org/care-dev' })
  assert.equal(f.calls[0].url, 'https://api.gh/orgs/My%20Org/teams/care-dev')

  const g = fakeFetch([{ status: 404, body: { message: 'Not Found' } }])
  assert.equal((await createGithubClient(ghConfig, { fetchImpl: g.impl }).checkTarget()).ok, false)
})
