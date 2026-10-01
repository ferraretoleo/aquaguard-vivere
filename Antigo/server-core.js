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

async function initializeDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const locationResult = await pool.query(
    `INSERT INTO locations(name,address,report_emails,is_active)
     SELECT 'Vivere Palhano','Rua Ernani Lacerda de Athayde, 1200',ARRAY['leoferrareto2013@gmail.com','residencialviverepalhano@gmail.com','rodrigosillva5835@gmail.com'],true
     WHERE NOT EXISTS (SELECT 1 FROM locations)
     RETURNING id`
  );
  let locationId = locationResult.rows[0]?.id;
  if (!locationId) locationId = (await pool.query(`SELECT id FROM locations ORDER BY created_at LIMIT 1`)).rows[0]?.id;

  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || '');
  if (adminEmail && adminPassword && locationId) {
    const hash = await bcrypt.hash(adminPassword, 12);
    await pool.query(
      `INSERT INTO users(name,email,password_hash,role,location_id)
       VALUES($1,$2,$3,'ADMIN',$4)
       ON CONFLICT ((lower(email))) DO UPDATE
       SET name=EXCLUDED.name, password_hash=EXCLUDED.password_hash, role='ADMIN',
           location_id=COALESCE(users.location_id,EXCLUDED.location_id),
           is_active=true, updated_at=now()`,
      [process.env.ADMIN_NAME || 'Administrador', adminEmail, hash, locationId]
    );
  }

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
    await pool.query(`ALTER TABLE users ALTER COLUMN location_id DROP NOT NULL`);
    await pool.query(
      `INSERT INTO user_locations(user_id,location_id)
       SELECT u.id,$1
       FROM users u
       WHERE u.role<>'ADMIN'
         AND NOT EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id=u.id)
       ON CONFLICT DO NOTHING`,
      [locationId]
    );
  }

}

module.exports = { pool, initializeDatabase };
