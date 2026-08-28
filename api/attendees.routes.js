const db = require('../db');

async function attendeesRoutes(fastify, options) {
  // 1. Listar asistentes
  fastify.get('/api/attendees', async (req, reply) => {
    return {
      success: true,
      count: db.inMemoryStore.asistentes.length,
      attendees: db.inMemoryStore.asistentes
    };
  });

  // 2. Registrar nuevo asistente o generar ticket
  fastify.post('/api/attendees/register', async (req, reply) => {
    const { nombre, apellido, email, dni, cel, empresa, cargo, tipo_ticket } = req.body || {};

    if (!nombre || (!email && !cel && !dni)) {
      return reply.status(400).send({ error: 'Nombre y un identificador (Email, DNI o Celular) son requeridos' });
    }

    // Buscar si ya existe por DNI o Email
    let attendee = db.inMemoryStore.asistentes.find(
      a => (dni && a.dni === dni) || (email && a.email.toLowerCase() === email.toLowerCase())
    );

    if (attendee) {
      return {
        success: true,
        isExisting: true,
        attendee,
        message: 'Registro recuperado exitosamente'
      };
    }

    const randomCode = `ITR-${Math.floor(1000 + Math.random() * 9000)}`;
    const randomToken = `tok-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;

    const newAttendee = {
      id: `att-${Date.now()}`,
      nombre: nombre.trim(),
      apellido: (apellido || '').trim(),
      dni: (dni || '').trim(),
      cel: (cel || '').trim(),
      email: (email || '').trim(),
      empresa: (empresa || 'Empresa Independiente').trim(),
      cargo: (cargo || 'Profesional').trim(),
      tipo_ticket: tipo_ticket || 'general',
      codigo_ticket: randomCode,
      qr_token: randomToken,
      estado: 'valido',
      checkin_count: 0,
      ultimo_checkin: null,
      badges: ['Bienvenida']
    };

    db.inMemoryStore.asistentes.unshift(newAttendee);

    // Intento de guardado en PostgreSQL
    try {
      await db.query(`
        INSERT INTO asistentes_tickets (codigo_ticket, qr_token, nombre, apellido, email, empresa, cargo, tipo_ticket, estado)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'valido')
      `, [newAttendee.codigo_ticket, newAttendee.qr_token, newAttendee.nombre, newAttendee.apellido, newAttendee.email, newAttendee.empresa, newAttendee.cargo, newAttendee.tipo_ticket]);
    } catch (e) {
      // Memory store ya tiene los datos
    }

    return reply.status(201).send({
      success: true,
      isExisting: false,
      attendee: newAttendee,
      message: 'Ticket creado exitosamente'
    });
  });

  // 3. Obtener ticket por código o QR Token
  fastify.get('/api/attendees/ticket/:identifier', async (req, reply) => {
    const { identifier } = req.params;
    const attendee = db.inMemoryStore.asistentes.find(
      a => a.codigo_ticket.toLowerCase() === identifier.toLowerCase() || a.qr_token === identifier || (a.dni && a.dni === identifier)
    );

    if (!attendee) {
      return reply.status(404).send({ error: 'Ticket no encontrado' });
    }

    return { success: true, attendee };
  });
}

module.exports = attendeesRoutes;
