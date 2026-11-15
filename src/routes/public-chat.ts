import type { ChatTurn } from "../ai/provider.ts";
import type { Ctx } from "../context.ts";
import { exec, nowIso, q, q1, tx } from "../db/index.ts";
import type { AgentRow, PublicChatRow } from "../db/types.ts";
import { parseAgentConfig } from "../domain/agent-config.ts";
import { asObject, Checker, isRecord, ValidationError } from "../domain/validate.ts";
import { addEvent, audit, createExecution, runExecution } from "../engine/engine.ts";
import { AppError } from "../errors.ts";
import { json, type Req, type Res, type Router } from "../http/router.ts";
import { randomUUID } from "../util/id.ts";

/*
 * Chat público embebible: permite que los visitantes de una web hablen con un agente sin iniciar sesión.
 *
 * Defensas (la cuota de IA es del dueño, así que se protege por capas):
 *  1. Solo responde a peticiones cuyo `Origin` esté en la lista del chat (CORS). Un navegador no puede falsificarlo;
 *     un script fuera del navegador sí, por eso hay más capas.
 *  2. Límite por visitante: N mensajes cada 10 minutos (clave = hash de IP + chat; la IP no se guarda).
 *  3. Tope diario de mensajes por chat: la defensa real contra abuso automatizado.
 *  4. El agente debe estar activo y no requerir aprobación humana; se aplica el límite global de ejecuciones activas.
 */

export const VISITOR_WINDOW_MS = 10 * 60_000;
export const MAX_TURNS = 20;
export const MAX_MESSAGE_CHARS = 1000;
const MAX_ORIGINS = 10;

export interface PublicChatSettings {
  agentId: string;
  title: string;
  greeting: string;
  suggestions: string[];
  privacyNotice: string;
  allowedOrigins: string[];
  enabled: boolean;
  perVisitorLimit: number;
  dailyLimit: number;
}

/** Normaliza un origen (`https://dominio.es`). Rechaza rutas, comodines y protocolos que no sean http(s). */
export function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function parseSettings(body: unknown): PublicChatSettings {
  const o = asObject(body);
  const c = new Checker();
  const originsIn = c.stringArray(o["allowedOrigins"], "allowedOrigins", { maxItems: MAX_ORIGINS, maxLen: 200 });
  const allowedOrigins: string[] = [];
  for (const raw of originsIn) {
    const origin = normalizeOrigin(raw);
    if (!origin) c.issues.push(`allowedOrigins: «${raw}» no es un dominio válido (usa https://tudominio.es, sin rutas)`);
    else if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
  }
  const settings: PublicChatSettings = {
    agentId: c.uuid(o["agentId"], "agentId"),
    title: c.string(o["title"], "title", { min: 2, max: 60 }),
    greeting: c.string(o["greeting"], "greeting", { max: 500, default: "" }),
    suggestions: c.stringArray(o["suggestions"], "suggestions", { maxItems: 4, maxLen: 60 }),
    privacyNotice: c.string(o["privacyNotice"], "privacyNotice", { max: 400, default: "" }),
    allowedOrigins,
    enabled: c.bool(o["enabled"], "enabled", true),
    perVisitorLimit: c.int(o["perVisitorLimit"], "perVisitorLimit", { min: 1, max: 100, default: 15 }),
    dailyLimit: c.int(o["dailyLimit"], "dailyLimit", { min: 1, max: 20000, default: 500 }),
  };
  c.done();
  return settings;
}

/** Fila → objeto para el panel del dueño. */
function present(row: PublicChatRow & { agent_name?: string; today?: number | null }) {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name ?? null,
    title: row.title,
    greeting: row.greeting,
    suggestions: JSON.parse(row.suggestions) as string[],
    privacyNotice: row.privacy_notice,
    allowedOrigins: JSON.parse(row.allowed_origins) as string[],
    enabled: row.enabled === 1,
    perVisitorLimit: row.per_visitor_limit,
    dailyLimit: row.daily_limit,
    messagesToday: row.today ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const today = (): string => new Date().toISOString().slice(0, 10);

async function visitorKey(chatId: string, ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${chatId}:${ip}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseMessages(body: unknown): { history: ChatTurn[]; input: string; conversationId: string | null } {
  const o = asObject(body);
  const raw = o["messages"];
  const issues: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) throw new ValidationError(["messages: debe ser una lista con al menos un mensaje"]);
  const turns = raw.slice(-MAX_TURNS); // solo los últimos turnos: limita el coste por petición
  const out: ChatTurn[] = [];
  turns.forEach((t, i) => {
    if (!isRecord(t) || (t["role"] !== "user" && t["role"] !== "assistant") || typeof t["content"] !== "string") {
      issues.push(`messages[${i}]: formato no válido`);
      return;
    }
    const content = t["content"].trim();
    if (!content) issues.push(`messages[${i}]: mensaje vacío`);
    else if (content.length > MAX_MESSAGE_CHARS) issues.push(`messages[${i}]: máximo ${MAX_MESSAGE_CHARS} caracteres`);
    else out.push({ role: t["role"], content });
  });
  if (issues.length) throw new ValidationError(issues);
  const last = out.pop()!;
  if (last.role !== "user") throw new ValidationError(["messages: el último mensaje debe ser del visitante"]);
  // El historial debe empezar por el visitante para que el modelo reciba turnos coherentes.
  while (out.length && out[0]!.role !== "user") out.shift();

  const cid = o["conversationId"];
  const conversationId = typeof cid === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(cid) ? cid : null;
  return { history: out, input: last.content, conversationId };
}

export function registerPublicChatRoutes(router: Router, ctx: Ctx): void {
  const { db } = ctx;

  // ---------------- Panel del dueño (requiere sesión) ----------------

  const ownedChat = (ownerId: string, id: string): PublicChatRow => {
    const row = q1<PublicChatRow>(db, "select * from public_chats where id = ? and owner_id = ?", id, ownerId);
    if (!row) throw new AppError(404, "Chat no encontrado.");
    return row;
  };

  const assertPublishableAgent = (ownerId: string, agentId: string): void => {
    const agent = q1<Pick<AgentRow, "id" | "current_version">>(db, "select id, current_version from agents where id = ? and owner_id = ?", agentId, ownerId);
    if (!agent) throw new AppError(404, "Agente no encontrado.");
    const row = q1<{ config: string }>(db, "select config from agent_versions where agent_id = ? and version = ? and owner_id = ?", agent.id, agent.current_version, ownerId);
    const config = parseAgentConfig(JSON.parse(row!.config));
    if (config.requiresApproval) {
      throw new AppError(409, "Este agente requiere aprobación humana en cada ejecución; no puede atender un chat público.");
    }
  };

  router.add("GET", "/api/public-chats", (req) => {
    const rows = q<PublicChatRow & { agent_name: string; today: number | null }>(
      db,
      `select pc.*, a.name as agent_name, u.messages as today
         from public_chats pc
         join agents a on a.id = pc.agent_id and a.owner_id = pc.owner_id
         left join public_chat_usage u on u.chat_id = pc.id and u.day = ?
        where pc.owner_id = ?
        order by pc.created_at desc`,
      today(),
      req.user.id,
    );
    return json({ chats: rows.map(present) });
  });

  router.add("POST", "/api/public-chats", (req) => {
    const s = parseSettings(req.body);
    assertPublishableAgent(req.user.id, s.agentId);
    const id = randomUUID();
    exec(
      db,
      `insert into public_chats (id, owner_id, agent_id, title, greeting, suggestions, privacy_notice, allowed_origins, enabled, per_visitor_limit, daily_limit)
       values (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      req.user.id,
      s.agentId,
      s.title,
      s.greeting,
      JSON.stringify(s.suggestions),
      s.privacyNotice,
      JSON.stringify(s.allowedOrigins),
      s.enabled ? 1 : 0,
      s.perVisitorLimit,
      s.dailyLimit,
    );
    audit(db, req.user.id, "public_chat.create", "public_chat", id, { agent_id: s.agentId, origins: s.allowedOrigins });
    return json({ id }, 201);
  });

  router.add("PUT", "/api/public-chats/:id", (req) => {
    const chat = ownedChat(req.user.id, req.params["id"]!);
    const s = parseSettings(req.body);
    assertPublishableAgent(req.user.id, s.agentId);
    exec(
      db,
      `update public_chats set agent_id = ?, title = ?, greeting = ?, suggestions = ?, privacy_notice = ?, allowed_origins = ?,
              enabled = ?, per_visitor_limit = ?, daily_limit = ?, updated_at = ?
        where id = ? and owner_id = ?`,
      s.agentId,
      s.title,
      s.greeting,
      JSON.stringify(s.suggestions),
      s.privacyNotice,
      JSON.stringify(s.allowedOrigins),
      s.enabled ? 1 : 0,
      s.perVisitorLimit,
      s.dailyLimit,
      nowIso(),
      chat.id,
      req.user.id,
    );
    audit(db, req.user.id, "public_chat.update", "public_chat", chat.id, { enabled: s.enabled, origins: s.allowedOrigins });
    return json({ ok: true });
  });

  router.add("DELETE", "/api/public-chats/:id", (req) => {
    const chat = ownedChat(req.user.id, req.params["id"]!);
    exec(db, "delete from public_chats where id = ? and owner_id = ?", chat.id, req.user.id);
    audit(db, req.user.id, "public_chat.delete", "public_chat", chat.id);
    return json({ ok: true });
  });

  // ---------------- Endpoints públicos (sin sesión, con CORS) ----------------

  /** Busca el chat y comprueba que el origen de la petición está autorizado. */
  const resolve = (req: Req): { chat: PublicChatRow; origin: string } => {
    const id = req.params["id"]!;
    const chat = /^[0-9a-f-]{36}$/i.test(id) ? q1<PublicChatRow>(db, "select * from public_chats where id = ?", id) : undefined;
    if (!chat) throw new AppError(404, "Chat no encontrado.");
    const origin = req.headers["origin"] ?? "";
    const allowed = JSON.parse(chat.allowed_origins) as string[];
    if (!origin || !allowed.includes(origin)) throw new AppError(403, "Este chat no está autorizado en esta web.");
    return { chat, origin };
  };

  const cors = (origin: string | undefined): Record<string, string> =>
    origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };

  /**
   * Envuelve un manejador público: los errores también llevan cabeceras CORS (si el origen es válido),
   * para que el widget pueda leer el mensaje y mostrarlo al visitante.
   */
  const publicRoute =
    (fn: (req: Req, chat: PublicChatRow, origin: string) => Promise<Res> | Res) =>
    async (req: Req): Promise<Res> => {
      let origin: string | undefined;
      try {
        const resolved = resolve(req);
        origin = resolved.origin;
        const res = await fn(req, resolved.chat, resolved.origin);
        return { ...res, headers: { ...cors(origin), ...(res.headers ?? {}) } };
      } catch (e) {
        if (e instanceof ValidationError) return json({ error: "Mensaje no válido.", issues: e.issues }, 400, cors(origin));
        if (e instanceof AppError) return json({ error: e.message }, e.status, cors(origin));
        throw e;
      }
    };

  router.addPublic(
    "OPTIONS",
    "/api/public/chats/:id/messages",
    publicRoute(() => ({
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      },
    })),
  );

  /** Configuración visible del widget (título, saludo, sugerencias, aviso de privacidad). */
  router.addPublic(
    "GET",
    "/api/public/chats/:id",
    publicRoute((_req, chat) => {
      const agent = q1<{ status: string }>(db, "select status from agents where id = ? and owner_id = ?", chat.agent_id, chat.owner_id);
      return json({
        title: chat.title,
        greeting: chat.greeting,
        suggestions: JSON.parse(chat.suggestions) as string[],
        privacyNotice: chat.privacy_notice,
        available: chat.enabled === 1 && agent?.status === "active",
      });
    }),
  );

  router.addPublic(
    "POST",
    "/api/public/chats/:id/messages",
    publicRoute(async (req, chat) => {
      const { history, input, conversationId } = parseMessages(req.body);

      if (chat.enabled !== 1) throw new AppError(503, "El chat no está disponible ahora mismo.");
      const agent = q1<{ status: string }>(db, "select status from agents where id = ? and owner_id = ?", chat.agent_id, chat.owner_id);
      if (agent?.status !== "active") throw new AppError(503, "El chat no está disponible ahora mismo.");
      try {
        assertPublishableAgent(chat.owner_id, chat.agent_id); // por si una versión nueva activó la aprobación humana
      } catch {
        throw new AppError(503, "El chat no está disponible ahora mismo.");
      }

      // Límites: se comprueban y se apuntan en la misma transacción.
      const visitor = await visitorKey(chat.id, req.ip);
      const now = Date.now();
      const day = today();
      tx(db, () => {
        const used = q1<{ messages: number }>(db, "select messages from public_chat_usage where chat_id = ? and day = ?", chat.id, day)?.messages ?? 0;
        if (used >= chat.daily_limit) throw new AppError(429, "El chat ha alcanzado su límite de mensajes por hoy. Vuelve a intentarlo mañana.");
        const recent = q1<{ n: number }>(
          db,
          "select count(*) as n from public_chat_hits where chat_id = ? and visitor = ? and at > ?",
          chat.id,
          visitor,
          now - VISITOR_WINDOW_MS,
        )!.n;
        if (recent >= chat.per_visitor_limit) throw new AppError(429, "Has enviado muchos mensajes seguidos. Espera unos minutos y vuelve a intentarlo.");

        exec(db, "insert into public_chat_hits (chat_id, visitor, at) values (?,?,?)", chat.id, visitor, now);
        exec(
          db,
          "insert into public_chat_usage (chat_id, day, messages) values (?,?,1) on conflict(chat_id, day) do update set messages = messages + 1",
          chat.id,
          day,
        );
        // Limpieza: los registros por visitante solo hacen falta durante la ventana.
        exec(db, "delete from public_chat_hits where chat_id = ? and at < ?", chat.id, now - 24 * 60 * 60_000);
      });

      let executionId: string;
      try {
        executionId = createExecution(ctx, chat.owner_id, { agentId: chat.agent_id, input });
      } catch (e) {
        if (e instanceof AppError && e.status === 429) throw new AppError(429, "Hay muchas conversaciones a la vez. Inténtalo de nuevo en unos segundos.");
        if (e instanceof AppError) throw new AppError(503, "El chat no está disponible ahora mismo.");
        throw e;
      }
      addEvent(db, chat.owner_id, executionId, null, "public_chat", "Mensaje del chat público.", {
        chat_id: chat.id,
        turns: history.length + 1,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      });

      const status = await runExecution(ctx, chat.owner_id, executionId, { history, publicChat: true });
      const done = q1<{ output: string | null }>(db, "select output from executions where id = ? and owner_id = ?", executionId, chat.owner_id);
      if (status !== "completed" || !done?.output) {
        // El detalle del error queda en Ejecuciones; al visitante no se le muestran datos internos.
        throw new AppError(503, "Ahora mismo no puedo responder. Inténtalo de nuevo en unos minutos.");
      }
      return json({ reply: done.output });
    }),
  );
}
