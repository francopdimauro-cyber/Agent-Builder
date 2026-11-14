import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Ctx } from "../context.ts";
import { createHandler, MAX_BODY_BYTES, toResponse } from "./app.ts";
import { json } from "./router.ts";

/** Adaptador de Node: traduce http.IncomingMessage ⇄ Request/Response y sirve los archivos estáticos de `public/`. */

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

async function readBody(req: IncomingMessage): Promise<Buffer | "too_large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return "too_large";
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Array<[string, string]> = [];
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers.push([key, value]);
  });
  for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
  res.writeHead(response.status, headers.flat() as string[]);
  res.end(Buffer.from(await response.arrayBuffer()));
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
  const handler = createHandler(ctx);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (!url.pathname.startsWith("/api/") && (method === "GET" || method === "HEAD") && opts.publicDir && serveStatic(opts.publicDir, url.pathname, res)) return;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const raw = await readBody(req);
      if (raw === "too_large") return send(res, toResponse(json({ error: "El cuerpo de la petición es demasiado grande." }, 413)));
      if (raw.length > 0) body = raw;
    }
    const request = new Request(url, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) });
    await send(res, await handler(request, { ip: req.socket.remoteAddress ?? "unknown" }));
  }

  return createHttpServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error("Error en el adaptador HTTP:", e);
      if (res.headersSent) return res.end();
      void send(res, toResponse(json({ error: "Error interno del servidor." }, 500)));
    });
  });
}
