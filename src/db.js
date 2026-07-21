/* ============================================================
   db.js — Supabase Postgres connection pool + tiny helpers
   Set DATABASE_URL to your Supabase connection string:
   postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
   ============================================================ */
import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL env var is not set (Supabase connection string).')
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires SSL; local dev postgres usually doesn't
  ssl: /supabase\.co|supabase\.com|pooler\.supabase/.test(process.env.DATABASE_URL || '')
    ? { rejectUnauthorized: false }
    : false,
  max: 10
})

/** all rows */
export async function q(text, params = []) {
  const r = await pool.query(text, params)
  return r.rows
}

/** first row or null */
export async function one(text, params = []) {
  const r = await pool.query(text, params)
  return r.rows[0] || null
}

/** run, returns full result (rowCount etc.) */
export async function run(text, params = []) {
  return pool.query(text, params)
}

/** run several statements in one transaction */
export async function tx(stmts) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const [text, params] of stmts) await client.query(text, params || [])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/* ---------- settings key-value helpers ---------- */
export async function getSetting(key) {
  try {
    const row = await one(`SELECT value FROM settings WHERE key = $1`, [key])
    return row ? String(row.value || '') : ''
  } catch { return '' }
}
export async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  )
}
