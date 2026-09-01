# ITERA / nodo — Instrucciones del proyecto

## Regla principal: seguridad obligatoria en todo cambio

**Todo código que se escriba o modifique en este proyecto debe pasar por una
revisión de seguridad antes de considerarse terminado.** No es opcional ni hay
que pedirlo: es el comportamiento por defecto.

Esto aplica a cualquier cambio, por pequeño que parezca: una función nueva, un
endpoint, un formulario, un texto que se pinta en pantalla o una dependencia.

### Checklist obligatorio antes de dar por hecho un cambio

1. **XSS / inyección en el navegador**
   - Nunca insertar datos de usuario en `innerHTML`, `outerHTML`, `insertAdjacentHTML`
     ni en atributos (`value="..."`, `href`, `style`) sin pasarlos por `esc()`.
   - Para nombres de personas usar `NM(obj)`; ambos helpers ya existen en
     `public/evento/prototipo.html`.
   - Preferir `textContent` cuando solo se muestra texto.
   - Nunca usar `eval()`, `new Function()`, ni `javascript:` en URLs.

2. **Autenticación y datos personales (PII)**
   - Cualquier endpoint que devuelva o modifique DNI, email, celular, listados de
     asistentes, analítica, check-in o leads **debe** llevar
     `{ preHandler: requireAdmin }`.
   - Nunca añadir un endpoint público que exponga PII.
   - No registrar (log) DNI, email, celular ni tokens en consola.

3. **Base de datos**
   - SQL siempre con consultas parametrizadas (`$1`, `$2`, …). Jamás concatenar
     valores dentro del SQL.

4. **Secretos**
   - Nunca escribir tokens, contraseñas ni `DATABASE_URL` en el código ni en el
     front. Van en variables de entorno y se documentan en `.env.example` con el
     valor vacío.
   - `.env` está en `.gitignore` y debe seguir estándolo.

5. **Abuso y fuerza bruta**
   - Los endpoints públicos de escritura y de búsqueda por identidad llevan
     `{ preHandler: rateLimit(max, ventanaMs) }`.

6. **Validación de entrada**
   - Validar tipo y longitud de lo que llega en `req.body` antes de usarlo.
   - No confiar en la validación del frontend.

7. **Dependencias**
   - Antes de añadir una dependencia nueva, justificar por qué es necesaria y
     preferir la solución sin dependencia si es razonable.

### Al terminar cualquier tarea

Informar explícitamente qué punto del checklist se revisó y si algo quedó
pendiente. Si un cambio introduce un riesgo que no se puede eliminar, decirlo
claramente en vez de darlo por bueno en silencio.

## Contexto técnico

- **Stack:** Fastify + PostgreSQL (`pg`), frontend estático en `public/`.
- **Despliegue:** `git push origin main` → GitHub `capmujcm/Iteraperu` → Railway
  redespliega automáticamente. No hay otro camino a producción.
- **No hay Node.js instalado localmente**, así que el servidor no se puede
  ejecutar en esta máquina. El frontend sí se puede validar en el navegador.
- **Datos personales de peruanos** → aplica la Ley 29733 de Protección de Datos
  Personales. Tratar DNI, email y celular como información sensible.

### Variables de entorno de seguridad

| Variable | Efecto |
|---|---|
| `ADMIN_TOKEN` | Protege los endpoints con PII. Si está vacío, el servidor arranca en modo demo abierto y avisa por consola. |
| `ALLOWED_ORIGINS` | Lista blanca CORS separada por comas. Vacío = solo mismo origen. |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` valida el certificado TLS de PostgreSQL. |

El staff carga su token abriendo la app con `?staff=TOKEN` (se guarda en
localStorage y se limpia de la URL) o con `iteraSetStaffToken('TOKEN')`.
