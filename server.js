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
    // Por defecto no se valida el certificado (Railway/Heroku usan certs gestionados
    // que muchas veces no encadenan a una CA pública). Para endurecer, exporta
    // DB_SSL_REJECT_UNAUTHORIZED=true cuando tu proveedor exponga una CA válida.
    const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true';
    pool = new Pool({
      connectionString,
      ssl: isInternal ? false : { rejectUnauthorized },
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

// -----------------------------------------------------------------------------
// BBDD de prueba: 100 asistentes deterministas.
// Mismos DNI / códigos / tokens que el front (evento-plataforma/prototipo.html)
// para que el check-in en Puerta resuelva contra las mismas identidades.
// -----------------------------------------------------------------------------
const SEED_ATTENDEES_N = 100;

const FIRST_NAMES = ['María', 'José', 'Luis', 'Carlos', 'Ana', 'Rosa', 'Jorge', 'Miguel', 'Carmen', 'Juan', 'Pedro', 'Lucía', 'Elena', 'Sofía', 'Diego', 'Andrés', 'Fernando', 'Patricia', 'Gabriela', 'Ricardo', 'Manuel', 'Verónica', 'Daniela', 'Renato', 'Camila', 'Mateo', 'Valentina', 'Sebastián', 'Alejandra', 'Rodrigo', 'Paula', 'Bruno', 'Ximena', 'Álvaro', 'Fiorella', 'Gonzalo', 'Milagros', 'Óscar', 'Claudia', 'Héctor'];
const LAST_NAMES = ['García', 'Rodríguez', 'Flores', 'Torres', 'Rojas', 'Ramírez', 'Castillo', 'Vargas', 'Chávez', 'Quispe', 'Mamani', 'Huamán', 'Sánchez', 'Díaz', 'Cruz', 'Gutiérrez', 'Reyes', 'Morales', 'Ríos', 'Salazar', 'Espinoza', 'Cáceres', 'Ponce', 'Valdivia', 'Meza', 'Ochoa', 'Bravo', 'Peralta', 'Vidal', 'Fernández', 'Salas', 'Ramos', 'Castro', 'Paredes', 'Zúñiga', 'Aguilar', 'Benites', 'Cabrera', 'Delgado', 'Rivas'];
const SEED_EMPRESAS = ['Retail Group Perú', 'Fintech Andina', 'Logística Express', 'Banco Líder', 'Agroindustrias del Sur', 'Almacenes Centrales', 'Minera Los Andes', 'Textil Pacífico', 'Clínica San Rafael', 'Universidad Continental', 'Alicorp', 'Interbank', 'Rímac Seguros', 'Entel Perú', 'Cálidda', 'Ferreyros', 'Cencosud', 'Independiente'];
const SEED_CARGOS = ['Analista de Procesos', 'Jefe de Operaciones', 'Gerente de TI', 'Coordinador de Proyectos', 'Director Comercial', 'Especialista en Automatización', 'Subgerente de Logística', 'Consultor Senior', 'Product Owner', 'Data Analyst', 'Jefe de Innovación', 'Ingeniero de Sistemas'];
const SEED_ANCHORS = [
  ['Carlos', 'Ponce'], ['Ana', 'Valenzuela'], ['Diego', 'Morales'], ['Lucía', 'Cárdenas'], ['Fernando', 'Ríos']
];

const _slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

function buildSeedAttendees() {
  const now = Date.now();
  const list = [];
  for (let i = 0; i < SEED_ATTENDEES_N; i++) {
    const nombre = i < SEED_ANCHORS.length ? SEED_ANCHORS[i][0] : FIRST_NAMES[(i * 7) % FIRST_NAMES.length];
    const apellido = i < SEED_ANCHORS.length ? SEED_ANCHORS[i][1] : LAST_NAMES[(i * 13 + 3) % LAST_NAMES.length];
    const dni = String(40100000 + i * 98717).slice(0, 8);
    const validado = (i % 20) < 13; // ~65% ya hizo check-in
    const tipo = i < 3 ? 'organizador'
      : (i % 17 === 0 ? 'speaker'
        : (i % 9 === 0 ? 'vip'
          : (i % 23 === 0 ? 'staff' : 'general')));
    list.push({
      id: `att-${i + 1}`,
      nombre,
      apellido,
      dni,
      cel: '9' + String(60000000 + i * 813467).slice(0, 8),
      email: `${_slug(nombre)}.${_slug(apellido)}@correo.pe`,
      empresa: SEED_EMPRESAS[(i * 5 + 1) % SEED_EMPRESAS.length],
      cargo: SEED_CARGOS[(i * 3) % SEED_CARGOS.length],
      tipo_ticket: tipo,
      codigo_ticket: `ITR-${1000 + i}`,
      qr_token: `tok-${dni}`,
      estado: validado ? 'checkin' : 'valido',
      checkin_count: validado ? 1 : 0,
      ultimo_checkin: validado ? new Date(now - (((i * 37) % 560) + 5) * 60000).toISOString() : null,
      badges: ['Bienvenida'].concat((i * 3 + (i % 4)) % 9 > 3 ? ['Networking'] : [])
    });
  }
  return list;
}

function seedMemory() {
  inMemoryStore.asistentes = buildSeedAttendees();
  inMemoryStore.checkins = inMemoryStore.asistentes
    .filter(a => a.estado === 'checkin')
    .map(a => ({
      id: `chk-seed-${a.id}`,
      ticket_code: a.codigo_ticket,
      nombre: `${a.nombre} ${a.apellido}`,
      puerta: 'Puerta Principal',
      staff: 'Seed',
      timestamp: a.ultimo_checkin,
      isDuplicate: false
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
// Seguridad: autenticación de staff/admin y limitación de tasa
// -----------------------------------------------------------------------------
// Token de administración/staff. Es OBLIGATORIO: si no se configura, los
// endpoints con datos personales responden 503 en vez de quedar abiertos
// (seguro por defecto). Definir ADMIN_TOKEN en el servicio los habilita.
// .trim() porque al pegar en paneles como Railway se cuelan espacios/saltos.
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const AUTH_ENABLED = ADMIN_TOKEN.length > 0;
if (!AUTH_ENABLED) {
  console.warn('[SEGURIDAD] ADMIN_TOKEN no configurado: los endpoints con datos personales quedan CERRADOS (503) hasta que se defina. Configúralo en las variables del servicio.');
} else if (ADMIN_TOKEN.length < 16) {
  console.warn('[SEGURIDAD] ADMIN_TOKEN es corto (<16 caracteres). Usa un token largo y aleatorio.');
}

// Comparación en tiempo constante para evitar ataques de temporización.
function safeEqual(a, b) {
  const crypto = require('crypto');
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// preHandler: exige token de admin en endpoints sensibles (si AUTH_ENABLED).
async function requireAdmin(req, reply) {
  // Cerrado por defecto: sin ADMIN_TOKEN configurado NADIE accede a los datos
  // personales. Se prefiere denegar el servicio a filtrar PII por un despiste
  // de configuración. El flujo de puerta del staff sigue funcionando porque el
  // front valida el ingreso contra su almacenamiento local.
  if (!AUTH_ENABLED) {
    reply.code(503).send({
      error: 'Servicio de datos no disponible: falta configurar ADMIN_TOKEN en el servidor.',
      hint: 'Define la variable de entorno ADMIN_TOKEN en el servicio y vuelve a desplegar.'
    });
    return reply;
  }
  const header = (req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')).trim();
  if (!header || !safeEqual(header, ADMIN_TOKEN)) {
    reply.code(401).send({ error: 'No autorizado. Falta o es inválido el token de staff.' });
    return reply;
  }
}

// Limitador de tasa en memoria (ventana deslizante por IP) — frena fuerza bruta
// y enumeración de DNIs/códigos sin añadir dependencias.
const rateBuckets = new Map();
// Identificador del proceso, para detectar si hay varias réplicas sirviendo
// (cada réplica tendría su propio contador en memoria).
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);

// Detrás del proxy de Railway, req.ip es la IP del proxy y no distingue
// visitantes. La cabecera X-Forwarded-For llega como "cliente, proxy1, ...";
// se toma la ÚLTIMA entrada porque es la que añade el proxy de confianza: las
// anteriores las puede falsificar quien llama para eludir el límite.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.ip || 'unknown';
}

function rateLimit(max, windowMs) {
  return async (req, reply) => {
    const ip = clientIp(req);
    const now = Date.now();
    let b = rateBuckets.get(ip);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(ip, b); }
    b.count++;
    if (b.count > max) {
      reply.code(429).send({ error: 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.' });
      return reply;
    }
  };
}
// Limpieza periódica de buckets vencidos.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) { if (now > v.reset) rateBuckets.delete(k); }
}, 60000).unref();

// -----------------------------------------------------------------------------
// Plugins
// -----------------------------------------------------------------------------
// CORS restringido: por defecto solo mismo origen (el navegador no aplica CORS a
// peticiones del mismo origen, así que la app sigue funcionando). Para permitir
// orígenes externos concretos, exporta ALLOWED_ORIGINS="https://a.com,https://b.com".
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
fastify.register(require('@fastify/cors'), {
  origin: allowedOrigins.length ? allowedOrigins : false,
  methods: ['GET', 'POST'],
  maxAge: 86400
});
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/',
  decorateReply: true
});

// -----------------------------------------------------------------------------
// Rutas API
// -----------------------------------------------------------------------------
fastify.get('/api/health', async (req) => {
  return {
    // Diagnóstico temporal del limitador de tasa.
    instance: INSTANCE_ID,
    ipKey: clientIp(req),
    buckets: rateBuckets.size,
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    db: pool ? 'connected' : 'memory_ready',
    attendeesCount: inMemoryStore.asistentes.length,
    // Diagnóstico operativo: indica si la protección de endpoints está activa.
    // Solo expone un booleano; nunca el token ni su longitud.
    auth: AUTH_ENABLED ? 'enabled' : 'DISABLED'
  };
});

fastify.get('/api/events/current', async () => {
  return { success: true, event: inMemoryStore.eventos[0] };
});

fastify.get('/api/events/analytics', { preHandler: requireAdmin }, async () => {
  const attendees = inMemoryStore.asistentes;
  const totalRegistrados = attendees.length;
  const ingresados = attendees.filter(a => a.estado === 'checkin');
  const totalIngresados = ingresados.length;
  const aforoMax = inMemoryStore.eventos[0]?.aforo_max || 500;
  const aforoPct = Math.round((totalIngresados / aforoMax) * 100);

  // Timeline real: acumulado de check-ins por hora del día.
  const horas = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
  const porHora = {};
  ingresados.forEach(a => {
    if (!a.ultimo_checkin) return;
    const h = new Date(a.ultimo_checkin).getHours();
    const key = String(h).padStart(2, '0') + ':00';
    porHora[key] = (porHora[key] || 0) + 1;
  });
  let acumulado = 0;
  const timelineHoras = horas.map(hora => {
    acumulado += porHora[hora] || 0;
    return { hora, ingresos: acumulado };
  });

  return {
    success: true,
    metrics: {
      totalRegistrados,
      totalIngresados,
      aforoMax,
      aforoPct,
      tasaIngreso: totalRegistrados ? Math.round((totalIngresados / totalRegistrados) * 100) : 0,
      standsLeadsCount: inMemoryStore.standsLeads.length,
      preguntasCount: inMemoryStore.preguntas.length,
      porTipo: {
        vip: attendees.filter(a => a.tipo_ticket === 'vip').length,
        general: attendees.filter(a => a.tipo_ticket === 'general').length,
        speaker: attendees.filter(a => a.tipo_ticket === 'speaker').length,
        staff: attendees.filter(a => a.tipo_ticket === 'staff').length,
        organizador: attendees.filter(a => a.tipo_ticket === 'organizador').length
      },
      timelineHoras
    }
  };
});

fastify.post('/api/events/seed', { preHandler: requireAdmin }, async () => {
  seedMemory();
  return { success: true, message: 'Datos demo inicializados con éxito', count: inMemoryStore.asistentes.length };
});

fastify.get('/api/attendees', { preHandler: requireAdmin }, async () => {
  return { success: true, count: inMemoryStore.asistentes.length, attendees: inMemoryStore.asistentes };
});

fastify.post('/api/attendees/register', { preHandler: rateLimit(20, 60000) }, async (req, reply) => {
  const { nombre, apellido, email, dni, cel, empresa, cargo, tipo_ticket } = req.body || {};
  if (!nombre) return reply.status(400).send({ error: 'Nombre es requerido' });

  // Códigos nuevos por encima del rango sembrado (ITR-1000..ITR-1099) para evitar colisiones.
  let seq = 1100;
  while (inMemoryStore.asistentes.some(a => a.codigo_ticket === `ITR-${seq}`)) seq++;
  const randomCode = `ITR-${seq}`;
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

fastify.post('/api/tickets/verify', { preHandler: rateLimit(20, 60000) }, async (req, reply) => {
  const { token, code, dni } = req.body || {};
  const attendee = inMemoryStore.asistentes.find(
    a => (token && a.qr_token === token) || 
         (code && a.codigo_ticket.toLowerCase() === code.toLowerCase()) ||
         (dni && a.dni === dni)
  );

  if (!attendee) return reply.status(404).send({ valid: false, message: 'Ticket no encontrado' });
  return { valid: true, attendee, alreadyCheckedIn: attendee.estado === 'checkin' };
});

fastify.post('/api/tickets/checkin', { preHandler: requireAdmin }, async (req, reply) => {
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

fastify.post('/api/stands/scan-lead', { preHandler: requireAdmin }, async (req, reply) => {
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

fastify.post('/api/qa/ask', { preHandler: rateLimit(15, 60000) }, async (req, reply) => {
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

fastify.post('/api/qa/:id/upvote', { preHandler: rateLimit(60, 60000) }, async (req, reply) => {
  const q = inMemoryStore.preguntas.find(item => item.id === req.params.id);
  if (!q) return reply.status(404).send({ error: 'Pregunta no encontrada' });
  q.votos += 1;
  return { success: true, votos: q.votos };
});

fastify.post('/api/leads', { preHandler: rateLimit(15, 60000) }, async (request, reply) => {
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
// Rutas de Páginas & Roles Directos
// -----------------------------------------------------------------------------
fastify.get('/brand', async (req, reply) => reply.sendFile('brand-deck.html'));
fastify.get('/evento', async (req, reply) => reply.sendFile('evento/prototipo.html'));

// URLs dedicadas por rol
fastify.get('/asistente', async (req, reply) => reply.sendFile('evento/prototipo.html'));
fastify.get('/persona', async (req, reply) => reply.sendFile('evento/prototipo.html'));
fastify.get('/empresa', async (req, reply) => reply.sendFile('evento/prototipo.html'));
fastify.get('/organizador', async (req, reply) => reply.sendFile('evento/prototipo.html'));
fastify.get('/proveedor', async (req, reply) => reply.sendFile('evento/prototipo.html'));
fastify.get('/staff', async (req, reply) => reply.sendFile('evento/prototipo.html'));
fastify.get('/ayuda', async (req, reply) => reply.sendFile('evento/prototipo.html'));

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
