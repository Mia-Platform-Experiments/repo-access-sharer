'use strict'

// Turns the repositoryURL sent by the Console into a repository path
// ("group/sub/project" on GitLab, "owner/repo" on GitHub), refusing anything
// that is not on the configured host. The token is only ever sent to the
// configured API, never to a host taken from the payload.
function parseRepositoryUrl (repositoryURL, { provider = 'gitlab', repositoryHost, githubOrg, allowedPathPrefixes = [] }) {
  if (typeof repositoryURL !== 'string' || repositoryURL.trim() === '') {
    return { ok: false, reason: 'missing_repository_url' }
  }

  let url
  try {
    url = new URL(repositoryURL.trim())
  } catch {
    return { ok: false, reason: 'invalid_repository_url' }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'unsupported_protocol' }
  }

  if (url.host.toLowerCase() !== repositoryHost.toLowerCase()) {
    return { ok: false, reason: 'host_not_allowed' }
  }

  let projectPath
  try {
    projectPath = decodeURIComponent(url.pathname)
  } catch {
    return { ok: false, reason: 'invalid_project_path' }
  }
  projectPath = projectPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')

  const segments = projectPath.split('/')
  if (!projectPath || segments.length < 2 || projectPath.includes('..') || projectPath.includes('/-/')) {
    return { ok: false, reason: 'invalid_project_path' }
  }

  // GitHub names are case-insensitive and repositories live exactly at owner/repo.
  const github = provider === 'github'
  if (github) {
    if (segments.length !== 2 || segments.some((s) => !/^[A-Za-z0-9._-]+$/.test(s))) {
      return { ok: false, reason: 'invalid_project_path' }
    }
    if (segments[0].toLowerCase() !== githubOrg.toLowerCase()) {
      return { ok: false, reason: 'owner_not_allowed', projectPath }
    }
  }

  if (allowedPathPrefixes.length > 0) {
    // GitLab prefixes are groups ("a/b/" never matches "a/b-evil/x"); GitHub
    // prefixes may also be a repository name prefix ("org/care-").
    const normalize = (value) => (github ? value.toLowerCase() : value)
    const allowed = allowedPathPrefixes.some((prefix) => {
      const p = github || prefix.endsWith('/') ? prefix : `${prefix}/`
      return normalize(projectPath).startsWith(normalize(p))
    })
    if (!allowed) return { ok: false, reason: 'path_not_allowed', projectPath }
  }

  return { ok: true, projectPath }
}

module.exports = { parseRepositoryUrl }
