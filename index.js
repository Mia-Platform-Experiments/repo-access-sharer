'use strict'

const { loadConfig } = require('./src/config')
const { createGitlabClient } = require('./src/gitlab')
const { createGithubClient } = require('./src/github')
const { buildApp } = require('./src/app')

async function main () {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    // Fail fast: a missing token or WEBHOOK_SECRET shows up as a crashing pod with a clear log line.
    console.error(JSON.stringify({ level: 'fatal', msg: error.message }))
    process.exit(1)
  }

  const repoClient = config.provider === 'gitlab' ? createGitlabClient(config) : createGithubClient(config)
  const app = buildApp(config, repoClient)

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await app.listen({ port: config.httpPort, host: '0.0.0.0' })
  app.log.info({
    provider: config.provider,
    apiUrl: config.provider === 'gitlab' ? config.gitlabBaseUrl : config.githubApiUrl,
    repositoryHost: config.repositoryHost,
    target: config.target,
    access: config.access,
    allowedTenantIds: config.allowedTenantIds,
    allowedPathPrefixes: config.allowedPathPrefixes,
    signatureVerification: !config.skipSignature,
  }, 'repo-access-sharer started')
}

main()
