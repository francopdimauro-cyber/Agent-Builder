import { AiProviderError } from "../ai/provider.ts";
import { COOKIE_NAME, getUserBySession, parseCookies } from "../auth/session.ts";
import type { Ctx } from "../context.ts";
import { ValidationError } from "../domain/validate.ts";
import { AppError } from "../errors.ts";
import { registerAuthRoutes } from "../routes/auth.ts";
import { registerAgentRoutes } from "../routes/agents.ts";
import { registerExecutionRoutes } from "../routes/executions.ts";
import { registerSystemRoutes } from "../routes/system.ts";
import { registerWorkflowRoutes } from "../routes/workflows.ts";
import { json, Router, type Req, type Res } from "./router.ts";

export const MAX_BODY_BYTES = 256 * 1024;

export interface RequestInfo {
  /** IP del cliente. En Workers se toma de `cf-connecting-ip` si no se indica. */
  ip?: string;
}

export function toResponse(out: Res): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const [k, v] of Object.entries(out.headers ?? {})) {
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, v);
  }
  const noBody = out.body === undefined || out.status === 204;
  return new Response(noBody ? null : JSON.stringify(out.body), { status: out.status, headers });
}

/**
 * Manejador HTTP independiente de la plataforma: recibe un `Request` estándar y devuelve un `Response`.
 * Lo usan tanto el servidor de Node (http/server.ts) como el Durable Object de Cloudflare (worker.ts).
 */
export function createHandler(ctx: Ctx): (request: Request, info?: RequestInfo) => Promise<Response> {
  const router = new Router();
  registerAuthRoutes(router, ctx);
  registerSystemRoutes(router, ctx);
  registerAgentRoutes(router, ctx);
  registerExecutionRoutes(router, ctx);
  registerWorkflowRoutes(router, ctx);

  async function handle(request: Request, info: RequestInfo): Promise<Res> {
    const method = request.method.toUpperCase();
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) return json({ error: "No encontrado." }, 404);

    // Defensa en profundidad contra CSRF (además de SameSite=Lax): el origen debe ser el propio o estar permitido.
    if (method !== "GET" && method !== "HEAD") {
      const origin = request.headers.get("origin");
      if (origin) {
        let sameHost = false;
        try {
          sameHost = new URL(origin).host === url.host;
        } catch {
          /* origen mal formado: se rechaza */
        }
        if (!sameHost && !ctx.config.allowedOrigins.includes(origin)) return json({ error: "Origen no permitido." }, 403);
      }
    }

    const found = router.match(method, url.pathname);
    if (found === null) return json({ error: "No encontrado." }, 404);
    if (found === "method_not_allowed") return json({ error: "Método no permitido." }, 405);

    let body: unknown = undefined;
    if (method !== "GET" && method !== "HEAD") {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new AppError(413, "El cuerpo de la petición es demasiado grande.");
      const raw = new Uint8Array(await request.arrayBuffer());
      if (raw.length > MAX_BODY_BYTES) throw new AppError(413, "El cuerpo de la petición es demasiado grande.");
      if (raw.length > 0) {
        if (!(request.headers.get("content-type") ?? "").includes("application/json")) throw new AppError(415, "Content-Type debe ser application/json.");
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          throw new AppError(400, "JSON no válido.");
        }
      }
    }

    const headers: Record<string, string | undefined> = Object.fromEntries(request.headers);
    const token = parseCookies(headers["cookie"])[COOKIE_NAME];
    const user = token ? ((await getUserBySession(ctx.db, token)) ?? null) : null;
    const ip = info.ip ?? headers["cf-connecting-ip"] ?? "unknown";
    const req: Req = { method, url, params: found.params, body, user, ip, headers };

    if (found.route.auth && !user) return json({ error: "Necesitas iniciar sesión." }, 401);
    return await (found.route.handler as (r: Req) => Promise<Res> | Res)(req);
  }

  return async (request, info = {}) => {
    try {
      return toResponse(await handle(request, info));
    } catch (e: unknown) {
      if (e instanceof ValidationError) return toResponse(json({ error: "Datos no válidos.", issues: e.issues }, 400));
      if (e instanceof AppError) return toResponse(json({ error: e.message }, e.status));
      if (e instanceof AiProviderError) {
        const status = e.kind === "rate_limited" ? 429 : e.kind === "not_configured" ? 503 : 502;
        return toResponse(json({ error: e.message, kind: e.kind }, status));
      }
      console.error("Error no controlado:", e);
      return toResponse(json({ error: "Error interno del servidor." }, 500));
    }
  };
}
