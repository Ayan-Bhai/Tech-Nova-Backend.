/* ============================================================
   mailer.js — Gmail SMTP, tries 465 (TLS) then 587 (STARTTLS)
   Config precedence: settings table (admin panel) > env vars
   ============================================================ */
import tls from 'node:tls'
import net from 'node:net'
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

/* ---- build the raw RFC-5321 DATA payload ---- */
function buildPayload(user, to, subject, html) {
  const body = html.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
  return (
    'From: TechNova <' + user + '>\r\n' +
    'To: <' + to + '>\r\n' +
    'Subject: ' + subject + '\r\n' +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: text/html; charset=utf-8\r\n' +
    '\r\n' +
    body + '\r\n.'   // lone dot; caller appends \r\n
  )
}

/* ---- shared SMTP state machine ---- */
function smtpSteps(user, pass, to, dataPayload) {
  return [
    [null,                                 ['220']],       // 0 greeting
    ['EHLO technova.local',                ['250']],       // 1 multi-line OK
    ['AUTH LOGIN',                         ['334']],       // 2
    [Buffer.from(user).toString('base64'), ['334']],       // 3 username
    [Buffer.from(pass).toString('base64'), ['235']],       // 4 password
    ['MAIL FROM:<' + user + '>',          ['250']],       // 5
    ['RCPT TO:<' + to + '>',             ['250', '251']], // 6
    ['DATA',                               ['354']],       // 7
    [dataPayload,                          ['250']],       // 8 body + lone dot
    ['QUIT',                               ['221']]        // 9
  ]
}

function runSmtp(sock, steps, onFinish) {
  let buf = ''
  let step = 0
  let done = false

  const finish = (ok, why) => {
    if (done) return
    done = true
    if (!ok && why) console.error('[mailer] SMTP error:', why)
    try { sock.destroy() } catch {}
    onFinish(ok)
  }

  sock.setTimeout(15000, () => finish(false, 'timeout'))
  sock.on('error', (e) => finish(false, e.message))

  sock.on('data', (d) => {
    buf += d.toString()
    // Final reply line always has space after code: "250 OK\r\n"
    // Continuation lines use dash: "250-EXT\r\n" — wait for final.
    const m = buf.match(/(\d{3}) [^\r\n]*\r\n$/)
    if (!m) return
    const code = m[1]
    buf = ''

    const [, expect] = steps[step]
    if (!expect.includes(code)) {
      if (step === steps.length - 1) return finish(true) // QUIT mismatch — already sent
      return finish(false, 'code ' + code + ' at step ' + step)
    }
    step++
    if (step >= steps.length) return finish(true)
    sock.write(steps[step][0] + '\r\n')
  })
}

/* ---- attempt 1: port 465 implicit TLS ---- */
function tryPort465(user, pass, to, subject, html) {
  return new Promise((resolve) => {
    console.log('[mailer] trying port 465...')
    const sock = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' })
    sock.on('secureConnect', () => console.log('[mailer] 465 TLS connected'))
    const steps = smtpSteps(user, pass, to, buildPayload(user, to, subject, html))
    runSmtp(sock, steps, resolve)
  })
}

/* ---- attempt 2: port 587 STARTTLS ---- */
function tryPort587(user, pass, to, subject, html) {
  return new Promise((resolve) => {
    console.log('[mailer] trying port 587 STARTTLS...')
    let buf = ''
    let done = false
    let upgraded = false

    const finish = (ok, why) => {
      if (done) return
      done = true
      if (!ok && why) console.error('[mailer] 587 error:', why)
      try { plain.destroy() } catch {}
      resolve(ok)
    }

    const plain = net.connect({ host: 'smtp.gmail.com', port: 587 })
    plain.setTimeout(15000, () => finish(false, 'timeout'))
    plain.on('error', (e) => finish(false, e.message))

    // Before STARTTLS we need: greeting → EHLO → STARTTLS → 220 → upgrade
    const preSteps = [
      [null,                  ['220']], // 0 greeting
      ['EHLO technova.local', ['250']], // 1
      ['STARTTLS',            ['220']], // 2
    ]
    let preStep = 0

    plain.on('data', (d) => {
      if (upgraded) return  // TLS socket handles the rest
      buf += d.toString()
      const m = buf.match(/(\d{3}) [^\r\n]*\r\n$/)
      if (!m) return
      const code = m[1]
      buf = ''

      const [, expect] = preSteps[preStep]
      if (!expect.includes(code)) return finish(false, 'pre-TLS code ' + code + ' at step ' + preStep)

      preStep++
      if (preStep < preSteps.length) {
        plain.write(preSteps[preStep][0] + '\r\n')
        return
      }

      // STARTTLS handshake — upgrade the plain socket
      upgraded = true
      const tlsSock = tls.connect({
        socket: plain,
        host: 'smtp.gmail.com',
        servername: 'smtp.gmail.com'
      })
      tlsSock.on('secureConnect', () => {
        console.log('[mailer] 587 STARTTLS upgraded')
        const steps = smtpSteps(user, pass, to, buildPayload(user, to, subject, html))
        // After STARTTLS we start fresh with a new EHLO
        // steps[0] is the greeting — skip it, send EHLO immediately
        tlsSock.write('EHLO technova.local\r\n')
        // Splice out the greeting step since server won't re-greet after upgrade
        const postSteps = steps.slice(1)
        let pBuf = ''
        let pStep = 0
        let pDone = false
        const pFinish = (ok, why) => {
          if (pDone) return; pDone = true
          if (!ok && why) console.error('[mailer] 587 post-TLS error:', why)
          try { tlsSock.destroy() } catch {}
          resolve(ok)
        }
        tlsSock.setTimeout(15000, () => pFinish(false, 'timeout'))
        tlsSock.on('error', (e) => pFinish(false, e.message))
        tlsSock.on('data', (d2) => {
          pBuf += d2.toString()
          const m2 = pBuf.match(/(\d{3}) [^\r\n]*\r\n$/)
          if (!m2) return
          const c2 = m2[1]; pBuf = ''
          const [, exp] = postSteps[pStep]
          if (!exp.includes(c2)) {
            if (pStep === postSteps.length - 1) return pFinish(true)
            return pFinish(false, 'code ' + c2 + ' at post-step ' + pStep)
          }
          pStep++
          if (pStep >= postSteps.length) return pFinish(true)
          tlsSock.write(postSteps[pStep][0] + '\r\n')
        })
      })
      tlsSock.on('error', (e) => finish(false, 'TLS upgrade: ' + e.message))
    })
  })
}

export async function sendMail(to, subject, html) {
  let { user, pass } = await mailConfig()

  console.log('[mailer] user:', user || '(empty)')
  console.log('[mailer] pass length:', pass.length)

  if (!user || !pass) {
    console.error('[mailer] Missing credentials — GMAIL_USER / GMAIL_APP_PASSWORD not set')
    return false
  }

  // Try 465 first, fall back to 587 if it fails
  const ok465 = await tryPort465(user, pass, to, subject, html)
  if (ok465) { console.log('[mailer] sent via 465'); return true }

  console.log('[mailer] 465 failed, falling back to 587...')
  const ok587 = await tryPort587(user, pass, to, subject, html)
  if (ok587) { console.log('[mailer] sent via 587'); return true }

  console.error('[mailer] both ports failed — Railway may be blocking outbound SMTP')
  return false
}
