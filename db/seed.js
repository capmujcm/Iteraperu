const db = require('./index');

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

const SEED_STANDS = [
  { id: 'stand-01', nombre: 'ITERA Automation & AI', categoria: 'Automatización & IA', ubicacion: 'Stand A-01', color: '#315CFF' },
  { id: 'stand-02', nombre: 'Cloud Infrastructure Lab', categoria: 'Cloud & DevOps', ubicacion: 'Stand A-02', color: '#0055FF' },
  { id: 'stand-03', nombre: 'Enterprise Data BI', categoria: 'Business Intelligence', ubicacion: 'Stand B-01', color: '#0F9B6C' },
  { id: 'stand-04', nombre: 'Fintech Payments Flow', categoria: 'Fintech & Pagos', ubicacion: 'Stand B-02', color: '#B5179E' }
];

const SEED_QUESTIONS = [
  { autor: 'Fernando Ríos (Banco Líder)', pregunta: '¿Cómo cuantifican el ROI de rediseñar un proceso antes de automatizarlo con RPA?', votos: 14, respondida: false },
  { autor: 'Lucía Cárdenas (Logística Express)', pregunta: '¿Cuál es el error más común al integrar ERPs antiguos con APIs modernas de almacén?', votos: 9, respondida: false },
  { autor: 'Mariana Vega', pregunta: '¿Qué arquitectura recomiendan para gobernar datos en empresas medianas sin elevar costos en la nube?', votos: 7, respondida: true }
];

async function seedDatabase() {
  console.log('[SEED] Inicializando datos demo en memoria y PostgreSQL...');

  // 1. Población en memoria (siempre disponible)
  db.inMemoryStore.asistentes = SEED_ATTENDEES.map((a, idx) => ({
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

  db.inMemoryStore.stands = SEED_STANDS;
  db.inMemoryStore.preguntas = SEED_QUESTIONS.map((q, idx) => ({
    id: `qa-${idx + 1}`,
    ...q,
    created_at: new Date(Date.now() - (idx * 15 * 60000)).toISOString()
  }));

  // 2. Intento de persistencia en PostgreSQL si está disponible
  try {
    // Evento base
    await db.query(`
      INSERT INTO eventos (id, slug, nombre, descripcion, lugar, aforo_max, activo)
      VALUES ('a0000000-0000-0000-0000-000000000001', 'itera-summit-2026', 'ITERA Summit 2026', 'Transformación y Evolución Empresarial', 'Centro de Convenciones', 500, true)
      ON CONFLICT (slug) DO NOTHING;
    `);

    // Asistentes
    for (const a of SEED_ATTENDEES) {
      await db.query(`
        INSERT INTO asistentes_tickets (codigo_ticket, qr_token, nombre, apellido, email, empresa, cargo, tipo_ticket, estado)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'valido')
        ON CONFLICT (codigo_ticket) DO NOTHING;
      `, [a.code, a.token, a.nombre, a.apellido, a.email, a.empresa, a.cargo, a.tipo]);
    }

    console.log('[SEED] Base de datos poblada exitosamente.');
  } catch (err) {
    console.warn('[SEED] Nota: Datos cargados en memoria resiliente.');
  }

  return {
    asistentesCount: db.inMemoryStore.asistentes.length,
    standsCount: SEED_STANDS.length,
    preguntasCount: SEED_QUESTIONS.length
  };
}

module.exports = { seedDatabase, SEED_ATTENDEES, SEED_STANDS, SEED_QUESTIONS };
