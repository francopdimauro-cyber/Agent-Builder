import { asObject, Checker, isRecord } from "./validate.ts";

/** Catálogo de herramientas. Solo las marcadas "available" pueden ejecutarse. */
export type ToolAvailability = "available" | "unavailable";

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  availability: ToolAvailability;
  requiredPermission: string;
  unavailableReason?: string;
}

export const TOOL_CATALOG: readonly ToolDefinition[] = [
  {
    id: "text_generation",
    name: "Generación de texto",
    description: "Razonamiento y redacción mediante el proveedor de IA configurado.",
    availability: "available",
    requiredPermission: "ai.generate",
  },
  {
    id: "site_knowledge",
    name: "Información verificada del negocio",
    description: "Busca respuestas en la base de conocimientos del agente, configurada y revisada por el propietario.",
    availability: "available",
    requiredPermission: "knowledge.read",
  },
  {
    id: "lead_capture",
    name: "Recibir solicitudes de contacto",
    description: "Muestra un formulario de contacto con consentimiento y guarda las solicitudes en la base de datos del propietario.",
    availability: "available",
    requiredPermission: "leads.create",
  },
  {
    id: "web_search",
    name: "Búsqueda web",
    description: "Consultar información pública en internet.",
    availability: "unavailable",
    requiredPermission: "net.search",
    unavailableReason: "No hay un conector de búsqueda configurado.",
  },
  {
    id: "http_request",
    name: "Peticiones HTTP",
    description: "Llamar a APIs externas.",
    availability: "unavailable",
    requiredPermission: "net.http",
    unavailableReason: "Requiere lista blanca de dominios y credenciales; no implementado.",
  },
  {
    id: "email_send",
    name: "Envío de correo",
    description: "Enviar correos en nombre del usuario.",
    availability: "unavailable",
    requiredPermission: "comms.email",
    unavailableReason: "No hay dominio de correo configurado.",
  },
  {
    id: "way_app",
    name: "WAY.APP",
    description: "Integración futura con la plataforma WAY.APP.",
    availability: "unavailable",
    requiredPermission: "way.app",
    unavailableReason: "Integración planificada; sin credenciales ni endpoints definidos.",
  },
];

export const TOOL_IDS: string[] = TOOL_CATALOG.map((t) => t.id);

export function getTool(id: string): ToolDefinition | undefined {
  return TOOL_CATALOG.find((t) => t.id === id);
}

export type ReasoningMode = "default" | "off";

export interface AgentConfig {
  name: string;
  description: string;
  role: string;
  objective: string;
  instructions: string;
  capabilities: string[];
  tools: string[];
  limits: {
    maxOutputTokens: number;
    timeoutSeconds: number;
    /** "off" pide al proveedor desactivar el razonamiento (ahorra tokens/cuota en tareas simples). */
    reasoning: ReasoningMode;
  };
  requiresApproval: boolean;
}

/** Valida y normaliza una configuración de agente. Lanza ValidationError. */
export function parseAgentConfig(input: unknown): AgentConfig {
  const o = asObject(input);
  const c = new Checker();
  const limitsIn = isRecord(o["limits"]) ? o["limits"] : {};
  if (o["limits"] !== undefined && !isRecord(o["limits"])) c.issues.push("limits: debe ser un objeto");

  const tools = c.stringArray(o["tools"], "tools", { maxItems: 10, maxLen: 60 });
  for (const t of tools) if (!TOOL_IDS.includes(t)) c.issues.push(`tools: herramienta desconocida «${t}»`);

  const config: AgentConfig = {
    name: c.string(o["name"], "name", { min: 2, max: 80 }),
    description: c.string(o["description"], "description", { max: 500, default: "" }),
    role: c.string(o["role"], "role", { min: 2, max: 200 }),
    objective: c.string(o["objective"], "objective", { min: 5, max: 1000 }),
    instructions: c.string(o["instructions"], "instructions", { min: 10, max: 8000 }),
    capabilities: c.stringArray(o["capabilities"], "capabilities", { maxItems: 20, maxLen: 120 }),
    tools: [...new Set(tools)],
    limits: {
      maxOutputTokens: c.int(limitsIn["maxOutputTokens"], "limits.maxOutputTokens", { min: 100, max: 8000, default: 1500 }),
      timeoutSeconds: c.int(limitsIn["timeoutSeconds"], "limits.timeoutSeconds", { min: 5, max: 60, default: 45 }),
      reasoning: c.oneOf(limitsIn["reasoning"], "limits.reasoning", ["default", "off"] as const, "default"),
    },
    requiresApproval: c.bool(o["requiresApproval"], "requiresApproval", false),
  };
  c.done();
  return config;
}

/**
 * Las herramientas que propone la IA nunca se conceden: se filtran a las conocidas
 * y el usuario debe activarlas explícitamente. Esto devuelve solo sugerencias.
 */
export function sanitizeSuggestedTools(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((x): x is string => typeof x === "string" && TOOL_IDS.includes(x)))];
}

/** Herramientas que el servidor permitirá realmente ejecutar para una config. */
export function grantedExecutableTools(config: AgentConfig): string[] {
  return config.tools.filter((id) => getTool(id)?.availability === "available");
}

export function canExecute(config: AgentConfig): { ok: true } | { ok: false; reason: string } {
  if (!config.tools.includes("text_generation")) {
    return { ok: false, reason: "El agente no tiene permiso para la herramienta de generación de texto." };
  }
  return { ok: true };
}
