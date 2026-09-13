'use strict';
// -----------------------------------------------------------------------------
// Datos de prueba
// -----------------------------------------------------------------------------
// Crea un evento de mentira para ensayar el circuito completo -sobre todo el
// sorteo, que sin participantes no se puede probar- y permite borrarlo entero
// despues.
//
// Todo lo que se genera aqui queda marcado con `es_prueba = true`. Esa marca es
// lo que permite barrerlo de un golpe sin tocar a una sola persona real. Sin
// ella, el dia del evento tendrias asistentes inventados contando en el aforo,
// en los CSV y en el bombo del sorteo.
const { auth } = require('./store');

// Rango de documentos reservado para las pruebas. Empieza por 99 para que no
// choque con un DNI peruano real, que no llega a esas cifras.
const DNI_BASE = 99000000;

const NOMBRES = ['Ana', 'Luis', 'María', 'Diego', 'Rosa', 'Carlos', 'Elena', 'Jorge'];
const APELLIDOS = ['Torres', 'Vega', 'Quispe', 'Morales', 'Flores', 'Ramírez', 'Salas', 'Ríos'];

const PUESTOS = [
  { nombre: 'Sazón de la Nona', usuario: 'prueba.sazon', rubro: 'Comida', emoji: '🍝',
    color: '#E60067', stand: 'A-10', condicion: 'Compra mínima S/ 30' },
  { nombre: 'Bar Cítrico', usuario: 'prueba.citrico', rubro: 'Bebidas', emoji: '🍹',
    color: '#00C2FF', stand: 'B-04', condicion: 'Compra mínima S/ 25' }
];

module.exports = function registrarPrueba(fastify, opciones) {
  const { store, eventoId, rateLimit, requireOrganizador, registrarAccion } = opciones;

  // ---------------------------------------------------------------------------
  // Generar
  // ---------------------------------------------------------------------------
  fastify.post('/api/soporte/datos-prueba', {
    preHandler: [requireOrganizador, rateLimit(10, 60000)]
  }, async (req, reply) => {
    const b = req.body || {};
    const cuantas = Math.min(Math.max(Number(b.personas) || 5, 1), 40);

    const ahora = new Date().toISOString();
    const creadas = { personas: [], puestos: [] };

    // --- puestos ---
    for (const p of PUESTOS) {
      const yaExiste = await store.findEmpresaByUsuario(eventoId, p.usuario);
      if (yaExiste) { creadas.puestos.push(yaExiste); continue; }

      const clave = auth.claveLegible(8);
      const { hash, salt, algo } = auth.hashPassword(clave);
      const empresa = await store.createEmpresa({
        evento_id: eventoId,
        nombre: p.nombre,
        usuario: p.usuario,
        rubro: p.rubro,
        emoji: p.emoji,
        color: p.color,
        stand: p.stand,
        condicion: p.condicion,
        descripcion: 'Puesto de prueba. Se puede borrar sin consecuencias.',
        qr_token: auth.newQrToken(),
        codigo_corto: await codigoCortoLibre(),
        password_hash: hash,
        password_salt: salt,
        password_algo: algo,
        password_updated_at: ahora,
        must_change_password: true,
        temp_password_expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        es_prueba: true
      });
      // La clave se devuelve una vez, por si se quiere entrar como ese puesto.
      creadas.puestos.push(Object.assign({}, empresa, { password_temporal: clave }));
    }

    // --- personas ---
    // Nacen con el ingreso ya validado: sin check-in no pueden escanear, y sin
    // escanear no hay insignias ni sorteo que probar.
    const { hash: hp, salt: sp, algo: ap } = auth.hashPassword(auth.TEMP_PASSWORD);

    for (let i = 0; i < cuantas; i++) {
      const dni = String(DNI_BASE + i);
      const yaExiste = await store.findByDni(eventoId, dni);
      if (yaExiste) { creadas.personas.push(yaExiste); continue; }

      const persona = await store.createAttendee({
        evento_id: eventoId,
        codigo_ticket: `TEST-${1000 + i}`,
        qr_token: auth.newQrToken(),
        dni,
        nombre: NOMBRES[i % NOMBRES.length],
        apellido: APELLIDOS[(i * 3 + 1) % APELLIDOS.length],
        email: null,
        celular: null,
        tipo_ticket: 'general',
        estado: 'checkin',
        checkin_count: 1,
        ultimo_checkin: ahora,
        password_hash: hp,
        password_salt: sp,
        password_algo: ap,
        password_updated_at: ahora,
        must_change_password: true,
        temp_password_expires_at: new Date(Date.now() + auth.TEMP_PASSWORD_TTL_MS).toISOString(),
        consentimiento: true,
        consentimiento_at: ahora,
        consentimiento_texto: 'DATO DE PRUEBA. No corresponde a ninguna persona real.',
        consentimiento_via: 'prueba',
        origen: 'prueba',
        creado_por: (req.actor && req.actor.nombre) || 'Organización',
        es_prueba: true
      });
      creadas.personas.push(persona);
    }

    // --- insignias ---
    // Repartidas de forma desigual a proposito: si todos tuvieran los mismos
    // boletos, el sorteo ponderado no se distinguiria de uno plano y no se
    // podria comprobar que funciona.
    let insignias = 0;
    for (let i = 0; i < creadas.personas.length; i++) {
      const persona = creadas.personas[i];
      // La primera persona visita los dos puestos, el resto alterna.
      const cuantos = (i === 0) ? creadas.puestos.length : ((i % 2 === 0) ? 2 : 1);
      for (let j = 0; j < Math.min(cuantos, creadas.puestos.length); j++) {
        const hecha = await store.crearInsignia(eventoId, persona.id, creadas.puestos[j].id, 'DEV-PRUEBA');
        if (hecha) insignias++;
      }
    }

    await registrarAccion(req, 'generar_datos_prueba',
      `${creadas.personas.length} personas, ${creadas.puestos.length} puestos, ${insignias} insignias`);

    return reply.code(201).send({
      success: true,
      personas: creadas.personas.length,
      puestos: creadas.puestos.map(p => ({
        id: p.id,
        nombre: p.nombre,
        usuario: p.usuario,
        codigo_corto: p.codigo_corto,
        password_temporal: p.password_temporal || null
      })),
      insignias,
      aviso: 'Datos de prueba. Bórralos antes del evento real.'
    });
  });

  // ---------------------------------------------------------------------------
  // Borrar
  // ---------------------------------------------------------------------------
  // Borra SOLO lo marcado como prueba. Las insignias, escaneos y sesiones se
  // van en cascada por las claves foraneas del esquema.
  fastify.delete('/api/soporte/datos-prueba', {
    preHandler: [requireOrganizador, rateLimit(10, 60000)]
  }, async (req, reply) => {
    const borrado = await store.borrarDatosPrueba(eventoId);
    await registrarAccion(req, 'borrar_datos_prueba',
      `${borrado.personas} personas, ${borrado.puestos} puestos`);
    return reply.send({ success: true, borrado });
  });

  // Cuenta lo que hay, para poder avisarlo en pantalla.
  fastify.get('/api/soporte/datos-prueba', { preHandler: requireOrganizador }, async () => {
    return { success: true, conteo: await store.contarDatosPrueba(eventoId) };
  });

  // Codigo corto libre, con el mismo alfabeto legible que el resto.
  async function codigoCortoLibre() {
    const ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let intento = 0; intento < 20; intento++) {
      let c = 'P-';
      for (let i = 0; i < 4; i++) c += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
      if (!(await store.findEmpresaByCodigo(eventoId, c))) return c;
    }
    return 'P-' + Date.now().toString(36).toUpperCase().slice(-5);
  }
};
