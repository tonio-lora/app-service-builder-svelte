export type Choice = 'A' | 'B' | 'C' | 'D'
export type Phase = 'lobby' | 'question' | 'reveal' | 'finished'

export interface Identity {
  id: string
  email: string
  name: string
  professor: boolean
  development: boolean
}

export interface Question {
  id: string
  text: string
  options: Record<Choice, string>
  correctAnswer: Choice
  seconds: number
}

export interface Quiz {
  id: string
  title: string
  ownerId: string
  createdAt: string
  questions: Question[]
}

export interface Answer {
  questionId: string
  choice: Choice
  receivedAt: number
  points: number
}

export interface Participant {
  id: string
  email: string
  name: string
  answers: Answer[]
}

export interface Game {
  code: string
  ownerId: string
  title: string
  createdAt: string
  questions: Question[]
  participants: Participant[]
  phase: Phase
  questionIndex: number
  startedAt: number | null
  deadline: number | null
  revision: number
}

export interface QuizSummary {
  id: string
  title: string
  createdAt: string
  questionCount: number
}

export interface GameSummary {
  code: string
  title: string
  createdAt: string
  phase: Phase
  participantCount: number
}

export interface GameView extends GameSummary {
  serverNow: number
  revision: number
  isHost: boolean
  joined: boolean
  questionNumber: number
  questionCount: number
  deadline: number | null
  answeredCount: number
  question: Omit<Question, 'correctAnswer'> | null
  correctAnswer: Choice | null
  submittedChoice: Choice | null
  leaderboard: { rank: number; name: string; points: number; isMe: boolean }[]
  roster: { name: string; email: string; answered: boolean }[]
}
