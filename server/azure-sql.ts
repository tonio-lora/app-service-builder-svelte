import sql from 'mssql'
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity'
import { HttpError } from './errors.js'
import type { Store, StoredRecord } from './store.js'

interface PoolLease {
  pool: sql.ConnectionPool
  expiresAt: number
  users: number
  retired: boolean
}

export class AzureSqlStore implements Store {
  private credential
  private current?: Promise<PoolLease>

  constructor(private server: string, private database: string, migration = false) {
    this.credential = migration
      ? new DefaultAzureCredential()
      : new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID
        ? { clientId: process.env.AZURE_CLIENT_ID } : {})
  }

  private async open(): Promise<PoolLease> {
    const token = await this.credential.getToken('https://database.windows.net/.default')
    const pool = new sql.ConnectionPool({
      server: this.server,
      database: this.database,
      authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
      options: { encrypt: true, trustServerCertificate: false, abortTransactionOnError: true },
      pool: { max: 16, min: 0, idleTimeoutMillis: 30000 },
      connectionTimeout: 15000,
      requestTimeout: 15000,
    })
    pool.on('error', () => console.error('Azure SQL pool connection failed. Check identity and network access.'))
    await pool.connect()
    return { pool, expiresAt: token.expiresOnTimestamp, users: 0, retired: false }
  }

  private async use<T>(action: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
    this.current ??= this.open()
    const pending = this.current
    let lease: PoolLease
    try {
      lease = await pending
    } catch (error) {
      if (this.current === pending) this.current = undefined
      throw error
    }
    if (lease.expiresAt - Date.now() < 120000) {
      if (this.current === pending) {
        this.current = this.open()
        lease.retired = true
        if (!lease.users) await lease.pool.close()
      }
      return this.use(action)
    }
    lease.users++
    try {
      return await action(lease.pool)
    } finally {
      lease.users--
      if (lease.retired && !lease.users) await lease.pool.close()
    }
  }

  async get<T>(id: string): Promise<T | undefined> {
    return this.use(async (pool) => {
      const result = await pool.request().input('id', sql.NVarChar(100), id)
        .query<{ payload: string }>('SELECT payload FROM dbo.ClassroomRecords WHERE id = @id')
      return result.recordset[0] ? JSON.parse(result.recordset[0].payload) : undefined
    })
  }

  async list<T>(kind: StoredRecord['kind'], ownerId: string): Promise<T[]> {
    return this.use(async (pool) => {
      const result = await pool.request().input('kind', sql.NVarChar(10), kind)
        .input('ownerId', sql.NVarChar(200), ownerId)
        .query<{ payload: string }>(`SELECT payload FROM dbo.ClassroomRecords
          WHERE kind = @kind AND ownerId = @ownerId ORDER BY createdAt DESC`)
      return result.recordset.map((row) => JSON.parse(row.payload))
    })
  }

  async create<T>(record: StoredRecord<T>) {
    await this.use(async (pool) => {
      try {
        await pool.request().input('id', sql.NVarChar(100), record.id)
          .input('kind', sql.NVarChar(10), record.kind).input('ownerId', sql.NVarChar(200), record.ownerId)
          .input('createdAt', sql.NVarChar(30), record.createdAt)
          .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(record.value))
          .query(`INSERT INTO dbo.ClassroomRecords (id, kind, ownerId, createdAt, payload)
            VALUES (@id, @kind, @ownerId, @createdAt, @payload)`)
      } catch (error) {
        if (error instanceof sql.RequestError && error.number !== undefined && [2601, 2627].includes(error.number)) {
          throw new HttpError(409, 'This record already exists. Please try again.')
        }
        throw error
      }
    })
  }

  async update<T, R>(id: string, change: (value: T) => R): Promise<R> {
    return this.use(async (pool) => {
      const transaction = new sql.Transaction(pool)
      let rolledBack = false
      transaction.on('rollback', () => { rolledBack = true })
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE)
      try {
        // Lock the competition row through the entire read/validate/write operation.
        const row = await new sql.Request(transaction).input('id', sql.NVarChar(100), id)
          .query<{ payload: string }>('SELECT payload FROM dbo.ClassroomRecords WITH (UPDLOCK, HOLDLOCK) WHERE id = @id')
        if (!row.recordset[0]) throw new HttpError(404, 'Competition not found. Check the join code.')
        const value: T = JSON.parse(row.recordset[0].payload)
        const result = change(value)
        await new sql.Request(transaction).input('id', sql.NVarChar(100), id)
          .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(value))
          .query('UPDATE dbo.ClassroomRecords SET payload = @payload WHERE id = @id')
        await transaction.commit()
        return result
      } catch (error) {
        if (!rolledBack) await transaction.rollback()
        throw error
      }
    })
  }

  async health() {
    await this.use(async (pool) => { await pool.request().query('SELECT TOP (1) id FROM dbo.ClassroomRecords') })
  }

  async migrate(schema: string) {
    await this.use(async (pool) => { await pool.request().batch(schema) })
  }

  async close() {
    if (this.current) await (await this.current).pool.close()
  }
}
