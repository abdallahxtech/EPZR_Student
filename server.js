'use strict';
/*
 * EPZR Student Connect
 * - Serves the landing page (public/)
 * - POST /api/apply  -> emails career@emiratespark.ae with subject "<SERIAL> | <Interest> | <Candidate Name>"
 * - Serial numbers persist in DATA_DIR (mount a volume at /data in EasyPanel)
 * - /qr.svg, /qr.png, /print, /screen generate the QR for whatever domain the site is served on
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const Busboy = require('busboy');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const PORT = parseInt(env('PORT', '80'), 10);
const DATA_DIR = env('DATA_DIR', '/data');
const MAIL_TO = env('MAIL_TO', 'career@emiratespark.ae');
const MAIL_CC = env('MAIL_CC', '');
const SERIAL_PREFIX = env('SERIAL_PREFIX', 'EPZR-SUAD');
const SERIAL_PAD = parseInt(env('SERIAL_PAD', '4'), 10);
const PUBLIC_URL = env('PUBLIC_URL', '').replace(/\/+$/, '');
const ADMIN_TOKEN = env('ADMIN_TOKEN', '');
const SEND_CONFIRMATION = env('SEND_CONFIRMATION', 'true') !== 'false';
const MAX_CV_MB = parseFloat(env('MAX_CV_MB', '5'));
// Students on campus Wi-Fi share one public IP, so keep this generous.
const RATE_LIMIT = parseInt(env('RATE_LIMIT', '150'), 10);

const SMTP = {
  host: env('SMTP_HOST', 'smtp.office365.com'),
  port: parseInt(env('SMTP_PORT', '587'), 10),
  user: env('SMTP_USER'),
  pass: env('SMTP_PASS'),
  from: env('MAIL_FROM') || env('SMTP_USER'),
  fromName: env('MAIL_FROM_NAME', 'EPZR Student Connect'),
};
const smtpReady = !!(SMTP.host && SMTP.user && SMTP.pass && SMTP.from);
const transporter = smtpReady
  ? nodemailer.createTransport({
      host: SMTP.host,
      port: SMTP.port,
      secure: SMTP.port === 465,
      requireTLS: SMTP.port === 587,
      auth: { user: SMTP.user, pass: SMTP.pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    })
  : null;

/* ---------- storage ---------- */
const UPLOAD_DIR = path.join(DATA_DIR, 'cv');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');
const LOG_FILE = path.join(DATA_DIR, 'submissions.csv');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, 'serial,received_at,interest,full_name,email,phone,university,study,area,availability,cv_file,email_status\n');
}
function nextSerial() {
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')).last || 0; } catch (_) {}
  n += 1;
  const tmp = COUNTER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ last: n }));
  fs.renameSync(tmp, COUNTER_FILE);
  return `${SERIAL_PREFIX}-${String(n).padStart(SERIAL_PAD, '0')}`;
}
const csv = (v) => '"' + String(v ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
function logRow(r) {
  fs.appendFileSync(LOG_FILE, [r.serial, r.receivedAt, r.interest, r.fullName, r.email, r.phone, r.university, r.study, r.area, r.availability, r.cvFile, r.status].map(csv).join(',') + '\n');
}

/* ---------- validation ---------- */
const INTERESTS = ['Volunteering', 'Internship', 'Job vacancy', 'Training & continuous education', 'Joint research'];
const AREAS = ['Animal care', 'Veterinary & pet hotel', 'Conservation & research', 'Education & interactive sessions', 'Sustainability programmes', 'Guest experience & events', 'Hospitality & F&B', 'Administration / other'];
// Strict address pattern: no quotes, comments, angle brackets or separators can reach the mailer.
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;
const PHONE_RE = /^[+0-9 ()-]{7,20}$/;
const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMulti = (s, max = 2000) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeFile = (s) => clean(s, 60).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'candidate';

/* ---------- rate limit (per IP, in memory) ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = RATE_LIMIT;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 600000)) hits.delete(k); }, 600000).unref();

/* ---------- multipart parsing ---------- */
const ALLOWED_CV = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
function parseForm(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { fields: 20, fieldSize: 4000, fieldNameSize: 40, files: 1, fileSize: Math.round(MAX_CV_MB * 1024 * 1024), parts: 25 } });
    } catch (e) { return reject(Object.assign(new Error('Invalid form submission.'), { status: 400 })); }
    const fields = {}; let file = null; let fileErr = null;
    bb.on('field', (name, val) => { if (/^[a-z_]{1,30}$/i.test(name)) fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      if (name !== 'cv' || !info.filename) { stream.resume(); return; }
      const ext = path.extname(info.filename).toLowerCase();
      if (!ALLOWED_CV[ext]) { fileErr = 'Your CV must be a PDF or Word file.'; stream.resume(); return; }
      const chunks = []; let size = 0;
      stream.on('data', (c) => { size += c.length; chunks.push(c); });
      stream.on('limit', () => { fileErr = `Your CV is larger than ${MAX_CV_MB} MB. Please upload a smaller file.`; });
      stream.on('end', () => { if (!fileErr && size > 0) file = { ext, buffer: Buffer.concat(chunks), contentType: ALLOWED_CV[ext], originalName: clean(info.filename, 120) }; });
    });
    bb.on('error', () => reject(Object.assign(new Error('The upload was interrupted. Please try again.'), { status: 400 })));
    bb.on('close', () => (fileErr ? reject(Object.assign(new Error(fileErr), { status: 400 })) : resolve({ fields, file })));
    req.on('aborted', () => reject(Object.assign(new Error('aborted'), { status: 400 })));
    req.pipe(bb);
  });
}

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/health', (req, res) => res.type('text/plain').send('ok'));
app.get('/api/status', (req, res) => res.json({ ok: true, email: smtpReady ? 'configured' : 'not-configured', to: MAIL_TO }));

app.post('/api/apply', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (limited(ip)) return res.status(429).json({ ok: false, error: 'Too many submissions from this connection. Please wait a few minutes and try again.' });
  if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) return res.status(400).json({ ok: false, error: 'Invalid form submission.' });

  let parsed;
  try { parsed = await parseForm(req); } catch (e) { return res.status(e.status || 400).json({ ok: false, error: e.message === 'aborted' ? 'The upload was interrupted.' : e.message }); }
  const f = parsed.fields;
  if (clean(f.website)) return res.json({ ok: true, serial: 'received' }); // honeypot

  const d = {
    fullName: clean(f.full_name, 100),
    email: clean(f.email, 120).toLowerCase(),
    phone: clean(f.phone, 20),
    university: clean(f.university, 120) || 'Sorbonne University Abu Dhabi',
    study: clean(f.study, 120),
    interest: clean(f.interest, 60),
    area: clean(f.area, 60),
    availability: clean(f.availability, 120),
    message: cleanMulti(f.message, 2000),
    consent: f.consent === 'yes',
  };
  const errors = [];
  if (d.fullName.length < 3) errors.push('Enter your full name.');
  if (!EMAIL_RE.test(d.email)) errors.push('Enter a valid email address, e.g. name@example.com.');
  if (!PHONE_RE.test(d.phone)) errors.push('Enter a valid mobile number, e.g. +971 50 123 4567.');
  if (!INTERESTS.includes(d.interest)) errors.push('Choose what you are applying for.');
  if (d.area && !AREAS.includes(d.area)) d.area = '';
  if (!d.consent) errors.push('Tick the box to agree that EPZR may contact you about your application.');
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });

  const serial = nextSerial();
  const receivedAt = new Date();
  const dubai = receivedAt.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' });
  let cvFile = '';
  if (parsed.file) {
    cvFile = `${serial}_${safeFile(d.fullName)}${parsed.file.ext}`;
    try { fs.writeFileSync(path.join(UPLOAD_DIR, cvFile), parsed.file.buffer); } catch (e) { console.error('CV save failed', e.message); }
  }
  const subject = `${serial} | ${d.interest} | ${d.fullName}`;

  const rows = [
    ['Serial number', serial], ['Applying for', d.interest], ['Full name', d.fullName], ['Email', d.email], ['Mobile', d.phone],
    ['University', d.university], ['Programme & year', d.study || '-'], ['Area of interest', d.area || '-'], ['Availability', d.availability || '-'],
    ['CV attached', parsed.file ? `Yes (${parsed.file.originalName})` : 'No'], ['Received', `${dubai} (Dubai)`], ['Source', 'Sorbonne University Abu Dhabi - Volunteering Day QR'],
  ];
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nMessage:\n${d.message || '-'}\n`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#16261d;max-width:640px">
<div style="background:#e30566;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0"><div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;opacity:.9">EPZR Student Connect</div><div style="font-size:20px;font-weight:700">${esc(serial)} &middot; ${esc(d.interest)}</div></div>
<table style="border-collapse:collapse;width:100%;border:1px solid #e6ddd2;border-top:0" cellpadding="8">${rows.map(([k, v], i) => `<tr style="background:${i % 2 ? '#fff' : '#f7f3ee'}"><td style="width:170px;font-weight:600;font-size:13px;color:#5b6a60">${esc(k)}</td><td style="font-size:14px">${esc(v)}</td></tr>`).join('')}
<tr><td colspan="2" style="font-size:14px;border-top:1px solid #e6ddd2"><div style="font-weight:600;font-size:13px;color:#5b6a60;margin-bottom:4px">Message</div>${esc(d.message || '-').replace(/\n/g, '<br>')}</td></tr></table>
<p style="font-size:12px;color:#5b6a60">Reply to this email to answer the candidate directly.</p></div>`;

  let status = 'not-configured';
  if (transporter) {
    try {
      await transporter.sendMail({
        from: { name: SMTP.fromName, address: SMTP.from },
        to: MAIL_TO,
        ...(MAIL_CC ? { cc: MAIL_CC } : {}),
        replyTo: { name: d.fullName.replace(/["<>;,\\]/g, ''), address: d.email },
        subject, text, html,
        attachments: parsed.file ? [{ filename: cvFile, content: parsed.file.buffer, contentType: parsed.file.contentType }] : [],
      });
      status = 'sent';
    } catch (e) {
      status = 'failed';
      console.error(`[${serial}] email failed:`, e.message);
    }
  }
  logRow({ serial, receivedAt: receivedAt.toISOString(), ...d, cvFile, status });
  console.log(`[${serial}] ${d.interest} - ${d.fullName} - email ${status}`);

  if (status === 'sent' && SEND_CONFIRMATION) {
    transporter.sendMail({
      from: { name: 'Emirates Park Zoo & Resort', address: SMTP.from },
      to: { name: d.fullName.replace(/["<>;,\\]/g, ''), address: d.email },
      replyTo: MAIL_TO,
      subject: `We received your application (${serial}) - Emirates Park Zoo & Resort`,
      text: `Dear ${d.fullName},\n\nThank you for your interest in ${d.interest.toLowerCase()} at Emirates Park Zoo & Resort. Your reference number is ${serial}.\n\nOur HR team will review your details and contact you. For any questions, reply to this email or write to ${MAIL_TO} and quote your reference number.\n\nKind regards,\nHuman Resources\nEmirates Park Zoo & Resort\nAl Bahyah, Abu Dhabi`,
    }).catch((e) => console.error(`[${serial}] confirmation failed:`, e.message));
  }

  if (status === 'sent') return res.json({ ok: true, serial, emailed: true });
  // Saved on the server but not emailed: give the student a ready-made email with the same serial as a fallback.
  return res.status(202).json({ ok: true, serial, emailed: false, mailto: { to: MAIL_TO, subject, body: text } });
});

/* ---------- admin: download submissions / CVs ---------- */
function adminOk(req) { return ADMIN_TOKEN && req.query.token === ADMIN_TOKEN; }
app.get('/admin/submissions.csv', (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'no-store');
  res.download(LOG_FILE, 'EPZR-student-submissions.csv');
});
app.get('/admin/cv/:file', (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found');
  const name = path.basename(req.params.file);
  const p = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).send('Not found');
  res.download(p, name);
});

/* ---------- QR code for this site ---------- */
function siteUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL + '/';
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}/`;
}
const LOGO_B64 = fs.readFileSync(path.join(__dirname, 'public/img/logo.png')).toString('base64');
async function qrSvg(url, dark = '#16261d') {
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'H', margin: 4, color: { dark, light: '#ffffff' } });
  const vb = (svg.match(/viewBox="0 0 (\d+) (\d+)"/) || [0, 50])[1] * 1;
  const bw = vb * 0.27, bh = bw * 0.5, x = (vb - bw) / 2, y = (vb - bh) / 2;
  const badge = `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="#fff" rx="0.6"/><image href="data:image/png;base64,${LOGO_B64}" x="${x + bw * 0.06}" y="${y + bh * 0.06}" width="${bw * 0.88}" height="${bh * 0.88}" preserveAspectRatio="xMidYMid meet"/>`;
  return svg.replace('</svg>', badge + '</svg>').replace('<svg ', '<svg width="1000" height="1000" ');
}
app.get('/qr.svg', async (req, res) => { res.type('image/svg+xml').set('Cache-Control', 'no-store').send(await qrSvg(siteUrl(req))); });
app.get('/qr-plain.png', async (req, res) => {
  const buf = await QRCode.toBuffer(siteUrl(req), { errorCorrectionLevel: 'H', margin: 4, width: 1200, color: { dark: '#16261d', light: '#ffffff' } });
  res.type('image/png').set('Cache-Control', 'no-store').set('Content-Disposition', 'attachment; filename="EPZR-QR-code.png"').send(buf);
});
const tpl = (name) => fs.readFileSync(path.join(__dirname, 'templates', name), 'utf8');
app.get(['/print', '/screen'], async (req, res) => {
  const url = siteUrl(req);
  const page = tpl(req.path === '/print' ? 'print.html' : 'screen.html')
    .replace('{{QR}}', await qrSvg(url))
    .replace(/{{URL}}/g, esc(url.replace(/^https?:\/\//, '').replace(/\/$/, '')));
  res.set('Cache-Control', 'no-store').type('html').send(page);
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));
app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ ok: false, error: 'Something went wrong on our side. Please try again.' }); });

app.listen(PORT, () => {
  console.log(`EPZR Student Connect on :${PORT} | data ${DATA_DIR} | email ${smtpReady ? 'via ' + SMTP.host + ' as ' + SMTP.from : 'NOT CONFIGURED (submissions saved, students get an email fallback)'} -> ${MAIL_TO}`);
  if (transporter) transporter.verify().then(() => console.log('SMTP login OK')).catch((e) => console.error('SMTP check FAILED:', e.message));
});
