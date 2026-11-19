import { AzureSqlStore } from './azure-sql.js'
import { serve } from './runtime.js'

if (!process.env.SQL_SERVER || !process.env.SQL_DATABASE) {
  throw new Error('SQL_SERVER and SQL_DATABASE are required. Use npm run dev for the local SQLite demo.')
}
await serve(new AzureSqlStore(process.env.SQL_SERVER, process.env.SQL_DATABASE), false)
