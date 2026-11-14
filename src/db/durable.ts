import type { Db, Param } from "./index.ts";
import { splitStatements } from "./split.ts";

/** Subconjunto de la API de almacenamiento SQLite de un Durable Object que usamos aquí. */
export interface SqlCursorLike {
  toArray(): Record<string, unknown>[];
}
export interface DurableStorageLike {
  sql: { exec(query: string, ...bindings: unknown[]): SqlCursorLike };
  transactionSync<T>(fn: () => T): T;
}

/** Adaptador del SQLite de un Durable Object (síncrono) a la interfaz Db. */
export function durableDb(storage: DurableStorageLike): Db {
  const exec = (sql: string, params: Param[] = []) => storage.sql.exec(sql, ...params).toArray();
  return {
    all: (sql, params) => exec(sql, params),
    run(sql, params) {
      exec(sql, params);
      // `rowsWritten` cuenta también escrituras de índices; `changes()` da las filas realmente afectadas.
      return Number(exec("select changes() as c")[0]!["c"]);
    },
    script(sql) {
      for (const stmt of splitStatements(sql)) exec(stmt);
    },
    transaction: (fn) => storage.transactionSync(fn),
  };
}
