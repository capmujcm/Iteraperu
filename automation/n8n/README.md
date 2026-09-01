# Automatización de publicación en Meta con n8n

Publica un carrusel simultáneamente en Instagram (carrusel nativo) y en la página de
Facebook (álbum), a partir de una sola llamada HTTP.

- **Workflow:** [`itera-publicar-meta.json`](itera-publicar-meta.json) — importar en n8n con
  *Workflows → Import from File*.

---

## 1. Requisitos previos en Meta

Sin esto la API rechaza todo, sin importar cómo esté armado el workflow:

1. Cuenta de **Instagram profesional (Empresa)** vinculada a la **página de Facebook**.
2. Una **app** en developers.facebook.com con el producto *Instagram Graph API* añadido.
3. Permisos concedidos: `instagram_basic`, `instagram_content_publish`,
   `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`.
4. Un **token de acceso de página de larga duración** (60 días, renovable).
   El mismo token sirve para Instagram y para Facebook.
5. Los permisos de publicación requieren **App Review + verificación de negocio** de Meta
   para funcionar fuera del modo desarrollo. Es el trámite más lento del proceso
   (días, no horas). Planifícalo antes que el resto.

Anota dos valores: el **Instagram User ID** y el **Facebook Page ID**.

## 2. Configuración en n8n

1. Importa el workflow.
2. Crea una credencial de tipo **Header Auth**:
   - Nombre del encabezado: `Authorization`
   - Valor: `Bearer <TOKEN_DE_PAGINA>`
3. Asígnala a los cinco nodos HTTP Request.
4. Abre el nodo **Config** y reemplaza `PEGA_AQUI_EL_INSTAGRAM_USER_ID` y
   `PEGA_AQUI_EL_FACEBOOK_PAGE_ID`.

## 3. Uso

```bash
curl -X POST https://TU-N8N/webhook/itera-publicar -H "Content-Type: application/json" -d '{"caption":"Texto del post con #hashtags","images":["https://tu-dominio.com/assets/social/post-1.jpg","https://tu-dominio.com/assets/social/post-2.jpg"]}'
```

## 4. Límites reales de la API

| Restricción | Valor |
|---|---|
| Imágenes por carrusel | 2 a 10 |
| Publicaciones por cuenta IG | 50 por cada 24 h |
| Formato de imagen | JPEG, URL **pública** (la API descarga el archivo; no acepta subida directa ni URLs privadas) |
| Relación de aspecto IG | entre 4:5 y 1.91:1 |
| Caracteres del pie | 2 200 |
| Hashtags | 30 |
| Vigencia del contenedor sin publicar | 24 h |

Las imágenes deben estar en una URL pública. La vía más simple con este repositorio es
activar **GitHub Pages** en `main`: las artes de `assets/social/` quedan servidas en
`https://<usuario>.github.io/<repo>/assets/social/post-1.jpg`.

## 5. Notas de operación

- El nodo *Esperar procesamiento* da 15 s a Meta para procesar el carrusel. Si aparece
  el error `Media ID is not available`, sube esa espera o consulta
  `GET /{container-id}?fields=status_code` hasta obtener `FINISHED`.
- Las **historias** usan `media_type=STORIES` en un contenedor simple, sin `children`.
- Los **reels** usan `media_type=REELS` con `video_url`, y necesitan una espera mayor
  (30–60 s) porque el procesamiento de video es más lento.
