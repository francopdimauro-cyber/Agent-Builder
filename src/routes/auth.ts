import { randomUUID } from "node:crypto";
import { dummyHash, hashPassword, verifyPassword } from "../auth/password.ts";
import { clearCookie, COOKIE_NAME, createSession, deleteSession, LoginLimiter, parseCookies, sessionCookie } from "../auth/session.ts";
import type { Ctx } from "../context.ts";
import { exec, q1 } from "../db/index.ts";
import type { UserRow } from "../db/types.ts";
import { asObject, Checker, ValidationError } from "../domain/validate.ts";
import { AppError } from "../errors.ts";
import { json, type Router } from "../http/router.ts";
import { audit } from "../engine/engine.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const publicUser = (u: Omit<UserRow, "password_hash">) => ({ id: u.id, email: u.email, display_name: u.display_name, language: u.language });

export function registerAuthRoutes(router: Router, ctx: Ctx): void {
  const { db, config } = ctx;
  const limiter = new LoginLimiter();

  router.addPublic("POST", "/api/auth/register", async (req) => {
    if (!config.allowRegistration) throw new AppError(403, "El registro está desactivado.");
    const o = asObject(req.body);
    const c = new Checker();
    const email = c.string(o["email"], "email", { min: 5, max: 254 }).toLowerCase();
    if (email && !EMAIL_RE.test(email)) c.issues.push("email: formato no válido");
    const password = typeof o["password"] === "string" ? o["password"] : "";
    if (password.length < 10) c.issues.push("password: mínimo 10 caracteres");
    if (password.length > 200) c.issues.push("password: máximo 200 caracteres");
    const displayName = c.string(o["displayName"], "displayName", { max: 80, default: "" }) || email.split("@")[0]!;
    c.done();

    if (q1(db, "select 1 as x from users where email = ?", email)) throw new AppError(409, "Ya existe una cuenta con ese correo.");
    const id = randomUUID();
    exec(db, "insert into users (id, email, password_hash, display_name) values (?,?,?,?)", id, email, await hashPassword(password), displayName);
    audit(db, id, "user.register", "user", id);
    const { token, expiresAt } = createSession(db, id, config.sessionTtlDays);
    const user = q1<Omit<UserRow, "password_hash">>(db, "select id, email, display_name, language, created_at from users where id = ?", id)!;
    return json({ user: publicUser(user) }, 201, { "Set-Cookie": sessionCookie(token, expiresAt, config.cookieSecure) });
  });

  router.addPublic("POST", "/api/auth/login", async (req) => {
    const o = asObject(req.body);
    const email = typeof o["email"] === "string" ? o["email"].trim().toLowerCase() : "";
    const password = typeof o["password"] === "string" ? o["password"] : "";
    if (!email || !password || password.length > 200) throw new ValidationError(["Correo y contraseña obligatorios"]);

    const key = `${req.ip}|${email}`;
    if (limiter.blocked(key)) throw new AppError(429, "Demasiados intentos fallidos. Espera unos minutos.");

    const row = q1<UserRow>(db, "select * from users where email = ?", email);
    // Siempre se calcula un hash para que el tiempo no revele si el correo existe.
    const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
    if (!row || !ok) {
      limiter.fail(key);
      throw new AppError(401, "Credenciales no válidas.");
    }
    limiter.reset(key);
    audit(db, row.id, "user.login", "user", row.id);
    const { token, expiresAt } = createSession(db, row.id, config.sessionTtlDays);
    return json({ user: publicUser(row) }, 200, { "Set-Cookie": sessionCookie(token, expiresAt, config.cookieSecure) });
  });

  router.addPublic("POST", "/api/auth/logout", (req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) deleteSession(db, token);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(config.cookieSecure) });
  });

  router.add("GET", "/api/auth/me", (req) => json({ user: publicUser(req.user) }));

  router.add("PATCH", "/api/auth/profile", (req) => {
    const o = asObject(req.body);
    const c = new Checker();
    const displayName = c.string(o["displayName"], "displayName", { min: 1, max: 80, default: req.user.display_name });
    const language = c.oneOf(o["language"], "language", ["es", "en"] as const, req.user.language as "es" | "en");
    c.done();
    exec(db, "update users set display_name = ?, language = ? where id = ?", displayName, language, req.user.id);
    return json({ user: publicUser({ ...req.user, display_name: displayName, language }) });
  });
}
