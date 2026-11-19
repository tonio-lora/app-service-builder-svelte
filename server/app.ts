import express from 'express'
import type { ErrorRequestHandler } from 'express'
import { join } from 'node:path'
import { readIdentity, type AuthConfig } from './auth.js'
import { Classroom } from './quiz.js'
import { HttpError, requireValue } from './errors.js'
import type { Store } from './store.js'

export function createApp(store: Store, auth: AuthConfig, distPath?: string, now?: () => number) {
  const app = express()
  const classroom = new Classroom(store, now)
  app.disable('x-powered-by')
  app.use((_request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    })
    next()
  })
  app.get('/api/health', async (_request, response) => {
    response.set('Cache-Control', 'no-store')
    try {
      await store.health()
      response.json({ status: 'ok', database: 'reachable' })
    } catch {
      console.error('Database health check failed. Check database configuration, schema and permissions.')
      response.status(503).json({ status: 'unavailable', message: 'Database is not reachable.' })
    }
  })
  app.use('/api', (request, response, next) => {
    response.set('Cache-Control', 'no-store')
    if (!['GET', 'HEAD'].includes(request.method)) {
      requireValue(request.get('x-quiz-request') === '1' && request.is('application/json')
        && request.get('sec-fetch-site') !== 'cross-site', 403, 'Use the classroom app to submit this request.')
    }
    response.locals.user = readIdentity(request, auth)
    next()
  })
  app.use(express.json({ limit: '1100kb' }))
  app.get('/api/me', (_request, response) => { response.json(response.locals.user) })
  app.get('/api/quizzes', async (_request, response) => { response.json(await classroom.quizzes(response.locals.user)) })
  app.post('/api/quizzes', async (request, response) => {
    response.status(201).json(await classroom.upload(response.locals.user, request.body?.title, request.body?.csv))
  })
  app.get('/api/games', async (_request, response) => { response.json(await classroom.games(response.locals.user)) })
  app.post('/api/games', async (request, response) => {
    response.status(201).json(await classroom.create(response.locals.user, request.body?.quizId))
  })
  app.use('/api/games/:code', (request, response, next) => {
    const code = request.params.code.toUpperCase()
    requireValue(/^[A-HJ-NP-Z2-9]{6}$/.test(code), 400, 'Enter a valid six-character join code.')
    response.locals.code = code
    next()
  })
  app.get('/api/games/:code', async (_request, response) => {
    response.json(await classroom.get(response.locals.code, response.locals.user))
  })
  app.post('/api/games/:code/join', async (request, response) => {
    response.json(await classroom.join(response.locals.code, response.locals.user, request.body?.name))
  })
  app.post('/api/games/:code/control', async (request, response) => {
    response.json(await classroom.control(response.locals.code, response.locals.user, request.body?.action, request.body?.revision))
  })
  app.post('/api/games/:code/answers', async (request, response) => {
    response.json(await classroom.answer(response.locals.code, response.locals.user, request.body?.questionId, request.body?.choice))
  })
  app.get('/api/games/:code/results.csv', async (_request, response) => {
    response.set('Content-Disposition', `attachment; filename="classroom-${response.locals.code}.csv"`)
    response.type('text/csv').send(await classroom.results(response.locals.code, response.locals.user))
  })
  app.use('/api', () => { throw new HttpError(404, 'API endpoint not found.') })
  if (distPath) {
    app.use(express.static(distPath, { index: false }))
    app.get(['/', '/j/:code', '/host/:code'], (_request, response) => { response.sendFile(join(distPath, 'index.html')) })
  }
  app.use((_request, response) => { response.status(404).send('Page not found.') })
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof HttpError) {
      response.status(error.status).json({ message: error.message })
    } else if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({ message: 'The request must contain valid JSON.' })
    } else if (error?.type === 'entity.too.large') {
      response.status(413).json({ message: 'The upload is too large. Use a CSV smaller than 500 KB.' })
    } else {
      console.error('Classroom request failed.', { type: error instanceof Error ? error.name : 'UnknownError' })
      response.status(500).json({ message: 'The request could not be completed. Retry, or ask the professor to check the server logs.' })
    }
  }
  app.use(errors)
  return app
}
