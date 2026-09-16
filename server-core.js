const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000
});

function parsePtDate(value) {
  const m = String(value || '').match(/(\d{2})\/(\d{2})\/(\d{4}) às (\d{2}):(\d{2})/);
  if (!m) return null;
  const [, day, month, year, hour, minute] = m;
  return `${year}-${month}-${day}T${hour}:${minute}:00-03:00`;
}

async function initializeDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || '');
  if (adminEmail && adminPassword) {
    const hash = await bcrypt.hash(adminPassword, 12);
    await pool.query(
      `INSERT INTO users(name,email,password_hash,role)
       VALUES($1,$2,$3,'ADMIN')
       ON CONFLICT ((lower(email))) DO UPDATE SET name=EXCLUDED.name, password_hash=EXCLUDED.password_hash, role='ADMIN', is_active=true, updated_at=now()`,
      [process.env.ADMIN_NAME || 'Administrador', adminEmail, hash]
    );
  }

  const locationResult = await pool.query(
    `INSERT INTO locations(name,address,report_emails,is_active)
     SELECT 'Vivere Palhano','Rua Ernani Lacerda de Athayde, 1200',ARRAY['leoferrareto2013@gmail.com','residencialviverepalhano@gmail.com','rodrigosillva5835@gmail.com'],true
     WHERE NOT EXISTS (SELECT 1 FROM locations)
     RETURNING id`
  );
  let locationId = locationResult.rows[0]?.id;
  if (!locationId) locationId = (await pool.query(`SELECT id FROM locations ORDER BY created_at LIMIT 1`)).rows[0]?.id;

  if (locationId) {
    await pool.query(
      `INSERT INTO pools(location_id,name,pool_location,volume_liters,is_active)
       SELECT $1,'Piscina Infantil','Área de Lazer',8000,true
       WHERE NOT EXISTS (SELECT 1 FROM pools WHERE location_id=$1 AND name='Piscina Infantil')`, [locationId]
    );
    await pool.query(
      `INSERT INTO pools(location_id,name,pool_location,volume_liters,is_active)
       SELECT $1,'Piscina Adulto','Área de Lazer',200000,true
       WHERE NOT EXISTS (SELECT 1 FROM pools WHERE location_id=$1 AND name='Piscina Adulto')`, [locationId]
    );
  }

  const historyCount = Number((await pool.query(`SELECT count(*)::int AS count FROM maintenances WHERE status='COMPLETED'`)).rows[0].count);
  if (historyCount === 0 && locationId) {
    const historyPath = path.join(__dirname, 'data', 'history.json');
    if (fs.existsSync(historyPath)) {
      const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      const pools = (await pool.query(`SELECT id,name FROM pools WHERE location_id=$1`, [locationId])).rows;
      for (const item of history) {
        const poolName = item.pool.replace(/\s+-\s+Vivere Palhano$/i, '');
        const targetPool = pools.find(p => p.name === poolName);
        if (!targetPool) continue;
        await pool.query(
          `INSERT INTO maintenances(pool_id,executor,status,started_at,ended_at,ph,chlorine,alkalinity,services,notes)
           VALUES($1,$2,'COMPLETED',$3,$4,$5,$6,$7,$8,$9)`,
          [targetPool.id, item.executor, parsePtDate(item.started), parsePtDate(item.ended), item.ph, item.chlorine, item.alkalinity, item.services, item.notes || null]
        );
      }
    }
  }
}

module.exports = { pool, initializeDatabase };
