'use strict';
// -----------------------------------------------------------------------------
// Dinamica de insignias
// -----------------------------------------------------------------------------
// Cada puesto participante muestra un QR. El asistente lo escanea y gana UNA
// insignia de ese puesto, que vale un ticket para el sorteo.
//
// Antes esto vivia entero en localStorage: la lista de insignias, la regla de
// "una por puesto" y hasta el numero de ticket del sorteo. Cualquiera con la
// consola del navegador podia darse los tickets que quisiera. Ahora:
//
//   * La insignia se crea en PostgreSQL con un indice unico (persona, puesto).
//     El duplicado lo decide la base de datos, no el cliente.
//   * El numero de ticket de sorteo lo asigna el servidor dentro del INSERT.
//   * Todo intento queda en scans_log, valido o no.
//
// Lo que esto NO resuelve: el QR del puesto es estatico e impreso. Si alguien lo
// fotografia y lo comparte por WhatsApp, quien reciba la foto puede ganar la
// insignia sin pasar por el stand. Por eso se exige haber validado el ingreso
// (se esta fisicamente en el evento) y se registra cada escaneo con su
// dispositivo, para que el organizador pueda detectar un QR filtrado.
const { auth } = require('./store');

// Tope de escaneos por minuto y persona. Un recorrido normal son unos pocos
// puestos; un ritmo muy superior es alguien probando codigos.
const ESCANEOS_POR_MINUTO = 20;

module.exports = function registrarInsignias(fastify, opciones) {
  const { store, eventoId, rateLimit, requireAdmin, requireSession, exigirIngreso } = opciones;

  // ---------------------------------------------------------------------------
  // Catalogo publico de puestos
  // ---------------------------------------------------------------------------
  // Sin `qr_token`: si se publicara aqui, cualquiera coleccionaria todas las
  // insignias desde su casa sin pisar el evento.
  fastify.get('/api/empresas', async () => {
    return { success: true, empresas: await store.listEmpresas(eventoId) };
  });

  // ---------------------------------------------------------------------------
  // Escanear el QR de un puesto
  // ---------------------------------------------------------------------------
  fastify.post('/api/insignias/scan', {
    preHandler: [rateLimit(ESCANEOS_POR_MINUTO, 60000), requireSession()]
  }, async (req, reply) => {
    const body = req.body || {};
    const persona = req.persona;
    const device = typeof body.device_id === 'string' ? body.device_id.slice(0, 60) : null;

    // El QR lleva "CFP|<token>". Se acepta tambien el token suelto y el codigo
    // corto impreso debajo, que es la red de seguridad cuando la camara falla.
    let bruto = typeof body.qr === 'string' ? body.qr.trim() : '';
    if (bruto.indexOf('CFP|') === 0) bruto = bruto.slice(4);

    let empresa = null;
    if (bruto) {
      empresa = await store.findEmpresaByQr(eventoId, bruto.slice(0, 64));
      if (!empresa) empresa = await store.findEmpresaByCodigo(eventoId, bruto.slice(0, 20));
    }

    if (!empresa) {
      await store.logScan(eventoId, persona.id, null, 'qr_invalido', device);
      return reply.code(404).send({
        error: 'Ese código no corresponde a ningún puesto del evento.',
        resultado: 'qr_invalido'
      });
    }

    // Hay que estar dentro del evento para coleccionar. Sin esto, basta con que
    // alguien difunda una foto del QR para repartir tickets de sorteo a gente
    // que ni siquiera vino.
    if (exigirIngreso && persona.estado !== 'checkin') {
      await store.logScan(eventoId, persona.id, empresa.id, 'sin_ingreso', device);
      return reply.code(403).send({
        error: 'Primero valida tu ingreso en la puerta del evento.',
        resultado: 'sin_ingreso'
      });
    }

    const insignia = await store.crearInsignia(eventoId, persona.id, empresa.id, device);

    if (!insignia) {
      await store.logScan(eventoId, persona.id, empresa.id, 'duplicado', device);
      return reply.send({
        success: true,
        resultado: 'duplicado',
        message: 'Ya tienes la insignia de ' + empresa.nombre,
        empresa: vistaEmpresa(empresa)
      });
    }

    await store.logScan(eventoId, persona.id, empresa.id, 'ok', device);

    return reply.code(201).send({
      success: true,
      resultado: 'ok',
      message: '+1 insignia · +1 ticket para el sorteo',
      empresa: vistaEmpresa(empresa),
      insignia: {
        ticket_sorteo: insignia.ticket_sorteo,
        created_at: insignia.created_at
      },
      total_insignias: (await store.listInsigniasDe(persona.id)).length
    });
  });

  // ---------------------------------------------------------------------------
  // Mi coleccion
  // ---------------------------------------------------------------------------
  fastify.get('/api/insignias/mias', { preHandler: requireSession() }, async (req) => {
    const insignias = await store.listInsigniasDe(req.persona.id);
    return {
      success: true,
      total: insignias.length,
      tickets_sorteo: insignias.length,   // 1 insignia = 1 ticket
      insignias
    };
  });

  // ---------------------------------------------------------------------------
  // Organizador: alta de puestos
  // ---------------------------------------------------------------------------
  fastify.post('/api/soporte/empresas', {
    preHandler: [requireAdmin, rateLimit(60, 60000)]
  }, async (req, reply) => {
    const b = req.body || {};
    const recorta = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

    const nombre = recorta(b.nombre, 150);
    if (!nombre) return reply.code(400).send({ error: 'El nombre del puesto es obligatorio.' });

    // El puesto nace con su acceso listo: clave temporal aleatoria, con cambio
    // obligatorio en el primer ingreso. Se devuelve UNA vez, para que el
    // organizador se la entregue al responsable; no se guarda en claro.
    const clave = auth.claveLegible(8);
    const { hash, salt, algo } = auth.hashPassword(clave);
    const ahora = new Date().toISOString();

    const empresa = await store.createEmpresa({
      evento_id: eventoId,
      nombre,
      rubro: recorta(b.rubro, 60),
      emoji: recorta(b.emoji, 16) || '🎪',
      color: recorta(b.color, 9) || '#FF5A1F',
      descripcion: recorta(b.descripcion, 1000),
      stand: recorta(b.stand, 30),
      condicion: recorta(b.condicion, 500),
      qr_token: auth.newQrToken(),
      codigo_corto: await codigoCortoLibre(),
      password_hash: hash,
      password_salt: salt,
      password_algo: algo,
      password_updated_at: ahora,
      must_change_password: true,
      temp_password_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    });

    return reply.code(201).send({
      success: true,
      empresa,
      acceso: {
        codigo: empresa.codigo_corto,
        password_temporal: clave,
        dias_validez: 7
      }
    });
  });

  // Listado con los tokens, para que el organizador imprima los carteles.
  fastify.get('/api/soporte/empresas', { preHandler: requireAdmin }, async () => {
    const empresas = await store.listEmpresasConToken(eventoId);
    return {
      success: true,
      empresas: empresas.map(e => Object.assign({}, e, {
        // Contenido exacto que debe llevar el QR impreso del puesto.
        qr_contenido: 'CFP|' + e.qr_token
      }))
    };
  });

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  // Vista publica de un puesto: nunca incluye el token del QR.
  function vistaEmpresa(e) {
    return {
      id: e.id, nombre: e.nombre, rubro: e.rubro, emoji: e.emoji,
      color: e.color, stand: e.stand, condicion: e.condicion,
      tiene_logo: !!e.tiene_logo || !!e.logo_datos
    };
  }

  // Codigo corto legible que se imprime bajo el QR (P-4821). Se evita el 0/O y
  // el 1/I porque se dictan en voz alta y en un evento ruidoso se confunden.
  const ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  async function codigoCortoLibre() {
    for (let intento = 0; intento < 20; intento++) {
      let c = 'P-';
      for (let i = 0; i < 4; i++) c += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
      if (!(await store.findEmpresaByCodigo(eventoId, c))) return c;
    }
    return 'P-' + Date.now().toString(36).toUpperCase().slice(-5);
  }
};
