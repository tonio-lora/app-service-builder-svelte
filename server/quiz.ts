import { randomInt, randomUUID } from 'node:crypto'
import { parse } from 'csv-parse/sync'
import type { Answer, Choice, Game, GameSummary, GameView, Identity, Participant, Quiz, QuizSummary } from '../src/lib/types.js'
import { requireValue } from './errors.js'
import type { Store } from './store.js'

const choices: Choice[] = ['A', 'B', 'C', 'D']
const fields = ['question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_answer', 'time_limit_seconds']
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function text(value: unknown, label: string, max: number): string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max,
    400, `${label} must contain 1-${max} characters.`)
  return value.trim()
}

export function importQuiz(title: unknown, csv: unknown, ownerId: string): Quiz {
  const cleanTitle = text(title, 'Quiz title', 100)
  requireValue(typeof csv === 'string' && Buffer.byteLength(csv) <= 512000, 400, 'Upload a CSV file no larger than 500 KB.')
  let rows: Record<string, string>[]
  try {
    rows = parse(csv, {
      bom: true, skip_empty_lines: true, trim: true, max_record_size: 12000,
      columns: (header: string[]) => {
        requireValue(header.length === fields.length && fields.every((field) => header.includes(field)),
          400, `CSV headers must be: ${fields.join(',')}`)
        return header
      },
    })
  } catch (error) {
    requireValue(false, 400, error instanceof Error ? `CSV import failed: ${error.message}` : 'Invalid CSV file.')
  }
  requireValue(rows.length > 0 && rows.length <= 100, 400, 'A quiz must contain 1-100 questions.')
  const questions = rows.map((row, index) => {
    const label = `CSV row ${index + 2}`
    const correctAnswer = row.correct_answer.toUpperCase()
    requireValue(choices.includes(correctAnswer as Choice), 400, `${label}: correct_answer must be A, B, C or D.`)
    const seconds = Number(row.time_limit_seconds)
    requireValue(/^\d+$/.test(row.time_limit_seconds) && Number.isInteger(seconds) && seconds >= 5 && seconds <= 120,
      400, `${label}: time_limit_seconds must be a whole number from 5 to 120.`)
    return {
      id: randomUUID(), text: text(row.question, `${label} question`, 1000),
      options: {
        A: text(row.option_a, `${label} option_a`, 300), B: text(row.option_b, `${label} option_b`, 300),
        C: text(row.option_c, `${label} option_c`, 300), D: text(row.option_d, `${label} option_d`, 300),
      },
      correctAnswer: correctAnswer as Choice, seconds,
    }
  })
  return { id: randomUUID(), title: cleanTitle, ownerId, createdAt: new Date().toISOString(), questions }
}

export function phaseAt(game: Game, now: number) {
  return game.phase === 'question' && game.deadline !== null && now >= game.deadline ? 'reveal' : game.phase
}

function visibleAnswers(game: Game, participant: Participant, now: number): Answer[] {
  const phase = phaseAt(game, now)
  const visible = new Set(game.questions.filter((_, index) =>
    phase === 'finished' || index < game.questionIndex || (index === game.questionIndex && phase === 'reveal'),
  ).map((question) => question.id))
  return participant.answers.filter((answer) => visible.has(answer.questionId))
}

export function viewGame(game: Game, user: Identity, now: number): GameView {
  const phase = phaseAt(game, now)
  const isHost = game.ownerId === user.id && user.professor
  const me = game.participants.find((participant) => participant.id === user.id)
  requireValue(isHost || me, 403, 'Join this competition before viewing it.')
  const question = game.questionIndex >= 0 ? game.questions[game.questionIndex] : null
  const leaderboard = game.participants.map((participant) => ({
    id: participant.id, name: participant.name,
    points: visibleAnswers(game, participant, now).reduce((sum, answer) => sum + answer.points, 0),
  })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
  return {
    code: game.code, title: game.title, createdAt: game.createdAt, phase,
    participantCount: game.participants.length, serverNow: now, revision: game.revision,
    isHost, joined: Boolean(me), questionNumber: game.questionIndex + 1,
    questionCount: game.questions.length, deadline: game.deadline,
    answeredCount: question ? game.participants.filter((participant) =>
      participant.answers.some((answer) => answer.questionId === question.id)).length : 0,
    question: question && phase !== 'lobby'
      ? { id: question.id, text: question.text, options: question.options, seconds: question.seconds } : null,
    correctAnswer: question && (phase === 'reveal' || phase === 'finished') ? question.correctAnswer : null,
    submittedChoice: me?.answers.find((answer) => answer.questionId === question?.id)?.choice ?? null,
    leaderboard: leaderboard.map((entry, index) => ({
      name: entry.name, points: entry.points, isMe: entry.id === user.id,
      rank: leaderboard.findIndex((other) => other.points === entry.points) + 1,
    })),
    roster: isHost ? game.participants.map((participant) => ({
      name: participant.name, email: participant.email,
      answered: participant.answers.some((answer) => answer.questionId === question?.id),
    })) : [],
  }
}

export function exportResults(game: Game): string {
  const cell = (value: string | number) => {
    let string = String(value)
    if (/^[\s]*[=+\-@]/.test(string) || /^[\t\r\n]/.test(string)) string = `'${string}`
    return `"${string.replaceAll('"', '""')}"`
  }
  const rows: (string | number)[][] = [
    ['competition', 'student_name', 'student_email', 'question_number', 'question', 'answer', 'correct_answer', 'points', 'received_at_utc'],
  ]
  for (const student of game.participants) {
    game.questions.forEach((question, index) => {
      const answer = student.answers.find((item) => item.questionId === question.id)
      rows.push([game.code, student.name, student.email, index + 1, question.text, answer?.choice || '',
        question.correctAnswer, answer?.points ?? 0, answer ? new Date(answer.receivedAt).toISOString() : ''])
    })
  }
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

export class Classroom {
  constructor(private store: Store, private now: () => number = Date.now) {}

  private professor(user: Identity) {
    requireValue(user.professor, 403, 'Professor access is required.')
  }

  private host(game: Game, user: Identity) {
    this.professor(user)
    requireValue(game.ownerId === user.id, 403, 'Only the professor hosting this competition can control it.')
  }

  async quizzes(user: Identity): Promise<QuizSummary[]> {
    this.professor(user)
    return (await this.store.list<Quiz>('quiz', user.id)).map(({ id, title, createdAt, questions }) =>
      ({ id, title, createdAt, questionCount: questions.length }))
  }

  async upload(user: Identity, title: unknown, csv: unknown) {
    this.professor(user)
    const quiz = importQuiz(title, csv, user.id)
    await this.store.create({ id: `quiz:${quiz.id}`, kind: 'quiz', ownerId: user.id, createdAt: quiz.createdAt, value: quiz })
    return { id: quiz.id, title: quiz.title, questionCount: quiz.questions.length }
  }

  async games(user: Identity): Promise<GameSummary[]> {
    this.professor(user)
    return (await this.store.list<Game>('game', user.id)).map((game) => ({
      code: game.code, title: game.title, createdAt: game.createdAt,
      phase: phaseAt(game, this.now()), participantCount: game.participants.length,
    }))
  }

  async create(user: Identity, quizId: unknown) {
    this.professor(user)
    requireValue(typeof quizId === 'string', 400, 'Select a quiz.')
    const quiz = await this.store.get<Quiz>(`quiz:${quizId}`)
    requireValue(quiz && quiz.ownerId === user.id, 404, 'Quiz not found.')
    const code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('')
    const game: Game = {
      code, ownerId: user.id, title: quiz.title, questions: quiz.questions,
      createdAt: new Date(this.now()).toISOString(), participants: [], phase: 'lobby',
      questionIndex: -1, startedAt: null, deadline: null, revision: 0,
    }
    await this.store.create({ id: `game:${code}`, kind: 'game', ownerId: user.id, createdAt: game.createdAt, value: game })
    return viewGame(game, user, this.now())
  }

  async get(code: string, user: Identity) {
    const game = await this.store.get<Game>(`game:${code}`)
    requireValue(game, 404, 'Competition not found. Check the join code.')
    return viewGame(game, user, this.now())
  }

  async join(code: string, user: Identity, displayName: unknown) {
    requireValue(!user.professor, 403, 'Use a student account to join as a competitor.')
    const name = text(displayName, 'Display name', 40)
    return this.store.update<Game, GameView>(`game:${code}`, (game) => {
      const existing = game.participants.find((student) => student.id === user.id)
      if (!existing) {
        requireValue(game.phase === 'lobby', 409, 'This competition has started. Ask the professor to open a new lobby.')
        game.participants.push({ id: user.id, email: user.email, name, answers: [] })
      }
      return viewGame(game, user, this.now())
    })
  }

  async control(code: string, user: Identity, action: unknown, revision: unknown) {
    this.professor(user)
    return this.store.update<Game, GameView>(`game:${code}`, (game) => {
      this.host(game, user)
      requireValue(Number.isInteger(revision) && revision === game.revision, 409, 'Controls changed. Refresh and try again.')
      const now = this.now()
      const phase = phaseAt(game, now)
      if (action === 'start' || action === 'next') {
        requireValue(action === 'start' ? phase === 'lobby' : phase === 'reveal', 409, 'That round cannot be started yet.')
        requireValue(game.participants.length > 0, 409, 'Wait for at least one student to join.')
        if (game.questionIndex + 1 === game.questions.length) {
          game.phase = 'finished'
        } else {
          game.questionIndex++
          game.startedAt = now
          game.deadline = now + game.questions[game.questionIndex].seconds * 1000
          game.phase = 'question'
        }
      } else if (action === 'close') {
        requireValue(phase === 'question', 409, 'This question is already closed.')
        game.phase = 'reveal'
      } else if (action === 'finish') {
        requireValue(phase !== 'finished', 409, 'This competition is already finished.')
        game.phase = 'finished'
      } else {
        requireValue(false, 400, 'Unknown competition action.')
      }
      game.revision++
      return viewGame(game, user, now)
    })
  }

  async answer(code: string, user: Identity, questionId: unknown, choice: unknown) {
    requireValue(typeof choice === 'string' && choices.includes(choice as Choice), 400, 'Choose A, B, C or D.')
    const receivedAt = this.now()
    return this.store.update<Game, GameView>(`game:${code}`, (game) => {
      const student = game.participants.find((entry) => entry.id === user.id)
      requireValue(student, 403, 'Join this competition before answering.')
      const previous = student.answers.find((answer) => answer.questionId === questionId)
      if (previous) {
        requireValue(previous.choice === choice, 409, 'Your answer is locked and cannot be changed.')
        return viewGame(game, user, this.now())
      }
      const question = game.questions[game.questionIndex]
      requireValue(question && question.id === questionId && game.phase === 'question'
        && game.deadline !== null && receivedAt < game.deadline, 409, 'This question is closed. Your answer was not accepted.')
      const remaining = Math.min(1, Math.max(0, (game.deadline - receivedAt) / (question.seconds * 1000)))
      const points = question.correctAnswer === choice ? 500 + Math.round(500 * remaining) : 0
      student.answers.push({ questionId: question.id, choice: choice as Choice, receivedAt, points })
      return viewGame(game, user, this.now())
    })
  }

  async results(code: string, user: Identity) {
    this.professor(user)
    const game = await this.store.get<Game>(`game:${code}`)
    requireValue(game, 404, 'Competition not found.')
    this.host(game, user)
    return exportResults(game)
  }
}
