import { hashPassword } from "../auth/password.ts";
import { fromBase64, safeEqual } from "../util/bytes.ts";
import type { Ctx } from "../context.ts";
import { exec, q1, tx } from "../db/index.ts";
import type { UserRow } from "../db/types.ts";
import { AppError } from "../errors.ts";
import { asObject, ValidationError } from "../domain/validate.ts";
import { clearCookie } from "../auth/session.ts";
import { audit } from "../engine/engine.ts";
import { json, type Router } from "../http/router.ts";

/**
 * Restablecimiento administrativo de una sola vez.
 *
 * Este endpoint NO genera tokens, ni los envía por email, ni permite enumerar usuarios.
 * Solo el administrador con acceso a Cloudflare puede depositar manualmente en _meta
 * una huella de 256 bits, asociada a un dueño y a una caducidad.
 * Al consumirla, se revocan todas las sesiones y se borra el permiso en una transacción.
 * No se modifica ni elimina ningún agente, chat, ejecución o flujo.
 */
export const RECOVERY_META_KEY = "admin_account_recovery_once";

interface RecoveryRecord {
  ownerId: string;
  tokenDigestBase64: string;
  expiresAt: string;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function registerRecoveryRoutes(router: Router, ctx: Ctx): void {
  const { db, config } = ctx;

  router.addPublic("POST", "/api/auth/recover", async (req) => {
    const o = asObject(req.body);
    const token = typeof o["token"] === "string" ? o["token"] : "";
    const password = typeof o["password"] === "string" ? o["password"] : "";
    const emailRaw = o["email"];
    const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";

    if (!/^[A-Za-z0-9_-]{40,96}$/.test(token)) {
      throw new AppError(403, "Enlace de recuperación inválido o caducado.");
    }
    if (password.length < 12 || password.length > 200) {
      throw new ValidationError(["La nueva contraseña debe tener entre 12 y 200 caracteres."]);
    }
    if (emailRaw !== undefined && (typeof emailRaw !== "string" || (email !== "" && (!EMAIL_RE.test(email) || email.length > 254)))) {
      throw new ValidationError(["El correo electrónico indicado no es válido."]);
    }

    const row = q1<{ value: string }>(db, "select value from _meta where key = ?", RECOVERY_META_KEY);
    if (!row) throw new AppError(403, "Enlace de recuperación inválido o caducado.");

    let record: RecoveryRecord;
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (
        typeof parsed !== "object" || parsed === null ||
        !("ownerId" in parsed) || !("tokenDigestBase64" in parsed) || !("expiresAt" in parsed) ||
        typeof parsed.ownerId !== "string" || typeof parsed.tokenDigestBase64 !== "string" || typeof parsed.expiresAt !== "string"
      ) throw new Error("Registro incompleto");
      record = parsed as RecoveryRecord;
    } catch {
      throw new AppError(403, "Enlace de recuperación inválido o caducado.");
    }
    if (!(new Date(record.expiresAt).getTime() > Date.now())) {
      throw new AppError(403, "Enlace de recuperación inválido o caducado.");
    }

    let expected: Uint8Array;
    try {
      expected = fromBase64(record.tokenDigestBase64);
    } catch {
      throw new AppError(403, "Enlace de recuperación inválido o caducado.");
    }
    const received = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    if (expected.length !== 32 || !safeEqual(received, expected)) {
      throw new AppError(403, "Enlace de recuperación inválido o caducado.");
    }

    const user = q1<Pick<UserRow, "id" | "email">>(db, "select id,email from users where id = ?", record.ownerId);
    if (!user) throw new AppError(403, "Enlace de recuperación inválido o caducado.");
    const nextEmail = email || user.email;
    const passwordHash = await hashPassword(password);

    tx(db, () => {
      const consumed = exec(db, "delete from _meta where key = ? and value = ?", RECOVERY_META_KEY, row.value);
      if (consumed !== 1) throw new AppError(409, "El enlace ya se ha utilizado.");
      const changed = exec(db, "update users set password_hash = ?, email = ? where id = ?", passwordHash, nextEmail, user.id);
      if (changed !== 1) throw new AppError(409, "No se ha podido actualizar la cuenta.");
      exec(db, "delete from sessions where user_id = ?", user.id);
      audit(db, user.id, "user.recovery_reset", "user", user.id, { email_changed: nextEmail !== user.email });
    });
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(config.cookieSecure) });
  });
}
