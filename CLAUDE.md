# ITERA / nodo — Instrucciones del proyecto

## Regla principal: seguridad obligatoria en todo cambio

**Todo código que se escriba o modifique en este proyecto debe pasar por una
revisión de seguridad antes de considerarse terminado.** No es opcional ni hay
que pedirlo: es el comportamiento por defecto.

Esto aplica a cualquier cambio, por pequeño que parezca: una función nueva, un
endpoint, un formulario, un texto que se pinta en pantalla o una dependencia.

### Dos niveles, porque no todo pesa igual

- **BLOQUEANTE** — si esto falla, el cambio no se da por terminado bajo ninguna
  circunstancia. Puntos 1 a 4 y 8.
- **REVISABLE** — hay que verificarlo y decir el resultado. Si algo queda
  pendiente, se dice explícitamente. Puntos 5 a 7 y 9 a 11.

Un sistema que trata todo como crítico termina con nadie revisando nada.

### Checklist obligatorio antes de dar por hecho un cambio

1. **XSS / inyección en el navegador** — BLOQUEANTE
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

7. **Dependencias** — REVISABLE
   - Antes de añadir una dependencia nueva, justificar por qué es necesaria y
     preferir la solución sin dependencia si es razonable.
   - Correr `npm audit` antes de dar por terminado un cambio que toca
     dependencias. Las versiones se fijan; nada de rangos abiertos.

8. **Autorización sobre el objeto, no solo sobre la ruta** — BLOQUEANTE
   - Que un endpoint lleve `requireAdmin` no basta. Si la ruta recibe un id
     (`/asistentes/:id`, `/empresas/:id`, `/insignias/:id`), hay que verificar
     que ese recurso pertenece a quien lo pide o al evento sobre el que tiene
     permiso. Cambiar un número en la URL para ver el registro de otro es el
     fallo más explotado que existe y no lo cubre ningún token global.
   - El control vive en el servidor. Ocultar un botón en el frontend es
     cosmética, no seguridad.
   - Responder "no encontrado" y no "prohibido" cuando el recurso existe pero no
     es del solicitante: "prohibido" confirma que el registro existe.

9. **Sesiones y enumeración** — REVISABLE
   - Los mensajes de error de acceso no distinguen entre "no existe" y
     "contraseña incorrecta". Tampoco en recuperación de contraseña.
   - Al elevar privilegios o cambiar de identidad, emitir sesión nueva. No
     reutilizar la anterior.

10. **Archivos y peticiones salientes** — REVISABLE
    - Archivo subido: validar el tipo real por contenido, no por extensión ni
      por lo que declara el cliente. Límite de tamaño. Guardar fuera de la raíz
      pública y servirlo por una ruta que verifica permisos. Nunca ejecutarlo.
    - Si el servidor consulta una URL que vino de fuera, validar el destino
      contra lista permitida y no seguir redirecciones a direcciones internas.
    - Un parámetro de retorno solo puede apuntar a rutas propias, verificadas
      contra lista, no comparando el inicio del texto.

11. **Rastro de lo sensible** — REVISABLE
    - Las tablas de registro (`acciones_staff`, `checkins_log`, `scans_log`) son
      append-only: no se editan ni se borran filas. Si hace falta corregir, se
      agrega un registro nuevo.

### Al terminar cualquier tarea

Informar explícitamente **qué punto concreto se revisó y cómo se comprobó** — no
"revisé seguridad", sino qué puntos y con qué resultado. Si un punto no aplica al
cambio, decirlo y seguir: enumerar puntos irrelevantes para parecer exhaustivo le
quita valor a la revisión.

Si algo quedó pendiente o hay un riesgo que no se pudo eliminar, decirlo
claramente en vez de darlo por bueno en silencio.

### Si un secreto se expuso

No basta con borrar el commit: **se rota la credencial**. Un token que estuvo en
el historial de git se considera comprometido para siempre.

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
