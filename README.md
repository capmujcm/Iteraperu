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
  evento/
    prototipo.html        Prototipo comercial       →  /evento  (autónomo, sin API)
    qr-test.html          Banco de pruebas del motor QR
  assets/                 Isotipo, logotipo, SVG y piezas para redes
lib/
  auth.js                 Contraseñas (scrypt), tokens de sesión y de QR
  store.js                Capa de datos: driver PostgreSQL y driver en memoria
  routes-auth.js          Rutas de registro, ingreso y soporte
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
