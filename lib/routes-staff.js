'use strict';
// -----------------------------------------------------------------------------
// Usuarios de staff: cuentas con nombre propio y permisos por rol
// -----------------------------------------------------------------------------
// Sustituye al ADMIN_TOKEN compartido entre todo el equipo. Con una sola llave
// repartida no se podia revocar a una persona concreta, y el nombre que quedaba
// registrado en cada accion era el que cada uno escribia a mano.
//
//   staff        -> puerta: validar ingreso, registro rapido, buscar por DNI y
//                   restablecer contrasenas de asistentes.
//   organizador  -> ademas: consola, alta de puestos, exportaciones y gestion
//                   de usuarios.
//
// El ADMIN_TOKEN se conserva como llave de emergencia: crea el primer
// organizador y permite recuperar el acceso si alguien se queda fuera. No se
// reparte.
const { auth } = require('./store');

// La clave que entrega el organizador dura 3 dias: se crea la cuenta en la
// reunion previa, no en la cola de la puerta.
const TEMP_STAFF_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const ROLES = ['staff', 'organizador'];

const CREDENCIALES_INVALIDAS = 'Usuario o contraseña incorrectos.';

// Usuario: minusculas, sin espacios ni acentos. Se escribe con prisa en un
// celular y en un teclado tactil, asi que cuanto menos ambiguo, mejor.
function normalizaUsuario(v) {
  if (typeof v !== 'string') return null;
  const u = v.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]/g, '');
  if (u.length < 3 || u.length > 40) return null;
  return u;
}

function texto(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

module.exports = function registrarStaff(fastify, opciones) {
  const { store, eventoId, rateLimit, adminTokenValido, authEnabled } = opciones;

  // ---------------------------------------------------------------------------
  // Guardia por rol
  // ---------------------------------------------------------------------------
  // Acepta dos credenciales:
  //   1. Una sesion de usuario de staff (lo normal).
  //   2. El ADMIN_TOKEN, que actua como organizador (llave de emergencia).
  //
  // Devuelve un preHandler. `roles` es la lista de roles admitidos.
  function requireRol(roles) {
    return async (req, reply) => {
      // --- 1. Token de emergencia ---
      const cabeceraAdmin = String(
        req.headers['x-admin-token'] || ''
      ).trim();
      if (cabeceraAdmin) {
        if (!authEnabled()) {
          reply.code(503).send({
            error: 'Servicio no disponible: falta configurar ADMIN_TOKEN en el servidor.'
          });
          return reply;
        }
        if (adminTokenValido(cabeceraAdmin)) {
          // El token de emergencia siempre vale como organizador.
          req.actor = { tipo: 'admin_token', id: null, nombre: 'Token de emergencia', rol: 'organizador' };
          return;
        }
        reply.code(401).send({ error: 'Token de emergencia inválido.' });
        return reply;
      }

      // --- 2. Sesion de staff ---
      const bearer = String(req.headers['authorization'] || '')
        .replace(/^Bearer\s+/i, '').trim();
      if (!bearer) {
        reply.code(401).send({ error: 'Sesión no iniciada.' });
        return reply;
      }

      const sesion = await store.findStaffSession(auth.sha256(bearer));
      if (!sesion) {
        reply.code(401).send({ error: 'Tu sesión expiró. Vuelve a ingresar.' });
        return reply;
      }

      const usuario = await store.findUsuarioStaffById(sesion.usuario_id);
      if (!usuario || usuario.evento_id !== eventoId || usuario.activo === false) {
        reply.code(401).send({ error: 'Sesión no válida.' });
        return reply;
      }
      if (usuario.must_change_password) {
        reply.code(403).send({
          error: 'Debes definir una contraseña nueva antes de continuar.',
          must_change_password: true
        });
        return reply;
      }
      if (roles.indexOf(usuario.rol) < 0) {
        // 403 y no 404: la persona esta autenticada, simplemente no le
        // corresponde. Decirlo claro evita que el staff crea que algo se rompio.
        reply.code(403).send({
          error: 'Tu usuario no tiene permiso para esta acción. Pídeselo a la organización.'
        });
        return reply;
      }

      req.actor = { tipo: 'staff', id: usuario.id, nombre: usuario.nombre, rol: usuario.rol };
      req.sessionTokenHash = sesion.token_hash;
      await store.touchStaffSession(sesion.id);
    };
  }

  const requireStaff = () => requireRol(ROLES);
  const requireOrganizador = () => requireRol(['organizador']);

  // Registra la accion con el autor verificado. Si vino por token de emergencia
  // queda constancia de eso tambien.
  async function registrar(req, accion, detalle) {
    const a = req.actor || {};
    await store.logAccionStaff(eventoId, a.id || null, a.nombre || 'desconocido', accion, detalle || null);
  }

  function vistaUsuario(u) {
    if (!u) return null;
    return {
      id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol,
      activo: u.activo, must_change_password: u.must_change_password,
      creado_por: u.creado_por, created_at: u.created_at
    };
  }

  // ---------------------------------------------------------------------------
  // Ingreso
  // ---------------------------------------------------------------------------
  fastify.post('/api/staff/login', { preHandler: rateLimit(15, 60000) }, async (req, reply) => {
    const b = req.body || {};
    const usuario = normalizaUsuario(b.usuario);
    const password = typeof b.password === 'string' ? b.password : '';

    if (!usuario || !password) return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });

    const u = await store.findUsuarioStaff(eventoId, usuario);
    if (!u || u.activo === false) return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });

    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      const min = Math.max(1, Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000));
      return reply.code(429).send({
        error: `Demasiados intentos fallidos. Vuelve a intentar en ${min} minuto(s).`
      });
    }

    if (!u.password_hash) return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });

    const caducada = u.must_change_password && u.temp_password_expires_at &&
      new Date(u.temp_password_expires_at).getTime() <= Date.now();
    if (caducada) {
      await store.updateUsuarioStaff(u.id, {
        password_hash: null, password_salt: null, temp_password_expires_at: null
      });
      return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });
    }

    if (!auth.verifyPassword(password, u.password_hash, u.password_salt)) {
      const fallos = (u.failed_login_count || 0) + 1;
      const patch = { failed_login_count: fallos };
      if (fallos >= auth.MAX_FAILED_LOGINS) {
        patch.locked_until = new Date(Date.now() + auth.LOCK_MS).toISOString();
        patch.failed_login_count = 0;
      }
      await store.updateUsuarioStaff(u.id, patch);
      return reply.code(401).send({ error: CREDENCIALES_INVALIDAS });
    }

    await store.updateUsuarioStaff(u.id, { failed_login_count: 0, locked_until: null });

    const { token, tokenHash } = auth.newSessionToken();
    const expira = new Date(Date.now() + auth.SESSION_TTL_MS).toISOString();
    await store.createStaffSession(u.id, tokenHash, texto(b.device_id, 60), expira);

    return reply.send({
      success: true,
      token,
      must_change_password: u.must_change_password === true,
      usuario: vistaUsuario(u)
    });
  });

  fastify.get('/api/staff/me', { preHandler: requireStaff() }, async (req) => {
    return { success: true, actor: req.actor };
  });

  fastify.post('/api/staff/logout', {
    preHandler: requireRol(ROLES)
  }, async (req) => {
    if (req.sessionTokenHash) await store.revokeStaffSession(req.sessionTokenHash);
    return { success: true };
  });

  // Cambio de contrasena. Se permite con el cambio pendiente, que es justo
  // cuando hace falta, asi que no pasa por requireRol.
  fastify.post('/api/staff/change-password', {
    preHandler: rateLimit(10, 60000)
  }, async (req, reply) => {
    const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (!bearer) return reply.code(401).send({ error: 'Sesión no iniciada.' });

    const sesion = await store.findStaffSession(auth.sha256(bearer));
    if (!sesion) return reply.code(401).send({ error: 'Tu sesión expiró. Vuelve a ingresar.' });

    const u = await store.findUsuarioStaffById(sesion.usuario_id);
    if (!u || u.evento_id !== eventoId || u.activo === false) {
      return reply.code(401).send({ error: 'Sesión no válida.' });
    }

    const b = req.body || {};
    if (!auth.verifyPassword(String(b.password_actual || ''), u.password_hash, u.password_salt)) {
      return reply.code(401).send({ error: 'La contraseña actual no coincide.' });
    }
    const nueva = auth.validatePassword(b.password_nueva);
    if (!nueva.ok) return reply.code(400).send({ error: nueva.error });
    if (auth.verifyPassword(nueva.value, u.password_hash, u.password_salt)) {
      return reply.code(400).send({ error: 'La contraseña nueva debe ser distinta de la actual.' });
    }

    const { hash, salt, algo } = auth.hashPassword(nueva.value);
    const actualizado = await store.updateUsuarioStaff(u.id, {
      password_hash: hash, password_salt: salt, password_algo: algo,
      password_updated_at: new Date().toISOString(),
      must_change_password: false, temp_password_expires_at: null,
      failed_login_count: 0, locked_until: null
    });
    await store.revokeAllStaffSessions(u.id, sesion.token_hash);

    return reply.send({
      success: true,
      actor: { tipo: 'staff', id: u.id, nombre: actualizado.nombre, rol: actualizado.rol }
    });
  });

  // ---------------------------------------------------------------------------
  // Gestion de usuarios (solo organizador)
  // ---------------------------------------------------------------------------
  fastify.get('/api/staff/usuarios', { preHandler: requireOrganizador() }, async () => {
    return { success: true, usuarios: await store.listUsuariosStaff(eventoId) };
  });

  fastify.post('/api/staff/usuarios', {
    preHandler: [requireOrganizador(), rateLimit(30, 60000)]
  }, async (req, reply) => {
    const b = req.body || {};
    const usuario = normalizaUsuario(b.usuario);
    const nombre = texto(b.nombre, 120);
    const rol = ROLES.indexOf(b.rol) >= 0 ? b.rol : 'staff';

    if (!usuario) {
      return reply.code(400).send({
        error: 'El usuario debe tener entre 3 y 40 caracteres: letras, números, punto, guion o guion bajo.'
      });
    }
    if (!nombre) return reply.code(400).send({ error: 'El nombre completo es obligatorio.' });

    const clave = auth.claveLegible(8);
    const { hash, salt, algo } = auth.hashPassword(clave);

    let creado;
    try {
      creado = await store.createUsuarioStaff({
        evento_id: eventoId,
        usuario, nombre, rol,
        password_hash: hash, password_salt: salt, password_algo: algo,
        password_updated_at: new Date().toISOString(),
        must_change_password: true,
        temp_password_expires_at: new Date(Date.now() + TEMP_STAFF_TTL_MS).toISOString(),
        creado_por: (req.actor && req.actor.nombre) || 'organización'
      });
    } catch (err) {
      if (err && err.code === '23505') {
        return reply.code(409).send({ error: 'Ya existe un usuario con ese nombre.' });
      }
      throw err;
    }

    await registrar(req, 'crear_usuario', `${usuario} (${rol})`);

    return reply.code(201).send({
      success: true,
      usuario: vistaUsuario(creado),
      // Se muestra UNA vez. No se guarda en claro.
      password_temporal: clave,
      dias_validez: Math.round(TEMP_STAFF_TTL_MS / 86400000)
    });
  });

  // Reponer la clave de un usuario.
  fastify.post('/api/staff/usuarios/:id/clave', {
    preHandler: [requireOrganizador(), rateLimit(30, 60000)]
  }, async (req, reply) => {
    const u = await store.findUsuarioStaffById(req.params.id);
    if (!u || u.evento_id !== eventoId) {
      return reply.code(404).send({ error: 'Usuario no encontrado.' });
    }

    const clave = auth.claveLegible(8);
    const { hash, salt, algo } = auth.hashPassword(clave);
    await store.updateUsuarioStaff(u.id, {
      password_hash: hash, password_salt: salt, password_algo: algo,
      password_updated_at: new Date().toISOString(),
      must_change_password: true,
      temp_password_expires_at: new Date(Date.now() + TEMP_STAFF_TTL_MS).toISOString(),
      failed_login_count: 0, locked_until: null
    });
    await store.revokeAllStaffSessions(u.id, null);
    await registrar(req, 'reponer_clave_usuario', u.usuario);

    return reply.send({
      success: true,
      usuario: u.usuario,
      password_temporal: clave,
      dias_validez: Math.round(TEMP_STAFF_TTL_MS / 86400000)
    });
  });

  // Desactivar o reactivar. No se borra: las acciones que hizo deben seguir
  // teniendo a quien atribuirse.
  fastify.post('/api/staff/usuarios/:id/activo', {
    preHandler: [requireOrganizador(), rateLimit(30, 60000)]
  }, async (req, reply) => {
    const u = await store.findUsuarioStaffById(req.params.id);
    if (!u || u.evento_id !== eventoId) {
      return reply.code(404).send({ error: 'Usuario no encontrado.' });
    }

    const activo = (req.body || {}).activo === true;

    // No dejar el evento sin ningun organizador activo: seria quedarse fuera
    // de la propia plataforma.
    if (!activo && u.rol === 'organizador') {
      const todos = await store.listUsuariosStaff(eventoId);
      const organizadoresActivos = todos.filter(x => x.rol === 'organizador' && x.activo !== false);
      if (organizadoresActivos.length <= 1) {
        return reply.code(409).send({
          error: 'No puedes desactivar al último organizador activo. Crea otro primero.'
        });
      }
    }

    await store.updateUsuarioStaff(u.id, { activo });
    if (!activo) await store.revokeAllStaffSessions(u.id, null);
    await registrar(req, activo ? 'activar_usuario' : 'desactivar_usuario', u.usuario);

    return reply.send({ success: true, usuario: u.usuario, activo });
  });

  // Bitacora de acciones.
  fastify.get('/api/staff/acciones', { preHandler: requireOrganizador() }, async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    return { success: true, acciones: await store.listAccionesStaff(eventoId, limit) };
  });

  return { requireRol, requireStaff, requireOrganizador, registrar, TEMP_STAFF_TTL_MS };
};
