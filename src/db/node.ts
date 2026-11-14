import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate, type Db, type Param } from "./index.ts";

/** Adaptador de `node:sqlite` a la interfaz Db. */
export function nodeDb(raw: DatabaseSync): Db & { close(): void } {
  return {
    all: (sql: string, params: Param[]) => raw.prepare(sql).all(...params) as Record<string, unknown>[],
    run: (sql: string, params: Param[]) => Number(raw.prepare(sql).run(...params).changes),
    script: (sql: string) => void raw.exec(sql),
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => raw.close(),
  };
}

export function openDb(path: string): Db & { close(): void } {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  // Compatibilidad: bases creadas con la versión anterior guardaban la versión en PRAGMA user_version.
  const legacy = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (legacy > 0) {
    raw.exec("create table if not exists _meta (key text primary key, value text not null)");
    raw.prepare("insert or ignore into _meta (key, value) values ('schema_version', ?)").run(String(legacy));
  }
  const db = nodeDb(raw);
  migrate(db);
  return db;
}
