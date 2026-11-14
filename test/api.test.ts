import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { exec, q1 } from "../src/db/index.ts";
import { recoverInterrupted } from "../src/engine/engine.ts";
import { AGENT, Client, okBody, startApp, startMock, type TestApp } from "./helpers.ts";

let mock: Awaited<ReturnType<typeof startMock>>;
let app: TestApp;

before(async () => {
  mock = await startMock((c, n) => ({ status: 200, body: okBody(`OUT:${n} (${c.model})`) }));
  app = await startApp(mock.url);
});
after(async () => {
  await app.close();
  await mock.close();
});

const defaultHandler = (c: { model: string }, n: number) => ({ status: 200, body: okBody(`OUT:${n} (${c.model})`) });

async function newUser(email: string): Promise<Client> {
  const c = new Client(app.base);
  const r = await c.post("/api/auth/register", { email, password: "contraseña-larga-1", displayName: email.split("@")[0] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return c;
}

async function activeAgent(c: Client, over: Record<string, unknown> = {}): Promise<string> {
  const r = await c.post("/api/agents", { config: { ...AGENT, ...over }, source: "manual" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const id = r.json.id as string;
  assert.equal((await c.post(`/api/agents/${id}/status`, { status: "active" })).status, 200);
  return id;
}

test("autenticación: registro, sesión, logout, login y errores", async () => {
  const anon = new Client(app.base);
  assert.equal((await anon.get("/api/agents")).status, 401);
  assert.equal((await anon.get("/api/health")).status, 200);

  assert.equal((await anon.post("/api/auth/register", { email: "mal", password: "corta" })).status, 400);
  const reg = await anon.post("/api/auth/register", { email: "Ana@Ejemplo.com", password: "contraseña-larga-1" });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.user.email, "ana@ejemplo.com");
  assert.ok(reg.json.user.password_hash === undefined, "no se filtra el hash");
  assert.match(reg.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
  assert.equal((await anon.get("/api/auth/me")).json.user.email, "ana@ejemplo.com");

  assert.equal((await new Client(app.base).post("/api/auth/register", { email: "ana@ejemplo.com", password: "contraseña-larga-1" })).status, 409);

  await anon.post("/api/auth/logout");
  assert.equal((await anon.get("/api/auth/me")).status, 401);

  const bad = new Client(app.base);
  assert.equal((await bad.post("/api/auth/login", { email: "ana@ejemplo.com", password: "incorrecta-123" })).status, 401);
  assert.equal((await bad.post("/api/auth/login", { email: "noexiste@x.com", password: "incorrecta-123" })).status, 401);
  assert.equal((await bad.post("/api/auth/login", { email: "ana@ejemplo.com", password: "contraseña-larga-1" })).status, 200);
  assert.equal((await bad.get("/api/auth/me")).status, 200);
});

test("seguridad HTTP: origen ajeno, content-type y JSON inválido", async () => {
  const c = await newUser("seg@x.com");
  assert.equal((await c.req("POST", "/api/agents/generate", { prompt: "x".repeat(20) }, { Origin: "https://evil.example" })).status, 403);
  const raw = await fetch(app.base + "/api/agents", { method: "POST", headers: { Cookie: c.cookie, "Content-Type": "text/plain" }, body: "hola" });
  assert.equal(raw.status, 415);
  const broken = await fetch(app.base + "/api/agents", { method: "POST", headers: { Cookie: c.cookie, "Content-Type": "application/json" }, body: "{roto" });
  assert.equal(broken.status, 400);
  assert.equal((await c.get("/api/nada")).status, 404);
  assert.equal((await c.req("PATCH", "/api/agents", {})).status, 405);
});

test("limitador: 5 logins fallidos bloquean al sexto", async () => {
  await newUser("lim@x.com");
  const c = new Client(app.base);
  for (let i = 0; i < 5; i++) assert.equal((await c.post("/api/auth/login", { email: "lim@x.com", password: "mala-contraseña" })).status, 401);
  assert.equal((await c.post("/api/auth/login", { email: "lim@x.com", password: "contraseña-larga-1" })).status, 429);
});

test("ciclo de vida: borrador no ejecuta, activar, ejecutar y modelo registrado", async () => {
  mock.setHandler(defaultHandler);
  const c = await newUser("vida@x.com");
  const created = await c.post("/api/agents", { config: AGENT, source: "manual" });
  const id = created.json.id as string;

  assert.equal((await c.post("/api/executions", { agentId: id, input: "hola" })).status, 409); // sigue en borrador
  await c.post(`/api/agents/${id}/status`, { status: "active" });

  const run = await c.post("/api/executions", { agentId: id, input: "Texto largo a resumir" });
  assert.equal(run.status, 201);
  assert.equal(run.json.status, "completed");
  const detail = await c.get(`/api/executions/${run.json.id}`);
  assert.match(detail.json.execution.output, /^OUT:/);
  assert.equal(detail.json.execution.model, "m/primary");
  assert.deepEqual(detail.json.events.map((e: any) => e.type), ["created", "running", "completed"]);

  // El prompt enviado al modelo incluye rol/objetivo y prohíbe fingir herramientas
  const sys = mock.calls.at(-1)!.body.messages[0].content as string;
  assert.match(sys, /Redactor profesional/);
  assert.match(sys, /No afirmes haber usado herramientas externas/);
});

test("versiones inmutables: editar crea v2, ejecuta la actual y el trigger impide modificar", async () => {
  const c = await newUser("ver@x.com");
  const id = await activeAgent(c);
  const v2 = await c.post(`/api/agents/${id}/versions`, { config: { ...AGENT, name: "Redactor v2" }, note: "cambio de nombre" });
  assert.equal(v2.json.version, 2);
  const detail = await c.get(`/api/agents/${id}`);
  assert.equal(detail.json.agent.current_version, 2);
  assert.equal(detail.json.agent.name, "Redactor v2");
  assert.deepEqual(detail.json.versions.map((v: any) => v.version), [2, 1]);
  assert.equal(detail.json.versions[1].config.name, "Redactor");

  assert.throws(() => exec(app.db, "update agent_versions set config = '{}' where agent_id = ?", id), /inmutable/);
  const run = await c.post("/api/executions", { agentId: id, input: "x" });
  assert.equal((await c.get(`/api/executions/${run.json.id}`)).json.execution.agent_version, 2);
});

test("aislamiento entre usuarios (lo que antes hacía RLS)", async () => {
  mock.setHandler(defaultHandler);
  const a = await newUser("a-iso@x.com");
  const b = await newUser("b-iso@x.com");
  const agentId = await activeAgent(a);
  const exec = await a.post("/api/executions", { agentId, input: "secreto de A" });
  const wf = await a.post("/api/workflows", { name: "Flujo A", steps: [{ agentId, title: "Paso" }] });
  const run = await a.post(`/api/workflows/${wf.json.id}/runs`, { input: "x" });

  assert.equal((await b.get("/api/agents")).json.agents.length, 0);
  assert.equal((await b.get(`/api/agents/${agentId}`)).status, 404);
  assert.equal((await b.post(`/api/agents/${agentId}/status`, { status: "inactive" })).status, 404);
  assert.equal((await b.post(`/api/agents/${agentId}/versions`, { config: AGENT })).status, 404);
  assert.equal((await b.del(`/api/agents/${agentId}`)).status, 404);
  assert.equal((await b.post("/api/executions", { agentId, input: "robo" })).status, 404);
  assert.equal((await b.get(`/api/executions/${exec.json.id}`)).status, 404);
  assert.equal((await b.post(`/api/executions/${exec.json.id}/cancel`)).status, 404);
  assert.equal((await b.get("/api/executions")).json.executions.length, 0);
  assert.equal((await b.get(`/api/workflows/${wf.json.id}`)).status, 404);
  assert.equal((await b.post(`/api/workflows/${wf.json.id}/runs`, { input: "x" })).status, 404);
  assert.equal((await b.get(`/api/workflow-runs/${run.json.id}`)).status, 404);
  assert.equal((await b.post(`/api/workflow-runs/${run.json.id}/cancel`)).status, 409);
  // B no puede montar un flujo con el agente de A
  assert.equal((await b.post("/api/workflows", { name: "Intruso", steps: [{ agentId, title: "Paso" }] })).status, 400);
  assert.equal((await b.get("/api/audit")).json.logs.every((l: any) => l.entity_id !== agentId), true);
});

test("respaldo de modelos dentro de una ejecución real", async () => {
  mock.setHandler((c, n) => (c.model === "m/primary" ? { status: 429, body: {}, headers: { "retry-after": "30" } } : { status: 200, body: okBody(`RESPALDO:${n}`) }));
  const c = await newUser("resp@x.com");
  const id = await activeAgent(c);
  const run = await c.post("/api/executions", { agentId: id, input: "hola" });
  assert.equal(run.json.status, "completed");
  const d = await c.get(`/api/executions/${run.json.id}`);
  assert.equal(d.json.execution.model, "m/backup1");
  const fb = d.json.events.find((e: any) => e.type === "fallback");
  assert.ok(fb && /m\/backup1/.test(fb.message));
  const sup = await c.get("/api/supervisor");
  assert.deepEqual(sup.json.modelUsage, [{ model: "m/backup1", n: 1 }]);
  mock.setHandler(defaultHandler);
});

test("todos los modelos caídos → ejecución fallida con mensaje claro y reintento", async () => {
  const c = await newUser("caido@x.com");
  const id = await activeAgent(c);
  mock.setHandler(() => ({ status: 503, body: {} }));
  const run = await c.post("/api/executions", { agentId: id, input: "hola" });
  assert.equal(run.json.status, "failed");
  const d = await c.get(`/api/executions/${run.json.id}`);
  assert.match(d.json.execution.error, /disponible/);
  assert.equal(d.json.execution.output, null);

  // Solo reintentables si fallaron; al volver el servicio funciona (los modelos en pausa se sondean)
  mock.setHandler(defaultHandler);
  const retry = await c.post(`/api/executions/${run.json.id}/retry`);
  assert.equal(retry.json.status, "completed");
  assert.equal((await c.get(`/api/executions/${retry.json.id}`)).json.execution.attempt, 2);
  assert.equal((await c.post(`/api/executions/${retry.json.id}/retry`)).status, 409);
});

test("aprobación humana: aprobar ejecuta, rechazar cancela", async () => {
  mock.setHandler(defaultHandler);
  const c = await newUser("apr@x.com");
  const id = await activeAgent(c, { requiresApproval: true });

  const r1 = await c.post("/api/executions", { agentId: id, input: "enviar informe" });
  assert.equal(r1.json.status, "awaiting_approval");
  const callsBefore = mock.calls.length;
  const pend = (await c.get("/api/approvals?status=pending")).json.approvals;
  assert.equal(pend.length, 1);
  assert.equal(mock.calls.length, callsBefore, "no se llama a la IA antes de aprobar");
  assert.equal((await c.post(`/api/approvals/${pend[0].id}/decision`, { approve: true })).json.status, "completed");
  assert.equal((await c.post(`/api/approvals/${pend[0].id}/decision`, { approve: true })).status, 404); // ya decidida

  const r2 = await c.post("/api/executions", { agentId: id, input: "otro" });
  const ap2 = (await c.get("/api/approvals?status=pending")).json.approvals[0];
  assert.equal((await c.post(`/api/approvals/${ap2.id}/decision`, { approve: false })).json.status, "cancelled");
  assert.equal((await c.get(`/api/executions/${r2.json.id}`)).json.execution.status, "cancelled");
});

test("flujos: encadenan la salida de cada paso y respetan aprobaciones", async () => {
  mock.setHandler(defaultHandler);
  const c = await newUser("flujo@x.com");
  const a1 = await activeAgent(c, { name: "Analista" });
  const a2 = await activeAgent(c, { name: "Redactor" });
  const wf = await c.post("/api/workflows", {
    name: "Informe",
    steps: [
      { agentId: a1, title: "Analizar", instruction: "Extrae los puntos clave" },
      { agentId: a2, title: "Redactar", instruction: "Redacta el resumen", requiresApproval: true },
    ],
  });
  assert.equal(wf.status, 201);

  const start = mock.calls.length;
  const run = await c.post(`/api/workflows/${wf.json.id}/runs`, { input: "DATOS ORIGINALES" });
  assert.equal(run.json.status, "awaiting_approval"); // el paso 2 pide aprobación
  assert.equal(mock.calls.length - start, 1);
  assert.match(mock.calls[start]!.body.messages[1].content, /Tarea: Extrae los puntos clave[\s\S]*DATOS ORIGINALES/);

  // No se puede editar un flujo en curso
  assert.equal((await c.put(`/api/workflows/${wf.json.id}`, { name: "X2", steps: [{ agentId: a1, title: "Uno" }] })).status, 409);

  const ap = (await c.get("/api/approvals?status=pending")).json.approvals[0];
  assert.equal((await c.post(`/api/approvals/${ap.id}/decision`, { approve: true })).json.status, "completed");
  const out1 = `OUT:${start + 1} (m/primary)`;
  assert.ok(mock.calls[start + 1]!.body.messages[1].content.includes(out1), "el paso 2 recibe la salida del paso 1");

  const detail = (await c.get(`/api/workflow-runs/${run.json.id}`)).json;
  assert.equal(detail.run.status, "completed");
  assert.equal(detail.executions.length, 2);
  assert.ok(detail.events.some((e: any) => e.type === "step_completed"));

  // Ahora sí se puede editar; y el agente en uso no se puede borrar
  assert.equal((await c.put(`/api/workflows/${wf.json.id}`, { name: "Informe v2", steps: [{ agentId: a1, title: "Uno" }] })).status, 200);
  assert.equal((await c.del(`/api/agents/${a1}`)).status, 409);
  assert.equal((await c.del(`/api/workflows/${wf.json.id}`)).status, 200);
  assert.equal((await c.del(`/api/agents/${a1}`)).status, 200);
});

test("flujo: rechazo y cancelación, y fallo de un paso detiene el flujo", async () => {
  mock.setHandler(defaultHandler);
  const c = await newUser("flujo2@x.com");
  const a = await activeAgent(c);
  const wf = await c.post("/api/workflows", { name: "Con aprobación", steps: [{ agentId: a, title: "P1", requiresApproval: true }] });

  const r1 = await c.post(`/api/workflows/${wf.json.id}/runs`, { input: "x" });
  assert.equal(r1.json.status, "awaiting_approval");
  assert.equal((await c.post(`/api/workflow-runs/${r1.json.id}/cancel`)).status, 200);
  assert.equal((await c.get(`/api/workflow-runs/${r1.json.id}`)).json.run.status, "cancelled");
  assert.equal((await c.get("/api/approvals?status=pending")).json.approvals.length, 0);
  assert.equal((await c.post(`/api/workflow-runs/${r1.json.id}/cancel`)).status, 409);

  const wf2 = await c.post("/api/workflows", { name: "Sin aprobación", steps: [{ agentId: a, title: "P1" }, { agentId: a, title: "P2" }] });
  mock.setHandler(() => ({ status: 503, body: {} }));
  const r2 = await c.post(`/api/workflows/${wf2.json.id}/runs`, { input: "x" });
  assert.equal(r2.json.status, "failed");
  const d = (await c.get(`/api/workflow-runs/${r2.json.id}`)).json;
  assert.match(d.run.error, /Paso 1/);
  assert.equal(d.executions.length, 1);
  mock.setHandler(defaultHandler);
});

test("flujo largo: pausa cada 3 pasos y «continuar» lo completa", async () => {
  mock.setHandler(defaultHandler);
  const c = await newUser("largo@x.com");
  const a = await activeAgent(c);
  const wf = await c.post("/api/workflows", { name: "Cinco pasos", steps: Array.from({ length: 5 }, (_, i) => ({ agentId: a, title: `P${i + 1}` })) });
  const run = await c.post(`/api/workflows/${wf.json.id}/runs`, { input: "x" });
  assert.equal(run.json.status, "running");
  assert.equal((await c.get(`/api/workflow-runs/${run.json.id}`)).json.executions.length, 3);
  assert.equal((await c.post(`/api/workflow-runs/${run.json.id}/continue`)).json.status, "completed");
  assert.equal((await c.get(`/api/workflow-runs/${run.json.id}`)).json.executions.length, 5);
});

test("generación de agentes con IA: tolera ```json, filtra herramientas y reintenta", async () => {
  const c = await newUser("gen@x.com");
  const payload = { name: "Soporte", description: "d", role: "Agente de soporte", objective: "Resolver dudas", instructions: "Responde con amabilidad. Pide datos. Escala si hace falta.", capabilities: ["FAQ"], suggestedTools: ["web_search", "borrar_todo"], requiresApproval: true };
  mock.setHandler(() => ({ status: 200, body: okBody("```json\n" + JSON.stringify(payload) + "\n```") }));
  const r = await c.post("/api/agents/generate", { prompt: "Un agente de soporte para mi tienda online" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.suggestedTools, ["web_search"]);
  assert.equal(r.json.config.requiresApproval, true);
  assert.equal(r.json.config.tools, undefined, "nunca concede herramientas");
  assert.equal(mock.calls.at(-1)!.body.response_format.type, "json_schema");

  // No guarda nada hasta que el usuario crea el agente
  assert.equal((await c.get("/api/agents")).json.agents.length, 0);

  const before = mock.calls.length;
  mock.setHandler(() => ({ status: 200, body: okBody("no soy json") }));
  const bad = await c.post("/api/agents/generate", { prompt: "Un agente de soporte para mi tienda online" });
  assert.equal(bad.status, 502);
  assert.equal(mock.calls.length - before, 2, "un reintento antes de rendirse");
  assert.equal((await c.post("/api/agents/generate", { prompt: "corto" })).status, 400);
  mock.setHandler(defaultHandler);
});

test("supervisor: máximo 5 ejecuciones activas simultáneas", async () => {
  mock.setHandler((c, n) => ({ status: 200, body: okBody(`OUT:${n}`), delayMs: 400 }));
  const c = await newUser("sup@x.com");
  const id = await activeAgent(c);
  const results = await Promise.all(Array.from({ length: 7 }, () => c.post("/api/executions", { agentId: id, input: "x" })));
  const codes = results.map((r) => r.status).sort();
  assert.equal(codes.filter((s) => s === 201).length, 5);
  assert.equal(codes.filter((s) => s === 429).length, 2);
  mock.setHandler(defaultHandler);
  const sup = (await c.get("/api/supervisor")).json;
  assert.equal(sup.active, 0);
  assert.equal(sup.counts.completed, 5);
});

test("recuperación al arrancar: lo que estaba en vuelo se marca fallido", async () => {
  const c = await newUser("rec@x.com");
  const id = await activeAgent(c);
  const user = q1<{ id: string }>(app.db, "select id from users where email = 'rec@x.com'")!;
  exec(app.db, "insert into executions (id, owner_id, agent_id, agent_version, status, input) values ('11111111-1111-4111-8111-111111111111', ?, ?, 1, 'running', 'x')", user.id, id);
  assert.equal(recoverInterrupted(app.db), 1);
  const d = await c.get("/api/executions/11111111-1111-4111-8111-111111111111");
  assert.equal(d.json.execution.status, "failed");
  assert.match(d.json.execution.error, /reinicio/);
  assert.equal(recoverInterrupted(app.db), 0);
});

test("estado del sistema, auditoría y registro cerrado", async () => {
  const c = await newUser("sys@x.com");
  const st = (await c.get("/api/system/status")).json;
  assert.equal(st.aiConfigured, true);
  assert.deepEqual(st.models, ["m/primary", "m/backup1", "m/backup2"]);
  assert.equal(st.tools.find((t: any) => t.id === "web_search").availability, "unavailable");
  await activeAgent(c);
  const actions = (await c.get("/api/audit")).json.logs.map((l: any) => l.action);
  assert.ok(actions.includes("agent.create") && actions.includes("agent.activate"));

  const closed = await startApp(mock.url, ["m/x"], { ALLOW_REGISTRATION: "false" });
  assert.equal((await new Client(closed.base).post("/api/auth/register", { email: "n@x.com", password: "contraseña-larga-1" })).status, 403);
  await closed.close();
});
