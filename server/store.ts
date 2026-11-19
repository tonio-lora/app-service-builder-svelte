export interface StoredRecord<T = unknown> {
  id: string
  kind: 'quiz' | 'game'
  ownerId: string
  createdAt: string
  value: T
}

export interface Store {
  get<T>(id: string): Promise<T | undefined>
  list<T>(kind: StoredRecord['kind'], ownerId: string): Promise<T[]>
  create<T>(record: StoredRecord<T>): Promise<void>
  update<T, R>(id: string, change: (value: T) => R): Promise<R>
  health(): Promise<void>
  close(): Promise<void>
}
