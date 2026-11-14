import type { Ctx } from "../context.ts";
import { q, q1 } from "../db/index.ts";
import { TOOL_CATALOG } from "../domain/agent-config.ts";
import { MAX_ACTIVE_EXECUTIONS, MAX_WORKFLOW_STEPS } from "../domain/execution-state.ts";
import { json, type Router } from "../http/router.ts";

export function registerSystemRoutes(router: Router, ctx: Ctx): void {
  const { db, ai, config } = ctx;

  router.addPublic("GET", "/api/health", () => json({ ok: true }));

  router.add("GET", "/api/system/status", () =>
    json({
      aiConfigured: ai.isConfigured(),
      models: ai.models(),
      tools: TOOL_CATALOG,
      limits: { maxActiveExecutions: MAX_ACTIVE_EXECUTIONS, maxWorkflowSteps: MAX_WORKFLOW_STEPS },
      registrationOpen: config.allowRegistration,
    }),
  );

  router.add("GET", "/api/supervisor", (req) => {
    const byStatus = q<{ status: string; n: number }>(db, "select status, count(*) as n from executions where owner_id = ? group by status", req.user.id);
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
    const pending = q1<{ n: number }>(db, "select count(*) as n from approvals where owner_id = ? and status = 'pending'", req.user.id)!.n;
    const recentFailures = q(
      db,
      "select id, agent_id, error, finished_at from executions where owner_id = ? and status = 'failed' order by finished_at desc limit 10",
      req.user.id,
    );
    const modelUsage = q(
      db,
      "select model, count(*) as n from executions where owner_id = ? and status = 'completed' and model is not null group by model order by n desc",
      req.user.id,
    );
    return json({
      active: (counts["queued"] ?? 0) + (counts["running"] ?? 0),
      maxActive: MAX_ACTIVE_EXECUTIONS,
      counts,
      pendingApprovals: pending,
      recentFailures,
      modelUsage,
    });
  });

  router.add("GET", "/api/audit", (req) => {
    const limit = Math.min(200, Math.max(1, Number(req.url.searchParams.get("limit")) || 50));
    const rows = q(db, `select id, action, entity_type, entity_id, details, created_at from audit_logs where owner_id = ? order by created_at desc, rowid desc limit ${limit}`, req.user.id).map(
      (r) => ({ ...r, details: typeof r["details"] === "string" ? (JSON.parse(r["details"]) as unknown) : null }),
    );
    return json({ logs: rows });
  });
}
