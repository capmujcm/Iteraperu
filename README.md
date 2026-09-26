# ITERA — Transformamos la forma en que trabajan las empresas

> **ITERA** es un socio estratégico de transformación empresarial, optimización de procesos, automatización inteligente y ciencia de datos aplicada para organizaciones en crecimiento.

- **Producción:** https://iteraperu.pe (Railway)
- **Stack:** Node 18+ · Fastify · PostgreSQL (con fallback in-memory)

---

## Estructura del Repositorio

```
public/                   Todo lo que se sirve al navegador (static root)
  index.html              Landing oficial de ITERA  →  /
  brand-deck.html         Manual de marca           →  /brand
  cf/                     APP REAL de Country Fest
    app.css               Estilos compartidos
    app.js                Núcleo: QR, cámara, navegación, cliente de la API
    asistente.html        App del asistente         →  /e/country-fest
    staff.html            Punto de Ayuda            →  /staff/country-fest
    negocio.html          Panel del puesto          →  /negocios/country-fest
    consola.html          Consola del organizador   →  /consola/country-fest
  evento/
    prototipo.html        Prototipo comercial       →  /evento  (autónomo, sin API)
    qr-test.html          Banco de pruebas del motor QR
  assets/                 Isotipo, logotipo, SVG y piezas para redes
lib/
  auth.js                 Contraseñas (scrypt), tokens de sesión y de QR
  store.js                Capa de datos: driver PostgreSQL y driver en memoria
  routes-auth.js          Rutas de registro, ingreso y soporte
  routes-insignias.js     Puestos, insignias y tickets de sorteo
  routes-empresa.js       Rol Empresa: acceso, ficha, logo y panel
  routes-staff.js         Cuentas de staff, roles y bitácora de acciones
db/
  schema.sql              Esquema de PostgreSQL. Idempotente: se aplica en cada arranque
automation/
  n8n/                    Workflows de automatización (publicación en Meta)
server.js                 Servidor Fastify: API + rutas de páginas
```

Nada fuera de `public/` es accesible por HTTP.

## Rutas

| Ruta | Sirve |
|---|---|
| `/` | Landing ITERA |
| `/brand` | Brand deck |
| `/e/country-fest` | **App real del asistente** (`/e`, `/entrada` redirigen aquí) |
| `/staff/country-fest` | **Punto de Ayuda** — usuario y contraseña de staff |
| `/negocios/country-fest` | **Panel del puesto participante** |
| `/consola/country-fest` | **Consola del organizador** — solo rol organizador |
| `/evento` | Prototipo comercial, con datos ficticios |
| `/api/*` | API del evento |

### App real vs. prototipo

Son dos cosas distintas y conviene no confundirlas:

- **`/cf/`** es la aplicación funcional de Country Fest. Habla con la API, escribe
  en PostgreSQL y es lo que se usa el día del evento. Un archivo por rol:
  `asistente.html` y `staff.html`, con `app.css` y `app.js` compartidos.
- **`/evento`** es el prototipo de venta: 44 pantallas navegables, cuatro roles,
  datos inventados. **Es autónomo**: no llama a la API ni toca la base de datos,
  así que enseñarlo a un cliente no crea asistentes reales. Toda la API está
  simulada dentro del propio archivo.

## Cuentas de staff y roles

Cada persona del equipo tiene **su usuario y su contraseña**. No hay token
compartido en el día a día.

| Acción | staff | organizador |
|---|---|---|
| Validar ingreso, registro rápido, buscar por DNI | ✅ | ✅ |
| Restablecer contraseña de un asistente | ✅ | ✅ |
| Consola con métricas del evento | — | ✅ |
| Crear puestos y emitir sus QR | — | ✅ |
| **Descargar los CSV con DNI y correos** | — | ✅ |
| Gestionar usuarios de staff | — | ✅ |

Los botones que no corresponden se ocultan, pero **la comprobación real está en
el servidor** (`requireRol` en `lib/routes-staff.js`). Manipular la interfaz no
sirve de nada.

### Arrancar desde cero

Todavía no hay usuarios, así que el primer organizador se crea con el
`ADMIN_TOKEN`:

1. `iteraperu.pe/staff/country-fest` → «Usar el token de emergencia» → pega el
   `ADMIN_TOKEN` de las variables de Railway.
2. Menú → **Usuarios de staff** → **Crear usuario**, rol `organizador`.
3. Anota el usuario y la clave temporal: se muestran **una sola vez**.
4. Cierra sesión, entra con tu usuario y define tu contraseña.
5. Crea al resto del equipo con rol `staff`.

Después, guarda el `ADMIN_TOKEN` y deja de repartirlo.

### El ADMIN_TOKEN como llave de emergencia

Se conserva para crear el primer organizador y para recuperar el acceso si el
último organizador pierde su clave. Actúa como organizador y sus acciones se
registran como «Token de emergencia», sin nombre. Cambiarlo invalida
inmediatamente ese camino, no las sesiones de los usuarios.

### Autoría verificada

El nombre que queda en cada check-in y en cada restablecimiento sale de la
**sesión**, no del cuerpo de la petición. Antes el staff lo escribía a mano y
cualquiera podía poner el de otro. Las acciones de gestión quedan además en
`acciones_staff`.

Se puede **desactivar** a una persona: sus sesiones se cierran al instante. No
se borra la cuenta, porque sus acciones pasadas deben seguir teniendo autor. El
sistema no permite desactivar al último organizador activo.

| Endpoint | Acceso |
|---|---|
| `POST /api/staff/login` | Público (60/min por IP; 8 fallos bloquean la cuenta) |
| `GET /api/staff/me` · `POST /api/staff/logout` | Sesión de staff |
| `POST /api/staff/change-password` | Sesión de staff |
| `GET`/`POST /api/staff/usuarios` | Organizador |
| `POST /api/staff/usuarios/:id/clave` | Organizador — repone la clave |
| `POST /api/staff/usuarios/:id/activo` | Organizador — activa o desactiva |
| `POST /api/staff/usuarios/:id/desbloquear` | Organizador — quita el bloqueo por intentos fallidos |
| `GET /api/staff/acciones` | Organizador — bitácora |

## Acceso de los asistentes

Cada persona entra con su **DNI y una contraseña que elige ella misma** al
registrarse. La sesión queda abierta en ese dispositivo mediante un token que
emite el servidor; no depende del celular ni de enlaces por WhatsApp.

- Las contraseñas se guardan con `scrypt` (hash + sal). Nunca en claro.
- Mínimo 6 caracteres, sin más reglas: público general en la cola de un evento.
- Tras 8 intentos fallidos sobre un mismo documento, ese documento se bloquea 15
  minutos.

### Si alguien olvida su contraseña

Solo el staff puede restablecerla, desde **Punto de Ayuda → Restablecer
contraseña**, previa verificación del documento físico:

1. Se asigna la contraseña temporal `CF2026`, **válida 30 minutos**.
2. Se cierran todas las sesiones abiertas de esa persona.
3. Queda registrado en `password_resets_log` quién la restableció y cuándo.
4. Al ingresar, la persona **está obligada a definir una contraseña propia**;
   hasta que lo haga, el resto de la API le responde 403.

`CF2026` es un valor público que se dicta en voz alta, por eso caduca y fuerza
el cambio. Si expira sin usarse, la cuenta queda sin contraseña y hay que
repetir el trámite en el Punto de Ayuda.

## Endpoints de autenticación

| Endpoint | Acceso |
|---|---|
| `POST /api/auth/register` | Público (90/min por IP) — exige `acepta_privacidad` |
| `POST /api/auth/login` | Público (150/min por IP; 8 fallos bloquean el DNI) |
| `POST /api/auth/change-password` | Sesión de la persona |
| `GET /api/auth/me` | Sesión de la persona |
| `POST /api/auth/logout` | Sesión de la persona |
| `POST /api/soporte/reset-password` | Sesión de staff (30/min por persona) |
| `POST /api/soporte/buscar` | Sesión de staff (60/min por persona) — búsqueda por DNI |

No hay ningún endpoint público que devuelva datos de una persona. El antiguo
`POST /api/tickets/verify` se retiró: permitía recorrer los códigos correlativos
(CF-1000, CF-1001…) y sacar la lista de nombres.

### Límites de peticiones

En el recinto cientos de celulares comparten la misma dirección (NAT de los
operadores y wifi del local), así que la IP identifica al local, no a quien
llama. De ahí el criterio:

- **Endpoints públicos** (registro web y los tres logins): topes por IP altos
  —90 registros, 150 ingresos por minuto— porque ahí todavía no hay sesión que
  identifique a nadie. La fuerza bruta la frena el bloqueo por cuenta: 8
  intentos fallidos sobre un mismo DNI o usuario lo bloquean 15 minutos.
- **Todo lo que ya pasó por una guardia** se cuenta **por persona**, no por IP:
  escaneos de puestos (20/min por asistente), registro rápido (60/min por
  miembro del staff), reseteo de contraseña (30/min), búsqueda por DNI y alta
  de puestos (60/min). Un tope por IP aquí era un tope para el equipo entero:
  cuando una puerta lo agotaba, las demás recibían 429 sin haber hecho nada.

El bloqueo por usuario tiene un filo: como es por cuenta y no por quien lo
intenta, alguien puede dejar fuera a un miembro del staff con ocho peticiones.
Por eso el organizador puede levantarlo desde **Usuarios de staff**
(`POST /api/staff/usuarios/:id/desbloquear`) sin tocarle la contraseña.

### Contraseñas

Se guardan con `scrypt` (hash + sal), nunca en claro. El hashing es
**asíncrono** (`crypto.scrypt`, no `scryptSync`): la versión síncrona bloquea el
hilo de Node ~100 ms por contraseña, y durante ese tiempo el servidor no atiende
nada más —ni un escaneo, ni un check-in—. En la hora punta de la puerta eso
dejaba el proceso bloqueado casi todo el rato.

Consecuencia para quien toque este código: `auth.hashPassword` y
`auth.verifyPassword` devuelven promesas. **Toda llamada lleva `await`.** Sin él,
`verifyPassword(...)` devuelve un objeto Promise, que es *truthy*, y un
`if (!auth.verifyPassword(...))` dejaría entrar cualquier contraseña. Se
comprueba con:

```bash
grep -rn "auth.hashPassword(\|auth.verifyPassword(" lib/ server.js | grep -v "^lib/auth.js" | grep -v "await "
```

que debe devolver cero líneas.

### Dos días de evento

`POST /api/soporte/reiniciar-ingresos` (organizador, cuerpo
`{ "confirmar": "REINICIAR" }`) pone a todos los que figuran como «dentro» de
vuelta en «pendiente de ingreso». Se pulsa desde la consola antes de abrir
puertas el segundo día. No toca `checkins_log`, ni las cuentas, ni las insignias.
Las curvas por hora de la consola y del panel del puesto muestran solo el día en
curso, en hora de Lima (`EVENT_TZ`).

Es la operación más destructiva de la consola: deja el aforo a cero y nadie
puede escanear puestos hasta volver a pasar por la puerta. Por eso pide escribir
`REINICIAR` a mano, y por eso existe la vuelta atrás:
`POST /api/soporte/deshacer-reinicio` (cuerpo `{ "confirmar": "DESHACER" }`)
devuelve a «dentro» a quien tenga un ingreso **exitoso de hoy** en
`checkins_log`. No adivina: quien no pasó por la puerta hoy, no vuelve.

## Dinámica de insignias y sorteo

Cada puesto participante tiene un QR impreso. El asistente lo escanea y gana
**una** insignia de ese puesto, que vale un ticket para el sorteo.

| Endpoint | Acceso |
|---|---|
| `GET /api/empresas` | Público — catálogo **sin** los tokens de QR |
| `POST /api/insignias/scan` | Sesión de la persona |
| `GET /api/insignias/mias` | Sesión de la persona — incluye `premio` si esa persona ganó y el resultado sigue vigente |
| `GET /api/sorteo/premios-publicos` | Público — premios, quién los regala y si ya se sortearon; **sin** ganadores ni recuentos |
| `POST /api/soporte/empresas` | Organizador — alta de puesto |
| `PATCH /api/soporte/empresas/:id` | Organizador — corregir datos o dar de baja / reactivar |
| `GET /api/soporte/empresas` | Organizador — puestos con su QR para imprimir |
| `GET /api/sorteo/estado` | Organizador — admite `?solo_presentes=false` |
| `POST /api/sorteo/jugar` | Organizador — cuerpo `{ solo_presentes }` opcional |
| `POST /api/sorteo/resultados/:id/no-reclamado` | Organizador — declara el premio desierto |
| `POST /api/soporte/empezar-de-cero` | **Temporal** (limpieza del ensayo del día 1; retirar tras usarlo). Organizador, cuerpo `{ "confirmar": "EMPEZAR DE CERO" }`. Reinicia ingresos, borra todas las insignias y todo el sorteo; se niega con más de 20 personas dentro. No toca personas, entradas, puestos ni claves. Botón en la consola junto a «Reiniciar ingresos» |
| `POST /api/sorteo/reiniciar` | Organizador — cuerpo `{ "confirmar": "BORRAR SORTEO" }`. Borra **todos** los premios y resultados; no toca insignias, personas, puestos ni ingresos. Deja en `acciones_staff` cada resultado borrado (posición, premio, código, hora). Botón «Borrar todo el sorteo» al final de «Premios» |

### Quién participa

- **Hay que estar en el recinto.** Solo entra al bombo quien tiene el ingreso
  validado en ese momento. El evento dura dos días: sin esta regla, el domingo
  —después de reiniciar ingresos— quien vino solo el sábado seguía participando
  con todas sus insignias y podía salir premiado desde su casa. La pantalla del
  sorteo lleva una casilla para ver el recuento con y sin el filtro antes de
  girar, y el criterio de cada sorteo queda en `acciones_staff`.
  La condición se avisa **antes**: está en las bases y en «Mis insignias».
- **Sin nombre no se participa.** Quien fue registrado en puerta solo con su
  documento y no completó su nombre queda fuera del bombo hasta que lo ponga:
  no se puede anunciar a alguien sin nombre en la pantalla. La app se lo avisa
  en «Mis insignias».
- **Nadie gana dos veces**, ni aunque su premio quedara desierto: quien sale
  pierde el turno.

### Si el ganador no se presenta

Pasa: la persona se fue temprano, no oye su nombre, está en la cola de un
puesto. `POST /api/sorteo/resultados/:id/no-reclamado` (organizador) declara el
premio desierto desde la propia pantalla del sorteo: botón «No se presentó» en
la barra mientras el ganador está en pantalla, o desde «Premios» para cualquier
premio ya sorteado (sirve si la pantalla se recargó o ya se pasó al siguiente).
Tras declararlo desierto, la pantalla se queda en ese mismo premio para volver
a sortearlo.

Para que el ganador se entere aunque no oiga su nombre, su app muestra
«¡Ganaste el Nº premio!» en «Mi entrada» y en «Mis insignias» (se refresca al
volver a la app, como mucho una vez por minuto). Si el premio se declara
desierto, el aviso desaparece.

### En el escenario

Después de un ganador, el botón principal dice **«Siguiente premio →»** y solo
presenta el premio que sigue (con el logo de quien lo regala); el sorteo es el
toque siguiente. Antes, el mismo botón que acababa de dar un ganador sorteaba
el siguiente premio de inmediato: un toque de más era un resultado grabado que
solo se podía deshacer declarándolo desierto, y eso le quita el turno a alguien
que no hizo nada.

La pantalla está probada a 1280×720: el logo, el premio, el ganador y su código
caben sin que la barra los tape. La lista de ganadores ocupa como mucho un 20 %
del alto y se desplaza.

El resultado **no se borra: se marca**. El premio vuelve a estar pendiente y se
puede sortear otra vez; la lista de ganadores sigue mostrando al primero,
tachado. Borrar el resultado sería borrar lo que pasó en el escenario delante de
4000 personas.

La unicidad es «un resultado **vigente** por premio» (índice parcial
`idx_sorteo_premio_vigente`), así que dos pulsaciones del botón siguen sin poder
sortear dos veces lo mismo.

### Cómo está protegido el sorteo

- **Una insignia por persona y puesto** es un índice único en PostgreSQL
  (`insignia_unica_por_puesto`). El duplicado lo decide la base de datos, no el
  navegador. Antes esto se comprobaba en `localStorage`, así que cualquiera con
  la consola se daba tickets.
- **El número de boleto sale de una secuencia** de PostgreSQL
  (`insignias_ticket_seq`). Antes salía de `COUNT(*) + 1` dentro del `INSERT`:
  dos personas escaneando a la vez se llevaban el mismo número.
- **El ganador lo decide el servidor** y queda grabado antes de que la ruleta
  empiece a girar. La animación es puro teatro.
- **El resultado se puede recalcular.** El número ganador se deriva de la
  semilla: `sha256(semilla|premio_id|total_boletos) mod total_boletos`. Con los
  tres valores, que quedan guardados, cualquiera reproduce el resultado. Antes
  la semilla y el número eran dos aleatorios independientes, así que guardar la
  semilla no demostraba nada.
- **Ensayar no quema los premios.** Al borrar los datos de prueba se borran
  también los resultados de sorteo de personas de prueba, así que los premios
  vuelven a quedar libres.
- **Hay que haber validado el ingreso** para poder escanear
  (`EXIGIR_INGRESO_PARA_ESCANEAR`, activo por defecto).
- **Todo intento queda en `scans_log`** con su dispositivo y resultado.

### Límite conocido

El QR del puesto es **estático e impreso**. Si alguien lo fotografía y lo
comparte, quien reciba la foto puede ganar la insignia sin pasar por el stand.
Exigir el ingreso validado acota el daño a quienes sí están en el evento, y
`scans_log` permite detectar el patrón (cientos de escaneos del mismo puesto en
pocos minutos desde dispositivos dispersos). La solución completa es un QR
rotativo por puesto, que exige una pantalla en cada stand: **está pendiente**.

### Dar de alta los puestos

Punto de Ayuda → **Puestos y sus QR**. Cada puesto genera su ficha imprimible
con el QR y un código corto de respaldo (`P-4K7Q`) para cuando la cámara no lee
por sol directo o pantalla sucia.

Al crearlo se devuelve **una sola vez** la clave temporal de acceso del puesto.
Anótala: no se guarda en claro. Si se pierde, hay un botón en la ficha para
generar otra.

### Importar el padrón completo de una vez

Dar de alta 72 puestos a mano son 72 formularios y 72 ocasiones de escribir mal
un nombre. El padrón del Country Fest 2026 vive en
[`db/puestos-countryfest-2026.json`](db/puestos-countryfest-2026.json) y se
carga desde **Consola del organizador → Importar el padrón de puestos**.

| Endpoint | Acceso | Qué hace |
|---|---|---|
| `GET /api/soporte/empresas/importar` | organizador | Cuántos puestos trae el archivo y cuántos ya existen |
| `POST /api/soporte/empresas/importar` | organizador | Crea los que faltan, corrige los que están |

Es idempotente y se puede repetir. **No borra nada**, y a un puesto que ya
existe nunca le cambia el QR, el código impreso ni el usuario: los carteles
pueden estar ya colgados. Los puestos que sobren se desactivan a mano; un
import que borra es un import que un día se ejecuta dos veces y se lleva por
delante las insignias de la gente.

Las claves temporales de los puestos creados se muestran una sola vez y se
bajan en CSV desde el mismo botón.

#### Los datos personales no están en el repositorio

El repositorio es público, y un nombre con su celular dentro del historial de
git ya no se puede retirar. Por eso el archivo versionado **solo lleva el
catálogo**: marca, stand, zona, emoji, color y descripción del negocio.

Los nombres y teléfonos de los responsables van en
`datos-privados/contactos-countryfest-2026.json`, que está en `.gitignore`, se
queda en la máquina de la organización y se adjunta en el momento de importar:

```json
{
  "contactos": [
    { "usuario": "micaobakery", "responsable": "…", "telefono": "9…", "whatsapp": "9…" }
  ]
}
```

Se cruzan por `usuario`. Si no se adjunta el archivo, los puestos se crean
igual y se quedan sin datos de contacto.

#### Regenerar el catálogo

Sale de dos archivos de la organización: la numeración de stands (hoja 1) y las
respuestas del formulario de inscripción, cruzados por nombre de marca. Cuando
una marca ocupa dos espacios (`A24/A25`) es **un solo puesto** con una sola
insignia: dos QR para la misma marca darían dos boletos de sorteo por la misma
visita.

## El puesto como usuario: `/negocios/country-fest`

El responsable del puesto entra con su **usuario** (`micaobakery`) y la clave que
le dio la organización. No con el código impreso bajo su QR (`P-4K7Q`): ese está
a la vista de todo el recinto y usarlo como identificador de acceso regalaba la
lista de usuarios válidos. La clave temporal caduca a los 7 días y le obliga a
definir la suya al entrar.

| Endpoint | Acceso |
|---|---|
| `POST /api/negocio/login` | Público (60/min por IP; 8 fallos bloquean la cuenta) |
| `GET /api/negocio/me` | Sesión del puesto |
| `POST /api/negocio/change-password` | Sesión del puesto |
| `PATCH /api/negocio/perfil` | Sesión del puesto |
| `POST /api/negocio/logo` | Sesión del puesto |
| `DELETE /api/negocio/logo` | Sesión del puesto |
| `GET /api/negocio/stats` | Sesión del puesto |
| `GET /api/empresas/:id/logo` | Público — la imagen |
| `POST /api/soporte/empresas/:id/acceso` | Token de staff — repone la clave |

Las sesiones de puesto viven en `sesiones_empresa`, tabla aparte de la de los
asistentes: un token de una **no sirve** como token de la otra.

### El logo es la insignia

Lo que sube el puesto es la imagen que se queda en el celular de cada asistente
que lo visitó. Sin logo, la insignia muestra el emoji del puesto.

Se guarda en PostgreSQL (`bytea`), no en disco: el sistema de archivos de
Railway es efímero y cada redespliegue borraría los logos. Los listados
devuelven solo `tiene_logo`; los bytes se piden por `/api/empresas/:id/logo`.

**Reglas de la subida** — es la superficie de ataque más expuesta del proyecto:

- El tipo se decide por los **bytes reales** del archivo, nunca por el `mime`
  que declare el cliente.
- Solo PNG, JPG y WebP. **SVG rechazado**: puede contener `<script>` y se
  ejecutaría en el navegador de cada asistente que viera la insignia — un XSS
  almacenado con alcance a todo el evento.
- Máximo 4 MB, con `bodyLimit` propio en la ruta (se calcula desde ese tope).
- **El navegador reescala antes de subir** (`reducirLogo()` en `negocio.html`):
  512 px de lado máximo, objetivo ~180 KB, a WebP si el navegador sabe
  escribirlo y si no a PNG/JPG. Por eso el puesto puede elegir un archivo de
  hasta 12 MB aunque el servidor solo acepte 4: lo que viaja son ~150 KB. Si el
  reescalado no se puede hacer, se sube el original y manda el tope de 4 MB.
  Es una mejora de peso, no un control de seguridad: el servidor revalida todo.
- Al servirla: `X-Content-Type-Options: nosniff` y `Content-Type` explícito.

### Qué NO ve el puesto

Solo cifras agregadas: insignias entregadas, escaneos, repetidos y curva por
hora. **No ve quién le escaneó.** Compartir datos identificables de los
asistentes con un tercero exigiría un consentimiento específico que no se pide
en el registro, y el aviso de privacidad dice lo contrario. Ofrecer captación de
leads a los puestos no es un ajuste de código: es un cambio legal.

## Desarrollo local

```bash
npm install
npm run dev     # node --watch server.js
```

Servidor en `http://localhost:3000`.

Con `DATABASE_URL` definida, el esquema de `db/schema.sql` se aplica solo en
cada arranque (es idempotente). Sin `DATABASE_URL` el servidor arranca con un
store en memoria y avisa por consola: **todo se pierde al reiniciar**, así que
ese modo no sirve para una prueba real.

## Variables de entorno

Ver [`.env.example`](.env.example). Las que importan para operar:

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Sin ella no hay persistencia |
| `ADMIN_TOKEN` | Sin él, el Punto de Ayuda y el check-in quedan cerrados (503) |
| `ALLOWED_ORIGINS` | Lista blanca CORS. Vacío = solo mismo origen |
| `EVENT_SLUG` / `EVENT_NAME` | Identidad del evento activo |
| `EVENT_PLACE` / `EVENT_AFORO` | Lugar y aforo (4000). Se reaplican en cada arranque |
| `EVENT_TZ` | Zona horaria de las curvas por hora. Por defecto `America/Lima` |
| `SEED_DEMO` | `true` siembra asistentes ficticios. Apagar en pruebas reales |

---

© 2026 ITERA. Todos los derechos reservados.

## Consola del organizador: `/consola/country-fest`

Solo lectura y descargas, con el mismo `ADMIN_TOKEN` que el Punto de Ayuda.
Muestra aforo en vivo, registrados, tickets de sorteo, puestos activos, la curva
de ingresos por hora y los últimos check-ins. Se refresca sola cada 20 segundos
y **deja de consultar cuando la pestaña está oculta**, para no machacar la base
durante las horas que queda abierta.

Las acciones que tocan a personas —validar ingreso, restablecer contraseñas,
dar de alta puestos— viven en el Punto de Ayuda, donde queda registrado quién
las hizo.

### Exportar los datos

`GET /api/export/asistentes`, `/checkins` o `/insignias` (token de staff).
Devuelve CSV con BOM para que Excel en Windows respete las tildes; añade
`?formato=json` si prefieres JSON.

El CSV escapa comillas y saltos de línea, y **antepone una comilla simple a las
celdas que empiezan por `=`, `+`, `-` o `@`**: sin eso, un nombre que empiece
por `=` lo ejecutaría Excel como fórmula al abrir el archivo.

Estos archivos llevan DNI, correo y celular. Cada descarga queda registrada en
los logs del servidor (el hecho y el número de filas, nunca el contenido).

## Cabeceras de seguridad

Se envían a mano desde `server.js`, sin `@fastify/helmet`: `Content-Security-Policy`,
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy` y `Strict-Transport-Security` (esta última solo sobre HTTPS,
para no dejar clavado el navegador en desarrollo local).

La CSP permite `'unsafe-inline'` en scripts porque las apps llevan su JavaScript
en el propio HTML. Eso limita su valor frente a un XSS, pero `default-src 'self'`
sigue impidiendo que un script inyectado envíe los datos fuera, y
`frame-ancestors 'none'` bloquea el clickjacking sobre el Punto de Ayuda.
**Pendiente:** separar los scripts a archivos propios y quitar `'unsafe-inline'`.
