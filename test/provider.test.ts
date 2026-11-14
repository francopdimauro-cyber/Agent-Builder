import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AiProviderError, createNvidiaProvider, findUnknownModels } from "../src/ai/provider.ts";
import { okBody, startMock } from "./helpers.ts";

const MODELS = ["m/primary", "m/backup1", "m/backup2"];
const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of closers) await c();
});

async function setup(handler: Parameters<typeof startMock>[0]) {
  const mock = await startMock(handler);
  closers.push(mock.close);
  const provider = createNvidiaProvider({ apiKey: "k", baseUrl: mock.url, models: MODELS });
  return { mock, provider };
}
const ARGS = { instructions: "sys", input: "hola" };

test("usa el modelo principal cuando responde", async () => {
  const { mock, provider } = await setup(() => ({ status: 200, body: okBody("hola!") }));
  const r = await provider.generateText(ARGS);
  assert.equal(r.text, "hola!");
  assert.equal(r.model, "m/primary");
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0]!.auth, "Bearer k");
  assert.deepEqual(mock.calls[0]!.body.messages.map((m: any) => m.role), ["system", "user"]);
});

test("429 en el principal → respaldo; el principal queda en pausa", async () => {
  const { mock, provider } = await setup((c) =>
    c.model === "m/primary" ? { status: 429, body: { error: "limit" }, headers: { "retry-after": "60" } } : { status: 200, body: okBody("desde respaldo") },
  );
  const r1 = await provider.generateText(ARGS);
  assert.equal(r1.model, "m/backup1");
  assert.equal(r1.attempts[0]!.outcome, "rate_limited");

  const before = mock.calls.length;
  const r2 = await provider.generateText(ARGS);
  assert.equal(r2.model, "m/backup1");
  assert.equal(mock.calls.length - before, 1, "el modelo en pausa no se vuelve a llamar");
  assert.equal(r2.attempts[0]!.outcome, "skipped_cooldown");
});

test("404 (modelo inexistente), 5xx y respuesta vacía caen al siguiente", async () => {
  const { provider } = await setup((c) => {
    if (c.model === "m/primary") return { status: 404, body: {} };
    if (c.model === "m/backup1") return { status: 200, body: { choices: [{ message: { content: "   " } }] } };
    return { status: 200, body: okBody("ok final") };
  });
  const r = await provider.generateText(ARGS);
  assert.equal(r.model, "m/backup2");
  assert.deepEqual(r.attempts.map((a) => a.outcome), ["provider_error", "invalid_response", "ok"]);
});

test("error incrustado en un HTTP 200 se trata como fallo recuperable", async () => {
  const { provider } = await setup((c) =>
    c.model === "m/primary" ? { status: 200, body: { error: { code: 429, message: "rate" } } } : { status: 200, body: okBody("ok") },
  );
  assert.equal((await provider.generateText(ARGS)).model, "m/backup1");
});

test("todos limitados → AiProviderError rate_limited", async () => {
  const { provider } = await setup(() => ({ status: 429, body: {} }));
  await assert.rejects(provider.generateText(ARGS), (e: unknown) => e instanceof AiProviderError && e.kind === "rate_limited");
  // Con todos en pausa se sondea uno y vuelve a fallar con el mismo tipo, sin explotar
  await assert.rejects(provider.generateText(ARGS), (e: unknown) => e instanceof AiProviderError && e.kind === "rate_limited");
});

test("401 es fatal y NO salta a otro modelo; 400 tampoco", async () => {
  const a = await setup(() => ({ status: 401, body: {} }));
  await assert.rejects(a.provider.generateText(ARGS), (e: unknown) => e instanceof AiProviderError && e.kind === "not_configured");
  assert.equal(a.mock.calls.length, 1);
  const b = await setup(() => ({ status: 400, body: {} }));
  await assert.rejects(b.provider.generateText(ARGS), (e: unknown) => e instanceof AiProviderError && e.kind === "provider_error");
  assert.equal(b.mock.calls.length, 1);
});

test("timeout del principal → respaldo", async () => {
  const { provider } = await setup((c) => (c.model === "m/primary" ? { status: 200, body: okBody("lento"), delayMs: 600 } : { status: 200, body: okBody("rápido") }));
  const r = await provider.generateText({ ...ARGS, timeoutMs: 200 });
  assert.equal(r.model, "m/backup1");
  assert.equal(r.attempts[0]!.outcome, "timeout");
});

test("envía json_schema y reasoning off cuando se piden", async () => {
  const { mock, provider } = await setup(() => ({ status: 200, body: okBody("{}") }));
  await provider.generateText({ ...ARGS, jsonSchema: { name: "x", schema: { type: "object" } }, reasoning: "off", maxOutputTokens: 321 });
  const body = mock.calls[0]!.body;
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.reasoning, undefined);
  assert.equal(body.max_tokens, 321);
});

test("sin clave → not_configured sin llamar a nadie", async () => {
  const mock = await startMock(() => ({ status: 200, body: okBody("x") }));
  closers.push(mock.close);
  const p = createNvidiaProvider({ apiKey: "", baseUrl: mock.url, models: MODELS });
  assert.equal(p.isConfigured(), false);
  await assert.rejects(p.generateText(ARGS), (e: unknown) => e instanceof AiProviderError && e.kind === "not_configured");
  assert.equal(mock.calls.length, 0);
});

test("findUnknownModels detecta identificadores inexistentes y envía la clave", async () => {
  let auth: string | undefined;
  const fake: typeof fetch = async (_url, init) => {
    auth = (init?.headers as Record<string, string>)["Authorization"];
    return new Response(JSON.stringify({ data: [{ id: "a/x" }, { id: "b/y" }] }), { status: 200 });
  };
  assert.deepEqual(await findUnknownModels("http://x", "k", ["a/x", "c/z"], fake), { checked: true, unknown: ["c/z"] });
  assert.equal(auth, "Bearer k");
  const down: typeof fetch = async () => {
    throw new Error("sin red");
  };
  assert.deepEqual(await findUnknownModels("http://x", "k", ["a"], down), { checked: false, unknown: [] });
  assert.deepEqual(await findUnknownModels("http://x", "", ["a"], fake), { checked: false, unknown: [] }, "sin clave no se consulta");
});
