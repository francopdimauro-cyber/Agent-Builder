import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type Db = DatabaseSync;
export type Param = null | number | bigint | string | Uint8Array;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** Todas las filas de una consulta. */
export function q<T = Record<string, unknown>>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Una fila o undefined. */
export function q1<T = Record<string, unknown>>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/** Ejecuta INSERT/UPDATE/DELETE y devuelve las filas afectadas. */
export function exec(db: Db, sql: string, ...params: Param[]): number {
  return Number(db.prepare(sql).run(...params).changes);
}

/** Transacción síncrona (no admite await dentro ni anidamiento). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const nowIso = (): string => new Date().toISOString();
