const db = require('../db');

async function ticketsRoutes(fastify, options) {
  // 1. Verificar Ticket (Consultar estado sin marcar ingreso todavía)
  fastify.post('/api/tickets/verify', async (req, reply) => {
    const { token, code, dni } = req.body || {};

    const attendee = db.inMemoryStore.asistentes.find(
      a => (token && a.qr_token === token) || 
           (code && a.codigo_ticket.toLowerCase() === code.toLowerCase()) ||
           (dni && a.dni === dni)
    );

    if (!attendee) {
      return reply.status(404).send({
        valid: false,
        message: 'Código de ticket no encontrado o inválido.'
      });
    }

    return {
      valid: true,
      attendee,
      alreadyCheckedIn: attendee.estado === 'checkin',
      lastCheckin: attendee.ultimo_checkin
    };
  });

  // 2. Ejecutar Check-in en Puerta
  fastify.post('/api/tickets/checkin', async (req, reply) => {
    const { token, code, dni, puerta, staff_nombre } = req.body || {};

    const attendee = db.inMemoryStore.asistentes.find(
      a => (token && a.qr_token === token) || 
           (code && a.codigo_ticket.toLowerCase() === code.toLowerCase()) ||
           (dni && a.dni === dni)
    );

    if (!attendee) {
      return reply.status(404).send({
        success: false,
        error: 'Ticket inválido o no registrado'
      });
    }

    const wasCheckedIn = attendee.estado === 'checkin';

    // Actualizar estado
    attendee.estado = 'checkin';
    attendee.checkin_count = (attendee.checkin_count || 0) + 1;
    attendee.ultimo_checkin = new Date().toISOString();

    const logEntry = {
      id: `chk-${Date.now()}`,
      ticket_code: attendee.codigo_ticket,
      nombre: `${attendee.nombre} ${attendee.apellido}`,
      puerta: puerta || 'Puerta Principal',
      staff: staff_nombre || 'Staff General',
      timestamp: attendee.ultimo_checkin,
      isDuplicate: wasCheckedIn
    };

    db.inMemoryStore.checkins.unshift(logEntry);

    // Actualizar en Postgres
    try {
      await db.query(`
        UPDATE asistentes_tickets 
        SET estado = 'checkin', checkin_count = checkin_count + 1, ultimo_checkin = NOW() 
        WHERE codigo_ticket = $1
      `, [attendee.codigo_ticket]);
    } catch (e) {
      // Memory fallback
    }

    return {
      success: true,
      isDuplicate: wasCheckedIn,
      message: wasCheckedIn ? '⚠ Advertencia: Este ticket ya había registrado ingreso anteriormente.' : '✓ Acceso concedido exitosamente.',
      attendee,
      checkin: logEntry
    };
  });

  // 3. Log de últimos ingresos en puerta
  fastify.get('/api/tickets/recent-checkins', async (req, reply) => {
    return {
      success: true,
      checkins: db.inMemoryStore.checkins.slice(0, 20)
    };
  });
}

module.exports = ticketsRoutes;
