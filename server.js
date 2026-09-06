const path = require('path');
const { Pool } = require('pg');

const { pgDriver, memoryDriver, safeAttendee, publicAttendee, auth } = require('./lib/store');
const registrarAuth = require('./lib/routes-auth');
const registrarInsignias = require('./lib/routes-insignias');
const registrarEmpresa = require('./lib/routes-empresa');

// Logger activado: durante el evento hay que poder reconstruir que paso en la
// puerta. `disableRequestLogging` evita una linea por peticion de asset, que
// solo genera ruido. Los handlers nunca registran DNI, correo, celular ni
// tokens (checklist punto 2).
const fastify = require('fastify')({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  disableRequestLogging: true
});

// -----------------------------------------------------------------------------
// Configuracion del evento
// -----------------------------------------------------------------------------
const EVENTO = {
  slug: process.env.EVENT_SLUG || 'country-fest',
  nombre: process.env.EVENT_NAME || 'Country Fest 2026',
  descripcion: process.env.EVENT_DESC || 'Feria gastronomica con dinamica de insignias.',
  lugar: process.env.EVENT_PLACE || 'Por confirmar',
  aforo_max: Number(process.env.EVENT_AFORO) || 500
};

// Datos ficticios de demostracion. Apagados por defecto: en una prueba real
// contaminan el aforo, la analitica y la lista de asistentes.
const SEED_DEMO = process.env.SEED_DEMO === 'true';

// Para coleccionar insignias hay que haber validado el ingreso en la puerta.
// Es la defensa contra el QR de un puesto filtrado por WhatsApp: sin esto,
// quien reciba la foto gana tickets de sorteo sin haber ido al evento.
// Se puede desactivar con EXIGIR_INGRESO_PARA_ESCANEAR=false, pero entonces el
// sorteo deja de estar protegido.
const EXIGIR_INGRESO_PARA_ESCANEAR = process.env.EXIGIR_INGRESO_PARA_ESCANEAR !== 'false';

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

// Nota: aquí vivía un `inMemoryStore` con stands y preguntas sembradas del
// evento anterior (ITERA Summit), servidas por /api/stands y /api/qa. Ninguna
// app de Country Fest los usaba y devolvían datos inventados a quien preguntara,
// así que se retiraron junto con sus endpoints. Los puestos participantes viven
// ahora en la tabla `empresas`.

// -----------------------------------------------------------------------------
// Capa de datos: PostgreSQL cuando hay DATABASE_URL, RAM en caso contrario
// -----------------------------------------------------------------------------
const store = pool ? pgDriver(pool) : memoryDriver();
let evento = null;      // fila del evento activo
let eventoId = null;
// Si el esquema no se puede aplicar, se guarda el motivo y la plataforma de
// eventos queda deshabilitada, pero el servidor SIGUE EN PIE. La landing
// comercial no tiene por que caerse por un problema de base de datos.
let errorDeArranque = null;

async function iniciarStore() {
  evento = await store.init(EVENTO);
  eventoId = evento.id;

  if (store.name === 'memory') {
    console.warn(
      '[DATOS] Sin DATABASE_URL: se esta usando el almacen en memoria. ' +
      'Todo se pierde al reiniciar el servicio. No usar para una prueba real.'
    );
  }

  if (SEED_DEMO) {
    await sembrarDemo();
  }
}

// Sembrado de demostracion. Se ejecuta solo con SEED_DEMO=true y crea las
// personas a traves del store, de modo que la demo recorre exactamente el mismo
// camino que el evento real. Los DNI son ficticios y el prefijo del codigo es
// DEMO- para poder distinguirlos y borrarlos.
const SEED_NOMBRES = ['María', 'José', 'Luis', 'Carlos', 'Ana', 'Rosa', 'Jorge', 'Miguel', 'Carmen', 'Juan', 'Pedro', 'Lucía', 'Elena', 'Sofía', 'Diego', 'Andrés', 'Fernando', 'Patricia', 'Gabriela', 'Ricardo'];
const SEED_APELLIDOS = ['García', 'Rodríguez', 'Flores', 'Torres', 'Rojas', 'Ramírez', 'Castillo', 'Vargas', 'Chávez', 'Quispe', 'Mamani', 'Huamán', 'Sánchez', 'Díaz', 'Cruz', 'Gutiérrez', 'Reyes', 'Morales', 'Ríos', 'Salazar'];
const SEED_N = 40;

async function sembrarDemo() {
  const yaHay = await store.countAttendees(eventoId);
  if (yaHay.total > 0) {
    console.warn(`[DEMO] Ya hay ${yaHay.total} asistentes; no se siembra de nuevo.`);
    return;
  }

  // Todas las personas de demo comparten la contrasena temporal, con cambio
  // obligatorio: asi ni siquiera los datos de prueba dejan cuentas con clave
  // fija utilizable.
  const { hash, salt, algo } = auth.hashPassword(auth.TEMP_PASSWORD);

  for (let i = 0; i < SEED_N; i++) {
    await store.createAttendee({
      evento_id: eventoId,
      codigo_ticket: `DEMO-${1000 + i}`,
      qr_token: auth.newQrToken(),
      dni: String(70100000 + i * 971).slice(0, 8),
      nombre: SEED_NOMBRES[i % SEED_NOMBRES.length],
      apellido: SEED_APELLIDOS[(i * 7 + 3) % SEED_APELLIDOS.length],
      email: null,
      celular: null,
      empresa: 'Demo',
      cargo: null,
      tipo_ticket: i % 11 === 0 ? 'vip' : 'general',
      estado: 'valido',
      password_hash: hash,
      password_salt: salt,
      password_algo: algo,
      password_updated_at: new Date().toISOString(),
      must_change_password: true,
      temp_password_expires_at: new Date(Date.now() + auth.TEMP_PASSWORD_TTL_MS).toISOString()
    });
  }
  console.warn(`[DEMO] Sembrados ${SEED_N} asistentes ficticios (codigos DEMO-*).`);
}

// Nota: aquí vivía un helper `query()` que capturaba los errores de PostgreSQL
// y devolvía `{ rows: [] }`. Eso hacía que un fallo de escritura pareciera un
// éxito con cero resultados. Se retiró a propósito: los accesos a la base van
// por `lib/store.js` o por `pool.query` directo, y los errores se propagan.

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
  // de configuración. Ojo: ahora el check-in de puerta y el restablecimiento de
  // contraseñas también pasan por aquí, así que sin ADMIN_TOKEN el Punto de
  // Ayuda queda inoperativo. Es deliberado: configurar el token es requisito
  // para operar el evento.
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
// Cabeceras de seguridad
// -----------------------------------------------------------------------------
// Se ponen a mano en vez de añadir @fastify/helmet: son seis cabeceras y así se
// ve exactamente qué se está enviando y por qué (checklist punto 7).
//
// Sobre la CSP: las apps llevan sus <script> y <style> en el propio HTML, así
// que hace falta 'unsafe-inline'. Eso limita el valor de la CSP frente a un XSS,
// pero sigue sirviendo para lo que más importa aquí: `default-src 'self'` impide
// que un script inyectado envíe los datos a un servidor externo, y
// `frame-ancestors 'none'` impide el clickjacking sobre el Punto de Ayuda.
// Separar los scripts a archivos propios y quitar 'unsafe-inline' es la mejora
// pendiente.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  // Las tipografías del festival vienen de Fontshare y Google Fonts.
  "style-src 'self' 'unsafe-inline' https://api.fontshare.com https://fonts.googleapis.com",
  "font-src 'self' https://api.fontshare.com https://cdn.fontshare.com https://fonts.gstatic.com",
  // data: y blob: porque el QR se dibuja en un <canvas> y los logos se
  // previsualizan desde el archivo antes de subirlos.
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  // La cámara necesita media-src para el <video> del lector de QR.
  "media-src 'self' blob:"
].join('; ');

fastify.addHook('onSend', async (req, reply, payload) => {
  reply.header('Content-Security-Policy', CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  // El QR de una entrada no debe viajar en el Referer hacia terceros.
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Se desactivan las APIs que la plataforma no usa. La cámara SÍ se necesita
  // para leer los QR, así que se permite en el propio origen.
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), payment=(), usb=(), camera=(self)');

  // HSTS solo cuando la petición llegó por HTTPS: activarlo en HTTP local
  // dejaría el navegador del desarrollador clavado en https://localhost.
  const proto = req.headers['x-forwarded-proto'] || (req.raw.socket && req.raw.socket.encrypted ? 'https' : 'http');
  if (proto === 'https') {
    reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  return payload;
});

// -----------------------------------------------------------------------------
// Guardia de arranque
// -----------------------------------------------------------------------------
// Si la base no quedó lista, la plataforma de eventos responde 503 en vez de
// operar a ciegas: se prefiere una puerta parada a una puerta que dice "adelante"
// sin registrar nada. La landing y los archivos estáticos siguen sirviéndose.
fastify.addHook('onRequest', async (req, reply) => {
  if (!errorDeArranque) return;
  const url = req.raw.url || '';
  const esApi = url.startsWith('/api/') && url !== '/api/health';
  const esAppEvento = url.startsWith('/e/') || url.startsWith('/staff/') ||
                      url.startsWith('/negocios/') || url.startsWith('/consola/') ||
                      url === '/e' || url === '/entrada';
  if (esApi || esAppEvento) {
    reply.code(503).send({
      error: 'La plataforma de eventos no está disponible: la base de datos no quedó lista al arrancar.',
      hint: 'Revisa los logs del servicio y la variable DATABASE_URL.'
    });
    return reply;
  }
});

// -----------------------------------------------------------------------------
// Rutas API
// -----------------------------------------------------------------------------
// Sonda de salud. No expone conteos de asistentes ni nada derivado de datos
// personales: solo el estado operativo del servicio.
fastify.get('/api/health', async (req, reply) => {
  if (errorDeArranque) {
    // 503 para que cualquier monitor lo vea como caído, con el motivo a la
    // vista pero sin filtrar la cadena de conexión ni credenciales.
    return reply.code(503).send({
      status: 'degradado',
      uptime: process.uptime(),
      eventos: 'no disponible',
      motivo: errorDeArranque,
      auth: AUTH_ENABLED ? 'enabled' : 'DISABLED'
    });
  }
  return {
    status: 'ok',
    uptime: process.uptime(),
    almacen: store.name,
    persistente: store.name === 'pg',
    evento: evento ? evento.slug : null,
    // Diagnóstico operativo: indica si la protección de endpoints está activa.
    // Solo expone un booleano; nunca el token ni su longitud.
    auth: AUTH_ENABLED ? 'enabled' : 'DISABLED'
  };
});

// Datos publicos del evento: nombre, lugar y aforo. Sin informacion de personas.
fastify.get('/api/events/current', async () => {
  return {
    success: true,
    event: {
      slug: evento.slug,
      nombre: evento.nombre,
      descripcion: evento.descripcion,
      lugar: evento.lugar,
      aforo_max: evento.aforo_max,
      activo: evento.activo
    }
  };
});

// Analitica agregada. Son cifras de conjunto, no fichas de personas, pero
// siguen exigiendo token de staff porque revelan el pulso del evento.
fastify.get('/api/events/analytics', { preHandler: requireAdmin }, async () => {
  const conteo = await store.countAttendees(eventoId);
  const porTipoFilas = await store.countByTipo(eventoId);
  const timeline = await store.checkinTimeline(eventoId);
  const insignias = await store.contarInsignias(eventoId);

  const aforoMax = evento.aforo_max || 500;
  const porTipo = porTipoFilas.reduce((acc, f) => {
    acc[f.tipo_ticket || 'general'] = f.n;
    return acc;
  }, {});

  // Acumulado sobre la franja horaria del evento.
  const horas = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
  const mapa = timeline.reduce((acc, f) => { acc[f.hora] = f.ingresos; return acc; }, {});
  let acumulado = 0;
  const timelineHoras = horas.map(hora => {
    acumulado += mapa[hora] || 0;
    return { hora, ingresos: acumulado };
  });

  return {
    success: true,
    metrics: {
      totalRegistrados: conteo.total,
      totalIngresados: conteo.ingresados,
      aforoMax,
      aforoPct: aforoMax ? Math.round((conteo.ingresados / aforoMax) * 100) : 0,
      tasaIngreso: conteo.total ? Math.round((conteo.ingresados / conteo.total) * 100) : 0,
      // Insignias emitidas = tickets de sorteo repartidos. `personas` es cuánta
      // gente distinta consiguió al menos una.
      insigniasTotal: insignias.total,
      insigniasPersonas: insignias.personas,
      puestos: (await store.listEmpresas(eventoId)).length,
      porTipo,
      timelineHoras
    }
  };
});

// Listado de asistentes: PII completa, siempre paginado. Sin paginacion, un
// unico GET se llevaba la base entera de DNI, correos y celulares.
fastify.get('/api/attendees', { preHandler: requireAdmin }, async (req) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { rows, total } = await store.listAttendees(eventoId, { limit, offset });
  return {
    success: true,
    total,
    limit,
    offset,
    attendees: rows.map(safeAttendee)
  };
});

// -----------------------------------------------------------------------------
// Exportación de datos
// -----------------------------------------------------------------------------
// Convierte filas a CSV. El escapado importa: un nombre con coma, comillas o un
// salto de línea rompería el archivo si se concatenara a pelo.
//
// El prefijo con comilla simple ante = + - @ evita la inyección de fórmulas:
// una celda que empiece por "=" la ejecuta Excel al abrir el archivo, y un
// nombre malicioso podría convertirse en un comando.
function aCSV(filas) {
  if (!filas.length) return '';
  const columnas = Object.keys(filas[0]);
  const celda = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lineas = [columnas.join(',')];
  filas.forEach(f => lineas.push(columnas.map(c => celda(f[c])).join(',')));
  // BOM para que Excel en Windows reconozca el UTF-8 y no destroce las tildes.
  return '﻿' + lineas.join('\r\n');
}

// Descarga de asistentes, check-ins o insignias. Lleva DNI, correo y celular:
// exige token de staff y se registra quién lo pidió.
fastify.get('/api/export/:que', { preHandler: requireAdmin }, async (req, reply) => {
  const que = String(req.params.que || '').toLowerCase();
  const fuentes = {
    asistentes: () => store.exportarAsistentes(eventoId),
    checkins: () => store.exportarCheckins(eventoId),
    insignias: () => store.exportarInsignias(eventoId)
  };

  if (!fuentes[que]) {
    return reply.code(404).send({ error: 'Exportación no reconocida. Usa: asistentes, checkins o insignias.' });
  }

  const filas = await fuentes[que]();
  // No se registra el contenido, solo el hecho y el volumen (checklist punto 2).
  req.log.warn({ export: que, filas: filas.length }, 'exportacion de datos personales');

  const fecha = new Date().toISOString().slice(0, 10);
  const nombre = `country-fest-${que}-${fecha}.csv`;

  if (req.query.formato === 'json') {
    return reply.send({ success: true, total: filas.length, filas });
  }

  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${nombre}"`)
    .send(aCSV(filas));
});

// Ultimos check-ins registrados, para el panel de puerta.
fastify.get('/api/checkins', { preHandler: requireAdmin }, async (req) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  return { success: true, checkins: await store.listCheckins(eventoId, limit) };
});

// -----------------------------------------------------------------------------
// Tickets: verificacion y check-in en puerta
// -----------------------------------------------------------------------------
// Se busca SOLO por token de QR o por codigo de ticket. La busqueda por DNI se
// retiro de este endpoint publico: permitia recorrer documentos ajenos y
// obtener la ficha completa de cada persona. Para el Punto de Ayuda existe
// /api/soporte/buscar, que exige token de staff.
async function buscarPorTicket({ token, code }) {
  if (token && typeof token === 'string') {
    const p = await store.findByQrToken(eventoId, token.trim().slice(0, 64));
    if (p) return p;
  }
  if (code && typeof code === 'string') {
    const p = await store.findByCodigo(eventoId, code.trim().slice(0, 30));
    if (p) return p;
  }
  return null;
}

// Verificacion publica: responde lo justo para saber a quien se deja pasar.
// Nunca devuelve DNI, correo ni celular.
fastify.post('/api/tickets/verify', { preHandler: rateLimit(20, 60000) }, async (req, reply) => {
  const { token, code } = req.body || {};
  const persona = await buscarPorTicket({ token, code });
  if (!persona) {
    return reply.status(404).send({ valid: false, message: 'Ticket no encontrado' });
  }
  return {
    valid: true,
    attendee: publicAttendee(persona),
    alreadyCheckedIn: persona.estado === 'checkin'
  };
});

// Check-in: escribe en la base y deja rastro en checkins_log.
fastify.post('/api/tickets/checkin', { preHandler: requireAdmin }, async (req, reply) => {
  const { token, code, puerta, staff_nombre } = req.body || {};
  const persona = await buscarPorTicket({ token, code });
  if (!persona) {
    return reply.status(404).send({ success: false, error: 'Ticket inválido' });
  }

  const yaHabiaIngresado = persona.estado === 'checkin';
  const ahora = new Date().toISOString();

  const actualizada = await store.updateAttendee(persona.id, {
    estado: 'checkin',
    checkin_count: (persona.checkin_count || 0) + 1,
    ultimo_checkin: ahora
  });

  const registro = await store.createCheckin(
    persona.id,
    String(puerta || 'Puerta Principal').slice(0, 80),
    String(staff_nombre || 'Staff').slice(0, 100),
    yaHabiaIngresado ? 'duplicado' : 'exitoso'
  );

  return {
    success: true,
    isDuplicate: yaHabiaIngresado,
    message: yaHabiaIngresado ? '⚠ Advertencia: Ingreso previo registrado.' : '✓ Acceso concedido.',
    attendee: publicAttendee(actualizada),
    checkin: registro
  };
});

// Punto de Ayuda: ubicar a una persona por su documento. Exige token de staff
// y devuelve la ficha sin hash de contrasena.
fastify.post('/api/soporte/buscar', {
  preHandler: [requireAdmin, rateLimit(60, 60000)]
}, async (req, reply) => {
  const dni = auth.normalizeDni((req.body || {}).dni);
  if (!dni) return reply.status(400).send({ error: 'Documento inválido.' });

  const persona = await store.findByDni(eventoId, dni);
  if (!persona) {
    return reply.status(404).send({ error: 'No hay ningún registro con ese documento.' });
  }
  return { success: true, attendee: safeAttendee(persona) };
});


// Texto exacto de la casilla de consentimiento de la landing. Se guarda junto
// al lead: si mañana cambia la redaccion, hay que poder demostrar cual acepto
// cada persona.
const TEXTO_CONSENTIMIENTO_LEAD =
  'Autorizo a ITERA a tratar mis datos (nombre, empresa y correo) para responder ' +
  'a esta solicitud de diagnostico y contactarme al respecto.';

// Captacion de leads de la landing. Escribe en `leads_diagnostico`.
//
// Este endpoint mentia dos veces: `query()` se tragaba el error de base de
// datos devolviendo filas vacias, y el `catch` respondia 200 con
// `success: true, simulated: true`. Es decir, la persona veia "Solicitud
// recibida" aunque el lead no se hubiera guardado en ningun sitio. Ahora un
// fallo de escritura devuelve 503 y el front lo dice.
fastify.post('/api/leads', { preHandler: rateLimit(15, 60000) }, async (request, reply) => {
  const b = request.body || {};

  const recorta = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
  const nombre = recorta(b.nombre, 120);
  const empresa = recorta(b.empresa, 150);
  const email = recorta(b.email, 150);

  if (!nombre || !email || !empresa) {
    return reply.status(400).send({ error: 'Nombre, email y empresa son requeridos' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply.status(400).send({ error: 'El correo electrónico no es válido' });
  }

  // Ley 29733: sin consentimiento expreso no se almacena el dato.
  if (b.consentimiento !== true) {
    return reply.status(400).send({
      error: 'Falta la autorización para tratar los datos personales.'
    });
  }

  if (!pool) {
    // Sin base de datos no hay dónde guardar el lead. Decirlo es preferible a
    // aceptar un contacto comercial que nadie va a recibir.
    request.log.error('lead recibido sin DATABASE_URL configurada');
    return reply.status(503).send({
      error: 'No pudimos registrar tu solicitud en este momento. Escríbenos a hola@iteraperu.pe.'
    });
  }

  try {
    const res = await pool.query(
      `INSERT INTO leads_diagnostico
         (nombre, empresa, cargo, email, telefono, tamano_empresa, desafio,
          horas_semanales_perdidas, ahorro_estimado_usd, mensaje, origen,
          consentimiento, consentimiento_at, consentimiento_texto)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,NOW(),$12)
       RETURNING id, created_at`,
      [
        nombre,
        empresa,
        recorta(b.cargo, 100),
        email,
        recorta(b.telefono, 50),
        recorta(b.tamano_empresa, 50),
        recorta(b.desafio, 100),
        Number(b.horas_semanales_perdidas) || 0,
        Number(b.ahorro_estimado_usd) || 0,
        recorta(b.mensaje, 2000),
        recorta(b.origen, 50) || 'web_itera',
        TEXTO_CONSENTIMIENTO_LEAD
      ]
    );
    // No se registra el contenido del lead: lleva nombre y correo (checklist 2).
    request.log.info({ leadId: res.rows[0].id }, 'lead de diagnostico registrado');
    return reply.status(201).send({ success: true, lead: res.rows[0] });
  } catch (err) {
    request.log.error({ err: err.message }, 'fallo al guardar el lead de diagnostico');
    return reply.status(503).send({
      error: 'No pudimos registrar tu solicitud en este momento. Escríbenos a hola@iteraperu.pe.'
    });
  }
});

// -----------------------------------------------------------------------------
// Rutas de Páginas & Roles Directos
// -----------------------------------------------------------------------------
fastify.get('/brand', async (req, reply) => reply.sendFile('brand-deck.html'));

// -----------------------------------------------------------------------------
// App real de Country Fest
// -----------------------------------------------------------------------------
// Las rutas llevan el slug del evento para que la plataforma pueda alojar mas
// de uno sin cambiar de forma. Hoy solo hay uno activo, asi que el slug se
// valida contra el configurado y cualquier otro devuelve 404: es preferible un
// 404 claro a servir la app de un evento que no existe.
function appDeEvento(archivo) {
  return async (req, reply) => {
    if (req.params.slug !== evento.slug) {
      return reply.code(404).send({ error: 'Evento no encontrado.' });
    }
    return reply.sendFile('cf/' + archivo);
  };
}

fastify.get('/e/:slug', appDeEvento('asistente.html'));       // asistente
fastify.get('/staff/:slug', appDeEvento('staff.html'));       // Punto de Ayuda
fastify.get('/negocios/:slug', appDeEvento('negocio.html'));  // puesto participante
fastify.get('/consola/:slug', appDeEvento('consola.html'));   // organizador

// Atajos sin slug, para carteles y enlaces cortos.
fastify.get('/e', async (req, reply) => reply.redirect(302, '/e/' + evento.slug));
fastify.get('/entrada', async (req, reply) => reply.redirect(302, '/e/' + evento.slug));

// Demo comercial: datos ficticios, autonoma, sin tocar la base real.
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
  // La base se prepara ANTES de aceptar trafico. Si el esquema no se puede
  // aplicar, NO se tumba el proceso: la landing comercial no tiene por que
  // caerse por un problema de base de datos. Lo que se hace es marcar el
  // arranque como degradado; la guardia de arriba devuelve 503 en todo lo que
  // dependa de la base, y /api/health lo reporta.
  try {
    await iniciarStore();
  } catch (err) {
    errorDeArranque = err && err.message ? err.message : 'error desconocido';
    console.error('[ARRANQUE] No se pudo preparar la base de datos:', errorDeArranque);
    console.error('[ARRANQUE] La plataforma de eventos queda DESHABILITADA (503). La landing sigue activa.');
  }

  try {
    // Las rutas de autenticacion necesitan el id del evento, que solo se conoce
    // despues de iniciar el store. Si el arranque fallo no se registran: la
    // guardia ya devuelve 503 antes de llegar aqui.
    if (!errorDeArranque) {
      const { requireSession } = registrarAuth(fastify, { store, eventoId, rateLimit, requireAdmin });
      registrarInsignias(fastify, {
        store, eventoId, rateLimit, requireAdmin, requireSession,
        exigirIngreso: EXIGIR_INGRESO_PARA_ESCANEAR
      });
      registrarEmpresa(fastify, { store, eventoId, rateLimit, requireAdmin });
    }

    const port = Number(process.env.PORT) || 3000;
    const address = await fastify.listen({ port, host: '0.0.0.0' });

    if (errorDeArranque) {
      console.warn(`[ITERA Engine] Servidor en ${address} · MODO DEGRADADO (sin base de datos)`);
    } else {
      console.log(`[ITERA Engine] Servidor en ${address} · evento "${evento.nombre}" · almacen ${store.name}`);
    }
  } catch (err) {
    // Aqui si es fatal: no se pudo abrir el puerto.
    console.error('[Error de arranque]:', err);
    process.exit(1);
  }
};
start();
