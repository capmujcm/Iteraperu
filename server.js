const path = require('path');
const { Pool } = require('pg');

const fastify = require('fastify')({
  logger: false,
  disableRequestLogging: true
});

// -----------------------------------------------------------------------------
// Base de Datos PostgreSQL con Fallback Resiliente
// -----------------------------------------------------------------------------
const connectionString = process.env.DATABASE_URL || '';
let pool = null;

if (connectionString) {
  try {
    const isInternal = connectionString.includes('.railway.internal') || connectionString.includes('localhost');
    pool = new Pool({
      connectionString,
      ssl: isInternal ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 4000
    });
    pool.on('error', (err) => console.warn('[PostgreSQL Pool Warning]:', err.message));
  } catch (e) {
    console.warn('[PostgreSQL Init Warning]:', e.message);
  }
}

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
  stands: [
    { id: 'stand-01', nombre: 'ITERA Automation & AI', categoria: 'Automatización & IA', ubicacion: 'Stand A-01', color: '#315CFF' },
    { id: 'stand-02', nombre: 'Cloud Infrastructure Lab', categoria: 'Cloud & DevOps', ubicacion: 'Stand A-02', color: '#0055FF' },
    { id: 'stand-03', nombre: 'Enterprise Data BI', categoria: 'Business Intelligence', ubicacion: 'Stand B-01', color: '#0F9B6C' },
    { id: 'stand-04', nombre: 'Fintech Payments Flow', categoria: 'Fintech & Pagos', ubicacion: 'Stand B-02', color: '#B5179E' }
  ],
  standsLeads: [],
  preguntas: [
    { id: 'qa-1', autor: 'Fernando Ríos (Banco Líder)', pregunta: '¿Cómo cuantifican el ROI de rediseñar un proceso antes de automatizarlo con RPA?', votos: 14, respondida: false },
    { id: 'qa-2', autor: 'Lucía Cárdenas (Logística Express)', pregunta: '¿Cuál es el error más común al integrar ERPs antiguos con APIs modernas de almacén?', votos: 9, respondida: false },
    { id: 'qa-3', autor: 'Mariana Vega', pregunta: '¿Qué arquitectura recomiendan para gobernar datos en empresas medianas sin elevar costos en la nube?', votos: 7, respondida: true }
  ]
};

const SEED_ATTENDEES = [
  { nombre: 'Carlos', apellido: 'Ponce', email: 'carlos.ponce@itera.tech', empresa: 'ITERA Enterprise', cargo: 'CEO & Founder', tipo: 'organizador', code: 'ITR-7701', token: 'tok-carlos-7701' },
  { nombre: 'Ana', apellido: 'Valenzuela', email: 'ana.valenzuela@retailgroup.com', empresa: 'Retail Group Perú', cargo: 'Directora de Operaciones', tipo: 'vip', code: 'ITR-8812', token: 'tok-ana-8812' },
  { nombre: 'Diego', apellido: 'Morales', email: 'diego.morales@fintechperu.io', empresa: 'Fintech Andina', cargo: 'Head of Technology', tipo: 'speaker', code: 'ITR-5520', token: 'tok-diego-5520' },
  { nombre: 'Lucía', apellido: 'Cárdenas', email: 'lucia.c@logisticaexpress.pe', empresa: 'Logística Express', cargo: 'Gerente de Cadena de Suministro', tipo: 'general', code: 'ITR-3304', token: 'tok-lucia-3304' },
  { nombre: 'Fernando', apellido: 'Ríos', email: 'fernando.rios@bancolider.com', empresa: 'Banco Líder', cargo: 'VP de Transformación Digital', tipo: 'vip', code: 'ITR-9905', token: 'tok-fernando-9905' },
  { nombre: 'Mariana', apellido: 'Vega', email: 'm.vega@agroindustria.pe', empresa: 'Agroindustrias del Sur', cargo: 'Jefa de Innovación & TI', tipo: 'general', code: 'ITR-4411', token: 'tok-mariana-4411' },
  { nombre: 'Roberto', apellido: 'Alarcón', email: 'roberto@almacenes.com', empresa: 'Almacenes Centrales', cargo: 'Director Financiero', tipo: 'general', code: 'ITR-2208', token: 'tok-roberto-2208' },
  { nombre: 'Sofía', apellido: 'Gutiérrez', email: 'sofia.g@consultores.pe', empresa: 'Gutiérrez & Asoc.', cargo: 'Managing Partner', tipo: 'speaker', code: 'ITR-6633', token: 'tok-sofia-6633' }
];

function seedMemory() {
  inMemoryStore.asistentes = SEED_ATTENDEES.map((a, idx) => ({
    id: `att-${idx + 1}`,
    nombre: a.nombre,
    apellido: a.apellido,
    email: a.email,
    empresa: a.empresa,
    cargo: a.cargo,
    tipo_ticket: a.tipo,
    codigo_ticket: a.code,
    qr_token: a.token,
    estado: idx < 3 ? 'checkin' : 'valido',
    checkin_count: idx < 3 ? 1 : 0,
    ultimo_checkin: idx < 3 ? new Date().toISOString() : null,
    badges: ['Bienvenida', 'Networking']
  }));
}
seedMemory();

async function query(text, params = []) {
  if (pool) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      console.warn('[DB Error]:', err.message);
    }
  }
  return { rows: [], rowCount: 0 };
}

// -----------------------------------------------------------------------------
// Plugins
// -----------------------------------------------------------------------------
fastify.register(require('@fastify/cors'), { origin: true });

// -----------------------------------------------------------------------------
// Rutas API
// -----------------------------------------------------------------------------
fastify.get('/api/health', async () => {
  return {
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    db: pool ? 'connected' : 'memory_ready',
    attendeesCount: inMemoryStore.asistentes.length
  };
});

fastify.get('/api/events/current', async () => {
  return { success: true, event: inMemoryStore.eventos[0] };
});

fastify.get('/api/events/analytics', async () => {
  const attendees = inMemoryStore.asistentes;
  const totalRegistrados = attendees.length;
  const totalIngresados = attendees.filter(a => a.estado === 'checkin').length;
  const aforoMax = 500;
  const aforoPct = Math.round((totalIngresados / aforoMax) * 100);

  return {
    success: true,
    metrics: {
      totalRegistrados,
      totalIngresados,
      aforoMax,
      aforoPct,
      porTipo: {
        vip: attendees.filter(a => a.tipo_ticket === 'vip').length,
        general: attendees.filter(a => a.tipo_ticket === 'general').length,
        speaker: attendees.filter(a => a.tipo_ticket === 'speaker').length,
        organizador: attendees.filter(a => a.tipo_ticket === 'organizador').length
      },
      standsLeadsCount: inMemoryStore.standsLeads.length,
      timelineHoras: [
        { hora: '08:00', ingresos: 12 },
        { hora: '09:00', ingresos: 48 },
        { hora: '10:00', ingresos: 95 },
        { hora: '11:00', ingresos: 140 },
        { hora: '12:00', ingresos: 180 },
        { hora: '13:00', ingresos: Math.max(totalIngresados, 180) }
      ]
    }
  };
});

fastify.post('/api/events/seed', async () => {
  seedMemory();
  return { success: true, message: 'Datos demo inicializados con éxito', count: inMemoryStore.asistentes.length };
});

fastify.get('/api/attendees', async () => {
  return { success: true, count: inMemoryStore.asistentes.length, attendees: inMemoryStore.asistentes };
});

fastify.post('/api/attendees/register', async (req, reply) => {
  const { nombre, apellido, email, dni, cel, empresa, cargo, tipo_ticket } = req.body || {};
  if (!nombre) return reply.status(400).send({ error: 'Nombre es requerido' });

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

  inMemoryStore.asistentes.unshift(newAttendee);
  return reply.status(201).send({ success: true, attendee: newAttendee });
});

fastify.post('/api/tickets/verify', async (req, reply) => {
  const { token, code, dni } = req.body || {};
  const attendee = inMemoryStore.asistentes.find(
    a => (token && a.qr_token === token) || 
         (code && a.codigo_ticket.toLowerCase() === code.toLowerCase()) ||
         (dni && a.dni === dni)
  );

  if (!attendee) return reply.status(404).send({ valid: false, message: 'Ticket no encontrado' });
  return { valid: true, attendee, alreadyCheckedIn: attendee.estado === 'checkin' };
});

fastify.post('/api/tickets/checkin', async (req, reply) => {
  const { token, code, dni, puerta, staff_nombre } = req.body || {};
  const attendee = inMemoryStore.asistentes.find(
    a => (token && a.qr_token === token) || 
         (code && a.codigo_ticket.toLowerCase() === code.toLowerCase()) ||
         (dni && a.dni === dni)
  );

  if (!attendee) return reply.status(404).send({ success: false, error: 'Ticket inválido' });

  const wasCheckedIn = attendee.estado === 'checkin';
  attendee.estado = 'checkin';
  attendee.checkin_count = (attendee.checkin_count || 0) + 1;
  attendee.ultimo_checkin = new Date().toISOString();

  const logEntry = {
    id: `chk-${Date.now()}`,
    ticket_code: attendee.codigo_ticket,
    nombre: `${attendee.nombre} ${attendee.apellido}`,
    puerta: puerta || 'Puerta Principal',
    staff: staff_nombre || 'Staff',
    timestamp: attendee.ultimo_checkin,
    isDuplicate: wasCheckedIn
  };
  inMemoryStore.checkins.unshift(logEntry);

  return {
    success: true,
    isDuplicate: wasCheckedIn,
    message: wasCheckedIn ? '⚠ Advertencia: Ingreso previo registrado.' : '✓ Acceso concedido.',
    attendee,
    checkin: logEntry
  };
});

fastify.get('/api/stands', async () => {
  return { success: true, stands: inMemoryStore.stands };
});

fastify.post('/api/stands/scan-lead', async (req, reply) => {
  const { stand_id, attendee_code, attendee_token, interes, notas } = req.body || {};
  const attendee = inMemoryStore.asistentes.find(
    a => (attendee_token && a.qr_token === attendee_token) || 
         (attendee_code && a.codigo_ticket.toLowerCase() === attendee_code.toLowerCase())
  );

  if (!attendee) return reply.status(404).send({ error: 'Asistente no encontrado' });

  const newLead = {
    id: `lead-${Date.now()}`,
    stand_id: stand_id || 'stand-01',
    attendee,
    interes: interes || 'Alto',
    notas: notas || 'Contacto en stand.',
    captured_at: new Date().toISOString()
  };
  inMemoryStore.standsLeads.unshift(newLead);
  return reply.status(201).send({ success: true, lead: newLead });
});

fastify.get('/api/qa', async () => {
  const sorted = [...inMemoryStore.preguntas].sort((a, b) => b.votos - a.votos);
  return { success: true, count: sorted.length, questions: sorted };
});

fastify.post('/api/qa/ask', async (req, reply) => {
  const { autor, pregunta } = req.body || {};
  if (!pregunta) return reply.status(400).send({ error: 'Pregunta requerida' });

  const newQ = {
    id: `qa-${Date.now()}`,
    autor: autor || 'Asistente',
    pregunta: pregunta.trim(),
    votos: 1,
    respondida: false,
    created_at: new Date().toISOString()
  };
  inMemoryStore.preguntas.unshift(newQ);
  return reply.status(201).send({ success: true, question: newQ });
});

fastify.post('/api/qa/:id/upvote', async (req, reply) => {
  const q = inMemoryStore.preguntas.find(item => item.id === req.params.id);
  if (!q) return reply.status(404).send({ error: 'Pregunta no encontrada' });
  q.votos += 1;
  return { success: true, votos: q.votos };
});

fastify.post('/api/leads', async (request, reply) => {
  const { nombre, empresa, cargo, email, telefono, tamano_empresa, desafio, horas_semanales_perdidas, ahorro_estimado_usd, mensaje } = request.body || {};
  if (!nombre || !email || !empresa) return reply.status(400).send({ error: 'Nombre, email y empresa son requeridos' });

  try {
    const queryStr = `
      INSERT INTO leads_diagnostico (nombre, empresa, cargo, email, telefono, tamano_empresa, desafio, horas_semanales_perdidas, ahorro_estimado_usd, mensaje)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, created_at
    `;
    const values = [nombre, empresa, cargo, email, telefono, tamano_empresa, desafio, horas_semanales_perdidas || 0, ahorro_estimado_usd || 0, mensaje];
    const res = await query(queryStr, values);
    return reply.status(201).send({ success: true, lead: res.rows[0] || { id: `lead-${Date.now()}` } });
  } catch (err) {
    return reply.status(200).send({ success: true, simulated: true });
  }
});

// -----------------------------------------------------------------------------
// Servir Archivos Estáticos
// -----------------------------------------------------------------------------
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname),
  prefix: '/',
  decorateReply: true,
  wildcard: false
});

fastify.get('/', async (req, reply) => reply.sendFile('index.html'));
fastify.get('/brand', async (req, reply) => reply.sendFile('brand-deck.html'));
fastify.get('/evento', async (req, reply) => reply.sendFile('evento-plataforma/prototipo.html'));

// -----------------------------------------------------------------------------
// Arranque
// -----------------------------------------------------------------------------
const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    const address = await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`[ITERA Engine] Servidor en ${address}`);
  } catch (err) {
    console.error('[Error de arranque]:', err);
    process.exit(1);
  }
};
start();
