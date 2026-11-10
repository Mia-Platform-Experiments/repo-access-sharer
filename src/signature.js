'use strict'

const crypto = require('node:crypto')

// Mia-Platform Console signs webhooks as: X-Mia-Signature = hex(sha256(rawBody + secret))
function computeSignature (rawBody, secret) {
  return crypto.createHash('sha256').update(rawBody + secret, 'utf8').digest('hex')
}

function isValidSignature (rawBody, secret, received) {
  if (typeof received !== 'string' || received.length === 0) return false
  const normalized = received.trim().toLowerCase().replace(/^sha256=/, '')
  const expected = computeSignature(rawBody, secret)
  const a = Buffer.from(normalized, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

module.exports = { computeSignature, isValidSignature }
