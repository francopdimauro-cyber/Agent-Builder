import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
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

const MAX_BODY_BYTES = 256 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new AppError(413, "El cuerpo de la petición es demasiado grande.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, out: Res): void {
  const payload = out.body === undefined ? "" : JSON.stringify(out.body);
  res.writeHead(out.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...out.headers,
  });
  res.end(payload);
}

function serveStatic(root: string, pathname: string, res: ServerResponse): boolean {
  if (!existsSync(root)) return false;
  const rootAbs = resolve(root);
  let file = resolve(join(rootAbs, normalize(decodeURIComponent(pathname))));
  if (file !== rootAbs && !file.startsWith(rootAbs + sep)) return false; // evita path traversal
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(pathname)) return false;
    file = join(rootAbs, "index.html"); // fallback SPA
    if (!existsSync(file)) return false;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(readFileSync(file));
  return true;
}

export function createApp(ctx: Ctx, opts: { publicDir?: string } = {}): Server {
  const router = new Router();
  registerAuthRoutes(router, ctx);
  registerSystemRoutes(router, ctx);
  registerAgentRoutes(router, ctx);
  registerExecutionRoutes(router, ctx);
  registerWorkflowRoutes(router, ctx);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (!url.pathname.startsWith("/api/")) {
      if (method === "GET" || method === "HEAD") {
        if (opts.publicDir && serveStatic(opts.publicDir, url.pathname, res)) return;
      }
      return send(res, json({ error: "No encontrado." }, 404));
    }

    // Defensa en profundidad contra CSRF (además de SameSite=Lax): el origen debe ser el propio o estar permitido.
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.origin;
      if (origin) {
        let sameHost = false;
        try {
          sameHost = new URL(origin).host === req.headers.host;
        } catch {
          /* origen mal formado: se rechaza */
        }
        if (!sameHost && !ctx.config.allowedOrigins.includes(origin)) return send(res, json({ error: "Origen no permitido." }, 403));
      }
    }

    const found = router.match(method, url.pathname);
    if (found === null) return send(res, json({ error: "No encontrado." }, 404));
    if (found === "method_not_allowed") return send(res, json({ error: "Método no permitido." }, 405));

    let body: unknown = undefined;
    if (method !== "GET" && method !== "HEAD") {
      const raw = await readBody(req);
      if (raw.length > 0) {
        if (!(req.headers["content-type"] ?? "").includes("application/json")) throw new AppError(415, "Content-Type debe ser application/json.");
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new AppError(400, "JSON no válido.");
        }
      }
    }

    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const user = token ? (getUserBySession(ctx.db, token) ?? null) : null;
    const request: Req = { method, url, params: found.params, body, user, ip: req.socket.remoteAddress ?? "unknown", headers: req.headers };

    if (found.route.auth && !user) return send(res, json({ error: "Necesitas iniciar sesión." }, 401));
    const out = await (found.route.handler as (r: Req) => Promise<Res> | Res)(request);
    send(res, out);
  }

  return createHttpServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.end();
      if (e instanceof ValidationError) return send(res, json({ error: "Datos no válidos.", issues: e.issues }, 400));
      if (e instanceof AppError) return send(res, json({ error: e.message }, e.status));
      if (e instanceof AiProviderError) {
        const status = e.kind === "rate_limited" ? 429 : e.kind === "not_configured" ? 503 : 502;
        return send(res, json({ error: e.message, kind: e.kind }, status));
      }
      console.error("Error no controlado:", e);
      send(res, json({ error: "Error interno del servidor." }, 500));
    });
  });
}
