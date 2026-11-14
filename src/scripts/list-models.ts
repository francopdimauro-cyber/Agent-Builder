// Lista los modelos disponibles en NVIDIA para copiar los identificadores exactos a AI_MODELS.
import { loadConfig } from "../config.ts";

const config = loadConfig();
if (!config.nvidiaApiKey) {
  console.error("Falta NVIDIA_API_KEY: el listado de modelos de NVIDIA requiere autenticación. Defínela en .env.");
  process.exit(1);
}
const res = await fetch(`${config.nvidiaBaseUrl}/models`, {
  headers: { Authorization: `Bearer ${config.nvidiaApiKey}` },
  signal: AbortSignal.timeout(15_000),
});
if (!res.ok) {
  console.error(`No se pudo consultar NVIDIA (HTTP ${res.status}).${res.status === 401 || res.status === 403 ? " Revisa NVIDIA_API_KEY." : ""}`);
  process.exit(1);
}
const data = (await res.json()) as { data?: Array<{ id: string }> };
const all = (data.data ?? []).map((m) => m.id).sort();
const nemotron = all.filter((id) => /nemotron/i.test(id));
const show = (title: string, list: string[]) => {
  console.log(`\n${title} (${list.length})`);
  for (const id of list) console.log(`  ${id}`);
};
show("Nemotron", nemotron);
show("Otros modelos", all.filter((id) => !/nemotron/i.test(id)));
console.log("\nActualmente configurado en AI_MODELS:");
const known = new Set(all);
for (const m of config.aiModels) console.log(`  ${known.has(m) ? "✓" : "✗ NO EXISTE"}  ${m}`);
