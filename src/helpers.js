/* ============================================================
   helpers.js — crypto, validation, auth middleware
   ============================================================ */
import crypto from 'node:crypto'
import { one, run, q } from './db.js'

export function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}
export function randHex(n) {
  return crypto.randomBytes(n).toString('hex')
}
export function code6() {
  return String(100000 + crypto.randomInt(900000))
}
export const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|icloud|proton|protonmail|live|msn|aol)\.(com|pk|co\.uk|me)$/i

export function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

/* ---------- auth ---------- */
export async function getUser(c) {
  const auth = c.req.header('Authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return null
  const row = await one(
    `SELECT u.id, u.email, u.name, u.role, u.verified, s.expires
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`, [token])
  if (!row) return null
  if (Number(row.expires) < Date.now()) {
    await run(`DELETE FROM sessions WHERE token = $1`, [token])
    return null
  }
  return row
}
export const STAFF_ROLES = ['admin', 'owner']
export async function requireAdmin(c) {
  const u = await getUser(c)
  if (!u || !STAFF_ROLES.includes(u.role)) return null
  return u
}
export async function requireOwner(c) {
  const u = await getUser(c)
  if (!u || u.role !== 'owner') return null
  return u
}

/* ---------- site settings ---------- */
export const SITE_KEYS = ['site_name', 'site_tagline', 'site_logo_text', 'hero_title', 'hero_accent', 'hero_sub', 'seo_title', 'seo_desc', 'seo_keywords', 'site_services', 'logo_ver']
export async function getSiteSettings() {
  const out = {}
  try {
    const rows = await q(
      `SELECT key, value FROM settings WHERE key = ANY($1)`, [SITE_KEYS])
    for (const r of rows) out[r.key] = String(r.value || '')
  } catch {}
  return out
}
