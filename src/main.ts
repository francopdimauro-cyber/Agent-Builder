import { findUnknownModels, providerFromConfig } from "./ai/provider.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/index.ts";
import { recoverInterrupted } from "./engine/engine.ts";
import { createApp } from "./http/server.ts";

const config = loadConfig();
const db = openDb(config.databasePath);
const recovered = recoverInterrupted(db);
if (recovered) console.warn(`Se marcaron ${recovered} ejecuciones interrumpidas como fallidas.`);

const ai = providerFromConfig(config);
const server = createApp({ db, ai, config }, { publicDir: "public" });

server.listen(config.port, config.host, () => {
  console.log(`Agent Factory escuchando en http://${config.host}:${config.port}`);
  console.log(`IA: ${ai.isConfigured() ? "NVIDIA configurado" : "⚠ falta NVIDIA_API_KEY"}`);
  console.log(`Modelos (prioridad): ${config.aiModels.join(" → ")}`);
  if (!config.cookieSecure && config.host !== "127.0.0.1" && config.host !== "localhost") {
    console.warn("⚠ Estás expuesto fuera de localhost sin COOKIE_SECURE=true: sirve la app por HTTPS.");
  }
  void findUnknownModels(config.nvidiaBaseUrl, config.nvidiaApiKey, config.aiModels).then(({ checked, unknown }) => {
    if (checked && unknown.length) console.warn(`⚠ Identificadores de modelo que NVIDIA no reconoce: ${unknown.join(", ")}. Ejecuta «npm run models».`);
  });
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
