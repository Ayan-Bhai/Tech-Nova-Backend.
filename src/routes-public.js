/* ============================================================
   routes-public.js — catalog, coupons, images, orders, pay, contact, site
   ============================================================ */
import { Hono } from 'hono'
import { q, one, run, getSetting } from './db.js'
import { getUser, code6, getSiteSettings } from './helpers.js'
import { sendMail, emailHtml, mailConfig } from './mailer.js'

const pub = new Hono()

/* ---------- catalog ---------- */
pub.get('/api/catalog', async (c) => {
  const cats = await q(`SELECT id, name FROM categories ORDER BY sort, id`)
  const prods = await q(
    `SELECT p.id, p.name, p.price, p.old_price AS "oldPrice", p.badge, p.icon, p.descr, p.stock, p.pinned, c.name AS category
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.active = 1 ORDER BY p.pinned DESC, p.sort, p.id`)
  const imgs = await q(`SELECT id, product_id FROM product_images ORDER BY sort, id`)
  const byProd = {}
  for (const im of imgs) (byProd[im.product_id] = byProd[im.product_id] || []).push(Number(im.id))
  for (const p of prods) { p.id = Number(p.id); p.images = byProd[p.id] || [] }
  const bannerId = Number(await getSetting('banner_product')) || null
  return c.json({ categories: cats.map(x => ({ ...x, id: Number(x.id) })), products: prods, banner: bannerId })
})

/* ---------- coupon check ---------- */
pub.post('/api/coupons/check', async (c) => {
  const { code, total } = await c.req.json().catch(() => ({}))
  const cc = String(code || '').trim().toUpperCase()
  if (!cc) return c.json({ error: 'Enter a coupon code.' }, 400)
  const cp = await one(`SELECT * FROM coupons WHERE code = $1`, [cc])
  if (!cp || !cp.active) return c.json({ error: 'Invalid coupon code.' }, 400)
  if (cp.expires_at && new Date(cp.expires_at).getTime() < Date.now()) return c.json({ error: 'This coupon has expired.' }, 400)
  if (cp.max_uses > 0 && cp.uses >= cp.max_uses) return c.json({ error: 'This coupon has been fully used.' }, 400)
  if (Number(total) < cp.min_total) return c.json({ error: 'Coupon needs a minimum order of Rs ' + Number(cp.min_total).toLocaleString('en-PK') + '.' }, 400)
  return c.json({ ok: true, code: cc, percent: cp.percent })
})

/* ---------- product image ---------- */
pub.get('/img/:id', async (c) => {
  const row = await one(`SELECT mime, data FROM product_images WHERE id = $1`, [Number(c.req.param('id')) || 0])
  if (!row) return c.notFound()
  return new Response(Buffer.from(row.data, 'base64'), {
    headers: { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=86400' }
  })
})

/* ---------- order builder (shared) ---------- */
async function buildOrder(items, couponCode) {
  const ids = items.map(i => Number(i.id)).filter(Boolean)
  if (!ids.length) return { error: 'No valid items.' }
  const rows = await q(`SELECT id, name, price, stock FROM products WHERE active = 1 AND id = ANY($1)`, [ids])
  const map = {}; for (const p of rows) map[Number(p.id)] = p
  const clean = []; let subtotal = 0
  for (const it of items) {
    const p = map[Number(it.id)]; if (!p) continue
    const qty = Math.max(1, Math.min(99, Number(it.qty) || 1))
    clean.push({ product_id: Number(p.id), name: p.name, price: p.price, qty })
    subtotal += p.price * qty
  }
  if (!clean.length) return { error: 'No valid items.' }
  let discount = 0, coupon = null
  const cc = String(couponCode || '').trim().toUpperCase()
  if (cc) {
    const cp = await one(`SELECT * FROM coupons WHERE code = $1`, [cc])
    const expired = cp && cp.expires_at && new Date(cp.expires_at).getTime() < Date.now()
    const used = cp && cp.max_uses > 0 && cp.uses >= cp.max_uses
    if (cp && cp.active && !expired && !used && subtotal >= cp.min_total) {
      discount = Math.round(subtotal * cp.percent / 100)
      coupon = cc
    }
  }
  return { clean, subtotal, discount, coupon, total: subtotal - discount }
}

function orderEmailTable(code, clean, subtotal, discount, coupon, total) {
  const rows = clean.map(i =>
    `<tr><td style="padding:9px 0;border-bottom:1px solid #eee;color:#333;font-size:14px">${i.name} × ${i.qty}</td>` +
    `<td align="right" style="padding:9px 0;border-bottom:1px solid #eee;color:#111;font-size:14px;white-space:nowrap">Rs ${(i.price * i.qty).toLocaleString('en-PK')}</td></tr>`
  ).join('')
  const disc = discount > 0
    ? `<tr><td style="padding:9px 0;color:#333;font-size:14px">Discount${coupon ? ' (' + coupon + ')' : ''}</td>` +
      `<td align="right" style="padding:9px 0;color:#111;font-size:14px">− Rs ${discount.toLocaleString('en-PK')}</td></tr>` : ''
  return `<p style="margin:0 0 16px;color:#444;font-size:14px;line-height:1.6">Order <strong>${code}</strong> has been received.</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}${disc}` +
    `<tr><td style="padding:12px 0;font-weight:bold;color:#111;font-size:15px">Total</td>` +
    `<td align="right" style="padding:12px 0;font-weight:bold;color:#111;font-size:15px">Rs ${total.toLocaleString('en-PK')}</td></tr></table>`
}

/* ---------- WhatsApp order ---------- */
pub.post('/api/orders', async (c) => {
  const u = await getUser(c)
  const { items, coupon: couponCode } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(items) || !items.length) return c.json({ error: 'Cart is empty.' }, 400)
  const b = await buildOrder(items, couponCode)
  if (b.error) return c.json({ error: b.error }, 400)
  const code = 'TN-' + code6()
  await run(`INSERT INTO orders (user_id, code, items, total, discount, coupon, pay_method) VALUES ($1,$2,$3,$4,$5,$6,'whatsapp')`,
    [u ? u.id : null, code, JSON.stringify(b.clean), b.total, b.discount, b.coupon])
  if (b.coupon) await run(`UPDATE coupons SET uses = uses + 1 WHERE code = $1`, [b.coupon])

  const orderTable = orderEmailTable(code, b.clean, b.subtotal, b.discount, b.coupon, b.total)
  ;(async () => {
    try {
      if (u && u.email) await sendMail(u.email, 'Order ' + code + ' received — TechNova', emailHtml('Thanks for your order!', orderTable))
      const { user: shopMail } = await mailConfig()
      if (shopMail) await sendMail(shopMail, 'NEW ORDER ' + code + (u ? ' from ' + u.email : ' (guest)'), emailHtml('New order on your website', orderTable))
    } catch (e) { console.error('order mail:', e.message) }
  })()

  return c.json({ ok: true, code, total: b.total, discount: b.discount, items: b.clean })
})

/* ---------- Stripe checkout ---------- */
async function stripeKey() {
  const sk = (await getSetting('stripe_sk')) || process.env.STRIPE_SECRET_KEY || ''
  return sk.trim()
}

pub.get('/api/pay/config', async (c) => {
  return c.json({ enabled: !!(await stripeKey()) })
})

pub.post('/api/pay/checkout', async (c) => {
  const u = await getUser(c)
  const { items, coupon: couponCode } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(items) || !items.length) return c.json({ error: 'Cart is empty.' }, 400)
  const sk = await stripeKey()
  if (!sk) return c.json({ error: 'Online payment is not configured yet.' }, 400)
  const b = await buildOrder(items, couponCode)
  if (b.error) return c.json({ error: b.error }, 400)
  const code = 'TN-' + code6()

  /* success/cancel pages live on the FRONTEND site */
  const front = (process.env.FRONTEND_URL || '').replace(/\/+$/, '') || new URL(c.req.url).origin

  const form = new URLSearchParams()
  form.set('mode', 'payment')
  form.set('success_url', front + '/pay-success.html?session_id={CHECKOUT_SESSION_ID}')
  form.set('cancel_url', front + '/cart.html')
  form.set('client_reference_id', code)
  if (u && u.email) form.set('customer_email', u.email)
  const ratio = b.subtotal > 0 ? b.total / b.subtotal : 1
  b.clean.forEach((i, n) => {
    const unit = Math.max(1, Math.round(i.price * ratio)) * 100
    form.set(`line_items[${n}][price_data][currency]`, 'pkr')
    form.set(`line_items[${n}][price_data][product_data][name]`, i.name.slice(0, 120))
    form.set(`line_items[${n}][price_data][unit_amount]`, String(unit))
    form.set(`line_items[${n}][quantity]`, String(i.qty))
  })
  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  })
  const sess = await resp.json().catch(() => ({}))
  if (!resp.ok || !sess.url) {
    const msg = sess && sess.error && sess.error.message ? sess.error.message : 'Could not start payment.'
    return c.json({ error: msg }, 400)
  }
  await run(
    `INSERT INTO orders (user_id, code, items, total, discount, coupon, pay_method, pay_status, pay_session) VALUES ($1,$2,$3,$4,$5,$6,'card','unpaid',$7)`,
    [u ? u.id : null, code, JSON.stringify(b.clean), b.total, b.discount, b.coupon, sess.id])
  if (b.coupon) await run(`UPDATE coupons SET uses = uses + 1 WHERE code = $1`, [b.coupon])
  return c.json({ ok: true, url: sess.url, code })
})

pub.get('/api/pay/verify', async (c) => {
  const sid = c.req.query('session_id') || ''
  if (!sid) return c.json({ error: 'Missing session.' }, 400)
  const sk = await stripeKey()
  if (!sk) return c.json({ error: 'Payment not configured.' }, 400)
  const o = await one(`SELECT id, code, total, status, pay_status, user_id FROM orders WHERE pay_session = $1`, [sid])
  if (!o) return c.json({ error: 'Order not found.' }, 404)
  if (o.pay_status === 'paid') return c.json({ ok: true, code: o.code, total: o.total, paid: true })
  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sid), {
    headers: { 'Authorization': 'Bearer ' + sk }
  })
  const sess = await resp.json().catch(() => ({}))
  const paid = resp.ok && sess.payment_status === 'paid'
  if (paid) {
    await run(`UPDATE orders SET pay_status='paid', status='confirmed' WHERE id = $1`, [o.id])
    const em = sess.customer_details && sess.customer_details.email
    ;(async () => {
      try {
        if (em) await sendMail(em, 'Payment received — order ' + o.code + ' confirmed ✅',
          emailHtml('Payment successful!', `<p style="margin:0;color:#444;font-size:14px;line-height:1.6">We received your payment of <strong>Rs ${Number(o.total).toLocaleString('en-PK')}</strong> for order <strong>${o.code}</strong>. It is now confirmed — we'll contact you about delivery.</p>`))
        const { user: shopMail } = await mailConfig()
        if (shopMail) await sendMail(shopMail, 'PAID ORDER ' + o.code + ' — Rs ' + Number(o.total).toLocaleString('en-PK'),
          emailHtml('Order paid online 💳', `<p style="margin:0;color:#444;font-size:14px">Order <strong>${o.code}</strong> was paid by card${em ? ' by ' + em : ''}. Total: Rs ${Number(o.total).toLocaleString('en-PK')}.</p>`))
      } catch (e) { console.error('pay mail:', e.message) }
    })()
  }
  return c.json({ ok: true, code: o.code, total: o.total, paid })
})

/* ---------- my orders ---------- */
pub.get('/api/my/orders', async (c) => {
  const u = await getUser(c)
  if (!u) return c.json({ error: 'Login required.' }, 401)
  const orders = await q(`SELECT id, code, items, total, status, created_at FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT 50`, [u.id])
  return c.json({ orders })
})

/* ---------- contact ---------- */
pub.post('/api/contact', async (c) => {
  const { name, email, body } = await c.req.json().catch(() => ({}))
  if (!name || !email || !body) return c.json({ error: 'All fields are required.' }, 400)
  await run(`INSERT INTO messages (name, email, body) VALUES ($1,$2,$3)`,
    [String(name).slice(0, 80), String(email).slice(0, 120), String(body).slice(0, 2000)])
  ;(async () => {
    try {
      const { user: shopMail } = await mailConfig()
      if (shopMail) {
        const esc2 = (s) => String(s || '').replace(/[<>&]/g, '')
        await sendMail(shopMail, 'New message from ' + String(name).slice(0, 40) + ' — TechNova',
          emailHtml('New contact message',
            `<p style="margin:0 0 10px;color:#444;font-size:14px"><strong>${esc2(name)}</strong> · ${esc2(email)}</p>` +
            `<div style="padding:16px;background:#f6f6f6;border-radius:12px;color:#333;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc2(body).slice(0, 2000)}</div>`))
      }
    } catch (e) { console.error('contact mail:', e.message) }
  })()
  return c.json({ ok: true })
})

/* ---------- public site overrides (branding/SEO/services) ---------- */
pub.get('/api/site', async (c) => {
  const s = await getSiteSettings()
  const hasLogo = !!(await getSetting('logo_data'))
  let services = null
  if (s.site_services) { try { services = JSON.parse(s.site_services) } catch {} }
  const apiBase = new URL(c.req.url).origin
  return c.json({
    name: s.site_name || '', tagline: s.site_tagline || '', logoText: s.site_logo_text || '',
    heroTitle: s.hero_title || '', heroAccent: s.hero_accent || '', heroSub: s.hero_sub || '',
    logo: hasLogo ? apiBase + '/logo?v=' + (s.logo_ver || '1') : '',
    seoTitle: s.seo_title || '', seoDesc: s.seo_desc || '', seoKeywords: s.seo_keywords || '',
    services
  })
})

/* ---------- uploaded logo ---------- */
pub.get('/logo', async (c) => {
  const data = await getSetting('logo_data')
  if (!data) return c.notFound()
  const mime = (await getSetting('logo_mime')) || 'image/png'
  return new Response(Buffer.from(data, 'base64'), {
    headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }
  })
})

export default pub
