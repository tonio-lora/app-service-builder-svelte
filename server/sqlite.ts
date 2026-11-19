import { DatabaseSync } from 'node:sqlite'
import { HttpError } from './errors.js'
import type { Store, StoredRecord } from './store.js'

export class SqliteStore implements Store {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ClassroomRecords (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, ownerId TEXT NOT NULL,
        createdAt TEXT NOT NULL, payload TEXT NOT NULL
      );`)
  }

  async get<T>(id: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT payload FROM ClassroomRecords WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.payload)) : undefined
  }

  async list<T>(kind: StoredRecord['kind'], ownerId: string): Promise<T[]> {
    return this.db.prepare(
      'SELECT payload FROM ClassroomRecords WHERE kind = ? AND ownerId = ? ORDER BY createdAt DESC',
    ).all(kind, ownerId).map((row) => JSON.parse(String(row.payload)))
  }

  async create<T>(record: StoredRecord<T>) {
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO ClassroomRecords (id, kind, ownerId, createdAt, payload) VALUES (?, ?, ?, ?, ?)',
    ).run(record.id, record.kind, record.ownerId, record.createdAt, JSON.stringify(record.value))
    if (!result.changes) throw new HttpError(409, 'This record already exists. Please try again.')
  }

  async update<T, R>(id: string, change: (value: T) => R): Promise<R> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT payload FROM ClassroomRecords WHERE id = ?').get(id)
      if (!row) throw new HttpError(404, 'Competition not found. Check the join code.')
      const value: T = JSON.parse(String(row.payload))
      const result = change(value)
      this.db.prepare('UPDATE ClassroomRecords SET payload = ? WHERE id = ?').run(JSON.stringify(value), id)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async health() {
    this.db.prepare('SELECT id FROM ClassroomRecords LIMIT 1').all()
  }

  async close() {
    this.db.close()
  }
}
