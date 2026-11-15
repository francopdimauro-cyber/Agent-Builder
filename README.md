# Agent Factory Free

Réplica propia y gratuita de *Agent Factory*: diseña agentes de IA (rol, objetivo, instrucciones, herramientas),
ejecútalos, encadénalos en flujos y supervisa todo con aprobaciones humanas y auditoría.

**Sin dependencias de runtime**: corre en Node ≥ 22.18 (SQLite integrado, `node:sqlite`) **o en Cloudflare Workers** (Durable Object con SQLite), con la API de NVIDIA (modelos Nemotron).

> **Estado:** backend completo y probado; interfaz web con agentes, centro de ejecución y **chat público para webs** (`public/`).

## Arranque

```sh
cp .env.example .env        # pega tu NVIDIA_API_KEY en .env (nunca la subas a git ni la pegues en chats)
npm run models              # comprueba que los identificadores de AI_MODELS existen
npm start                   # http://127.0.0.1:3000
npm test                    # tests (usan un NVIDIA simulado: no gastan cuota)
```

`npm install` solo hace falta para `npm run typecheck` (TypeScript y tipos de Node).

## Despliegue en Cloudflare Workers (desde GitHub)

La app entera vive en **un Durable Object con almacenamiento SQLite** (`src/worker.ts`), así que conserva la base de datos
síncrona, las transacciones y el trigger de versiones inmutables. Las rutas `/api/*` pasan por el Worker; `public/` lo sirve Cloudflare.

1. **Sube el repo a GitHub** (`.env` y `.dev.vars` están en `.gitignore`).
2. En el panel de Cloudflare: **Workers & Pages → Create → Import a repository** y elige el repo.
   - Nombre del Worker: el de `wrangler.toml` (`agent-factory-free`). Usa un nombre **nuevo**; no reutilices Workers existentes.
   - Comando de build: *(vacío)* · Comando de despliegue: `npx wrangler deploy`
3. En el Worker → **Settings → Variables and Secrets → Add** → tipo **Secret**, nombre `NVIDIA_API_KEY`, valor tu clave `nvapi-…`.
   Vuelve a desplegar (o pulsa *Deploy*) para que la tome.
4. Abre la URL `https://agent-factory-free.<tu-subdominio>.workers.dev`: debe aparecer la pantalla de inicio de sesión.
5. Crea tu cuenta (`POST /api/auth/register`) y **después** pon `ALLOW_REGISTRATION = "false"` en `wrangler.toml` y haz push,
   para que nadie más pueda registrarse y gastar tu cuota de NVIDIA.

Cada `git push` a `main` vuelve a desplegar. Probar en local con Workers: `npm install`, copia `.dev.vars.example` a `.dev.vars`
con tu clave y ejecuta `npm run cf:dev`.

Notas del despliegue:
- **Plan:** el hash de contraseñas (PBKDF2, 100 000 iteraciones) y las llamadas lentas a modelos grandes pueden superar el límite
  de CPU del plan gratuito de Workers (10 ms). Si registro o login fallan con «Exceeded CPU», usa el plan Workers de pago.
- **Una sola instancia:** todas las peticiones pasan por un único Durable Object (pensado para uso personal o de equipo pequeño).
- Los datos viven en el Durable Object; para borrarlos hay que eliminar el Worker o cambiar la clase en una migración de Wrangler.

## IA: principal + respaldo

`AI_MODELS` define el orden de prioridad (por defecto Nemotron 3 Super → Nemotron 3 Ultra → Nemotron 3.5 Super VL).
Se salta al siguiente modelo con: 429 (límite), 402 (créditos), 404 (modelo inexistente), 408, 5xx, timeout, HTTP 200 con
error incrustado o respuesta vacía. **No** se salta con 401/403 (clave mala) ni otros 4xx (petición incorrecta).
Un modelo que falla queda en pausa (respeta `Retry-After`) para no malgastar peticiones. El modelo que respondió se guarda
en cada ejecución y el panel del supervisor muestra el reparto.

> Los identificadores por defecto se verificaron contra el catálogo de NVIDIA; si cambian, confírmalos con `npm run models` (requiere `NVIDIA_API_KEY`).
> El endpoint de NVIDIA registra el uso; no envíes datos confidenciales ni personales.

## API (JSON, sesión por cookie `af_session`)

Entradas en camelCase, filas devueltas tal cual de la base de datos (snake_case), como en el original.

| Área | Endpoints |
|---|---|
| Auth | `POST /api/auth/register · login · logout` · `GET /api/auth/me` · `PATCH /api/auth/profile` |
| Agentes | `GET/POST /api/agents` · `GET/DELETE /api/agents/:id` · `POST …/:id/versions` · `POST …/:id/status` · `POST /api/agents/generate` |
| Ejecuciones | `GET/POST /api/executions` · `GET …/:id` · `POST …/:id/cancel · retry` |
| Aprobaciones | `GET /api/approvals?status=pending` · `POST /api/approvals/:id/decision {approve}` |
| Flujos | `GET/POST /api/workflows` · `GET/PUT/DELETE …/:id` · `GET/POST …/:id/runs` · `GET /api/workflow-runs/:id` · `POST …/continue · cancel` |
| Sistema | `GET /api/health · /api/system/status · /api/supervisor · /api/audit` |
| Chat web (panel) | `GET/POST /api/public-chats` · `PUT/DELETE /api/public-chats/:id` |
| Chat web (público, sin sesión, con CORS) | `GET /api/public/chats/:id` · `POST /api/public/chats/:id/messages {messages, conversationId?}` |

## Chat para tu web (agentes en webs de clientes)

Un agente activo se puede publicar como chat en la web de un negocio. Los visitantes hablan con él sin iniciar sesión,
y cada mensaje queda en **Ejecuciones** (con la conversación agrupada por `conversation_id`).

1. En la app, pestaña **Chat web**: elige el agente, escribe el saludo, las preguntas sugeridas, el aviso de privacidad
   y las **webs autorizadas** (`https://dominio.es`; con y sin `www` cuentan como distintas).
2. Copia la línea que te da y pégala antes de `</body>` en la web:
   ```html
   <script src="https://TU-WORKER.workers.dev/widget.js" data-chat="ID" defer></script>
   ```
   Opcionales: `data-accent`, `data-accent-text`, `data-theme="auto|light|dark"`, `data-position="left"`, `data-label`, `data-font`.
   El widget vive en un Shadow DOM (no choca con los estilos de la web), sigue el `data-theme` de la página,
   recuerda la conversación mientras la pestaña está abierta y es accesible con teclado y lector de pantalla.

**Protección de la cuota de IA**, por capas: solo responde a las webs autorizadas (CORS por `Origin`), límite por
visitante (15 mensajes / 10 min por defecto; se guarda un hash de la IP, nunca la IP), **tope diario por chat**
(500 por defecto; es la defensa real, porque un script fuera del navegador puede falsificar el `Origin`) y el límite
global de 5 ejecuciones activas. Solo se envían al modelo los últimos 20 turnos, de 1000 caracteres como máximo cada uno.
Un agente con «Requiere aprobación» no se puede publicar.

`agents/refu.json` es **Refu**, el asistente de El Refugio de Chilla: en la pestaña Agentes pulsa **Importar .json**,
guárdalo, actívalo y publícalo desde Chat web.

### Estructura del repo: el Agent Builder y las webs que lo embeben

El repo separa dos cosas que no se despliegan juntas:

- **`public/` + `src/`** — el Agent Builder: el panel (crear agentes, ejecutarlos, publicarlos como chat) y su
  backend. Esto es lo que corre en tu Worker (o en Node).
- **`sites/`** — webs de ejemplo de negocios que **usan** un agente ya publicado, con el `<script>` de `widget.js`
  embebido de verdad. `sites/refugio-de-chilla/` es la web de Refu: sirve para probar el embebido de principio a
  fin y como plantilla para la web de cualquier otro cliente. Estas webs no dependen del código del Agent Builder;
  solo necesitan el `data-chat` de un chat publicado (ver arriba) y pueden alojarse en cualquier sitio.

## Qué cambia respecto al original (Lovable + Supabase)

| Original | Aquí |
|---|---|
| Lovable AI Gateway (créditos de pago) | NVIDIA (`integrate.api.nvidia.com`), modelos Nemotron, con respaldo |
| Supabase Postgres + RLS | SQLite; **cada consulta filtra por `owner_id`** (hay tests de aislamiento) |
| Supabase Auth | Usuarios propios: scrypt, sesiones con hash en BD, cookie HttpOnly/SameSite, límite de intentos |
| zod | Validador propio sin dependencias |

Se conserva: versiones inmutables (con *trigger*), máquina de estados, límite de 5 ejecuciones activas, flujos de hasta
10 pasos, aprobaciones, auditoría, y que las herramientas sugeridas por la IA nunca se conceden solas.

Mejoras añadidas: recuperación tras reinicio, bloqueo contra avance concurrente de un flujo, cancelar un flujo cancela
sus ejecuciones vivas, control de CSRF por origen, y límite de tamaño de cuerpo.

## Limitaciones conocidas

- `node:sqlite` (solo al ejecutar en Node) sigue marcado como experimental en Node 22.
- Las ejecuciones se resuelven dentro de la petición HTTP (igual que el original). Sin cola en segundo plano.
- Los límites de la capa gratuita de NVIDIA varían por cuenta: consúltalos en build.nvidia.com.
- Si expones el servidor fuera de localhost, ponlo detrás de HTTPS y activa `COOKIE_SECURE=true`.
  El limitador de login usa la IP del socket; tras un proxy inverso verá la IP del proxy.
- Herramientas `web_search`, `http_request`, `email_send` y `way_app` siguen *no disponibles* (igual que el original).

## Hoja de ruta

1. **Fase 2 — interfaz web**: hechos agentes, ejecución y chat web; faltan flujos, supervisor y ajustes.
2. **Fase 3 — herramientas reales**: búsqueda (SearXNG autoalojado) y HTTP con lista blanca de dominios.
3. Docker Compose y copia de seguridad de la base de datos.

## Exportar cada agente como proyecto independiente

En el panel, activa el agente y abre **Entregar este agente como ZIP independiente**. Escribe el origen HTTPS exacto de la web del cliente y pulsa **Descargar ZIP independiente**. El navegador crea un ZIP con `src/worker.mjs`, `src/agent.json`, `public/widget.js`, `wrangler.toml`, `package.json`, `README.md` y `EMBEBER_EN_WEB.txt`.

Cada ZIP contiene su **propio Worker** y **Durable Object SQLite** con controles de cuota, sin dependencia del servidor central. El cliente necesita configurar una clave de NVIDIA propia con `wrangler secret put NVIDIA_API_KEY`; nunca se copian las claves del constructor. El backend independiente solo implementa chat de texto, sin herramientas externas, flujos ni aprobación humana. Para cambiar sus instrucciones, se modifica `src/agent.json` y se despliega nuevamente. Exportar no elimina ni migra el agente del constructor original.

## Desplegar un agente en Cloudflare desde el panel (sin instalar el ZIP)

**Disponible para el administrador de esta instancia.** Este flujo crea **un Worker por pareja agente + origen HTTPS**, junto con un **Durable Object SQLite exclusivo**, sin que el Worker resultante dependa de Agent Builder. No crea un repositorio GitHub nuevo; para distribuir el código fuente utiliza «Descargar ZIP independiente».

### Configurar la conexión una única vez

1. En Cloudflare, abre **Mi perfil > API Tokens > Create Token**. Crea un token de **cuenta** con permisos de **Workers Scripts: Edit** y **Workers Scripts: Read**, limitado a **esta cuenta**. Valora también una política de caducidad y restricción por IP si procede. No utilices la clave global.
2. Abre el Worker **agent-factory-free > Settings > Variables and Secrets**. Añade un **secreto** llamado `CF_DEPLOY_API_TOKEN` y pega allí el token. Nunca lo introduzcas en el código, el ZIP, GitHub ni el navegador de Agent Builder.
3. En `wrangler.toml`, la variable no secreta `CF_DEPLOY_ACCOUNT_ID` debe corresponder a la cuenta donde crearás los Workers. El proyecto incluye el identificador de la cuenta que actualmente aloja Agent Builder. Si cambias de cuenta, actualízalo con cuidado.
4. Confirma que `agent-factory-free` continúa funcionando. Guardar un secreto de Worker puede provocar un nuevo despliegue.

### Crear el Worker de un cliente

1. Abre **Agentes** y selecciona un agente **activo** que use solamente **Generación de texto**.
2. En **Entregar este agente como ZIP independiente**, introduce el origen HTTPS exacto de la web del cliente, por ejemplo `https://www.tunegocio.es` sin rutas. Los orígenes con y sin `www` son diferentes.
3. Pulsa **Desplegar en Cloudflare** y confirma la operación. El Worker realiza una llamada autenticada a la API, crea el Worker independiente y activa su URL `workers.dev`.
4. El panel muestra el nombre, la URL y el código `<script>` que debes instalar en la web del cliente.
5. En **Cloudflare > Workers > [nombre del nuevo agente] > Settings > Variables and Secrets**, añade el secreto **`NVIDIA_API_KEY`** de ese cliente. Sin él, el chat no atenderá mensajes. El Worker utiliza el modelo indicado en su binding `NVIDIA_MODEL`.
6. Comprueba `https://NUEVO-WORKER.TU-SUBDOMINIO.workers.dev/api/health`, pega el código en la web autorizada y prueba una conversación real.

**Seguridad:** el token del administrador nunca sale del servidor; el backend exige sesión y un origen HTTP coincidente. El nombre del Worker se genera a partir del identificador del agente y del dominio y no se acepta código arbitrario desde la web. Si el Worker ya existe, **no lo sobrescribe**; para actualizarlo se usa su ZIP y el despliegue manual. No elimina ni cambia la base de datos o el chat de Refu. Cada cliente obtiene contadores y almacenamiento independientes, pero los Workers se administran bajo la misma cuenta Cloudflare hasta que decidas migrarlos.

**Limitaciones actuales:** despliegue directo solo de chat de texto, sin herramientas externas, sin panel administrativo separado y sin configuración automática de dominio propio. No permite enviar correos ni reservar mesas. Las pruebas automáticas simulan la API de Cloudflare; **se requiere una prueba real con el token configurado** antes de dar el mecanismo por validado en producción.
