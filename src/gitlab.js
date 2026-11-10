'use strict'

const { createJsonClient, withRetry, messageOf } = require('./http')

// GitLab: shares the project with a group (POST /projects/:id/share).
function createGitlabClient (config, { fetchImpl, sleepImpl } = {}) {
  const request = createJsonClient({
    baseUrl: `${config.gitlabBaseUrl}/api/v4`,
    headers: { 'PRIVATE-TOKEN': config.gitlabToken, accept: 'application/json' },
    requestTimeoutMs: config.requestTimeoutMs,
  }, { fetchImpl })

  // Returns { outcome: 'shared' | 'already_shared' | 'failed', status, attempts, message }.
  function grantAccess (projectPath) {
    return withRetry(config, async () => {
      const { status, payload } = await request('POST', `/projects/${encodeURIComponent(projectPath)}/share`, {
        group_id: config.targetGroupId,
        group_access: config.groupAccessLevel,
      })
      const message = messageOf(payload)
      if (status === 201) return { done: true, result: { outcome: 'shared', status } }
      if (status === 409 || (status === 400 && /already/i.test(message || ''))) {
        return { done: true, result: { outcome: 'already_shared', status, message } }
      }
      return { done: false, result: { outcome: 'failed', status, message } }
    }, { sleepImpl })
  }

  // Readiness: the token works and can see the target group.
  async function checkTarget () {
    try {
      const { status, payload } = await request('GET', `/groups/${config.targetGroupId}?with_projects=false`)
      return { ok: status === 200, status, target: payload && payload.full_path }
    } catch (error) {
      return { ok: false, status: 0, message: error.message }
    }
  }

  return { grantAccess, checkTarget }
}

module.exports = { createGitlabClient }
