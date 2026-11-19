import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { SqliteStore } from './sqlite.js'
import { serve } from './runtime.js'

const path = resolve(process.env.LOCAL_DB_PATH || '.data/classroom.sqlite')
await mkdir(dirname(path), { recursive: true })
await serve(new SqliteStore(path), true)
