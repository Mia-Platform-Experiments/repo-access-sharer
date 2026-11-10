'use strict'

const Fastify = require('fastify')
const { isValidSignature } = require('./signature')
const { parseRepositoryUrl } = require('./repository')

const SIGNATURE_HEADER = 'x-mia-signature'
const READY_CACHE_MS = 30_000

// repoClient: { grantAccess(path), checkTarget() } from ./github or ./gitlab.
function buildApp (config, repoClient, fastifyOptions = {}) {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 1024 * 1024,
    ...fastifyOptions,
  })

  // Keep the raw body: the signature is computed over the exact bytes the Console sent.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body
    try {
      done(null, body.length > 0 ? JSON.parse(body) : {})
    } catch (error) {
      error.statusCode = 400
      done(error, undefined)
    }
  })

  app.get('/-/healthz', async () => ({ status: 'OK' }))

  let readyCache = { at: 0, result: null }
  app.get('/-/ready', async (request, reply) => {
    if (!readyCache.result || Date.now() - readyCache.at > READY_CACHE_MS) {
      readyCache = { at: Date.now(), result: await repoClient.checkTarget() }
    }
    const result = readyCache.result
    if (!result.ok) {
      request.log.error({ provider: config.provider, providerStatus: result.status, target: config.target }, 'token cannot read the target group/team')
      return reply.code(503).send({ status: 'KO', providerStatus: result.status })
    }
    return { status: 'OK', provider: config.provider, target: result.target }
  })

  // Served on both paths: the Console endpoint /webhooks rewrites its base path to "/" by default.
  const handleServiceCreated = async (request, reply) => {
    const log = request.log

    if (!config.skipSignature) {
      const signature = request.headers[SIGNATURE_HEADER]
      if (!isValidSignature(request.rawBody || '', config.webhookSecret, signature)) {
        log.warn({ hasSignatureHeader: Boolean(signature) }, 'rejected webhook: invalid signature')
        return reply.code(401).send({ status: 'rejected', reason: 'invalid_signature' })
      }
    }

    const body = request.body
    if (!body || typeof body !== 'object' || !body.payload || typeof body.payload !== 'object') {
      return reply.code(400).send({ status: 'rejected', reason: 'invalid_body' })
    }

    const { eventName, payload } = body
    const context = {
      eventName,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      serviceName: payload.serviceName,
      repositoryURL: payload.repositoryURL,
    }

    if (eventName !== 'service_created') {
      log.info(context, 'ignored webhook: unsupported event')
      return { status: 'ignored', reason: 'unsupported_event' }
    }

    if (config.allowedTenantIds.length > 0 && !config.allowedTenantIds.includes(payload.tenantId)) {
      log.info(context, 'ignored webhook: tenant not allowed')
      return { status: 'ignored', reason: 'tenant_not_allowed' }
    }

    const parsed = parseRepositoryUrl(payload.repositoryURL, config)
    if (!parsed.ok) {
      if (['host_not_allowed', 'owner_not_allowed', 'path_not_allowed'].includes(parsed.reason)) {
        log.info({ ...context, reason: parsed.reason }, 'ignored webhook: repository outside allowed scope')
        return { status: 'ignored', reason: parsed.reason }
      }
      log.warn({ ...context, reason: parsed.reason }, 'rejected webhook: bad repositoryURL')
      return reply.code(400).send({ status: 'rejected', reason: parsed.reason })
    }

    const result = await repoClient.grantAccess(parsed.projectPath)
    const logContext = {
      ...context,
      provider: config.provider,
      projectPath: parsed.projectPath,
      target: config.target,
      access: config.access,
      providerStatus: result.status,
      attempts: result.attempts,
    }

    if (result.outcome === 'shared' || result.outcome === 'already_shared') {
      log.info(logContext, `repository ${result.outcome.replace('_', ' ')} with group`)
      return { status: result.outcome, projectPath: parsed.projectPath, target: config.target }
    }

    log.error({ ...logContext, providerMessage: result.message }, 'failed to share repository with group')
    return reply.code(502).send({ status: 'failed', projectPath: parsed.projectPath, providerStatus: result.status })
  }

  app.post('/webhooks/service-created', handleServiceCreated)
  app.post('/service-created', handleServiceCreated)

  return app
}

module.exports = { buildApp }
