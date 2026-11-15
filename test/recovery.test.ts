import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { AGENT, Client, okBody, startApp, startMock, type TestApp } from "./helpers.ts";
import { RECOVERY_META_KEY } from "../src/routes/recovery.ts";
import { q1 } from "../src/db/index.ts";

let app: TestApp;
let mock: Awaited<ReturnType<typeof startMock>>;

before(async () => {
  mock = await startMock(() => ({ status: 200, body: okBody("Respuesta") }));
  app = await startApp(mock.url);
});
after(async () => {
  await app?.close();
  await mock?.close();
});

test("restablecer credenciales con enlace único no destruye Refu, revoca sesiones y evita repetición", async () => {
  const old = new Client(app.base);
  assert.equal((await old.post("/api/auth/register", { email: "anterior@test.com", password: "Clave-anterior-12345" })).status, 201);
  const user = q1<{ id: string }>(app.db, "select id from users where email = ?", "anterior@test.com")!;
  assert.ok(user?.id);

  const agent = await old.post("/api/agents", { config: { ...AGENT, name: "Refu" } });
  assert.equal(agent.status, 201);
  const agentId = agent.json.id as string;
  assert.equal((await old.post(`/api/agents/${agentId}/status`, { status: "active" })).status, 200);

  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("base64");
  const record = { ownerId: user.id, tokenDigestBase64: hash, expiresAt: new Date(Date.now() + 1_800_000).toISOString() };
  app.db.run("insert into _meta (key,value) values (?,?)", [RECOVERY_META_KEY, JSON.stringify(record)]);

  const unknown = new Client(app.base);
  const wrong = randomBytes(32).toString("base64url");
  assert.equal((await unknown.post("/api/auth/recover", { token: wrong, password: "Nueva-clave-suficiente" })).status, 403);
  assert.equal((await unknown.post("/api/auth/recover", { token, password: "corta" })).status, 400);
  assert.equal((await unknown.post("/api/auth/recover", { token, password: "Nueva-clave-suficiente", email: "correo-invalido" })).status, 400);

  const changed = await unknown.post("/api/auth/recover", { token, password: "Nueva-clave-suficiente-987", email: "nueva@test.com" });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal(changed.json.ok, true);

  assert.equal((await old.get("/api/agents")).status, 401, "sesiones anteriores revocadas");
  assert.equal((await unknown.post("/api/auth/recover", { token, password: "Otra-clave-suficiente-123" })).status, 403, "enlace de un solo uso");
  assert.equal((await unknown.post("/api/auth/login", { email: "anterior@test.com", password: "Clave-anterior-12345" })).status, 401);
  assert.equal((await unknown.post("/api/auth/login", { email: "nueva@test.com", password: "Nueva-clave-suficiente-987" })).status, 200);
  assert.equal((await unknown.get("/api/agents")).json.agents[0].name, "Refu");
  assert.equal(q1<{ n: number }>(app.db, "select count(*) as n from agents where id = ?", agentId)?.n, 1);
  assert.equal(q1<{ n: number }>(app.db, "select count(*) as n from _meta where key = ?", RECOVERY_META_KEY)?.n, 0);
});

test("caducidad del enlace no cambia la cuenta", async () => {
  const c = new Client(app.base);
  const registered = await c.post("/api/auth/register", { email: "caducado@test.com", password: "Contraseña-valida-original" });
  assert.equal(registered.status, 201);
  const user = q1<{ id: string }>(app.db, "select id from users where email = ?", "caducado@test.com")!;
  const token = randomBytes(32).toString("base64url");
  const record = { ownerId: user.id, tokenDigestBase64: createHash("sha256").update(token).digest("base64"), expiresAt: new Date(Date.now() - 30_000).toISOString() };
  app.db.run("insert into _meta (key,value) values (?,?)", [RECOVERY_META_KEY, JSON.stringify(record)]);
  const unauth = new Client(app.base);
  assert.equal((await unauth.post("/api/auth/recover", { token, password: "Nueva-clave-suficiente-987" })).status, 403);
  assert.equal((await unauth.post("/api/auth/login", { email: "caducado@test.com", password: "Contraseña-valida-original" })).status, 200);
  app.db.run("delete from _meta where key = ?", [RECOVERY_META_KEY]);
});
