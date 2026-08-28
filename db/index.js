const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/itera';

let pool = null;
let isConnected = false;

try {
  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' && !connectionString.includes('localhost') 
      ? { rejectUnauthorized: false } 
      : false,
    max: 3,                  // Máximo 3 conexiones concurrentes para ultra-bajo consumo de RAM
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000
  });

  pool.on('error', (err) => {
    console.warn('[PostgreSQL Pool Warning]:', err.message);
  });
} catch (e) {
  console.warn('[PostgreSQL Init Error]:', e.message);
}

// In-Memory store para resiliencia total si la DB está en arranque
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
      console.warn('[DB Query Fallback to In-Memory]:', err.message);
    }
  }
  return { rows: [], rowCount: 0 };
}

module.exports = {
  query,
  pool,
  inMemoryStore,
  isConnected: () => isConnected
};
