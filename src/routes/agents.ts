import { randomUUID } from "node:crypto";
import type { Ctx } from "../context.ts";
import { exec, nowIso, q, q1, tx } from "../db/index.ts";
import type { AgentRow } from "../db/types.ts";
import { canExecute, parseAgentConfig, sanitizeSuggestedTools } from "../domain/agent-config.ts";
import { asObject, Checker, isRecord } from "../domain/validate.ts";
import { AppError } from "../errors.ts";
import { audit } from "../engine/engine.ts";
import { json, type Router } from "../http/router.ts";
import { AiProviderError } from "../ai/provider.ts";

const GENERATED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "role", "objective", "instructions", "capabilities", "suggestedTools", "requiresApproval"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    role: { type: "string" },
    objective: { type: "string" },
    instructions: { type: "string" },
    capabilities: { type: "array", items: { type: "string" } },
    suggestedTools: { type: "array", items: { type: "string" } },
    requiresApproval: { type: "boolean" },
  },
} as const;

/** Extrae un objeto JSON aunque el modelo lo envuelva en ```json … ``` o añada texto alrededor. */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v: unknown = JSON.parse(stripped.slice(start, end + 1));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

export function registerAgentRoutes(router: Router, ctx: Ctx): void {
  const { db, ai } = ctx;

  const ownedAgent = (ownerId: string, id: string): AgentRow => {
    const a = q1<AgentRow>(db, "select * from agents where id = ? and owner_id = ?", id, ownerId);
    if (!a) throw new AppError(404, "Agente no encontrado.");
    return a;
  };

  /** Genera una configuración propuesta. NO guarda nada ni concede herramientas. */
  router.add("POST", "/api/agents/generate", async (req) => {
    const o = asObject(req.body);
    const c = new Checker();
    const prompt = c.string(o["prompt"], "prompt", { min: 10, max: 2000 });
    c.done();

    const instructions =
      "Diseñas agentes de IA. A partir de la descripción del usuario, devuelve SOLO un objeto JSON en español con los campos " +
      "name, description, role, objective, instructions, capabilities, suggestedTools y requiresApproval. " +
      "Instrucciones claras y accionables (mínimo 3 frases). Capacidades: lista corta. " +
      "suggestedTools solo puede contener ids de: text_generation, web_search, http_request, email_send. " +
      "requiresApproval=true si el agente podría tomar decisiones sensibles.";

    // Los modelos gratuitos a veces devuelven JSON roto: un reintento antes de rendirse.
    let raw: Record<string, unknown> | null = null;
    let model = "";
    for (let attempt = 0; attempt < 2 && !raw; attempt++) {
      const out = await ai.generateText({
        instructions,
        input: prompt,
        maxOutputTokens: 2000,
        jsonSchema: { name: "agent_config", schema: GENERATED_SCHEMA as unknown as Record<string, unknown> },
      });
      model = out.model;
      raw = parseJsonLoose(out.text);
    }
    if (!raw) throw new AiProviderError("invalid_response", "La IA devolvió un formato inválido. Inténtalo de nuevo.");

    audit(db, req.user.id, "agent.ai_generate", "agent", null, { prompt_chars: prompt.length, model });
    const strs = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 20) : []);
    return json({
      config: {
        name: String(raw["name"] ?? "").slice(0, 80),
        description: String(raw["description"] ?? "").slice(0, 500),
        role: String(raw["role"] ?? ""),
        objective: String(raw["objective"] ?? ""),
        instructions: String(raw["instructions"] ?? ""),
        capabilities: strs(raw["capabilities"]),
        requiresApproval: Boolean(raw["requiresApproval"]),
      },
      // Solo sugerencias: el usuario debe activarlas explícitamente.
      suggestedTools: sanitizeSuggestedTools(raw["suggestedTools"]),
      model,
    });
  });

  router.add("GET", "/api/agents", (req) =>
    json({
      agents: q(
        db,
        "select id, name, description, status, current_version, created_at, updated_at from agents where owner_id = ? order by updated_at desc",
        req.user.id,
      ),
    }),
  );

  router.add("POST", "/api/agents", (req) => {
    const o = asObject(req.body);
    const config = parseAgentConfig(o["config"]);
    const c = new Checker();
    const source = c.oneOf(o["source"], "source", ["manual", "ai"] as const, "manual");
    c.done();

    const id = randomUUID();
    tx(db, () => {
      exec(db, "insert into agents (id, owner_id, name, description, status, current_version) values (?,?,?,?, 'draft', 1)", id, req.user.id, config.name, config.description);
      exec(
        db,
        "insert into agent_versions (id, agent_id, owner_id, version, config, source, change_note) values (?,?,?,?,?,?,?)",
        randomUUID(),
        id,
        req.user.id,
        1,
        JSON.stringify(config),
        source,
        "Versión inicial",
      );
      audit(db, req.user.id, "agent.create", "agent", id, { source });
    });
    return json({ id }, 201);
  });

  router.add("GET", "/api/agents/:id", (req) => {
    const agent = ownedAgent(req.user.id, req.params["id"]!);
    const versions = q<{ id: string; version: number; config: string; source: string; change_note: string | null; created_at: string }>(
      db,
      "select id, version, config, source, change_note, created_at from agent_versions where agent_id = ? and owner_id = ? order by version desc",
      agent.id,
      req.user.id,
    ).map((v) => ({ ...v, config: JSON.parse(v.config) as unknown }));
    return json({ agent, versions });
  });

  router.add("POST", "/api/agents/:id/versions", (req) => {
    const agent = ownedAgent(req.user.id, req.params["id"]!);
    const o = asObject(req.body);
    const config = parseAgentConfig(o["config"]);
    const c = new Checker();
    const note = c.string(o["note"], "note", { max: 300, default: "" });
    c.done();

    const next = tx(db, () => {
      const last = q1<{ v: number | null }>(db, "select max(version) as v from agent_versions where agent_id = ? and owner_id = ?", agent.id, req.user.id)?.v ?? 0;
      const version = last + 1;
      exec(
        db,
        "insert into agent_versions (id, agent_id, owner_id, version, config, source, change_note) values (?,?,?,?,?, 'manual', ?)",
        randomUUID(),
        agent.id,
        req.user.id,
        version,
        JSON.stringify(config),
        note || null,
      );
      exec(db, "update agents set current_version = ?, name = ?, description = ?, updated_at = ? where id = ? and owner_id = ?", version, config.name, config.description, nowIso(), agent.id, req.user.id);
      audit(db, req.user.id, "agent.version", "agent", agent.id, { version });
      return version;
    });
    return json({ version: next }, 201);
  });

  router.add("POST", "/api/agents/:id/status", (req) => {
    const agent = ownedAgent(req.user.id, req.params["id"]!);
    const c = new Checker();
    const status = c.oneOf(asObject(req.body)["status"], "status", ["active", "inactive"] as const);
    c.done();
    if (status === "active") {
      const row = q1<{ config: string }>(db, "select config from agent_versions where agent_id = ? and version = ? and owner_id = ?", agent.id, agent.current_version, req.user.id);
      const perm = canExecute(parseAgentConfig(JSON.parse(row!.config)));
      if (!perm.ok) throw new AppError(409, perm.reason);
    }
    exec(db, "update agents set status = ?, updated_at = ? where id = ? and owner_id = ?", status, nowIso(), agent.id, req.user.id);
    audit(db, req.user.id, `agent.${status === "active" ? "activate" : "deactivate"}`, "agent", agent.id);
    return json({ ok: true });
  });

  router.add("DELETE", "/api/agents/:id", (req) => {
    const agent = ownedAgent(req.user.id, req.params["id"]!);
    const used = q1<{ n: number }>(db, "select count(*) as n from workflow_steps where agent_id = ? and owner_id = ?", agent.id, req.user.id)!.n;
    if (used > 0) throw new AppError(409, "El agente se usa en un flujo. Quítalo del flujo antes de eliminarlo.");
    exec(db, "delete from agents where id = ? and owner_id = ?", agent.id, req.user.id);
    audit(db, req.user.id, "agent.delete", "agent", agent.id);
    return json({ ok: true });
  });
}
