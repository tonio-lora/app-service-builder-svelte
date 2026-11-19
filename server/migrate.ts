import { readFile } from 'node:fs/promises'
import { AzureSqlStore } from './azure-sql.js'

if (!process.env.SQL_SERVER || !process.env.SQL_DATABASE) {
  throw new Error('Set SQL_SERVER and SQL_DATABASE before migrating Azure SQL.')
}
const store = new AzureSqlStore(process.env.SQL_SERVER, process.env.SQL_DATABASE, true)
try {
  await store.migrate(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
  console.log('Azure SQL schema is ready. No sample records were inserted.')
} finally {
  await store.close()
}
