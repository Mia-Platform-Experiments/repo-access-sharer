'use strict'

const PROVIDERS = ['github', 'gitlab']
const GITLAB_ACCESS_LEVELS = [10, 15, 20, 30, 40, 50]
const GITHUB_PERMISSIONS = ['pull', 'triage', 'push', 'maintain', 'admin']

function parseList (value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function hostOf (url, name, errors) {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    if (url) errors.push(`${name} is not a valid URL`)
    return ''
  }
}

// Retry settings: generic names first, GITLAB_* kept for existing deployments.
function intFrom (env, names, fallback) {
  const name = names.find((n) => env[n] !== undefined && env[n] !== '')
  return Number.parseInt(name ? env[name] : fallback, 10)
}

function loadGithub (env, errors) {
  const githubApiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
  const apiHost = hostOf(githubApiUrl, 'GITHUB_API_URL', errors)
  // github.com serves the API on api.github.com; GitHub Enterprise Server on <host>/api/v3.
  const repositoryHost = (env.GITHUB_HOST || (apiHost === 'api.github.com' ? 'github.com' : apiHost)).toLowerCase()

  const githubToken = env.GITHUB_TOKEN || ''
  if (!githubToken) errors.push('GITHUB_TOKEN is required')

  const githubOrg = (env.GITHUB_ORG || '').trim()
  if (!githubOrg) errors.push('GITHUB_ORG is required')

  const targetTeamSlug = (env.TARGET_TEAM_SLUG || '').trim()
  if (!targetTeamSlug) errors.push('TARGET_TEAM_SLUG is required')

  const teamPermission = (env.TEAM_PERMISSION || 'push').trim()
  if (!GITHUB_PERMISSIONS.includes(teamPermission)) {
    errors.push(`TEAM_PERMISSION must be one of ${GITHUB_PERMISSIONS.join(', ')}`)
  }

  return {
    githubApiUrl,
    githubToken,
    githubOrg,
    targetTeamSlug,
    teamPermission,
    repositoryHost,
    target: `${githubOrg}/${targetTeamSlug}`,
    access: teamPermission,
  }
}

function loadGitlab (env, errors) {
  const gitlabBaseUrl = (env.GITLAB_BASE_URL || '').replace(/\/+$/, '')
  if (!gitlabBaseUrl) errors.push('GITLAB_BASE_URL is required')
  const repositoryHost = hostOf(gitlabBaseUrl, 'GITLAB_BASE_URL', errors)

  const gitlabToken = env.GITLAB_TOKEN || ''
  if (!gitlabToken) errors.push('GITLAB_TOKEN is required')

  const targetGroupId = Number.parseInt(env.TARGET_GROUP_ID, 10)
  if (!Number.isInteger(targetGroupId) || targetGroupId <= 0) {
    errors.push('TARGET_GROUP_ID must be a positive integer')
  }

  const groupAccessLevel = Number.parseInt(env.GROUP_ACCESS_LEVEL || '30', 10)
  if (!GITLAB_ACCESS_LEVELS.includes(groupAccessLevel)) {
    errors.push(`GROUP_ACCESS_LEVEL must be one of ${GITLAB_ACCESS_LEVELS.join(', ')}`)
  }

  return {
    gitlabBaseUrl,
    gitlabToken,
    targetGroupId,
    groupAccessLevel,
    repositoryHost,
    target: String(targetGroupId),
    access: groupAccessLevel,
  }
}

function loadConfig (env = process.env) {
  const errors = []

  // Default to gitlab when only GITLAB_* is set, so existing deployments keep working.
  const provider = (env.REPOSITORY_PROVIDER || (env.GITLAB_BASE_URL ? 'gitlab' : 'github')).trim().toLowerCase()
  if (!PROVIDERS.includes(provider)) errors.push(`REPOSITORY_PROVIDER must be one of ${PROVIDERS.join(', ')}`)

  const providerConfig = provider === 'gitlab' ? loadGitlab(env, errors) : loadGithub(env, errors)

  const webhookSecret = env.WEBHOOK_SECRET || ''
  const skipSignature = env.SKIP_SIGNATURE_VERIFICATION === 'true'
  if (!webhookSecret && !skipSignature) {
    errors.push('WEBHOOK_SECRET is required (or set SKIP_SIGNATURE_VERIFICATION=true for local tests only)')
  }

  if (errors.length > 0) {
    const error = new Error(`Invalid configuration:\n - ${errors.join('\n - ')}`)
    error.code = 'INVALID_CONFIG'
    throw error
  }

  return {
    provider,
    ...providerConfig,
    httpPort: Number.parseInt(env.HTTP_PORT || '3000', 10),
    logLevel: env.LOG_LEVEL || 'info',
    webhookSecret,
    skipSignature,
    allowedTenantIds: parseList(env.ALLOWED_TENANT_IDS),
    allowedPathPrefixes: parseList(env.ALLOWED_PATH_PREFIX).map((prefix) => prefix.replace(/^\/+/, '')),
    retryAttempts: intFrom(env, ['RETRY_ATTEMPTS', 'GITLAB_RETRY_ATTEMPTS'], '3'),
    retryBaseDelayMs: intFrom(env, ['RETRY_BASE_DELAY_MS', 'GITLAB_RETRY_BASE_DELAY_MS'], '1000'),
    requestTimeoutMs: intFrom(env, ['REQUEST_TIMEOUT_MS', 'GITLAB_REQUEST_TIMEOUT_MS'], '10000'),
  }
}

module.exports = { loadConfig }
