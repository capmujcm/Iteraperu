'use strict';
// -----------------------------------------------------------------------------
// Rutas de autenticacion del asistente
// -----------------------------------------------------------------------------
// Regla de negocio (decidida el 2026-09-06):
//
//   * La persona entra con su DNI y una contrasena que elige ella misma.
//   * La sesion se mantiene en el mismo dispositivo mediante un token opaco.
//   * Soporte (Punto de Ayuda, con token de staff) puede restablecerla a la
//     contrasena temporal CF2026. Esa temporal CADUCA a los 30 minutos y
//     obliga a definir una nueva en el primer ingreso.
//
// El modelo anterior era un enlace de un solo uso al celular/WhatsApp, que
// dejaba fuera a quien registrara mal su numero.
const { safeAttendee, auth } = require('./store');

// Mensaje unico para cualquier fallo de credenciales: no revela si el DNI
// existe, si la contrasena era la incorrecta o si la temporal caduco.
const CREDENCIALES_INVALIDAS =
  'DNI o contrasena incorrectos. Si soporte te restablecio la clave hace mas ' +
  'de 30 minutos, pidela de nuevo en el Punto de Ayuda.';

// Limites de longitud para todo lo que llega en el body. Se validan aqui y no
// solo en el front (checklist punto 6).
const LIMITES = {
  nombre: 120, apellido: 120, email: 150, celular: 30,
  empresa: 150, cargo: 100, staff_nombre: 100, punto_ayuda: 80, device_id: 60
};

// Texto exacto que acepta la persona al registrarse. Se guarda junto al
// registro: si manana cambia la redaccion, hay que poder demostrar cual acepto
// cada quien.
const TEXTO_CONSENTIMIENTO =
  'Acepto el tratamiento de mis datos (nombre, documento, celular y correo) ' +
  'para acreditacion e ingreso al evento. Responsable: la empresa organizadora. ' +
  'Encargado del tratamiento: itera. Plazo: hasta 12 meses despues del evento.';

// Version que registra el staff cuando crea la ficha en puerta con el documento
// de la persona delante. Se distingue de la web a proposito: el consentimiento
// fue verbal y presencial, no un clic.
const TEXTO_CONSENTIMIENTO_PUERTA =
  'Consentimiento verbal recogido en el Punto de Ayuda, con documento fisico ' +
  'verificado por el staff, para acreditacion e ingreso al evento.';

function texto(valor, maxLen) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== 'string') return null;
  const t = valor.trim();
  if (!t) return null;
  return t.slice(0, maxLen);
}

module.exports = function registrarAuth(fastify, { store, eventoId, rateLimit, requireAdmin }) {
  // ---------------------------------------------------------------------------
  // Guardia de sesion
  // ---------------------------------------------------------------------------
  // Devuelve un preHandler. Con `allowMustChange` se permite el paso aunque la
  // persona tenga un cambio de contrasena pendiente; se usa solo en el propio
  // endpoint de cambio de contrasena.
  function requireSession({ allowMustChange = false } = {}) {
    return async (req, reply) => {
      const header = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
      if (!header) {
        reply.code(401).send({ error: 'Sesion no iniciada.' });
        return reply;
      }
      const sesion = await store.findSession(auth.sha256(header));
      if (!sesion) {
        reply.code(401).send({ error: 'Tu sesion expiro. Vuelve a ingresar con tu DNI.' });
        return reply;
      }
      const persona = await store.findById(sesion.ticket_id);
      if (!persona) {
        reply.code(401).send({ error: 'Sesion no valida.' });
        return reply;
      }
      if (persona.must_change_password && !allowMustChange) {
        reply.code(403).send({
          error: 'Debes definir una contrasena nueva antes de continuar.',
          must_change_password: true
        });
        return reply;
      }
      // Se cuelgan en la request para que el handler no repita la consulta.
      req.sesion = sesion;
      req.persona = persona;
      req.sessionTokenHash = sesion.token_hash;
      await store.touchSession(sesion.id);
    };
  }

  // ---------------------------------------------------------------------------
  // Alta: DNI + contrasena elegida por la persona
  // ---------------------------------------------------------------------------
  fastify.post('/api/auth/register', { preHandler: rateLimit(10, 60000) }, async (req, reply) => {
    const body = req.body || {};

    const dni = auth.normalizeDni(body.dni);
    if (!dni) {
      return reply.code(400).send({ error: 'Documento invalido. Revisa el numero e intenta de nuevo.' });
    }

    const nombre = texto(body.nombre, LIMITES.nombre);
    if (!nombre) return reply.code(400).send({ error: 'El nombre es obligatorio.' });

    const pass = auth.validatePassword(body.password);
    if (!pass.ok) return reply.code(400).send({ error: pass.error });

    // Ley 29733: el consentimiento es previo, informado y expreso. Sin el no se
    // crea el registro.
    if (body.acepta_privacidad !== true) {
      return reply.code(400).send({
        error: 'Debes aceptar la politica de privacidad para registrarte.'
      });
    }

    const existente = await store.findByDni(eventoId, dni);
    if (existente) {
      // Se confirma la existencia del documento a proposito: sin esto la
      // persona no entiende por que no puede registrarse y termina en la cola
      // del Punto de Ayuda. El endpoint esta limitado a 10 intentos/minuto.
      return reply.code(409).send({
        error: 'Ya existe un registro con ese documento. Ingresa con tu contrasena.',
        ya_registrado: true
      });
    }

    const { hash, salt, algo } = auth.hashPassword(pass.value);
    const ahora = new Date().toISOString();

    const datos = {
      evento_id: eventoId,
      qr_token: auth.newQrToken(),
      dni,
      nombre,
      apellido: texto(body.apellido, LIMITES.apellido),
      email: texto(body.email, LIMITES.email),
      celular: texto(body.celular, LIMITES.celular),
      empresa: texto(body.empresa, LIMITES.empresa),
      cargo: texto(body.cargo, LIMITES.cargo),
      tipo_ticket: 'general',
      estado: 'valido',
      password_hash: hash,
      password_salt: salt,
      password_algo: algo,
      password_updated_at: ahora,
      must_change_password: false,
      temp_password_expires_at: null,
      // Prueba del consentimiento (Ley 29733): no basta con validarlo, hay que
      // poder demostrar que se dio, cuando y sobre que texto.
      consentimiento: true,
      consentimiento_at: ahora,
      consentimiento_texto: TEXTO_CONSENTIMIENTO,
      consentimiento_via: 'web',
      acepta_marketing: body.acepta_marketing === true,
      origen: 'web'
    };

    let persona = null;
    let ultimoError = null;

    // Dos altas simultaneas pueden pedir el mismo codigo de ticket. Se
    // reintenta con el siguiente numero en vez de fallar el registro.
    for (let intento = 0; intento < 5 && !persona; intento++) {
      try {
        persona = await store.createAttendee(
          Object.assign({ codigo_ticket: await siguienteCodigo() }, datos)
        );
      } catch (err) {
        ultimoError = err;
        if (!err || err.code !== '23505') throw err;
        // Colision del documento: la persona ya existe y debe ingresar.
        if (String(err.constraint || '').includes('dni')) {
          return reply.code(409).send({
            error: 'Ya existe un registro con ese documento. Ingresa con tu contrasena.',
            ya_registrado: true
          });
        }
        // Colision del codigo de ticket: se reintenta.
      }
    }

    if (!persona) {
      req.log && req.log.error({ err: ultimoError }, 'no se pudo emitir el codigo de ticket');
      return reply.code(503).send({
        error: 'No pudimos emitir tu ticket en este momento. Intenta de nuevo en unos segundos.'
      });
    }

    const sesion = await abrirSesion(persona.id, texto(body.device_id, LIMITES.device_id));
    return reply.code(201).send({
      success: true,
      token: sesion.token,
      expira: sesion.expiraISO,
      attendee: safeAttendee(persona)
    });
  });

  // ---------------------------------------------------------------------------
  // Ingreso
  // ---------------------------------------------------------------------------
  fastify.post('/api/auth/login', { preHandler: rateLimit(15, 60000) }, async (req, reply) => {
    const body = req.body || {};
    const dni = auth.normalizeDni(body.dni);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!dni || !password) {
      return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });
    }

    const persona = await store.findByDni(eventoId, dni);
    if (!persona) {
      return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });
    }

    // Bloqueo temporal tras varios fallos sobre el mismo documento. Frena la
    // fuerza bruta aunque el atacante rote de IP.
    if (persona.locked_until && new Date(persona.locked_until).getTime() > Date.now()) {
      const min = Math.max(1, Math.ceil((new Date(persona.locked_until).getTime() - Date.now()) / 60000));
      return reply.code(429).send({
        error: `Demasiados intentos fallidos. Vuelve a intentar en ${min} minuto(s) o acercate al Punto de Ayuda.`
      });
    }

    // Registro creado por staff en puerta que aun no tiene contrasena.
    if (!persona.password_hash) {
      return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });
    }

    // Si la temporal de soporte caduco, se anula el acceso: CF2026 deja de
    // funcionar y la persona debe volver al Punto de Ayuda.
    const temporalCaducada = persona.must_change_password &&
      persona.temp_password_expires_at &&
      new Date(persona.temp_password_expires_at).getTime() <= Date.now();

    if (temporalCaducada) {
      await store.updateAttendee(persona.id, {
        password_hash: null,
        password_salt: null,
        temp_password_expires_at: null
      });
      return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });
    }

    if (!auth.verifyPassword(password, persona.password_hash, persona.password_salt)) {
      const fallos = (persona.failed_login_count || 0) + 1;
      const patch = { failed_login_count: fallos };
      if (fallos >= auth.MAX_FAILED_LOGINS) {
        patch.locked_until = new Date(Date.now() + auth.LOCK_MS).toISOString();
        patch.failed_login_count = 0;
      }
      await store.updateAttendee(persona.id, patch);
      return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });
    }

    await store.updateAttendee(persona.id, { failed_login_count: 0, locked_until: null });

    const sesion = await abrirSesion(persona.id, texto(body.device_id, LIMITES.device_id));
    return reply.send({
      success: true,
      token: sesion.token,
      expira: sesion.expiraISO,
      // El front usa esta bandera para llevar directo a la pantalla de cambio.
      must_change_password: persona.must_change_password === true,
      attendee: safeAttendee(persona)
    });
  });

  // ---------------------------------------------------------------------------
  // Cambio de contrasena (voluntario o forzado tras un restablecimiento)
  // ---------------------------------------------------------------------------
  fastify.post('/api/auth/change-password', {
    preHandler: [rateLimit(10, 60000), requireSession({ allowMustChange: true })]
  }, async (req, reply) => {
    const body = req.body || {};
    const persona = req.persona;

    const actual = typeof body.password_actual === 'string' ? body.password_actual : '';
    if (!auth.verifyPassword(actual, persona.password_hash, persona.password_salt)) {
      return reply.code(401).send({ error: 'La contrasena actual no coincide.' });
    }

    const nueva = auth.validatePassword(body.password_nueva);
    if (!nueva.ok) return reply.code(400).send({ error: nueva.error });

    if (auth.verifyPassword(nueva.value, persona.password_hash, persona.password_salt)) {
      return reply.code(400).send({ error: 'La contrasena nueva debe ser distinta de la actual.' });
    }

    const { hash, salt, algo } = auth.hashPassword(nueva.value);
    const actualizada = await store.updateAttendee(persona.id, {
      password_hash: hash,
      password_salt: salt,
      password_algo: algo,
      password_updated_at: new Date().toISOString(),
      must_change_password: false,
      temp_password_expires_at: null,
      failed_login_count: 0,
      locked_until: null
    });

    // Se cierran las demas sesiones: si alguien habia entrado con la clave
    // anterior (o con la temporal CF2026), queda fuera al instante.
    await store.revokeAllSessions(persona.id, req.sessionTokenHash);

    return reply.send({ success: true, attendee: safeAttendee(actualizada) });
  });

  // ---------------------------------------------------------------------------
  // Sesion actual
  // ---------------------------------------------------------------------------
  fastify.get('/api/auth/me', { preHandler: requireSession() }, async (req) => {
    return { success: true, attendee: safeAttendee(req.persona) };
  });

  // ---------------------------------------------------------------------------
  // Cierre de sesion en este dispositivo
  // ---------------------------------------------------------------------------
  fastify.post('/api/auth/logout', {
    preHandler: requireSession({ allowMustChange: true })
  }, async (req) => {
    await store.revokeSession(req.sessionTokenHash);
    return { success: true };
  });

  // ---------------------------------------------------------------------------
  // Soporte: restablecer contrasena a la temporal CF2026
  // ---------------------------------------------------------------------------
  // Solo staff con token. CF2026 es un valor publico que se dicta en voz alta
  // en el Punto de Ayuda, asi que va SIEMPRE con caducidad de 30 minutos y
  // cambio obligatorio en el primer ingreso. Queda registrado quien lo hizo.
  fastify.post('/api/soporte/reset-password', {
    preHandler: [requireAdmin, rateLimit(60, 60000)]
  }, async (req, reply) => {
    const body = req.body || {};
    const dni = auth.normalizeDni(body.dni);
    if (!dni) return reply.code(400).send({ error: 'Documento invalido.' });

    const persona = await store.findByDni(eventoId, dni);
    if (!persona) {
      return reply.code(404).send({ error: 'No hay ningun registro con ese documento.' });
    }

    const { hash, salt, algo } = auth.hashPassword(auth.TEMP_PASSWORD);
    const expira = new Date(Date.now() + auth.TEMP_PASSWORD_TTL_MS).toISOString();

    await store.updateAttendee(persona.id, {
      password_hash: hash,
      password_salt: salt,
      password_algo: algo,
      password_updated_at: new Date().toISOString(),
      must_change_password: true,
      temp_password_expires_at: expira,
      failed_login_count: 0,
      locked_until: null
    });

    // Toda sesion previa se invalida: si el telefono quedo en manos de otra
    // persona, el restablecimiento la expulsa.
    await store.revokeAllSessions(persona.id, null);

    await store.logPasswordReset(
      persona.id,
      texto(body.staff_nombre, LIMITES.staff_nombre) || 'Staff',
      texto(body.punto_ayuda, LIMITES.punto_ayuda) || 'Punto de Ayuda'
    );

    return reply.send({
      success: true,
      password_temporal: auth.TEMP_PASSWORD,
      expira,
      minutos_validez: Math.round(auth.TEMP_PASSWORD_TTL_MS / 60000),
      // Solo el nombre: el staff necesita confirmar en voz alta que es la
      // persona correcta, no ver su correo ni su celular.
      persona: { nombre: persona.nombre, apellido: persona.apellido }
    });
  });

  // ---------------------------------------------------------------------------
  // Soporte: registro rapido en puerta
  // ---------------------------------------------------------------------------
  // Regla operativa del evento: nunca se bloquea el ingreso por un registro
  // incompleto. Se crea el minimo con el documento delante, se deja entrar, y
  // la persona completa sus datos despues.
  //
  // La ficha nace con la contrasena temporal CF2026 y cambio obligatorio, igual
  // que un restablecimiento: la persona la usa para tomar control de su cuenta
  // desde su propio celular.
  fastify.post('/api/soporte/registro-rapido', {
    preHandler: [requireAdmin, rateLimit(120, 60000)]
  }, async (req, reply) => {
    const body = req.body || {};

    const dni = auth.normalizeDni(body.dni);
    if (!dni) return reply.code(400).send({ error: 'Documento invalido.' });

    const nombre = texto(body.nombre, LIMITES.nombre);
    if (!nombre) return reply.code(400).send({ error: 'El nombre es obligatorio.' });

    // El staff debe confirmar que verifico el documento y recogio el
    // consentimiento verbal. Sin eso no se crea la ficha.
    if (body.consentimiento_verificado !== true) {
      return reply.code(400).send({
        error: 'Debes confirmar que verificaste el documento y explicaste el uso de los datos.'
      });
    }

    const existente = await store.findByDni(eventoId, dni);
    if (existente) {
      return reply.code(409).send({
        error: 'Ya existe un registro con ese documento.',
        ya_registrado: true,
        attendee: safeAttendee(existente)
      });
    }

    const { hash, salt, algo } = auth.hashPassword(auth.TEMP_PASSWORD);
    const ahora = new Date().toISOString();
    const staffNombre = texto(body.staff_nombre, LIMITES.staff_nombre) || 'Staff';

    const datos = {
      evento_id: eventoId,
      qr_token: auth.newQrToken(),
      dni,
      nombre,
      apellido: texto(body.apellido, LIMITES.apellido),
      celular: texto(body.celular, LIMITES.celular),
      email: texto(body.email, LIMITES.email),
      tipo_ticket: 'general',
      estado: 'valido',
      password_hash: hash,
      password_salt: salt,
      password_algo: algo,
      password_updated_at: ahora,
      must_change_password: true,
      temp_password_expires_at: new Date(Date.now() + auth.TEMP_PASSWORD_TTL_MS).toISOString(),
      consentimiento: true,
      consentimiento_at: ahora,
      consentimiento_texto: TEXTO_CONSENTIMIENTO_PUERTA,
      consentimiento_via: 'puerta',
      acepta_marketing: false,
      origen: 'staff',
      creado_por: staffNombre
    };

    let persona = null;
    for (let intento = 0; intento < 5 && !persona; intento++) {
      try {
        persona = await store.createAttendee(
          Object.assign({ codigo_ticket: await siguienteCodigo() }, datos)
        );
      } catch (err) {
        if (!err || err.code !== '23505') throw err;
        if (String(err.constraint || '').includes('dni')) {
          return reply.code(409).send({ error: 'Ya existe un registro con ese documento.', ya_registrado: true });
        }
      }
    }

    if (!persona) {
      return reply.code(503).send({ error: 'No pudimos emitir el ticket. Intenta de nuevo.' });
    }

    // Opcionalmente se valida el ingreso en el mismo gesto: la persona esta en
    // la puerta, no tiene sentido obligar al staff a buscarla otra vez.
    let checkin = null;
    if (body.validar_ingreso === true) {
      const actualizada = await store.updateAttendee(persona.id, {
        estado: 'checkin',
        checkin_count: 1,
        ultimo_checkin: new Date().toISOString()
      });
      checkin = await store.createCheckin(
        persona.id,
        texto(body.puerta, LIMITES.punto_ayuda) || 'Punto de Ayuda',
        staffNombre,
        'exitoso'
      );
      persona = actualizada;
    }

    return reply.code(201).send({
      success: true,
      attendee: safeAttendee(persona),
      password_temporal: auth.TEMP_PASSWORD,
      minutos_validez: Math.round(auth.TEMP_PASSWORD_TTL_MS / 60000),
      checkin
    });
  });

  // ---------------------------------------------------------------------------
  // Utilidades internas
  // ---------------------------------------------------------------------------
  async function abrirSesion(ticketId, deviceId) {
    const { token, tokenHash } = auth.newSessionToken();
    const expiraISO = new Date(Date.now() + auth.SESSION_TTL_MS).toISOString();
    await store.createSession(ticketId, tokenHash, deviceId, expiraISO);
    return { token, expiraISO };
  }

  // Codigo de ticket legible (CF-1000, CF-1001, ...). El contador arranca desde
  // el mayor codigo ya emitido, para que un reinicio del servidor no vuelva a
  // repartir numeros que ya estan en manos de la gente.
  const PREFIJO_CODIGO = 'CF';
  const CODIGO_INICIAL = 1000;
  let ultimoCodigo = null;

  async function siguienteCodigo() {
    if (ultimoCodigo === null) {
      const max = await store.maxCodigoNum(eventoId, PREFIJO_CODIGO);
      ultimoCodigo = Math.max(max, CODIGO_INICIAL - 1);
    }
    return `${PREFIJO_CODIGO}-${++ultimoCodigo}`;
  }

  return { requireSession };
};
