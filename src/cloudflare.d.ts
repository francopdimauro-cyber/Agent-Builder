// Tipos mínimos de Cloudflare Workers usados por src/worker.ts (evita depender de @cloudflare/workers-types).
// Archivo sin imports/exports de nivel superior a propósito: así las declaraciones son globales/ambientales.

interface DurableObjectState {
  storage: import("./db/durable.ts").DurableStorageLike;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
