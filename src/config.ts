export interface AppConfig {
  port: number;
  host: string;
  databasePath: string;
  nvidiaApiKey: string;
  nvidiaBaseUrl: string;
  aiModels: string[];
  sessionTtlDays: number;
  allowRegistration: boolean;
  cookieSecure: boolean;
  allowedOrigins: string[];
}

export const DEFAULT_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b", // principal (verificar con `npm run models`)
  "nvidia/nemotron-3-ultra-550b-a55b", // respaldo 1 (verificar con `npm run models`)
  "nvidia/nemotron-3.5-super-vl-120b-a12b", // respaldo 2 (verificar con `npm run models`)
];

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === "") return def;
  return ["1", "true", "yes", "si", "sí"].includes(v.trim().toLowerCase());
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function int(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const models = list(env["AI_MODELS"]);
  return {
    port: int(env["PORT"], 3000, 0, 65535),
    host: env["HOST"]?.trim() || "127.0.0.1",
    databasePath: env["DATABASE_PATH"]?.trim() || "./data/agent-factory.db",
    nvidiaApiKey: env["NVIDIA_API_KEY"]?.trim() ?? "",
    nvidiaBaseUrl: (env["NVIDIA_BASE_URL"]?.trim() || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
    aiModels: models.length ? models : DEFAULT_MODELS,
    sessionTtlDays: int(env["SESSION_TTL_DAYS"], 14, 1, 365),
    allowRegistration: bool(env["ALLOW_REGISTRATION"], true),
    cookieSecure: bool(env["COOKIE_SECURE"], false),
    allowedOrigins: list(env["ALLOWED_ORIGINS"]),
  };
}
