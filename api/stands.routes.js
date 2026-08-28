const db = require('../db');

async function standsRoutes(fastify, options) {
  // 1. Listar stands del evento
  fastify.get('/api/stands', async (req, reply) => {
    return {
      success: true,
      stands: db.inMemoryStore.stands || []
    };
  });

  // 2. Escaneo de Asistente en Stand (Captura de Lead por Expositor)
  fastify.post('/api/stands/scan-lead', async (req, reply) => {
    const { stand_id, attendee_code, attendee_token, interes, notas } = req.body || {};

    const attendee = db.inMemoryStore.asistentes.find(
      a => (attendee_token && a.qr_token === attendee_token) || 
           (attendee_code && a.codigo_ticket.toLowerCase() === attendee_code.toLowerCase())
    );

    if (!attendee) {
      return reply.status(404).send({ error: 'Asistente no encontrado' });
    }

    const newLead = {
      id: `lead-${Date.now()}`,
      stand_id: stand_id || 'stand-01',
      attendee: {
        nombre: attendee.nombre,
        apellido: attendee.apellido,
        email: attendee.email,
        empresa: attendee.empresa,
        cargo: attendee.cargo,
        codigo_ticket: attendee.codigo_ticket
      },
      interes: interes || 'Alto',
      notas: notas || 'Contacto establecido en stand.',
      captured_at: new Date().toISOString()
    };

    db.inMemoryStore.standsLeads.unshift(newLead);

    return reply.status(201).send({
      success: true,
      message: '✓ Contacto comercial guardado con éxito',
      lead: newLead
    });
  });

  // 3. Obtener leads capturados por un stand
  fastify.get('/api/stands/:stand_id/leads', async (req, reply) => {
    const { stand_id } = req.params;
    const leads = db.inMemoryStore.standsLeads.filter(l => l.stand_id === stand_id);
    return {
      success: true,
      count: leads.length,
      leads
    };
  });
}

module.exports = standsRoutes;
