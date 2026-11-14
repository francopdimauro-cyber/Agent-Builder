import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { providerFromConfig } from "../src/ai/provider.ts";
import { hashPassword, verifyPassword } from "../src/auth/password.ts";
import { loadConfig } from "../src/config.ts";
import { durableDb, type DurableStorageLike } from "../src/db/durable.ts";
import { exec, migrate, q, q1, tx } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { splitStatements } from "../src/db/split.ts";
import { createHandler } from "../src/http/app.ts";

/** Imita el almacenamiento SQLite de un Durable Object: UNA sentencia por llamada y transacciones con transactionSync. */
function fakeStorage(): DurableStorageLike & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  return {
    raw,
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const stmt = raw.prepare(query); // node:sqlite rechaza varias sentencias a la vez: comprueba que el adaptador las divide
        const isRead = /^\s*(select|with|pragma)/i.test(query);
        const rows = isRead ? stmt.all(...(bindings as never[])) : (stmt.run(...(bindings as never[])), []);
        return { toArray: () => rows as Record<string, unknown>[] };
      },
    },
    transactionSync<T>(fn: () => T): T {
      raw.exec("BEGIN");
      try {
        const r = fn();
        raw.exec("COMMIT");
        return r;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

test("splitStatements: separa sentencias, conserva el trigger entero y quita comentarios", () => {
  const stmts = splitStatements(MIGRATIONS.join("\n"));
  assert.ok(stmts.length > 10);
  const trigger = stmts.filter((s) => /^create trigger/i.test(s));
  assert.equal(trigger.length, 1);
  assert.match(trigger[0]!, /raise\(abort, 'agent_versions es inmutable'\);\s*end;$/);
  assert.ok(stmts.every((s) => !s.includes("--")), "sin comentarios");
  assert.ok(stmts.every((s) => s.endsWith(";")));
  assert.deepEqual(splitStatements("select 1; -- nada\nselect ';--no es comentario';"), ["select 1;", "select ';--no es comentario';"]);
});

test("durableDb: migraciones, changes(), transacciones y trigger", () => {
  const st = fakeStorage();
  const db = durableDb(st);
  migrate(db);
  migrate(db); // idempotente
  assert.equal(q1<{ value: string }>(db, "select value from _meta where key='schema_version'")!.value, String(MIGRATIONS.length));

  const names = q<{ name: string }>(db, "select name from sqlite_master where type in ('table','trigger') order by name").map((r) => r.name);
  assert.ok(names.includes("agent_versions_immutable") && names.includes("users") && names.includes("executions"));

  exec(db, "insert into users (id,email,password_hash,display_name) values ('u1','a@x.com','h','A')");
  assert.equal(exec(db, "update users set display_name='B' where id='u1'"), 1);
  assert.equal(exec(db, "update users set display_name='C' where id='nope'"), 0);

  assert.throws(() =>
    tx(db, () => {
      exec(db, "update users set display_name='ROLLBACK' where id='u1'");
      throw new Error("boom");
    }),
  );
  assert.equal(q1<{ display_name: string }>(db, "select display_name from users where id='u1'")!.display_name, "B");

  exec(db, "insert into agents (id,owner_id,name) values ('a1','u1','Agente')");
  exec(db, "insert into agent_versions (id,agent_id,owner_id,version,config,source) values ('v1','a1','u1',1,'{}','manual')");
  assert.throws(() => exec(db, "update agent_versions set config='{}' where id='v1'"), /inmutable/);
  assert.throws(() => exec(db, "insert into agents (id,owner_id,name) values ('a2','no-existe','Fantasma')"), /FOREIGN KEY/i);
});

test("contraseñas: PBKDF2 con Web Crypto", async () => {
  const h = await hashPassword("una-clave-larga-123");
  assert.match(h, /^pbkdf2\$sha256\$100000\$/);
  assert.equal(await verifyPassword("una-clave-larga-123", h), true);
  assert.equal(await verifyPassword("otra", h), false);
  assert.equal(await verifyPassword("x", "scrypt$1$2$3$a$b"), false, "formato antiguo/ajeno rechazado");
});

test("handler Request/Response sobre el almacenamiento tipo Durable Object: registro, sesión y logout", async () => {
  const db = durableDb(fakeStorage());
  migrate(db);
  const config = loadConfig({ NVIDIA_API_KEY: "k", COOKIE_SECURE: "true" });
  const handle = createHandler({ db, ai: providerFromConfig(config), config });
  const call = (method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) =>
    handle(
      new Request(`https://app.example.com${path}`, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );

  assert.equal((await call("GET", "/api/health")).status, 200);
  assert.equal((await call("GET", "/api/auth/me")).status, 401);
  assert.equal((await call("GET", "/")).status, 404);

  const reg = await call("POST", "/api/auth/register", { email: "w@x.com", password: "contraseña-larga-1" });
  assert.equal(reg.status, 201);
  const setCookie = reg.headers.getSetCookie()[0]!;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(";")[0]!;

  const me = await call("GET", "/api/auth/me", undefined, cookie);
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as any).user.email, "w@x.com");

  assert.equal((await call("POST", "/api/auth/login", { email: "w@x.com", password: "mala" })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { email: "w@x.com", password: "contraseña-larga-1" })).status, 200);

  const csrf = await call("POST", "/api/auth/logout", {}, cookie, { origin: "https://evil.example" });
  assert.equal(csrf.status, 403);

  assert.equal((await call("POST", "/api/auth/logout", {}, cookie)).status, 200);
  assert.equal((await call("GET", "/api/auth/me", undefined, cookie)).status, 401, "la sesión ya no vale");

  const big = await call("POST", "/api/auth/login", { email: "x@x.com", password: "y".repeat(300_000) });
  assert.equal(big.status, 413);
});
