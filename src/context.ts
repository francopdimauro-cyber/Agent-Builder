import type { AiProvider } from "./ai/provider.ts";
import type { AppConfig } from "./config.ts";
import type { Db } from "./db/index.ts";

export interface Ctx {
  db: Db;
  ai: AiProvider;
  config: AppConfig;
}
