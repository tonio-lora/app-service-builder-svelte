import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { GameView, QuizSummary } from '../src/lib/types.js'
import { createApp } from '../server/app.js'
import { SqliteStore } from '../server/sqlite.js'

const csv = 'question,option_a,option_b,option_c,option_d,correct_answer,time_limit_seconds\nQ?,A,B,C,D,A,10'

test('production startup cannot fall back to simulated sign-in or local SQLite', () => {
  const env = { ...process.env, DEV_AUTH: 'true', NODE_ENV: 'development' }
  delete env.SQL_SERVER
  delete env.SQL_DATABASE
  const result = spawnSync(process.execPath, ['build/server/start.js'], { env, encoding: 'utf8', timeout: 10000 })
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SQL_SERVER and SQL_DATABASE are required/)
  assert.doesNotMatch(result.stdout, /listening|LOCAL DEMO API/)
})

function identity(email: string, id = email) {
  return {
    'x-ms-client-principal-idp': 'aad', 'x-ms-client-principal-id': id,
    'x-ms-client-principal-name': email,
    'x-ms-client-principal': Buffer.from(JSON.stringify({ claims: [
      { typ: 'tid', val: 'test-tenant' }, { typ: 'email', val: email }, { typ: 'name', val: email.split('@')[0] },
    ] })).toString('base64'),
  }
}

test('HTTP contract protects identities and roles, rejects cross-site writes, and serves production SPA routes', async (t) => {
  const store = new SqliteStore(':memory:')
  const server = createApp(store, {
    domain: 'iastate.edu', professors: ['professor@iastate.edu'], development: false,
  }, resolve('dist')).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise<void>((done) => server.close(() => done())); await store.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const professor = identity('professor@iastate.edu')
  const student = identity('student@iastate.edu')
  const post = (path: string, body: unknown, headers = professor) => fetch(`${origin}/api${path}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Quiz-Request': '1' },
    body: JSON.stringify(body),
  })
  assert.equal((await fetch(`${origin}/api/health`)).status, 200)
  assert.equal((await fetch(`${origin}/api/me`)).status, 401)
  assert.equal((await fetch(`${origin}/api/me`, { headers: { 'x-dev-user': 'professor' } })).status, 401)
  assert.equal((await fetch(`${origin}/api/me`, { headers: identity('outsider@example.org') })).status, 403)
  assert.equal((await fetch(`${origin}/api/me`, { headers: identity('student@sub.iastate.edu') })).status, 403)
  assert.equal((await fetch(`${origin}/api/me`, { headers: { ...professor, 'x-ms-client-principal': 'null' } })).status, 401)
  const me = await fetch(`${origin}/api/me`, { headers: student })
  assert.equal(me.headers.get('cache-control'), 'no-store')
  assert.equal((await me.json()).professor, false)
  assert.equal((await post('/quizzes', { title: 'Quiz', csv }, student)).status, 403)
  assert.equal((await post('/quizzes', { title: 'Quiz', csv }, { ...professor, 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await fetch(`${origin}/api/quizzes`, {
    method: 'POST', headers: { ...professor, 'Content-Type': 'application/json' }, body: '{}',
  })).status, 403)
  const uploaded = await post('/quizzes', { title: 'Quiz', csv })
  assert.equal(uploaded.status, 201)
  const quiz: QuizSummary = await uploaded.json()
  const created = await post('/games', { quizId: quiz.id })
  assert.equal(created.status, 201)
  const game: GameView = await created.json()
  assert.equal((await fetch(`${origin}/api/games/${game.code}`, { headers: student })).status, 403)
  assert.equal((await post(`/games/${game.code}/join`, { name: 'Student' }, student)).status, 200)
  assert.equal((await post(`/games/${game.code}/control`, { action: 'start', revision: 0 }, student)).status, 403)
  const round = await post(`/games/${game.code}/control`, { action: 'start', revision: 0 })
  const live: GameView = await round.json()
  const answered = await post(`/games/${game.code}/answers`, {
    questionId: live.question!.id, choice: 'A', points: 999999, receivedAt: 0,
  }, student)
  assert.equal(answered.status, 200)
  assert.equal((await answered.json()).leaderboard[0].points, 0)
  assert.equal((await fetch(`${origin}/api/games/${game.code}/results.csv`, { headers: student })).status, 403)
  const exportResponse = await fetch(`${origin}/api/games/${game.code}/results.csv`, { headers: professor })
  assert.match(exportResponse.headers.get('content-type')!, /text\/csv/)
  assert.match(await exportResponse.text(), /student@iastate.edu/)
  assert.equal((await fetch(`${origin}/api/games/BAD`, { headers: student })).status, 400)
  assert.equal((await fetch(`${origin}/api/missing`, { headers: student })).status, 404)
  for (const route of ['/', `/j/${game.code}`, `/host/${game.code}`]) {
    const response = await fetch(origin + route)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Cyclone Classroom/)
  }
  assert.equal((await fetch(`${origin}/server/schema.sql`)).status, 404)
  assert.equal((await fetch(`${origin}/not-a-route`)).status, 404)
})
