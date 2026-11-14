import { fromBase64, randomBytes, safeEqual, toBase64 } from "../util/bytes.ts";

// PBKDF2-SHA256 con Web Crypto: funciona igual en Node y en Cloudflare Workers (que no ofrece scrypt nativo).
// 100 000 es el máximo de iteraciones que admite Workers. Los parámetros se guardan en el propio hash.
const ITERATIONS = 100_000;
const KEY_BITS = 256;

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt, iterations }, key, KEY_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) return false;
  const actual = await derive(password, fromBase64(parts[3]!), iterations);
  return safeEqual(fromBase64(parts[4]!), actual);
}

/** Hash de relleno para igualar el tiempo de respuesta cuando el correo no existe. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword("relleno-no-valido"));
}
