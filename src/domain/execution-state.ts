export const EXECUTION_STATUSES = [
  "draft",
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

const TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  draft: ["queued", "cancelled"],
  queued: ["running", "awaiting_approval", "cancelled"],
  awaiting_approval: ["queued", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transición no permitida: ${from} → ${to}`);
  }
}

export function isTerminal(s: ExecutionStatus): boolean {
  return TRANSITIONS[s].length === 0;
}

export const STATUS_LABEL: Record<ExecutionStatus, string> = {
  draft: "Borrador",
  queued: "En cola",
  running: "Ejecutando",
  awaiting_approval: "Esperando aprobación",
  completed: "Completada",
  failed: "Fallida",
  cancelled: "Cancelada",
};

/** Máximo de ejecuciones activas simultáneas por usuario (límite del supervisor). */
export const MAX_ACTIVE_EXECUTIONS = 5;
/** Máximo de pasos en un flujo. */
export const MAX_WORKFLOW_STEPS = 10;
