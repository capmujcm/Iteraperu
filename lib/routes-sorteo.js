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

// El numero ganador SALE de la semilla. Antes la semilla y el numero eran dos
// aleatorios independientes, asi que guardar la semilla no demostraba nada: si
// alguien impugnaba el resultado no habia forma de recalcularlo. Ahora, con la
// semilla, el premio y el total de boletos -los tres quedan guardados- se
// reproduce el numero con cualquier calculadora de SHA-256.
//
// El sesgo del modulo sobre 256 bits de entrada es despreciable para cualquier
// cantidad de boletos que pueda tener este evento.
function numeroDesdeSemilla(semilla, premioId, total) {
  const h = crypto.createHash('sha256')
    .update(`${semilla}|${premioId}|${total}`).digest('hex');
  return Number(BigInt('0x' + h) % BigInt(total));
}

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

  // Lo que se sortea, para la app del asistente: saber que hay un televisor en
  // juego es lo que anima a recorrer un puesto mas. Publico y sin datos
  // personales: ni quien gano ni cuantos participan. Solo el premio, quien lo
  // regala y si ya se sorteo.
  fastify.get('/api/sorteo/premios-publicos', async () => {
    const premios = await store.listPremios(eventoId);
    return {
      success: true,
      premios: premios.map(p => ({
        orden: p.orden,
        nombre: p.nombre,
        descripcion: p.descripcion,
        empresa_id: p.empresa_id,
        empresa_nombre: p.empresa_nombre,
        empresa_tiene_logo: p.empresa_tiene_logo,
        sorteado: p.sorteado
      }))
    };
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
  fastify.get('/api/sorteo/estado', { preHandler: requireOrganizador }, async (req) => {
    // Por defecto solo cuentan los presentes. La pantalla puede pedir el
    // recuento sin ese filtro para que el organizador vea, antes de girar,
    // cuanta gente queda fuera por no estar en el recinto.
    const soloPresentes = req.query.solo_presentes !== 'false';
    const premios = await store.listPremios(eventoId);
    const participantes = await store.participantesSorteo(eventoId, { soloPresentes });
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
      solo_presentes: soloPresentes,
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

    // Quien no esta en el recinto no participa, salvo que la organizacion lo
    // decida al pulsar. Se manda explicito desde la pantalla del sorteo.
    const soloPresentes = !(req.body && req.body.solo_presentes === false);

    const participantes = await store.participantesSorteo(eventoId, { soloPresentes });
    if (!participantes.length) {
      return reply.code(409).send({
        error: soloPresentes
          ? 'No hay participantes presentes: nadie con insignias y con el ingreso validado queda sin premio.'
          : 'No hay participantes: nadie con insignias queda sin premio.'
      });
    }

    const totalBoletos = participantes.reduce((s, p) => s + p.boletos, 0);

    // Sorteo ponderado. La semilla es criptografica y el numero se deriva de
    // ella, de modo que el resultado se puede recalcular despues.
    const semilla = crypto.randomBytes(16).toString('hex');
    const numeroGanador = numeroDesdeSemilla(semilla, premio.id, totalBoletos);

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

    // Queda anotado con que criterio se sorteo: si alguien pregunta despues
    // por que su nombre no estaba en el bombo, la respuesta esta aqui.
    await registrarAccion(req, 'sorteo',
      `${premio.orden}º ${premio.nombre} → ${ganador.codigo_ticket}` +
      ` (${soloPresentes ? 'solo presentes' : 'todos los registrados'})`);

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
      // El id del resultado es lo que necesita la pantalla para declararlo
      // desierto si el ganador no aparece.
      resultado_id: resultado.id,
      auditoria: {
        total_participantes: participantes.length,
        total_boletos: totalBoletos,
        numero_ganador: numeroGanador,
        semilla,
        solo_presentes: soloPresentes,
        sorteado_at: resultado.created_at
      }
    });
  });

  // ---------------------------------------------------------------------------
  // El ganador no se presento
  // ---------------------------------------------------------------------------
  // Pasa: la persona se fue temprano, no oye su nombre, esta en la cola de un
  // puesto. Sin esto el premio se quedaba colgado, porque un premio sorteado
  // no se puede borrar ni volver a sortear.
  //
  // El resultado NO se borra: se marca como desierto y el premio vuelve a
  // estar pendiente. Queda quien salio, cuando y quien lo declaro desierto
  // (punto 11). Quien salio pierde el turno y no vuelve al bombo.
  fastify.post('/api/sorteo/resultados/:id/no-reclamado', {
    preHandler: [requireOrganizador, rateLimit(30, 60000)]
  }, async (req, reply) => {
    const actor = (req.actor && req.actor.nombre) || 'Organización';

    // Punto 8: el resultado tiene que ser de ESTE evento. marcarNoReclamado
    // filtra por evento_id, asi que un id de otro evento devuelve 404 y no
    // confirma que exista.
    const r = await store.marcarNoReclamado(eventoId, req.params.id, actor);
    if (!r) {
      return reply.code(404).send({
        error: 'Ese resultado no existe o ya estaba declarado desierto.'
      });
    }

    await registrarAccion(req, 'premio_no_reclamado',
      `premio ${r.premio_id} · el ganador no se presento`);

    return {
      success: true,
      resultado: {
        id: r.id,
        premio_id: r.premio_id,
        no_reclamado_at: r.no_reclamado_at,
        no_reclamado_por: r.no_reclamado_por
      }
    };
  });

  // ---------------------------------------------------------------------------
  // Borrar todo el sorteo
  // ---------------------------------------------------------------------------
  // Para limpiar un ensayo hecho con cuentas reales: «Borrar datos de prueba»
  // solo alcanza a las personas marcadas como prueba, y un premio sorteado no
  // se puede quitar uno por uno. Borra premios y resultados. NO toca insignias,
  // personas, puestos ni ingresos.
  //
  // Es la operacion mas destructiva del sorteo, asi que:
  //   * solo organizador, y hay que escribir la frase exacta;
  //   * se lee todo antes de borrar y queda en acciones_staff (punto 11) cada
  //     resultado que desaparece: posicion, premio, codigo de entrada y hora.
  //     Codigos y no nombres: el rastro no necesita mas datos personales.
  fastify.post('/api/sorteo/reiniciar', {
    preHandler: [requireOrganizador, rateLimit(5, 60000)]
  }, async (req, reply) => {
    const b = req.body || {};
    if (b.confirmar !== 'BORRAR SORTEO') {
      return reply.code(400).send({
        error: 'Falta la confirmación. Escribe exactamente BORRAR SORTEO.'
      });
    }

    const premios = await store.listPremios(eventoId);
    const ganadores = await store.listGanadores(eventoId);
    const rastro = ganadores.map(g =>
      `${g.orden}º ${g.premio} → ${g.codigo_ticket || 'sin ticket'}` +
      `${g.no_reclamado_at ? ' (desierto)' : ''} @ ${new Date(g.created_at).toISOString()}`
    ).join('; ');

    const borrado = await store.borrarSorteo(eventoId);

    await registrarAccion(req, 'borrar_sorteo',
      `${borrado.premios} premio(s) [${premios.map(p => p.orden + 'º ' + p.nombre).join(', ')}]` +
      ` y ${borrado.resultados} resultado(s)` + (rastro ? `: ${rastro}` : ''));
    req.log.warn(borrado, 'sorteo borrado entero');

    return { success: true, borrado };
  });
};
