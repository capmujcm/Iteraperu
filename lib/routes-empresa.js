'use strict';
// -----------------------------------------------------------------------------
// Rol Empresa: el puesto como usuario de la plataforma
// -----------------------------------------------------------------------------
// El responsable del puesto entra con el codigo del puesto (P-4K7Q) y una
// contrasena. El organizador crea el puesto y le entrega una clave temporal;
// en el primer ingreso el puesto define la suya.
//
// Que puede hacer: editar su ficha publica, subir su logo -que es la imagen de
// la insignia que se lleva la gente- y ver cuantas insignias entrego.
//
// Que NO puede hacer: ver quien le escaneo. El panel da cifras agregadas. Los
// datos personales de los asistentes no se comparten con los puestos (Ley
// 29733), y no hay un consentimiento que lo permita.
const { auth } = require('./store');

// --- Limites de la subida de logos -------------------------------------------
// 400 KB descodificados. Un logo de puesto no necesita mas, y el tope evita
// que alguien llene la base de datos con imagenes enormes.
const LOGO_MAX_BYTES = 400 * 1024;

// Solo mapas de bits. SVG queda FUERA a proposito: un SVG puede contener
// <script> y se ejecutaria en el navegador de quien lo vea, convirtiendo la
// subida de logos en un XSS almacenado que afectaria a todos los asistentes.
const TIPOS_PERMITIDOS = {
  'image/png': [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/webp': [] // se comprueba aparte: RIFF....WEBP
};

// Duracion de la clave temporal del puesto. A diferencia de la del asistente
// (30 min, se dicta en la cola), esta se entrega por correo o en una reunion
// dias antes del evento.
const TEMP_EMPRESA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CREDENCIALES_INVALIDAS =
  'Código de puesto o contraseña incorrectos. Si tu clave temporal caducó, ' +
  'pídela de nuevo a la organización.';

// La clave temporal del puesto se genera con el mismo helper que usa el resto
// del proyecto: alfabeto sin 0/O ni 1/I, porque se dicta y se copia a mano.
const claveTemporal = () => auth.claveLegible(8);

// Comprueba que los bytes son de verdad la imagen que dicen ser. Fiarse del
// mime declarado por el cliente permitiria subir cualquier cosa etiquetada
// como PNG.
function tipoRealDe(buf) {
  if (buf.length < 12) return null;
  for (const [mime, firmas] of Object.entries(TIPOS_PERMITIDOS)) {
    for (const firma of firmas) {
      if (firma.every((b, i) => buf[i] === b)) return mime;
    }
  }
  const esRiff = buf.slice(0, 4).toString('ascii') === 'RIFF';
  const esWebp = buf.slice(8, 12).toString('ascii') === 'WEBP';
  if (esRiff && esWebp) return 'image/webp';
  return null;
}

function texto(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

module.exports = function registrarEmpresa(fastify, opciones) {
  const { store, eventoId, rateLimit, requireAdmin } = opciones;

  // ---------------------------------------------------------------------------
  // Guardia de sesion del puesto
  // ---------------------------------------------------------------------------
  function requireEmpresa({ allowMustChange = false } = {}) {
    return async (req, reply) => {
      const header = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
      if (!header) {
        reply.code(401).send({ error: 'Sesión no iniciada.' });
        return reply;
      }
      // Se busca SOLO en las sesiones de puesto. Un token de asistente no sirve
      // aqui, y viceversa: son tablas distintas justamente para eso.
      const sesion = await store.findEmpresaSession(auth.sha256(header));
      if (!sesion) {
        reply.code(401).send({ error: 'Tu sesión expiró. Vuelve a ingresar.' });
        return reply;
      }
      const empresa = await store.findEmpresaById(sesion.empresa_id);
      if (!empresa || empresa.evento_id !== eventoId) {
        reply.code(401).send({ error: 'Sesión no válida.' });
        return reply;
      }
      if (empresa.must_change_password && !allowMustChange) {
        reply.code(403).send({
          error: 'Debes definir una contraseña nueva antes de continuar.',
          must_change_password: true
        });
        return reply;
      }
      req.empresa = empresa;
      req.sessionTokenHash = sesion.token_hash;
      await store.touchEmpresaSession(sesion.id);
    };
  }

  // Vista que se devuelve al propio puesto: sin hash ni sal.
  function vistaPropia(e) {
    const c = Object.assign({}, e);
    delete c.password_hash;
    delete c.password_salt;
    delete c.failed_login_count;
    delete c.locked_until;
    return c;
  }

  // ---------------------------------------------------------------------------
  // Ingreso
  // ---------------------------------------------------------------------------
  fastify.post('/api/negocio/login', { preHandler: rateLimit(15, 60000) }, async (req, reply) => {
    const b = req.body || {};
    const codigo = texto(b.codigo, 20);
    const password = typeof b.password === 'string' ? b.password : '';

    if (!codigo || !password) return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });

    const empresa = await store.findEmpresaByCodigo(eventoId, codigo);
    if (!empresa) return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });

    const completa = await store.findEmpresaById(empresa.id);

    if (completa.locked_until && new Date(completa.locked_until).getTime() > Date.now()) {
      const min = Math.max(1, Math.ceil((new Date(completa.locked_until).getTime() - Date.now()) / 60000));
      return reply.code(429).send({
        error: `Demasiados intentos fallidos. Vuelve a intentar en ${min} minuto(s).`
      });
    }

    if (!completa.password_hash) return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });

    // Clave temporal caducada: se anula el acceso y hay que pedir otra.
    const caducada = completa.must_change_password && completa.temp_password_expires_at &&
      new Date(completa.temp_password_expires_at).getTime() <= Date.now();
    if (caducada) {
      await store.updateEmpresa(completa.id, {
        password_hash: null, password_salt: null, temp_password_expires_at: null
      });
      return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });
    }

    if (!auth.verifyPassword(password, completa.password_hash, completa.password_salt)) {
      const fallos = (completa.failed_login_count || 0) + 1;
      const patch = { failed_login_count: fallos };
      if (fallos >= auth.MAX_FAILED_LOGINS) {
        patch.locked_until = new Date(Date.now() + auth.LOCK_MS).toISOString();
        patch.failed_login_count = 0;
      }
      await store.updateEmpresa(completa.id, patch);
      return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });
    }

    await store.updateEmpresa(completa.id, { failed_login_count: 0, locked_until: null });

    const { token, tokenHash } = auth.newSessionToken();
    const expira = new Date(Date.now() + auth.SESSION_TTL_MS).toISOString();
    await store.createEmpresaSession(completa.id, tokenHash, texto(b.device_id, 60), expira);

    return reply.send({
      success: true,
      token,
      must_change_password: completa.must_change_password === true,
      empresa: vistaPropia(completa)
    });
  });

  // ---------------------------------------------------------------------------
  // Sesion actual, cambio de clave y salida
  // ---------------------------------------------------------------------------
  fastify.get('/api/negocio/me', { preHandler: requireEmpresa() }, async (req) => {
    return { success: true, empresa: vistaPropia(req.empresa) };
  });

  fastify.post('/api/negocio/change-password', {
    preHandler: [rateLimit(10, 60000), requireEmpresa({ allowMustChange: true })]
  }, async (req, reply) => {
    const b = req.body || {};
    const e = req.empresa;

    if (!auth.verifyPassword(String(b.password_actual || ''), e.password_hash, e.password_salt)) {
      return reply.code(401).send({ error: 'La contraseña actual no coincide.' });
    }
    const nueva = auth.validatePassword(b.password_nueva);
    if (!nueva.ok) return reply.code(400).send({ error: nueva.error });
    if (auth.verifyPassword(nueva.value, e.password_hash, e.password_salt)) {
      return reply.code(400).send({ error: 'La contraseña nueva debe ser distinta de la actual.' });
    }

    const { hash, salt, algo } = auth.hashPassword(nueva.value);
    const actualizada = await store.updateEmpresa(e.id, {
      password_hash: hash, password_salt: salt, password_algo: algo,
      password_updated_at: new Date().toISOString(),
      must_change_password: false, temp_password_expires_at: null,
      failed_login_count: 0, locked_until: null
    });
    await store.revokeAllEmpresaSessions(e.id, req.sessionTokenHash);

    return reply.send({ success: true, empresa: vistaPropia(actualizada) });
  });

  fastify.post('/api/negocio/logout', {
    preHandler: requireEmpresa({ allowMustChange: true })
  }, async (req) => {
    await store.revokeEmpresaSession(req.sessionTokenHash);
    return { success: true };
  });

  // ---------------------------------------------------------------------------
  // Ficha publica del puesto
  // ---------------------------------------------------------------------------
  fastify.patch('/api/negocio/perfil', { preHandler: requireEmpresa() }, async (req, reply) => {
    const b = req.body || {};

    // El puesto no puede tocar su codigo, su QR ni su estado activo: eso lo
    // gobierna la organizacion. Cambiar el QR dejaria muertos los carteles ya
    // impresos y colgados en el recinto.
    const patch = {};
    const campos = [
      ['nombre', 150], ['rubro', 60], ['descripcion', 1000], ['condicion', 500],
      ['responsable', 120], ['telefono', 30], ['email', 150], ['instagram', 80],
      ['ruc', 20], ['emoji', 16]
    ];
    campos.forEach(([campo, max]) => {
      if (b[campo] !== undefined) patch[campo] = texto(b[campo], max);
    });
    if (typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color.trim())) {
      patch.color = b.color.trim();
    }

    if (!Object.keys(patch).length) {
      return reply.code(400).send({ error: 'No hay nada que actualizar.' });
    }
    if (patch.nombre === null) {
      return reply.code(400).send({ error: 'El nombre del puesto no puede quedar vacío.' });
    }

    const actualizada = await store.updateEmpresa(req.empresa.id, patch);
    return reply.send({ success: true, empresa: vistaPropia(actualizada) });
  });

  // ---------------------------------------------------------------------------
  // Logo: es la imagen de la insignia
  // ---------------------------------------------------------------------------
  // Llega como base64 en JSON, no como multipart. Asi se evita anadir
  // @fastify/multipart por un unico endpoint que maneja archivos pequenos
  // (checklist punto 7: preferir la solucion sin dependencia).
  fastify.post('/api/negocio/logo', {
    preHandler: [rateLimit(20, 60000), requireEmpresa()],
    // base64 infla ~33%, mas el resto del JSON.
    bodyLimit: Math.ceil(LOGO_MAX_BYTES * 1.4) + 4096
  }, async (req, reply) => {
    const b = req.body || {};
    const datos = typeof b.datos === 'string' ? b.datos : '';

    // Se acepta con o sin prefijo data:. El prefijo se ignora por completo:
    // el tipo lo decide el contenido, no lo que diga el cliente.
    const limpio = datos.replace(/^data:[^;,]*;base64,/, '');
    if (!limpio) return reply.code(400).send({ error: 'No llegó ninguna imagen.' });
    if (!/^[A-Za-z0-9+/=\s]+$/.test(limpio)) {
      return reply.code(400).send({ error: 'La imagen no llegó en un formato válido.' });
    }

    let buf;
    try {
      buf = Buffer.from(limpio, 'base64');
    } catch (e) {
      return reply.code(400).send({ error: 'La imagen no llegó en un formato válido.' });
    }

    if (!buf.length) return reply.code(400).send({ error: 'La imagen está vacía.' });
    if (buf.length > LOGO_MAX_BYTES) {
      return reply.code(413).send({
        error: `La imagen pesa demasiado. El máximo son ${Math.round(LOGO_MAX_BYTES / 1024)} KB.`
      });
    }

    // La comprobacion que importa: los bytes reales, no la etiqueta.
    const mime = tipoRealDe(buf);
    if (!mime) {
      return reply.code(415).send({
        error: 'Formato no admitido. Sube un PNG, JPG o WebP. Los SVG no se aceptan por seguridad.'
      });
    }

    const actualizada = await store.updateEmpresa(req.empresa.id, {
      logo_mime: mime,
      logo_datos: buf,
      logo_actualizado_at: new Date().toISOString()
    });

    req.log.info({ empresaId: req.empresa.id, bytes: buf.length, mime }, 'logo actualizado');
    return reply.send({ success: true, empresa: vistaPropia(actualizada), bytes: buf.length });
  });

  fastify.delete('/api/negocio/logo', { preHandler: requireEmpresa() }, async (req) => {
    const actualizada = await store.updateEmpresa(req.empresa.id, {
      logo_mime: null, logo_datos: null, logo_actualizado_at: null
    });
    return { success: true, empresa: vistaPropia(actualizada) };
  });

  // Servido publico del logo: lo pinta la app del asistente en cada insignia.
  fastify.get('/api/empresas/:id/logo', async (req, reply) => {
    const logo = await store.getLogo(req.params.id);
    if (!logo) return reply.code(404).send({ error: 'Ese puesto no tiene logo.' });

    return reply
      // nosniff impide que el navegador reinterprete el archivo como otra cosa
      // aunque el contenido le sugiera lo contrario.
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Type', logo.logo_mime)
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'public, max-age=300')
      .send(logo.logo_datos);
  });

  // ---------------------------------------------------------------------------
  // Panel del puesto
  // ---------------------------------------------------------------------------
  fastify.get('/api/negocio/stats', { preHandler: requireEmpresa() }, async (req) => {
    const stats = await store.statsEmpresa(req.empresa.id);
    return {
      success: true,
      // Cifras agregadas. Ninguna persona identificable: el puesto sabe cuantos
      // le escanearon, no quienes.
      insignias: stats.insignias,
      escaneos: stats.escaneos,
      repetidos: stats.repetidos,
      porHora: stats.porHora
    };
  });

  // ---------------------------------------------------------------------------
  // Organizador: entregar o reponer el acceso de un puesto
  // ---------------------------------------------------------------------------
  fastify.post('/api/soporte/empresas/:id/acceso', {
    preHandler: [requireAdmin, rateLimit(60, 60000)]
  }, async (req, reply) => {
    const empresa = await store.findEmpresaById(req.params.id);
    if (!empresa || empresa.evento_id !== eventoId) {
      return reply.code(404).send({ error: 'Puesto no encontrado.' });
    }

    const clave = claveTemporal();
    const { hash, salt, algo } = auth.hashPassword(clave);
    const expira = new Date(Date.now() + TEMP_EMPRESA_TTL_MS).toISOString();

    await store.updateEmpresa(empresa.id, {
      password_hash: hash, password_salt: salt, password_algo: algo,
      password_updated_at: new Date().toISOString(),
      must_change_password: true, temp_password_expires_at: expira,
      failed_login_count: 0, locked_until: null
    });
    // Se cierran las sesiones abiertas del puesto: si el acceso se repone es
    // porque cambio el responsable o se perdio la clave.
    await store.revokeAllEmpresaSessions(empresa.id, null);

    return reply.send({
      success: true,
      // Se muestra UNA vez. No se guarda en claro en ningun sitio.
      codigo: empresa.codigo_corto,
      password_temporal: clave,
      expira,
      dias_validez: Math.round(TEMP_EMPRESA_TTL_MS / 86400000),
      empresa: { id: empresa.id, nombre: empresa.nombre }
    });
  });

  return { requireEmpresa, claveTemporal, TEMP_EMPRESA_TTL_MS };
};
