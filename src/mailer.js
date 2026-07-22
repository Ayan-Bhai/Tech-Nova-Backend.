/* ============================================================
   mailer.js — zero-dependency Gmail SMTP over node:tls (465)
   Config precedence: settings table (admin panel) > env vars
   ============================================================ */
import tls from 'node:tls'
import { getSetting } from './db.js'

export async function mailConfig() {
  let user = await getSetting('gmail_user')
  let pass = await getSetting('gmail_pass')
  user = (user || process.env.GMAIL_USER || '').trim()
  pass = (pass || process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '')
  return { user, pass }
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

export async function sendMail(to, subject, html) {
  let { user, pass } = await mailConfig()

  // DEBUG — remove after confirming credentials load correctly
  console.log('[mailer] user:', user ? user : '(empty)')
  console.log('[mailer] pass length:', pass ? pass.length : 0)

  if (!user || !pass) {
    console.error('[mailer] Missing credentials — check GMAIL_USER / GMAIL_APP_PASSWORD env vars')
    return false
  }

  return new Promise((resolve) => {
    let buf = ''
    let done = false
    const finish = (ok, why) => {
      if (done) return
      done = true
      if (!ok && why) console.error('[mailer] sendMail failed:', why)
      try { sock.destroy() } catch {}
      resolve(ok)
    }

    const sock = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' })
    sock.setTimeout(20000, () => finish(false, 'timeout'))
    sock.on('error', (e) => finish(false, e.message))

    // Dot-stuff any body lines starting with '.'
    const body = html.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')

    // Full DATA payload per RFC 5321
    const dataPayload =
      'From: TechNova <' + user + '>\r\n' +
      'To: <' + to + '>\r\n' +
      'Subject: ' + subject + '\r\n' +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: text/html; charset=utf-8\r\n' +
      '\r\n' +
      body + '\r\n' +
      '.'   // lone dot; sock.write appends \r\n → ".\r\n"

    const steps = [
      [null,                                 ['220']], // 0 server greeting
      ['EHLO technova.local',                ['250']], // 1 may be multi-line
      ['AUTH LOGIN',                         ['334']], // 2
      [Buffer.from(user).toString('base64'), ['334']], // 3 username
      [Buffer.from(pass).toString('base64'), ['235']], // 4 password
      ['MAIL FROM:<' + user + '>',          ['250']], // 5
      ['RCPT TO:<' + to + '>',             ['250', '251']], // 6
      ['DATA',                               ['354']], // 7
      [dataPayload,                          ['250']], // 8 body + lone dot
      ['QUIT',                               ['221']]  // 9
    ]
    let step = 0

    function advance() {
      // SMTP final reply line always has a space after code: "250 OK\r\n"
      // Multi-line continuations use a dash: "250-EXT\r\n" — we wait for the final line.
      const m = buf.match(/(\d{3}) [^\r\n]*\r\n$/)
      if (!m) return
      const code = m[1]
      buf = ''

      const [, expect] = steps[step]
      if (!expect.includes(code)) {
        if (step === steps.length - 1) return finish(true) // QUIT mismatch is fine
        return finish(false, 'SMTP ' + code + ' at step ' + step)
      }

      step++
      if (step >= steps.length) return finish(true)

      // Every step gets \r\n — body ends with bare '.' so this makes it ".\r\n" (correct)
      sock.write(steps[step][0] + '\r\n')
    }

    sock.on('data', (d) => { buf += d.toString(); advance() })
  })
}
