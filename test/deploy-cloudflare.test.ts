import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deployIndependentAgent, DeploymentError, siteOrigin, type AgentDeploymentDetail } from "../src/deploy/cloudflare.ts";

const workerSource = readFileSync("public/export/template-worker.mjs", "utf8");
const widgetSource = readFileSync("public/widget.js", "utf8");
const agentId = "2fb13a78-b74f-4dc1-a0a2-6f0ea928a0e6";
const detail: AgentDeploymentDetail = {
  agent: { id: agentId, name: "Refu", status: "active", current_version: 1 },
  versions: [{
    version: 1,
    config: {
      name: "Refu",
      role: "Asistente del restaurante",
      objective: "Ayudar a consultar información.",
      instructions: "Proporciona horarios sin inventar datos.",
      tools: ["text_generation"],
      requiresApproval: false,
    },
  }],
};
const id = "ba56d80431a1f1ca7555ff2031a1f0fd";
const origin = "https://restaurante.example";
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, result: data }), { status: 200 });
const denied = (status: number, codes = [10000]) =>
  new Response(JSON.stringify({ success: false, errors: codes.map(code => ({ code })) }), { status });

test("normaliza la URL y rechaza otros protocolos y rutas", () => {
  assert.equal(siteOrigin("https://restaurante.example/"), origin);
  for (const input of ["http://restaurante.example", "https://restaurante.example/abierto", "https://restaurante.example?q=1", "mailto:test@example.com"]) {
    assert.throws(() => siteOrigin(input), DeploymentError);
  }
});

test("crea Worker independiente usando Cloudflare multipart, SQLite propia y widget embebido", async () => {
  const steps: string[] = [];
  let generatedName = "";
  const mock: typeof fetch = async (req, init) => {
    const url = String(req), method = init?.method || "GET";
    steps.push(method + " " + url.split("/").slice(-2).join("/"));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-test-token");
    if (method === "GET" && url.endsWith("/workers/subdomain")) return ok({ subdomain: "francopdimauro" });
    if (method === "GET" && url.includes("/scripts/")) {
      generatedName = url.split("/").pop()!;
      assert.match(generatedName, /^agente-refu-[a-f0-9]{12}$/);
      return denied(404, [10007]);
    }
    if (method === "PUT" && url.includes("/scripts/")) {
      assert.equal(url.split("/").pop(), generatedName);
      assert.ok(init?.body instanceof FormData);
      const form = init.body as FormData;
      const metadata = JSON.parse(String(await (form.get("metadata") as Blob).text()));
      const code = await (form.get("worker.mjs") as Blob).text();
      assert.equal(metadata.main_module, "worker.mjs");
      assert.deepEqual(metadata.migrations.new_sqlite_classes, ["SiteAgent"]);
      assert.ok(metadata.bindings.some((x: { type:string; name:string }) => x.type === "durable_object_namespace" && x.name === "SITE_AGENT"));
      assert.ok(code.includes("restaurante.example"));
      assert.ok(code.includes(agentId));
      assert.ok(code.includes("widget.js"));
      assert.ok(!code.includes('import agent from "./agent.json";'));
      assert.ok(!code.includes("agent-factory-free.francopdimauro.workers.dev"));
      assert.ok(!code.includes("fake-test-token"));
      return ok({ id: generatedName });
    }
    if (method === "POST" && url.endsWith("/subdomain")) {
      assert.equal(JSON.parse(String(init?.body)).enabled, true);
      return ok({ enabled: true });
    }
    assert.fail("Ruta inesperada: " + method + " " + url);
  };
  const result = await deployIndependentAgent({
    detail,
    webOrigin: origin,
    workerSource, widgetSource,
    accountId: id, apiToken: "fake-test-token", cfFetch: mock,
  });
  assert.equal(result.chatId, agentId);
  assert.equal(result.needsAiKey, true);
  assert.equal(result.workerUrl, "https://" + generatedName + ".francopdimauro.workers.dev");
  assert.deepEqual(steps.map(x=>x.split(" ")[0]), ["GET", "PUT", "POST", "GET"]);
});

test("sin token o cuenta configurada no realiza peticiones ni consume el proveedor", async () => {
  let calls = 0;
  const mock: typeof fetch = async () => { calls++; return ok({}); };
  const base = { detail, webOrigin: origin, workerSource, widgetSource, cfFetch: mock, accountId: id, apiToken: "" };
  await assert.rejects(() => deployIndependentAgent(base), (e: unknown) => e instanceof DeploymentError && e.status === 503);
  await assert.rejects(() => deployIndependentAgent({ ...base, apiToken:"token", accountId:"bad" }), DeploymentError);
  assert.equal(calls, 0);
});

test("rechaza agentes inactivos, herramientas externas y aprobación obligatoria", async () => {
  let calls = 0;
  const cfFetch: typeof fetch = async () => { calls++; return ok({}); };
  const base = { detail, webOrigin: origin, workerSource, widgetSource, accountId: id, apiToken: "fake-test-token", cfFetch };
  await assert.rejects(() => deployIndependentAgent({ ...base, detail:{ ...detail, agent:{...detail.agent,status:"draft"} } }), DeploymentError);
  await assert.rejects(() => deployIndependentAgent({ ...base, detail:{...detail, versions:[{version:1,config:{...detail.versions[0]!.config, tools:["http_request"]}}]} }), DeploymentError);
  await assert.rejects(() => deployIndependentAgent({ ...base, detail:{...detail, versions:[{version:1,config:{...detail.versions[0]!.config,requiresApproval:true}}]} }), DeploymentError);
  assert.equal(calls, 0);
});

test("nunca sobrescribe otro Worker existente", async () => {
  let changes = 0;
  const cfFetch: typeof fetch = async (_input, init) => {
    if ((init?.method || "GET") !== "GET") changes++;
    return ok({});
  };
  await assert.rejects(() => deployIndependentAgent({
    detail, webOrigin: origin, workerSource, widgetSource,
    accountId: id, apiToken:"fake-test-token", cfFetch,
  }), (e: unknown) => e instanceof DeploymentError && e.status === 409);
  assert.equal(changes, 0);
});

test("Cloudflare deniega acceso: devuelve error sin filtrar tokens", async () => {
  const cfFetch: typeof fetch = async () => denied(403, [10000]);
  await assert.rejects(() => deployIndependentAgent({
    detail, webOrigin: origin, workerSource, widgetSource,
    accountId: id, apiToken:"fake-test-token", cfFetch,
  }), (e: unknown) => e instanceof DeploymentError && !e.message.includes("fake-test-token"));
});
