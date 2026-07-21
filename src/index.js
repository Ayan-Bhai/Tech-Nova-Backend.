/* ============================================================
   TechNova backend — Node.js + Hono + Supabase Postgres
   Deploy target: Railway (or any Node host)

   ENV VARS (Railway → Variables):
     DATABASE_URL          required — Supabase connection string
     FRONTEND_URL          required — e.g. https://your-site.netlify.app
                           (CORS allow-origin + Stripe redirect base)
     PORT                  set by Railway automatically
     GMAIL_USER            optional (or set in Admin → Settings)
     GMAIL_APP_PASSWORD    optional (or set in Admin → Settings)
     STRIPE_SECRET_KEY     optional (or set in Admin → Settings)
     DEV_SHOW_CODE         optional 'true' — show codes when email off
   ============================================================ */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import 'dotenv/config'

import authRoutes from './routes-auth.js'
import publicRoutes from './routes-public.js'
import adminRoutes from './routes-admin.js'
import { pool } from './db.js'

const app = new Hono()

app.use('*', logger())

/* ---------- CORS: allow the frontend site(s) ---------- */
const ALLOWED = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean)

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return '*'                          // curl / server-to-server
    if (!ALLOWED.length) return origin               // dev: allow all until FRONTEND_URL is set
    const o = origin.replace(/\/+$/, '')
    if (ALLOWED.includes(o)) return origin
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return origin  // local dev
    return ''                                        // blocked
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}))

/* ---------- health check (Railway) ---------- */
app.get('/', (c) => c.json({ ok: true, service: 'technova-backend', time: new Date().toISOString() }))
app.get('/health', async (c) => {
  try {
    await pool.query('SELECT 1')
    return c.json({ ok: true, db: 'up' })
  } catch (e) {
    return c.json({ ok: false, db: 'down', error: e.message }, 503)
  }
})

/* ---------- routes ---------- */
app.route('/api/auth', authRoutes)
app.route('/', publicRoutes)          // /api/catalog, /api/orders, /api/pay/*, /api/contact, /api/site, /img/:id, /logo
app.route('/api/admin', adminRoutes)

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  console.error('Unhandled:', err)
  return c.json({ error: 'Server error' }, 500)
})

const port = Number(process.env.PORT) || 8080
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`✅ TechNova backend listening on http://0.0.0.0:${info.port}`)
  console.log(`   CORS allowed origins: ${ALLOWED.length ? ALLOWED.join(', ') : '(all — set FRONTEND_URL in production!)'}`)
})
