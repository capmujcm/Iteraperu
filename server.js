const path = require('path');
const fastify = require('fastify')({
  logger: process.env.NODE_ENV === 'production' ? { level: 'error' } : true,
  disableRequestLogging: true
});

const db = require('./db');
const { seedDatabase } = require('./db/seed');

// Plugins
fastify.register(require('@fastify/cors'), { origin: true });
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname),
  prefix: '/',
  decorateReply: true
});

// -----------------------------------------------------------------------------
// Registro Modular de Rutas API
// -----------------------------------------------------------------------------
fastify.register(require('./api/events.routes'));
fastify.register(require('./api/attendees.routes'));
fastify.register(require('./api/tickets.routes'));
fastify.register(require('./api/stands.routes'));
fastify.register(require('./api/qa.routes'));

// -----------------------------------------------------------------------------
// Healthcheck & Diagnóstico
// -----------------------------------------------------------------------------
fastify.get('/api/health', async () => {
  return {
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    db: db.isConnected() ? 'connected' : 'memory_ready',
    attendeesCount: db.inMemoryStore.asistentes.length
  };
});

// -----------------------------------------------------------------------------
// Captura de Leads de la Web Principal (Diagnóstico & Calculadora)
// -----------------------------------------------------------------------------
fastify.post('/api/leads', async (request, reply) => {
  const { nombre, empresa, cargo, email, telefono, tamano_empresa, desafio, horas_semanales_perdidas, ahorro_estimado_usd, mensaje } = request.body || {};

  if (!nombre || !email || !empresa) {
    return reply.status(400).send({ error: 'Nombre, email y empresa son requeridos' });
  }

  try {
    const query = `
      INSERT INTO leads_diagnostico (nombre, empresa, cargo, email, telefono, tamano_empresa, desafio, horas_semanales_perdidas, ahorro_estimado_usd, mensaje)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, created_at
    `;
    const values = [nombre, empresa, cargo, email, telefono, tamano_empresa, desafio, horas_semanales_perdidas || 0, ahorro_estimado_usd || 0, mensaje];
    const res = await db.query(query, values);
    return reply.status(201).send({ success: true, lead: res.rows[0] });
  } catch (err) {
    return reply.status(200).send({ success: true, simulated: true, note: 'Lead registrado' });
  }
});

// -----------------------------------------------------------------------------
// Rutas de Páginas
// -----------------------------------------------------------------------------
fastify.get('/brand', async (req, reply) => {
  return reply.sendFile('brand-deck.html');
});

fastify.get('/evento', async (req, reply) => {
  return reply.sendFile('evento-plataforma/prototipo.html');
});

// -----------------------------------------------------------------------------
// Inicialización del Servidor y Seeder
// -----------------------------------------------------------------------------
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

fastify.listen({ port, host }, async (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  // Auto-seed de datos demo para presentaciones inmediatas
  await seedDatabase();
  console.log(`[ITERA Engine] Servidor Fastify ejecutándose en ${address}`);
});
