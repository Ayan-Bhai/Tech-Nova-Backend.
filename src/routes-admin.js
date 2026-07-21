/* ============================================================
   routes-admin.js — stats, products, categories, orders, users,
   coupons, analytics, images, messages, settings, site identity
   All routes require admin/owner (server-enforced).
   ============================================================ */
import { Hono } from 'hono'
import { q, one, run, tx, getSetting, setSetting } from './db.js'
import { requireAdmin, requireOwner, getSiteSettings } from './helpers.js'
import { sendMail, emailHtml, mailConfig } from './mailer.js'

const admin = new Hono()

/* gate every route in this router */
admin.use('*', async (c, next) => {
  const a = await requireAdmin(c)
  if (!a) return c.json({ error: 'Admin only.' }, 403)
  c.set('staff', a)
  await next()
})

/* ---------- stats ---------- */
admin.get('/stats', async (c) => {
  const [users, products, orders, msgs, revenue] = await Promise.all([
    one(`SELECT COUNT(*)::int n FROM users WHERE role='customer'`),
    one(`SELECT COUNT(*)::int n FROM products WHERE active=1`),
    one(`SELECT COUNT(*)::int n FROM orders`),
    one(`SELECT COUNT(*)::int n FROM messages WHERE read=0`),
    one(`SELECT COALESCE(SUM(total),0)::bigint n FROM orders WHERE status IN ('confirmed','delivered')`)
  ])
  return c.json({ users: users.n, products: products.n, orders: orders.n, unread: msgs.n, revenue: Number(revenue.n) })
})

/* ---------- products ---------- */
admin.get('/products', async (c) => {
  const products = await q(
    `SELECT p.*, c.name AS category,
       (SELECT COUNT(*)::int FROM product_images pi WHERE pi.product_id = p.id) AS img_count
     FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.pinned DESC, p.sort, p.id`)
  for (const p of products) { p.id = Number(p.id); if (p.category_id) p.category_id = Number(p.category_id) }
  return c.json({ products })
})
admin.post('/products', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  if (!b.name || !b.price) return c.json({ error: 'Name and price are required.' }, 400)
  const r = await one(
    `INSERT INTO products (name, category_id, price, old_price, badge, icon, descr, stock, pinned, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1) RETURNING id`,
    [b.name, b.category_id || null, Number(b.price), b.old_price ? Number(b.old_price) : null,
     b.badge || null, b.icon || 'laptop', b.descr || '', Number(b.stock) || 0, b.pinned ? 1 : 0])
  return c.json({ ok: true, id: Number(r.id) })
})
admin.put('/products/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json().catch(() => ({}))
  await run(
    `UPDATE products SET name=$1, category_id=$2, price=$3, old_price=$4, badge=$5, icon=$6, descr=$7, stock=$8, pinned=$9, active=$10 WHERE id=$11`,
    [b.name, b.category_id || null, Number(b.price), b.old_price ? Number(b.old_price) : null,
     b.badge || null, b.icon || 'laptop', b.descr || '', Number(b.stock) || 0, b.pinned ? 1 : 0, b.active === 0 ? 0 : 1, id])
  return c.json({ ok: true })
})
admin.delete('/products/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await run(`DELETE FROM product_images WHERE product_id = $1`, [id])
  await run(`DELETE FROM products WHERE id = $1`, [id])
  const banner = Number(await getSetting('banner_product'))
  if (banner === id) await setSetting('banner_product', '')
  return c.json({ ok: true })
})
admin.put('/products/:id/pin', async (c) => {
  const { pinned } = await c.req.json().catch(() => ({}))
  await run(`UPDATE products SET pinned = $1 WHERE id = $2`, [pinned ? 1 : 0, Number(c.req.param('id'))])
  return c.json({ ok: true })
})

/* ---------- banner ---------- */
admin.put('/banner', async (c) => {
  const { product_id } = await c.req.json().catch(() => ({}))
  const id = Number(product_id) || 0
  if (id) {
    const p = await one(`SELECT id FROM products WHERE id = $1 AND active = 1`, [id])
    if (!p) return c.json({ error: 'Product not found.' }, 404)
  }
  await setSetting('banner_product', id ? String(id) : '')
  return c.json({ ok: true })
})

/* ---------- reorder ---------- */
admin.put('/reorder/products', async (c) => {
  const { ids } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: 'ids required.' }, 400)
  await tx(ids.map((id, i) => [`UPDATE products SET sort = $1 WHERE id = $2`, [i, Number(id)]]))
  return c.json({ ok: true })
})
admin.put('/reorder/categories', async (c) => {
  const { ids } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: 'ids required.' }, 400)
  await tx(ids.map((id, i) => [`UPDATE categories SET sort = $1 WHERE id = $2`, [i, Number(id)]]))
  return c.json({ ok: true })
})

/* ---------- coupons ---------- */
admin.get('/coupons', async (c) => {
  const coupons = await q(`SELECT * FROM coupons ORDER BY id DESC`)
  for (const cp of coupons) cp.id = Number(cp.id)
  return c.json({ coupons })
})
admin.post('/coupons', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '')
  const percent = Math.round(Number(b.percent))
  if (!code || code.length < 3) return c.json({ error: 'Code must be at least 3 letters/numbers.' }, 400)
  if (!(percent >= 1 && percent <= 90)) return c.json({ error: 'Percent must be 1–90.' }, 400)
  const expires = b.expires_at ? String(b.expires_at) + ' 23:59:59+00' : null
  try {
    const r = await one(
      `INSERT INTO coupons (code, percent, min_total, max_uses, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [code, percent, Math.max(0, Number(b.min_total) || 0), Math.max(0, Number(b.max_uses) || 0), expires])
    return c.json({ ok: true, id: Number(r.id) })
  } catch { return c.json({ error: 'That code already exists.' }, 400) }
})
admin.put('/coupons/:id', async (c) => {
  const { active } = await c.req.json().catch(() => ({}))
  await run(`UPDATE coupons SET active = $1 WHERE id = $2`, [active ? 1 : 0, Number(c.req.param('id'))])
  return c.json({ ok: true })
})
admin.delete('/coupons/:id', async (c) => {
  await run(`DELETE FROM coupons WHERE id = $1`, [Number(c.req.param('id'))])
  return c.json({ ok: true })
})

/* ---------- analytics ---------- */
admin.get('/analytics', async (c) => {
  const year = c.req.query('year') || ''
  const month = c.req.query('month') || ''
  const day = c.req.query('day') || ''
  let start, end, group, labelFmt
  if (year && month && day) {
    const d = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    start = d + ' 00:00:00'; end = d + ' 23:59:59'
    group = `to_char(created_at, 'HH24')`; labelFmt = 'hour'
  } else if (year && month) {
    const m = month.padStart(2, '0')
    start = `${year}-${m}-01 00:00:00`
    const nextM = Number(month) === 12 ? `${Number(year) + 1}-01` : `${year}-${String(Number(month) + 1).padStart(2, '0')}`
    end = `${nextM}-01 00:00:00`
    group = `to_char(created_at, 'DD')`; labelFmt = 'day'
  } else {
    const y = year || String(new Date().getFullYear())
    start = `${y}-01-01 00:00:00`; end = `${Number(y) + 1}-01-01 00:00:00`
    group = `to_char(created_at, 'MM')`; labelFmt = 'month'
  }
  const [series, totals, itemsRows, byStatus, years] = await Promise.all([
    q(`SELECT ${group} AS k, COUNT(*)::int AS orders, COALESCE(SUM(total),0)::bigint AS revenue,
          COALESCE(SUM(CASE WHEN status IN ('confirmed','delivered') THEN total ELSE 0 END),0)::bigint AS confirmed_revenue
       FROM orders WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY k ORDER BY k`, [start, end]),
    one(`SELECT COUNT(*)::int AS orders, COALESCE(SUM(total),0)::bigint AS revenue,
            COALESCE(SUM(discount),0)::bigint AS discounts,
            COALESCE(SUM(CASE WHEN status IN ('confirmed','delivered') THEN total ELSE 0 END),0)::bigint AS confirmed_revenue,
            COALESCE(SUM(CASE WHEN pay_status='paid' THEN total ELSE 0 END),0)::bigint AS paid_online,
            COALESCE(AVG(total),0)::float AS avg_order
         FROM orders WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, [start, end]),
    q(`SELECT items FROM orders WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, [start, end]),
    q(`SELECT status, COUNT(*)::int AS n FROM orders WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY status`, [start, end]),
    q(`SELECT DISTINCT to_char(created_at, 'YYYY') AS y FROM orders ORDER BY y DESC`)
  ])
  for (const s of series) { s.revenue = Number(s.revenue); s.confirmed_revenue = Number(s.confirmed_revenue) }
  const t = { ...totals, revenue: Number(totals.revenue), discounts: Number(totals.discounts), confirmed_revenue: Number(totals.confirmed_revenue), paid_online: Number(totals.paid_online) }
  const agg = {}
  for (const row of itemsRows) {
    try {
      for (const i of JSON.parse(row.items)) {
        const k = String(i.product_id || i.name)
        agg[k] = agg[k] || { name: i.name, qty: 0, revenue: 0 }
        agg[k].qty += i.qty; agg[k].revenue += i.price * i.qty
      }
    } catch {}
  }
  const topProducts = Object.values(agg).sort((x, y) => y.revenue - x.revenue).slice(0, 8)
  return c.json({ labelFmt, series, totals: t, topProducts, byStatus, years: years.map(r => r.y) })
})

/* ---------- categories ---------- */
admin.post('/categories', async (c) => {
  const { name } = await c.req.json().catch(() => ({}))
  if (!name) return c.json({ error: 'Name required.' }, 400)
  try {
    const r = await one(`INSERT INTO categories (name, sort) VALUES ($1, (SELECT COALESCE(MAX(sort),0)+1 FROM categories)) RETURNING id`, [String(name).trim()])
    return c.json({ ok: true, id: Number(r.id) })
  } catch { return c.json({ error: 'Category already exists.' }, 400) }
})
admin.put('/categories/:id', async (c) => {
  const { name } = await c.req.json().catch(() => ({}))
  await run(`UPDATE categories SET name = $1 WHERE id = $2`, [String(name).trim(), Number(c.req.param('id'))])
  return c.json({ ok: true })
})
admin.delete('/categories/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await run(`UPDATE products SET category_id = NULL WHERE category_id = $1`, [id])
  await run(`DELETE FROM categories WHERE id = $1`, [id])
  return c.json({ ok: true })
})

/* ---------- users ---------- */
admin.get('/users', async (c) => {
  const a = c.get('staff')
  const users = await q(`SELECT id, email, name, role, verified, created_at FROM users ORDER BY id DESC LIMIT 200`)
  for (const u of users) u.id = Number(u.id)
  return c.json({ users, me: { id: Number(a.id), role: a.role } })
})
admin.delete('/users/:id', async (c) => {
  const a = c.get('staff')
  const id = Number(c.req.param('id'))
  if (id === Number(a.id)) return c.json({ error: 'You cannot delete yourself.' }, 400)
  const target = await one(`SELECT id, role FROM users WHERE id = $1`, [id])
  if (!target) return c.json({ error: 'User not found.' }, 404)
  if (target.role === 'owner') return c.json({ error: 'The owner account cannot be deleted.' }, 400)
  if (target.role === 'admin' && a.role !== 'owner') return c.json({ error: 'Only the owner can delete an admin.' }, 403)
  await run(`DELETE FROM sessions WHERE user_id = $1`, [id])
  await run(`DELETE FROM users WHERE id = $1`, [id])
  return c.json({ ok: true })
})
admin.put('/users/:id/role', async (c) => {
  const a = await requireOwner(c)
  if (!a) return c.json({ error: 'Only the owner can change user roles.' }, 403)
  const id = Number(c.req.param('id'))
  const { role } = await c.req.json().catch(() => ({}))
  if (!['customer', 'admin', 'owner'].includes(role)) return c.json({ error: 'Role must be customer, admin or owner.' }, 400)
  if (id === Number(a.id)) return c.json({ error: 'You cannot change your own role.' }, 400)
  const target = await one(`SELECT id, role, verified FROM users WHERE id = $1`, [id])
  if (!target) return c.json({ error: 'User not found.' }, 404)
  if (!target.verified && role !== 'customer') return c.json({ error: 'User must verify their email before being promoted.' }, 400)
  if (role === 'owner') {
    await tx([
      [`UPDATE users SET role = 'admin' WHERE id = $1`, [a.id]],
      [`UPDATE users SET role = 'owner' WHERE id = $1`, [id]]
    ])
    return c.json({ ok: true, transferred: true })
  }
  await run(`UPDATE users SET role = $1 WHERE id = $2`, [role, id])
  if (role === 'customer') await run(`DELETE FROM sessions WHERE user_id = $1`, [id])
  return c.json({ ok: true })
})

/* ---------- orders ---------- */
admin.get('/orders', async (c) => {
  const orders = await q(
    `SELECT o.*, u.email AS user_email FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 200`)
  for (const o of orders) o.id = Number(o.id)
  return c.json({ orders })
})
admin.put('/orders/:id', async (c) => {
  const { status } = await c.req.json().catch(() => ({}))
  if (!['pending', 'confirmed', 'delivered', 'cancelled'].includes(status)) return c.json({ error: 'Bad status.' }, 400)
  const id = Number(c.req.param('id'))
  await run(`UPDATE orders SET status = $1 WHERE id = $2`, [status, id])
  const o = await one(`SELECT o.code, o.total, u.email, u.name FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [id])
  if (o && o.email) {
    const nice = { pending: 'is pending review', confirmed: 'has been confirmed ✔', delivered: 'has been delivered 📦', cancelled: 'was cancelled' }
    ;(async () => {
      try {
        await sendMail(o.email, 'Order ' + o.code + ' ' + status + ' — TechNova',
          emailHtml('Order update',
            `<p style="margin:0 0 14px;color:#444;font-size:14px;line-height:1.6">Hi ${String(o.name || '').replace(/[<>&]/g, '')}, your order <strong>${o.code}</strong> (Rs ${Number(o.total).toLocaleString('en-PK')}) ${nice[status]}.</p>` +
            `<p style="margin:0;color:#777;font-size:13px">Questions? Just reply to this email or message us on WhatsApp.</p>`))
      } catch (e) { console.error('status mail:', e.message) }
    })()
  }
  return c.json({ ok: true })
})

/* ---------- product images ---------- */
admin.get('/products/:id/images', async (c) => {
  const images = await q(`SELECT id, mime, sort FROM product_images WHERE product_id = $1 ORDER BY sort, id`, [Number(c.req.param('id'))])
  for (const im of images) im.id = Number(im.id)
  return c.json({ images })
})
admin.post('/products/:id/images', async (c) => {
  const pid = Number(c.req.param('id'))
  const prod = await one(`SELECT id FROM products WHERE id = $1`, [pid])
  if (!prod) return c.json({ error: 'Product not found.' }, 404)
  const { images } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(images) || !images.length) return c.json({ error: 'No images.' }, 400)
  const existing = await one(`SELECT COUNT(*)::int n FROM product_images WHERE product_id = $1`, [pid])
  if ((existing.n || 0) + images.length > 8) return c.json({ error: 'Max 8 images per product.' }, 400)
  let added = 0
  for (const im of images.slice(0, 8)) {
    const m = String(im.data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/)
    if (!m) continue
    if (m[2].length > 1_400_000) return c.json({ error: 'One image is too large (max ~1 MB).' }, 400)
    await run(
      `INSERT INTO product_images (product_id, mime, data, sort)
       VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort),0)+1 FROM product_images WHERE product_id = $1))`,
      [pid, m[1], m[2]])
    added++
  }
  if (!added) return c.json({ error: 'No valid images (use JPG/PNG/WebP).' }, 400)
  return c.json({ ok: true, added })
})
admin.delete('/images/:id', async (c) => {
  await run(`DELETE FROM product_images WHERE id = $1`, [Number(c.req.param('id'))])
  return c.json({ ok: true })
})
admin.put('/images/:id/cover', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await one(`SELECT product_id FROM product_images WHERE id = $1`, [id])
  if (!row) return c.json({ error: 'Not found.' }, 404)
  await run(`UPDATE product_images SET sort = sort + 1 WHERE product_id = $1`, [row.product_id])
  await run(`UPDATE product_images SET sort = 0 WHERE id = $1`, [id])
  return c.json({ ok: true })
})

/* ---------- messages ---------- */
admin.get('/messages', async (c) => {
  const messages = await q(`SELECT * FROM messages ORDER BY id DESC LIMIT 200`)
  for (const m of messages) m.id = Number(m.id)
  return c.json({ messages })
})
admin.put('/messages/:id/read', async (c) => {
  await run(`UPDATE messages SET read = 1 WHERE id = $1`, [Number(c.req.param('id'))])
  return c.json({ ok: true })
})

/* ---------- settings (email + stripe) ---------- */
admin.get('/settings', async (c) => {
  const user = await getSetting('gmail_user') || process.env.GMAIL_USER || ''
  const pass = await getSetting('gmail_pass') || process.env.GMAIL_APP_PASSWORD || ''
  const sk = await getSetting('stripe_sk') || process.env.STRIPE_SECRET_KEY || ''
  const banner = Number(await getSetting('banner_product')) || null
  return c.json({ gmail_user: user, gmail_pass_set: !!pass, stripe_set: !!sk, banner_product: banner })
})
admin.put('/settings', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  if (typeof b.gmail_user === 'string') {
    const gu = b.gmail_user.trim().toLowerCase()
    if (gu && !/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(gu)) return c.json({ error: 'Must be a @gmail.com address.' }, 400)
    await setSetting('gmail_user', gu)
  }
  if (typeof b.gmail_pass === 'string' && b.gmail_pass.trim()) {
    await setSetting('gmail_pass', b.gmail_pass.trim())
  }
  if (typeof b.stripe_sk === 'string' && b.stripe_sk.trim()) {
    const sk = b.stripe_sk.trim()
    if (!/^(sk_test_|sk_live_|rk_test_|rk_live_)/.test(sk)) return c.json({ error: 'Stripe key must start with sk_test_ or sk_live_.' }, 400)
    await setSetting('stripe_sk', sk)
  }
  return c.json({ ok: true })
})
admin.post('/settings/test-email', async (c) => {
  const { user } = await mailConfig()
  if (!user) return c.json({ error: 'Set your Gmail address first.' }, 400)
  const ok = await sendMail(user, 'TechNova test email ✔',
    emailHtml('Email is working!', `<p style="margin:0;color:#444;font-size:14px;line-height:1.6">Your website can now send verification codes and order emails. 🎉</p>`))
  return c.json(ok ? { ok: true } : { error: 'Sending failed — check the Gmail address and app password.' }, ok ? 200 : 400)
})

/* ---------- site identity / SEO / services / logo ---------- */
admin.get('/site', async (c) => {
  const s = await getSiteSettings()
  const hasLogo = !!(await getSetting('logo_data'))
  return c.json({
    site_name: s.site_name || '', site_tagline: s.site_tagline || '', site_logo_text: s.site_logo_text || '',
    hero_title: s.hero_title || '', hero_accent: s.hero_accent || '', hero_sub: s.hero_sub || '',
    seo_title: s.seo_title || '', seo_desc: s.seo_desc || '', seo_keywords: s.seo_keywords || '',
    site_services: s.site_services || '', has_logo: hasLogo, logo_ver: s.logo_ver || '1'
  })
})
admin.put('/site', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max)
  const pairs = []
  if ('site_name' in b) pairs.push(['site_name', text(b.site_name, 40)])
  if ('site_tagline' in b) pairs.push(['site_tagline', text(b.site_tagline, 80)])
  if ('site_logo_text' in b) pairs.push(['site_logo_text', text(b.site_logo_text, 3)])
  if ('hero_title' in b) pairs.push(['hero_title', text(b.hero_title, 60)])
  if ('hero_accent' in b) pairs.push(['hero_accent', text(b.hero_accent, 60)])
  if ('hero_sub' in b) pairs.push(['hero_sub', text(b.hero_sub, 300)])
  if ('seo_title' in b) pairs.push(['seo_title', text(b.seo_title, 70)])
  if ('seo_desc' in b) pairs.push(['seo_desc', text(b.seo_desc, 170)])
  if ('seo_keywords' in b) pairs.push(['seo_keywords', text(b.seo_keywords, 300)])
  for (const [k, v] of pairs) await setSetting(k, v)
  return c.json({ ok: true })
})
admin.put('/site/services', async (c) => {
  const { services } = await c.req.json().catch(() => ({}))
  if (services === null || (Array.isArray(services) && !services.length)) {
    await setSetting('site_services', '')
    return c.json({ ok: true, reset: true })
  }
  if (!Array.isArray(services)) return c.json({ error: 'services must be a list.' }, 400)
  if (services.length > 12) return c.json({ error: 'Max 12 items.' }, 400)
  const ICONS_OK = ['shield','wrench','truck','swap','card','headset','box','star','check','clock','pin','mail','tag','laptop','phone','headphones','chart','user','gear']
  const clean = []
  for (const s of services) {
    const title = String(s && s.title || '').trim().slice(0, 60)
    const desc = String(s && s.desc || '').trim().slice(0, 220)
    const icon = ICONS_OK.includes(s && s.icon) ? s.icon : 'shield'
    if (!title || !desc) return c.json({ error: 'Every item needs a title and a description.' }, 400)
    clean.push({ icon, title, desc })
  }
  await setSetting('site_services', JSON.stringify(clean))
  return c.json({ ok: true })
})
admin.put('/site/logo', async (c) => {
  const { data } = await c.req.json().catch(() => ({}))
  if (!data) {
    await setSetting('logo_data', '')
    await setSetting('logo_ver', String(Date.now()))
    return c.json({ ok: true, removed: true })
  }
  const m = String(data).match(/^data:(image\/(?:jpeg|png|webp|svg\+xml));base64,(.+)$/)
  if (!m) return c.json({ error: 'Logo must be a PNG, JPG, WebP or SVG image.' }, 400)
  if (m[2].length > 700_000) return c.json({ error: 'Logo is too large (max ~500 KB).' }, 400)
  await setSetting('logo_mime', m[1])
  await setSetting('logo_data', m[2])
  await setSetting('logo_ver', String(Date.now()))
  return c.json({ ok: true })
})

export default admin
