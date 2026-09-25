'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// The preload reads AUDIT_LOG_PATH once at load time, so set it before requiring.
const auditLogPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-audit-')), 'mongo.audit')
process.env.AUDIT_LOG_PATH = auditLogPath

const { onCommandStarted } = require('../mongo-audit-preload')

// The driver calls this listener synchronously inside the query, so a throw here fails the query.
test('a BigInt in the command does not throw', () => {
  const event = { commandName: 'insert', command: { documents: [{ big: 12345678901234567890n }] } }

  assert.doesNotThrow(() => onCommandStarted(event))

  const line = JSON.parse(fs.readFileSync(auditLogPath, 'utf8'))
  assert.equal(line.command.documents[0].big, '12345678901234567890')
})
