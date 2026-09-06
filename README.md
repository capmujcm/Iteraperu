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
| `/staff/country-fest` | **App real del Punto de Ayuda** (requiere `?staff=TOKEN`) |
| `/negocios/country-fest` | **Panel del puesto participante** |
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

### Poner en marcha el Punto de Ayuda

El equipo de staff abre `https://iteraperu.pe/staff/country-fest?staff=EL_TOKEN`.
El token se guarda en ese navegador y se borra de la barra de direcciones al
instante. Después el staff escribe su nombre y su puesto, que quedan registrados
en cada ingreso que valide y en cada contraseña que restablezca.

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
| `POST /api/auth/register` | Público (10/min) — exige `acepta_privacidad` |
| `POST /api/auth/login` | Público (15/min) |
| `POST /api/auth/change-password` | Sesión de la persona |
| `GET /api/auth/me` | Sesión de la persona |
| `POST /api/auth/logout` | Sesión de la persona |
| `POST /api/soporte/reset-password` | Token de staff |
| `POST /api/soporte/buscar` | Token de staff — búsqueda por DNI |

`POST /api/tickets/verify` es público pero **solo resuelve por token de QR o
código de ticket**, y devuelve nombre, código, tipo y estado. Nunca DNI, correo
ni celular.

## Dinámica de insignias y sorteo

Cada puesto participante tiene un QR impreso. El asistente lo escanea y gana
**una** insignia de ese puesto, que vale un ticket para el sorteo.

| Endpoint | Acceso |
|---|---|
| `GET /api/empresas` | Público — catálogo **sin** los tokens de QR |
| `POST /api/insignias/scan` | Sesión de la persona |
| `GET /api/insignias/mias` | Sesión de la persona |
| `POST /api/soporte/empresas` | Token de staff — alta de puesto |
| `GET /api/soporte/empresas` | Token de staff — puestos con su QR para imprimir |

### Cómo está protegido el sorteo

- **Una insignia por persona y puesto** es un índice único en PostgreSQL
  (`insignia_unica_por_puesto`). El duplicado lo decide la base de datos, no el
  navegador. Antes esto se comprobaba en `localStorage`, así que cualquiera con
  la consola se daba tickets.
- **El número de ticket lo asigna el servidor** dentro del mismo `INSERT`. En
  dos pasos daría números repetidos cuando dos personas escanean a la vez.
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

## El puesto como usuario: `/negocios/country-fest`

El responsable del puesto entra con su código (`P-4K7Q`) y la clave que le dio
la organización. Caduca a los 7 días y le obliga a definir la suya al entrar.

| Endpoint | Acceso |
|---|---|
| `POST /api/negocio/login` | Público (15/min) |
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
- Máximo 400 KB, con `bodyLimit` propio en la ruta.
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
| `SEED_DEMO` | `true` siembra asistentes ficticios. Apagar en pruebas reales |

---

© 2026 ITERA. Todos los derechos reservados.
