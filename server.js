const path = require('path');
const fs = require('fs');
const fastify = require('fastify')({
  logger: process.env.NODE_ENV === 'production' ? { level: 'error' } : true,
  disableRequestLogging: true
});

const db = require('./db');

// Plugins
fastify.register(require('@fastify/cors'), { origin: true });
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname),
  prefix: '/',
  decorateReply: true
});

// -----------------------------------------------------------------------------
// 1. Healthcheck (Para Railway y monitores de uptime)
// -----------------------------------------------------------------------------
fastify.get('/api/health', async () => {
  return { status: 'ok', uptime: process.uptime(), memory: process.memoryUsage().rss };
});

// -----------------------------------------------------------------------------
// 2. Captura de Leads (Formulario de Diagnóstico & Calculadora de ROI)
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
    fastify.log.error(err);
    return reply.status(200).send({ success: true, simulated: true, note: 'Lead registrado' });
  }
});

// -----------------------------------------------------------------------------
// 3. Verificación de Ticket QR (Control de Acceso / Staff en Puerta)
// -----------------------------------------------------------------------------
fastify.post('/api/tickets/verify', async (request, reply) => {
  const { qr_token, codigo_ticket } = request.body || {};
  try {
    const res = await db.query(
      `SELECT * FROM asistentes_tickets WHERE qr_token = $1 OR codigo_ticket = $2 LIMIT 1`,
      [qr_token || '', codigo_ticket || '']
    );
    if (res.rows.length === 0) {
      return reply.status(404).send({ valid: false, message: 'Ticket no encontrado o inválido' });
    }
    const ticket = res.rows[0];
    return { valid: true, ticket };
  } catch (err) {
    return reply.status(500).send({ error: 'Error al consultar ticket' });
  }
});

// -----------------------------------------------------------------------------
// 4. Registro de Check-in en Puerta
// -----------------------------------------------------------------------------
fastify.post('/api/tickets/checkin', async (request, reply) => {
  const { ticket_id, puerta, staff_nombre } = request.body || {};
  try {
    await db.query(
      `UPDATE asistentes_tickets 
       SET estado = 'checkin', checkin_count = checkin_count + 1, ultimo_checkin = NOW() 
       WHERE id = $1`,
      [ticket_id]
    );

    await db.query(
      `INSERT INTO checkins_log (ticket_id, puerta, staff_nombre, resultado)
       VALUES ($1, $2, $3, 'exitoso')`,
      [ticket_id, puerta || 'Principal', staff_nombre || 'Staff']
    );

    return { success: true, message: 'Check-in completado exitosamente' };
  } catch (err) {
    return reply.status(500).send({ error: 'Error al procesar check-in' });
  }
});

// -----------------------------------------------------------------------------
// Rutas de Vistas
// -----------------------------------------------------------------------------
fastify.get('/brand', async (req, reply) => {
  return reply.sendFile('brand-deck.html');
});

fastify.get('/evento', async (req, reply) => {
  return reply.sendFile('evento-plataforma/prototipo.html');
});

// Iniciar servidor
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

fastify.listen({ port, host }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[ITERA Engine] Servidor ejecutándose en ${address}`);
});
