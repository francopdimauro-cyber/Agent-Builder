import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { test } from "node:test";
import { assembleStandalone, makeWorkerName, normalizeSiteOrigin, makeZip } from "../public/export/exporter.mjs";

const workerSource = readFileSync("public/export/template-worker.mjs", "utf8");
const widgetSource = readFileSync("public/widget.js", "utf8");
const agent = { name: "Agente Restaurante", status: "active", current_version: 1 };
const config = {
  name: "Refu", role: "Atención al cliente", objective: "Informar de horarios y reservas.",
  instructions: "Responde de forma clara, amable y sin inventar información.",
  description: "Asistente de restaurante", capabilities: [],
  tools: ["text_generation"], requiresApproval: false,
  limits: { maxOutputTokens: 1200, timeoutSeconds: 35, reasoning: "off" }
};
const uniqueId = "9c30c211-8225-4e65-8d87-517302341256";
const origin = "https://pruebas-restaurante.example";

test("normaliza dominios y rechaza dominios inseguros", () => {
  assert.equal(normalizeSiteOrigin("https://pruebas-restaurante.example/"), origin);
  assert.throws(() => normalizeSiteOrigin("http://pruebas-restaurante.example"));
  assert.throws(() => normalizeSiteOrigin("https://pruebas-restaurante.example/ruta"));
  assert.throws(() => normalizeSiteOrigin("https://evil.com@pruebas-restaurante.example"));
  assert.match(makeWorkerName("Restaurante El Refugio de Chilla", uniqueId), /^agent-restaurante-el-refugio-de-chilla-/);
});

test("genera ZIP completo y autónomo, sin credenciales, con CORS específico", () => {
  const data = assembleStandalone({ agent, config, siteOrigin: origin, workerSource, widgetSource, uniqueId });
  assert.match(data.workerName, /^agent-refu-/);
  assert.ok(data.zip.length > widgetSource.length);
  assert.deepEqual([...data.zip.slice(0,4)], [0x50,0x4b,0x03,0x04]);
  assert.deepEqual(Object.keys(data.files).sort(), [
    ".gitignore","EMBEBER_EN_WEB.html","README.md","package.json",
    "public/widget.js","src/agent.json","src/worker.mjs","wrangler.toml"
  ].sort());
  const manifest = JSON.parse(data.files["src/agent.json"]);
  assert.deepEqual(manifest.allowedOrigins, [origin]);
  assert.equal(manifest.chatId, uniqueId);
  assert.equal(manifest.instructions, config.instructions);
  assert.ok(data.files["wrangler.toml"].includes('new_sqlite_classes = ["SiteAgent"]'));
  assert.ok(data.files["src/worker.mjs"].includes("this.ctx.storage.transactionSync"));
  assert.ok(data.files["EMBEBER_EN_WEB.html"].includes(uniqueId));
  assert.ok(!data.files["src/agent.json"].includes("NVIDIA_API_KEY"));
  assert.ok(!data.files["wrangler.toml"].includes("nvidia-api-key-placeholder"));
  assert.ok(!data.files["src/worker.mjs"].includes("agent-factory-free.francopdimauro.workers.dev"));
  assert.equal(data.files["src/worker.mjs"], workerSource);
  mkdirSync(".export-ci", { recursive: true });
  writeFileSync(".export-ci/example.zip", data.zip);
});

test("rechaza agentes sin permiso o que requieren herramientas no implementadas", () => {
  const params = { agent, config, siteOrigin: origin, workerSource, widgetSource, uniqueId };
  assert.throws(() => assembleStandalone({ ...params, agent: { ...agent, status: "draft" } }));
  assert.throws(() => assembleStandalone({ ...params, config: { ...config, requiresApproval: true } }));
  assert.throws(() => assembleStandalone({ ...params, config: { ...config, tools: ["text_generation","http_request"] } }));
  assert.throws(() => assembleStandalone({ ...params, config: { ...config, tools: [] } }));
  assert.throws(() => makeZip({ "../secret": "hack" }));
});
