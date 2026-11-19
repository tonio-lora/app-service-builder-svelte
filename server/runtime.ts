import { resolve } from 'node:path'
import { createApp } from './app.js'
import type { Store } from './store.js'

export async function serve(store: Store, development: boolean) {
  const domain = (process.env.ALLOWED_DOMAIN || 'iastate.edu').trim().toLowerCase()
  const professors = (process.env.PROFESSOR_EMAILS || (development ? 'alora@iastate.edu' : ''))
    .split(',').map((email) => email.trim().toLowerCase()).filter(Boolean)
  if (!professors.length || professors.some((email) => email.split('@').length !== 2 || email.split('@')[1] !== domain)) {
    throw new Error('PROFESSOR_EMAILS must contain at least one account in ALLOWED_DOMAIN.')
  }
  const app = createApp(store, { domain, professors, development }, resolve('dist'))
  await store.health()
  const port = development ? 3001 : Number(process.env.PORT || 8080)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.')
  const server = app.listen(port, development ? '127.0.0.1' : '0.0.0.0', () => {
    console.log(development
      ? 'LOCAL DEMO API on http://127.0.0.1:3001. Simulated identities enabled; never expose this port.'
      : `Classroom is listening on port ${port}. Builder-verified Entra identity is required.`)
  })
  server.on('error', (error) => { console.error('Unable to start classroom server:', error.message); process.exitCode = 1 })
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    server.close(() => {
      store.close().catch((error: unknown) => { console.error('Database shutdown failed.', error); process.exitCode = 1 })
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
