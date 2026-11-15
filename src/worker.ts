/**
 * Punto de entrada para Cloudflare Workers.
 *
 * Toda la app vive dentro de UN Durable Object con almacenamiento SQLite: así se conserva la base de datos
 * síncrona del diseño original (transacciones, trigger de versiones inmutables, estados atómicos) y las peticiones
 * se serializan solas. El Worker de fuera solo reenvía las llamadas `/api/*`; los archivos de `public/` los sirve
 * Cloudflare directamente (ver wrangler.toml).
 */
import { DurableObject } from "cloudflare:workers";
import { deployIndependentAgent, DeploymentError, type AgentDeploymentDetail } from "./deploy/cloudflare.ts";
import { providerFromConfig } from "./ai/provider.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/index.ts";
import { durableDb } from "./db/durable.ts";
import { recoverInterrupted } from "./engine/engine.ts";
import { createHandler } from "./http/app.ts";

interface Env {
  AGENT_FACTORY: DurableObjectNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
  CF_DEPLOY_ACCOUNT_ID?: string;
  CF_DEPLOY_API_TOKEN?: string;
  [binding: string]: unknown;
}

/** Variables y secretos de texto (NVIDIA_API_KEY, AI_MODELS…); se ignoran los bindings que no son texto. */
function textVars(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

export class AgentFactory extends DurableObject<Env> {
  private handler: (request: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = durableDb(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      migrate(db);
      const recovered = recoverInterrupted(db);
      if (recovered) console.warn(`Se marcaron ${recovered} ejecuciones interrumpidas como fallidas.`);
    });
    const config = loadConfig(textVars(env));
    this.handler = createHandler({ db, ai: providerFromConfig(config), config });
  }

  fetch(request: Request): Promise<Response> {
    return this.handler(request);
  }
}

/** El despliegue se gestiona fuera del DO para no bloquear el motor de Refu durante llamadas externas. */
async function handleDeploy(request: Request, env: Env, stub: { fetch(request: Request): Promise<Response> }): Promise<Response> {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  const respond = (status: number, message: string): Response =>
    new Response(JSON.stringify({ error: message }), { status, headers });

  if (request.method !== "POST") return respond(405, "Método no permitido.");
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) return respond(403, "Origen no autorizado.");

  const cookie = request.headers.get("Cookie");
  if (!cookie) return respond(401, "Inicia sesión en Agent Builder.");
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.includes("application/json")) return respond(415, "Content-Type debe ser JSON.");
  const bodyText = await request.text();
  if (bodyText.length > 2048) return respond(413, "Solicitud demasiado grande.");

  let data: unknown;
  try { data = JSON.parse(bodyText); }
  catch { return respond(400, "El cuerpo no es JSON válido."); }
  if (!data || typeof data !== "object") return respond(400, "Solicitud inválida.");
  const o = data as Record<string, unknown>;
  if (typeof o.agentId !== "string" || !/^[0-9a-f-]{36}$/i.test(o.agentId) ||
      typeof o.siteOrigin !== "string" || o.siteOrigin.length > 220) {
    return respond(400, "Selecciona un agente y una dirección HTTPS válida.");
  }
  // Validar la sesión y la propiedad del agente con el backend existente.
  const agentRequest = new Request(new URL("/api/agents/" + o.agentId, request.url), {
    method: "GET", headers: { Cookie: cookie },
  });
  const details = await stub.fetch(agentRequest);
  if (!details.ok) return respond(details.status === 401 ? 401 : 404, "Sesión inválida o agente no encontrado.");
  const agent = await details.json() as AgentDeploymentDetail;
  if (!env.CF_DEPLOY_ACCOUNT_ID || !env.CF_DEPLOY_API_TOKEN) {
    return respond(503, "Configura CF_DEPLOY_API_TOKEN como secreto de Agent Builder en Cloudflare. El permiso debe limitarse a Workers Scripts de tu cuenta.");
  }
  try {
    const [runtime, widget] = await Promise.all([
      env.ASSETS.fetch(new Request(new URL("/export/template-worker.mjs", request.url))),
      env.ASSETS.fetch(new Request(new URL("/widget.js", request.url))),
    ]);
    if (!runtime.ok || !widget.ok) return respond(503, "No se pudieron cargar las plantillas del agente.");
    const result = await deployIndependentAgent({
      detail: agent,
      webOrigin: o.siteOrigin,
      workerSource: await runtime.text(),
      widgetSource: await widget.text(),
      accountId: env.CF_DEPLOY_ACCOUNT_ID,
      apiToken: env.CF_DEPLOY_API_TOKEN,
    });
    return new Response(JSON.stringify(result), { status: 201, headers });
  } catch (e: unknown) {
    if (e instanceof DeploymentError) return respond(e.status, e.message);
    console.error("Fallo imprevisto al desplegar agente");
    return respond(502, "Cloudflare no ha completado el despliegue. Comprueba el panel antes de reintentarlo.");
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.AGENT_FACTORY.get(env.AGENT_FACTORY.idFromName("main"));
    if (new URL(request.url).pathname === "/api/deploy/agent") return handleDeploy(request, env, stub);
    return stub.fetch(request);
  },
};
