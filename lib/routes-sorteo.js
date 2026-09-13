'use strict';
// -----------------------------------------------------------------------------
// Sorteo
// -----------------------------------------------------------------------------
// Reglas del evento:
//
//   * Los premios se registran ANTES y en orden (1º, 2º, 3º...). Sortear a
//     ciegas y decidir el premio despues seria manipulable.
//   * Participa quien tenga al menos una insignia.
//   * Cada insignia es un boleto: quien visito cinco puestos tiene cinco veces
//     mas probabilidad. Es lo que la app le prometio a la gente en cada escaneo.
//   * Nadie gana dos veces: los ganadores salen del bombo para los siguientes.
//
// DONDE OCURRE EL SORTEO
// El ganador lo decide EL SERVIDOR y queda grabado antes de que la pantalla
// empiece a girar. La animacion de ruleta es puro teatro: si el sorteo se
// resolviera en el navegador, cualquiera con la consola abierta podria elegir
// quien gana delante de todo el publico.
//
// AUDITORIA
// De cada sorteo se guarda la semilla, el numero que salio, cuantos boletos
// habia y cuantos participantes. Con eso el resultado es reproducible y
// defendible si alguien lo cuestiona.
const crypto = require('crypto');

function texto(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

module.exports = function registrarSorteo(fastify, opciones) {
  const { store, eventoId, rateLimit, requireOrganizador, registrarAccion } = opciones;

  // ---------------------------------------------------------------------------
  // Premios
  // ---------------------------------------------------------------------------
  fastify.get('/api/sorteo/premios', { preHandler: requireOrganizador }, async () => {
    return { success: true, premios: await store.listPremios(eventoId) };
  });

  fastify.post('/api/sorteo/premios', {
    preHandler: [requireOrganizador, rateLimit(60, 60000)]
  }, async (req, reply) => {
    const b = req.body || {};
    const nombre = texto(b.nombre, 150);
    if (!nombre) return reply.code(400).send({ error: 'El nombre del premio es obligatorio.' });

    const orden = Number(b.orden) > 0
      ? Math.floor(Number(b.orden))
      : await store.siguienteOrdenPremio(eventoId);

    // Puesto que regala el premio. Se comprueba que exista y que sea de ESTE
    // evento: sin eso, un id de otro evento colaría por la clave foránea.
    let empresaId = null;
    if (b.empresa_id) {
      const empresa = await store.findEmpresaById(b.empresa_id);
      if (!empresa || empresa.evento_id !== eventoId) {
        return reply.code(400).send({ error: 'Ese puesto no existe en este evento.' });
      }
      empresaId = empresa.id;
    }

    try {
      const premio = await store.createPremio(eventoId, orden, nombre, texto(b.descripcion, 500), empresaId);
      await registrarAccion(req, 'crear_premio', `${orden}º · ${nombre}`);
      return reply.code(201).send({ success: true, premio });
    } catch (err) {
      if (err && err.code === '23505') {
        return reply.code(409).send({ error: `Ya hay un premio en la posición ${orden}.` });
      }
      throw err;
    }
  });

  fastify.delete('/api/sorteo/premios/:id', {
    preHandler: [requireOrganizador, rateLimit(60, 60000)]
  }, async (req, reply) => {
    const ok = await store.deletePremio(eventoId, req.params.id);
    if (!ok) {
      return reply.code(409).send({
        error: 'No se puede borrar: o no existe, o ya fue sorteado. Un premio sorteado no se elimina.'
      });
    }
    await registrarAccion(req, 'borrar_premio', req.params.id);
    return { success: true };
  });

  // ---------------------------------------------------------------------------
  // Estado del sorteo
  // ---------------------------------------------------------------------------
  fastify.get('/api/sorteo/estado', { preHandler: requireOrganizador }, async () => {
    const premios = await store.listPremios(eventoId);
    const participantes = await store.participantesSorteo(eventoId);
    const ganadores = await store.listGanadores(eventoId);

    const totalBoletos = participantes.reduce((s, p) => s + p.boletos, 0);
    const pendientes = premios.filter(p => !p.sorteado);

    return {
      success: true,
      premios,
      siguiente: pendientes[0] || null,
      pendientes: pendientes.length,
      participantes: participantes.length,
      total_boletos: totalBoletos,
      ganadores
    };
  });

  fastify.get('/api/sorteo/ganadores', { preHandler: requireOrganizador }, async () => {
    return { success: true, ganadores: await store.listGanadores(eventoId) };
  });

  // ---------------------------------------------------------------------------
  // Jugar
  // ---------------------------------------------------------------------------
  fastify.post('/api/sorteo/jugar', {
    preHandler: [requireOrganizador, rateLimit(30, 60000)]
  }, async (req, reply) => {
    const premios = await store.listPremios(eventoId);
    const pendientes = premios.filter(p => !p.sorteado);

    if (!premios.length) {
      return reply.code(400).send({ error: 'Todavía no hay premios registrados.' });
    }
    if (!pendientes.length) {
      return reply.code(409).send({ error: 'Ya se sortearon todos los premios.' });
    }

    // Se sortea el siguiente por orden, o el que pida el organizador si sigue
    // pendiente. No se puede elegir uno ya sorteado.
    let premio = pendientes[0];
    if (req.body && req.body.premio_id) {
      const pedido = pendientes.find(p => p.id === req.body.premio_id);
      if (!pedido) {
        return reply.code(409).send({ error: 'Ese premio no existe o ya fue sorteado.' });
      }
      premio = pedido;
    }

    const participantes = await store.participantesSorteo(eventoId);
    if (!participantes.length) {
      return reply.code(409).send({
        error: 'No hay participantes: nadie con insignias queda sin premio.'
      });
    }

    const totalBoletos = participantes.reduce((s, p) => s + p.boletos, 0);

    // Sorteo ponderado. `randomInt` usa el generador criptografico del sistema,
    // no `Math.random`, que es predecible y no debe decidir quien gana un premio.
    const semilla = crypto.randomBytes(16).toString('hex');
    const numeroGanador = crypto.randomInt(0, totalBoletos);

    let acumulado = 0;
    let ganador = participantes[participantes.length - 1];
    for (const p of participantes) {
      acumulado += p.boletos;
      if (numeroGanador < acumulado) { ganador = p; break; }
    }

    let resultado;
    try {
      resultado = await store.registrarResultadoSorteo({
        evento_id: eventoId,
        premio_id: premio.id,
        ticket_id: ganador.ticket_id,
        boletos_ganador: ganador.boletos,
        total_boletos: totalBoletos,
        total_participantes: participantes.length,
        semilla,
        numero_ganador: numeroGanador,
        sorteado_por: (req.actor && req.actor.nombre) || 'Organización'
      });
    } catch (err) {
      // Dos pulsaciones simultaneas del boton: el indice unico sobre premio_id
      // impide sortear dos veces el mismo premio.
      if (err && err.code === '23505') {
        return reply.code(409).send({ error: 'Ese premio ya fue sorteado.' });
      }
      throw err;
    }

    await registrarAccion(req, 'sorteo',
      `${premio.orden}º ${premio.nombre} → ${ganador.codigo_ticket}`);

    // Nombres para la animacion de la ruleta. Solo nombre y inicial del
    // apellido: son los que desfilan en pantalla sin haber ganado nada.
    const carrete = participantes
      .filter(p => p.ticket_id !== ganador.ticket_id)
      .map(p => (p.nombre || '') + ' ' + String(p.apellido || '').charAt(0) + '.')
      .sort(() => Math.random() - 0.5)
      .slice(0, 40);

    return reply.code(201).send({
      success: true,
      premio: {
        id: premio.id, orden: premio.orden, nombre: premio.nombre,
        descripcion: premio.descripcion,
        empresa_id: premio.empresa_id,
        empresa_nombre: premio.empresa_nombre,
        empresa_tiene_logo: premio.empresa_tiene_logo
      },
      // El ganador SÍ se identifica con nombre completo y código: sube al
      // escenario y tiene que poder demostrar que es quien dice ser.
      ganador: {
        nombre: ganador.nombre,
        apellido: ganador.apellido,
        codigo_ticket: ganador.codigo_ticket,
        boletos: ganador.boletos
      },
      carrete,
      auditoria: {
        total_participantes: participantes.length,
        total_boletos: totalBoletos,
        numero_ganador: numeroGanador,
        semilla,
        sorteado_at: resultado.created_at
      }
    });
  });
};
