# Agent Factory Free

Réplica propia y gratuita de *Agent Factory*: diseña agentes de IA (rol, objetivo, instrucciones, herramientas),
ejecútalos, encadénalos en flujos y supervisa todo con aprobaciones humanas y auditoría.

**Sin dependencias de pago ni de runtime**: Node ≥ 22.18, SQLite integrado (`node:sqlite`) y la API de NVIDIA (modelos Nemotron).

> **Estado: Fase 1 — backend completo y probado.** La interfaz web es la Fase 2.

## Arranque

```sh
cp .env.example .env        # pega tu NVIDIA_API_KEY en .env (nunca la subas a git ni la pegues en chats)
npm run models              # comprueba que los identificadores de AI_MODELS existen
npm start                   # http://127.0.0.1:3000
npm test                    # 32 tests (usan un NVIDIA simulado: no gastan cuota)
```

`npm install` solo hace falta para `npm run typecheck` (TypeScript y tipos de Node).

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

- `node:sqlite` sigue marcado como experimental en Node 22 (funciona; la API podría cambiar).
- Las ejecuciones se resuelven dentro de la petición HTTP (igual que el original). Sin cola en segundo plano.
- Los límites de la capa gratuita de NVIDIA varían por cuenta: consúltalos en build.nvidia.com.
- Si expones el servidor fuera de localhost, ponlo detrás de HTTPS y activa `COOKIE_SECURE=true`.
  El limitador de login usa la IP del socket; tras un proxy inverso verá la IP del proxy.
- Herramientas `web_search`, `http_request`, `email_send` y `way_app` siguen *no disponibles* (igual que el original).

## Hoja de ruta

1. **Fase 2 — interfaz web** (panel, agentes, builder con IA, flujos, ejecución, supervisor, ajustes), servida desde `public/`.
2. **Fase 3 — herramientas reales**: búsqueda (SearXNG autoalojado) y HTTP con lista blanca de dominios.
3. Docker Compose y copia de seguridad de la base de datos.
