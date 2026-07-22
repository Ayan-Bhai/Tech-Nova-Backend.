/* ============================================================
   routes-auth.js — signup, verify, login, logout, forgot/reset
   ============================================================ */
import { Hono } from 'hono'
import { one, run } from './db.js'
import { sha256hex, randHex, code6, EMAIL_RE, getUser } from './helpers.js'
import { sendMail, emailHtml } from './mailer.js'

const auth = new Hono()
const DEV_SHOW_CODE = () => process.env.DEV_SHOW_CODE === 'true'

async function makeSession(userId) {
  const token = randHex(24)
  await run(`INSERT INTO sessions (token, user_id, expires) VALUES ($1,$2,$3)`,
    [token, userId, Date.now() + 30 * 24 * 3600 * 1000])
  return token
}

/* signup — NO email verification: account is created verified and
   logged in immediately. A welcome email is attempted in the
   background but never blocks or fails the signup. */
auth.post('/signup', async (c) => {
  const { name, email, password } = await c.req.json().catch(() => ({}))
  if (!name || !email || !password) return c.json({ error: 'All fields are required.' }, 400)
  if (String(password).length < 6) return c.json({ error: 'Password must be at least 6 characters.' }, 400)
  const em = String(email).trim().toLowerCase()
  if (!EMAIL_RE.test(em)) return c.json({ error: 'Please use a popular email provider (Gmail, Yahoo, Outlook…).' }, 400)

  const existing = await one(`SELECT id, verified FROM users WHERE email = $1`, [em])
  if (existing && existing.verified) return c.json({ error: 'This email is already registered. Please log in.' }, 400)

  const salt = randHex(8)
  const hash = sha256hex(salt + password)

  let userId
  if (existing) {
    // leftover unverified signup — take over the row
    await run(`UPDATE users SET name=$1, pass_hash=$2, salt=$3, verified=1, verify_code=NULL, verify_expires=NULL WHERE id=$4`,
      [String(name).trim(), hash, salt, existing.id])
    userId = existing.id
  } else {
    const r = await one(
      `INSERT INTO users (email, name, pass_hash, salt, verified) VALUES ($1,$2,$3,$4,1) RETURNING id`,
      [em, String(name).trim(), hash, salt])
    userId = r.id
  }

  const token = await makeSession(userId)
  const user = await one(`SELECT id::int, email, name, role FROM users WHERE id = $1`, [userId])

  /* fire-and-forget welcome email — never blocks signup */
  sendMail(em, 'Welcome to TechNova 🎉',
    emailHtml('Welcome to TechNova',
      `<p style="margin:0;color:#444;font-size:14px;line-height:1.6">Hi ${String(name).replace(/[<>&]/g, '')}, your account is ready — happy shopping!</p>`))
    .catch(() => {})

  return c.json({ ok: true, token, user })
})

auth.post('/verify', async (c) => {
  const { email, code } = await c.req.json().catch(() => ({}))
  const em = String(email || '').trim().toLowerCase()
  const u = await one(`SELECT id, verify_code, verify_expires FROM users WHERE email = $1 AND verified = 0`, [em])
  if (!u) return c.json({ error: 'No pending signup for this email.' }, 400)
  if (!u.verify_code || String(code).trim() !== u.verify_code) return c.json({ error: 'Wrong code. Check your email and try again.' }, 400)
  if (Number(u.verify_expires) < Date.now()) return c.json({ error: 'Code expired. Sign up again to get a new code.' }, 400)
  await run(`UPDATE users SET verified = 1, verify_code = NULL WHERE id = $1`, [u.id])
  const token = await makeSession(u.id)
  const user = await one(`SELECT id::int, email, name, role FROM users WHERE id = $1`, [u.id])
  return c.json({ ok: true, token, user })
})

auth.post('/forgot', async (c) => {
  const { email } = await c.req.json().catch(() => ({}))
  const em = String(email || '').trim().toLowerCase()
  if (!EMAIL_RE.test(em)) return c.json({ error: 'Enter a valid email address.' }, 400)
  const u = await one(`SELECT id, name FROM users WHERE email = $1 AND verified = 1`, [em])
  if (!u) return c.json({ error: 'No account found with this email.' }, 400)
  const code = code6()
  await run(`UPDATE users SET verify_code = $1, verify_expires = $2 WHERE id = $3`,
    [code, Date.now() + 15 * 60 * 1000, u.id])
  const sent = await sendMail(em, 'Your TechNova password reset code: ' + code,
    emailHtml('Reset your password',
      `<p style="margin:0 0 18px;color:#444;font-size:14px;line-height:1.6">Hi ${String(u.name || '').replace(/[<>&]/g, '')}, use this code to set a new password. It expires in <strong>15 minutes</strong>. If you didn't ask for this, just ignore this email.</p>` +
      `<div style="text-align:center;padding:18px;background:#f6f6f6;border-radius:12px;font-size:32px;font-weight:bold;letter-spacing:10px;color:#111">${code}</div>`))
  const resp = { ok: true, emailSent: sent }
  if (!sent && DEV_SHOW_CODE()) resp.devCode = code
  return c.json(resp)
})

auth.post('/reset', async (c) => {
  const { email, code, password } = await c.req.json().catch(() => ({}))
  const em = String(email || '').trim().toLowerCase()
  if (String(password || '').length < 6) return c.json({ error: 'Password must be at least 6 characters.' }, 400)
  const u = await one(`SELECT id, verify_code, verify_expires FROM users WHERE email = $1 AND verified = 1`, [em])
  if (!u || !u.verify_code || String(code).trim() !== u.verify_code) return c.json({ error: 'Wrong code. Check your email and try again.' }, 400)
  if (Number(u.verify_expires) < Date.now()) return c.json({ error: 'Code expired. Request a new one.' }, 400)
  const salt = randHex(8)
  const hash = sha256hex(salt + password)
  await run(`UPDATE users SET pass_hash = $1, salt = $2, verify_code = NULL WHERE id = $3`, [hash, salt, u.id])
  await run(`DELETE FROM sessions WHERE user_id = $1`, [u.id])
  const token = await makeSession(u.id)
  const user = await one(`SELECT id::int, email, name, role FROM users WHERE id = $1`, [u.id])
  return c.json({ ok: true, token, user })
})

auth.post('/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}))
  const em = String(email || '').trim().toLowerCase()
  const u = await one(`SELECT * FROM users WHERE email = $1`, [em])
  if (!u) return c.json({ error: 'No account with this email.' }, 400)
  const hash = sha256hex(u.salt + password)
  if (hash !== u.pass_hash) return c.json({ error: 'Wrong password.' }, 400)
  /* email verification removed — auto-verify old unverified accounts on successful login */
  if (!u.verified) await run(`UPDATE users SET verified = 1, verify_code = NULL WHERE id = $1`, [u.id])
  const token = await makeSession(u.id)
  return c.json({ ok: true, token, user: { id: Number(u.id), email: u.email, name: u.name, role: u.role } })
})

auth.post('/logout', async (c) => {
  const h = c.req.header('Authorization') || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (token) await run(`DELETE FROM sessions WHERE token = $1`, [token])
  return c.json({ ok: true })
})

auth.get('/me', async (c) => {
  const u = await getUser(c)
  if (!u) return c.json({ user: null })
  return c.json({ user: { id: Number(u.id), email: u.email, name: u.name, role: u.role } })
})

export default auth
