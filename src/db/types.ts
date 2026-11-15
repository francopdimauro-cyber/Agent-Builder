export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  language: string;
  created_at: string;
}

export interface AgentRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  status: "draft" | "active" | "inactive";
  current_version: number;
  created_at: string;
  updated_at: string;
}

export interface ExecutionRow {
  id: string;
  owner_id: string;
  agent_id: string;
  agent_version: number;
  workflow_run_id: string | null;
  workflow_step_id: string | null;
  status: string;
  input: string;
  output: string | null;
  error: string | null;
  model: string | null;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface WorkflowStepRow {
  id: string;
  workflow_id: string;
  owner_id: string;
  position: number;
  agent_id: string;
  title: string;
  instruction: string;
  requires_approval: number;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  owner_id: string;
  status: string;
  input: string;
  current_position: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface PublicChatRow {
  id: string;
  owner_id: string;
  agent_id: string;
  title: string;
  greeting: string;
  /** JSON: string[] */
  suggestions: string;
  privacy_notice: string;
  /** JSON: string[] de orígenes (https://dominio.es) */
  allowed_origins: string;
  enabled: number;
  per_visitor_limit: number;
  daily_limit: number;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRow {
  id: string;
  owner_id: string;
  execution_id: string | null;
  workflow_run_id: string | null;
  reason: string;
  status: "pending" | "approved" | "rejected";
  decided_at: string | null;
  created_at: string;
}
