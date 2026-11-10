'use strict'

// Sends a signed service_created event to the service, as the Console would.
//
// Usage:
//   WEBHOOK_SECRET=... node scripts/send-test-webhook.js <endpoint-url> <repository-url> [tenant-id] [project-id]
//
// Example:
//   WEBHOOK_SECRET=... node scripts/send-test-webhook.js \
//     https://<project-host>/webhooks/service-created \
//     https://github.com/<org>/<repo>

const { computeSignature } = require('../src/signature')

async function main () {
  const [endpoint, repositoryURL, tenantId = 'b933f1ef-5b8e-4adf-a346-24a3b03d13e8', projectId = 'manual-test'] = process.argv.slice(2)
  const secret = process.env.WEBHOOK_SECRET
  if (!endpoint || !repositoryURL || !secret) {
    console.error('Usage: WEBHOOK_SECRET=... node scripts/send-test-webhook.js <endpoint-url> <repository-url> [tenant-id] [project-id]')
    process.exit(2)
  }

  const serviceName = repositoryURL.replace(/\/+$/, '').split('/').pop()
  const body = JSON.stringify({
    eventName: 'service_created',
    eventTimestamp: Date.now(),
    payload: {
      projectId,
      repositoryURL,
      serviceName,
      tenantId,
    },
    user: { id: 'manual-test', name: 'Manual test', email: 'manual-test@example.invalid' },
  })

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mia-signature': computeSignature(body, secret) },
    body,
  })
  console.log(response.status, await response.text())
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
