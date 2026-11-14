/** Validación de entrada sin dependencias (sustituye a zod). Acumula todos los fallos. */
export class ValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class Checker {
  issues: string[] = [];

  string(v: unknown, field: string, o: { min?: number; max: number; default?: string }): string {
    if ((v === undefined || v === null) && o.default !== undefined) return o.default;
    if (typeof v !== "string") {
      this.issues.push(`${field}: debe ser texto`);
      return "";
    }
    const s = v.trim();
    if (o.min !== undefined && s.length < o.min) this.issues.push(`${field}: mínimo ${o.min} caracteres`);
    if (s.length > o.max) this.issues.push(`${field}: máximo ${o.max} caracteres`);
    return s;
  }

  int(v: unknown, field: string, o: { min: number; max: number; default: number }): number {
    if (v === undefined || v === null) return o.default;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      this.issues.push(`${field}: debe ser un número entero`);
      return o.default;
    }
    if (v < o.min || v > o.max) this.issues.push(`${field}: debe estar entre ${o.min} y ${o.max}`);
    return v;
  }

  bool(v: unknown, field: string, def: boolean): boolean {
    if (v === undefined || v === null) return def;
    if (typeof v !== "boolean") {
      this.issues.push(`${field}: debe ser verdadero o falso`);
      return def;
    }
    return v;
  }

  uuid(v: unknown, field: string): string {
    if (typeof v !== "string" || !UUID_RE.test(v)) {
      this.issues.push(`${field}: identificador no válido`);
      return "";
    }
    return v;
  }

  oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[], def?: T): T {
    if ((v === undefined || v === null) && def !== undefined) return def;
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
      this.issues.push(`${field}: valor no permitido`);
      return def ?? allowed[0]!;
    }
    return v as T;
  }

  stringArray(v: unknown, field: string, o: { maxItems: number; maxLen: number }): string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.issues.push(`${field}: debe ser una lista`);
      return [];
    }
    if (v.length > o.maxItems) this.issues.push(`${field}: máximo ${o.maxItems} elementos`);
    const out: string[] = [];
    v.forEach((item, i) => {
      if (typeof item !== "string" || !item.trim() || item.trim().length > o.maxLen) {
        this.issues.push(`${field}[${i}]: texto no válido (1-${o.maxLen} caracteres)`);
      } else out.push(item.trim());
    });
    return out;
  }

  done(): void {
    if (this.issues.length) throw new ValidationError(this.issues);
  }
}

/** Exige que el cuerpo sea un objeto JSON. */
export function asObject(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ValidationError(["El cuerpo debe ser un objeto JSON"]);
  return body;
}
