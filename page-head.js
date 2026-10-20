// Inlined into <head> of DbGate's pages, before DbGate's own code. See Dockerfile.

// Every session shares one browser origin, so DbGate would reopen the previous session's tabs
// (another service's database). Keep browser storage in memory only: replace localStorage and hide
// IndexedDB and WebSQL (openDatabase, still in Safari), so DbGate's localforage falls back to
// localStorage, which is this in-memory store.
try {
  // Images before this one saved earlier sessions' tabs and query text here.
  try {
    window.indexedDB?.deleteDatabase('localforage')
  } catch (e) {}

  const store = new Map()
  const memoryStorage = {
    getItem: (key) => store.get(String(key)) ?? null,
    setItem: (key, value) => {
      store.set(String(key), String(value))
    },
    removeItem: (key) => {
      store.delete(String(key))
    },
    clear: () => {
      store.clear()
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    }
  }
  Object.defineProperty(window, 'localStorage', { value: memoryStorage })
  for (const name of [
    'indexedDB',
    'webkitIndexedDB',
    'mozIndexedDB',
    'msIndexedDB',
    'openDatabase'
  ]) {
    Object.defineProperty(window, name, { value: undefined })
  }
} catch (e) {
  console.warn(
    'page-head.js: browser storage not isolated, tabs may persist',
    e
  )
}

// Decline usage analytics. TODO: use USAGE_ANALYTICS=false once the dbgate/dbgate image supports it.
try {
  localStorage.setItem('dbgateUsageAnalyticsConsent', 'false')
} catch (e) {}
