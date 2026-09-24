#!/usr/bin/env node
'use strict'

// Minimal stand-in for api.dbgate.cloud. DbGate calls these on every UI load;
// in CDP the request goes through the forwarder proxy and fails with
// "Redirected request failed: Unsupported protocol file:", which becomes a
// snackbar toast. LOCAL_DBGATE_CLOUD points DbGate at localhost:3110 instead.
const http = require('http')

const PORT = 3110
const HOST = '127.0.0.1'

const server = http.createServer((req, res) => {
  const url = req.url || ''
  let body = '[]'

  if (url.includes('premium-promo-widget')) {
    body = JSON.stringify({ state: 'unchanged' })
  } else if (url.startsWith('/public/')) {
    body = JSON.stringify({})
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(body)
})

server.on('error', err => {
  // Don't take down the container over this — DbGate's cloud calls will just
  // go back to failing against the real api.dbgate.cloud (toast returns, but
  // Mongo browsing still works).
  console.error(`cdp-dbgate cloud stub failed to start: ${err.message}`)
})

server.listen(PORT, HOST, () => {
  console.log(`cdp-dbgate cloud stub listening on ${HOST}:${PORT}`)
})
