const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';

let pool = null;
let isConnected = false;

if (connectionString) {
  try {
    pool = new Pool({
      connectionString,
      ssl: !connectionString.includes('localhost') ? { rejectUnauthorized: false } : false,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000
    });

    pool.on('error', (err) => {
      console.warn('[PostgreSQL Pool]:', err.message);
    });
  } catch (e) {
    console.warn('[PostgreSQL Init]:', e.message);
  }
}

// In-Memory store garantizado
const inMemoryStore = {
  eventos: [
    {
      id: 'evt-itera-2026',
      slug: 'itera-summit-2026',
      nombre: 'ITERA Summit 2026 — Transformación & Procesos',
      descripcion: 'El evento anual de innovación operativa, automatización y evolución empresarial.',
      lugar: 'Centro de Convenciones de Lima / Transmisión Online',
      aforo_max: 500,
      activo: true
    }
  ],
  asistentes: [],
  checkins: [],
  stands: [],
  standsLeads: [],
  preguntas: []
};

async function query(text, params = []) {
  if (pool) {
    try {
      const res = await pool.query(text, params);
      isConnected = true;
      return res;
    } catch (err) {
      console.warn('[DB Query]:', err.message);
    }
  }
  return { rows: [], rowCount: 0 };
}

// Auto-creación de tablas si PostgreSQL está conectado
async function autoMigrate() {
  if (!pool) return;
  try {
    await query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE TABLE IF NOT EXISTS leads_diagnostico (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        nombre VARCHAR(120) NOT NULL,
        empresa VARCHAR(150) NOT NULL,
        cargo VARCHAR(100),
        email VARCHAR(150) NOT NULL,
        telefono VARCHAR(50),
        tamano_empresa VARCHAR(50),
        desafio VARCHAR(100),
        horas_semanales_perdidas INT DEFAULT 0,
        ahorro_estimado_usd NUMERIC(10,2) DEFAULT 0,
        mensaje TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS eventos (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        slug VARCHAR(80) UNIQUE NOT NULL,
        nombre VARCHAR(200) NOT NULL,
        descripcion TEXT,
        lugar VARCHAR(250),
        aforo_max INT DEFAULT 500,
        activo BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS asistentes_tickets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        evento_id UUID,
        codigo_ticket VARCHAR(30) UNIQUE NOT NULL,
        qr_token VARCHAR(64) UNIQUE NOT NULL,
        nombre VARCHAR(120) NOT NULL,
        apellido VARCHAR(120) NOT NULL,
        email VARCHAR(150) NOT NULL,
        empresa VARCHAR(150),
        cargo VARCHAR(100),
        tipo_ticket VARCHAR(50) DEFAULT 'general',
        estado VARCHAR(30) DEFAULT 'valido',
        checkin_count INT DEFAULT 0,
        ultimo_checkin TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB Auto-Migrate] Tablas de PostgreSQL creadas o verificadas exitosamente.');
  } catch (err) {
    console.warn('[DB Auto-Migrate]:', err.message);
  }
}

module.exports = {
  query,
  pool,
  inMemoryStore,
  autoMigrate,
  isConnected: () => isConnected
};
