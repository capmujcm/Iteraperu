'use strict';
// -----------------------------------------------------------------------------
// Importacion del padron real de puestos
// -----------------------------------------------------------------------------
// Dar de alta 72 puestos a mano desde el Punto de Ayuda son 72 formularios y 72
// oportunidades de escribir mal un nombre. El padron ya existe en dos archivos
// de la organizacion (la numeracion de stands y las respuestas del formulario
// de inscripcion), asi que se importa de una vez y siempre igual.
//
// El catalogo vive en db/puestos-countryfest-2026.json y esta VERSIONADO. Por
// eso no lleva un solo dato personal: el repositorio es publico y un nombre con
// su celular dentro del historial de git ya no se puede retirar. Los contactos
// de los responsables viajan en el cuerpo de la peticion, los sube el
// organizador desde su maquina el dia que toca, y no se escriben en ningun log.
//
// La importacion es idempotente y se puede repetir:
//   * puesto que no existe -> se crea con su QR, su codigo impreso y una clave
//     temporal que se devuelve UNA vez.
//   * puesto que ya existe -> se le corrigen nombre, stand, rubro, emoji, color
//     y descripcion. NO se le tocan el QR, el codigo corto ni el usuario: los
//     carteles pueden estar ya impresos y colgados.
//
// Lo que esta funcion NO hace: borrar. Un puesto que sobra se desactiva desde
// la consola. Un import que borra es un import que un dia se ejecuta dos veces
// y se lleva por delante las insignias de la gente.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { auth } = require('./store');

const RUTA_CATALOGO = path.join(__dirname, '..', 'db', 'puestos-countryfest-2026.json');

// Tope de contactos aceptados en una peticion. El padron son ~72 puestos; un
// cuerpo mucho mayor no es un padron, es alguien probando cuanto aguanta.
const MAX_CONTACTOS = 300;

const ZONAS_COLOR = {
  'COMIDAS': '#E60067',
  'LICORES Y COCTELES': '#00C2FF',
  'POSTRES': '#FFDE00',
  'MINI EMPRENDEDORES': '#0F9B6C',
  'EMPRENDEDORES': '#315CFF'
};

// Mismo criterio que en routes-insignias: el usuario del puesto es su
// identificador de acceso, no el codigo impreso bajo el QR.
function normalizaUsuario(v) {
  if (typeof v !== 'string') return null;
  const u = v.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]/g, '');
  if (u.length < 3 || u.length > 40) return null;
  return u;
}

function colorValido(v, porDefecto) {
  const c = typeof v === 'string' ? v.trim() : '';
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : porDefecto;
}

function recorta(v, n) {
  return (typeof v === 'string' && v.trim()) ? v.trim().slice(0, n) : null;
}

// Un telefono peruano son 9 digitos. Se acepta cualquier separador y se guarda
// solo el numero, porque es lo que hace falta para abrir un WhatsApp.
function telefono(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = String(v).replace(/[^0-9]/g, '');
  if (d.length < 6 || d.length > 15) return null;
  return d;
}

// El catalogo se lee y se valida UNA vez, al arrancar, para que un archivo roto
// se vea en el log del despliegue y no en mitad del evento. Pero si esta roto,
// el servidor ARRANCA IGUAL: la puerta, el escaneo y el sorteo no pueden caerse
// por un archivo de alta de puestos. Solo se cae esta funcion, y lo dice.
function cargarCatalogo() {
  const crudo = JSON.parse(fs.readFileSync(RUTA_CATALOGO, 'utf8'));
  const lista = Array.isArray(crudo.puestos) ? crudo.puestos : [];
  const vistos = new Set();
  const puestos = [];

  lista.forEach((p, i) => {
    const usuario = normalizaUsuario(p.usuario);
    const nombre = recorta(p.nombre, 150);
    if (!usuario) throw new Error(`Catalogo de puestos: usuario invalido en la posicion ${i}.`);
    if (!nombre) throw new Error(`Catalogo de puestos: "${usuario}" no tiene nombre.`);
    if (vistos.has(usuario)) throw new Error(`Catalogo de puestos: usuario repetido "${usuario}".`);
    vistos.add(usuario);

    const zona = recorta(p.zona, 60);
    puestos.push({
      usuario,
      nombre,
      rubro: zona,
      stand: recorta(p.stand, 30),
      emoji: recorta(p.emoji, 16) || '🎪',
      color: colorValido(p.color, ZONAS_COLOR[zona] || '#FF5A1F'),
      descripcion: recorta(p.descripcion, 1000)
    });
  });

  if (!puestos.length) throw new Error('Catalogo de puestos: no hay ni un puesto.');
  return { meta: { evento: crudo.evento, generado: crudo.generado }, puestos };
}

let CATALOGO = null;
let ERROR_CATALOGO = null;
try {
  CATALOGO = cargarCatalogo();
} catch (e) {
  ERROR_CATALOGO = e.message;
  console.error('[ITERA Engine] Catalogo de puestos no disponible: ' + e.message);
}

module.exports = function registrarImportacion(fastify, opciones) {
  const { store, eventoId, rateLimit, requireOrganizador } = opciones;
  const registrarAccion = opciones.registrarAccion || (async () => {});

  // Puerta unica: sin catalogo no hay nada que importar, y se dice por que.
  function sinCatalogo(reply) {
    if (CATALOGO) return false;
    reply.code(503).send({
      error: 'El catálogo de puestos no se pudo cargar: ' + ERROR_CATALOGO
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Que hay en el catalogo y que falta por importar
  // ---------------------------------------------------------------------------
  // Sirve para que la consola pueda avisar antes de pulsar: "hay 72 puestos en
  // el archivo, 0 estan creados". Sin datos personales.
  fastify.get('/api/soporte/empresas/importar', {
    preHandler: requireOrganizador
  }, async (req, reply) => {
    if (sinCatalogo(reply)) return reply;

    const existentes = await store.listEmpresasConToken(eventoId);
    const porUsuario = new Map(
      existentes.filter(e => e.usuario).map(e => [String(e.usuario).toLowerCase(), e])
    );
    let yaEstan = 0;
    CATALOGO.puestos.forEach(p => { if (porUsuario.has(p.usuario)) yaEstan++; });

    return {
      success: true,
      catalogo: CATALOGO.meta,
      total: CATALOGO.puestos.length,
      ya_creados: yaEstan,
      por_crear: CATALOGO.puestos.length - yaEstan
    };
  });

  // ---------------------------------------------------------------------------
  // Importar
  // ---------------------------------------------------------------------------
  fastify.post('/api/soporte/empresas/importar', {
    preHandler: [requireOrganizador, rateLimit(5, 60000)]
  }, async (req, reply) => {
    if (sinCatalogo(reply)) return reply;

    const b = req.body || {};

    // Confirmacion explicita en el cuerpo: esto escribe decenas de filas en la
    // base real y no puede dispararse por una peticion suelta.
    if (b.confirmar !== 'IMPORTAR') {
      return reply.code(400).send({ error: 'Falta la confirmacion explicita de la importacion.' });
    }

    // --- contactos (opcionales, datos personales) ---
    // Llegan del archivo que el organizador tiene en su maquina. Se validan
    // como cualquier otra entrada: ni el numero de elementos ni su forma se dan
    // por buenos porque los mande la consola.
    const contactos = new Map();
    if (b.contactos !== undefined) {
      if (!Array.isArray(b.contactos)) {
        return reply.code(400).send({ error: 'Los contactos deben venir en una lista.' });
      }
      if (b.contactos.length > MAX_CONTACTOS) {
        return reply.code(400).send({ error: `Demasiados contactos (maximo ${MAX_CONTACTOS}).` });
      }
      for (const c of b.contactos) {
        if (!c || typeof c !== 'object') continue;
        const usuario = normalizaUsuario(c.usuario);
        if (!usuario) continue;
        contactos.set(usuario, {
          responsable: recorta(c.responsable, 120),
          telefono: telefono(c.telefono),
          whatsapp: telefono(c.whatsapp)
        });
      }
    }

    const ahora = new Date().toISOString();
    const creados = [];
    const actualizados = [];
    const fallidos = [];

    for (const p of CATALOGO.puestos) {
      try {
        const existente = await store.findEmpresaByUsuario(eventoId, p.usuario);
        const contacto = contactos.get(p.usuario) || null;

        if (existente) {
          // Punto 8: el puesto tiene que ser de ESTE evento. findEmpresaByUsuario
          // ya filtra por evento, pero se vuelve a comprobar antes de escribir.
          if (existente.evento_id !== eventoId) { fallidos.push(p.usuario); continue; }

          const patch = {
            nombre: p.nombre, rubro: p.rubro, emoji: p.emoji,
            color: p.color, stand: p.stand, descripcion: p.descripcion
          };
          if (contacto) {
            if (contacto.responsable) patch.responsable = contacto.responsable;
            if (contacto.telefono) patch.telefono = contacto.telefono;
            if (contacto.whatsapp) patch.whatsapp = contacto.whatsapp;
          }
          await store.updateEmpresa(existente.id, patch);
          actualizados.push({ usuario: p.usuario, nombre: p.nombre, stand: p.stand });
          continue;
        }

        // Nace con su acceso listo: clave temporal aleatoria, cambio obligatorio
        // en el primer ingreso y caducidad a 7 dias. Se devuelve una sola vez.
        const clave = auth.claveLegible(8);
        const { hash, salt, algo } = auth.hashPassword(clave);

        const empresa = await store.createEmpresa({
          evento_id: eventoId,
          nombre: p.nombre,
          rubro: p.rubro,
          emoji: p.emoji,
          color: p.color,
          descripcion: p.descripcion,
          stand: p.stand,
          condicion: null,
          telefono: contacto ? contacto.telefono : null,
          qr_token: auth.newQrToken(),
          codigo_corto: await codigoCortoLibre(),
          usuario: p.usuario,
          password_hash: hash,
          password_salt: salt,
          password_algo: algo,
          password_updated_at: ahora,
          must_change_password: true,
          temp_password_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });

        // createEmpresa no escribe `responsable` ni `whatsapp`: van en un update
        // aparte para no tener que tocar la firma del store.
        if (contacto && (contacto.responsable || contacto.whatsapp)) {
          const extra = {};
          if (contacto.responsable) extra.responsable = contacto.responsable;
          if (contacto.whatsapp) extra.whatsapp = contacto.whatsapp;
          await store.updateEmpresa(empresa.id, extra);
        }

        creados.push({
          usuario: empresa.usuario,
          nombre: empresa.nombre,
          stand: empresa.stand,
          codigo_corto: empresa.codigo_corto,
          password_temporal: clave
        });
      } catch (e) {
        // Un puesto que falla no detiene el padron entero: se anota y se sigue.
        // Solo el usuario, que no es dato personal; el error se queda aqui.
        fallidos.push(p.usuario);
      }
    }

    // La bitacora guarda el recuento, nunca las claves ni los contactos.
    await registrarAccion(req, 'importar_puestos',
      `${creados.length} creados, ${actualizados.length} actualizados, ${fallidos.length} con error` +
      (contactos.size ? `, ${contactos.size} contactos aplicados` : ', sin contactos'));

    return reply.code(201).send({
      success: true,
      total: CATALOGO.puestos.length,
      creados,
      actualizados: actualizados.length,
      fallidos,
      aviso: creados.length
        ? 'Las claves temporales se muestran una sola vez. Descargalas antes de cerrar.'
        : 'No habia puestos nuevos: solo se actualizaron los existentes.'
    });
  });

  // Codigo corto libre, con el mismo alfabeto legible que el resto del sistema.
  async function codigoCortoLibre() {
    const ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let intento = 0; intento < 20; intento++) {
      let c = 'P-';
      // Aleatoriedad criptografica, no Math.random: el codigo corto va impreso a
      // la vista, pero adivinar el siguiente antes de imprimirlo no deberia ser
      // un ejercicio de aritmetica.
      for (let i = 0; i < 4; i++) c += ALFABETO[crypto.randomInt(ALFABETO.length)];
      if (!(await store.findEmpresaByCodigo(eventoId, c))) return c;
    }
    return 'P-' + Date.now().toString(36).toUpperCase().slice(-5);
  }
};
