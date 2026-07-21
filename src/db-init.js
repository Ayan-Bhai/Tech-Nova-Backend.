/* Run schema.sql against DATABASE_URL: npm run db:init */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pool } from './db.js'

const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql'), 'utf8')

try {
  await pool.query(sql)
  console.log('✅ Schema + seed applied successfully.')
} catch (e) {
  console.error('❌ db:init failed:', e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
