import assert from "node:assert/strict";
import { test } from "node:test";
import { canExecute, grantedExecutableTools, parseAgentConfig, sanitizeSuggestedTools } from "../src/domain/agent-config.ts";
import { assertTransition, canTransition, isTerminal } from "../src/domain/execution-state.ts";
import { ValidationError } from "../src/domain/validate.ts";
import { parseJsonLoose } from "../src/routes/agents.ts";

const valid = {
  name: "Agente",
  role: "Analista",
  objective: "Analizar datos",
  instructions: "Analiza los datos que reciba y resume.",
  tools: ["text_generation"],
};

test("parseAgentConfig aplica valores por defecto", () => {
  const c = parseAgentConfig(valid);
  assert.equal(c.limits.maxOutputTokens, 1500);
  assert.equal(c.limits.timeoutSeconds, 45);
  assert.equal(c.limits.reasoning, "default");
  assert.equal(c.requiresApproval, false);
  assert.deepEqual(c.capabilities, []);
});

test("parseAgentConfig acumula errores y rechaza herramientas desconocidas", () => {
  assert.throws(
    () => parseAgentConfig({ name: "x", role: "", objective: "ab", instructions: "corto", tools: ["hackear"] }),
    (e: unknown) => e instanceof ValidationError && e.issues.length >= 5 && e.issues.some((i) => i.includes("hackear")),
  );
  assert.throws(() => parseAgentConfig(null), ValidationError);
  assert.throws(() => parseAgentConfig({ ...valid, limits: { maxOutputTokens: 99999 } }), ValidationError);
  assert.throws(() => parseAgentConfig({ ...valid, limits: { reasoning: "max" } }), ValidationError);
});

test("las herramientas sugeridas por la IA se filtran y las no disponibles nunca se ejecutan", () => {
  assert.deepEqual(sanitizeSuggestedTools(["web_search", "rm -rf", 3, "web_search"]), ["web_search"]);
  const c = parseAgentConfig({ ...valid, tools: ["text_generation", "web_search"] });
  assert.deepEqual(grantedExecutableTools(c), ["text_generation"]);
});

test("canExecute exige generación de texto", () => {
  assert.equal(canExecute(parseAgentConfig(valid)).ok, true);
  assert.equal(canExecute(parseAgentConfig({ ...valid, tools: [] })).ok, false);
});

test("máquina de estados de ejecuciones", () => {
  assert.ok(canTransition("queued", "running"));
  assert.ok(canTransition("awaiting_approval", "queued"));
  assert.ok(!canTransition("completed", "running"));
  assert.ok(!canTransition("running", "queued"));
  assert.throws(() => assertTransition("failed", "queued"));
  assert.ok(isTerminal("cancelled") && !isTerminal("running"));
});

test("parseJsonLoose tolera vallas de código y texto alrededor", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Claro: {"a":{"b":2}} listo'), { a: { b: 2 } });
  assert.equal(parseJsonLoose("sin json"), null);
  assert.equal(parseJsonLoose("{roto"), null);
});
