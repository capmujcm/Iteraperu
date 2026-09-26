const path = require('path');
const { Pool } = require('pg');

const { pgDriver, memoryDriver, safeAttendee, publicAttendee, auth } = require('./lib/store');
const registrarAuth = require('./lib/routes-auth');
const registrarInsignias = require('./lib/routes-insignias');
const registrarEmpresa = require('./lib/routes-empresa');
const registrarStaff = require('./lib/routes-staff');
const registrarSorteo = require('./lib/routes-sorteo');
const registrarPrueba = require('./lib/routes-prueba');
const registrarImportacion = require('./lib/routes-importar');

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
  lugar: process.env.EVENT_PLACE || 'La Villa Country Club, Ilo',
  // Aforo confirmado por la organizacion: 4000 personas. Se puede ajustar con
  // EVENT_AFORO; el valor se vuelve a aplicar en cada arranque (ver store.init).
  aforo_max: Number(process.env.EVENT_AFORO) || 4000
};

// Zona horaria del evento. Railway y PostgreSQL corren en UTC; sin esto la
// curva de ingresos por hora mostraba las 5 de la tarde como las 22:00 y las
// perdia fuera del rango.
const ZONA_HORARIA = process.env.EVENT_TZ || 'America/Lima';

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
// Primer organizador
// -----------------------------------------------------------------------------
// Sin esto, la unica forma de entrar la primera vez era el token de emergencia,
// que resultaba confuso: hay que pegarlo en un desplegable escondido antes de
// poder crear a nadie. Con estas variables la cuenta existe desde el primer
// arranque y se entra como en cualquier sitio: usuario y contrasena.
//
// La contrasena NO va en el codigo: el repositorio termina en GitHub y una
// contrasena ahi es una contrasena filtrada.
const ADMIN_USUARIO = (process.env.ADMIN_USUARIO || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

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
      // Tres conexiones eran pocas para el dia del evento: cada peticion hace
      // entre dos y cuatro consultas (sesion, persona, operacion), asi que con
      // tres puertas validando ingresos y gente escaneando puestos dentro, la
      // cuarta peticion simultanea se quedaba esperando turno. Se ve desde
      // fuera como "la app se queda cargando". Railway admite bastante mas.
      max: Number(process.env.DB_POOL_MAX) || 12,
      idleTimeoutMillis: 30000,
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

  await asegurarOrganizador();

  if (SEED_DEMO) {
    await sembrarDemo();
  }
}

// Crea el primer organizador si no existe. Es idempotente y NUNCA pisa una
// cuenta ya creada: si mañana alguien cambia ADMIN_PASSWORD en Railway, no se
// le reescribe la contraseña por la espalda a quien ya está usando la cuenta.
// Para cambiarla se usa la pantalla de cambio de contraseña, o se repone desde
// la gestión de usuarios.
async function asegurarOrganizador() {
  if (!ADMIN_USUARIO || !ADMIN_PASSWORD) {
    console.warn(
      '[STAFF] Sin ADMIN_USUARIO/ADMIN_PASSWORD no hay cuenta inicial. ' +
      'La primera entrada tendrá que hacerse con el token de emergencia.'
    );
    return;
  }

  const usuario = ADMIN_USUARIO.toLowerCase();

  const existente = await store.findUsuarioStaff(eventoId, usuario);
  if (existente) return;

  if (ADMIN_PASSWORD.length < 6) {
    console.error('[STAFF] ADMIN_PASSWORD es demasiado corta (mínimo 6). No se creó la cuenta inicial.');
    return;
  }
  if (ADMIN_PASSWORD.length < 12) {
    // Se crea igualmente: es una decisión del operador. Pero queda dicho.
    console.warn(
      '[STAFF] ADMIN_PASSWORD es corta para una cuenta que puede exportar ' +
      'datos personales. Conviene cambiarla desde la app tras el primer ingreso.'
    );
  }

  const { hash, salt, algo } = await auth.hashPassword(ADMIN_PASSWORD);
  await store.createUsuarioStaff({
    evento_id: eventoId,
    usuario,
    nombre: process.env.ADMIN_NOMBRE || 'Organización',
    rol: 'organizador',
    password_hash: hash,
    password_salt: salt,
    password_algo: algo,
    password_updated_at: new Date().toISOString(),
    // La eligió el operador, así que no se le obliga a cambiarla al entrar.
    must_change_password: false,
    temp_password_expires_at: null,
    creado_por: 'arranque del servidor'
  });

  // Nunca se registra la contraseña, solo el hecho.
  console.warn(`[STAFF] Cuenta de organizador "${usuario}" creada en el arranque.`);
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
  const { hash, salt, algo } = await auth.hashPassword(auth.TEMP_PASSWORD);

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

// Comprobación del token de emergencia, en tiempo constante.
function adminTokenValido(valor) {
  return AUTH_ENABLED && safeEqual(valor, ADMIN_TOKEN);
}

// Guardias por rol. Las rutas se registran al cargar el módulo, pero las
// guardias solo existen después de iniciar el store (necesitan el id del
// evento). Estos envoltorios se resuelven en el momento de la petición, no en
// el del registro.
let _requireStaff = null;
let _requireOrganizador = null;
let registrarAccion = async () => {};

async function requireStaff(req, reply) {
  if (!_requireStaff) {
    reply.code(503).send({ error: 'El servicio todavía está arrancando.' });
    return reply;
  }
  return _requireStaff(req, reply);
}

async function requireOrganizador(req, reply) {
  if (!_requireOrganizador) {
    reply.code(503).send({ error: 'El servicio todavía está arrancando.' });
    return reply;
  }
  return _requireOrganizador(req, reply);
}

// preHandler heredado: solo token de emergencia. Se mantiene para los endpoints
// que aún no distinguen rol; los demás usan requireStaff / requireOrganizador.
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

// Limitador de tasa en memoria (ventana fija) — frena fuerza bruta y
// enumeración de DNIs/códigos sin añadir dependencias.
//
// OJO con la clave: por defecto es la IP, pero en el recinto cientos de
// celulares llegan con la MISMA direccion (los operadores peruanos usan NAT
// masivo, y el wifi del local tambien). Un tope bajo por IP bloquearia a gente
// legitima en masa el dia del evento. Por eso:
//   * los limites por IP de los endpoints publicos son generosos, y la fuerza
//     bruta sobre una cuenta la frena el bloqueo por DNI/usuario (8 intentos);
//   * lo que se limita por persona (escaneos) usa una clave propia via `keyFn`.
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

// Clave de limitacion para los endpoints que YA pasaron por una guardia de
// staff. Contar por IP ahi no sirve: todo el equipo trabaja desde el mismo
// wifi del local, asi que un tope "por IP" es en realidad un tope para el
// equipo entero, y cuando una puerta lo agota las demas reciben 429 sin haber
// hecho nada. `req.actor` lo deja la guardia, asi que no lo controla el
// cliente. El token de emergencia cuenta como un actor mas.
const porActor = req => 'staff:' + ((req.actor && req.actor.id) || 'token');

// Cada limitador cuenta APARTE. Antes todos compartian un solo contador por IP
// (o por actor) y cada ruta lo comparaba con su propio tope: en el wifi del
// local, los ingresos de los asistentes sumaban al mismo contador y el cambio
// de clave de un puesto (tope 10) o el boton de sortear (tope 30) respondian
// 429 sin que nadie los hubiera usado. Cada llamada a rateLimit() es una ruta,
// asi que un numero propio por llamada basta para separarlos.
let limitadores = 0;

function rateLimit(max, windowMs, keyFn) {
  const id = ++limitadores;
  return async (req, reply) => {
    const base = keyFn ? keyFn(req) : ('ip:' + clientIp(req));
    if (!base) return;
    const clave = id + '|' + base;
    const now = Date.now();
    let b = rateBuckets.get(clave);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(clave, b); }
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
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
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
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
  // Las tipografías del festival vienen de Fontshare y Google Fonts.
  "style-src 'self' 'unsafe-inline' https://api.fontshare.com https://fonts.googleapis.com",
  "font-src 'self' https://api.fontshare.com https://cdn.fontshare.com https://fonts.gstatic.com",
  // data: y blob: porque el QR se dibuja en un <canvas> y los logos se
  // previsualizan desde el archivo antes de subirlos. Unsplash para imágenes demo.
  "img-src 'self' data: blob: https://images.unsplash.com",
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
                      url.startsWith('/sorteo/') ||
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
fastify.get('/api/events/analytics', { preHandler: requireOrganizador }, async () => {
  const conteo = await store.countAttendees(eventoId);
  const porTipoFilas = await store.countByTipo(eventoId);
  // Solo el dia de hoy (hora de Lima): el evento dura dos dias y mezclar las
  // horas de ambos en una sola curva no dice nada.
  const timeline = await store.checkinTimeline(eventoId, ZONA_HORARIA);
  const insignias = await store.contarInsignias(eventoId);

  const aforoMax = evento.aforo_max || 4000;
  const porTipo = porTipoFilas.reduce((acc, f) => {
    acc[f.tipo_ticket || 'general'] = f.n;
    return acc;
  }, {});

  // Acumulado por hora. El rango sale de los datos -desde la primera hora con
  // ingresos hasta la ultima- en vez de una franja fija de 8 a 18 que dejaba
  // fuera la tarde y la noche, que es cuando mas gente entra a una feria.
  const mapa = timeline.reduce((acc, f) => { acc[f.hora] = f.ingresos; return acc; }, {});
  const conDatos = Object.keys(mapa).map(h => parseInt(h, 10)).filter(n => !isNaN(n));
  const timelineHoras = [];
  if (conDatos.length) {
    const desde = Math.min(...conDatos);
    const hasta = Math.max(...conDatos);
    let acumulado = 0;
    for (let h = desde; h <= hasta; h++) {
      const hora = String(h).padStart(2, '0') + ':00';
      acumulado += mapa[hora] || 0;
      timelineHoras.push({ hora, ingresos: acumulado });
    }
  }

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
fastify.get('/api/attendees', { preHandler: requireOrganizador }, async (req) => {
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
fastify.get('/api/export/:que', { preHandler: requireOrganizador }, async (req, reply) => {
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
fastify.get('/api/checkins', { preHandler: requireStaff }, async (req) => {
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

// Nota: aqui existia POST /api/tickets/verify, publico y sin uso en ninguna
// pantalla. Devolvia nombre y apellido a partir del codigo de entrada, y los
// codigos son correlativos (CF-1000, CF-1001...), asi que permitia recorrerlos
// y sacar la lista de asistentes. Se retiro (checklist puntos 2 y 9). La
// puerta usa /api/tickets/checkin, que exige sesion de staff.

// Check-in: escribe en la base y deja rastro en checkins_log.
fastify.post('/api/tickets/checkin', { preHandler: requireStaff }, async (req, reply) => {
  const { token, code, puerta } = req.body || {};
  const persona = await buscarPorTicket({ token, code });
  if (!persona) {
    return reply.status(404).send({ success: false, error: 'Ticket inválido' });
  }

  // El autor sale de la sesión, no del cuerpo de la petición. Antes el staff
  // escribía su nombre a mano: quedaba registrado, pero cualquiera podía poner
  // el de otro. Ahora es el usuario que inició sesión.
  const autor = (req.actor && req.actor.nombre) || 'Staff';

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
    autor,
    yaHabiaIngresado ? 'duplicado' : 'exitoso'
  );

  // El aforo viaja con cada validacion. La consola ya lo muestra, pero quien
  // decide si se para la cola esta en la puerta, no mirando una laptop. No se
  // bloquea el ingreso al llegar al tope: eso lo decide una persona, no un if.
  const conteo = await store.countAttendees(eventoId);

  return {
    success: true,
    isDuplicate: yaHabiaIngresado,
    message: yaHabiaIngresado ? '⚠ Advertencia: Ingreso previo registrado.' : '✓ Acceso concedido.',
    attendee: publicAttendee(actualizada),
    checkin: registro,
    aforo: { dentro: conteo.ingresados, max: evento.aforo_max || 4000 }
  };
});

// Punto de Ayuda: ubicar a una persona por su documento. Exige token de staff
// y devuelve la ficha sin hash de contrasena.
fastify.post('/api/soporte/buscar', {
  preHandler: [requireStaff, rateLimit(60, 60000, porActor)]
}, async (req, reply) => {
  const dni = auth.normalizeDni((req.body || {}).dni);
  if (!dni) return reply.status(400).send({ error: 'Documento inválido.' });

  const persona = await store.findByDni(eventoId, dni);
  if (!persona) {
    return reply.status(404).send({ error: 'No hay ningún registro con ese documento.' });
  }
  return { success: true, attendee: safeAttendee(persona) };
});

// -----------------------------------------------------------------------------
// Segundo dia: reiniciar los ingresos
// -----------------------------------------------------------------------------
// El evento dura dos dias (26 y 27). Cada dia hay que volver a validar en
// puerta: si no, quien entro el sabado aparece como "dentro" el domingo sin
// haber venido, el aforo miente y ademas podria escanear puestos desde su casa
// (la insignia exige ingreso validado).
//
// Que hace: pone a todos los que estaban en 'checkin' de vuelta en 'valido'.
// Que NO hace: no toca checkins_log (append-only, los ingresos del dia 1 se
// conservan), ni las insignias, ni las cuentas. Es reversible en la practica:
// la gente vuelve a pasar por la puerta.
//
// Solo organizador, con confirmacion explicita en el cuerpo para que un clic
// accidental no vacie el recinto en plena tarde.
fastify.post('/api/soporte/reiniciar-ingresos', {
  preHandler: [requireOrganizador, rateLimit(5, 60000)]
}, async (req, reply) => {
  const b = req.body || {};
  if (b.confirmar !== 'REINICIAR') {
    return reply.code(400).send({
      error: 'Falta la confirmación. Envía { "confirmar": "REINICIAR" }.'
    });
  }
  const reiniciados = await store.reiniciarIngresos(eventoId);
  await registrarAccion(req, 'reiniciar_ingresos', `${reiniciados} persona(s) vuelven a "pendiente de ingreso"`);
  req.log.warn({ reiniciados }, 'ingresos reiniciados para un nuevo dia');
  return { success: true, reiniciados };
});

// -----------------------------------------------------------------------------
// Deshacer el reinicio de ingresos
// -----------------------------------------------------------------------------
// El reinicio es la operacion mas destructiva que tiene la consola: un clic a
// destiempo deja a miles de personas como "pendientes de ingreso", con el aforo
// a cero y sin poder escanear puestos, y la unica salida era que todas
// volvieran a pasar por la puerta.
//
// Esto lo revierte con lo que ya esta registrado: vuelve a "dentro" quien tenga
// un ingreso exitoso de HOY en checkins_log. No inventa a nadie, y checkins_log
// no se toca (punto 11: solo se lee).
fastify.post('/api/soporte/deshacer-reinicio', {
  preHandler: [requireOrganizador, rateLimit(5, 60000)]
}, async (req, reply) => {
  const b = req.body || {};
  if (b.confirmar !== 'DESHACER') {
    return reply.code(400).send({
      error: 'Falta la confirmación. Envía { "confirmar": "DESHACER" }.'
    });
  }
  const recuperados = await store.deshacerReinicio(eventoId, ZONA_HORARIA);
  await registrarAccion(req, 'deshacer_reinicio', `${recuperados} persona(s) vuelven a "dentro"`);
  req.log.warn({ recuperados }, 'reinicio de ingresos deshecho');
  return { success: true, recuperados };
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

// Guia del puesto participante. Publica y sin sesion a proposito: es el enlace
// que llega por WhatsApp junto con las credenciales, y pedir login para leer
// como se hace login no tendria sentido. No contiene datos de ningun puesto.
// La ruta es corta porque se manda por chat y se dicta por telefono.
fastify.get('/guia', async (req, reply) => reply.sendFile('guia-puesto.html'));
fastify.get('/guia-puesto', async (req, reply) => reply.redirect(302, '/guia'));

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
fastify.get('/sorteo/:slug', appDeEvento('sorteo.html'));     // pantalla de proyección

// Atajos sin slug, para carteles y enlaces cortos.
fastify.get('/e', async (req, reply) => reply.redirect(302, '/e/' + evento.slug));
fastify.get('/entrada', async (req, reply) => reply.redirect(302, '/e/' + evento.slug));

// Demo comercial: datos ficticios, autonoma, sin tocar la base real. Solo se
// llega a ella por /evento, a proposito.
fastify.get('/evento', async (req, reply) => reply.sendFile('evento/prototipo.html'));

// Atajos por rol. Antes servian el prototipo de venta: quien tecleaba
// iteraperu.pe/staff el dia del evento caia en la demo con datos ficticios.
// Ahora llevan a la app real del rol que corresponde.
const irA = (ruta) => async (req, reply) => reply.redirect(302, ruta + '/' + evento.slug);
fastify.get('/asistente', irA('/e'));
fastify.get('/persona', irA('/e'));
fastify.get('/empresa', irA('/negocios'));
fastify.get('/proveedor', irA('/negocios'));
fastify.get('/organizador', irA('/consola'));
fastify.get('/staff', irA('/staff'));
fastify.get('/ayuda', irA('/staff'));

// Sunrise Hotel Ilo — Plataforma Web, Presentación y Centro de Mando
fastify.get('/sunrise', async (req, reply) => reply.redirect(302, '/sunrise/'));
fastify.get('/hotel', async (req, reply) => reply.redirect(302, '/sunrise/'));
fastify.get('/sunrise-hotel', async (req, reply) => reply.redirect(302, '/sunrise/'));
fastify.get('/sunrise/', async (req, reply) => reply.sendFile('sunrise/index.html'));
fastify.get('/sunrise/presentacion', async (req, reply) => reply.sendFile('sunrise/presentacion.html'));
fastify.get('/sunrise/portal', async (req, reply) => reply.sendFile('sunrise/portal.html'));

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
      // Las cuentas de staff se registran primero: el resto de módulos usa sus
      // guardias por rol.
      const staff = registrarStaff(fastify, {
        store, eventoId, rateLimit,
        adminTokenValido,
        authEnabled: () => AUTH_ENABLED
      });
      _requireStaff = staff.requireStaff();
      _requireOrganizador = staff.requireOrganizador();
      registrarAccion = staff.registrar;

      // Cada módulo recibe la guardia que le corresponde:
      //   requireStaff        -> acciones de puerta
      //   requireOrganizador  -> puestos, exportaciones y datos del evento
      const { requireSession } = registrarAuth(fastify, {
        store, eventoId, rateLimit, porActor,
        requireAdmin: requireStaff,        // reset y registro rápido: puerta
        registrarAccion
      });
      registrarInsignias(fastify, {
        store, eventoId, rateLimit, porActor,
        requireAdmin: requireOrganizador,  // alta y edicion de puestos y sus QR
        requireSession,
        exigirIngreso: EXIGIR_INGRESO_PARA_ESCANEAR,
        registrarAccion
      });
      registrarEmpresa(fastify, {
        store, eventoId, rateLimit, porActor,
        requireAdmin: requireOrganizador,  // reponer el acceso de un puesto
        zonaHoraria: ZONA_HORARIA
      });
      registrarSorteo(fastify, {
        store, eventoId, rateLimit, porActor, requireOrganizador, registrarAccion
      });
      registrarPrueba(fastify, {
        store, eventoId, rateLimit, porActor, requireOrganizador, registrarAccion
      });
      registrarImportacion(fastify, {
        store, eventoId, rateLimit, porActor, requireOrganizador, registrarAccion
      });
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
