import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const destination = process.env.DESTINATION_DIR
if (!destination || resolve(destination) === process.cwd()) {
  throw new Error('Builder must supply a separate DESTINATION_DIR for the runnable artifact.')
}
await mkdir(destination, { recursive: true })
for (const name of ['build', 'dist', 'package.json', 'package-lock.json']) {
  await cp(name, resolve(destination, name), { recursive: true })
}
