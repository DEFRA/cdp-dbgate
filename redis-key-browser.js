'use strict'

// Makes DbGate's Redis key browser scan until it finds keys, audited as one line per page.
// Wired in by redis-preload.js when DbGate loads the Redis plugin.

const { AsyncLocalStorage } = require('async_hooks')
const { audit } = require('./audit-log')

// The service's keys are a small part of a shared keyspace, so a 2000-slot page is usually empty.
// Keep scanning small pages until keys turn up, so no single SCAN blocks the shared primary.
// On timeout the empty page is returned with its cursor, so the UI offers "Scan more" instead of an error.
const KEY_BROWSER_SCAN_TIMEOUT_MS = 5000

// A key browser page sends SCAN and DBSIZE per page, then TYPE and up to 5 size commands per key.
// They only reveal key names, so the page is audited as one line listing them instead.
const keyBrowserScan = new AsyncLocalStorage()

// The UI doesn't cancel a scan when the filter changes or the list is refreshed, so the latest call
// per connection wins: an older loop stops after its current page instead of scanning on for 5 seconds.
const latestKeyBrowserScan = new WeakMap()

function isKeyBrowserScan() {
  return keyBrowserScan.getStore() === true
}

// "Scan all" passes no count and gets a single call.
async function scanUntilKeys(scanPage, cursor, count, summary, isLatest) {
  const deadline = Date.now() + KEY_BROWSER_SCAN_TIMEOUT_MS
  let page
  do {
    page = await scanPage(cursor)
    summary.pages++
    cursor = page.nextCursor
  } while (
    count != null &&
    page.keys.length === 0 &&
    String(cursor) !== '0' &&
    Date.now() < deadline &&
    isLatest()
  )
  return page
}

function auditKeyBrowserScan({ error, ...args }) {
  try {
    audit('redis', { commandName: 'scanKeys', args, error }, 'args')
  } catch (_) {
    // Never fail the user's scan because auditing failed.
  }
}

// Only the key browser calls driver.scanKeys; the query tab uses driver.stream, so typed COUNTs
// are untouched and its commands are still audited one by one.
function patchDriver(plugin) {
  for (const driver of (plugin && plugin.drivers) || []) {
    const originalScanKeys = driver.scanKeys
    if (
      typeof originalScanKeys !== 'function' ||
      originalScanKeys.__cdpPatched
    ) {
      continue
    }
    driver.scanKeys = function (dbhan, pattern, cursor, count) {
      const scanPage = (pageCursor) =>
        originalScanKeys.call(this, dbhan, pattern, pageCursor, count)
      const token = {}
      latestKeyBrowserScan.set(dbhan, token)
      const isLatest = () => latestKeyBrowserScan.get(dbhan) === token
      return keyBrowserScan.run(true, async () => {
        // DbGate's driver defaults a missing cursor to 0.
        const summary = {
          filter: pattern ?? null,
          cursor: String(cursor ?? 0),
          pages: 0
        }
        try {
          const page = await scanUntilKeys(
            scanPage,
            cursor,
            count,
            summary,
            isLatest
          )
          summary.nextCursor = String(page.nextCursor)
          summary.keys = page.keys.map((keyObj) => String(keyObj.key))
          return page
        } catch (err) {
          summary.error = (err && err.message) || String(err)
          throw err
        } finally {
          auditKeyBrowserScan(summary)
        }
      })
    }
    driver.scanKeys.__cdpPatched = true
    console.log(JSON.stringify({ msg: 'redis.driver.patched', status: 'ok' }))
  }
}

module.exports = { isKeyBrowserScan, patchDriver }
