const { Pool } = require('pg');

// Configuración ultra-optimizada para bajo consumo de RAM y CPU
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/itera';

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 3,                 // Máximo 3 conexiones simultáneas (ahorra RAM)
  idleTimeoutMillis: 10000, // Cierra conexiones ociosas tras 10 segundos
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('[DB] Error inesperado en el cliente inactivo de PostgreSQL:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
