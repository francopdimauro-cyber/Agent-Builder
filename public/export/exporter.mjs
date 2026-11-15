/* ZIP STORE estándar. Sin librerías ni carga de datos a servicios de terceros. */
const encoder = new TextEncoder();
const u16 = (v, n, x) => v.setUint16(n, x, true);
const u32 = (v, n, x) => v.setUint32(n, x >>> 0, true);
function header(n, fn) { const b = new Uint8Array(n); fn(new DataView(b.buffer)); return b; }
function checksum(data) {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
export function makeZip(files) {
  const names = Object.keys(files);
  if (!names.length || names.length > 100) throw Error("Número de archivos inválido");
  const out = [], central = [];
  let offset = 0;
  for (const name of names) {
    if (!/^[A-Za-z0-9./_-]+$/.test(name) || name.startsWith("/") || name.split("/").includes("..")) {
      throw Error("Nombre de archivo inválido");
    }
    const n = encoder.encode(name);
    const data = typeof files[name] === "string" ? encoder.encode(files[name]) : files[name];
    if (!(data instanceof Uint8Array)) throw Error("Archivo inválido");
    const crc = checksum(data), size = data.length, localOffset = offset;
    const a = header(30, v => {
      u32(v, 0, 0x04034b50); u16(v, 4, 20); u16(v, 6, 0x0800);
      u16(v, 8, 0); u32(v, 14, crc); u32(v, 18, size);
      u32(v, 22, size); u16(v, 26, n.length);
    });
    out.push(a, n, data);
    offset += a.length + n.length + data.length;
    const b = header(46, v => {
      u32(v, 0, 0x02014b50); u16(v, 4, 20); u16(v, 6, 20);
      u16(v, 8, 0x0800); u32(v, 16, crc); u32(v, 20, size);
      u32(v, 24, size); u16(v, 28, n.length); u32(v, 42, localOffset);
    });
    central.push(b, n);
  }
  const directorySize = central.reduce((n, x) => n + x.length, 0);
  const footer = header(22, v => {
    u32(v, 0, 0x06054b50);
    u16(v, 8, names.length); u16(v, 10, names.length);
    u32(v, 12, directorySize); u32(v, 16, offset);
  });
  const all = [...out, ...central, footer];
  const total = all.reduce((n, x) => n + x.length, 0);
  if (total > 8_000_000) throw Error("ZIP demasiado grande");
  const zip = new Uint8Array(total);
  let p = 0; for (const part of all) { zip.set(part, p); p += part.length; }
  return zip;
}
export function normalizeSiteOrigin(value) {
  let u;
  try { u = new URL(String(value || "").trim()); }
  catch { throw Error("Introduce un dominio completo, por ejemplo https://tuweb.com"); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") {
    throw Error("El dominio debe ser HTTPS y no contener rutas, usuarios ni parámetros.");
  }
  return u.origin;
}
export function makeWorkerName(name, id) {
  const slug = String(name || "web").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 34) || "web";
  return "agent-" + slug + "-" + id.replace(/[^0-9a-f]/gi, "").slice(0, 8);
}
export function assembleStandalone({ agent, config, siteOrigin, workerSource, widgetSource, uniqueId }) {
  if (agent?.status !== "active") throw Error("Activa el agente antes de exportarlo.");
  if (!config || !config.name || !config.role || !config.objective || !config.instructions) {
    throw Error("La configuración del agente está incompleta.");
  }
  if (config.requiresApproval) throw Error("No se exportan agentes que requieren aprobación humana.");
  if (!Array.isArray(config.tools) || !config.tools.includes("text_generation") ||
      config.tools.some(x => x !== "text_generation")) {
    throw Error("La exportación independiente solo admite por ahora la herramienta Generación de texto.");
  }
  const origin = normalizeSiteOrigin(siteOrigin);
  if (typeof workerSource !== "string" || !workerSource.includes("export class SiteAgent") ||
      typeof widgetSource !== "string" || !widgetSource.includes("data-chat")) {
    throw Error("No se ha cargado el motor independiente o el widget.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(uniqueId)) throw Error("Identificador de exportación inválido");
  const chatId = uniqueId, workerName = makeWorkerName(config.name, uniqueId);
  const manifest = {
    name: config.name, description: config.description || "",
    role: config.role, objective: config.objective, instructions: config.instructions,
    capabilities: config.capabilities || [], limits: config.limits || {},
    chatId, allowedOrigins: [origin], title: config.name,
    greeting: "¡Hola! Soy " + config.name + ". ¿En qué puedo ayudarte?",
    suggestions: [], privacyNotice: "Hablas con una IA. No compartas información personal sensible.",
    perVisitorLimit: 15, dailyLimit: 500
  };
  const wrangler = [
    '# Agente autónomo: NO se conecta a Agent Builder.',
    'name = "' + workerName + '"',
    'main = "src/worker.mjs"',
    'compatibility_date = "2026-11-15"',
    '', '[assets]', 'directory = "./public"', 'run_worker_first = ["/api/*"]',
    '', '[[durable_objects.bindings]]', 'name = "SITE_AGENT"', 'class_name = "SiteAgent"',
    '', '[[migrations]]', 'tag = "v1"', 'new_sqlite_classes = ["SiteAgent"]',
    '', '[vars]', 'NVIDIA_MODEL = "nvidia/nemotron-3-super-120b-a12b"',
    '', '[observability]', 'enabled = true', ''
  ].join("\n");
  const packageJson = {
    name: workerName, version: "1.0.0", type: "module", private: true,
    scripts: { dev: "wrangler dev", deploy: "wrangler deploy", check: "wrangler deploy --dry-run" },
    devDependencies: { wrangler: "^4.0.0" }
  };
  const readme = [
    "# " + config.name + " — agente independiente",
    "",
    "Agente exportado de Agent Builder: dispone de Worker, base SQLite y credenciales propias.",
    "No realiza llamadas al backend central de Agent Builder.",
    "",
    "INSTALACIÓN (Node.js 22 o posterior):",
    "1. Extrae el ZIP en una carpeta nueva.",
    "2. Ejecuta: npm install",
    "3. Ejecuta: npx wrangler login",
    "4. Ejecuta: npm run deploy",
    "5. Ejecuta: npx wrangler secret put NVIDIA_API_KEY",
    "   Introduce la clave en tu terminal, nunca en un archivo del repositorio.",
    "6. Comprueba: https://" + workerName + ".TU-SUBDOMINIO.workers.dev/api/health",
    "",
    "INTEGRAR EN LA WEB:",
    "Abre EMBEBER_EN_WEB.html, sustituye TU-SUBDOMINIO por tu subdominio de Cloudflare",
    "y pega el script justo antes del cierre de body en la web " + origin,
    "El dominio debe figurar exactamente en allowedOrigins dentro de src/agent.json.",
    "www y sin www son dos orígenes diferentes; añade ambos si la web usa los dos.",
    "",
    "CAMBIAR INSTRUCCIONES O LIMITES:",
    "Edita src/agent.json y ejecuta npm run deploy. Mantén privados los prompts del cliente.",
    "No se exportan claves privadas ni datos de otros clientes.",
    "",
    "PRIVACIDAD Y SEGURIDAD:",
    "Se almacenan contadores y hashes de visitantes, no transcripciones de mensajes.",
    "El Origin se valida en el navegador, pero puede falsificarse fuera de él.",
    "Los límites reducen abusos, sin garantizar un coste cero del proveedor.",
    "Este agente no tiene herramientas para enviar correos ni confirmar reservas.",
    "",
    "LIMITACIONES:",
    "Este ZIP incluye un chat independiente, no un panel de edición web.",
    "No exporta workflows, herramientas externas ni aprobación humana.",
    "Cada cliente necesita su propia configuración de proveedor de IA.",
    ""
  ].join("\n");
  const label = config.name.replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;");
  const embed = [
    "<!-- Pega este script antes del cierre de body en " + origin + " -->",
    '<script src="https://' + workerName + '.TU-SUBDOMINIO.workers.dev/widget.js"',
    ' data-chat="' + chatId + '" data-label="' + label + '"',
    ' data-accent="#1f5c4a" data-theme="auto" defer></script>', ""
  ].join("\n");
  const files = {
    "src/worker.mjs": workerSource,
    "src/agent.json": JSON.stringify(manifest, null, 2) + "\n",
    "public/widget.js": widgetSource,
    "wrangler.toml": wrangler,
    "package.json": JSON.stringify(packageJson, null, 2) + "\n",
    ".gitignore": "node_modules/\n.wrangler/\n.dev.vars\n.env\n",
    "README.md": readme,
    "EMBEBER_EN_WEB.html": embed
  };
  return { workerName, chatId, origin, files, zip: makeZip(files) };
}
export async function downloadStandaloneZip({ agent, config, siteOrigin }) {
  const [runtime, widget] = await Promise.all([
    fetch("/export/template-worker.mjs", { cache: "no-store" }),
    fetch("/widget.js", { cache: "no-store" })
  ]);
  if (!runtime.ok || !widget.ok) throw Error("No se pudieron descargar las plantillas.");
  const result = assembleStandalone({
    agent, config, siteOrigin,
    workerSource: await runtime.text(), widgetSource: await widget.text(),
    uniqueId: crypto.randomUUID()
  });
  const url = URL.createObjectURL(new Blob([result.zip], { type: "application/zip" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = result.workerName + ".zip";
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return result;
}
