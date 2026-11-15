import type { AppConfig } from "../config.ts";
import type { ReasoningMode } from "../domain/agent-config.ts";

export type AiErrorKind =
  | "not_configured"
  | "rate_limited"
  | "payment_required"
  | "timeout"
  | "invalid_response"
  | "provider_error";

export class AiProviderError extends Error {
  kind: AiErrorKind;
  constructor(kind: AiErrorKind, message: string) {
    super(message);
    this.name = "AiProviderError";
    this.kind = kind;
  }
}

/** Turno previo de una conversación (chat de varios mensajes). */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateArgs {
  instructions: string;
  input: string;
  /** Turnos anteriores, del más antiguo al más reciente. `input` es siempre el último mensaje del usuario. */
  history?: ChatTurn[];
  maxOutputTokens?: number;
  /** Tiempo máximo por intento. El total de la cadena de respaldo se limita a 2× este valor. */
  timeoutMs?: number;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  reasoning?: ReasoningMode;
}

export interface AttemptInfo {
  model: string;
  outcome: "ok" | "skipped_cooldown" | AiErrorKind;
  status?: number;
}

export interface GenerateResult {
  text: string;
  /** Modelo que realmente respondió. */
  model: string;
  attempts: AttemptInfo[];
}

/** Abstracción del proveedor: el resto de la app solo conoce esta interfaz. */
export interface AiProvider {
  isConfigured(): boolean;
  models(): string[];
  generateText(args: GenerateArgs): Promise<GenerateResult>;
}

interface Cooldown {
  until: number;
  kind: AiErrorKind;
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 45_000;
const MIN_COOLDOWN_MS = 5_000;
const MAX_COOLDOWN_MS = 60 * 60_000;
const DEFAULT_429_COOLDOWN_MS = 2 * 60_000;

type Classification =
  | { fatal: true; kind: AiErrorKind; message: string }
  | { fatal: false; kind: AiErrorKind; cooldownMs: number };

function classify(status: number, headers?: Headers): Classification {
  if (status === 401 || status === 403)
    return { fatal: true, kind: "not_configured", message: "La clave de NVIDIA no es válida o no tiene permisos." };
  if (status === 402) return { fatal: false, kind: "payment_required", cooldownMs: 10 * 60_000 };
  if (status === 404) return { fatal: false, kind: "provider_error", cooldownMs: 60 * 60_000 }; // modelo inexistente o sin acceso
  if (status === 408) return { fatal: false, kind: "timeout", cooldownMs: 30_000 };
  if (status === 429) return { fatal: false, kind: "rate_limited", cooldownMs: retryAfterMs(headers) };
  if (status >= 500) return { fatal: false, kind: "provider_error", cooldownMs: 30_000 };
  // Otros 4xx (400, 413, 422…): la petición en sí es incorrecta; otro modelo no lo arreglaría.
  return { fatal: true, kind: "provider_error", message: `El proveedor rechazó la petición (HTTP ${status}).` };
}

function retryAfterMs(headers?: Headers): number {
  const clamp = (ms: number) => Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, ms));
  const retryAfter = Number(headers?.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return clamp(retryAfter * 1000);
  return DEFAULT_429_COOLDOWN_MS;
}

function extractContent(message: unknown): string {
  const m = message as { content?: unknown } | undefined;
  if (typeof m?.content === "string") return m.content.trim();
  if (Array.isArray(m?.content)) {
    return (m.content as Array<{ type?: string; text?: unknown }>)
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
  }
  return "";
}

const KIND_PRIORITY: AiErrorKind[] = ["rate_limited", "payment_required", "timeout", "invalid_response", "provider_error"];

function summarizeFailure(kinds: AiErrorKind[]): AiProviderError {
  const kind = KIND_PRIORITY.find((k) => kinds.includes(k)) ?? "provider_error";
  const messages: Record<AiErrorKind, string> = {
    rate_limited: "Todos los modelos han alcanzado su límite de peticiones. Inténtalo de nuevo en unos minutos.",
    payment_required: "Los modelos configurados requieren créditos o acceso en NVIDIA.",
    timeout: "Los modelos tardaron demasiado en responder.",
    invalid_response: "Los modelos no devolvieron contenido utilizable.",
    provider_error: "Ningún modelo está disponible ahora mismo.",
    not_configured: "El proveedor de IA no está configurado.",
  };
  return new AiProviderError(kind, messages[kind]);
}

export interface NvidiaOptions {
  apiKey: string;
  baseUrl: string;
  models: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Cliente de NVIDIA (API compatible con OpenAI) con cadena de respaldo: prueba los modelos en orden y salta al siguiente
 * ante límites (429), créditos (402), modelo inexistente (404), timeouts, 5xx o respuestas vacías.
 * Un modelo que falla queda en pausa (cooldown) para no gastar peticiones inútiles.
 */
export function createNvidiaProvider(opts: NvidiaOptions): AiProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cooldowns = new Map<string, Cooldown>();

  async function generateText(args: GenerateArgs): Promise<GenerateResult> {
    if (!opts.apiKey) throw new AiProviderError("not_configured", "Falta NVIDIA_API_KEY.");
    const attemptTimeout = args.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    const deadline = now() + attemptTimeout * 2;
    const attempts: AttemptInfo[] = [];
    const failures: AiErrorKind[] = [];

    // Modelos disponibles; si todos están en pausa, se sondea el que antes se recupere.
    let candidates = opts.models.filter((m) => (cooldowns.get(m)?.until ?? 0) <= now());
    for (const m of opts.models) {
      if (!candidates.includes(m)) attempts.push({ model: m, outcome: "skipped_cooldown" });
    }
    if (candidates.length === 0 && opts.models.length > 0) {
      const soonest = [...opts.models].sort((a, b) => (cooldowns.get(a)?.until ?? 0) - (cooldowns.get(b)?.until ?? 0))[0]!;
      candidates = [soonest];
      attempts.length = 0;
      for (const m of opts.models) failures.push(cooldowns.get(m)?.kind ?? "provider_error");
    }

    for (const model of candidates) {
      const remaining = deadline - now();
      if (remaining < Math.min(500, attemptTimeout / 4)) {
        failures.push("timeout");
        break;
      }
      const result = await tryModel(model, args, Math.min(attemptTimeout, remaining));
      attempts.push({ model, outcome: result.ok ? "ok" : result.kind, ...(!result.ok && result.status ? { status: result.status } : {}) });
      if (result.ok) return { text: result.text, model, attempts };
      if (result.fatal) throw new AiProviderError(result.kind, result.message);
      failures.push(result.kind);
      cooldowns.set(model, { until: now() + result.cooldownMs, kind: result.kind });
    }
    throw summarizeFailure(failures);
  }

  type TryResult =
    | { ok: true; text: string }
    | { ok: false; fatal: true; kind: AiErrorKind; message: string; status?: number }
    | { ok: false; fatal: false; kind: AiErrorKind; cooldownMs: number; status?: number };

  async function tryModel(model: string, args: GenerateArgs, timeoutMs: number): Promise<TryResult> {
    const body: Record<string, unknown> = {
      model,
      stream: false,
      max_tokens: args.maxOutputTokens ?? 1500,
      messages: [
        { role: "system", content: args.instructions },
        ...(args.history ?? []).map((t) => ({ role: t.role, content: t.content })),
        { role: "user", content: args.input },
      ],
    };
    if (args.jsonSchema) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: args.jsonSchema.name, strict: true, schema: args.jsonSchema.schema },
      };
    }
    // Nemotron: se desactiva el razonamiento mediante la plantilla de chat (no existe el parámetro `reasoning` de OpenRouter).
    if (args.reasoning === "off") body["chat_template_kwargs"] = { enable_thinking: false };

    let res: Response;
    try {
      res = await fetchImpl(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      return { ok: false, fatal: false, kind: timedOut ? "timeout" : "provider_error", cooldownMs: 30_000 };
    }

    if (!res.ok) {
      const c = classify(res.status, res.headers);
      return c.fatal
        ? { ok: false, fatal: true, kind: c.kind, message: c.message, status: res.status }
        : { ok: false, fatal: false, kind: c.kind, cooldownMs: c.cooldownMs, status: res.status };
    }

    let data: {
      error?: { code?: unknown };
      choices?: Array<{ message?: { refusal?: unknown }; error?: { code?: unknown } }>;
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return { ok: false, fatal: false, kind: "invalid_response", cooldownMs: 30_000 };
    }

    // Por si el proveedor devuelve HTTP 200 con un error dentro del cuerpo.
    const embedded = data.error ?? data.choices?.[0]?.error;
    if (embedded) {
      const code = typeof embedded.code === "number" ? embedded.code : 502;
      const c = classify(code);
      return c.fatal
        ? { ok: false, fatal: true, kind: c.kind, message: c.message, status: code }
        : { ok: false, fatal: false, kind: c.kind, cooldownMs: c.cooldownMs, status: code };
    }

    const message = data.choices?.[0]?.message;
    if (typeof message?.refusal === "string" && message.refusal) {
      return { ok: false, fatal: true, kind: "invalid_response", message: "El modelo rechazó la solicitud." };
    }
    const text = extractContent(message);
    if (!text) return { ok: false, fatal: false, kind: "invalid_response", cooldownMs: 60_000 };
    return { ok: true, text };
  }

  return {
    isConfigured: () => Boolean(opts.apiKey),
    models: () => [...opts.models],
    generateText,
  };
}

export function providerFromConfig(config: AppConfig): AiProvider {
  return createNvidiaProvider({ apiKey: config.nvidiaApiKey, baseUrl: config.nvidiaBaseUrl, models: config.aiModels });
}

/** Comprueba (sin fallar) que los identificadores configurados existen en NVIDIA. El listado requiere clave. */
export async function findUnknownModels(
  baseUrl: string,
  apiKey: string,
  models: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ checked: boolean; unknown: string[] }> {
  if (!apiKey) return { checked: false, unknown: [] };
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { checked: false, unknown: [] };
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const known = new Set((data.data ?? []).map((m) => m.id));
    if (known.size === 0) return { checked: false, unknown: [] };
    return { checked: true, unknown: models.filter((m) => !known.has(m)) };
  } catch {
    return { checked: false, unknown: [] };
  }
}
