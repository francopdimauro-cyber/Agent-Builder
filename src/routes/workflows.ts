import { randomUUID } from "../util/id.ts";
import type { Ctx } from "../context.ts";
import { exec, nowIso, q, q1, tx } from "../db/index.ts";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/types.ts";
import { MAX_WORKFLOW_STEPS } from "../domain/execution-state.ts";
import { asObject, Checker, isRecord, ValidationError } from "../domain/validate.ts";
import { AppError } from "../errors.ts";
import { advanceWorkflowRun, audit, cancelWorkflowRun } from "../engine/engine.ts";
import { json, type Router } from "../http/router.ts";

interface StepInput {
  agentId: string;
  title: string;
  instruction: string;
  requiresApproval: boolean;
}

function parseWorkflow(body: unknown): { name: string; description: string; steps: StepInput[] } {
  const o = asObject(body);
  const c = new Checker();
  const name = c.string(o["name"], "name", { min: 2, max: 80 });
  const description = c.string(o["description"], "description", { max: 500, default: "" });
  const steps: StepInput[] = [];
  if (!Array.isArray(o["steps"]) || o["steps"].length < 1) c.issues.push("steps: añade al menos un paso");
  else if (o["steps"].length > MAX_WORKFLOW_STEPS) c.issues.push(`steps: máximo ${MAX_WORKFLOW_STEPS} pasos`);
  else {
    o["steps"].forEach((s: unknown, i: number) => {
      if (!isRecord(s)) return void c.issues.push(`steps[${i}]: no válido`);
      steps.push({
        agentId: c.uuid(s["agentId"], `steps[${i}].agentId`),
        title: c.string(s["title"], `steps[${i}].title`, { min: 1, max: 120 }),
        instruction: c.string(s["instruction"], `steps[${i}].instruction`, { max: 2000, default: "" }),
        requiresApproval: c.bool(s["requiresApproval"], `steps[${i}].requiresApproval`, false),
      });
    });
  }
  c.done();
  return { name, description, steps };
}

export function registerWorkflowRoutes(router: Router, ctx: Ctx): void {
  const { db } = ctx;

  const ownedWorkflow = (ownerId: string, id: string) => {
    const w = q1<{ id: string; name: string; description: string; status: string; created_at: string; updated_at: string }>(
      db,
      "select id, name, description, status, created_at, updated_at from workflows where id = ? and owner_id = ?",
      id,
      ownerId,
    );
    if (!w) throw new AppError(404, "Flujo no encontrado.");
    return w;
  };

  /** Crea o reemplaza un flujo y sus pasos, comprobando que todos los agentes son del usuario. */
  const save = (ownerId: string, existingId: string | null, data: ReturnType<typeof parseWorkflow>): string => {
    for (const s of data.steps) {
      if (!q1(db, "select 1 as x from agents where id = ? and owner_id = ?", s.agentId, ownerId)) throw new ValidationError([`El agente ${s.agentId} no existe.`]);
    }
    return tx(db, () => {
      let id = existingId;
      if (id) {
        const active = q1(db, "select 1 as x from workflow_runs where workflow_id = ? and owner_id = ? and status in ('queued','running','awaiting_approval')", id, ownerId);
        if (active) throw new AppError(409, "No se puede editar un flujo con ejecuciones en curso.");
        exec(db, "update workflows set name = ?, description = ?, updated_at = ? where id = ? and owner_id = ?", data.name, data.description, nowIso(), id, ownerId);
        exec(db, "delete from workflow_steps where workflow_id = ? and owner_id = ?", id, ownerId);
      } else {
        id = randomUUID();
        exec(db, "insert into workflows (id, owner_id, name, description, status) values (?,?,?,?, 'active')", id, ownerId, data.name, data.description);
      }
      data.steps.forEach((s, i) =>
        exec(
          db,
          "insert into workflow_steps (id, workflow_id, owner_id, position, agent_id, title, instruction, requires_approval) values (?,?,?,?,?,?,?,?)",
          randomUUID(),
          id!,
          ownerId,
          i,
          s.agentId,
          s.title,
          s.instruction,
          s.requiresApproval ? 1 : 0,
        ),
      );
      audit(db, ownerId, existingId ? "workflow.update" : "workflow.create", "workflow", id);
      return id;
    });
  };

  router.add("GET", "/api/workflows", (req) =>
    json({
      workflows: q(
        db,
        `select w.id, w.name, w.description, w.status, w.created_at, w.updated_at,
                (select count(*) from workflow_steps s where s.workflow_id = w.id) as step_count
           from workflows w where w.owner_id = ? order by w.updated_at desc`,
        req.user.id,
      ),
    }),
  );

  router.add("POST", "/api/workflows", (req) => json({ id: save(req.user.id, null, parseWorkflow(req.body)) }, 201));

  router.add("GET", "/api/workflows/:id", (req) => {
    const workflow = ownedWorkflow(req.user.id, req.params["id"]!);
    const steps = q<WorkflowStepRow>(db, "select * from workflow_steps where workflow_id = ? and owner_id = ? order by position", workflow.id, req.user.id).map((s) => ({
      ...s,
      requires_approval: s.requires_approval === 1,
    }));
    return json({ workflow, steps });
  });

  router.add("PUT", "/api/workflows/:id", (req) => {
    const workflow = ownedWorkflow(req.user.id, req.params["id"]!);
    return json({ id: save(req.user.id, workflow.id, parseWorkflow(req.body)) });
  });

  router.add("DELETE", "/api/workflows/:id", (req) => {
    const workflow = ownedWorkflow(req.user.id, req.params["id"]!);
    exec(db, "delete from workflows where id = ? and owner_id = ?", workflow.id, req.user.id);
    audit(db, req.user.id, "workflow.delete", "workflow", workflow.id);
    return json({ ok: true });
  });

  router.add("GET", "/api/workflows/:id/runs", (req) => {
    const workflow = ownedWorkflow(req.user.id, req.params["id"]!);
    return json({ runs: q<WorkflowRunRow>(db, "select * from workflow_runs where workflow_id = ? and owner_id = ? order by created_at desc, rowid desc limit 50", workflow.id, req.user.id) });
  });

  router.add("POST", "/api/workflows/:id/runs", async (req) => {
    const workflow = ownedWorkflow(req.user.id, req.params["id"]!);
    const c = new Checker();
    const input = c.string(asObject(req.body)["input"], "input", { min: 1, max: 8000 });
    c.done();
    const runId = randomUUID();
    exec(db, "insert into workflow_runs (id, workflow_id, owner_id, input, status) values (?,?,?,?, 'queued')", runId, workflow.id, req.user.id, input);
    audit(db, req.user.id, "workflow.run", "workflow_run", runId);
    const status = await advanceWorkflowRun(ctx, req.user.id, runId);
    return json({ id: runId, status }, 201);
  });

  router.add("GET", "/api/workflow-runs/:id", (req) => {
    const run = q1<WorkflowRunRow>(db, "select * from workflow_runs where id = ? and owner_id = ?", req.params["id"]!, req.user.id);
    if (!run) throw new AppError(404, "Ejecución de flujo no encontrada.");
    const executions = q(db, "select id, agent_id, agent_version, workflow_step_id, status, input, output, error, model, started_at, finished_at from executions where workflow_run_id = ? and owner_id = ? order by rowid", run.id, req.user.id);
    const events = q(db, "select id, type, message, created_at from execution_events where workflow_run_id = ? and owner_id = ? and execution_id is null order by created_at, rowid", run.id, req.user.id);
    return json({ run, executions, events });
  });

  router.add("POST", "/api/workflow-runs/:id/continue", async (req) => {
    const run = q1<{ status: string }>(db, "select status from workflow_runs where id = ? and owner_id = ?", req.params["id"]!, req.user.id);
    if (!run) throw new AppError(404, "Ejecución de flujo no encontrada.");
    if (run.status !== "running") throw new AppError(409, "El flujo no está en estado de ejecución.");
    return json({ status: await advanceWorkflowRun(ctx, req.user.id, req.params["id"]!) });
  });

  router.add("POST", "/api/workflow-runs/:id/cancel", (req) => {
    cancelWorkflowRun(db, req.user.id, req.params["id"]!);
    return json({ ok: true });
  });
}
