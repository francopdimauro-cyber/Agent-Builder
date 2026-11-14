import type { IncomingHttpHeaders } from "node:http";
import type { UserRow } from "../db/types.ts";

export type User = Omit<UserRow, "password_hash">;

export interface Req {
  method: string;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  user: User | null;
  ip: string;
  headers: IncomingHttpHeaders;
}

export interface Res {
  status: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

export const json = (body: unknown, status = 200, headers?: Res["headers"]): Res => ({ status, body, ...(headers ? { headers } : {}) });

export type Handler = (req: Req & { user: User }) => Promise<Res> | Res;
export type PublicHandler = (req: Req) => Promise<Res> | Res;

interface Route {
  method: string;
  segments: string[];
  auth: boolean;
  handler: Handler | PublicHandler;
}

export class Router {
  private routes: Route[] = [];

  /** Ruta que exige sesión. */
  add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, segments: path.split("/").filter(Boolean), auth: true, handler });
  }

  /** Ruta pública (sin sesión). */
  addPublic(method: string, path: string, handler: PublicHandler): void {
    this.routes.push({ method, segments: path.split("/").filter(Boolean), auth: false, handler });
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | "method_not_allowed" | null {
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i]!;
        if (seg.startsWith(":")) {
          try {
            params[seg.slice(1)] = decodeURIComponent(parts[i]!);
          } catch {
            ok = false;
            break;
          }
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? "method_not_allowed" : null;
  }
}
