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

// Lista blanca equivalente para los puestos. `qr_token` y `codigo_corto` NO
// estan: cambiarlos invalidaria los carteles ya impresos y colgados en el
// recinto. `evento_id` tampoco, para que un puesto no pueda saltar de evento.
const EMPRESA_UPDATABLE = ['nombre', 'rubro', 'emoji', 'color', 'descripcion',
  'stand', 'condicion', 'activo', 'ruc', 'responsable', 'telefono', 'email',
  'instagram', 'facebook', 'tiktok', 'whatsapp', 'logo_mime', 'logo_datos', 'logo_actualizado_at',
  'password_hash', 'password_salt', 'password_algo', 'password_updated_at',
  'must_change_password', 'temp_password_expires_at',
  'failed_login_count', 'locked_until'];

// Lista blanca de los usuarios de staff. `usuario`, `rol` y `evento_id` quedan
// fuera: cambiar el rol de una cuenta es una operacion aparte y explicita, no
// algo que pueda colarse en un update generico.
const STAFF_UPDATABLE = ['nombre', 'activo', 'password_hash', 'password_salt',
  'password_algo', 'password_updated_at', 'must_change_password',
  'temp_password_expires_at', 'failed_login_count', 'locked_until'];

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
         ON CONFLICT (slug) DO UPDATE
           SET nombre = EXCLUDED.nombre,
               descripcion = EXCLUDED.descripcion,
               -- Lugar y aforo se vuelven a aplicar en cada arranque: antes
               -- solo se guardaban al crear el evento, asi que cambiar
               -- EVENT_AFORO en Railway no tenia ningun efecto.
               lugar = EXCLUDED.lugar,
               aforo_max = EXCLUDED.aforo_max
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
            consentimiento_via, acepta_marketing, origen, creado_por, es_prueba)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING *`,
        [a.evento_id, a.codigo_ticket, a.qr_token, a.dni, a.nombre, a.apellido,
          a.email, a.celular, a.empresa, a.cargo, a.tipo_ticket, a.estado || 'valido',
          a.password_hash, a.password_salt, a.password_algo, a.password_updated_at,
          a.must_change_password === true, a.temp_password_expires_at,
          a.consentimiento === true, a.consentimiento_at, a.consentimiento_texto,
          a.consentimiento_via, a.acepta_marketing === true,
          a.origen || 'web', a.creado_por, a.es_prueba === true]
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

    // Ingresos por hora DEL DIA DE HOY, en la zona horaria del evento, para la
    // curva del panel del organizador. La base corre en UTC: sin la conversion
    // las 17:00 de Ilo salian como 22:00, y con dos dias de evento las horas
    // de ambos se sumaban en una sola curva.
    async checkinTimeline(eventoId, tz) {
      const res = await q(
        `SELECT to_char(date_trunc('hour', c.created_at AT TIME ZONE $2::text), 'HH24:00') AS hora,
                COUNT(*)::int AS ingresos
         FROM checkins_log c
         JOIN asistentes_tickets t ON t.id = c.ticket_id
         WHERE t.evento_id = $1 AND c.resultado = 'exitoso'
           AND (c.created_at AT TIME ZONE $2::text)::date = (NOW() AT TIME ZONE $2::text)::date
         GROUP BY 1 ORDER BY 1`,
        [eventoId, tz || 'America/Lima']
      );
      return res.rows;
    },

    // Segundo dia del evento: todos vuelven a "pendiente de ingreso" y deben
    // pasar otra vez por la puerta. checkins_log no se toca (append-only).
    async reiniciarIngresos(eventoId) {
      const res = await q(
        `UPDATE asistentes_tickets SET estado = 'valido'
         WHERE evento_id = $1 AND estado = 'checkin'`,
        [eventoId]
      );
      return res.rowCount;
    },

    // Vuelta atras de un reinicio pulsado a destiempo. Sin esto, un clic por
    // error a media tarde dejaba a miles de personas fuera -sin poder escanear
    // puestos, con el aforo a cero- y la unica salida era que todas volvieran a
    // pasar por la puerta.
    //
    // No inventa nada: recupera el estado "dentro" solo de quien tiene un
    // ingreso exitoso registrado HOY en checkins_log, en hora del evento. Quien
    // no paso por la puerta hoy, no vuelve.
    async deshacerReinicio(eventoId, tz) {
      const res = await q(
        `UPDATE asistentes_tickets t SET estado = 'checkin'
         WHERE t.evento_id = $1 AND t.estado = 'valido'
           AND EXISTS (
             SELECT 1 FROM checkins_log c
             WHERE c.ticket_id = t.id AND c.resultado = 'exitoso'
               AND (c.created_at AT TIME ZONE $2::text)::date
                   = (NOW() AT TIME ZONE $2::text)::date
           )`,
        [eventoId, tz || 'America/Lima']
      );
      return res.rowCount;
    },

    async countByTipo(eventoId) {
      const res = await q(
        `SELECT tipo_ticket, COUNT(*)::int AS n
         FROM asistentes_tickets WHERE evento_id = $1 GROUP BY 1`,
        [eventoId]
      );
      return res.rows;
    },

    // --- puestos participantes ----------------------------------------------
    // Nunca se seleccionan los bytes del logo en los listados: son binarios de
    // cientos de KB y multiplicarlos por cada puesto haria la respuesta
    // inmanejable. Se devuelve solo si existe, y la imagen se pide aparte.
    async listEmpresas(eventoId) {
      const res = await q(
        `SELECT id, nombre, rubro, emoji, color, descripcion, stand, condicion,
                codigo_corto, activo,
                -- Lo que el puesto decide publicar: sus redes y su numero de
                -- contacto. El telefono del responsable NO va aqui: ese
                -- solo lo ve la organizacion.
                instagram, facebook, tiktok, whatsapp,
                (logo_datos IS NOT NULL) AS tiene_logo, logo_actualizado_at
         FROM empresas WHERE evento_id = $1 AND activo = true
         ORDER BY nombre`,
        [eventoId]
      );
      return res.rows;
    },

    // Incluye el qr_token: solo para el organizador, que necesita imprimir los
    // carteles. Nunca se expone en el catalogo publico. Se excluyen los bytes
    // del logo y el hash de la contrasena.
    async listEmpresasConToken(eventoId) {
      const res = await q(
        `SELECT id, evento_id, nombre, rubro, emoji, color, descripcion, stand,
                condicion, qr_token, codigo_corto, usuario, activo, ruc, responsable,
                telefono, email, instagram, facebook, tiktok, whatsapp, created_at,
                must_change_password, temp_password_expires_at,
                (password_hash IS NOT NULL) AS tiene_acceso,
                (logo_datos IS NOT NULL) AS tiene_logo
         FROM empresas WHERE evento_id = $1 ORDER BY nombre`,
        [eventoId]
      );
      return res.rows;
    },

    async findEmpresaById(id) {
      const res = await q(
        `SELECT id, evento_id, nombre, rubro, emoji, color, descripcion, stand,
                condicion, qr_token, codigo_corto, usuario, activo, ruc, responsable,
                telefono, email, instagram, facebook, tiktok, whatsapp, created_at,
                password_hash, password_salt, must_change_password,
                temp_password_expires_at, failed_login_count, locked_until,
                (logo_datos IS NOT NULL) AS tiene_logo, logo_actualizado_at
         FROM empresas WHERE id = $1`,
        [id]
      );
      return res.rows[0] || null;
    },

    // Solo aqui se leen los bytes de la imagen, y de un puesto concreto.
    async getLogo(empresaId) {
      const res = await q(
        'SELECT logo_mime, logo_datos, logo_actualizado_at FROM empresas WHERE id = $1',
        [empresaId]
      );
      const fila = res.rows[0];
      if (!fila || !fila.logo_datos) return null;
      return fila;
    },

    async updateEmpresa(id, patch) {
      const cols = Object.keys(patch).filter(k => EMPRESA_UPDATABLE.includes(k));
      if (!cols.length) return driver.findEmpresaById(id);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await q(
        `UPDATE empresas SET ${sets} WHERE id = $1`,
        [id, ...cols.map(c => patch[c])]
      );
      // Se relee con la proyeccion segura en vez de usar RETURNING *, que
      // arrastraria los bytes del logo y el hash en cada actualizacion.
      return driver.findEmpresaById(id);
    },

    // --- sesiones de puesto -------------------------------------------------
    async createEmpresaSession(empresaId, tokenHash, deviceId, expiresAt) {
      const res = await q(
        `INSERT INTO sesiones_empresa (empresa_id, token_hash, device_id, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [empresaId, tokenHash, deviceId, expiresAt]
      );
      return res.rows[0];
    },

    async findEmpresaSession(tokenHash) {
      const res = await q(
        `SELECT * FROM sesiones_empresa
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [tokenHash]
      );
      return res.rows[0] || null;
    },

    async touchEmpresaSession(id) {
      await q('UPDATE sesiones_empresa SET last_seen_at = NOW() WHERE id = $1', [id]);
    },

    async revokeEmpresaSession(tokenHash) {
      await q(
        'UPDATE sesiones_empresa SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
        [tokenHash]
      );
    },

    async revokeAllEmpresaSessions(empresaId, exceptTokenHash) {
      await q(
        `UPDATE sesiones_empresa SET revoked_at = NOW()
         WHERE empresa_id = $1 AND revoked_at IS NULL
           AND ($2::char(64) IS NULL OR token_hash <> $2)`,
        [empresaId, exceptTokenHash || null]
      );
    },

    // --- panel del puesto ---------------------------------------------------
    // Cifras agregadas de SU puesto. Nunca datos de personas identificables:
    // el puesto no tiene por que saber quien le escaneo, solo cuantos.
    async statsEmpresa(empresaId, tz) {
      const res = await q(
        `SELECT
           (SELECT COUNT(*)::int FROM insignias WHERE empresa_id = $1) AS insignias,
           (SELECT COUNT(*)::int FROM scans_log WHERE empresa_id = $1) AS escaneos,
           (SELECT COUNT(*)::int FROM scans_log WHERE empresa_id = $1 AND resultado = 'duplicado') AS repetidos`,
        [empresaId]
      );
      // Solo el dia de hoy y en hora local, por la misma razon que la curva
      // del organizador.
      const porHora = await q(
        `SELECT to_char(date_trunc('hour', created_at AT TIME ZONE $2::text), 'HH24:00') AS hora,
                COUNT(*)::int AS n
         FROM insignias WHERE empresa_id = $1
           AND (created_at AT TIME ZONE $2::text)::date = (NOW() AT TIME ZONE $2::text)::date
         GROUP BY 1 ORDER BY 1`,
        [empresaId, tz || 'America/Lima']
      );
      return Object.assign({}, res.rows[0], { porHora: porHora.rows });
    },

    async findEmpresaByQr(eventoId, token) {
      const res = await q(
        'SELECT * FROM empresas WHERE evento_id = $1 AND qr_token = $2 AND activo = true',
        [eventoId, token]
      );
      return res.rows[0] || null;
    },

    // Codigo IMPRESO bajo el QR. Publico: lo teclean los asistentes cuando la
    // camara no lee. No sirve para iniciar sesion.
    async findEmpresaByCodigo(eventoId, codigo) {
      const res = await q(
        `SELECT * FROM empresas
         WHERE evento_id = $1 AND UPPER(codigo_corto) = UPPER($2) AND activo = true`,
        [eventoId, codigo]
      );
      return res.rows[0] || null;
    },

    // Identificador de ACCESO del responsable del puesto. Distinto del codigo
    // impreso a proposito: ese esta a la vista de todo el recinto.
    async findEmpresaByUsuario(eventoId, usuario) {
      const res = await q(
        `SELECT * FROM empresas
         WHERE evento_id = $1 AND LOWER(usuario) = LOWER($2)`,
        [eventoId, usuario]
      );
      return res.rows[0] || null;
    },

    async createEmpresa(e) {
      const res = await q(
        `INSERT INTO empresas
           (evento_id, nombre, rubro, emoji, color, descripcion, stand,
            condicion, qr_token, codigo_corto, usuario, telefono, activo,
            password_hash, password_salt, password_algo, password_updated_at,
            must_change_password, temp_password_expires_at, es_prueba)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id, evento_id, nombre, rubro, emoji, color, descripcion,
                   stand, condicion, qr_token, codigo_corto, usuario, telefono,
                   activo, created_at, must_change_password, temp_password_expires_at, es_prueba`,
        [e.evento_id, e.nombre, e.rubro, e.emoji, e.color, e.descripcion,
          e.stand, e.condicion, e.qr_token, e.codigo_corto, e.usuario, e.telefono,
          e.password_hash, e.password_salt, e.password_algo, e.password_updated_at,
          e.must_change_password === true, e.temp_password_expires_at, e.es_prueba === true]
      );
      return res.rows[0];
    },

    // --- insignias ----------------------------------------------------------
    // El numero de ticket de sorteo se calcula DENTRO del mismo INSERT, contando
    // las insignias ya emitidas. Hacerlo en dos pasos (leer el total, luego
    // insertar) daria numeros repetidos cuando dos personas escanean a la vez.
    // Si ya existe la insignia, ON CONFLICT no devuelve fila: eso es el
    // duplicado, y lo decide la base de datos, no el navegador.
    async crearInsignia(eventoId, ticketId, empresaId, deviceId) {
      const res = await q(
        // El numero salia de COUNT(*)+1: dos personas escaneando a la vez veian
        // el mismo recuento y se llevaban el mismo boleto. La secuencia no
        // repite nunca. Un duplicado consume un numero y deja un hueco, que da
        // igual: el numero identifica al boleto, no cuenta cuantos hay.
        `INSERT INTO insignias (evento_id, ticket_id, empresa_id, ticket_sorteo, device_id)
         VALUES ($1, $2, $3, nextval('insignias_ticket_seq'), $4)
         ON CONFLICT ON CONSTRAINT insignia_unica_por_puesto DO NOTHING
         RETURNING *`,
        [eventoId, ticketId, empresaId, deviceId]
      );
      return res.rows[0] || null;   // null = ya la tenia
    },

    // Se traen tambien los datos publicos del puesto -lo que decidio publicar-
    // para que al tocar una insignia se vea con quien estuvo la persona sin
    // pedir nada mas. Van aqui y no via el catalogo publico porque el catalogo
    // solo lista puestos activos: si manana se desactiva uno, quien ya tiene su
    // insignia debe seguir viendola completa.
    //
    // Sigue sin salir `telefono`: ese es el del responsable, no el de contacto.
    async listInsigniasDe(ticketId) {
      const res = await q(
        `SELECT i.id, i.ticket_sorteo, i.created_at,
                e.id AS empresa_id, e.nombre, e.emoji, e.color, e.rubro, e.stand,
                e.descripcion, e.condicion,
                e.instagram, e.facebook, e.tiktok, e.whatsapp,
                (e.logo_datos IS NOT NULL) AS tiene_logo
         FROM insignias i
         JOIN empresas e ON e.id = i.empresa_id
         WHERE i.ticket_id = $1
         ORDER BY i.created_at`,
        [ticketId]
      );
      return res.rows;
    },

    async contarInsignias(eventoId) {
      const res = await q(
        `SELECT COUNT(*)::int AS total,
                COUNT(DISTINCT ticket_id)::int AS personas
         FROM insignias WHERE evento_id = $1`,
        [eventoId]
      );
      return res.rows[0];
    },

    async logScan(eventoId, ticketId, empresaId, resultado, deviceId) {
      await q(
        `INSERT INTO scans_log (evento_id, ticket_id, empresa_id, resultado, device_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [eventoId, ticketId, empresaId, resultado, deviceId]
      );
    },

    // --- sorteo -------------------------------------------------------------
    async listPremios(eventoId) {
      const res = await q(
        `SELECT p.id, p.orden, p.nombre, p.descripcion, p.empresa_id,
                e.nombre AS empresa_nombre,
                (e.logo_datos IS NOT NULL) AS empresa_tiene_logo,
                (r.id IS NOT NULL) AS sorteado
         FROM premios p
         -- Solo el resultado VIGENTE cuenta como "sorteado": si el ganador no
         -- se presento, el premio vuelve a estar pendiente.
         LEFT JOIN sorteo_resultados r ON r.premio_id = p.id AND r.no_reclamado_at IS NULL
         LEFT JOIN empresas e ON e.id = p.empresa_id
         WHERE p.evento_id = $1
         ORDER BY p.orden`,
        [eventoId]
      );
      return res.rows;
    },

    async createPremio(eventoId, orden, nombre, descripcion, empresaId) {
      const res = await q(
        `INSERT INTO premios (evento_id, orden, nombre, descripcion, empresa_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [eventoId, orden, nombre, descripcion, empresaId || null]
      );
      return res.rows[0];
    },

    async deletePremio(eventoId, id) {
      // No se borra un premio ya sorteado: seria borrar el resultado. Un
      // premio cuyo ganador no se presento tampoco: el resultado desierto es
      // parte del rastro de lo que paso en el escenario.
      const res = await q(
        `DELETE FROM premios
         WHERE id = $1 AND evento_id = $2
           AND NOT EXISTS (SELECT 1 FROM sorteo_resultados r WHERE r.premio_id = premios.id)
         RETURNING id`,
        [id, eventoId]
      );
      return res.rowCount > 0;
    },

    async siguienteOrdenPremio(eventoId) {
      const res = await q(
        'SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM premios WHERE evento_id = $1',
        [eventoId]
      );
      return res.rows[0].n;
    },

    // Participantes del bombo: quien tenga al menos una insignia, tenga su
    // nombre puesto y no haya ganado ya. `boletos` es el numero de insignias, y
    // cada insignia es un boleto: quien visito cinco puestos tiene cinco veces
    // mas probabilidad.
    //
    // Sin nombre no se participa: quien fue registrado en puerta solo con su
    // documento y no completo sus datos no puede ser anunciado en la pantalla
    // del sorteo. La app se lo dice para que lo complete.
    // `soloPresentes` deja fuera a quien no tiene el ingreso validado en este
    // momento. El evento dura dos dias: el domingo, despues de reiniciar los
    // ingresos, quien vino solo el sabado seguia en el bombo con todas sus
    // insignias y podia salir premiado desde su casa. Sacar un nombre que no
    // esta en el recinto deja el premio colgado y enfria al publico.
    //
    // Quien ya salio premiado no vuelve, aunque aquel premio quedara desierto:
    // pierde el turno. Por eso el NOT EXISTS no mira `no_reclamado_at`.
    async participantesSorteo(eventoId, opciones) {
      const soloPresentes = !opciones || opciones.soloPresentes !== false;
      const res = await q(
        `SELECT t.id AS ticket_id, t.nombre, t.apellido, t.codigo_ticket,
                COUNT(i.id)::int AS boletos
         FROM asistentes_tickets t
         JOIN insignias i ON i.ticket_id = t.id
         WHERE t.evento_id = $1
           AND t.nombre IS NOT NULL AND btrim(t.nombre) <> ''
           AND ($2::boolean = false OR t.estado = 'checkin')
           AND NOT EXISTS (
             SELECT 1 FROM sorteo_resultados r
             WHERE r.evento_id = $1 AND r.ticket_id = t.id
           )
         GROUP BY t.id, t.nombre, t.apellido, t.codigo_ticket
         HAVING COUNT(i.id) > 0
         ORDER BY t.id`,
        [eventoId, soloPresentes]
      );
      return res.rows;
    },

    // Declara desierto un resultado. No borra: marca. El premio vuelve a estar
    // pendiente y queda el rastro de quien habia salido.
    async marcarNoReclamado(eventoId, resultadoId, por) {
      const res = await q(
        `UPDATE sorteo_resultados
            SET no_reclamado_at = NOW(), no_reclamado_por = $3
          WHERE id = $1 AND evento_id = $2 AND no_reclamado_at IS NULL
          RETURNING *`,
        [resultadoId, eventoId, por]
      );
      return res.rows[0] || null;
    },

    async registrarResultadoSorteo(r) {
      const res = await q(
        `INSERT INTO sorteo_resultados
           (evento_id, premio_id, ticket_id, boletos_ganador, total_boletos,
            total_participantes, semilla, numero_ganador, sorteado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [r.evento_id, r.premio_id, r.ticket_id, r.boletos_ganador, r.total_boletos,
          r.total_participantes, r.semilla, r.numero_ganador, r.sorteado_por]
      );
      return res.rows[0];
    },

    async listGanadores(eventoId) {
      // Se devuelven tambien los desiertos, con su marca: un premio que se
      // sorteo dos veces tiene dos filas y las dos se ven. Por eso el orden
      // secundario es la fecha.
      const res = await q(
        `SELECT r.id, p.orden, p.nombre AS premio,
                t.nombre, t.apellido, t.codigo_ticket,
                r.boletos_ganador, r.total_boletos, r.total_participantes,
                r.semilla, r.numero_ganador, r.sorteado_por, r.created_at,
                r.no_reclamado_at, r.no_reclamado_por
         FROM sorteo_resultados r
         JOIN premios p ON p.id = r.premio_id
         LEFT JOIN asistentes_tickets t ON t.id = r.ticket_id
         WHERE r.evento_id = $1
         ORDER BY p.orden, r.created_at`,
        [eventoId]
      );
      return res.rows;
    },

    // El premio que ha ganado ESTA persona, para que su app se lo diga. Solo
    // el resultado vigente: si se declaro desierto, ya no tiene premio.
    async premioGanadoPor(eventoId, ticketId) {
      const res = await q(
        `SELECT p.orden, p.nombre, e.nombre AS empresa_nombre, r.created_at
         FROM sorteo_resultados r
         JOIN premios p ON p.id = r.premio_id
         LEFT JOIN empresas e ON e.id = p.empresa_id
         WHERE r.evento_id = $1 AND r.ticket_id = $2 AND r.no_reclamado_at IS NULL
         LIMIT 1`,
        [eventoId, ticketId]
      );
      return res.rows[0] || null;
    },

    // --- datos de prueba ----------------------------------------------------
    async contarDatosPrueba(eventoId) {
      const res = await q(
        `SELECT
           (SELECT COUNT(*)::int FROM asistentes_tickets
            WHERE evento_id = $1 AND es_prueba = true) AS personas,
           (SELECT COUNT(*)::int FROM empresas
            WHERE evento_id = $1 AND es_prueba = true) AS puestos`,
        [eventoId]
      );
      return res.rows[0];
    },

    // Borra SOLO lo marcado como prueba. Insignias, escaneos y sesiones se van
    // en cascada por las claves foraneas.
    //
    // Los resultados de sorteo se borran ANTES y a mano: su clave foranea es
    // ON DELETE SET NULL, asi que al borrar a la persona el premio quedaba
    // "sorteado" con ganador vacio, y ya no se podia volver a sortear ni
    // borrar. Ensayar el sorteo quemaba los premios reales.
    async borrarDatosPrueba(eventoId) {
      const sorteos = await q(
        `DELETE FROM sorteo_resultados r
         USING asistentes_tickets t
         WHERE r.ticket_id = t.id AND t.evento_id = $1 AND t.es_prueba = true`,
        [eventoId]
      );
      const personas = await q(
        'DELETE FROM asistentes_tickets WHERE evento_id = $1 AND es_prueba = true',
        [eventoId]
      );
      const puestos = await q(
        'DELETE FROM empresas WHERE evento_id = $1 AND es_prueba = true',
        [eventoId]
      );
      return { personas: personas.rowCount, puestos: puestos.rowCount, sorteos: sorteos.rowCount };
    },

    // --- usuarios de staff --------------------------------------------------
    async findUsuarioStaff(eventoId, usuario) {
      const res = await q(
        'SELECT * FROM usuarios_staff WHERE evento_id = $1 AND LOWER(usuario) = LOWER($2)',
        [eventoId, usuario]
      );
      return res.rows[0] || null;
    },

    async findUsuarioStaffById(id) {
      const res = await q('SELECT * FROM usuarios_staff WHERE id = $1', [id]);
      return res.rows[0] || null;
    },

    async listUsuariosStaff(eventoId) {
      const res = await q(
        `SELECT id, usuario, nombre, rol, activo, must_change_password,
                temp_password_expires_at, creado_por, created_at,
                (password_hash IS NOT NULL) AS tiene_clave
         FROM usuarios_staff WHERE evento_id = $1 ORDER BY rol, usuario`,
        [eventoId]
      );
      return res.rows;
    },

    async createUsuarioStaff(u) {
      const res = await q(
        `INSERT INTO usuarios_staff
           (evento_id, usuario, nombre, rol, password_hash, password_salt,
            password_algo, password_updated_at, must_change_password,
            temp_password_expires_at, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, usuario, nombre, rol, activo, must_change_password,
                   temp_password_expires_at, creado_por, created_at`,
        [u.evento_id, u.usuario, u.nombre, u.rol, u.password_hash, u.password_salt,
          u.password_algo, u.password_updated_at, u.must_change_password !== false,
          u.temp_password_expires_at, u.creado_por]
      );
      return res.rows[0];
    },

    async updateUsuarioStaff(id, patch) {
      const cols = Object.keys(patch).filter(k => STAFF_UPDATABLE.includes(k));
      if (!cols.length) return driver.findUsuarioStaffById(id);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const res = await q(
        `UPDATE usuarios_staff SET ${sets} WHERE id = $1 RETURNING *`,
        [id, ...cols.map(c => patch[c])]
      );
      return res.rows[0] || null;
    },

    // --- sesiones de staff --------------------------------------------------
    async createStaffSession(usuarioId, tokenHash, deviceId, expiresAt) {
      const res = await q(
        `INSERT INTO sesiones_staff (usuario_id, token_hash, device_id, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [usuarioId, tokenHash, deviceId, expiresAt]
      );
      return res.rows[0];
    },

    async findStaffSession(tokenHash) {
      const res = await q(
        `SELECT * FROM sesiones_staff
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [tokenHash]
      );
      return res.rows[0] || null;
    },

    async touchStaffSession(id) {
      await q('UPDATE sesiones_staff SET last_seen_at = NOW() WHERE id = $1', [id]);
    },

    async revokeStaffSession(tokenHash) {
      await q(
        'UPDATE sesiones_staff SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
        [tokenHash]
      );
    },

    async revokeAllStaffSessions(usuarioId, exceptTokenHash) {
      await q(
        `UPDATE sesiones_staff SET revoked_at = NOW()
         WHERE usuario_id = $1 AND revoked_at IS NULL
           AND ($2::char(64) IS NULL OR token_hash <> $2)`,
        [usuarioId, exceptTokenHash || null]
      );
    },

    // --- bitacora de acciones -----------------------------------------------
    async logAccionStaff(eventoId, usuarioId, usuarioNombre, accion, detalle) {
      await q(
        `INSERT INTO acciones_staff (evento_id, usuario_id, usuario_nombre, accion, detalle)
         VALUES ($1, $2, $3, $4, $5)`,
        [eventoId, usuarioId, usuarioNombre, accion, detalle]
      );
    },

    async listAccionesStaff(eventoId, limit = 50) {
      const res = await q(
        `SELECT usuario_nombre, accion, detalle, created_at
         FROM acciones_staff WHERE evento_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [eventoId, limit]
      );
      return res.rows;
    },

    // --- exportacion --------------------------------------------------------
    // Vuelca todo lo exportable de una vez. Se usa para el respaldo y para el
    // informe posterior al evento; lleva datos personales, asi que la ruta que
    // lo consume exige token de staff.
    async exportarAsistentes(eventoId) {
      const res = await q(
        `SELECT codigo_ticket, dni, nombre, apellido, email, celular,
                tipo_ticket, estado, checkin_count, ultimo_checkin,
                origen, creado_por, consentimiento, consentimiento_at,
                consentimiento_via, acepta_marketing, created_at,
                (SELECT COUNT(*) FROM insignias i WHERE i.ticket_id = t.id) AS insignias
         FROM asistentes_tickets t
         WHERE evento_id = $1 ORDER BY created_at`,
        [eventoId]
      );
      return res.rows;
    },

    async exportarCheckins(eventoId) {
      const res = await q(
        `SELECT c.created_at, c.puerta, c.staff_nombre, c.resultado,
                t.codigo_ticket, t.nombre, t.apellido, t.dni
         FROM checkins_log c
         JOIN asistentes_tickets t ON t.id = c.ticket_id
         WHERE t.evento_id = $1 ORDER BY c.created_at`,
        [eventoId]
      );
      return res.rows;
    },

    async exportarInsignias(eventoId) {
      const res = await q(
        `SELECT i.created_at, i.ticket_sorteo,
                t.codigo_ticket, t.dni, t.nombre, t.apellido,
                e.nombre AS puesto, e.stand
         FROM insignias i
         JOIN asistentes_tickets t ON t.id = i.ticket_id
         JOIN empresas e ON e.id = i.empresa_id
         WHERE i.evento_id = $1 ORDER BY i.ticket_sorteo`,
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
// Fecha (AAAA-MM-DD) y hora (HH:00) de un instante en la zona horaria del
// evento. Replican lo que hace `AT TIME ZONE` en PostgreSQL.
function fechaLocal(d, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}
function horaLocal(d, tz) {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'America/Lima', hour: '2-digit', hour12: false
  }).format(d);
  return String(h).padStart(2, '0').slice(0, 2) + ':00';
}

function memoryDriver() {
  const db = {
    evento: null, asistentes: [], sesiones: [], checkins: [], resets: [],
    empresas: [], insignias: [], scans: [], sesionesEmpresa: [],
    usuariosStaff: [], sesionesStaff: [], acciones: [],
    premios: [], sorteoResultados: []
  };
  const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
  let seq = 0;
  const uid = () => 'mem-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);

  // Vista de un puesto sin secretos ni binarios, equivalente a la proyeccion
  // que hace PostgreSQL en sus consultas.
  function vistaEmpresa(e, conToken) {
    if (!e) return null;
    const c = {};
    ['id', 'evento_id', 'nombre', 'rubro', 'emoji', 'color', 'descripcion',
      'stand', 'condicion', 'codigo_corto', 'usuario', 'activo', 'ruc', 'responsable',
      'telefono', 'email', 'instagram', 'facebook', 'tiktok', 'whatsapp', 'created_at', 'must_change_password',
      'temp_password_expires_at', 'logo_actualizado_at'
    ].forEach(k => { c[k] = e[k]; });
    c.tiene_logo = !!e.logo_datos;
    c.tiene_acceso = !!e.password_hash;
    if (conToken) c.qr_token = e.qr_token;
    return c;
  }

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

    async checkinTimeline(eventoId, tz) {
      const ids = new Set(db.asistentes.filter(a => a.evento_id === eventoId).map(a => a.id));
      const porHora = new Map();
      const hoy = fechaLocal(new Date(), tz);
      db.checkins
        .filter(c => ids.has(c.ticket_id) && c.resultado === 'exitoso' &&
          fechaLocal(new Date(c.created_at), tz) === hoy)
        .forEach(c => {
          const hora = horaLocal(new Date(c.created_at), tz);
          porHora.set(hora, (porHora.get(hora) || 0) + 1);
        });
      return [...porHora.entries()]
        .map(([hora, ingresos]) => ({ hora, ingresos }))
        .sort((a, b) => a.hora.localeCompare(b.hora));
    },

    async reiniciarIngresos(eventoId) {
      let n = 0;
      db.asistentes.forEach(a => {
        if (a.evento_id === eventoId && a.estado === 'checkin') { a.estado = 'valido'; n++; }
      });
      return n;
    },

    // Mismo criterio que el driver de PostgreSQL: solo vuelve quien tiene un
    // ingreso exitoso registrado hoy.
    async deshacerReinicio(eventoId, tz) {
      const hoy = fechaLocal(new Date(), tz);
      let n = 0;
      db.asistentes.forEach(a => {
        if (a.evento_id !== eventoId || a.estado !== 'valido') return;
        const entroHoy = db.checkins.some(c =>
          c.ticket_id === a.id && c.resultado === 'exitoso' &&
          fechaLocal(new Date(c.created_at), tz) === hoy
        );
        if (entroHoy) { a.estado = 'checkin'; n++; }
      });
      return n;
    },

    async countByTipo(eventoId) {
      const porTipo = new Map();
      db.asistentes
        .filter(a => a.evento_id === eventoId)
        .forEach(a => porTipo.set(a.tipo_ticket, (porTipo.get(a.tipo_ticket) || 0) + 1));
      return [...porTipo.entries()].map(([tipo_ticket, n]) => ({ tipo_ticket, n }));
    },

    // --- puestos participantes ----------------------------------------------
    async listEmpresas(eventoId) {
      return db.empresas
        .filter(e => e.evento_id === eventoId && e.activo !== false)
        .map(e => vistaEmpresa(e, false));
    },

    async listEmpresasConToken(eventoId) {
      return db.empresas.filter(e => e.evento_id === eventoId).map(e => vistaEmpresa(e, true));
    },

    async findEmpresaById(id) {
      const e = db.empresas.find(x => x.id === id);
      if (!e) return null;
      // Aqui si viajan hash y sal: lo usa la verificacion de contrasena, igual
      // que en PostgreSQL. Las rutas lo filtran antes de responder.
      return Object.assign(vistaEmpresa(e, true), {
        password_hash: e.password_hash,
        password_salt: e.password_salt,
        failed_login_count: e.failed_login_count,
        locked_until: e.locked_until
      });
    },

    async getLogo(empresaId) {
      const e = db.empresas.find(x => x.id === empresaId);
      if (!e || !e.logo_datos) return null;
      return { logo_mime: e.logo_mime, logo_datos: e.logo_datos, logo_actualizado_at: e.logo_actualizado_at };
    },

    async updateEmpresa(id, patch) {
      const e = db.empresas.find(x => x.id === id);
      if (!e) return null;
      Object.keys(patch)
        .filter(k => EMPRESA_UPDATABLE.includes(k))
        .forEach(k => { e[k] = patch[k]; });
      return this.findEmpresaById(id);
    },

    async createEmpresaSession(empresaId, tokenHash, deviceId, expiresAt) {
      const s = {
        id: uid(), empresa_id: empresaId, token_hash: tokenHash, device_id: deviceId,
        created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
        expires_at: new Date(expiresAt).toISOString(), revoked_at: null
      };
      db.sesionesEmpresa.push(s);
      return clone(s);
    },

    async findEmpresaSession(tokenHash) {
      const s = db.sesionesEmpresa.find(x => x.token_hash === tokenHash && !x.revoked_at &&
        new Date(x.expires_at).getTime() > Date.now());
      return clone(s || null);
    },

    async touchEmpresaSession(id) {
      const s = db.sesionesEmpresa.find(x => x.id === id);
      if (s) s.last_seen_at = new Date().toISOString();
    },

    async revokeEmpresaSession(tokenHash) {
      const s = db.sesionesEmpresa.find(x => x.token_hash === tokenHash);
      if (s && !s.revoked_at) s.revoked_at = new Date().toISOString();
    },

    async revokeAllEmpresaSessions(empresaId, exceptTokenHash) {
      db.sesionesEmpresa.forEach(s => {
        if (s.empresa_id === empresaId && !s.revoked_at && s.token_hash !== exceptTokenHash) {
          s.revoked_at = new Date().toISOString();
        }
      });
    },

    async statsEmpresa(empresaId, tz) {
      const insignias = db.insignias.filter(i => i.empresa_id === empresaId);
      const escaneos = db.scans.filter(s => s.empresa_id === empresaId);
      const porHora = new Map();
      const hoy = fechaLocal(new Date(), tz);
      insignias
        .filter(i => fechaLocal(new Date(i.created_at), tz) === hoy)
        .forEach(i => {
          const h = horaLocal(new Date(i.created_at), tz);
          porHora.set(h, (porHora.get(h) || 0) + 1);
        });
      return {
        insignias: insignias.length,
        escaneos: escaneos.length,
        repetidos: escaneos.filter(s => s.resultado === 'duplicado').length,
        porHora: [...porHora.entries()].map(([hora, n]) => ({ hora, n }))
          .sort((a, b) => a.hora.localeCompare(b.hora))
      };
    },

    async findEmpresaByQr(eventoId, token) {
      return clone(db.empresas.find(e => e.evento_id === eventoId &&
        e.qr_token === token && e.activo !== false) || null);
    },

    async findEmpresaByCodigo(eventoId, codigo) {
      const c = String(codigo || '').toUpperCase();
      return clone(db.empresas.find(e => e.evento_id === eventoId &&
        String(e.codigo_corto).toUpperCase() === c && e.activo !== false) || null);
    },

    async findEmpresaByUsuario(eventoId, usuario) {
      const u = String(usuario || '').toLowerCase();
      return clone(db.empresas.find(e => e.evento_id === eventoId &&
        String(e.usuario || '').toLowerCase() === u && u) || null);
    },

    async createEmpresa(e) {
      const row = Object.assign({ id: uid(), activo: true, created_at: new Date().toISOString() }, e);
      db.empresas.push(row);
      return clone(row);
    },

    // --- insignias ----------------------------------------------------------
    async crearInsignia(eventoId, ticketId, empresaId, deviceId) {
      // Misma regla que el indice unico de PostgreSQL.
      const yaLaTiene = db.insignias.some(i => i.ticket_id === ticketId && i.empresa_id === empresaId);
      if (yaLaTiene) return null;
      const row = {
        id: uid(),
        evento_id: eventoId,
        ticket_id: ticketId,
        empresa_id: empresaId,
        ticket_sorteo: db.insignias.filter(i => i.evento_id === eventoId).length + 1,
        device_id: deviceId,
        created_at: new Date().toISOString()
      };
      db.insignias.push(row);
      return clone(row);
    },

    async listInsigniasDe(ticketId) {
      return db.insignias
        .filter(i => i.ticket_id === ticketId)
        .map(i => {
          const e = db.empresas.find(x => x.id === i.empresa_id) || {};
          return {
            id: i.id, ticket_sorteo: i.ticket_sorteo, created_at: i.created_at,
            empresa_id: i.empresa_id, nombre: e.nombre, emoji: e.emoji,
            color: e.color, rubro: e.rubro, stand: e.stand,
            descripcion: e.descripcion, condicion: e.condicion,
            instagram: e.instagram, facebook: e.facebook,
            tiktok: e.tiktok, whatsapp: e.whatsapp,
            tiene_logo: !!e.logo_datos
          };
        })
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    },

    async contarInsignias(eventoId) {
      const propias = db.insignias.filter(i => i.evento_id === eventoId);
      return {
        total: propias.length,
        personas: new Set(propias.map(i => i.ticket_id)).size
      };
    },

    async logScan(eventoId, ticketId, empresaId, resultado, deviceId) {
      db.scans.push({
        id: uid(), evento_id: eventoId, ticket_id: ticketId, empresa_id: empresaId,
        resultado, device_id: deviceId, created_at: new Date().toISOString()
      });
    },

    // --- sorteo -------------------------------------------------------------
    async listPremios(eventoId) {
      return db.premios
        .filter(p => p.evento_id === eventoId)
        .map(p => {
          const e = db.empresas.find(x => x.id === p.empresa_id);
          return Object.assign(clone(p), {
            empresa_nombre: e ? e.nombre : null,
            empresa_tiene_logo: !!(e && e.logo_datos),
            // Solo el resultado vigente cuenta: un premio cuyo ganador no se
            // presento vuelve a estar pendiente.
            sorteado: db.sorteoResultados.some(r => r.premio_id === p.id && !r.no_reclamado_at)
          });
        })
        .sort((a, b) => a.orden - b.orden);
    },

    async createPremio(eventoId, orden, nombre, descripcion, empresaId) {
      const row = {
        id: uid(), evento_id: eventoId, orden, nombre, descripcion,
        empresa_id: empresaId || null,
        created_at: new Date().toISOString()
      };
      db.premios.push(row);
      return clone(row);
    },

    async deletePremio(eventoId, id) {
      const i = db.premios.findIndex(p => p.id === id && p.evento_id === eventoId);
      if (i < 0) return false;
      if (db.sorteoResultados.some(r => r.premio_id === id)) return false;
      db.premios.splice(i, 1);
      return true;
    },

    async siguienteOrdenPremio(eventoId) {
      return db.premios.filter(p => p.evento_id === eventoId)
        .reduce((m, p) => Math.max(m, p.orden), 0) + 1;
    },

    // Mismo criterio que el driver de PostgreSQL: solo quien esta dentro, y
    // quien ya salio premiado no vuelve aunque aquel premio quedara desierto.
    async participantesSorteo(eventoId, opciones) {
      const soloPresentes = !opciones || opciones.soloPresentes !== false;
      const yaGanaron = new Set(db.sorteoResultados
        .filter(r => r.evento_id === eventoId).map(r => r.ticket_id));
      return db.asistentes
        .filter(t => t.evento_id === eventoId && !yaGanaron.has(t.id) &&
          t.nombre && String(t.nombre).trim() &&
          (!soloPresentes || t.estado === 'checkin'))
        .map(t => ({
          ticket_id: t.id, nombre: t.nombre, apellido: t.apellido,
          codigo_ticket: t.codigo_ticket,
          boletos: db.insignias.filter(i => i.ticket_id === t.id).length
        }))
        .filter(p => p.boletos > 0);
    },

    async registrarResultadoSorteo(r) {
      // El indice parcial de PostgreSQL impide dos resultados vigentes para el
      // mismo premio. Aqui se imita, con el mismo codigo de error que usa el
      // handler para responder 409.
      const vigente = db.sorteoResultados.find(
        x => x.premio_id === r.premio_id && !x.no_reclamado_at
      );
      if (vigente) {
        const err = new Error('Ese premio ya fue sorteado.');
        err.code = '23505';
        throw err;
      }
      const row = Object.assign(
        { id: uid(), created_at: new Date().toISOString(), no_reclamado_at: null, no_reclamado_por: null },
        r
      );
      db.sorteoResultados.push(row);
      return clone(row);
    },

    async marcarNoReclamado(eventoId, resultadoId, por) {
      const r = db.sorteoResultados.find(
        x => x.id === resultadoId && x.evento_id === eventoId && !x.no_reclamado_at
      );
      if (!r) return null;
      r.no_reclamado_at = new Date().toISOString();
      r.no_reclamado_por = por;
      return clone(r);
    },

    async listGanadores(eventoId) {
      return db.sorteoResultados
        .filter(r => r.evento_id === eventoId)
        .map(r => {
          const p = db.premios.find(x => x.id === r.premio_id) || {};
          const t = db.asistentes.find(x => x.id === r.ticket_id) || {};
          return {
            id: r.id,
            orden: p.orden, premio: p.nombre,
            nombre: t.nombre, apellido: t.apellido, codigo_ticket: t.codigo_ticket,
            boletos_ganador: r.boletos_ganador, total_boletos: r.total_boletos,
            total_participantes: r.total_participantes, semilla: r.semilla,
            numero_ganador: r.numero_ganador, sorteado_por: r.sorteado_por,
            created_at: r.created_at,
            no_reclamado_at: r.no_reclamado_at || null,
            no_reclamado_por: r.no_reclamado_por || null
          };
        })
        .sort((a, b) => (a.orden || 0) - (b.orden || 0) ||
          String(a.created_at).localeCompare(String(b.created_at)));
    },

    async premioGanadoPor(eventoId, ticketId) {
      const r = db.sorteoResultados.find(x =>
        x.evento_id === eventoId && x.ticket_id === ticketId && !x.no_reclamado_at);
      if (!r) return null;
      const p = db.premios.find(x => x.id === r.premio_id) || {};
      const e = db.empresas.find(x => x.id === p.empresa_id) || {};
      return { orden: p.orden, nombre: p.nombre, empresa_nombre: e.nombre || null, created_at: r.created_at };
    },

    // --- datos de prueba ----------------------------------------------------
    async contarDatosPrueba(eventoId) {
      return {
        personas: db.asistentes.filter(a => a.evento_id === eventoId && a.es_prueba).length,
        puestos: db.empresas.filter(e => e.evento_id === eventoId && e.es_prueba).length
      };
    },

    async borrarDatosPrueba(eventoId) {
      const personasFuera = db.asistentes.filter(a => a.evento_id === eventoId && a.es_prueba);
      const puestosFuera = db.empresas.filter(e => e.evento_id === eventoId && e.es_prueba);
      const idsP = new Set(personasFuera.map(a => a.id));
      const idsE = new Set(puestosFuera.map(e => e.id));

      // En memoria no hay cascada: se replica a mano lo que hacen las claves
      // foraneas de PostgreSQL.
      db.asistentes = db.asistentes.filter(a => !idsP.has(a.id));
      db.empresas = db.empresas.filter(e => !idsE.has(e.id));
      db.insignias = db.insignias.filter(i => !idsP.has(i.ticket_id) && !idsE.has(i.empresa_id));
      db.scans = db.scans.filter(s => !idsP.has(s.ticket_id) && !idsE.has(s.empresa_id));
      db.checkins = db.checkins.filter(c => !idsP.has(c.ticket_id));
      db.sesiones = db.sesiones.filter(s => !idsP.has(s.ticket_id));
      db.sesionesEmpresa = db.sesionesEmpresa.filter(s => !idsE.has(s.empresa_id));
      const antes = db.sorteoResultados.length;
      db.sorteoResultados = db.sorteoResultados.filter(r => !idsP.has(r.ticket_id));
      db.premios.forEach(p => { if (idsE.has(p.empresa_id)) p.empresa_id = null; });

      return {
        personas: personasFuera.length,
        puestos: puestosFuera.length,
        sorteos: antes - db.sorteoResultados.length
      };
    },

    // --- usuarios de staff --------------------------------------------------
    async findUsuarioStaff(eventoId, usuario) {
      const u = String(usuario || '').toLowerCase();
      return clone(db.usuariosStaff.find(x => x.evento_id === eventoId &&
        String(x.usuario).toLowerCase() === u) || null);
    },

    async findUsuarioStaffById(id) {
      return clone(db.usuariosStaff.find(x => x.id === id) || null);
    },

    async listUsuariosStaff(eventoId) {
      return db.usuariosStaff
        .filter(u => u.evento_id === eventoId)
        .map(u => ({
          id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol,
          activo: u.activo, must_change_password: u.must_change_password,
          temp_password_expires_at: u.temp_password_expires_at,
          creado_por: u.creado_por, created_at: u.created_at,
          tiene_clave: !!u.password_hash
        }))
        .sort((a, b) => (a.rol + a.usuario).localeCompare(b.rol + b.usuario));
    },

    async createUsuarioStaff(u) {
      const existe = db.usuariosStaff.some(x => x.evento_id === u.evento_id &&
        String(x.usuario).toLowerCase() === String(u.usuario).toLowerCase());
      if (existe) {
        const err = new Error('usuario duplicado');
        err.code = '23505';
        throw err;
      }
      const row = Object.assign({
        id: uid(), activo: true, failed_login_count: 0, locked_until: null,
        created_at: new Date().toISOString()
      }, u, { must_change_password: u.must_change_password !== false });
      db.usuariosStaff.push(row);
      return clone(row);
    },

    async updateUsuarioStaff(id, patch) {
      const u = db.usuariosStaff.find(x => x.id === id);
      if (!u) return null;
      Object.keys(patch).filter(k => STAFF_UPDATABLE.includes(k))
        .forEach(k => { u[k] = patch[k]; });
      return clone(u);
    },

    async createStaffSession(usuarioId, tokenHash, deviceId, expiresAt) {
      const s = {
        id: uid(), usuario_id: usuarioId, token_hash: tokenHash, device_id: deviceId,
        created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
        expires_at: new Date(expiresAt).toISOString(), revoked_at: null
      };
      db.sesionesStaff.push(s);
      return clone(s);
    },

    async findStaffSession(tokenHash) {
      const s = db.sesionesStaff.find(x => x.token_hash === tokenHash && !x.revoked_at &&
        new Date(x.expires_at).getTime() > Date.now());
      return clone(s || null);
    },

    async touchStaffSession(id) {
      const s = db.sesionesStaff.find(x => x.id === id);
      if (s) s.last_seen_at = new Date().toISOString();
    },

    async revokeStaffSession(tokenHash) {
      const s = db.sesionesStaff.find(x => x.token_hash === tokenHash);
      if (s && !s.revoked_at) s.revoked_at = new Date().toISOString();
    },

    async revokeAllStaffSessions(usuarioId, exceptTokenHash) {
      db.sesionesStaff.forEach(s => {
        if (s.usuario_id === usuarioId && !s.revoked_at && s.token_hash !== exceptTokenHash) {
          s.revoked_at = new Date().toISOString();
        }
      });
    },

    async logAccionStaff(eventoId, usuarioId, usuarioNombre, accion, detalle) {
      db.acciones.unshift({
        id: uid(), evento_id: eventoId, usuario_id: usuarioId,
        usuario_nombre: usuarioNombre, accion, detalle,
        created_at: new Date().toISOString()
      });
    },

    async listAccionesStaff(eventoId, limit = 50) {
      return db.acciones.filter(a => a.evento_id === eventoId).slice(0, limit).map(clone);
    },

    async exportarAsistentes(eventoId) {
      return db.asistentes.filter(a => a.evento_id === eventoId).map(a => ({
        codigo_ticket: a.codigo_ticket, dni: a.dni, nombre: a.nombre,
        apellido: a.apellido, email: a.email, celular: a.celular,
        tipo_ticket: a.tipo_ticket, estado: a.estado,
        checkin_count: a.checkin_count, ultimo_checkin: a.ultimo_checkin,
        origen: a.origen, creado_por: a.creado_por,
        consentimiento: a.consentimiento, consentimiento_at: a.consentimiento_at,
        consentimiento_via: a.consentimiento_via, acepta_marketing: a.acepta_marketing,
        created_at: a.created_at,
        insignias: db.insignias.filter(i => i.ticket_id === a.id).length
      }));
    },

    async exportarCheckins(eventoId) {
      const ids = new Set(db.asistentes.filter(a => a.evento_id === eventoId).map(a => a.id));
      return db.checkins.filter(c => ids.has(c.ticket_id)).map(c => {
        const a = db.asistentes.find(x => x.id === c.ticket_id) || {};
        return {
          created_at: c.created_at, puerta: c.puerta, staff_nombre: c.staff_nombre,
          resultado: c.resultado, codigo_ticket: a.codigo_ticket,
          nombre: a.nombre, apellido: a.apellido, dni: a.dni
        };
      });
    },

    async exportarInsignias(eventoId) {
      return db.insignias.filter(i => i.evento_id === eventoId).map(i => {
        const a = db.asistentes.find(x => x.id === i.ticket_id) || {};
        const e = db.empresas.find(x => x.id === i.empresa_id) || {};
        return {
          created_at: i.created_at, ticket_sorteo: i.ticket_sorteo,
          codigo_ticket: a.codigo_ticket, dni: a.dni, nombre: a.nombre,
          apellido: a.apellido, puesto: e.nombre, stand: e.stand
        };
      }).sort((x, y) => (x.ticket_sorteo || 0) - (y.ticket_sorteo || 0));
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
