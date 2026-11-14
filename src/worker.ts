/**
 * Punto de entrada para Cloudflare Workers.
 *
 * Toda la app vive dentro de UN Durable Object con almacenamiento SQLite: así se conserva la base de datos
 * síncrona del diseño original (transacciones, trigger de versiones inmutables, estados atómicos) y las peticiones
 * se serializan solas. El Worker de fuera solo reenvía las llamadas `/api/*`; los archivos de `public/` los sirve
 * Cloudflare directamente (ver wrangler.toml).
 */
import { DurableObject } from "cloudflare:workers";
import { providerFromConfig } from "./ai/provider.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/index.ts";
import { durableDb } from "./db/durable.ts";
import { recoverInterrupted } from "./engine/engine.ts";
import { createHandler } from "./http/app.ts";

interface Env {
  AGENT_FACTORY: DurableObjectNamespace;
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

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.AGENT_FACTORY.get(env.AGENT_FACTORY.idFromName("main"));
    return stub.fetch(request);
  },
};
