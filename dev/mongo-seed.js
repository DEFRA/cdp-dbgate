db = db.getSiblingDB('demo-service')

db.createCollection('users')
db.users.insertMany([
  {
    username: 'alice',
    role: 'admin',
    active: true,
    tags: ['oncall', 'ops']
  },
  {
    username: 'bob',
    role: 'developer',
    active: true,
    tags: ['backend']
  },
  {
    username: 'carol',
    role: 'viewer',
    active: false,
    tags: []
  }
])

db.createCollection('events')
db.events.insertMany([
  {
    source: 'portal',
    type: 'login',
    createdAt: new Date(),
    details: { browser: 'firefox', ip: '127.0.0.1' }
  },
  {
    source: 'redis',
    type: 'key_update',
    createdAt: new Date(),
    details: { key: 'demo-service:feature:flags', action: 'set' }
  }
])
