'use strict'

// Status codes worth retrying. 404 is included on purpose: the webhook can
// arrive a moment before the new repository is visible through the API.
const RETRYABLE_STATUS = new Set([404, 408, 429, 500, 502, 503, 504])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createJsonClient ({ baseUrl, headers, requestTimeoutMs }, { fetchImpl = fetch } = {}) {
  return async function request (method, path, body) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    let payload = null
    const text = await response.text()
    if (text) {
      try { payload = JSON.parse(text) } catch { payload = { message: text.slice(0, 500) } }
    }
    return { status: response.status, payload }
  }
}

function messageOf (payload) {
  const message = payload && (payload.message || payload.error)
  if (message === undefined || message === null) return undefined
  return typeof message === 'string' ? message : JSON.stringify(message)
}

// Runs `attemptFn` until it returns a non-retryable result or attempts run out.
// attemptFn returns { done: true, result } to stop, or { done: false, result } to retry.
async function withRetry ({ retryAttempts, retryBaseDelayMs }, attemptFn, { sleepImpl = sleep } = {}) {
  let last = { outcome: 'failed', status: 0, attempts: 0, message: 'not attempted' }
  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      const { done, result } = await attemptFn()
      last = { ...result, attempts: attempt }
      if (done || !RETRYABLE_STATUS.has(result.status)) return last
    } catch (error) {
      last = { outcome: 'failed', status: 0, attempts: attempt, message: error.name === 'TimeoutError' ? 'timeout' : error.message }
    }
    if (attempt < retryAttempts) await sleepImpl(retryBaseDelayMs * 2 ** (attempt - 1))
  }
  return last
}

module.exports = { createJsonClient, withRetry, messageOf, RETRYABLE_STATUS }
