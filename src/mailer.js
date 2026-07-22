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

  console.log("========== SMTP DEBUG ==========")
  console.log("GMAIL_USER:", user)
  console.log("Has password:", !!pass)

  if (!user || !pass) {
    console.error("Missing Gmail credentials")
    return false
  }

  user = user.trim()
  pass = pass.replace(/\s+/g, "")

  // ...rest of your existing code...
}
  if (!user || !pass) return false
  user = user.trim(); pass = pass.replace(/\s+/g, '')

  return new Promise((resolve) => {
    let buf = ''
    let done = false
    const finish = (ok, why) => {
      if (done) return
      done = true
      if (!ok) {
      console.error('=== EMAIL ERROR ===')
      console.error('Reason:', why)
}
      try { sock.end() } catch {}
      resolve(ok)
    }

    const sock = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' })
    sock.setTimeout(20000, () => finish(false, 'timeout'))
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
