require('dotenv').config();

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const { pool, initializeDatabase } = require('./server-core');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'altere-esta-chave-em-producao';
const APP_URL = String(process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const isProduction = process.env.NODE_ENV === 'production';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/i.test(file.mimetype))
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, location_id: row.location_id };
}

function signIn(res, user) {
  const token = jwt.sign(publicUser(user), JWT_SECRET, { expiresIn: '7d' });
  res.cookie('aquaguard_token', token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

async function requireAuth(req, res, next) {
  try {
    const decoded = jwt.verify(req.cookies.aquaguard_token || '', JWT_SECRET);
    const result = await pool.query(`SELECT id,name,email,role,location_id FROM users WHERE id=$1 AND is_active=true`, [decoded.id]);
    if (!result.rows[0]) return res.status(401).json({ error: 'Usuário inativo ou não encontrado.' });
    req.user = publicUser(result.rows[0]);
    next();
  } catch {
    res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Acesso exclusivo para administrador.' });
  next();
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function requestedLocation(req, value) {
  if (req.user.role !== 'ADMIN') return req.user.location_id;
  return validUuid(value) ? value : null;
}

function canAccessLocation(req, locationId) {
  return req.user.role === 'ADMIN' || req.user.location_id === locationId;
}

function emailList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim().toLowerCase()).filter(Boolean);
  return String(value || '').split(/[;,\n]/).map(v => v.trim().toLowerCase()).filter(Boolean);
}

function buildMaintenanceText(m) {
  const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
  return [
    `🏊 *Relatório de Manutenção*`,
    `*Piscina:* ${m.pool_name} - ${m.location_name}`,
    `*Executante:* ${m.executor}`,
    `*Início:* ${date.format(new Date(m.started_at))}`,
    `*Término:* ${m.ended_at ? date.format(new Date(m.ended_at)) : 'Em andamento'}`,
    '',
    `*pH:* ${m.ph ?? '-'}`,
    `*Cloro livre:* ${m.chlorine ?? '-'} ppm`,
    `*Alcalinidade:* ${m.alkalinity ?? '-'} ppm`,
    `*Estabilizador (CYA):* ${m.stabilizer ?? '-'} ppm`,
    '',
    `*Serviços:* ${(m.services || []).join(', ') || '-'}`,
    m.notes ? `*Observações:* ${m.notes}` : ''
  ].filter(Boolean).join('\n');
}

async function getMaintenance(id) {
  const result = await pool.query(
    `SELECT m.*, p.name AS pool_name, p.volume_liters, l.id AS location_id, l.name AS location_name,
            l.address, l.report_emails,
            COALESCE((SELECT json_agg(json_build_object('id',mp.id,'phase',mp.phase,'file_name',mp.file_name))
                      FROM maintenance_photos mp WHERE mp.maintenance_id=m.id),'[]'::json) AS photos
     FROM maintenances m
     JOIN pools p ON p.id=m.pool_id
     JOIN locations l ON l.id=p.location_id
     WHERE m.id=$1`, [id]
  );
  return result.rows[0];
}

function createReportPdf(data, title = 'Relatório de Manutenção') {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: title } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.fillColor('#0f766e').fontSize(24).text('AquaGuard', { align: 'center' });
  doc.fillColor('#111827').fontSize(17).text(title, { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).fillColor('#374151');
  const dt = value => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value)) : '-';
  doc.text(`Local: ${data.location_name}`);
  doc.text(`Piscina: ${data.pool_name}`);
  doc.text(`Executante: ${data.executor}`);
  doc.text(`Início: ${dt(data.started_at)}`);
  doc.text(`Término: ${dt(data.ended_at)}`);
  doc.moveDown();
  doc.fontSize(14).fillColor('#111827').text('Medições químicas');
  doc.fontSize(11).fillColor('#374151');
  doc.text(`pH: ${data.ph ?? '-'}`);
  doc.text(`Cloro livre: ${data.chlorine ?? '-'} ppm`);
  doc.text(`Alcalinidade: ${data.alkalinity ?? '-'} ppm`);
  doc.text(`Estabilizador (CYA): ${data.stabilizer ?? '-'} ppm`);
  doc.moveDown();
  doc.fontSize(14).fillColor('#111827').text('Serviços executados');
  doc.fontSize(11).fillColor('#374151').text((data.services || []).map(s => `• ${s}`).join('\n') || 'Nenhum serviço informado.');
  if (data.notes) {
    doc.moveDown();
    doc.fontSize(14).fillColor('#111827').text('Observações');
    doc.fontSize(11).fillColor('#374151').text(data.notes);
  }
  doc.moveDown(2);
  doc.fontSize(9).fillColor('#6b7280').text(`Documento gerado pelo AquaGuard em ${dt(new Date())}.`, { align: 'center' });
  doc.end();
  return done;
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

function brevoConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
}

function emailConfigured() {
  return brevoConfigured() || smtpConfigured();
}

function mailTransport(connectionHost = process.env.SMTP_HOST) {
  if (!smtpConfigured()) return null;
  const configuredHost = String(process.env.SMTP_HOST);
  return nodemailer.createTransport({
    host: connectionHost,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    tls: net.isIP(connectionHost) ? { servername: configuredHost } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
}

async function sendSmtpMail(message) {
  if (!smtpConfigured()) {
    const error = new Error('SMTP não configurado.');
    error.code = 'ESMTP_CONFIG';
    throw error;
  }
  const configuredHost = String(process.env.SMTP_HOST);
  let ipv4Hosts;
  if (net.isIPv4(configuredHost)) {
    ipv4Hosts = [configuredHost];
  } else {
    ipv4Hosts = [...new Set(await dns.resolve4(configuredHost))];
  }
  if (!ipv4Hosts.length) {
    const error = new Error(`Nenhum endereço IPv4 encontrado para ${configuredHost}.`);
    error.code = 'EDNS_IPV4';
    throw error;
  }
  const retryableCodes = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
  let lastError;
  for (const ipv4Host of ipv4Hosts) {
    try {
      const info = await mailTransport(ipv4Host).sendMail(message);
      return { info, ipv4Host };
    } catch (error) {
      lastError = error;
      if (!retryableCodes.has(error.code)) throw error;
    }
  }
  throw lastError;
}

async function sendBrevoMail({ recipients, subject, text, html, attachments = [] }) {
  if (!brevoConfigured()) {
    const error = new Error('API da Brevo não configurada.');
    error.code = 'EBREVO_CONFIG';
    throw error;
  }
  const senderEmail = String(process.env.BREVO_SENDER_EMAIL).trim();
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: process.env.BREVO_SENDER_NAME || 'AquaGuard', email: senderEmail },
      to: [{ email: senderEmail }],
      bcc: recipients.map(email => ({ email })),
      subject,
      textContent: text,
      htmlContent: html || undefined,
      attachment: attachments.map(item => ({
        name: item.filename,
        content: Buffer.isBuffer(item.content) ? item.content.toString('base64') : String(item.content)
      }))
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    const error = new Error(`Brevo respondeu ${response.status}: ${detail}`);
    error.code = 'EBREVO_API';
    throw error;
  }
  return { provider: 'Brevo API', info: await response.json() };
}

async function sendAppEmail({ recipients, subject, text, html, attachments = [] }) {
  const uniqueRecipients = [...new Set(emailList(recipients))];
  if (!uniqueRecipients.length) throw new Error('Nenhum destinatário informado.');
  if (brevoConfigured()) return sendBrevoMail({ recipients: uniqueRecipients, subject, text, html, attachments });
  if (smtpConfigured()) {
    const sender = process.env.SMTP_FROM || process.env.SMTP_USER;
    const result = await sendSmtpMail({ from: sender, to: sender, bcc: uniqueRecipients, subject, text, html, attachments });
    return { provider: `SMTP IPv4 (${result.ipv4Host})`, info: result.info };
  }
  const error = new Error('Nenhum provedor de e-mail configurado.');
  error.code = 'EMAIL_CONFIG';
  throw error;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function maintenanceEmailHtml(data) {
  const dt = value => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value)) : '-';
  const services = (data.services || []).map(service => `<li style="margin:0 0 6px">${escapeHtml(service)}</li>`).join('') || '<li>Nenhum serviço informado</li>';
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#172033"><div style="max-width:680px;margin:0 auto;padding:24px"><div style="background:#0f766e;color:white;border-radius:14px 14px 0 0;padding:22px 26px"><div style="font-size:13px;opacity:.85">AquaGuard</div><h1 style="font-size:22px;margin:5px 0 0">Manutenção realizada</h1></div><div style="background:white;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 14px 14px;padding:26px"><p style="margin-top:0">A manutenção da piscina foi concluída com sucesso.</p><table style="width:100%;border-collapse:collapse;margin:18px 0"><tr><td style="padding:9px;background:#f8fafc"><strong>Local</strong><br>${escapeHtml(data.location_name)}</td><td style="padding:9px;background:#f8fafc"><strong>Piscina</strong><br>${escapeHtml(data.pool_name)}</td></tr><tr><td style="padding:9px"><strong>Executante</strong><br>${escapeHtml(data.executor)}</td><td style="padding:9px"><strong>Período</strong><br>${escapeHtml(dt(data.started_at))} a ${escapeHtml(dt(data.ended_at))}</td></tr></table><h2 style="font-size:17px;color:#0f766e">Medições químicas</h2><table style="width:100%;border-collapse:collapse;text-align:center"><tr><td style="padding:10px;border:1px solid #e5e7eb"><strong>pH</strong><br>${escapeHtml(data.ph ?? '-')}</td><td style="padding:10px;border:1px solid #e5e7eb"><strong>Cloro livre</strong><br>${escapeHtml(data.chlorine ?? '-')} ppm</td><td style="padding:10px;border:1px solid #e5e7eb"><strong>Alcalinidade</strong><br>${escapeHtml(data.alkalinity ?? '-')} ppm</td><td style="padding:10px;border:1px solid #e5e7eb"><strong>Estabilizador</strong><br>${escapeHtml(data.stabilizer ?? '-')} ppm</td></tr></table><h2 style="font-size:17px;color:#0f766e;margin-top:24px">Serviços executados</h2><ul style="padding-left:20px">${services}</ul>${data.notes ? `<h2 style="font-size:17px;color:#0f766e;margin-top:24px">Observações</h2><p>${escapeHtml(data.notes)}</p>` : ''}<p style="font-size:12px;color:#64748b;margin:28px 0 0">Mensagem enviada automaticamente pelo AquaGuard.</p></div></div></body></html>`;
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({ googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) }));
app.get('/vendor/html2canvas.min.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js')));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const result = await pool.query(`SELECT * FROM users WHERE lower(email)=lower($1) AND is_active=true`, [email]);
  const user = result.rows[0];
  if (!user || !user.password_hash || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }
  signIn(res, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('aquaguard_token');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(503).send('Login Google ainda não configurado.');
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie('google_oauth_state', state, { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${APP_URL}/auth/google/callback`,
    response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', asyncRoute(async (req, res) => {
  if (!req.query.code || req.query.state !== req.cookies.google_oauth_state) return res.redirect('/login?erro=google');
  res.clearCookie('google_oauth_state');
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: req.query.code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: `${APP_URL}/auth/google/callback`, grant_type: 'authorization_code' })
  });
  if (!tokenResponse.ok) return res.redirect('/login?erro=google');
  const tokens = await tokenResponse.json();
  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } });
  const profile = await profileResponse.json();
  const registered = (await pool.query(`SELECT * FROM users WHERE lower(email)=lower($1) AND is_active=true`, [profile.email])).rows[0];
  if (!registered) return res.redirect('/login?erro=usuario-nao-cadastrado');
  const result = await pool.query(
    `UPDATE users SET google_id=$1,updated_at=now() WHERE id=$2 RETURNING *`,
    [profile.sub, registered.id]
  );
  signIn(res, result.rows[0]);
  res.redirect('/dashboard');
}));

app.use('/api', requireAuth);

app.get('/api/users', requireAdmin, asyncRoute(async (_req, res) => {
  const result = await pool.query(
    `SELECT u.id,u.name,u.email,u.role,u.is_active,u.location_id,l.name AS location_name,u.created_at,u.updated_at
     FROM users u
     JOIN locations l ON l.id=u.location_id
     ORDER BY l.name,u.name,u.email`
  );
  res.json(result.rows);
}));

app.post('/api/users', requireAdmin, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'ADMIN' ? 'ADMIN' : 'USER';
  const locationId = String(req.body.location_id || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Informe um nome e um e-mail válidos.' });
  if (!validUuid(locationId)) return res.status(400).json({ error: 'Selecione o local do usuário.' });
  if (!(await pool.query(`SELECT 1 FROM locations WHERE id=$1`, [locationId])).rowCount) return res.status(400).json({ error: 'O local selecionado não existe.' });
  if (password.length < 8) return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
  const hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO users(name,email,password_hash,role,is_active,location_id)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING id,name,email,role,is_active,location_id,created_at,updated_at`,
    [name, email, hash, role, req.body.is_active !== false, locationId]
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/users/:id', requireAdmin, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'ADMIN' ? 'ADMIN' : 'USER';
  const locationId = String(req.body.location_id || '');
  const isSelf = req.params.id === req.user.id;
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Informe um nome e um e-mail válidos.' });
  if (!validUuid(locationId)) return res.status(400).json({ error: 'Selecione o local do usuário.' });
  if (!(await pool.query(`SELECT 1 FROM locations WHERE id=$1`, [locationId])).rowCount) return res.status(400).json({ error: 'O local selecionado não existe.' });
  if (password && password.length < 8) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 8 caracteres.' });
  if (isSelf && (role !== 'ADMIN' || req.body.is_active === false)) return res.status(400).json({ error: 'Você não pode remover seu próprio acesso de administrador.' });
  const hash = password ? await bcrypt.hash(password, 12) : null;
  const result = await pool.query(
    `UPDATE users
     SET name=$1,email=$2,role=$3,is_active=$4,location_id=$5,
         password_hash=CASE WHEN $6::text IS NULL THEN password_hash ELSE $6 END,
         updated_at=now()
     WHERE id=$7
     RETURNING id,name,email,role,is_active,location_id,created_at,updated_at`,
    [name, email, role, req.body.is_active !== false, locationId, hash, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.json(result.rows[0]);
}));

app.get('/api/locations', asyncRoute(async (_req, res) => {
  const result = _req.user.role === 'ADMIN'
    ? await pool.query(`SELECT * FROM locations ORDER BY name`)
    : await pool.query(`SELECT * FROM locations WHERE id=$1 ORDER BY name`, [_req.user.location_id]);
  res.json(result.rows);
}));

app.post('/api/locations', requireAdmin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `INSERT INTO locations(name,address,report_emails,is_active) VALUES($1,$2,$3,$4) RETURNING *`,
    [String(req.body.name || '').trim(), String(req.body.address || '').trim() || null, emailList(req.body.report_emails), req.body.is_active !== false]
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/locations/:id', requireAdmin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE locations SET name=$1,address=$2,report_emails=$3,is_active=$4,updated_at=now() WHERE id=$5 RETURNING *`,
    [String(req.body.name || '').trim(), String(req.body.address || '').trim() || null, emailList(req.body.report_emails), req.body.is_active !== false, req.params.id]
  );
  res.json(result.rows[0]);
}));

app.delete('/api/locations/:id', requireAdmin, asyncRoute(async (req, res) => {
  await pool.query(`UPDATE locations SET is_active=false,updated_at=now() WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/pools', asyncRoute(async (req, res) => {
  const args = [];
  let where = '';
  const locationId = requestedLocation(req, req.query.location_id);
  if (locationId) { args.push(locationId); where = `WHERE p.location_id=$1`; }
  const result = await pool.query(
    `SELECT p.*,l.name AS location_name FROM pools p JOIN locations l ON l.id=p.location_id ${where} ORDER BY p.name`, args
  );
  res.json(result.rows);
}));

app.post('/api/pools', requireAdmin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `INSERT INTO pools(location_id,name,pool_location,volume_liters,is_active) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [req.body.location_id, String(req.body.name || '').trim(), String(req.body.pool_location || '').trim() || null, req.body.volume_liters || null, req.body.is_active !== false]
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/pools/:id', requireAdmin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE pools SET location_id=$1,name=$2,pool_location=$3,volume_liters=$4,is_active=$5,updated_at=now() WHERE id=$6 RETURNING *`,
    [req.body.location_id, String(req.body.name || '').trim(), String(req.body.pool_location || '').trim() || null, req.body.volume_liters || null, req.body.is_active !== false, req.params.id]
  );
  res.json(result.rows[0]);
}));

app.delete('/api/pools/:id', requireAdmin, asyncRoute(async (req, res) => {
  await pool.query(`UPDATE pools SET is_active=false,updated_at=now() WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const locationId = requestedLocation(req, req.query.location_id);
  const poolId = validUuid(req.query.pool_id) ? req.query.pool_id : null;
  const params = [];
  const conditions = [`m.status='COMPLETED'`];
  if (locationId) { params.push(locationId); conditions.push(`p.location_id=$${params.length}`); }
  if (poolId) { params.push(poolId); conditions.push(`m.pool_id=$${params.length}`); }
  const where = conditions.join(' AND ');
  const [activePools, today, total, history, trends] = await Promise.all([
    pool.query(`SELECT count(*)::int AS count FROM pools p WHERE p.is_active=true ${locationId ? `AND p.location_id=$1` : ''}`, locationId ? [locationId] : []),
    pool.query(`SELECT count(*)::int AS count FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE ${where} AND (m.started_at AT TIME ZONE 'America/Sao_Paulo')::date=(now() AT TIME ZONE 'America/Sao_Paulo')::date`, params),
    pool.query(`SELECT count(*)::int AS count FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE ${where}`, params),
    pool.query(`SELECT m.id,m.executor,m.started_at,m.ended_at,m.ph,m.chlorine,m.alkalinity,m.stabilizer,m.services,m.notes,p.name AS pool_name,l.name AS location_name FROM maintenances m JOIN pools p ON p.id=m.pool_id JOIN locations l ON l.id=p.location_id WHERE ${where} ORDER BY m.started_at DESC LIMIT 100`, params),
    pool.query(`SELECT m.id,m.started_at,m.ph,m.chlorine,m.alkalinity,m.stabilizer,p.name AS pool_name FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE ${where} ORDER BY m.started_at ASC LIMIT 100`, params)
  ]);
  res.json({ stats: { activePools: activePools.rows[0].count, today: today.rows[0].count, total: total.rows[0].count }, history: history.rows, trends: trends.rows });
}));

app.get('/api/reports/maintenances', asyncRoute(async (req, res) => {
  const locationId = requestedLocation(req, req.query.location_id);
  const poolId = req.query.pool_id ? String(req.query.pool_id) : null;
  const dateFrom = req.query.date_from ? String(req.query.date_from) : null;
  const dateTo = req.query.date_to ? String(req.query.date_to) : null;
  if (poolId && !validUuid(poolId)) return res.status(400).json({ error: 'Piscina inválida.' });
  if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) return res.status(400).json({ error: 'Data inicial inválida.' });
  if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) return res.status(400).json({ error: 'Data final inválida.' });
  if (dateFrom && dateTo && dateFrom > dateTo) return res.status(400).json({ error: 'A data inicial não pode ser maior que a data final.' });
  const params = [];
  const conditions = [`m.status='COMPLETED'`];
  if (locationId) { params.push(locationId); conditions.push(`p.location_id=$${params.length}`); }
  if (poolId) { params.push(poolId); conditions.push(`m.pool_id=$${params.length}`); }
  if (dateFrom) { params.push(dateFrom); conditions.push(`(m.started_at AT TIME ZONE 'America/Sao_Paulo')::date >= $${params.length}::date`); }
  if (dateTo) { params.push(dateTo); conditions.push(`(m.started_at AT TIME ZONE 'America/Sao_Paulo')::date <= $${params.length}::date`); }
  const rows = (await pool.query(
    `SELECT m.id,m.executor,m.started_at,m.ended_at,m.ph,m.chlorine,m.alkalinity,m.stabilizer,m.services,m.notes,
            p.id AS pool_id,p.name AS pool_name,l.id AS location_id,l.name AS location_name
     FROM maintenances m
     JOIN pools p ON p.id=m.pool_id
     JOIN locations l ON l.id=p.location_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.started_at DESC
     LIMIT 1000`, params
  )).rows;
  res.json({
    summary: {
      total: rows.length,
      pools: new Set(rows.map(row => row.pool_id)).size,
      services: rows.reduce((total, row) => total + (row.services || []).length, 0)
    },
    rows
  });
}));

app.get('/api/maintenances/active', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT m.*,p.name AS pool_name,p.location_id,l.name AS location_name FROM maintenances m JOIN pools p ON p.id=m.pool_id JOIN locations l ON l.id=p.location_id WHERE m.status='STARTED' AND m.created_by=$1 ORDER BY m.started_at DESC LIMIT 1`, [req.user.id]
  );
  res.json(result.rows[0] || null);
}));

app.post('/api/maintenances/start', upload.array('photos', 5), asyncRoute(async (req, res) => {
  if (!validUuid(req.body.pool_id) || !String(req.body.executor || '').trim()) return res.status(400).json({ error: 'Informe a piscina e o executante.' });
  const selectedPool = (await pool.query(`SELECT location_id FROM pools WHERE id=$1 AND is_active=true`, [req.body.pool_id])).rows[0];
  if (!selectedPool || !canAccessLocation(req, selectedPool.location_id)) return res.status(403).json({ error: 'Piscina não disponível para este usuário.' });
  const active = (await pool.query(`SELECT m.id,p.name AS pool_name FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE m.status='STARTED' AND m.created_by=$1 ORDER BY m.started_at DESC LIMIT 1`, [req.user.id])).rows[0];
  if (active) return res.status(409).json({ error: `Você já possui um serviço em andamento na ${active.pool_name}. Finalize-o antes de iniciar outro.` });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`INSERT INTO maintenances(pool_id,executor,status,created_by) VALUES($1,$2,'STARTED',$3) RETURNING *`, [req.body.pool_id, String(req.body.executor).trim(), req.user.id]);
    for (const file of req.files || []) await client.query(`INSERT INTO maintenance_photos(maintenance_id,phase,file_name,mime_type,file_data) VALUES($1,'START',$2,$3,$4)`, [result.rows[0].id, file.originalname, file.mimetype, file.buffer]);
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.post('/api/maintenances/:id/complete', upload.array('photos', 5), asyncRoute(async (req, res) => {
  const measurements = ['ph', 'chlorine', 'alkalinity', 'stabilizer'];
  if (measurements.some(field => req.body[field] === undefined || req.body[field] === '' || !Number.isFinite(Number(req.body[field])))) {
    return res.status(400).json({ error: 'Informe todas as medições químicas, incluindo o estabilizador em ppm.' });
  }
  const services = JSON.parse(req.body.services || '[]');
  const target = (await pool.query(`SELECT p.location_id,m.created_by FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE m.id=$1`, [req.params.id])).rows[0];
  if (!target || !canAccessLocation(req, target.location_id) || (req.user.role !== 'ADMIN' && target.created_by !== req.user.id)) return res.status(403).json({ error: 'Manutenção não disponível para este usuário.' });
  const client = await pool.connect();
  let completedMaintenance;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE maintenances SET status='COMPLETED',ended_at=now(),ph=$1,chlorine=$2,alkalinity=$3,stabilizer=$4,services=$5,notes=$6,updated_at=now() WHERE id=$7 AND status='STARTED' RETURNING *`,
      [req.body.ph, req.body.chlorine, req.body.alkalinity, req.body.stabilizer, services, String(req.body.notes || '').trim() || null, req.params.id]
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este serviço já foi encerrado ou não existe.' });
    }
    for (const file of req.files || []) await client.query(`INSERT INTO maintenance_photos(maintenance_id,phase,file_name,mime_type,file_data) VALUES($1,'END',$2,$3,$4)`, [req.params.id, file.originalname, file.mimetype, file.buffer]);
    await client.query('COMMIT');
    completedMaintenance = result.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

  res.json(completedMaintenance);
}));

app.get('/api/maintenances/:id', asyncRoute(async (req, res) => {
  const data = await getMaintenance(req.params.id);
  if (!data) return res.status(404).json({ error: 'Manutenção não encontrada.' });
  if (!canAccessLocation(req, data.location_id)) return res.status(403).json({ error: 'Manutenção não disponível para este usuário.' });
  res.json({ ...data, whatsapp_text: buildMaintenanceText(data) });
}));

app.get('/api/photos/:id', asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT mp.mime_type,mp.file_data,p.location_id FROM maintenance_photos mp JOIN maintenances m ON m.id=mp.maintenance_id JOIN pools p ON p.id=m.pool_id WHERE mp.id=$1`, [req.params.id]);
  if (!result.rows[0]) return res.sendStatus(404);
  if (!canAccessLocation(req, result.rows[0].location_id)) return res.sendStatus(403);
  res.type(result.rows[0].mime_type).send(result.rows[0].file_data);
}));

app.get('/api/maintenances/:id/report.pdf', asyncRoute(async (req, res) => {
  const data = await getMaintenance(req.params.id);
  if (!data) return res.sendStatus(404);
  if (!canAccessLocation(req, data.location_id)) return res.sendStatus(403);
  const pdf = await createReportPdf(data);
  res.setHeader('Content-Disposition', `attachment; filename="relatorio-${data.pool_name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.pdf"`);
  res.type('application/pdf').send(pdf);
}));

app.post('/api/reports/evolution/email', asyncRoute(async (req, res) => {
  if (!validUuid(req.body.pool_id)) return res.status(400).json({ error: 'Selecione uma piscina.' });
  const p = await pool.query(`SELECT p.*,l.name AS location_name,l.report_emails FROM pools p JOIN locations l ON l.id=p.location_id WHERE p.id=$1`, [req.body.pool_id]);
  if (!p.rows[0]) return res.sendStatus(404);
  if (!canAccessLocation(req, p.rows[0].location_id)) return res.status(403).json({ error: 'Piscina não disponível para este usuário.' });
  const rows = (await pool.query(`SELECT * FROM maintenances WHERE pool_id=$1 AND status='COMPLETED' ORDER BY started_at DESC LIMIT 60`, [req.body.pool_id])).rows;
  if (!emailConfigured()) return res.status(503).json({ error: 'Configure a API da Brevo ou o SMTP no Render para enviar relatórios.' });
  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const pdfDone = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.fontSize(22).fillColor('#0f766e').text('AquaGuard', { align: 'center' });
  doc.fontSize(15).fillColor('#111827').text(`Evolução Química - ${p.rows[0].name}`, { align: 'center' }).moveDown();
  rows.forEach(r => doc.fontSize(9).fillColor('#374151').text(`${new Date(r.started_at).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'})}   pH ${r.ph ?? '-'}   Cloro ${r.chlorine ?? '-'}   Alcalinidade ${r.alkalinity ?? '-'}   Estabilizador ${r.stabilizer ?? '-'} ppm`));
  doc.end();
  const pdf = await pdfDone;
  const recipients = emailList(req.body.emails?.length ? req.body.emails : p.rows[0].report_emails);
  if (!recipients.length) return res.status(400).json({ error: 'O local não possui e-mails cadastrados.' });
  await sendAppEmail({ recipients, subject: `AquaGuard - Evolução Química - ${p.rows[0].name}`, text: `Segue o relatório de evolução química da ${p.rows[0].name}.`, attachments: [{ filename: 'evolucao-quimica.pdf', content: pdf }] });
  res.json({ ok: true, recipients });
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/usuarios', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'usuarios.html')));
app.get(/^(?!\/api\/|\/auth\/|\/health$).*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Cada foto deve ter no máximo 6 MB.' });
  if (error.code === '23505') return res.status(409).json({ error: 'Já existe um usuário cadastrado com este e-mail.' });
  res.status(500).json({ error: 'Não foi possível concluir a operação.', detail: isProduction ? undefined : error.message });
});

initializeDatabase()
  .then(() => app.listen(PORT, () => console.log(`AquaGuard disponível na porta ${PORT}`)))
  .catch(error => { console.error('Falha na inicialização:', error); process.exit(1); });
