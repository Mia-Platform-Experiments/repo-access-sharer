'use strict'

const { createJsonClient, withRetry, messageOf } = require('./http')

// GitHub: adds the repository to an organization team
// (PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}).
// The call is idempotent: repeating it with the same permission returns 204 again.
function createGithubClient (config, { fetchImpl, sleepImpl } = {}) {
  const request = createJsonClient({
    baseUrl: config.githubApiUrl,
    headers: {
      authorization: `Bearer ${config.githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'repo-access-sharer',
    },
    requestTimeoutMs: config.requestTimeoutMs,
  }, { fetchImpl })

  const org = encodeURIComponent(config.githubOrg)
  const team = encodeURIComponent(config.targetTeamSlug)

  // repositoryPath is "owner/repo", already validated by parseRepositoryUrl.
  function grantAccess (repositoryPath) {
    const [owner, repo] = repositoryPath.split('/').map(encodeURIComponent)
    return withRetry(config, async () => {
      const { status, payload } = await request('PUT', `/orgs/${org}/teams/${team}/repos/${owner}/${repo}`, {
        permission: config.teamPermission,
      })
      if (status === 204) return { done: true, result: { outcome: 'shared', status } }
      return { done: false, result: { outcome: 'failed', status, message: messageOf(payload) } }
    }, { sleepImpl })
  }

  // Readiness: the token works and can see the target team.
  async function checkTarget () {
    try {
      const { status, payload } = await request('GET', `/orgs/${org}/teams/${team}`)
      return { ok: status === 200, status, target: payload && payload.slug ? `${config.githubOrg}/${payload.slug}` : undefined }
    } catch (error) {
      return { ok: false, status: 0, message: error.message }
    }
  }

  return { grantAccess, checkTarget }
}

module.exports = { createGithubClient }
