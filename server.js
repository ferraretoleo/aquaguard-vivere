require('dotenv').config();

const crypto = require('crypto');
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
  return { id: row.id, name: row.name, email: row.email, role: row.role };
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

function requireAuth(req, res, next) {
  try {
    req.user = jwt.verify(req.cookies.aquaguard_token || '', JWT_SECRET);
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

function mailTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
  });
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({ googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) }));

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
  const result = await pool.query(
    `INSERT INTO users(name,email,google_id,role)
     VALUES($1,lower($2),$3,CASE WHEN lower($2)=lower($4) THEN 'ADMIN' ELSE 'USER' END)
     ON CONFLICT ((lower(email))) DO UPDATE SET name=EXCLUDED.name, google_id=EXCLUDED.google_id, is_active=true, updated_at=now()
     RETURNING *`, [profile.name || profile.email, profile.email, profile.sub, process.env.ADMIN_EMAIL || '']
  );
  signIn(res, result.rows[0]);
  res.redirect('/dashboard');
}));

app.use('/api', requireAuth);

app.get('/api/locations', asyncRoute(async (_req, res) => {
  const result = await pool.query(`SELECT * FROM locations ORDER BY name`);
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
  if (validUuid(req.query.location_id)) { args.push(req.query.location_id); where = `WHERE p.location_id=$1`; }
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
  const locationId = validUuid(req.query.location_id) ? req.query.location_id : null;
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
    pool.query(`SELECT m.id,m.executor,m.started_at,m.ended_at,m.ph,m.chlorine,m.alkalinity,m.services,m.notes,p.name AS pool_name,l.name AS location_name FROM maintenances m JOIN pools p ON p.id=m.pool_id JOIN locations l ON l.id=p.location_id WHERE ${where} ORDER BY m.started_at DESC LIMIT 100`, params),
    pool.query(`SELECT m.id,m.started_at,m.ph,m.chlorine,m.alkalinity,p.name AS pool_name FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE ${where} ORDER BY m.started_at ASC LIMIT 100`, params)
  ]);
  res.json({ stats: { activePools: activePools.rows[0].count, today: today.rows[0].count, total: total.rows[0].count }, history: history.rows, trends: trends.rows });
}));

app.get('/api/maintenances/active', asyncRoute(async (req, res) => {
  const args = [req.user.id];
  let extra = '';
  if (validUuid(req.query.location_id)) { args.push(req.query.location_id); extra = `AND p.location_id=$2`; }
  const result = await pool.query(
    `SELECT m.*,p.name AS pool_name,p.location_id,l.name AS location_name FROM maintenances m JOIN pools p ON p.id=m.pool_id JOIN locations l ON l.id=p.location_id WHERE m.status='STARTED' AND m.created_by=$1 ${extra} ORDER BY m.started_at DESC LIMIT 1`, args
  );
  res.json(result.rows[0] || null);
}));

app.post('/api/maintenances/start', upload.array('photos', 5), asyncRoute(async (req, res) => {
  if (!validUuid(req.body.pool_id) || !String(req.body.executor || '').trim()) return res.status(400).json({ error: 'Informe a piscina e o executante.' });
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
  const services = JSON.parse(req.body.services || '[]');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE maintenances SET status='COMPLETED',ended_at=now(),ph=$1,chlorine=$2,alkalinity=$3,services=$4,notes=$5,updated_at=now() WHERE id=$6 AND status='STARTED' RETURNING *`,
      [req.body.ph || null, req.body.chlorine || null, req.body.alkalinity || null, services, String(req.body.notes || '').trim() || null, req.params.id]
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este serviço já foi encerrado ou não existe.' });
    }
    for (const file of req.files || []) await client.query(`INSERT INTO maintenance_photos(maintenance_id,phase,file_name,mime_type,file_data) VALUES($1,'END',$2,$3,$4)`, [req.params.id, file.originalname, file.mimetype, file.buffer]);
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.get('/api/maintenances/:id', asyncRoute(async (req, res) => {
  const data = await getMaintenance(req.params.id);
  if (!data) return res.status(404).json({ error: 'Manutenção não encontrada.' });
  res.json({ ...data, whatsapp_text: buildMaintenanceText(data) });
}));

app.get('/api/photos/:id', asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT mime_type,file_data FROM maintenance_photos WHERE id=$1`, [req.params.id]);
  if (!result.rows[0]) return res.sendStatus(404);
  res.type(result.rows[0].mime_type).send(result.rows[0].file_data);
}));

app.get('/api/maintenances/:id/report.pdf', asyncRoute(async (req, res) => {
  const data = await getMaintenance(req.params.id);
  if (!data) return res.sendStatus(404);
  const pdf = await createReportPdf(data);
  res.setHeader('Content-Disposition', `attachment; filename="relatorio-${data.pool_name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.pdf"`);
  res.type('application/pdf').send(pdf);
}));

app.post('/api/reports/evolution/email', asyncRoute(async (req, res) => {
  if (!validUuid(req.body.pool_id)) return res.status(400).json({ error: 'Selecione uma piscina.' });
  const p = await pool.query(`SELECT p.*,l.name AS location_name,l.report_emails FROM pools p JOIN locations l ON l.id=p.location_id WHERE p.id=$1`, [req.body.pool_id]);
  if (!p.rows[0]) return res.sendStatus(404);
  const rows = (await pool.query(`SELECT * FROM maintenances WHERE pool_id=$1 AND status='COMPLETED' ORDER BY started_at DESC LIMIT 60`, [req.body.pool_id])).rows;
  const transport = mailTransport();
  if (!transport) return res.status(503).json({ error: 'Configure o SMTP no Render para enviar relatórios.' });
  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const pdfDone = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.fontSize(22).fillColor('#0f766e').text('AquaGuard', { align: 'center' });
  doc.fontSize(15).fillColor('#111827').text(`Evolução Química - ${p.rows[0].name}`, { align: 'center' }).moveDown();
  rows.forEach(r => doc.fontSize(9).fillColor('#374151').text(`${new Date(r.started_at).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'})}   pH ${r.ph ?? '-'}   Cloro ${r.chlorine ?? '-'}   Alcalinidade ${r.alkalinity ?? '-'}`));
  doc.end();
  const pdf = await pdfDone;
  const recipients = emailList(req.body.emails?.length ? req.body.emails : p.rows[0].report_emails);
  if (!recipients.length) return res.status(400).json({ error: 'O local não possui e-mails cadastrados.' });
  await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: recipients.join(','), subject: `AquaGuard - Evolução Química - ${p.rows[0].name}`, text: `Segue o relatório de evolução química da ${p.rows[0].name}.`, attachments: [{ filename: 'evolucao-quimica.pdf', content: pdf }] });
  res.json({ ok: true, recipients });
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get(/^(?!\/api\/|\/auth\/|\/health$).*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Cada foto deve ter no máximo 6 MB.' });
  res.status(500).json({ error: 'Não foi possível concluir a operação.', detail: isProduction ? undefined : error.message });
});

initializeDatabase()
  .then(() => app.listen(PORT, () => console.log(`AquaGuard disponível na porta ${PORT}`)))
  .catch(error => { console.error('Falha na inicialização:', error); process.exit(1); });
