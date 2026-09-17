# Country Fest 2026 — Guía completa de mejoras

Complemento de [REVISION-PRE-EVENTO.md](REVISION-PRE-EVENTO.md). Aquí está el
**cómo**: qué archivo, qué líneas, qué código, cómo se prueba y en qué orden.
Cada bloque es un commit independiente, así se puede subir uno, verificar en
producción y seguir con el siguiente. Si algo sale mal se revierte un commit,
no una semana de trabajo.

Fecha: 2026-09-17 · Evento: 26–27 sep · Base: `main` en `2fbc458`

---

## Cómo trabajar esta semana (leer primero)

**No hay Node en esta máquina.** Nada se puede ejecutar localmente. Eso cambia
la forma de trabajar:

1. **Un cambio por commit.** Nunca dos bloques juntos.
2. **Después de cada push**, esperar el redespliegue y comprobar:
   ```bash
   curl -s https://iteraperu.pe/api/health
   ```
   Tiene que responder `"status":"ok"` y `"almacen":"pg"`. Si responde 503 o
   no responde, el servidor no arrancó: `git revert HEAD && git push` y mirar
   los logs de Railway antes de intentarlo de nuevo.
3. **Después de cada bloque**, ejecutar la prueba que se indica en ese bloque
   desde el navegador, con la cuenta de organizador y datos de prueba.
4. **Congelar el código el 24 por la noche.** Del 25 en adelante solo se toca
   si algo está roto. Un cambio "pequeño" el 26 por la mañana es el que tumba
   la puerta.
5. **Cada commit pasa el checklist de `CLAUDE.md`.** En cada bloque de abajo
   está anotado qué puntos aplican.

> ## ESTADO: bloques A–K aplicados y desplegados (2026-09-17)
>
> Los once bloques de código están en producción. Lo que queda es el bloque L
> (operativo) y el **ensayo completo**, que es lo único que puede validar los
> caminos que no se pueden probar sin una cuenta de staff.
>
> | # | Bloque | Estado | Commit |
> |---|---|---|---|
> | A | Pool de PostgreSQL | ✅ desplegado | `9d25e65` |
> | B | Contraseñas temporales (TTL) | ✅ desplegado | `47684f0` |
> | C | scrypt asíncrono | ✅ desplegado y **verificado en producción** | `27a8c8a` |
> | D | Límites por actor | ✅ desplegado | `a7f2d00` |
> | E | Aforo en la puerta | ✅ desplegado | `fcacb01` |
> | F+G+H | Sorteo: presencia, desierto, semilla | ✅ desplegado | `0a5176d` |
> | I | Deshacer el reinicio | ✅ desplegado | `7641179` |
> | J | Boleto por secuencia | ✅ desplegado | `b8b8cd2` |
> | K | Desbloquear staff | ✅ desplegado | `fab5acf` |
> | L | Operativo | ⬜ pendiente | — |
>
> **Decisiones que se tomaron por defecto** (F y G), reversibles:
> - Solo participa en el sorteo quien está en el recinto. Es una casilla en la
>   pantalla del sorteo, marcada por defecto: se puede desmarcar en el momento.
> - El ganador que no se presenta **pierde el turno** y no vuelve al bombo. Esto
>   sí es código (`participantesSorteo`); cambiarlo es quitar una condición.
>
> **Lo que NO se pudo verificar desde aquí** y hay que probar en el navegador,
> porque hace falta una sesión de staff:
> 1. Un escaneo completo que llegue a crear la insignia (ejercita
>    `nextval('insignias_ticket_seq')`, bloque J).
> 2. Declarar un premio desierto y volver a sortearlo (bloque G).
> 3. Deshacer un reinicio de ingresos (bloque I).
> 4. El aforo pintado en la ficha de check-in (bloque E).
>
> Están cubiertos por los pasos 5, 7 y 8 del ensayo, más abajo.

Orden recomendado (los primeros son los de más impacto y menos riesgo):

| # | Bloque | Riesgo del cambio | Impacto el 26 |
|---|---|---|---|
| A | Pool de PostgreSQL | mínimo | alto |
| B | Contraseñas temporales (TTL) | mínimo | medio |
| C | scrypt asíncrono | **medio** — hay que tocar 9 llamadas | alto |
| D | Límites por actor en vez de por IP | bajo | medio |
| E | Aforo visible en la puerta | bajo | bajo |
| F | Sorteo: solo presentes | bajo | alto |
| G | Sorteo: premio no reclamado | medio | alto |
| H | Sorteo: semilla reproducible | bajo | bajo (defensa) |
| I | Deshacer el reinicio de ingresos | bajo | medio |
| J | Número de ticket sin repetir | bajo | bajo |
| K | Desbloquear un usuario de staff | bajo | bajo |
| L | Operativo: red, réplicas, ensayo | — | alto |

Hay que decidir con la organización **antes** de F y G (ver esos bloques).

---

## A. Pool de PostgreSQL

**Archivo:** `server.js`, bloque `new Pool({...})` (≈ línea 78).

```js
    pool = new Pool({
      connectionString,
      ssl: isInternal ? false : { rejectUnauthorized },
      // 3 conexiones eran pocas: cada peticion hace 2-4 consultas y con
      // varias puertas y gente escaneando dentro, la cuarta peticion
      // simultanea se quedaba esperando. Railway Postgres admite bastante mas.
      max: 12,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 4000
    });
```

**Antes de subirlo:** en Railway → servicio Postgres → Variables, ver
`max_connections` (suele ser 100 o más). 12 está bien por debajo.

**Prueba:** `/api/health` responde ok. Abrir la consola y ver que las métricas
cargan.

**Seguridad:** no aplica ningún punto; no toca datos ni rutas.

**Commit:** `perf(db): pool de 12 conexiones para la carga del evento`

---

## B. Contraseñas temporales: que lleguen al domingo

Tres constantes, tres archivos.

**`lib/auth.js`** (≈ línea 31):
```js
// Registro rapido en puerta: cubre las DOS jornadas. Con 14 horas, quien fue
// registrado el sabado por la tarde y abrio la app el domingo ya no podia
// entrar y volvia al Punto de Ayuda. Sigue siendo de un solo uso porque
// obliga a cambiarla al entrar.
const TEMP_PASSWORD_PUERTA_TTL_MS = 40 * 60 * 60 * 1000; // 40 horas
```

**`lib/routes-empresa.js`** línea 34, **`lib/routes-insignias.js`** línea 195 y
**`lib/routes-importar.js`** línea 248: cambiar `7 * 24 * 60 * 60 * 1000` por
`14 * 24 * 60 * 60 * 1000`. Mejor: definir en `lib/auth.js`

```js
// Clave temporal de un puesto. Se reparten la semana previa y el responsable
// puede no abrir el panel hasta el dia del evento.
const TEMP_EMPRESA_TTL_MS = 14 * 24 * 60 * 60 * 1000;
```
exportarla, y usar `auth.TEMP_EMPRESA_TTL_MS` en los tres sitios. Así no vuelve
a haber tres copias del mismo número.

**Ojo:** esto afecta a puestos creados **después** del cambio. Los 72 que se
importen antes tendrán 7 días. Por eso este bloque va **antes** de importar el
padrón, o se importa y luego se usa "reponer clave" para los que caduquen.

**Prueba:** crear un puesto de prueba (consola → datos de prueba) y ver que
`temp_password_expires_at` en la respuesta está a 14 días.

**Seguridad:** punto 9 (sesiones) — sigue habiendo cambio obligatorio y
caducidad; solo se alarga la ventana. No aplica más.

**Commit:** `fix(auth): las claves temporales cubren las dos jornadas`

---

## C. scrypt asíncrono

Este es el cambio con más impacto en rendimiento y el que más cuidado exige.

### Por qué

`crypto.scryptSync` bloquea el hilo de Node ~100 ms. Mientras calcula, **no se
atiende ninguna otra petición**: ni escaneos, ni check-ins, ni la consola. A 10
logins o registros por segundo en hora punta, el servidor está bloqueado el
100 % del tiempo. `crypto.scrypt` (asíncrono) hace el mismo cálculo en el
threadpool y el servidor sigue atendiendo.

### El peligro

Al volver `verifyPassword` asíncrona, devuelve una **Promise**. Una Promise es
un objeto, y un objeto es *truthy*. Si queda una sola llamada sin `await`:

```js
if (!auth.verifyPassword(password, hash, salt))   // SIN await
```

`!promise` es `false` → **cualquier contraseña entra**. Es el fallo más grave
que se puede introducir en este proyecto. Por eso el bloque termina con una
comprobación obligatoria.

### Cambio en `lib/auth.js`

```js
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

// ...

// Asincrono: scryptSync bloqueaba el servidor entero ~100 ms por contrasena.
// En hora punta de la puerta eso dejaba en cola los escaneos y los check-ins.
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(String(plain), salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p
  });
  return { hash: derived.toString('hex'), salt, algo: 'scrypt' };
}

async function verifyPassword(plain, hash, salt) {
  if (!hash || !salt) return false;
  if (typeof plain !== 'string' || plain.length > MAX_PASSWORD_LEN) return false;
  let derived;
  try {
    derived = await scrypt(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  } catch (e) {
    return false;
  }
  const stored = Buffer.from(String(hash), 'hex');
  if (stored.length !== derived.length) return false;
  return crypto.timingSafeEqual(stored, derived);
}
```

### Las 24 llamadas

Hay 24 usos fuera de `auth.js`. Todos tienen que llevar `await`. Los de
`verifyPassword` son los peligrosos; están en:

| Archivo | Líneas | Forma actual | Forma nueva |
|---|---|---|---|
| `lib/routes-auth.js` | 254, 292 | `if (!auth.verifyPassword(...))` | `if (!(await auth.verifyPassword(...)))` |
| `lib/routes-auth.js` | 299 | `if (auth.verifyPassword(...))` | `if (await auth.verifyPassword(...))` |
| `lib/routes-empresa.js` | 207, 245 | `if (!auth.verifyPassword(...))` | `if (!(await auth.verifyPassword(...)))` |
| `lib/routes-empresa.js` | 250 | `if (auth.verifyPassword(...))` | `if (await auth.verifyPassword(...))` |
| `lib/routes-staff.js` | 170, 223 | `if (!auth.verifyPassword(...))` | `if (!(await auth.verifyPassword(...)))` |
| `lib/routes-staff.js` | 228 | `if (auth.verifyPassword(...))` | `if (await auth.verifyPassword(...))` |

Los de `hashPassword` (15) son de la forma
`const { hash, salt, algo } = auth.hashPassword(x);` → añadir `await`. Sin
`await` el destructuring da `undefined` y el servidor falla ruidosamente al
insertar (no es silencioso como el otro), pero igual hay que cubrirlos todos.
Están en `routes-auth.js`, `routes-empresa.js`, `routes-staff.js`,
`routes-insignias.js`, `routes-importar.js`, `routes-prueba.js` y `server.js`
(`asegurarOrganizador`, `sembrarDemo`). Todas las funciones que los contienen ya
son `async`, así que el `await` es legal en todas.

### Comprobación obligatoria antes del commit

```bash
grep -rn "hashPassword(\|verifyPassword(" lib/ server.js | grep -v "^lib/auth.js" | grep -v "await "
```

**Tiene que devolver cero líneas.** Si devuelve una, esa es la que falta.

### Prueba en producción (no negociable)

1. Login de asistente con contraseña **correcta** → entra.
2. Login de asistente con contraseña **incorrecta** → "DNI o contraseña incorrectos".
3. Lo mismo con un usuario de staff y con un puesto.
4. Cambio de contraseña con la actual mal escrita → "no coincide".

Si el paso 2 entra, revertir de inmediato.

**Seguridad:** punto 2 (auth) — es exactamente lo que se verifica arriba;
punto 9 — los mensajes no cambian.

**Commit:** `perf(auth): scrypt asincrono para no bloquear el servidor en la puerta`

---

## D. Límites de tasa por actor, no por IP

**Por qué:** todo el staff está en el wifi del local → una IP para todos. Un
tope "por IP" es un tope para todo el equipo junto. Cuando se alcanza, todas
las puertas reciben 429 el resto del minuto.

**Cómo:** `rateLimit` ya acepta un tercer parámetro `keyFn`. El `preHandler`
`requireStaff`/`requireAdmin` va antes y deja `req.actor`, así que la clave
puede ser el actor. Añadir en `server.js` junto a `rateLimit`:

```js
// Clave para limitar por persona del staff y no por IP: todo el equipo
// comparte el wifi del local. El token de emergencia cuenta como un actor.
const porActor = req => 'staff:' + ((req.actor && req.actor.id) || 'token');
```

y pasarla a los módulos que la necesitan (ya reciben `rateLimit`; añadir
`porActor` en las mismas `opciones`). Cambiar:

| Archivo | Endpoint | Antes | Después |
|---|---|---|---|
| `lib/routes-auth.js` | `/api/soporte/registro-rapido` | `rateLimit(120, 60000)` | `rateLimit(60, 60000, porActor)` |
| `lib/routes-auth.js` | `/api/soporte/reset-password` | `rateLimit(60, 60000)` | `rateLimit(30, 60000, porActor)` |
| `server.js` | `/api/soporte/buscar` | `rateLimit(60, 60000)` | `rateLimit(60, 60000, porActor)` |
| `lib/routes-insignias.js` | alta/edición de puestos | `rateLimit(60, 60000)` | `rateLimit(60, 60000, porActor)` |

Los topes bajan porque ahora son **por persona**: 60 registros/minuto por
staff es uno por segundo, más de lo que un humano hace.

**Prueba:** desde dos celulares con dos usuarios de staff distintos, buscar por
DNI varias veces seguidas; ninguno recibe 429.

**Seguridad:** punto 5 (abuso) — los límites siguen existiendo y son más
estrictos por persona. La clave es el id de sesión, que no controla el cliente.

**Commit:** `fix(ratelimit): los topes del staff se cuentan por persona, no por wifi`

---

## E. Aforo visible en la puerta

**`server.js`**, en `POST /api/tickets/checkin`, antes del `return`:

```js
  // La puerta necesita ver el aforo: la consola lo muestra, pero quien decide
  // si se para la cola es quien esta en la puerta.
  const conteo = await store.countAttendees(eventoId);

  return {
    success: true,
    isDuplicate: yaHabiaIngresado,
    message: ...,
    attendee: publicAttendee(actualizada),
    checkin: registro,
    aforo: { dentro: conteo.ingresados, max: evento.aforo_max || 4000 }
  };
```

**`public/cf/staff.html`**, donde pinta el resultado del check-in (≈ línea
505–540): añadir una línea con `datos.aforo.dentro + ' / ' + datos.aforo.max`
y, si `dentro / max >= 0.95`, la clase `warn`. No bloquear: lo decide una
persona.

**Seguridad:** punto 1 — son dos números del servidor; van por `esc()` de
todas formas.

**Commit:** `feat(puerta): el aforo se ve en cada check-in`

---

## F. Sorteo: solo personas presentes

**Decisión previa con la organización:** ¿participa quien no está en el
recinto en el momento del sorteo? Recomendación: **no**. Si sale alguien que
no está, el premio se queda colgado (bloque G) y el público se enfría. Además
es lo que hace que la gente se quede hasta el final.

Si la respuesta es "sí participan todos", saltar este bloque.

**`lib/store.js`**, `participantesSorteo` (driver pg, ≈ línea 603):

```js
    // `soloPresentes`: solo quien tiene el ingreso validado AHORA. El evento
    // dura dos dias y el domingo, tras reiniciar ingresos, quien vino solo el
    // sabado no esta en el recinto para recoger nada.
    async participantesSorteo(eventoId, { soloPresentes = true } = {}) {
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
```

Y el mismo criterio en el driver de memoria (≈ línea 1284): filtrar
`p.estado === 'checkin'` cuando `soloPresentes`.

**`lib/routes-sorteo.js`**:

- En `GET /api/sorteo/estado`: leer `req.query.solo_presentes !== 'false'` y
  pasarlo. Devolver también `solo_presentes` en la respuesta para que la
  pantalla lo muestre.
- En `POST /api/sorteo/jugar`: `const soloPresentes = req.body.solo_presentes !== false;`
  pasarlo a `participantesSorteo` y **guardarlo en la bitácora**:
  `registrarAccion(req, 'sorteo', \`${premio.orden}º ${premio.nombre} → ${ganador.codigo_ticket} (${soloPresentes ? 'solo presentes' : 'todos'})\`)`.

**`public/cf/sorteo.html`**: una casilla "Solo personas presentes en el
recinto", marcada por defecto, junto al botón de jugar. Su valor va en el
cuerpo de `/api/sorteo/jugar` y en la query de `/estado`. El contador de
participantes en pantalla cambia al marcarla/desmarcarla, así el organizador
ve cuántos quedan fuera antes de girar.

**`public/cf/asistente.html`**: donde dice "+1 ticket para el sorteo" o en
"Mis insignias", añadir el aviso: "Para participar tienes que estar en el
evento en el momento del sorteo". Es lo que la Ley 29733 llama información
previa: la regla se dice antes, no después.

**Prueba:** con datos de prueba, reiniciar ingresos → `/estado` con
`solo_presentes=true` da 0 participantes y con `false` da N. Validar el ingreso
de una persona de prueba → aparece.

**Seguridad:** punto 6 — el flag es booleano y se normaliza; punto 11 — queda
en `acciones_staff` qué criterio se usó en cada sorteo.

**Commit:** `feat(sorteo): participa quien esta en el recinto`

---

## G. Sorteo: premio no reclamado

**Decisión previa:** cuando el ganador no aparece, ¿vuelve al bombo para los
siguientes premios o pierde su turno? Recomendación: **pierde el turno**. Es
la regla habitual, evita discusiones y la implementación es más simple.

### Esquema (`db/schema.sql`, al final, nueva sección)

```sql
-- =============================================================================
-- 23. Premio no reclamado
-- =============================================================================
-- Si el ganador no se presenta, el resultado NO se borra: se marca como no
-- reclamado y el premio vuelve a estar pendiente. Queda el rastro de quien
-- salio, cuando, y quien lo declaro desierto (append-only, punto 11).
ALTER TABLE sorteo_resultados ADD COLUMN IF NOT EXISTS no_reclamado_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sorteo_resultados ADD COLUMN IF NOT EXISTS no_reclamado_por VARCHAR(120);

-- La unicidad pasa a ser "un resultado VIGENTE por premio". El UNIQUE original
-- de la columna se retira y lo sustituye un indice parcial.
ALTER TABLE sorteo_resultados DROP CONSTRAINT IF EXISTS sorteo_resultados_premio_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sorteo_premio_vigente
  ON sorteo_resultados (premio_id) WHERE no_reclamado_at IS NULL;
```

`sorteo_resultados_premio_id_key` es el nombre que PostgreSQL da por defecto a
un `UNIQUE` inline de la columna `premio_id`. Para confirmarlo antes de subir,
en la consola SQL de Railway:

```sql
SELECT conname FROM pg_constraint WHERE conrelid = 'sorteo_resultados'::regclass;
```

El índice `idx_sorteo_un_premio_por_persona` **se deja como está**: la persona
que salió y no reclamó no vuelve a ganar (decisión de arriba).

### Store (`lib/store.js`, driver pg)

`listPremios`: el `LEFT JOIN` solo cuenta resultados vigentes:

```sql
         LEFT JOIN sorteo_resultados r ON r.premio_id = p.id AND r.no_reclamado_at IS NULL
```

`deletePremio`: mismo criterio en el `NOT EXISTS` (`AND r.no_reclamado_at IS NULL`).

`listGanadores`: añadir `r.id, r.no_reclamado_at, r.no_reclamado_por` al
`SELECT` y ordenar por `p.orden, r.created_at`, para que se vean los dos
intentos del mismo premio.

Función nueva:

```js
    // Declara desierto un resultado. No borra: marca. El premio vuelve a estar
    // pendiente y la persona que salio no vuelve al bombo.
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
```

Replicar en el driver de memoria.

### Ruta (`lib/routes-sorteo.js`)

```js
  // ---------------------------------------------------------------------------
  // El ganador no se presento
  // ---------------------------------------------------------------------------
  // Punto 8: el resultado tiene que ser de ESTE evento; si no, 404.
  fastify.post('/api/sorteo/resultados/:id/no-reclamado', {
    preHandler: [requireOrganizador, rateLimit(30, 60000)]
  }, async (req, reply) => {
    const actor = (req.actor && req.actor.nombre) || 'Organización';
    const r = await store.marcarNoReclamado(eventoId, req.params.id, actor);
    if (!r) {
      return reply.code(404).send({ error: 'Resultado no encontrado o ya marcado.' });
    }
    await registrarAccion(req, 'premio_no_reclamado', `resultado ${r.id} · premio ${r.premio_id}`);
    return { success: true, resultado: { id: r.id, premio_id: r.premio_id, no_reclamado_at: r.no_reclamado_at } };
  });
```

En `jugar`, el `catch` del `23505` sigue valiendo: ahora lo dispara el índice
parcial.

### Pantalla (`public/cf/sorteo.html`)

Después de mostrar al ganador, un botón discreto **"No se presentó"** que:

1. Pide confirmación con el nombre: *"¿Declarar desierto el 1º premio? Carlos Q.
   pierde el turno y el premio se vuelve a sortear."*
2. Llama al endpoint con el `id` del resultado (viene en `listGanadores`; hay
   que devolver `resultado_id` también desde `jugar`).
3. Recarga `/estado` → el premio vuelve a "siguiente" y el botón "Sortear" se
   habilita.

En la lista de ganadores, los marcados se muestran tachados con "no
reclamado". No desaparecen.

**Prueba:** con datos de prueba, sortear, marcar no reclamado, volver a
sortear el mismo premio → sale otra persona; la primera no vuelve a salir en
ningún premio; `listGanadores` muestra ambos resultados.

**Seguridad:** punto 8 — `marcarNoReclamado` filtra por `evento_id`; punto 11
— no se borra ninguna fila; punto 3 — parametrizado.

**Commit:** `feat(sorteo): un premio no reclamado se vuelve a sortear`

---

## H. Semilla que reproduce el número

**`lib/routes-sorteo.js`**, en `jugar`, sustituir:

```js
    const semilla = crypto.randomBytes(16).toString('hex');
    const numeroGanador = crypto.randomInt(0, totalBoletos);
```

por:

```js
    // El numero SALE de la semilla: con semilla, premio y total de boletos
    // (los tres se guardan) cualquiera recalcula el resultado. Antes la
    // semilla y el numero eran dos aleatorios independientes y la "auditoria"
    // no demostraba nada.
    const semilla = crypto.randomBytes(16).toString('hex');
    const numeroGanador = numeroDesdeSemilla(semilla, premio.id, totalBoletos);
```

y añadir arriba del módulo:

```js
// sha256(semilla|premio|total) mod total. Con 256 bits de entrada el sesgo
// del modulo es despreciable para cualquier total de boletos realista.
function numeroDesdeSemilla(semilla, premioId, total) {
  const h = crypto.createHash('sha256')
    .update(`${semilla}|${premioId}|${total}`).digest('hex');
  return Number(BigInt('0x' + h) % BigInt(total));
}
module.exports.numeroDesdeSemilla = numeroDesdeSemilla;
```

Añadir al README, en la sección del sorteo, cómo verificar un resultado a
mano (con cualquier herramienta que calcule SHA-256).

**Seguridad:** no aplica; el generador sigue siendo criptográfico.

**Commit:** `fix(sorteo): el numero ganador se deriva de la semilla`

---

## I. Deshacer el reinicio de ingresos

**`lib/store.js`** (driver pg, junto a `reiniciarIngresos`):

```js
    // Vuelta atras de un reinicio pulsado por error: recupera el estado
    // "dentro" de quien tiene un ingreso exitoso HOY en checkins_log (hora
    // del evento). No inventa nada: si no paso por la puerta hoy, no vuelve.
    async deshacerReinicio(eventoId, tz) {
      const res = await q(
        `UPDATE asistentes_tickets t SET estado = 'checkin'
         WHERE t.evento_id = $1 AND t.estado = 'valido'
           AND EXISTS (
             SELECT 1 FROM checkins_log c
             WHERE c.ticket_id = t.id AND c.resultado = 'exitoso'
               AND (c.created_at AT TIME ZONE $2::text)::date = (NOW() AT TIME ZONE $2::text)::date
           )`,
        [eventoId, tz || 'America/Lima']
      );
      return res.rowCount;
    },
```

**`server.js`**, junto a `reiniciar-ingresos`:

```js
fastify.post('/api/soporte/deshacer-reinicio', {
  preHandler: [requireOrganizador, rateLimit(5, 60000)]
}, async (req, reply) => {
  const b = req.body || {};
  if (b.confirmar !== 'DESHACER') {
    return reply.code(400).send({ error: 'Falta la confirmación. Envía { "confirmar": "DESHACER" }.' });
  }
  const recuperados = await store.deshacerReinicio(eventoId, ZONA_HORARIA);
  await registrarAccion(req, 'deshacer_reinicio', `${recuperados} persona(s) vuelven a "dentro"`);
  req.log.warn({ recuperados }, 'reinicio de ingresos deshecho');
  return { success: true, recuperados };
});
```

**`public/cf/consola.html`**: en la tarjeta de reinicio, cambiar el `confirm()`
por un campo de texto donde haya que escribir `REINICIAR`, y añadir un segundo
botón "Deshacer el reinicio de hoy" con el mismo mecanismo (`DESHACER`).

**Prueba:** validar ingreso de 3 personas de prueba → reiniciar → aforo 0 →
deshacer → aforo 3.

**Seguridad:** punto 11 — `checkins_log` no se toca, solo se lee; punto 3 —
parametrizado.

**Commit:** `feat(consola): el reinicio de ingresos se puede deshacer`

---

## J. Número de ticket sin repetir

**`db/schema.sql`**, sección de insignias:

```sql
-- Numero correlativo del boleto. Antes salia de COUNT(*)+1 dentro del INSERT,
-- que con dos escaneos simultaneos daba el mismo numero a dos personas.
CREATE SEQUENCE IF NOT EXISTS insignias_ticket_seq;
SELECT setval('insignias_ticket_seq',
              (SELECT COALESCE(MAX(ticket_sorteo), 0) + 1 FROM insignias), false);
```

**`lib/store.js`**, `crearInsignia`:

```sql
        `INSERT INTO insignias (evento_id, ticket_id, empresa_id, ticket_sorteo, device_id)
         VALUES ($1, $2, $3, nextval('insignias_ticket_seq'), $4)
         ON CONFLICT ON CONSTRAINT insignia_unica_por_puesto DO NOTHING
         RETURNING *`
```

Un duplicado consume un número y deja un hueco. No importa: el sorteo cuenta
insignias, no números.

**Alternativa sin tocar la base:** dejar de mostrar "tu ticket #1042" en
`asistente.html` y mostrar "tienes N boletos". Es un cambio de texto y elimina
el reclamo. Si el tiempo aprieta, esta.

**Commit:** `fix(insignias): numero de boleto por secuencia`

---

## K. Desbloquear un usuario de staff

**`lib/routes-staff.js`**, junto a `/usuarios/:id/activo`:

```js
  // Ocho intentos fallidos bloquean 15 minutos. Si eso pasa en la puerta, no
  // se puede esperar: el organizador lo desbloquea.
  fastify.post('/api/staff/usuarios/:id/desbloquear', {
    preHandler: [requireOrganizador(), rateLimit(30, 60000)]
  }, async (req, reply) => {
    const u = await store.findUsuarioStaffById(req.params.id);
    if (!u || u.evento_id !== eventoId) return reply.code(404).send({ error: 'Usuario no encontrado.' });
    await store.updateUsuarioStaff(u.id, { locked_until: null, failed_login_count: 0 });
    await registrar(req, 'desbloquear_usuario', u.usuario);
    return { success: true };
  });
```

(Adaptar la forma de `requireOrganizador` a cómo se usa en ese archivo: ahí es
una fábrica, `requireOrganizador()`.) Botón en la gestión de usuarios de
`staff.html`.

**Seguridad:** punto 8 — se comprueba `evento_id`; 404 y no 403.

**Commit:** `feat(staff): el organizador puede desbloquear un usuario`

---

## L. Operativo (no es código)

### Railway
- **Réplicas = 1.** Servicio → Settings → Replicas. El contador de códigos y el
  limitador viven en memoria; con dos procesos se pisan.
- Variables: `SEED_DEMO` vacío o `false`, `ADMIN_TOKEN` largo, `EVENT_AFORO=4000`,
  `EVENT_TZ=America/Lima`, `ALLOWED_ORIGINS` vacío.
- Anotar dónde ver los logs y quién tiene acceso a Railway el 26. Si el
  servidor se cae a las 8 pm, alguien tiene que poder reiniciarlo desde el
  celular.

### Red en el recinto
- Wifi **del staff** separado del público, con contraseña distinta.
- Un celular con datos de un operador distinto por puerta.
- Probar desde el recinto **antes** del 26: abrir `/staff/country-fest`, hacer
  un check-in de prueba. La cobertura de un club de campo en Ilo no se adivina.

### Ensayo completo (recomendado: 23 o 24, con la app ya congelada)
Consola → datos de prueba → 20 personas. Luego, con dos celulares:

1. Registro web de una persona nueva → login → ver su QR.
2. Puerta: check-in por cámara y por código tecleado; check-in repetido (aviso).
3. Registro rápido solo con DNI, con "validar ingreso" marcado.
4. Esa persona entra con `CF2026` desde su celular, cambia clave, pone su nombre.
5. Escanear 3 puestos; el segundo escaneo del mismo → "ya la tienes".
6. Puesto: entrar al panel, ver sus estadísticas.
7. Sorteo: 2 premios; sortear; marcar no reclamado; volver a sortear.
8. Reiniciar ingresos → escanear → "primero valida tu ingreso" → deshacer.
9. Exportar los tres CSV y abrirlos en Excel (tildes bien).
10. **Borrar datos de prueba.** Verificar que el aforo queda en 0 y que los
    premios vuelven a estar libres.
11. **Borrar la cuenta sintética de la prueba de contraseñas.** Al verificar el
    bloque C en producción se creó un asistente con DNI `99000777`, nombre
    «PRUEBA SCRYPT BORRAR». No lleva `es_prueba`, así que el barrido de datos de
    prueba **no** se lo lleva. Desde la consola SQL de Railway:

    ```sql
    DELETE FROM asistentes_tickets WHERE dni = '99000777';
    ```

    Si no se borra, aparecerá en el CSV de asistentes y sumará uno al total de
    registrados. No entra al sorteo (no tiene insignias).

Cada paso que falle es un bug a arreglar antes del 25, no un "ya lo vemos el día".

### El día
- Un organizador con la consola abierta en una laptop, no en el celular.
- El botón de reiniciar ingresos **solo el domingo por la mañana**, una vez.
- Sorteo: proyectar `/sorteo/country-fest`; la laptop conectada por cable o
  wifi del staff, nunca 4G.
- Tener impresa la hoja de claves de los puestos (el CSV) por si alguno
  perdió la suya; "reponer clave" desde la consola.

---

## Después del evento

No es urgente, pero queda apuntado para no perderlo:

- CSP sin `'unsafe-inline'`: sacar los `<script>` de los HTML a archivos.
- QR rotativo por puesto (requiere una pantalla en cada stand).
- Limitador de tasa en base de datos o Redis si algún día hay más de una réplica.
- Retirar el `ADMIN_TOKEN` como vía de acceso cuando haya organizadores con
  cuenta y contraseña estable.
- Borrar los datos personales a los 12 meses, como dice el texto de
  consentimiento. Poner un recordatorio para septiembre de 2027.
