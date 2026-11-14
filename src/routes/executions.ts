import type { Ctx } from "../context.ts";
import { exec, q, q1 } from "../db/index.ts";
import type { ApprovalRow, ExecutionRow } from "../db/types.ts";
import { EXECUTION_STATUSES } from "../domain/execution-state.ts";
import { asObject, Checker } from "../domain/validate.ts";
import { AppError } from "../errors.ts";
import { audit, cancelExecution, createExecution, decideApprovalRow, runExecution } from "../engine/engine.ts";
import { json, type Router } from "../http/router.ts";

export function registerExecutionRoutes(router: Router, ctx: Ctx): void {
  const { db } = ctx;

  router.add("GET", "/api/executions", (req) => {
    const conds = ["owner_id = ?"];
    const params: (string | number)[] = [req.user.id];
    const agentId = req.url.searchParams.get("agentId");
    const status = req.url.searchParams.get("status");
    if (agentId) {
      conds.push("agent_id = ?");
      params.push(agentId);
    }
    if (status) {
      if (!(EXECUTION_STATUSES as readonly string[]).includes(status)) throw new AppError(400, "Estado no válido.");
      conds.push("status = ?");
      params.push(status);
    }
    const limit = Math.min(200, Math.max(1, Number(req.url.searchParams.get("limit")) || 50));
    const rows = q<ExecutionRow>(db, `select * from executions where ${conds.join(" and ")} order by created_at desc, rowid desc limit ${limit}`, ...params);
    return json({ executions: rows });
  });

  router.add("GET", "/api/executions/:id", (req) => {
    const execution = q1<ExecutionRow>(db, "select * from executions where id = ? and owner_id = ?", req.params["id"]!, req.user.id);
    if (!execution) throw new AppError(404, "Ejecución no encontrada.");
    const events = q(db, "select id, type, message, data, created_at from execution_events where execution_id = ? and owner_id = ? order by created_at, rowid", execution.id, req.user.id).map(
      (e) => ({ ...e, data: typeof e["data"] === "string" ? (JSON.parse(e["data"]) as unknown) : null }),
    );
    return json({ execution, events });
  });

  router.add("POST", "/api/executions", async (req) => {
    const o = asObject(req.body);
    const c = new Checker();
    const agentId = c.uuid(o["agentId"], "agentId");
    const input = c.string(o["input"], "input", { min: 1, max: 8000 });
    c.done();
    const id = createExecution(ctx, req.user.id, { agentId, input });
    const status = await runExecution(ctx, req.user.id, id);
    return json({ id, status }, 201);
  });

  router.add("POST", "/api/executions/:id/cancel", (req) => {
    cancelExecution(db, req.user.id, req.params["id"]!);
    return json({ ok: true });
  });

  router.add("POST", "/api/executions/:id/retry", async (req) => {
    const ex = q1<ExecutionRow>(db, "select * from executions where id = ? and owner_id = ?", req.params["id"]!, req.user.id);
    if (!ex) throw new AppError(404, "Ejecución no encontrada.");
    if (ex.status !== "failed" && ex.status !== "cancelled") throw new AppError(409, "Solo se pueden reintentar ejecuciones fallidas o canceladas.");
    if (ex.workflow_run_id) throw new AppError(409, "Reintenta el flujo completo desde Flujos.");
    const id = createExecution(ctx, req.user.id, { agentId: ex.agent_id, input: ex.input, attempt: ex.attempt + 1 });
    const status = await runExecution(ctx, req.user.id, id);
    return json({ id, status }, 201);
  });

  // ---- Aprobaciones ----
  router.add("GET", "/api/approvals", (req) => {
    const status = req.url.searchParams.get("status");
    const rows = status
      ? q<ApprovalRow>(db, "select * from approvals where owner_id = ? and status = ? order by created_at desc, rowid desc limit 100", req.user.id, status)
      : q<ApprovalRow>(db, "select * from approvals where owner_id = ? order by created_at desc, rowid desc limit 100", req.user.id);
    return json({ approvals: rows });
  });

  router.add("POST", "/api/approvals/:id/decision", async (req) => {
    const c = new Checker();
    const approve = c.bool(asObject(req.body)["approve"], "approve", false);
    c.done();
    const ap = q1<ApprovalRow>(db, "select * from approvals where id = ? and owner_id = ?", req.params["id"]!, req.user.id);
    if (!ap || ap.status !== "pending") throw new AppError(404, "Aprobación no disponible.");
    return json(await decideApprovalRow(ctx, req.user.id, ap, approve));
  });
}

// Exportado para el supervisor
export { audit, exec };
