const db = require('../db');
const { seedDatabase } = require('../db/seed');

async function eventsRoutes(fastify, options) {
  // Obtener info del evento actual
  fastify.get('/api/events/current', async (req, reply) => {
    return {
      success: true,
      event: db.inMemoryStore.eventos[0],
      dbStatus: db.isConnected() ? 'connected' : 'memory_fallback'
    };
  });

  // Métricas y Analíticas en tiempo real para el Organizador
  fastify.get('/api/events/analytics', async (req, reply) => {
    const attendees = db.inMemoryStore.asistentes;
    const totalRegistrados = attendees.length;
    const totalIngresados = attendees.filter(a => a.estado === 'checkin').length;
    const aforoMax = db.inMemoryStore.eventos[0].aforo_max || 500;
    const aforoPct = Math.round((totalIngresados / aforoMax) * 100);

    const porTipo = {
      vip: attendees.filter(a => a.tipo_ticket === 'vip').length,
      general: attendees.filter(a => a.tipo_ticket === 'general').length,
      speaker: attendees.filter(a => a.tipo_ticket === 'speaker').length,
      organizador: attendees.filter(a => a.tipo_ticket === 'organizador').length
    };

    const standsLeadsCount = db.inMemoryStore.standsLeads.length;

    // Curva simulada por hora para gráficos ejecutivos
    const timelineHoras = [
      { hora: '08:00', ingresos: 12 },
      { hora: '09:00', ingresos: 48 },
      { hora: '10:00', ingresos: 95 },
      { hora: '11:00', ingresos: 140 },
      { hora: '12:00', ingresos: 180 },
      { hora: '13:00', ingresos: totalIngresados }
    ];

    return {
      success: true,
      metrics: {
        totalRegistrados,
        totalIngresados,
        aforoMax,
        aforoPct,
        porTipo,
        standsLeadsCount,
        timelineHoras
      }
    };
  });

  // Disparar seeder de datos demo
  fastify.post('/api/events/seed', async (req, reply) => {
    const res = await seedDatabase();
    return {
      success: true,
      message: 'Datos demo inicializados con éxito',
      summary: res
    };
  });
}

module.exports = eventsRoutes;
