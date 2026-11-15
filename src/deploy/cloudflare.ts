/**
 * Despliegue de agentes aislados en la MISMA cuenta Cloudflare, con autorización
 * de cuenta almacenada exclusivamente en un secreto del Worker central.
 *
 * La API no acepta nombres de Worker, código ni rutas arbitrarios del usuario.
 */
export interface DeployAgentConfig {
  name: string;
  description?: string;
  role: string;
  objective: string;
  instructions: string;
  capabilities?: string[];
  limits?: { maxOutputTokens?: number; timeoutSeconds?: number; reasoning?: string };
  tools: string[];
  requiresApproval?: boolean;
}
export interface AgentDeploymentDetail {
  agent: { id: string; name: string; status: string; current_version: number };
  versions: Array<{ version: number; config: DeployAgentConfig }>;
}
export interface DeploymentResult {
  workerName: string;
  workerUrl: string;
  chatId: string;
  siteOrigin: string;
  needsAiKey: true;
}

const API = "https://api.cloudflare.com/client/v4";
const COMPAT_DATE = "2026-11-15";

export class DeploymentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DeploymentError";
    this.status = status;
  }
}
export function siteOrigin(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); }
  catch { throw new DeploymentError(400, "Introduce la URL completa de la web: https://tudominio.es"); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") {
    throw new DeploymentError(400, "El dominio tiene que ser HTTPS y no incluir rutas ni parámetros.");
  }
  return u.origin;
}
function slug(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 27) || "agente";
}
function checkAgent(detail: AgentDeploymentDetail): DeployAgentConfig {
  const { agent } = detail;
  if (agent.status !== "active") throw new DeploymentError(409, "Activa el agente antes de desplegarlo.");
  const v = detail.versions.find(x => x.version === agent.current_version);
  if (!v) throw new DeploymentError(409, "No se encuentra la configuración actual.");
  const cfg = v.config;
  if (!cfg.name || !cfg.role || !cfg.objective || !cfg.instructions) {
    throw new DeploymentError(400, "La configuración del agente está incompleta.");
  }
  if (cfg.requiresApproval) throw new DeploymentError(409, "Los agentes con aprobación humana no pueden desplegarse así.");
  if (!Array.isArray(cfg.tools) || cfg.tools.length !== 1 || cfg.tools[0] !== "text_generation") {
    throw new DeploymentError(409, "Solo se admiten agentes con Generación de texto (sin herramientas adicionales).");
  }
  return cfg;
}
function assertTemplate(runtime: string, widget: string) {
  if (!runtime.includes('import agent from "./agent.json";') ||
      !runtime.includes('if (!path.startsWith("/api/")) {') ||
      !runtime.includes("export class SiteAgent") ||
      !widget.includes("data-chat")) {
    throw new DeploymentError(500, "El motor autónomo o su widget no tienen el formato esperado.");
  }
}
async function digestHex(s: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function failCode(result: unknown): string {
  if (!result || typeof result !== "object") return "sin detalles";
  const e = (result as { errors?: Array<{code?:number}> }).errors;
  return Array.isArray(e) && e.length ? e.map(x => String(x.code ?? "error")).slice(0,3).join(",") : "sin detalles";
}
async function cloudflareRequest(
  f: typeof fetch, token: string, path: string,
  options: { method?: string; body?: string | FormData; contentType?: string } = {},
): Promise<{ status: number; success: boolean; data: Record<string, unknown> }> {
  const res = await f(API + path, {
    method: options.method ?? "GET",
    headers: {
      Authorization: "Bearer " + token,
      ...(options.contentType ? { "Content-Type": options.contentType } : {}),
    },
    ...(options.body !== undefined ? { body: options.body } : {}),
    redirect: "error",
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, success: res.ok && data.success === true, data };
}
export interface DeployParams {
  detail: AgentDeploymentDetail;
  webOrigin: string;
  workerSource: string;
  widgetSource: string;
  accountId: string;
  apiToken: string;
  cfFetch?: typeof fetch;
}
/** No crea ni modifica nada hasta haber validado agente, web y origen. */
export async function deployIndependentAgent(p: DeployParams): Promise<DeploymentResult> {
  if (!/^[a-f0-9]{32}$/i.test(p.accountId)) throw new DeploymentError(503, "Falta configurar la cuenta de Cloudflare.");
  if (!p.apiToken) throw new DeploymentError(503, "Falta configurar el secreto CF_DEPLOY_API_TOKEN en Agent Builder.");
  const cfg = checkAgent(p.detail);
  const origin = siteOrigin(p.webOrigin);
  assertTemplate(p.workerSource, p.widgetSource);

  // Nombre determinista y exclusivo por pareja (agente, dominio).
  // Si ya existe, NO se sobrescribe ningún Worker: evita daños accidentales.
  const fingerprint = await digestHex(p.detail.agent.id + "\n" + origin);
  const workerName = "agente-" + slug(cfg.name) + "-" + fingerprint.slice(0, 12);
  const chatId = p.detail.agent.id; // UUID del agente, estable en este Worker
  const manifest = {
    name: cfg.name, description: cfg.description || "", role: cfg.role,
    objective: cfg.objective, instructions: cfg.instructions,
    capabilities: cfg.capabilities || [], limits: cfg.limits || {},
    chatId, allowedOrigins: [origin], title: cfg.name,
    greeting: "¡Hola! Soy " + cfg.name + ". ¿En qué puedo ayudarte?",
    suggestions: [], privacyNotice: "Hablas con una IA. No compartas datos sensibles.",
    perVisitorLimit: 15, dailyLimit: 500,
  };
  const source = p.workerSource
    .replace('import agent from "./agent.json";', "const agent = " + JSON.stringify(manifest) + ";")
    .replace('if (!path.startsWith("/api/")) {',
      'if (path === "/widget.js" && (request.method === "GET" || request.method === "HEAD")) {' +
      'return new Response(request.method === "HEAD" ? null : ' + JSON.stringify(p.widgetSource) +
      ', {headers:{"Content-Type":"application/javascript; charset=utf-8","X-Content-Type-Options":"nosniff","Cache-Control":"public, max-age=3600"}});}' +
      '\n    if (!path.startsWith("/api/")) {');
  if (source.includes('import agent from "./agent.json";')) {
    throw new DeploymentError(500, "No se ha podido incorporar la configuración del agente.");
  }

  const f = p.cfFetch ?? fetch;
  const path = "/accounts/" + p.accountId + "/workers/scripts/" + workerName;
  const exists = await cloudflareRequest(f, p.apiToken, path);
  if (exists.success || exists.status === 200) {
    throw new DeploymentError(409, "Ya existe un Worker para este agente y este dominio. No se sobrescribirá automáticamente.");
  }
  if (exists.status !== 404) {
    throw new DeploymentError(502, "Cloudflare no permitió comprobar el nombre del Worker (HTTP " + exists.status + ", código " + failCode(exists.data) + ").");
  }

  const meta = {
    main_module: "worker.mjs",
    compatibility_date: COMPAT_DATE,
    bindings: [
      { type: "durable_object_namespace", name: "SITE_AGENT", class_name: "SiteAgent" },
      { type: "plain_text", name: "NVIDIA_MODEL", text: "nvidia/nemotron-3-super-120b-a12b" },
    ],
    migrations: { new_tag: "v1", new_sqlite_classes: ["SiteAgent"] },
    observability: { enabled: true },
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
  form.append("worker.mjs", new Blob([source], { type: "application/javascript+module" }), "worker.mjs");
  const uploaded = await cloudflareRequest(f, p.apiToken, path, {method: "PUT", body: form});
  if (!uploaded.success) {
    throw new DeploymentError(502, "Cloudflare rechazó la creación del Worker (HTTP " + uploaded.status + ", código " + failCode(uploaded.data) + ").");
  }
  const route = await cloudflareRequest(f, p.apiToken, path + "/subdomain", {
    method: "POST", contentType: "application/json", body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
  if (!route.success) {
    throw new DeploymentError(502, "Worker creado: " + workerName + ". No se pudo activar workers.dev; compruébalo en Cloudflare (HTTP " + route.status + ").");
  }
  const subdomain = await cloudflareRequest(f, p.apiToken, "/accounts/" + p.accountId + "/workers/subdomain");
  const subResult = subdomain.data.result as { subdomain?: unknown } | undefined;
  if (!subdomain.success || typeof subResult?.subdomain !== "string") {
    throw new DeploymentError(502, "Worker creado: " + workerName + ". No se ha podido obtener el subdominio de Cloudflare.");
  }
  return {
    workerName,
    workerUrl: "https://" + workerName + "." + subResult.subdomain + ".workers.dev",
    chatId, siteOrigin: origin, needsAiKey: true,
  };
}
