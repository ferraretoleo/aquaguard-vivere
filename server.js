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

const ROLE_ADMIN = 'ADMIN';
const ROLE_LOCAL_ADMIN = 'LOCAL_ADMIN';
const ROLE_USER = 'USER';
const PAYMENT_METHODS = ['PIX','BOLETO','TRANSFERENCIA','CARTAO','DINHEIRO','DEBITO_AUTOMATICO','OUTRO'];

function publicUser(row) {
  const locationIds = Array.isArray(row.location_ids)
    ? row.location_ids.filter(Boolean)
    : (row.location_id ? [row.location_id] : []);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    location_id: locationIds[0] || null,
    location_ids: locationIds
  };
}

async function userWithLocations(userId) {
  const result = await pool.query(
    `SELECT u.*,
            COALESCE(array_agg(ul.location_id ORDER BY ul.created_at)
              FILTER (WHERE ul.location_id IS NOT NULL),'{}'::uuid[]) AS location_ids
     FROM users u
     LEFT JOIN user_locations ul ON ul.user_id=u.id
     WHERE u.id=$1
     GROUP BY u.id`,
    [userId]
  );
  return result.rows[0] || null;
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
    const user = await userWithLocations(decoded.id);
    if (!user?.is_active) return res.status(401).json({ error: 'Usuário inativo ou não encontrado.' });
    req.user = publicUser(user);
    next();
  } catch {
    res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== ROLE_ADMIN) return res.status(403).json({ error: 'Acesso exclusivo para administrador geral.' });
  next();
}

function requireLocalManager(req, res, next) {
  if (![ROLE_ADMIN, ROLE_LOCAL_ADMIN].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Seu perfil não permite alterar este cadastro.' });
  }
  next();
}

function isGlobalAdmin(user) {
  return user?.role === ROLE_ADMIN;
}

function canManageLocalData(user) {
  return [ROLE_ADMIN, ROLE_LOCAL_ADMIN].includes(user?.role);
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function canAccessLocation(req, locationId) {
  return isGlobalAdmin(req.user) || (req.user.location_ids || []).includes(String(locationId));
}

function itineraryScope(req, alias, params) {
  if (isGlobalAdmin(req.user)) return null;
  let responsibleScope = '';
  if (req.user.role === ROLE_USER) {
    params.push(req.user.id);
    responsibleScope = `${alias}.responsible_user_id=$${params.length} AND `;
  }
  params.push(req.user.location_ids || []);
  return `(${responsibleScope}
    EXISTS(SELECT 1 FROM itinerary_stops scope_stops WHERE scope_stops.itinerary_id=${alias}.id)
    AND NOT EXISTS(
      SELECT 1 FROM itinerary_stops outside_stops
      WHERE outside_stops.itinerary_id=${alias}.id
        AND NOT (outside_stops.location_id=ANY($${params.length}::uuid[]))
    )
  )`;
}

async function canAccessItinerary(req, itineraryId) {
  const params = [itineraryId];
  const scope = itineraryScope(req, 'i', params);
  const result = await pool.query(
    `SELECT 1 FROM itineraries i WHERE i.id=$1${scope ? ` AND ${scope}` : ''}`,
    params
  );
  return Boolean(result.rows[0]);
}

async function itineraryResponsible(req, requestedUserId, locationIds) {
  const targetId = canManageLocalData(req.user) && validUuid(requestedUserId)
    ? String(requestedUserId)
    : String(req.user.id);
  if (req.user.role === ROLE_USER && targetId !== String(req.user.id)) {
    const error = new Error('O usuário comum só pode criar itinerários para si mesmo.'); error.status = 403; throw error;
  }
  const target = await userWithLocations(targetId);
  if (!target?.is_active) { const error = new Error('Selecione um usuário ativo para o itinerário.'); error.status = 400; throw error; }
  const targetLocations = Array.isArray(target.location_ids) ? target.location_ids.map(String) : [];
  if (req.user.role === ROLE_LOCAL_ADMIN && targetId !== String(req.user.id)) {
    const shared = target.role !== ROLE_ADMIN && targetLocations.some(id => (req.user.location_ids || []).includes(id));
    if (!shared) { const error = new Error('O usuário escolhido não está associado aos mesmos locais deste administrador.'); error.status = 403; throw error; }
  }
  if (locationIds.some(id => !canAccessLocation(req, id))) {
    const error = new Error('Um ou mais locais não estão disponíveis para este administrador.'); error.status = 403; throw error;
  }
  if (target.role !== ROLE_ADMIN && locationIds.some(id => !targetLocations.includes(String(id)))) {
    const error = new Error('Todos os locais do itinerário devem estar associados ao usuário responsável.'); error.status = 403; throw error;
  }
  return target;
}

function locationScope(req, requestedValue, column, params) {
  const requested = validUuid(requestedValue) ? String(requestedValue) : null;
  if (requested) {
    if (!canAccessLocation(req, requested)) {
      const error = new Error('Local não disponível para este usuário.');
      error.status = 403;
      throw error;
    }
    params.push(requested);
    return `${column}=$${params.length}`;
  }
  if (isGlobalAdmin(req.user)) return null;
  params.push(req.user.location_ids || []);
  return `${column}=ANY($${params.length}::uuid[])`;
}

function normalizeLocationIds(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(values.map(String).filter(validUuid))];
}

async function ensureLocationsExist(locationIds) {
  if (!locationIds.length) return true;
  const result = await pool.query(`SELECT count(*)::int AS count FROM locations WHERE id=ANY($1::uuid[])`, [locationIds]);
  return result.rows[0].count === locationIds.length;
}

async function userRecord(userId) {
  const result = await pool.query(
    `SELECT u.id,u.name,u.email,u.role,u.is_active,u.created_at,u.updated_at,
            COALESCE(array_agg(l.id ORDER BY l.name) FILTER (WHERE l.id IS NOT NULL),'{}'::uuid[]) AS location_ids,
            COALESCE(json_agg(json_build_object('id',l.id,'name',l.name) ORDER BY l.name)
              FILTER (WHERE l.id IS NOT NULL),'[]'::json) AS locations
     FROM users u
     LEFT JOIN user_locations ul ON ul.user_id=u.id
     LEFT JOIN locations l ON l.id=ul.location_id
     WHERE u.id=$1
     GROUP BY u.id`,
    [userId]
  );
  return result.rows[0] || null;
}

function emailList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim().toLowerCase()).filter(Boolean);
  return String(value || '').split(/[;,\n]/).map(v => v.trim().toLowerCase()).filter(Boolean);
}

function notificationContacts(value) {
  let contacts = value;
  if (typeof contacts === 'string') {
    try { contacts = JSON.parse(contacts); } catch { contacts = []; }
  }
  if (!Array.isArray(contacts)) return [];
  return contacts.map(contact => ({
    name: String(contact?.name || '').trim(),
    phone: String(contact?.phone || '').trim()
  })).filter(contact => contact.name && contact.phone);
}

function formatDocumentNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return null;
}

function contractNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function locationContract(body) {
  const rawPlanId = String(body.payment_plan_id || '').trim();
  const paymentPlanId = validUuid(rawPlanId) ? rawPlanId : null;
  if (rawPlanId && !paymentPlanId) { const error = new Error('Selecione um plano de pagamento válido.'); error.status = 400; throw error; }
  if (!paymentPlanId) return { paymentPlanId: null, contractValue: null, paymentMethod: null, paymentType: null, paymentDueDay: null, monthlyAmount: null, installmentCount: null, installmentAmount: null };
  const contractValue = contractNumber(body.contract_value);
  const paymentMethod = PAYMENT_METHODS.includes(body.payment_method) ? body.payment_method : null;
  const paymentType = ['MONTHLY','INSTALLMENTS'].includes(body.payment_type) ? body.payment_type : null;
  const paymentDueDay = Number.parseInt(body.payment_due_day, 10);
  const monthlyAmount = paymentType === 'MONTHLY' ? contractNumber(body.monthly_amount) : null;
  const installmentCount = paymentType === 'INSTALLMENTS' ? Number.parseInt(body.installment_count, 10) : null;
  const installmentAmount = paymentType === 'INSTALLMENTS' ? contractNumber(body.installment_amount) : null;
  if (!(contractValue >= 0) || !paymentMethod || !paymentType) { const error = new Error('Informe o valor do contrato, usando 0 quando não houver valor contratual, além da forma e do tipo de pagamento.'); error.status = 400; throw error; }
  if (!(paymentDueDay >= 1 && paymentDueDay <= 31)) { const error = new Error('Informe o dia de vencimento entre 1 e 31.'); error.status = 400; throw error; }
  if (paymentType === 'MONTHLY' && !(monthlyAmount > 0)) { const error = new Error('Informe o valor mensal do contrato.'); error.status = 400; throw error; }
  if (paymentType === 'INSTALLMENTS' && (!(installmentCount > 0) || !(installmentAmount > 0))) { const error = new Error('Informe a quantidade e o valor das parcelas.'); error.status = 400; throw error; }
  return { paymentPlanId, contractValue, paymentMethod, paymentType, paymentDueDay, monthlyAmount, installmentCount, installmentAmount };
}

async function canUsePaymentPlan(req, paymentPlanId) {
  if (!paymentPlanId) return true;
  if (isGlobalAdmin(req.user)) return Boolean((await pool.query(`SELECT 1 FROM payment_plans WHERE id=$1`, [paymentPlanId])).rows[0]);
  const result = await pool.query(
    `SELECT 1 FROM payment_plans WHERE id=$1 AND created_by=$2`,
    [paymentPlanId, req.user.id]
  );
  return Boolean(result.rows[0]);
}

function parseQuoteItems(value) {
  let items = value;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = []; }
  }
  if (!Array.isArray(items)) return [];
  return items.map(item => ({
    description: String(item?.description || '').trim(),
    value: Math.round(Number(item?.value) * 100) / 100
  }));
}

function formatBrl(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
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
    m.problems_found ? `*Problemas encontrados:* ${m.problems_found}` : '',
    m.notes ? `*Observações:* ${m.notes}` : '',
    m.quote_total !== null && m.quote_total !== undefined ? `*Orçamento:* ${formatBrl(m.quote_total)}` : ''
  ].filter(Boolean).join('\n');
}

async function getMaintenance(id) {
  const result = await pool.query(
    `SELECT m.*, p.name AS pool_name, p.volume_liters, l.id AS location_id, l.name AS location_name,
            l.address, l.document_number, l.report_emails,
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
  if (data.problems_found) {
    doc.moveDown();
    doc.fontSize(14).fillColor('#991b1b').text('Problemas encontrados');
    doc.fontSize(11).fillColor('#374151').text(data.problems_found);
  }
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

function createQuotePdf(data) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Orçamento - ${data.pool_name}` } });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const dt = value => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value)) : '-';
  const items = Array.isArray(data.quote_items) ? data.quote_items : [];

  doc.fillColor('#0f766e').fontSize(26).text('AquaGuard', { align: 'center' });
  doc.fillColor('#111827').fontSize(19).text('Orçamento de Manutenção', { align: 'center' });
  doc.fontSize(10).fillColor('#6b7280').text(`Orçamento nº ${String(data.id).slice(0, 8).toUpperCase()}`, { align: 'center' });
  doc.moveDown(1.5);

  const infoBoxY = doc.y;
  doc.roundedRect(48, infoBoxY, 499, 118, 8).fillAndStroke('#f8fafc', '#e5e7eb');
  const infoY = infoBoxY + 14;
  doc.fillColor('#111827').fontSize(11).text(`Local: ${data.location_name}`, 62, infoY, { width: 225 });
  doc.text(`Piscina: ${data.pool_name}`, 300, infoY, { width: 230 });
  doc.text(`Endereço: ${data.address || 'Não informado'}`, 62, infoY + 25, { width: 470 });
  doc.text(`CNPJ/CPF: ${data.document_number || 'Não informado'}`, 62, infoY + 50, { width: 225 });
  doc.text(`Data: ${dt(data.quote_created_at || data.ended_at)}`, 300, infoY + 50, { width: 230 });
  doc.text(`Executante: ${data.executor}`, 62, infoY + 75, { width: 470 });
  doc.y = infoBoxY + 132;

  doc.fillColor('#111827').fontSize(13).text('Descrição');
  doc.fillColor('#374151').fontSize(11).text(data.problems_found || 'Não informada.');
  doc.moveDown(1.2);

  let y = doc.y;
  const drawTableHeader = () => {
    doc.rect(48, y, 499, 28).fill('#0f766e');
    doc.fillColor('#ffffff').fontSize(10).text('Item', 60, y + 9, { width: 355 });
    doc.text('Valor', 430, y + 9, { width: 105, align: 'right' });
    y += 28;
  };
  drawTableHeader();
  items.forEach((item, index) => {
    const description = `${index + 1}. ${item.description}`;
    const rowHeight = Math.max(30, doc.heightOfString(description, { width: 355 }) + 16);
    if (y + rowHeight > 735) {
      doc.addPage();
      y = 48;
      drawTableHeader();
    }
    doc.rect(48, y, 499, rowHeight).fillAndStroke(index % 2 ? '#ffffff' : '#f8fafc', '#e5e7eb');
    doc.fillColor('#374151').fontSize(10).text(description, 60, y + 8, { width: 355 });
    doc.text(formatBrl(item.value), 430, y + 8, { width: 105, align: 'right' });
    y += rowHeight;
  });

  if (y + 58 > 750) { doc.addPage(); y = 48; }
  doc.roundedRect(337, y + 14, 210, 40, 7).fill('#ecfdf5');
  doc.fillColor('#065f46').fontSize(13).text('Valor total', 351, y + 27, { width: 90 });
  doc.fontSize(15).text(formatBrl(data.quote_total), 430, y + 25, { width: 103, align: 'right' });
  doc.y = y + 78;
  doc.fontSize(9).fillColor('#6b7280').text('Orçamento gerado pelo AquaGuard. Os valores correspondem aos itens informados no encerramento da manutenção.', { align: 'center' });
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
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#172033"><div style="max-width:680px;margin:0 auto;padding:24px"><div style="background:#0f766e;color:white;border-radius:14px 14px 0 0;padding:22px 26px"><div style="font-size:13px;opacity:.85">AquaGuard</div><h1 style="font-size:22px;margin:5px 0 0">Manutenção realizada</h1></div><div style="background:white;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 14px 14px;padding:26px"><p style="margin-top:0">A manutenção da piscina foi concluída com sucesso.</p><table style="width:100%;border-collapse:collapse;margin:18px 0"><tr><td style="padding:9px;background:#f8fafc"><strong>Local</strong><br>${escapeHtml(data.location_name)}</td><td style="padding:9px;background:#f8fafc"><strong>Piscina</strong><br>${escapeHtml(data.pool_name)}</td></tr><tr><td style="padding:9px"><strong>Executante</strong><br>${escapeHtml(data.executor)}</td><td style="padding:9px"><strong>Período</strong><br>${escapeHtml(dt(data.started_at))} a ${escapeHtml(dt(data.ended_at))}</td></tr></table><h2 style="font-size:17px;color:#0f766e">Medições químicas</h2><table style="width:100%;border-collapse:collapse;text-align:center"><tr><td style="padding:10px;border:1px solid #e5e7eb"><strong>pH</strong><br>${escapeHtml(data.ph ?? '-')}</td><td style="padding:10px;border:1px solid #e5e7eb"><strong>Cloro livre</strong><br>${escapeHtml(data.chlorine ?? '-')} ppm</td><td style="padding:10px;border:1px solid #e5e7eb"><strong>Alcalinidade</strong><br>${escapeHtml(data.alkalinity ?? '-')} ppm</td><td style="padding:10px;border:1px solid #e5e7eb"><strong>Estabilizador</strong><br>${escapeHtml(data.stabilizer ?? '-')} ppm</td></tr></table><h2 style="font-size:17px;color:#0f766e;margin-top:24px">Serviços executados</h2><ul style="padding-left:20px">${services}</ul>${data.problems_found ? `<h2 style="font-size:17px;color:#991b1b;margin-top:24px">Problemas encontrados</h2><p>${escapeHtml(data.problems_found)}</p>` : ''}${data.notes ? `<h2 style="font-size:17px;color:#0f766e;margin-top:24px">Observações</h2><p>${escapeHtml(data.notes)}</p>` : ''}<p style="font-size:12px;color:#64748b;margin:28px 0 0">Mensagem enviada automaticamente pelo AquaGuard.</p></div></div></body></html>`;
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
  const authenticatedUser = await userWithLocations(user.id);
  signIn(res, authenticatedUser);
  res.json({ user: publicUser(authenticatedUser) });
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
  signIn(res, await userWithLocations(result.rows[0].id));
  res.redirect('/dashboard');
}));

app.use('/api', requireAuth);

app.get('/api/users', requireAdmin, asyncRoute(async (_req, res) => {
  const result = await pool.query(
    `SELECT u.id,u.name,u.email,u.role,u.is_active,u.created_at,u.updated_at,
            COALESCE(array_agg(l.id ORDER BY l.name) FILTER (WHERE l.id IS NOT NULL),'{}'::uuid[]) AS location_ids,
            COALESCE(json_agg(json_build_object('id',l.id,'name',l.name) ORDER BY l.name)
              FILTER (WHERE l.id IS NOT NULL),'[]'::json) AS locations
     FROM users u
     LEFT JOIN user_locations ul ON ul.user_id=u.id
     LEFT JOIN locations l ON l.id=ul.location_id
     GROUP BY u.id
     ORDER BY u.name,u.email`
  );
  res.json(result.rows);
}));

app.post('/api/users', requireAdmin, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = [ROLE_ADMIN, ROLE_LOCAL_ADMIN, ROLE_USER].includes(req.body.role) ? req.body.role : ROLE_USER;
  const locationIds = role === ROLE_ADMIN ? [] : normalizeLocationIds(req.body.location_ids || req.body.location_id);
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Informe um nome e um e-mail válidos.' });
  if (role !== ROLE_ADMIN && !locationIds.length) return res.status(400).json({ error: 'Selecione pelo menos um local para o usuário.' });
  if (!(await ensureLocationsExist(locationIds))) return res.status(400).json({ error: 'Um dos locais selecionados não existe.' });
  if (password.length < 8) return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO users(name,email,password_hash,role,is_active,location_id)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [name, email, hash, role, req.body.is_active !== false, locationIds[0] || null]
    );
    for (const locationId of locationIds) {
      await client.query(`INSERT INTO user_locations(user_id,location_id) VALUES($1,$2)`, [result.rows[0].id, locationId]);
    }
    await client.query('COMMIT');
    res.status(201).json(await userRecord(result.rows[0].id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.put('/api/users/:id', requireAdmin, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = [ROLE_ADMIN, ROLE_LOCAL_ADMIN, ROLE_USER].includes(req.body.role) ? req.body.role : ROLE_USER;
  const locationIds = role === ROLE_ADMIN ? [] : normalizeLocationIds(req.body.location_ids || req.body.location_id);
  const isSelf = req.params.id === req.user.id;
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Informe um nome e um e-mail válidos.' });
  if (role !== ROLE_ADMIN && !locationIds.length) return res.status(400).json({ error: 'Selecione pelo menos um local para o usuário.' });
  if (!(await ensureLocationsExist(locationIds))) return res.status(400).json({ error: 'Um dos locais selecionados não existe.' });
  if (password && password.length < 8) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 8 caracteres.' });
  if (isSelf && (role !== ROLE_ADMIN || req.body.is_active === false)) return res.status(400).json({ error: 'Você não pode remover seu próprio acesso de administrador geral.' });
  const hash = password ? await bcrypt.hash(password, 12) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE users
       SET name=$1,email=$2,role=$3,is_active=$4,location_id=$5,
           password_hash=CASE WHEN $6::text IS NULL THEN password_hash ELSE $6 END,
           updated_at=now()
       WHERE id=$7
       RETURNING id`,
      [name, email, role, req.body.is_active !== false, locationIds[0] || null, hash, req.params.id]
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    await client.query(`DELETE FROM user_locations WHERE user_id=$1`, [req.params.id]);
    for (const locationId of locationIds) {
      await client.query(`INSERT INTO user_locations(user_id,location_id) VALUES($1,$2)`, [req.params.id, locationId]);
    }
    await client.query('COMMIT');
    res.json(await userRecord(req.params.id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/payment-plans', requireLocalManager, asyncRoute(async (req, res) => {
  const result = isGlobalAdmin(req.user)
    ? await pool.query(
      `SELECT pp.*,u.name AS created_by_name,count(l.id)::int AS locations_count
       FROM payment_plans pp JOIN users u ON u.id=pp.created_by
       LEFT JOIN locations l ON l.payment_plan_id=pp.id
       GROUP BY pp.id,u.name ORDER BY pp.name`
    )
    : await pool.query(
      `SELECT pp.*,u.name AS created_by_name,count(DISTINCT l.id)::int AS locations_count
       FROM payment_plans pp JOIN users u ON u.id=pp.created_by
       LEFT JOIN locations l ON l.payment_plan_id=pp.id AND l.id=ANY($2::uuid[])
       WHERE pp.created_by=$1
       GROUP BY pp.id,u.name ORDER BY pp.name`, [req.user.id, req.user.location_ids || []]
    );
  res.json(result.rows);
}));

app.post('/api/payment-plans', requireLocalManager, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const planType = String(req.body.plan_type || '').trim();
  const includedServices = String(req.body.included_services || '').trim();
  if (!name || !planType || !includedServices) return res.status(400).json({ error: 'Informe o nome, o tipo e o que o plano contempla.' });
  const result = await pool.query(
    `INSERT INTO payment_plans(name,plan_type,included_services,created_by,is_active) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [name, planType, includedServices, req.user.id, req.body.is_active !== false]
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/payment-plans/:id', requireLocalManager, asyncRoute(async (req, res) => {
  const existing = (await pool.query(`SELECT * FROM payment_plans WHERE id=$1`, [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Plano de pagamento não encontrado.' });
  if (!isGlobalAdmin(req.user) && String(existing.created_by) !== String(req.user.id)) return res.status(403).json({ error: 'Somente o criador do plano ou o administrador geral pode alterá-lo.' });
  const name = String(req.body.name || '').trim();
  const planType = String(req.body.plan_type || '').trim();
  const includedServices = String(req.body.included_services || '').trim();
  if (!name || !planType || !includedServices) return res.status(400).json({ error: 'Informe o nome, o tipo e o que o plano contempla.' });
  const result = await pool.query(
    `UPDATE payment_plans SET name=$1,plan_type=$2,included_services=$3,is_active=$4,updated_at=now() WHERE id=$5 RETURNING *`,
    [name, planType, includedServices, req.body.is_active !== false, existing.id]
  );
  res.json(result.rows[0]);
}));

app.delete('/api/payment-plans/:id', requireLocalManager, asyncRoute(async (req, res) => {
  const existing = (await pool.query(`SELECT * FROM payment_plans WHERE id=$1`, [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Plano de pagamento não encontrado.' });
  if (!isGlobalAdmin(req.user) && String(existing.created_by) !== String(req.user.id)) return res.status(403).json({ error: 'Somente o criador do plano ou o administrador geral pode desativá-lo.' });
  await pool.query(`UPDATE payment_plans SET is_active=false,updated_at=now() WHERE id=$1`, [existing.id]);
  res.json({ ok: true });
}));

app.get('/api/locations', asyncRoute(async (_req, res) => {
  let result;
  if (canManageLocalData(_req.user)) {
    const where = isGlobalAdmin(_req.user) ? '' : `WHERE l.id=ANY($1::uuid[])`;
    const params = isGlobalAdmin(_req.user) ? [] : [_req.user.location_ids || []];
    result = await pool.query(
      `SELECT l.*,pp.name AS payment_plan_name,pp.plan_type AS payment_plan_type,pp.included_services AS payment_plan_services
       FROM locations l LEFT JOIN payment_plans pp ON pp.id=l.payment_plan_id
       ${where} ORDER BY l.name`, params
    );
  } else {
    result = await pool.query(`SELECT id,name,address,is_active FROM locations WHERE id=ANY($1::uuid[]) ORDER BY name`, [_req.user.location_ids || []]);
  }
  res.json(result.rows);
}));

app.post('/api/locations', requireLocalManager, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Informe o nome do local.' });
  const documentInput = String(req.body.document_number || '').trim();
  const documentNumber = formatDocumentNumber(documentInput);
  if (documentInput && !documentNumber) return res.status(400).json({ error: 'Informe um CPF com 11 dígitos ou CNPJ com 14 dígitos.' });
  const contract = locationContract(req.body);
  if (!(await canUsePaymentPlan(req, contract.paymentPlanId))) return res.status(403).json({ error: 'Plano de pagamento não disponível para este usuário.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO locations(name,address,document_number,payment_plan_id,contract_value,payment_method,payment_type,payment_due_day,monthly_amount,installment_count,installment_amount,report_emails,notification_contacts,is_active)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING *`,
      [name, String(req.body.address || '').trim() || null, documentNumber, contract.paymentPlanId, contract.contractValue, contract.paymentMethod, contract.paymentType, contract.paymentDueDay, contract.monthlyAmount, contract.installmentCount, contract.installmentAmount, emailList(req.body.report_emails), JSON.stringify(notificationContacts(req.body.notification_contacts)), req.body.is_active !== false]
    );
    if (req.user.role === ROLE_LOCAL_ADMIN) {
      await client.query(`INSERT INTO user_locations(user_id,location_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [req.user.id, result.rows[0].id]);
    }
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.put('/api/locations/:id', requireLocalManager, asyncRoute(async (req, res) => {
  if (!canAccessLocation(req, req.params.id)) return res.status(403).json({ error: 'Local não disponível para este usuário.' });
  const documentInput = String(req.body.document_number || '').trim();
  const documentNumber = formatDocumentNumber(documentInput);
  if (documentInput && !documentNumber) return res.status(400).json({ error: 'Informe um CPF com 11 dígitos ou CNPJ com 14 dígitos.' });
  const contract = locationContract(req.body);
  if (!(await canUsePaymentPlan(req, contract.paymentPlanId))) return res.status(403).json({ error: 'Plano de pagamento não disponível para este usuário.' });
  const result = await pool.query(
    `UPDATE locations SET name=$1,address=$2,document_number=$3,payment_plan_id=$4,contract_value=$5,payment_method=$6,payment_type=$7,payment_due_day=$8,monthly_amount=$9,installment_count=$10,installment_amount=$11,report_emails=$12,notification_contacts=$13::jsonb,is_active=$14,updated_at=now() WHERE id=$15 RETURNING *`,
    [String(req.body.name || '').trim(), String(req.body.address || '').trim() || null, documentNumber, contract.paymentPlanId, contract.contractValue, contract.paymentMethod, contract.paymentType, contract.paymentDueDay, contract.monthlyAmount, contract.installmentCount, contract.installmentAmount, emailList(req.body.report_emails), JSON.stringify(notificationContacts(req.body.notification_contacts)), req.body.is_active !== false, req.params.id]
  );
  res.json(result.rows[0]);
}));

app.delete('/api/locations/:id', requireLocalManager, asyncRoute(async (req, res) => {
  if (!canAccessLocation(req, req.params.id)) return res.status(403).json({ error: 'Local não disponível para este usuário.' });
  await pool.query(`UPDATE locations SET is_active=false,updated_at=now() WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/itinerary-users', asyncRoute(async (req, res) => {
  const params = [];
  const conditions = ['u.is_active=true'];
  if (req.user.role === ROLE_USER) {
    params.push(req.user.id);
    conditions.push(`u.id=$${params.length}`);
  } else if (req.user.role === ROLE_LOCAL_ADMIN) {
    params.push(req.user.id, req.user.location_ids || []);
    conditions.push(`(u.id=$1 OR (u.role<>'ADMIN' AND EXISTS(
      SELECT 1 FROM user_locations shared_ul
      WHERE shared_ul.user_id=u.id AND shared_ul.location_id=ANY($2::uuid[])
    )))`);
  }
  const result = await pool.query(
    `SELECT u.id,u.name,u.email,u.role,
            COALESCE(array_agg(ul.location_id ORDER BY ul.created_at)
              FILTER (WHERE ul.location_id IS NOT NULL),'{}'::uuid[]) AS location_ids
     FROM users u
     LEFT JOIN user_locations ul ON ul.user_id=u.id
     WHERE ${conditions.join(' AND ')}
     GROUP BY u.id
     ORDER BY CASE WHEN u.id=$${params.push(req.user.id)} THEN 0 ELSE 1 END,u.name`,
    params
  );
  res.json(result.rows);
}));

app.get('/api/itineraries', asyncRoute(async (req, res) => {
  const serviceDate = String(req.query.service_date || '').trim();
  const dateFrom = String(req.query.date_from || '').trim();
  const onlyOpen = String(req.query.only_open || '').toLowerCase() === 'true';
  if (serviceDate && !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return res.status(400).json({ error: 'Data do itinerário inválida.' });
  if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) return res.status(400).json({ error: 'Data inicial do itinerário inválida.' });
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 200);
  const params = [];
  const conditions = [];
  const scope = itineraryScope(req, 'i', params);
  if (scope) conditions.push(scope);
  if (serviceDate) { params.push(serviceDate); conditions.push(`i.service_date=$${params.length}::date`); }
  if (dateFrom) { params.push(dateFrom); conditions.push(`i.service_date>=$${params.length}::date`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const having = onlyOpen ? `HAVING count(s.id) FILTER (WHERE s.status='PENDING') > 0` : '';
  params.push(limit);
  const result = await pool.query(
    `SELECT i.*,responsible.name AS responsible_name,creator.name AS created_by_name,
            count(s.id)::int AS total_stops,
            count(s.id) FILTER (WHERE s.status<>'PENDING')::int AS visited_stops,
            count(s.id) FILTER (WHERE s.status='VISITED_SERVICE')::int AS serviced_stops,
            count(s.id) FILTER (WHERE s.status='VISITED_NO_SERVICE')::int AS no_service_stops
     FROM itineraries i
     JOIN users responsible ON responsible.id=i.responsible_user_id
     JOIN users creator ON creator.id=i.created_by
     LEFT JOIN itinerary_stops s ON s.itinerary_id=i.id
     ${where}
     GROUP BY i.id,responsible.name,creator.name
     ${having}
     ORDER BY i.service_date ${dateFrom?'ASC':'DESC'},i.created_at DESC
     LIMIT $${params.length}`, params
  );
  res.json(result.rows.map(row => ({
    ...row,
    can_edit: canManageLocalData(req.user) || String(row.created_by) === String(req.user.id)
  })));
}));

app.get('/api/reports/itineraries', asyncRoute(async (req, res) => {
  const dateFrom = String(req.query.date_from || '').trim();
  const dateTo = String(req.query.date_to || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return res.status(400).json({ error: 'Informe o período inicial e final do relatório.' });
  }
  if (dateFrom > dateTo) return res.status(400).json({ error: 'A data inicial não pode ser maior que a data final.' });
  const params = [dateFrom, dateTo];
  const conditions = [`i.service_date BETWEEN $1::date AND $2::date`];
  const scope = itineraryScope(req, 'i', params);
  if (scope) conditions.push(scope);
  const rows = (await pool.query(
    `SELECT i.id AS itinerary_id,i.title,i.service_date,u.name AS responsible_name,
            s.id AS stop_id,s.position,s.status,s.visit_notes,s.visited_at,
            l.id AS location_id,l.name AS location_name,l.address,
            m.id AS maintenance_id,m.started_at,m.ended_at,p.name AS pool_name
     FROM itineraries i
     JOIN users u ON u.id=i.responsible_user_id
     JOIN itinerary_stops s ON s.itinerary_id=i.id
     JOIN locations l ON l.id=s.location_id
     LEFT JOIN maintenances m ON m.id=s.maintenance_id
     LEFT JOIN pools p ON p.id=m.pool_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY i.service_date,i.created_at,s.position`, params
  )).rows;
  res.json({
    summary: {
      total: rows.length,
      services: rows.filter(row => row.status === 'VISITED_SERVICE').length,
      no_service: rows.filter(row => row.status === 'VISITED_NO_SERVICE').length,
      pending: rows.filter(row => row.status === 'PENDING').length
    },
    rows
  });
}));

app.get('/api/itineraries/:id', asyncRoute(async (req, res) => {
  const itinerary = (await pool.query(
    `SELECT i.*,responsible.name AS responsible_name,creator.name AS created_by_name
     FROM itineraries i
     JOIN users responsible ON responsible.id=i.responsible_user_id
     JOIN users creator ON creator.id=i.created_by
     WHERE i.id=$1`,
    [req.params.id]
  )).rows[0];
  if (!itinerary) return res.status(404).json({ error: 'Itinerário não encontrado.' });
  if (!(await canAccessItinerary(req, itinerary.id))) return res.status(403).json({ error: 'Itinerário não disponível para este usuário.' });
  const stops = (await pool.query(
    `SELECT s.*,l.name AS location_name,l.address,l.document_number,
            m.pool_id,p.name AS pool_name,m.started_at,m.ended_at
     FROM itinerary_stops s
     JOIN locations l ON l.id=s.location_id
     LEFT JOIN maintenances m ON m.id=s.maintenance_id
     LEFT JOIN pools p ON p.id=m.pool_id
     WHERE s.itinerary_id=$1
     ORDER BY s.position`, [itinerary.id]
  )).rows;
  res.json({ ...itinerary, stops });
}));

app.post('/api/itineraries', asyncRoute(async (req, res) => {
  const title = String(req.body.title || '').trim();
  const serviceDate = String(req.body.service_date || '').trim();
  const locationIds = normalizeLocationIds(req.body.location_ids);
  if (!title) return res.status(400).json({ error: 'Informe o nome do itinerário.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return res.status(400).json({ error: 'Informe a data do itinerário.' });
  if (!locationIds.length) return res.status(400).json({ error: 'Selecione pelo menos um local.' });
  if (!(await ensureLocationsExist(locationIds))) return res.status(400).json({ error: 'Um ou mais locais não existem.' });
  const responsible = await itineraryResponsible(req, req.body.responsible_user_id, locationIds);
  const withoutAddress = (await pool.query(`SELECT name FROM locations WHERE id=ANY($1::uuid[]) AND NULLIF(btrim(address),'') IS NULL`, [locationIds])).rows;
  if (withoutAddress.length) return res.status(400).json({ error: `Cadastre o endereço antes de incluir no itinerário: ${withoutAddress.map(row => row.name).join(', ')}.` });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itinerary = (await client.query(
      `INSERT INTO itineraries(title,service_date,created_by,responsible_user_id) VALUES($1,$2,$3,$4) RETURNING *`,
      [title, serviceDate, req.user.id, responsible.id]
    )).rows[0];
    for (let index = 0; index < locationIds.length; index += 1) {
      await client.query(`INSERT INTO itinerary_stops(itinerary_id,location_id,position) VALUES($1,$2,$3)`, [itinerary.id, locationIds[index], index + 1]);
    }
    await client.query('COMMIT');
    res.status(201).json(itinerary);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.put('/api/itineraries/:id', asyncRoute(async (req, res) => {
  const existing = (await pool.query(`SELECT * FROM itineraries WHERE id=$1`, [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Itinerário não encontrado.' });
  if (!(await canAccessItinerary(req, existing.id))) return res.status(403).json({ error: 'Itinerário não disponível para este usuário.' });
  if (req.user.role === ROLE_USER && String(existing.created_by) !== String(req.user.id)) return res.status(403).json({ error: 'Você pode alterar somente itinerários criados por você.' });
  const locked = (await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM itinerary_stops s
       WHERE s.itinerary_id=$1
         AND (s.status<>'PENDING' OR EXISTS(SELECT 1 FROM maintenances m WHERE m.itinerary_stop_id=s.id))
     ) AS locked`, [existing.id]
  )).rows[0].locked;
  if (locked) return res.status(409).json({ error: 'Um itinerário que já possui visitas ou serviços iniciados não pode ser alterado.' });
  const title = String(req.body.title || '').trim();
  const serviceDate = String(req.body.service_date || '').trim();
  const locationIds = normalizeLocationIds(req.body.location_ids);
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) || !locationIds.length) return res.status(400).json({ error: 'Informe o nome, a data e pelo menos um local.' });
  if (!(await ensureLocationsExist(locationIds))) return res.status(400).json({ error: 'Um ou mais locais não existem.' });
  const responsible = await itineraryResponsible(req, req.body.responsible_user_id || existing.responsible_user_id, locationIds);
  const withoutAddress = (await pool.query(`SELECT name FROM locations WHERE id=ANY($1::uuid[]) AND NULLIF(btrim(address),'') IS NULL`, [locationIds])).rows;
  if (withoutAddress.length) return res.status(400).json({ error: `Cadastre o endereço antes de incluir no itinerário: ${withoutAddress.map(row => row.name).join(', ')}.` });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE itineraries SET title=$1,service_date=$2,responsible_user_id=$3,updated_at=now() WHERE id=$4`, [title, serviceDate, responsible.id, existing.id]);
    await client.query(`DELETE FROM itinerary_stops WHERE itinerary_id=$1`, [existing.id]);
    for (let index = 0; index < locationIds.length; index += 1) {
      await client.query(`INSERT INTO itinerary_stops(itinerary_id,location_id,position) VALUES($1,$2,$3)`, [existing.id, locationIds[index], index + 1]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.delete('/api/itineraries/:id', asyncRoute(async (req, res) => {
  const existing = (await pool.query(`SELECT * FROM itineraries WHERE id=$1`, [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Itinerário não encontrado.' });
  if (!(await canAccessItinerary(req, existing.id))) return res.status(403).json({ error: 'Itinerário não disponível para este usuário.' });
  if (req.user.role === ROLE_USER && String(existing.created_by) !== String(req.user.id)) return res.status(403).json({ error: 'Você pode excluir somente itinerários criados por você.' });
  const locked = (await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM itinerary_stops s
       WHERE s.itinerary_id=$1
         AND (s.status<>'PENDING' OR EXISTS(SELECT 1 FROM maintenances m WHERE m.itinerary_stop_id=s.id))
     ) AS locked`, [existing.id]
  )).rows[0].locked;
  if (locked) return res.status(409).json({ error: 'Um itinerário que já possui visitas ou serviços iniciados não pode ser excluído.' });
  await pool.query(`DELETE FROM itineraries WHERE id=$1`, [existing.id]);
  res.json({ ok: true });
}));

app.post('/api/itineraries/:id/stops/:stopId/no-service', asyncRoute(async (req, res) => {
  const notes = String(req.body.notes || '').trim();
  if (!notes) return res.status(400).json({ error: 'Informe por que o serviço não foi realizado.' });
  const stop = (await pool.query(
    `SELECT s.*,i.id AS route_id FROM itinerary_stops s JOIN itineraries i ON i.id=s.itinerary_id WHERE s.id=$1 AND i.id=$2`,
    [req.params.stopId, req.params.id]
  )).rows[0];
  if (!stop) return res.status(404).json({ error: 'Parada não encontrada.' });
  if (!(await canAccessItinerary(req, stop.route_id)) || !canAccessLocation(req, stop.location_id)) return res.status(403).json({ error: 'Parada não disponível para este usuário.' });
  const startedService = (await pool.query(`SELECT 1 FROM maintenances WHERE itinerary_stop_id=$1 AND status='STARTED' LIMIT 1`, [stop.id])).rows[0];
  if (startedService) return res.status(409).json({ error: 'Existe um serviço em andamento nesta parada. Finalize o serviço para concluir a visita.' });
  const result = await pool.query(
    `UPDATE itinerary_stops SET status='VISITED_NO_SERVICE',visit_notes=$1,visited_at=now(),visited_by=$2
     WHERE id=$3 AND status='PENDING' RETURNING *`, [notes, req.user.id, stop.id]
  );
  if (!result.rows[0]) return res.status(409).json({ error: 'Esta parada já foi concluída.' });
  res.json(result.rows[0]);
}));

app.get('/api/pools', asyncRoute(async (req, res) => {
  const args = [];
  const scope = locationScope(req, req.query.location_id, 'p.location_id', args);
  const where = scope ? `WHERE ${scope}` : '';
  const result = await pool.query(
    `SELECT p.*,l.name AS location_name FROM pools p JOIN locations l ON l.id=p.location_id ${where} ORDER BY p.name`, args
  );
  res.json(result.rows);
}));

app.post('/api/pools', requireLocalManager, asyncRoute(async (req, res) => {
  if (!validUuid(req.body.location_id)) return res.status(400).json({ error: 'Selecione um local válido.' });
  if (!canAccessLocation(req, req.body.location_id)) return res.status(403).json({ error: 'Local não disponível para este usuário.' });
  const result = await pool.query(
    `INSERT INTO pools(location_id,name,pool_location,volume_liters,is_active) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [req.body.location_id, String(req.body.name || '').trim(), String(req.body.pool_location || '').trim() || null, req.body.volume_liters || null, req.body.is_active !== false]
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/pools/:id', requireLocalManager, asyncRoute(async (req, res) => {
  if (!validUuid(req.body.location_id)) return res.status(400).json({ error: 'Selecione um local válido.' });
  const existing = (await pool.query(`SELECT location_id FROM pools WHERE id=$1`, [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Piscina não encontrada.' });
  if (!canAccessLocation(req, existing.location_id) || !canAccessLocation(req, req.body.location_id)) {
    return res.status(403).json({ error: 'Piscina ou local não disponível para este usuário.' });
  }
  const result = await pool.query(
    `UPDATE pools SET location_id=$1,name=$2,pool_location=$3,volume_liters=$4,is_active=$5,updated_at=now() WHERE id=$6 RETURNING *`,
    [req.body.location_id, String(req.body.name || '').trim(), String(req.body.pool_location || '').trim() || null, req.body.volume_liters || null, req.body.is_active !== false, req.params.id]
  );
  res.json(result.rows[0]);
}));

app.delete('/api/pools/:id', requireLocalManager, asyncRoute(async (req, res) => {
  const existing = (await pool.query(`SELECT location_id FROM pools WHERE id=$1`, [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Piscina não encontrada.' });
  if (!canAccessLocation(req, existing.location_id)) return res.status(403).json({ error: 'Piscina não disponível para este usuário.' });
  await pool.query(`UPDATE pools SET is_active=false,updated_at=now() WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const poolId = validUuid(req.query.pool_id) ? req.query.pool_id : null;
  const params = [];
  const conditions = [`m.status='COMPLETED'`];
  const scope = locationScope(req, req.query.location_id, 'p.location_id', params);
  if (scope) conditions.push(scope);
  if (poolId) { params.push(poolId); conditions.push(`m.pool_id=$${params.length}`); }
  const where = conditions.join(' AND ');
  const poolParams = [];
  const poolScope = locationScope(req, req.query.location_id, 'p.location_id', poolParams);
  const activePoolsWhere = [`p.is_active=true`, ...(poolScope ? [poolScope] : [])].join(' AND ');
  const [activePools, today, total, history, problems, trends] = await Promise.all([
    pool.query(`SELECT count(*)::int AS count FROM pools p WHERE ${activePoolsWhere}`, poolParams),
    pool.query(`SELECT count(*)::int AS count FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE ${where} AND (m.started_at AT TIME ZONE 'America/Sao_Paulo')::date=(now() AT TIME ZONE 'America/Sao_Paulo')::date`, params),
    pool.query(`SELECT count(*)::int AS count FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE ${where}`, params),
    pool.query(`SELECT m.id,m.executor,m.started_at,m.ended_at,m.ph,m.chlorine,m.alkalinity,m.stabilizer,m.services,m.problems_found,m.notes,p.name AS pool_name,l.name AS location_name FROM maintenances m JOIN pools p ON p.id=m.pool_id JOIN locations l ON l.id=p.location_id WHERE ${where} ORDER BY m.started_at DESC LIMIT 100`, params),
    pool.query(`SELECT m.id,m.executor,m.started_at,m.ended_at,m.problems_found,p.name AS pool_name,l.name AS location_name FROM maintenances m JOIN pools p ON p.id=m.pool_id JOIN locations l ON l.id=p.location_id WHERE ${where} AND NULLIF(btrim(m.problems_found),'') IS NOT NULL ORDER BY m.started_at DESC LIMIT 100`, params),
    pool.query(`SELECT m.id,m.started_at,m.ph,m.chlorine,m.alkalinity,m.stabilizer,p.name AS pool_name FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE ${where} ORDER BY m.started_at ASC LIMIT 100`, params)
  ]);
  res.json({ stats: { activePools: activePools.rows[0].count, today: today.rows[0].count, total: total.rows[0].count }, history: history.rows, problems: problems.rows, trends: trends.rows });
}));

app.get('/api/reports/maintenances', asyncRoute(async (req, res) => {
  const poolId = req.query.pool_id ? String(req.query.pool_id) : null;
  const dateFrom = req.query.date_from ? String(req.query.date_from) : null;
  const dateTo = req.query.date_to ? String(req.query.date_to) : null;
  if (poolId && !validUuid(poolId)) return res.status(400).json({ error: 'Piscina inválida.' });
  if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) return res.status(400).json({ error: 'Data inicial inválida.' });
  if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) return res.status(400).json({ error: 'Data final inválida.' });
  if (dateFrom && dateTo && dateFrom > dateTo) return res.status(400).json({ error: 'A data inicial não pode ser maior que a data final.' });
  const params = [];
  const conditions = [`m.status='COMPLETED'`];
  const scope = locationScope(req, req.query.location_id, 'p.location_id', params);
  if (scope) conditions.push(scope);
  if (poolId) { params.push(poolId); conditions.push(`m.pool_id=$${params.length}`); }
  if (dateFrom) { params.push(dateFrom); conditions.push(`(m.started_at AT TIME ZONE 'America/Sao_Paulo')::date >= $${params.length}::date`); }
  if (dateTo) { params.push(dateTo); conditions.push(`(m.started_at AT TIME ZONE 'America/Sao_Paulo')::date <= $${params.length}::date`); }
  const rows = (await pool.query(
    `SELECT m.id,m.executor,m.started_at,m.ended_at,m.ph,m.chlorine,m.alkalinity,m.stabilizer,m.services,m.problems_found,m.notes,
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
      services: rows.length
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
  const itineraryStopId = validUuid(req.body.itinerary_stop_id) ? String(req.body.itinerary_stop_id) : null;
  if (itineraryStopId) {
    const stop = (await pool.query(
      `SELECT s.location_id,s.status,i.id AS route_id FROM itinerary_stops s JOIN itineraries i ON i.id=s.itinerary_id WHERE s.id=$1`,
      [itineraryStopId]
    )).rows[0];
    if (!stop || stop.status !== 'PENDING' || String(stop.location_id) !== String(selectedPool.location_id) || !(await canAccessItinerary(req, stop.route_id))) {
      return res.status(400).json({ error: 'A parada do itinerário não está disponível para esta piscina.' });
    }
  }
  const active = (await pool.query(`SELECT m.id,p.name AS pool_name FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE m.status='STARTED' AND m.created_by=$1 ORDER BY m.started_at DESC LIMIT 1`, [req.user.id])).rows[0];
  if (active) return res.status(409).json({ error: `Você já possui um serviço em andamento na ${active.pool_name}. Finalize-o antes de iniciar outro.` });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`INSERT INTO maintenances(pool_id,executor,status,created_by,itinerary_stop_id) VALUES($1,$2,'STARTED',$3,$4) RETURNING *`, [req.body.pool_id, String(req.body.executor).trim(), req.user.id, itineraryStopId]);
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
  const problemsFound = String(req.body.problems_found || '').trim();
  const generateQuote = String(req.body.generate_quote || '').toLowerCase() === 'true';
  const quoteItems = generateQuote ? parseQuoteItems(req.body.quote_items) : [];
  if (generateQuote && !problemsFound) return res.status(400).json({ error: 'Informe os problemas encontrados antes de gerar o orçamento.' });
  if (generateQuote && (!quoteItems.length || quoteItems.some(item => !item.description || !Number.isFinite(item.value) || item.value <= 0))) {
    return res.status(400).json({ error: 'Informe a descrição e um valor maior que zero para cada item do orçamento.' });
  }
  const quoteTotal = generateQuote ? quoteItems.reduce((total, item) => total + Math.round(item.value * 100), 0) / 100 : null;
  const target = (await pool.query(`SELECT p.location_id,m.created_by,m.itinerary_stop_id FROM maintenances m JOIN pools p ON p.id=m.pool_id WHERE m.id=$1`, [req.params.id])).rows[0];
  if (!target || !canAccessLocation(req, target.location_id) || (!canManageLocalData(req.user) && target.created_by !== req.user.id)) return res.status(403).json({ error: 'Manutenção não disponível para este usuário.' });
  const client = await pool.connect();
  let completedMaintenance;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE maintenances SET status='COMPLETED',ended_at=now(),ph=$1,chlorine=$2,alkalinity=$3,stabilizer=$4,services=$5,problems_found=$6,notes=$7,quote_items=$8::jsonb,quote_total=$9,quote_created_at=CASE WHEN $9::numeric IS NULL THEN NULL ELSE now() END,updated_at=now() WHERE id=$10 AND status='STARTED' RETURNING *`,
      [req.body.ph, req.body.chlorine, req.body.alkalinity, req.body.stabilizer, services, problemsFound || null, String(req.body.notes || '').trim() || null, JSON.stringify(quoteItems), quoteTotal, req.params.id]
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este serviço já foi encerrado ou não existe.' });
    }
    completedMaintenance = result.rows[0];
    for (const file of req.files || []) await client.query(`INSERT INTO maintenance_photos(maintenance_id,phase,file_name,mime_type,file_data) VALUES($1,'END',$2,$3,$4)`, [req.params.id, file.originalname, file.mimetype, file.buffer]);
    let itineraryStopId = target.itinerary_stop_id;
    if (!itineraryStopId) {
      itineraryStopId = (await client.query(
        `SELECT s.id
         FROM itinerary_stops s
         JOIN itineraries i ON i.id=s.itinerary_id
         WHERE s.location_id=$1 AND s.status='PENDING' AND i.responsible_user_id=$2
           AND i.service_date=($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
         ORDER BY i.created_at,s.position
         LIMIT 1`, [target.location_id, target.created_by, completedMaintenance.started_at]
      )).rows[0]?.id || null;
      if (itineraryStopId) await client.query(`UPDATE maintenances SET itinerary_stop_id=$1 WHERE id=$2`, [itineraryStopId, completedMaintenance.id]);
    }
    if (itineraryStopId) {
      await client.query(
        `UPDATE itinerary_stops SET status='VISITED_SERVICE',maintenance_id=$1,visited_at=now(),visited_by=$2,visit_notes=NULL
         WHERE id=$3 AND status='PENDING'`, [completedMaintenance.id, req.user.id, itineraryStopId]
      );
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

  res.json({ ...completedMaintenance, quote_url: quoteTotal !== null ? `/api/maintenances/${completedMaintenance.id}/quote.pdf` : null });
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

app.get('/api/maintenances/:id/quote.pdf', asyncRoute(async (req, res) => {
  const data = await getMaintenance(req.params.id);
  if (!data) return res.sendStatus(404);
  if (!canAccessLocation(req, data.location_id)) return res.status(403).json({ error: 'Orçamento não disponível para este usuário.' });
  if (!Array.isArray(data.quote_items) || !data.quote_items.length || data.quote_total === null) {
    return res.status(404).json({ error: 'Esta manutenção não possui orçamento.' });
  }
  const pdf = await createQuotePdf(data);
  res.setHeader('Content-Disposition', `inline; filename="orcamento-${data.pool_name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.pdf"`);
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

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.get('/usuarios', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'usuarios.html'));
});
app.get(/^(?!\/api\/|\/auth\/|\/health$).*/, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Cada foto deve ter no máximo 6 MB.' });
  if (error.code === '23505') return res.status(409).json({ error: 'Já existe um usuário cadastrado com este e-mail.' });
  res.status(500).json({ error: 'Não foi possível concluir a operação.', detail: isProduction ? undefined : error.message });
});

initializeDatabase()
  .then(() => app.listen(PORT, () => console.log(`AquaGuard disponível na porta ${PORT}`)))
  .catch(error => { console.error('Falha na inicialização:', error); process.exit(1); });
