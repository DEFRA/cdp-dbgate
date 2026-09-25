'use strict'

// Shared by the mongo and redis audit preloads: one JSON line per command, full line to AUDIT_LOG_PATH
// (uploaded to S3 by entrypoint.sh on shutdown), and the same line minus `detailKey` to stdout (OpenSearch).

const fs = require('fs')

// Set by entrypoint.sh, which also creates the directory and owns the upload. Unset means stdout only.
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH

// DbGate turns large integers into BigInt, which plain JSON.stringify throws on. A throw here
// would surface in the driver and fail the user's query.
function toJson(value) {
  return JSON.stringify(value, (_key, v) =>
    typeof v === 'bigint' ? v.toString() : v
  )
}

function writeAuditLine(engine, line) {
  if (!AUDIT_LOG_PATH) {
    return
  }
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, `${line}\n`)
  } catch (err) {
    console.log(
      JSON.stringify({
        msg: `${engine}.audit.write.error`,
        path: AUDIT_LOG_PATH,
        error: err && err.message
      })
    )
  }
}

// `detailKey` holds the command body, which may contain personal data, so it stays out of stdout.
function audit(engine, entry, detailKey) {
  const full = {
    msg: `${engine}.command`,
    ts: new Date().toISOString(),
    ...entry,
    userId: process.env.USER_ID || null,
    service: process.env.SERVICE,
    environment: process.env.ENVIRONMENT,
    token: process.env.TOKEN
  }
  writeAuditLine(engine, toJson(full))
  console.log(toJson({ ...full, [detailKey]: undefined }))
}

module.exports = { audit, AUDIT_LOG_PATH }
