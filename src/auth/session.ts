import { createHash, randomBytes } from "node:crypto";
import { exec, nowIso, q1, type Db } from "../db/index.ts";
import type { UserRow } from "../db/types.ts";

export const COOKIE_NAME = "af_session";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Crea una sesión y devuelve el token en claro (solo se guarda su hash). */
export function createSession(db: Db, userId: string, ttlDays: number): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  exec(db, "insert into sessions (id, user_id, expires_at) values (?,?,?)", sha256(token), userId, expiresAt.toISOString());
  exec(db, "delete from sessions where expires_at < ?", nowIso()); // limpieza oportunista
  return { token, expiresAt };
}

export function getUserBySession(db: Db, token: string): Omit<UserRow, "password_hash"> | undefined {
  return q1(
    db,
    `select u.id, u.email, u.display_name, u.language, u.created_at
       from sessions s join users u on u.id = s.user_id
      where s.id = ? and s.expires_at > ?`,
    sha256(token),
    nowIso(),
  );
}

export function deleteSession(db: Db, token: string): void {
  exec(db, "delete from sessions where id = ?", sha256(token));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/** Limitador en memoria de intentos de login fallidos (por IP + correo). */
export class LoginLimiter {
  private fails = new Map<string, { count: number; first: number }>();
  max: number;
  windowMs: number;
  constructor(max = 5, windowMs = 15 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  blocked(key: string): boolean {
    const e = this.fails.get(key);
    if (!e) return false;
    if (Date.now() - e.first > this.windowMs) {
      this.fails.delete(key);
      return false;
    }
    return e.count >= this.max;
  }
  fail(key: string): void {
    const e = this.fails.get(key);
    if (!e || Date.now() - e.first > this.windowMs) this.fails.set(key, { count: 1, first: Date.now() });
    else e.count++;
  }
  reset(key: string): void {
    this.fails.delete(key);
  }
}
