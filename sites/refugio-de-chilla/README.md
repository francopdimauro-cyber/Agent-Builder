# Web de El Refugio de Chilla (con Refu embebido)

Esta carpeta es la web de **un cliente** del Agent Builder, no el Agent Builder en sí: es un ejemplo real de cómo
queda un negocio que ha publicado un agente como chat. Vive separada de `public/` (el panel del Agent Builder)
a propósito, porque en producción esta web la aloja el cliente (o se sube a cualquier hosting estático), mientras
que `public/` la sirve el Worker del Agent Builder.

## Conectar el chat de verdad

El `<script>` al final de `index.html` trae un `data-chat` de ejemplo que no funciona. Para activarlo:

1. En el panel del Agent Builder, pestaña **Agentes** → **Importar .json** → sube `agents/refu.json` (en la raíz
   del repo) → guarda y actívalo.
2. Pestaña **Chat web** → crea un chat para ese agente → en **webs autorizadas** añade el dominio exacto donde
   vayas a publicar esta web (`https://tudominio.es`, sin ruta).
3. El panel te da una línea `<script src="…/widget.js" data-chat="ID-REAL" defer></script>`: sustituye por esa
   la que hay en `index.html` (también cambia `https://TU-WORKER.workers.dev` por el dominio real de tu Worker).

Nada más de esta web depende del Agent Builder: es HTML y CSS corrientes, puedes copiarla, alojarla donde quieras
y cambiar el contenido del restaurante por el de cualquier otro negocio.
