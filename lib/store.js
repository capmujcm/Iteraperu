'use strict';
// -----------------------------------------------------------------------------
// Capa de datos
// -----------------------------------------------------------------------------
// Un solo interfaz asincrono con dos implementaciones intercambiables:
//
//   * driver `pg`     -> PostgreSQL. Es el modo real y el que se usa en Railway.
//   * driver `memory` -> RAM. Solo para la demo comercial y para arrancar sin
//                       base de datos. Los datos se pierden al reiniciar y el
//                       servidor lo advierte por consola.
//
// Mantener una unica firma para ambos evita que el modo real y el modo demo se
// desincronicen, que es lo que pasaba cuando el front tenia su propia base en
// localStorage y el servidor otra distinta en memoria.
//
// TODO el SQL usa consultas parametrizadas ($1, $2, ...). Nunca se concatena un
// valor dentro de la sentencia.
const fs = require('fs');
const path = require('path');
const auth = require('./auth');

// Campos que se pueden devolver al propio asistente o al staff autorizado.
// `password_hash` y `password_salt` jamas salen de esta capa.
const PUBLIC_FIELDS = `id, evento_id, codigo_ticket, qr_token, nombre, apellido,
  email, celular, dni, empresa, cargo, tipo_ticket, estado, checkin_count,
  ultimo_checkin, must_change_password, created_at`;

// Lista blanca de columnas actualizables. El nombre de la columna nunca llega
// desde el cliente sin filtrarse contra esta lista, asi que no hay forma de
// inyectar identificadores en el SQL.
//
// `consentimiento`, `consentimiento_at`, `consentimiento_texto` y
// `consentimiento_via` quedan FUERA a proposito: son el registro de lo que la
// persona acepto en un momento dado. Si se pudieran reescribir, no probarian
// nada. Una revocacion se modela retirando el dato, no editando la prueba.
const UPDATABLE = ['nombre', 'apellido', 'email', 'celular', 'empresa', 'cargo',
  'tipo_ticket', 'estado', 'checkin_count', 'ultimo_checkin',
  'password_hash', 'password_salt', 'password_algo', 'password_updated_at',
  'must_change_password', 'temp_password_expires_at',
  'failed_login_count', 'locked_until', 'acepta_marketing'];

// -----------------------------------------------------------------------------
// Driver PostgreSQL
// -----------------------------------------------------------------------------
function pgDriver(pool) {
  const q = (text, params = []) => pool.query(text, params);

  const driver = {
    name: 'pg',

    async init(evento) {
      // Esquema idempotente en cada arranque: no hay migraciones manuales y el
      // unico camino a produccion es `git push` (ver CLAUDE.md).
      const ddl = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
      await q(ddl);
      const res = await q(
        `INSERT INTO eventos (slug, nombre, descripcion, lugar, aforo_max, activo)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre
         RETURNING *`,
        [evento.slug, evento.nombre, evento.descripcion, evento.lugar, evento.aforo_max]
      );
      return res.rows[0];
    },

    async getEvent(slug) {
      const res = await q('SELECT * FROM eventos WHERE slug = $1', [slug]);
      return res.rows[0] || null;
    },

    // --- asistentes ---------------------------------------------------------
    async findByDni(eventoId, dni) {
      const res = await q(
        'SELECT * FROM asistentes_tickets WHERE evento_id = $1 AND dni = $2',
        [eventoId, dni]
      );
      return res.rows[0] || null;
    },

    async findByQrToken(eventoId, token) {
      const res = await q(
        'SELECT * FROM asistentes_tickets WHERE evento_id = $1 AND qr_token = $2',
        [eventoId, token]
      );
      return res.rows[0] || null;
    },

    async findByCodigo(eventoId, codigo) {
      const res = await q(
        'SELECT * FROM asistentes_tickets WHERE evento_id = $1 AND UPPER(codigo_ticket) = UPPER($2)',
        [eventoId, codigo]
      );
      return res.rows[0] || null;
    },

    async findById(id) {
      const res = await q('SELECT * FROM asistentes_tickets WHERE id = $1', [id]);
      return res.rows[0] || null;
    },

    async createAttendee(a) {
      const res = await q(
        `INSERT INTO asistentes_tickets
           (evento_id, codigo_ticket, qr_token, dni, nombre, apellido, email,
            celular, empresa, cargo, tipo_ticket, estado,
            password_hash, password_salt, password_algo, password_updated_at,
            must_change_password, temp_password_expires_at,
            consentimiento, consentimiento_at, consentimiento_texto,
            consentimiento_via, acepta_marketing, origen, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25)
         RETURNING *`,
        [a.evento_id, a.codigo_ticket, a.qr_token, a.dni, a.nombre, a.apellido,
          a.email, a.celular, a.empresa, a.cargo, a.tipo_ticket, a.estado || 'valido',
          a.password_hash, a.password_salt, a.password_algo, a.password_updated_at,
          a.must_change_password === true, a.temp_password_expires_at,
          a.consentimiento === true, a.consentimiento_at, a.consentimiento_texto,
          a.consentimiento_via, a.acepta_marketing === true,
          a.origen || 'web', a.creado_por]
      );
      return res.rows[0];
    },

    async updateAttendee(id, patch) {
      const cols = Object.keys(patch).filter(k => UPDATABLE.includes(k));
      if (!cols.length) return driver.findById(id);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const res = await q(
        `UPDATE asistentes_tickets SET ${sets} WHERE id = $1 RETURNING *`,
        [id, ...cols.map(c => patch[c])]
      );
      return res.rows[0] || null;
    },

    async listAttendees(eventoId, { limit = 100, offset = 0 } = {}) {
      const res = await q(
        `SELECT ${PUBLIC_FIELDS} FROM asistentes_tickets
         WHERE evento_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [eventoId, limit, offset]
      );
      const total = await q(
        'SELECT COUNT(*)::int AS n FROM asistentes_tickets WHERE evento_id = $1',
        [eventoId]
      );
      return { rows: res.rows, total: total.rows[0].n };
    },

    async countAttendees(eventoId) {
      const res = await q(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE estado = 'checkin')::int AS ingresados
         FROM asistentes_tickets WHERE evento_id = $1`,
        [eventoId]
      );
      return res.rows[0];
    },

    // Mayor numero usado en los codigos con el prefijo dado (CF-1042 -> 1042).
    // Permite continuar la numeracion despues de un reinicio en lugar de
    // empezar de cero y chocar con los codigos ya emitidos.
    async maxCodigoNum(eventoId, prefijo) {
      // El casteo a int va dentro de la subconsulta y sobre el grupo capturado
      // por la expresion regular: `regexp_match` devuelve NULL cuando el codigo
      // no encaja, de modo que nunca se intenta convertir un texto no numerico.
      const res = await q(
        `SELECT COALESCE(MAX(n), 0) AS n FROM (
           SELECT (regexp_match(codigo_ticket, '^' || $2 || '-([0-9]+)$'))[1]::int AS n
           FROM asistentes_tickets WHERE evento_id = $1
         ) s`,
        [eventoId, prefijo]
      );
      return res.rows[0].n || 0;
    },

    // --- sesiones -----------------------------------------------------------
    async createSession(ticketId, tokenHash, deviceId, expiresAt) {
      const res = await q(
        `INSERT INTO sesiones (ticket_id, token_hash, device_id, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [ticketId, tokenHash, deviceId, expiresAt]
      );
      return res.rows[0];
    },

    async findSession(tokenHash) {
      const res = await q(
        `SELECT * FROM sesiones
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [tokenHash]
      );
      return res.rows[0] || null;
    },

    async touchSession(id) {
      await q('UPDATE sesiones SET last_seen_at = NOW() WHERE id = $1', [id]);
    },

    async revokeSession(tokenHash) {
      await q(
        'UPDATE sesiones SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
        [tokenHash]
      );
    },

    // Al cambiar o restablecer la contrasena se cierran las demas sesiones: si
    // alguien habia entrado con la contrasena anterior, queda fuera.
    async revokeAllSessions(ticketId, exceptTokenHash) {
      await q(
        `UPDATE sesiones SET revoked_at = NOW()
         WHERE ticket_id = $1 AND revoked_at IS NULL
           AND ($2::char(64) IS NULL OR token_hash <> $2)`,
        [ticketId, exceptTokenHash || null]
      );
    },

    // --- check-in en puerta -------------------------------------------------
    async createCheckin(ticketId, puerta, staffNombre, resultado) {
      const res = await q(
        `INSERT INTO checkins_log (ticket_id, puerta, staff_nombre, resultado)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [ticketId, puerta, staffNombre, resultado]
      );
      return res.rows[0];
    },

    async listCheckins(eventoId, limit = 50) {
      const res = await q(
        `SELECT c.id, c.puerta, c.staff_nombre, c.resultado, c.created_at,
                t.codigo_ticket, t.nombre, t.apellido
         FROM checkins_log c
         JOIN asistentes_tickets t ON t.id = c.ticket_id
         WHERE t.evento_id = $1
         ORDER BY c.created_at DESC
         LIMIT $2`,
        [eventoId, limit]
      );
      return res.rows;
    },

    // Acumulado de ingresos por hora, para la curva del panel del organizador.
    async checkinTimeline(eventoId) {
      const res = await q(
        `SELECT to_char(date_trunc('hour', c.created_at), 'HH24:00') AS hora,
                COUNT(*)::int AS ingresos
         FROM checkins_log c
         JOIN asistentes_tickets t ON t.id = c.ticket_id
         WHERE t.evento_id = $1 AND c.resultado = 'exitoso'
         GROUP BY 1 ORDER BY 1`,
        [eventoId]
      );
      return res.rows;
    },

    async countByTipo(eventoId) {
      const res = await q(
        `SELECT tipo_ticket, COUNT(*)::int AS n
         FROM asistentes_tickets WHERE evento_id = $1 GROUP BY 1`,
        [eventoId]
      );
      return res.rows;
    },

    // --- bitacora de restablecimientos --------------------------------------
    async logPasswordReset(ticketId, staffNombre, puntoAyuda) {
      await q(
        `INSERT INTO password_resets_log (ticket_id, staff_nombre, punto_ayuda)
         VALUES ($1, $2, $3)`,
        [ticketId, staffNombre, puntoAyuda]
      );
    }
  };

  return driver;
}

// -----------------------------------------------------------------------------
// Driver en memoria (demo / arranque sin base de datos)
// -----------------------------------------------------------------------------
function memoryDriver() {
  const db = { evento: null, asistentes: [], sesiones: [], checkins: [], resets: [] };
  const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
  let seq = 0;
  const uid = () => 'mem-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);

  return {
    name: 'memory',
    _db: db,

    async init(evento) {
      db.evento = Object.assign(
        { id: 'evt-memory', created_at: new Date().toISOString() },
        evento
      );
      return clone(db.evento);
    },

    async getEvent() {
      return clone(db.evento);
    },

    async findByDni(eventoId, dni) {
      return clone(db.asistentes.find(a => a.evento_id === eventoId && a.dni === dni) || null);
    },

    async findByQrToken(eventoId, token) {
      return clone(db.asistentes.find(a => a.evento_id === eventoId && a.qr_token === token) || null);
    },

    async findByCodigo(eventoId, codigo) {
      const c = String(codigo || '').toUpperCase();
      return clone(db.asistentes.find(a => a.evento_id === eventoId &&
        String(a.codigo_ticket).toUpperCase() === c) || null);
    },

    async findById(id) {
      return clone(db.asistentes.find(a => a.id === id) || null);
    },

    async createAttendee(a) {
      const row = Object.assign({
        id: uid(),
        estado: 'valido',
        checkin_count: 0,
        ultimo_checkin: null,
        must_change_password: false,
        temp_password_expires_at: null,
        failed_login_count: 0,
        locked_until: null,
        created_at: new Date().toISOString()
      }, a);
      db.asistentes.unshift(row);
      return clone(row);
    },

    async updateAttendee(id, patch) {
      const row = db.asistentes.find(a => a.id === id);
      if (!row) return null;
      Object.keys(patch)
        .filter(k => UPDATABLE.includes(k))
        .forEach(k => { row[k] = patch[k]; });
      return clone(row);
    },

    async listAttendees(eventoId, { limit = 100, offset = 0 } = {}) {
      const all = db.asistentes.filter(a => a.evento_id === eventoId);
      const rows = all.slice(offset, offset + limit).map(a => {
        const c = clone(a);
        delete c.password_hash;
        delete c.password_salt;
        return c;
      });
      return { rows, total: all.length };
    },

    async countAttendees(eventoId) {
      const all = db.asistentes.filter(a => a.evento_id === eventoId);
      return { total: all.length, ingresados: all.filter(a => a.estado === 'checkin').length };
    },

    async maxCodigoNum(eventoId, prefijo) {
      const re = new RegExp('^' + prefijo + '-(\\d+)$');
      return db.asistentes
        .filter(a => a.evento_id === eventoId)
        .reduce((max, a) => {
          const m = re.exec(String(a.codigo_ticket || ''));
          return m ? Math.max(max, parseInt(m[1], 10)) : max;
        }, 0);
    },

    async createSession(ticketId, tokenHash, deviceId, expiresAt) {
      const s = {
        id: uid(),
        ticket_id: ticketId,
        token_hash: tokenHash,
        device_id: deviceId,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        revoked_at: null
      };
      db.sesiones.push(s);
      return clone(s);
    },

    async findSession(tokenHash) {
      const s = db.sesiones.find(x => x.token_hash === tokenHash && !x.revoked_at &&
        new Date(x.expires_at).getTime() > Date.now());
      return clone(s || null);
    },

    async touchSession(id) {
      const s = db.sesiones.find(x => x.id === id);
      if (s) s.last_seen_at = new Date().toISOString();
    },

    async revokeSession(tokenHash) {
      const s = db.sesiones.find(x => x.token_hash === tokenHash);
      if (s && !s.revoked_at) s.revoked_at = new Date().toISOString();
    },

    async revokeAllSessions(ticketId, exceptTokenHash) {
      db.sesiones.forEach(s => {
        if (s.ticket_id === ticketId && !s.revoked_at && s.token_hash !== exceptTokenHash) {
          s.revoked_at = new Date().toISOString();
        }
      });
    },

    async createCheckin(ticketId, puerta, staffNombre, resultado) {
      const persona = db.asistentes.find(a => a.id === ticketId);
      const row = {
        id: uid(),
        ticket_id: ticketId,
        puerta,
        staff_nombre: staffNombre,
        resultado,
        created_at: new Date().toISOString(),
        codigo_ticket: persona ? persona.codigo_ticket : null,
        nombre: persona ? persona.nombre : null,
        apellido: persona ? persona.apellido : null
      };
      db.checkins.unshift(row);
      return clone(row);
    },

    async listCheckins(eventoId, limit = 50) {
      const ids = new Set(db.asistentes.filter(a => a.evento_id === eventoId).map(a => a.id));
      return db.checkins.filter(c => ids.has(c.ticket_id)).slice(0, limit).map(clone);
    },

    async checkinTimeline(eventoId) {
      const ids = new Set(db.asistentes.filter(a => a.evento_id === eventoId).map(a => a.id));
      const porHora = new Map();
      db.checkins
        .filter(c => ids.has(c.ticket_id) && c.resultado === 'exitoso')
        .forEach(c => {
          const hora = String(new Date(c.created_at).getHours()).padStart(2, '0') + ':00';
          porHora.set(hora, (porHora.get(hora) || 0) + 1);
        });
      return [...porHora.entries()]
        .map(([hora, ingresos]) => ({ hora, ingresos }))
        .sort((a, b) => a.hora.localeCompare(b.hora));
    },

    async countByTipo(eventoId) {
      const porTipo = new Map();
      db.asistentes
        .filter(a => a.evento_id === eventoId)
        .forEach(a => porTipo.set(a.tipo_ticket, (porTipo.get(a.tipo_ticket) || 0) + 1));
      return [...porTipo.entries()].map(([tipo_ticket, n]) => ({ tipo_ticket, n }));
    },

    async logPasswordReset(ticketId, staffNombre, puntoAyuda) {
      db.resets.push({
        id: uid(),
        ticket_id: ticketId,
        staff_nombre: staffNombre,
        punto_ayuda: puntoAyuda,
        created_at: new Date().toISOString()
      });
    }
  };
}

// -----------------------------------------------------------------------------
// Vistas seguras de un asistente
// -----------------------------------------------------------------------------
// Se aplican antes de responder, para que el hash de la contrasena no pueda
// escaparse por descuido desde ningun endpoint.
function safeAttendee(row) {
  if (!row) return null;
  const a = Object.assign({}, row);
  delete a.password_hash;
  delete a.password_salt;
  delete a.password_algo;
  delete a.failed_login_count;
  delete a.locked_until;
  return a;
}

// Vista minima para respuestas publicas (verificacion de ticket en puerta).
// Sin DNI, sin correo y sin celular: quien escanea solo necesita saber a quien
// deja pasar, no llevarse la ficha de datos personales.
function publicAttendee(row) {
  if (!row) return null;
  return {
    nombre: row.nombre,
    apellido: row.apellido,
    codigo_ticket: row.codigo_ticket,
    tipo_ticket: row.tipo_ticket,
    estado: row.estado
  };
}

module.exports = { pgDriver, memoryDriver, safeAttendee, publicAttendee, auth };
