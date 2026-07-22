/* ============================================================
   mailer.js — multi-provider email sending
   Providers (tried in this order):
     1. Brevo HTTPS API   (works on Railway — SMTP-blocked hosts)
     2. Resend HTTPS API  (works on Railway — SMTP-blocked hosts)
     3. Gmail SMTP :465   (blocked on Railway Free/Trial/Hobby!)
   Config precedence: settings table (admin panel) > env vars
   ⚠ Railway blocks outbound SMTP ports (25/465/587) on
     Free/Trial/Hobby plans. Use Brevo or Resend there.
   ============================================================ */
import tls from 'node:tls'
import { getSetting } from './db.js'

export async function mailConfig() {
  let user = await getSetting('gmail_user')
  let pass = await getSetting('gmail_pass')
  let brevoKey = await getSetting('brevo_key')
  let resendKey = await getSetting('resend_key')
  let fromEmail = await getSetting('mail_from')
  user = (user || process.env.GMAIL_USER || '').trim()
  pass = (pass || process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '')
  brevoKey = (brevoKey || process.env.BREVO_API_KEY || '').trim()
  resendKey = (resendKey || process.env.RESEND_API_KEY || '').trim()
  fromEmail = (fromEmail || process.env.MAIL_FROM || user).trim()
  return { user, pass, brevoKey, resendKey, fromEmail }
}

/* email HTML template (monochrome, matches site) */
export function emailHtml(title, bodyHtml, brand = 'TechNova') {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 14px">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e5e5">` +
    `<tr><td style="background:#111111;padding:26px 32px"><span style="display:inline-block;color:#ffffff;font-size:19px;font-weight:bold;letter-spacing:1px">${brand}</span></td></tr>` +
    `<tr><td style="padding:32px"><h1 style="margin:0 0 14px;font-size:21px;color:#111111">${title}</h1>${bodyHtml}</td></tr>` +
    `<tr><td style="padding:18px 32px;border-top:1px solid #eeeeee;color:#999999;font-size:12px">This email was sent by ${brand}. If you didn't expect it, you can ignore it.</td></tr>` +
    `</table></td></tr></table></body></html>`
}

/* ---------- Provider 1: Brevo (free 300/day, HTTPS — Railway-safe) ---------- */
async function sendViaBrevo(apiKey, fromEmail, to, subject, html) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'TechNova', email: fromEmail },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  })
  if (res.ok) return true
  const body = await res.text().catch(() => '')
  console.error('Brevo send failed:', res.status, body.slice(0, 300))
  return false
}

/* ---------- Provider 2: Resend (HTTPS — Railway-safe) ---------- */
async function sendViaResend(apiKey, fromEmail, to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'TechNova <' + fromEmail + '>',
      to: [to],
      subject,
      html
    })
  })
  if (res.ok) return true
  const body = await res.text().catch(() => '')
  console.error('Resend send failed:', res.status, body.slice(0, 300))
  return false
}

/* ---------- Provider 3: Gmail SMTP over node:tls (465) ----------
   ⚠ Blocked on Railway Free/Trial/Hobby — connection times out. */
function sendViaGmailSmtp(user, pass, to, subject, html) {
  return new Promise((resolve) => {
    let buf = ''
    let done = false
    const finish = (ok, why) => {
      if (done) return
      done = true
      if (!ok && why) console.error('Gmail SMTP failed:', why,
        why === 'timeout' || /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(String(why))
          ? '(your host may block outbound SMTP — Railway blocks ports 25/465/587 on Free/Trial/Hobby plans; use a Brevo or Resend API key instead)'
          : '')
      try { sock.end() } catch {}
      resolve(ok)
    }

    const sock = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' })
    sock.setTimeout(15000, () => finish(false, 'timeout'))
    sock.on('error', (e) => finish(false, e.message))

    /* SMTP conversation as a queue of [command, expectedCodes] */
    const msg = [
      'From: TechNova <' + user + '>',
      'To: <' + to + '>',
      'Subject: ' + subject,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      html.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
      '.'
    ].join('\r\n')

    const steps = [
      [null, ['220']],                                     // greeting
      ['EHLO technova.local', ['250']],
      ['AUTH LOGIN', ['334']],
      [Buffer.from(user).toString('base64'), ['334']],
      [Buffer.from(pass).toString('base64'), ['235']],
      ['MAIL FROM:<' + user + '>', ['250']],
      ['RCPT TO:<' + to + '>', ['250', '251']],
      ['DATA', ['354']],
      [msg, ['250']],
      ['QUIT', ['221']]
    ]
    let step = 0

    function advance() {
      // find a complete final reply line: "NNN text\r\n" (space after code = last line)
      const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/)
      if (!m) return
      const code = m[1]
      buf = ''
      const [, expect] = steps[step]
      if (!expect.includes(code)) {
        if (step === steps.length - 1) return finish(true) // QUIT reply mismatch — mail already sent
        return finish(false, 'SMTP ' + code + ' at step ' + step)
      }
      step++
      if (step >= steps.length) return finish(true)
      sock.write(steps[step][0] + '\r\n')
    }

    sock.on('data', (d) => { buf += d.toString(); advance() })
  })
}

/* ---------- public API: try providers in order ---------- */
export async function sendMail(to, subject, html) {
  const { user, pass, brevoKey, resendKey, fromEmail } = await mailConfig()

  // 1) Brevo HTTPS API (Railway-safe)
  if (brevoKey && fromEmail) {
    try {
      if (await sendViaBrevo(brevoKey, fromEmail, to, subject, html)) return true
    } catch (e) { console.error('Brevo error:', e.message) }
  }

  // 2) Resend HTTPS API (Railway-safe)
  if (resendKey && fromEmail) {
    try {
      if (await sendViaResend(resendKey, fromEmail, to, subject, html)) return true
    } catch (e) { console.error('Resend error:', e.message) }
  }

  // 3) Gmail SMTP fallback (blocked on Railway Free/Trial/Hobby)
  if (user && pass) {
    try {
      return await sendViaGmailSmtp(user, pass, to, subject, html)
    } catch (e) { console.error('Gmail SMTP error:', e.message) }
  }

  if (!brevoKey && !resendKey && !(user && pass)) {
    console.error('sendMail: no email provider configured (set BREVO_API_KEY / RESEND_API_KEY, or Gmail user+app password)')
  }
  return false
}
