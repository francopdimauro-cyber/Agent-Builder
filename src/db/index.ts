import { MIGRATIONS } from "./migrations.ts";

export type Param = null | number | bigint | string | Uint8Array;

/**
 * Interfaz mínima y SÍNCRONA de base de datos. Tiene dos implementaciones:
 *  - db/node.ts: `node:sqlite` (desarrollo local, tests y ejecución en Node).
 *  - db/durable.ts: SQLite de un Durable Object (Cloudflare Workers).
 * Este archivo no importa nada específico de ninguna plataforma.
 */
export interface Db {
  /** Todas las filas de una consulta. */
  all(sql: string, params: Param[]): Record<string, unknown>[];
  /** Ejecuta INSERT/UPDATE/DELETE y devuelve las filas afectadas. */
  run(sql: string, params: Param[]): number;
  /** Ejecuta un script con varias sentencias (sin parámetros). */
  script(sql: string): void;
  /** Transacción síncrona (sin await dentro ni anidamiento). */
  transaction<T>(fn: () => T): T;
}

/** Todas las filas de una consulta. */
export function q<T = Record<string, unknown>>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.all(sql, params) as T[];
}

/** Una fila o undefined. */
export function q1<T = Record<string, unknown>>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.all(sql, params)[0] as T | undefined;
}

/** Ejecuta INSERT/UPDATE/DELETE y devuelve las filas afectadas. */
export function exec(db: Db, sql: string, ...params: Param[]): number {
  return db.run(sql, params);
}

/** Transacción síncrona (no admite await dentro ni anidamiento). */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn);
}

export const nowIso = (): string => new Date().toISOString();

/** Aplica las migraciones pendientes. La versión se guarda en la tabla `_meta` (portable entre motores). */
export function migrate(db: Db): void {
  db.script("create table if not exists _meta (key text primary key, value text not null)");
  const row = q1<{ value: string }>(db, "select value from _meta where key = 'schema_version'");
  for (let v = Number(row?.value ?? 0); v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.script(MIGRATIONS[v]!);
      db.run("insert into _meta (key, value) values ('schema_version', ?) on conflict(key) do update set value = excluded.value", [String(v + 1)]);
    });
  }
}
