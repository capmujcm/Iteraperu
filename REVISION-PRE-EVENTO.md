# Country Fest 2026 — Revisión de lógica antes del evento

Fecha de revisión: 2026-09-17 · Evento: 26 y 27 de septiembre · Código revisado: `main` en `2fbc458`

Se leyó la lógica del servidor completa (`server.js`, `lib/routes-*.js`, `lib/store.js`,
`lib/auth.js`, `db/schema.sql`) y los puntos críticos de las apps del navegador.
Lo que sigue está ordenado por lo que más puede doler el día del evento, no por
lo fácil que es de arreglar.

Leyenda: **🔴 arreglar antes del evento** · **🟠 conviene arreglar** · **🟡 mejora / decisión operativa** · **🟢 verificado, está bien**

---

## 🔴 1. Un ganador del sorteo que no está no se puede reemplazar

**Dónde:** `lib/routes-sorteo.js`, `store.deletePremio`, `public/cf/sorteo.html`

**Qué pasa:** se sortea el 1º premio, sale "Carlos Q." y no está en el recinto
(se fue a las 6, está en el baño, no oye). No hay forma de declarar el premio
desierto y volver a sortearlo:

- `deletePremio` se niega a borrar un premio ya sorteado (a propósito, para no
  borrar resultados).
- `jugar` solo acepta premios pendientes.
- El índice `idx_sorteo_un_premio_por_persona` y `premio_id UNIQUE` impiden
  registrar un segundo resultado para el mismo premio.

La única salida en vivo sería crear un premio nuevo con el mismo nombre en otra
posición, que confunde al público y deja la bitácora sucia.

**Propuesta:** un endpoint `POST /api/sorteo/resultados/:id/no-reclamado`
(organizador) que marque el resultado como `no_reclamado_at = NOW()` sin
borrarlo, y que `listPremios`/`participantesSorteo` traten ese premio como
pendiente otra vez. El ganador ausente vuelve al bombo o no, según decidan
(recomiendo que **no**: perdió su turno). Se queda el rastro de quién salió y
cuándo. Botón "No se presentó → volver a sortear" en `sorteo.html`.

---

## 🔴 2. El sorteo incluye a gente que ya se fue (o que vino solo el día 1)

**Dónde:** `store.participantesSorteo`

**Qué pasa:** entra al bombo todo el que tenga insignias y nombre, sin mirar
`estado`. El domingo, después de reiniciar ingresos, quien vino el sábado y no
volvió sigue en el bombo con todas sus insignias. Combinado con el punto 1, la
probabilidad de sacar a alguien que no está es alta, y cada ausente es un
premio que hay que resolver a mano.

**Propuesta:** añadir a la consulta `AND t.estado = 'checkin'` (solo quien está
dentro ahora mismo), controlado por una casilla en `sorteo.html` que por
defecto esté marcada: "Solo personas presentes". Si el sorteo es el domingo, la
gente del sábado que quiera participar tiene que volver — que es lo que la
organización quiere de todas formas.

Hay que decidirlo con la organización y **decirlo en la app** antes del sorteo:
hoy la app promete "+1 ticket para el sorteo" sin condición de presencia.

---

## 🔴 3. `scryptSync` bloquea todo el servidor ~100 ms por contraseña

**Dónde:** `lib/auth.js` (`hashPassword`, `verifyPassword`), usado en registro,
login, cambio de clave, registro rápido y reset.

**Qué pasa:** `scryptSync` es síncrono: mientras calcula, Node no atiende
**ninguna** otra petición. A 100 ms por hash, con 10 personas registrándose o
entrando por segundo en la hora punta, el servidor pasa el 100 % del tiempo
bloqueado y los escaneos de puestos, los check-ins y la consola se quedan en
cola. Es la causa más probable de un "la app va lenta" con 4000 personas.

**Propuesta:** cambiar a `crypto.scrypt` (asíncrono, usa el threadpool) con
`util.promisify`. Son dos funciones y sus llamadas pasan a `await`. Bajar N a
8192 también es razonable para este contexto (contraseñas de 6 caracteres para
un evento de dos días no justifican 16 MB por hash).

---

## 🔴 4. Pool de PostgreSQL con 3 conexiones

**Dónde:** `server.js` → `new Pool({ max: 3 })`

**Qué pasa:** cada petición al API hace entre 2 y 4 consultas (buscar sesión,
tocar sesión, buscar persona, la operación). Con 3 conexiones, la cuarta
petición simultánea espera. En la puerta a las 7 pm con varias colas y gente
escaneando dentro, eso son colas invisibles que se manifiestan como "se quedó
cargando". Railway Postgres admite bastante más.

**Propuesta:** `max: 10` a `15`. Ver el límite del plan de Railway
(`max_connections`) y quedarse por debajo de la mitad.

---

## 🟠 5. Reiniciar ingresos no tiene deshacer

**Dónde:** `POST /api/soporte/reiniciar-ingresos`

**Qué pasa:** un organizador lo pulsa el **sábado** a media tarde por error
(o el domingo a las 5 pm creyendo que es otra cosa). Al instante 2000 personas
pasan a "pendiente de ingreso": ya no pueden escanear puestos (403
`sin_ingreso`) y el aforo marca 0. La única forma de volver es que todos pasen
otra vez por la puerta. Hay un `confirm()` en el navegador, que es poco.

**Propuesta:**

- Endpoint `deshacer-reinicio` que vuelva a poner en `checkin` a quien tenga un
  registro `exitoso` en `checkins_log` **del día de hoy** (hora de Lima). Es
  exacto y no inventa nada.
- En la consola, exigir escribir "REINICIAR" en un campo, no solo `confirm()`.
- Ocultar el botón fuera del horario razonable (antes de las 12 del mediodía).

---

## 🟠 6. La "semilla" del sorteo no reproduce nada

**Dónde:** `lib/routes-sorteo.js` → `jugar`

**Qué pasa:** el comentario y el README dicen que con la semilla el resultado es
"reproducible y defendible". Pero `semilla` sale de `randomBytes(16)` y
`numeroGanador` de `randomInt(...)` **por separado**: la semilla no determina el
número. Si alguien impugna, no se puede demostrar que ese número salió de esa
semilla. El sorteo es justo; la auditoría es de mentira.

**Propuesta:** derivar el número de la semilla:
`numeroGanador = BigInt('0x' + sha256(semilla + '|' + premio.id + '|' + totalBoletos)) % BigInt(totalBoletos)`.
Con semilla, premio y total (los tres se guardan) cualquiera recalcula el
número. Mejor aún: publicar el hash de la semilla **antes** de girar y la
semilla después (commit-reveal), pero eso ya es lujo.

---

## 🟠 7. El número de ticket de sorteo puede repetirse

**Dónde:** `store.crearInsignia` → `(SELECT COUNT(*) + 1 FROM insignias …)`

**Qué pasa:** dos personas escanean a la vez → las dos transacciones ven el
mismo `COUNT(*)` y reciben el mismo `ticket_sorteo`. No hay índice único sobre
esa columna. El sorteo no lo usa (cuenta insignias, no números), así que **no
afecta a quién gana**, pero el número que la app le enseña a la persona como
"tu ticket #1042" puede estar repetido y eso genera reclamos.

**Propuesta:** una `SEQUENCE` en PostgreSQL (`nextval`) o simplemente dejar de
mostrar el número y mostrar "tienes N boletos". Lo segundo es un cambio de
texto.

---

## 🟠 8. Contraseña temporal del registro rápido caduca a las 14 h

**Dónde:** `lib/auth.js` → `TEMP_PASSWORD_PUERTA_TTL_MS`

**Qué pasa:** alguien es registrado en puerta el sábado a las 6 pm solo con su
DNI, entra, no abre la app. El domingo a la 1 pm quiere escanear: `CF2026` ya
caducó (19 h después), `login` le pone `password_hash = null` y tiene que ir al
Punto de Ayuda a que le hagan un reset. Cola.

**Propuesta:** 40 horas cubre las dos jornadas. Sigue siendo de un solo uso
porque obliga a cambiarla.

---

## 🟠 9. Límites por IP que comparte todo el staff

**Dónde:** `server.js` y `routes-auth.js`, endpoints con `rateLimit(n, 60000)` sin `keyFn`

Todo el staff está en el mismo wifi del local → una IP para todos. Los topes
que se cuentan por IP son topes **para todo el equipo junto**:

| Endpoint | Tope/min | Riesgo |
|---|---|---|
| `POST /api/soporte/registro-rapido` | 120 | 4 puertas a 1 registro cada 2 s ya lo tocan |
| `POST /api/soporte/buscar` | 60 | 3 personas en Punto de Ayuda a un ritmo normal lo tocan |
| `POST /api/soporte/reset-password` | 60 | poco probable |
| `POST /api/staff/login` | 60 | ok |

Cuando se alcanza, **todas** las puertas reciben 429 durante el resto del minuto.

**Propuesta:** en los endpoints con sesión de staff, contar por actor:
`rateLimit(n, 60000, req => 'staff:' + (req.actor.id || 'token'))`. El
`preHandler` tiene que ir después de `requireStaff` (ya es así en `scan`).

---

## 🟠 10. Bloqueo por DNI se puede usar contra otra persona

**Dónde:** `POST /api/auth/login` y `POST /api/staff/login`

**Qué pasa:** 8 intentos fallidos sobre un DNI lo bloquean 15 minutos. Cualquiera
que sepa el DNI de otro (o el usuario de un staff, que se dicta en voz alta) lo
deja fuera 15 minutos con 8 peticiones. Poco probable en un festival, pero es
trivial y el staff bloqueado en la puerta es un problema.

**Propuesta:** para el staff, que el bloqueo sea **por IP + usuario** en vez de
solo por usuario, o que un organizador pueda desbloquear desde la gestión de
usuarios (poner `locked_until = null`). Lo segundo es un botón.

---

## 🟡 11. No hay tope de aforo en la puerta

`POST /api/tickets/checkin` no mira `aforo_max`. Con 4001 dentro sigue diciendo
"Adelante". La consola muestra el porcentaje pero la puerta no lo ve.

**Propuesta:** devolver `aforo: { dentro, max }` en la respuesta del check-in y
que la app de puerta pinte una banda roja al pasar del 95 %. No bloquear: eso
lo decide un humano.

---

## 🟡 12. Si se cae la red en la puerta no hay plan B en la app

La app de staff no encola nada: sin red, no hay check-in. En un recinto con
4000 celulares, el 4G se degrada; el wifi del local es lo que sostiene la
operación.

No es un cambio de código para esta semana. Es operativo:

- Wifi dedicado para el staff, con contraseña distinta de la del público.
- Un celular con datos de otro operador por puerta, como respaldo.
- El código corto impreso (`CF-1042`) se puede teclear si la cámara falla, pero
  sigue necesitando red.

---

## 🟡 13. La clave temporal de los puestos dura 7 días

Ya se dijo: si se reparten hoy (17), el 26 están caducadas. Repartir el 20 o
después, o subir el TTL a 14 días en `routes-insignias.js` y `routes-importar.js`.

---

## 🟡 14. Un solo proceso de Node

`siguienteCodigo()` y el limitador de tasa viven en memoria. Si Railway
escalara a 2 réplicas, los códigos chocarían (hay reintento, pero con el mismo
contador viejo) y los límites se contarían por separado. **Verificar que el
servicio tiene 1 réplica** y no tocarlo durante el evento.

---

## 🟢 Lo que se revisó y está bien

- **Insignia única por persona y puesto**: índice único en PostgreSQL, el cliente no decide.
- **Escaneo exige ingreso validado** y se relee el estado de la persona en cada petición (no hay caché que se quede viejo tras el reinicio del día 2).
- **Puesto desactivado no da insignias**: `findEmpresaByQr` y `findEmpresaByCodigo` filtran `activo = true`. Quien ya tenía la insignia la sigue viendo.
- **Sorteo decidido en el servidor con `randomInt`**, grabado antes de que gire la ruleta; doble clic lo frena el índice único sobre `premio_id`.
- **Nadie gana dos veces** (`idx_sorteo_un_premio_por_persona`) y **sin nombre no se participa**.
- **Reinicio del día 2** no toca `checkins_log`, insignias ni cuentas; la curva por hora es del día en curso en hora de Lima.
- **Check-in duplicado** se registra como `duplicado`, avisa en pantalla y no bloquea.
- **Registro en puerta** solo con documento, sin bloquear la entrada; consentimiento verbal registrado con su texto.
- **Códigos de ticket** continúan desde el máximo en base tras un reinicio.
- **Detrás de Railway sin Cloudflare**: `X-Forwarded-For` último = cliente real; el limitador por IP distingue visitantes. Verificado con las cabeceras de producción.
- **QR del asistente**: `CF|<24 bytes aleatorios>`, versión 3, lo lee cualquier cámara.
- **Escape en el navegador**: todo lo del servidor pasa por `esc()`/`NM()`; el color por `colorHex()`.
- **Datos de prueba** marcados con `es_prueba` y borrables de un golpe, incluidos sus resultados de sorteo.

---

## Orden sugerido para esta semana

| Día | Qué |
|---|---|
| Hoy/mañana | 3 (scrypt async), 4 (pool), 8 (TTL 40 h), 13 (TTL puestos) — cambios de una línea o dos |
| Antes del 22 | 1 (premio no reclamado) y 2 (solo presentes) — decisión de la organización + código |
| Antes del 22 | 9 (límites por actor), 5 (deshacer reinicio) |
| Si da tiempo | 6, 7, 10, 11 |
| Operativo | 12, 14, y el ensayo completo con datos de prueba: registrar, entrar, escanear, sortear, reiniciar, borrar |

Cada cambio pasa por la revisión de seguridad del `CLAUDE.md` antes de subirse.
