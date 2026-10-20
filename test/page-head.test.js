'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(
  path.join(__dirname, '..', 'page-head.js'),
  'utf8'
)

// The browser's real localStorage, holding what earlier page loads saved.
function fakeRealStorage(saved = {}) {
  const data = { ...saved }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = String(value)
    },
    removeItem: (key) => {
      delete data[key]
    },
    key: (index) => Object.keys(data)[index] ?? null,
    get length() {
      return Object.keys(data).length
    }
  }
}

function fakeIndexedDB() {
  const deleted = []
  return { deleted, deleteDatabase: (name) => deleted.push(name) }
}

function loadPage(
  realStorage = fakeRealStorage(),
  realIndexedDB = fakeIndexedDB()
) {
  const window = {
    localStorage: realStorage,
    indexedDB: realIndexedDB,
    webkitIndexedDB: {},
    openDatabase: () => {}
  }
  window.window = window
  vm.createContext(window)
  vm.runInContext(source, window)
  return window
}

test('replaces localStorage with an in-memory store and hides IndexedDB and WebSQL', () => {
  const window = loadPage()

  assert.equal(window.indexedDB, undefined)
  assert.equal(window.webkitIndexedDB, undefined)
  assert.equal(window.openDatabase, undefined)
  assert.equal(window.localStorage.getItem('missing'), null)

  window.localStorage.setItem('openedTabs', 1)
  assert.equal(window.localStorage.getItem('openedTabs'), '1')
  assert.equal(window.localStorage.key(1), 'openedTabs')
  assert.equal(window.localStorage.key(5), null)
  assert.equal(window.localStorage.length, 2)

  window.localStorage.removeItem('openedTabs')
  assert.equal(window.localStorage.getItem('openedTabs'), null)

  window.localStorage.clear()
  assert.equal(window.localStorage.length, 0)
})

test('never touches the real localStorage, which other webshell tools share', () => {
  const realStorage = fakeRealStorage({ pgweb_query: 'select 1' })
  const window = loadPage(realStorage)

  window.localStorage.setItem('openedTabs', '[]')
  window.localStorage.clear()

  assert.deepEqual(realStorage.data, { pgweb_query: 'select 1' })
})

test('deletes the IndexedDB database earlier images saved tabs in', () => {
  const realIndexedDB = fakeIndexedDB()

  loadPage(fakeRealStorage(), realIndexedDB)

  assert.deepEqual(realIndexedDB.deleted, ['localforage'])
})

test('declines usage analytics in the in-memory store', () => {
  const realStorage = fakeRealStorage()
  const window = loadPage(realStorage)

  assert.equal(
    window.localStorage.getItem('dbgateUsageAnalyticsConsent'),
    'false'
  )
  assert.deepEqual(realStorage.data, {})
})

test('each page load starts empty', () => {
  loadPage().localStorage.setItem('openedTabs', '[]')

  assert.equal(loadPage().localStorage.getItem('openedTabs'), null)
})
