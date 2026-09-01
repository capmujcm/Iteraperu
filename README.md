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
  evento/
    prototipo.html        Plataforma de eventos     →  /evento y rutas por rol
    qr-test.html          Banco de pruebas del motor QR
  assets/                 Isotipo, logotipo, SVG y piezas para redes
db/
  schema.sql              Esquema de referencia de PostgreSQL
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
| `/evento` | Prototipo de la plataforma de eventos |
| `/asistente` `/persona` `/empresa` `/organizador` `/proveedor` `/staff` `/ayuda` | El mismo prototipo, abierto en el rol correspondiente |
| `/api/*` | API del evento (health, events, attendees, tickets, stands, qa, leads) |

## Desarrollo local

```bash
npm install
npm run dev     # node --watch server.js
```

Servidor en `http://localhost:3000`. Sin `DATABASE_URL` la API funciona igual usando el store in-memory.

## Variables de entorno

Ver [`.env.example`](.env.example): `PORT`, `NODE_ENV`, `DATABASE_URL`.

---

© 2026 ITERA. Todos los derechos reservados.
