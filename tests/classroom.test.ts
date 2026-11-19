import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Game, Identity } from '../src/lib/types.js'
import { Classroom, exportResults, importQuiz } from '../server/quiz.js'
import { SqliteStore } from '../server/sqlite.js'

const professor: Identity = {
  id: 'professor-id', email: 'professor@iastate.edu', name: 'Professor', professor: true, development: false,
}
const student = (index: number): Identity => ({
  id: `student-${index}`, email: `student${index}@iastate.edu`, name: `Student ${index}`, professor: false, development: false,
})
const header = 'question,option_a,option_b,option_c,option_d,correct_answer,time_limit_seconds'
const csv = `${header}\n"Question, one?",Alpha,Beta,Gamma,Delta,A,10\nQuestion two?,One,Two,Three,Four,B,5`

test('CSV import accepts spreadsheet quoting and rejects malformed or unsafe question banks', () => {
  const quiz = importQuiz(' First class ', '\uFEFF' + csv.replaceAll('\n', '\r\n'), professor.id)
  assert.equal(quiz.title, 'First class')
  assert.equal(quiz.questions[0].text, 'Question, one?')
  assert.equal(quiz.questions[0].options.A, 'Alpha')
  for (const invalid of [
    header,
    csv.replace('correct_answer', 'option_a'),
    csv.replace('question,', '__proto__,'),
    csv.replace(',A,10', ',E,10'),
    csv.replace(',A,10', ',A,4'),
    csv.replace(',A,10', ',A,121'),
    csv.replace(',A,10', ',A,1e1'),
    csv.replace(',Alpha,', ',,'),
    csv.replace('Alpha,Beta,Gamma,Delta', 'Alpha,Beta,Gamma,Delta,Extra'),
    `${header}\n${Array(101).fill('Q,A,B,C,D,A,10').join('\n')}`,
    'x'.repeat(512001),
  ]) assert.throws(() => importQuiz('Quiz', invalid, professor.id), { status: 400 })
  assert.throws(() => importQuiz('', csv, professor.id), { status: 400 })
})

test('50-student competition enforces server timing, locking, hidden scores, controls and saved results', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'classroom-test-'))
  const dbPath = join(folder, 'classroom.sqlite')
  let store = new SqliteStore(dbPath)
  t.after(async () => { await store.close(); await rm(folder, { recursive: true }) })
  let now = 100000
  let classroom = new Classroom(store, () => now)
  const quiz = await classroom.upload(professor, 'Class competition', csv)
  const lobby = await classroom.create(professor, quiz.id)
  const students = Array.from({ length: 50 }, (_, index) => student(index))
  const joins = await Promise.all(students.map((user) => classroom.join(lobby.code, user, user.name)))
  assert.equal(joins.at(-1)?.participantCount, 50)
  const duplicateJoin = await classroom.join(lobby.code, students[0], 'Changed name')
  assert.equal(duplicateJoin.participantCount, 50)
  await assert.rejects(classroom.control(lobby.code, students[0], 'start', 0), { status: 403 })
  const started = await classroom.control(lobby.code, professor, 'start', 0)
  assert.equal(started.deadline, now + 10000)
  await assert.rejects(classroom.join(lobby.code, student(51), 'Late join'), { status: 409 })
  await assert.rejects(classroom.control(lobby.code, professor, 'next', started.revision), { status: 409 })
  now += 1000
  const questionId = started.question!.id
  const responses = await Promise.all(students.slice(0, 49).map((user, index) =>
    classroom.answer(lobby.code, user, questionId, index % 2 === 0 ? 'A' : 'B')))
  assert.equal(responses.at(-1)?.answeredCount, 49)
  const hidden = await classroom.get(lobby.code, students[0])
  assert.equal(hidden.correctAnswer, null)
  assert.equal(hidden.leaderboard.every((entry) => entry.points === 0), true)
  assert.equal(hidden.roster.length, 0)
  assert.equal(JSON.stringify(hidden).includes('student1@iastate.edu'), false)
  assert.equal('correctAnswer' in hidden.question!, false)
  await assert.rejects(classroom.answer(lobby.code, students[0], questionId, 'B'), { status: 409 })
  assert.equal((await classroom.answer(lobby.code, students[0], questionId, 'A')).answeredCount, 49)
  now = started.deadline!
  await assert.rejects(classroom.answer(lobby.code, students[49], questionId, 'A'), { status: 409 })
  const reveal = await classroom.get(lobby.code, students[0])
  assert.equal(reveal.phase, 'reveal')
  assert.equal(reveal.correctAnswer, 'A')
  assert.equal(reveal.leaderboard.find((entry) => entry.isMe)?.points, 950)
  assert.equal(reveal.leaderboard.filter((entry) => entry.points === 950).length, 25)
  const next = await classroom.control(lobby.code, professor, 'next', started.revision)
  await assert.rejects(classroom.control(lobby.code, professor, 'next', started.revision), { status: 409 })
  await assert.rejects(classroom.answer(lobby.code, students[49], questionId, 'A'), { status: 409 })
  await store.close()
  store = new SqliteStore(dbPath)
  classroom = new Classroom(store, () => now)
  const restored = await classroom.get(lobby.code, students[0])
  assert.equal(restored.question?.id, next.question?.id)
  assert.equal(restored.leaderboard.find((entry) => entry.isMe)?.points, 950)
  now += 2500
  await classroom.answer(lobby.code, students[0], next.question!.id, 'B')
  const closed = await classroom.control(lobby.code, professor, 'close', next.revision)
  assert.equal(closed.correctAnswer, 'B')
  await assert.rejects(classroom.answer(lobby.code, students[1], next.question!.id, 'B'), { status: 409 })
  const finished = await classroom.control(lobby.code, professor, 'next', closed.revision)
  assert.equal(finished.phase, 'finished')
  assert.equal(finished.leaderboard[0].points, 1700)
  assert.equal(finished.leaderboard[0].name, students[0].name)
  const results = await classroom.results(lobby.code, professor)
  assert.match(results, /student0@iastate.edu/)
  assert.match(results, /"950"/)
  assert.equal(results.split('\r\n').length, 102)
  await assert.rejects(classroom.results(lobby.code, students[0]), { status: 403 })
  const anotherProfessor = { ...professor, id: 'another-professor' }
  await assert.rejects(classroom.results(lobby.code, anotherProfessor), { status: 403 })
  assert.deepEqual(await classroom.games(anotherProfessor), [])
})

test('invalid actions roll back and do not change another professor’s competition', async (t) => {
  const store = new SqliteStore(':memory:')
  t.after(() => store.close())
  const classroom = new Classroom(store, () => 100)
  await assert.rejects(classroom.upload(student(1), 'Quiz', csv), { status: 403 })
  const quiz = await classroom.upload(professor, 'Quiz', csv)
  const lobby = await classroom.create(professor, quiz.id)
  await assert.rejects(classroom.control(lobby.code, professor, 'start', 0), { status: 409 })
  await assert.rejects(classroom.control(lobby.code, { ...professor, id: 'other' }, 'finish', 0), { status: 403 })
  assert.equal((await classroom.get(lobby.code, professor)).phase, 'lobby')
  await assert.rejects(classroom.get(lobby.code, student(2)), { status: 403 })
  await assert.rejects(store.update<Game, void>(`game:${lobby.code}`, (game) => {
    game.title = 'Not committed'
    throw new Error('Failure during update')
  }), /Failure during update/)
  assert.equal((await classroom.get(lobby.code, professor)).title, 'Quiz')
})

test('CSV exports neutralize spreadsheet formulas in names and question text', () => {
  const quiz = importQuiz('Quiz', csv, professor.id)
  const game: Game = {
    code: 'ABC234', ownerId: professor.id, title: 'Quiz', createdAt: '', questions: quiz.questions,
    phase: 'finished', questionIndex: 0, startedAt: null, deadline: null, revision: 1,
    participants: [{ id: '1', name: '=HYPERLINK("https://example.org")', email: 'student@iastate.edu', answers: [] }],
  }
  const results = exportResults(game)
  assert.match(results, /"\'=HYPERLINK\(""https:\/\/example.org""\)"/)
  assert.match(results, /"Question, one\?"/)
})
