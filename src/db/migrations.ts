/**
 * Migraciones versionadas (versión guardada en la tabla _meta). Añade nuevas entradas al final; no edites las existentes.
 * Sustituye a las políticas RLS de Postgres: aquí TODA consulta debe filtrar por owner_id (ver engine y routes).
 */
const TS = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export const MIGRATIONS: string[] = [
  /* 1 — esquema inicial */ `
create table users (
  id text primary key,
  email text not null unique collate nocase,
  password_hash text not null,
  display_name text not null,
  language text not null default 'es' check (language in ('es','en')),
  created_at text not null default (${TS})
);

create table sessions (
  id text primary key,               -- sha256 del token (el token en claro solo vive en la cookie)
  user_id text not null references users(id) on delete cascade,
  expires_at text not null,
  created_at text not null default (${TS})
);
create index sessions_user_idx on sessions(user_id);

create table agents (
  id text primary key,
  owner_id text not null references users(id) on delete cascade,
  name text not null check (length(name) between 2 and 80),
  description text not null default '',
  status text not null default 'draft' check (status in ('draft','active','inactive')),
  current_version integer not null default 1,
  created_at text not null default (${TS}),
  updated_at text not null default (${TS})
);
create index agents_owner_idx on agents(owner_id, updated_at desc);

create table agent_versions (
  id text primary key,
  agent_id text not null references agents(id) on delete cascade,
  owner_id text not null,
  version integer not null,
  config text not null check (json_valid(config)),
  source text not null default 'manual' check (source in ('manual','ai')),
  change_note text,
  created_at text not null default (${TS}),
  unique (agent_id, version)
);
-- Versiones inmutables: una edición inserta una versión nueva, nunca modifica la anterior.
create trigger agent_versions_immutable before update on agent_versions
begin select raise(abort, 'agent_versions es inmutable'); end;

create table workflows (
  id text primary key,
  owner_id text not null references users(id) on delete cascade,
  name text not null check (length(name) between 2 and 80),
  description text not null default '',
  status text not null default 'draft' check (status in ('draft','active','archived')),
  created_at text not null default (${TS}),
  updated_at text not null default (${TS})
);
create index workflows_owner_idx on workflows(owner_id, updated_at desc);

create table workflow_steps (
  id text primary key,
  workflow_id text not null references workflows(id) on delete cascade,
  owner_id text not null,
  position integer not null,
  agent_id text not null references agents(id) on delete restrict,
  title text not null,
  instruction text not null default '',
  requires_approval integer not null default 0 check (requires_approval in (0,1)),
  created_at text not null default (${TS}),
  unique (workflow_id, position)
);

create table workflow_runs (
  id text primary key,
  workflow_id text not null references workflows(id) on delete cascade,
  owner_id text not null,
  status text not null default 'queued' check (status in ('queued','running','awaiting_approval','completed','failed','cancelled')),
  input text not null default '',
  current_position integer not null default 0,
  error text,
  started_at text,
  finished_at text,
  created_at text not null default (${TS})
);
create index workflow_runs_idx on workflow_runs(owner_id, created_at desc);

create table executions (
  id text primary key,
  owner_id text not null,
  agent_id text not null references agents(id) on delete cascade,
  agent_version integer not null,
  workflow_run_id text references workflow_runs(id) on delete cascade,
  workflow_step_id text references workflow_steps(id) on delete set null,
  status text not null default 'queued' check (status in ('draft','queued','running','awaiting_approval','completed','failed','cancelled')),
  input text not null,
  output text,
  error text,
  model text,
  attempt integer not null default 1,
  started_at text,
  finished_at text,
  created_at text not null default (${TS})
);
create index executions_owner_idx on executions(owner_id, created_at desc);
create index executions_agent_idx on executions(agent_id, created_at desc);
create index executions_run_idx on executions(workflow_run_id);

create table execution_events (
  id text primary key,
  owner_id text not null,
  execution_id text references executions(id) on delete cascade,
  workflow_run_id text references workflow_runs(id) on delete cascade,
  type text not null,
  message text not null,
  data text check (data is null or json_valid(data)),
  created_at text not null default (${TS})
);
create index exec_events_idx on execution_events(execution_id, created_at);
create index run_events_idx on execution_events(workflow_run_id, created_at);

create table approvals (
  id text primary key,
  owner_id text not null,
  execution_id text references executions(id) on delete cascade,
  workflow_run_id text references workflow_runs(id) on delete cascade,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_at text,
  created_at text not null default (${TS})
);
create index approvals_owner_idx on approvals(owner_id, status, created_at desc);

create table audit_logs (
  id text primary key,
  owner_id text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details text check (details is null or json_valid(details)),
  created_at text not null default (${TS})
);
create index audit_owner_idx on audit_logs(owner_id, created_at desc);
`,
];
