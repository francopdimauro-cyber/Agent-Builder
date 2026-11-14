import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { providerFromConfig, type AiProvider } from "../src/ai/provider.ts";
import { loadConfig } from "../src/config.ts";
import type { Db } from "../src/db/index.ts";
import { openDb } from "../src/db/node.ts";
import { createApp } from "../src/http/server.ts";

export interface MockCall {
  model: string;
  body: Record<string, any>;
  auth: string | undefined;
}
export interface MockReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}
export type MockHandler = (call: MockCall, n: number) => MockReply;

export const okBody = (text: string) => ({ choices: [{ message: { role: "assistant", content: text } }] });

/** Servidor que imita /chat/completions de NVIDIA. */
export async function startMock(initial: MockHandler) {
  let handler = initial;
  const calls: MockCall[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const call: MockCall = { model: body.model, body, auth: req.headers.authorization };
      calls.push(call);
      const reply = handler(call, calls.length);
      setTimeout(() => {
        res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
        res.end(JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    setHandler: (h: MockHandler) => (handler = h),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export interface TestApp {
  base: string;
  db: Db;
  ai: AiProvider;
  close: () => Promise<void>;
}

export async function startApp(mockUrl: string, models: string[] = ["m/primary", "m/backup1", "m/backup2"], extraEnv: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    NVIDIA_API_KEY: "test-key",
    NVIDIA_BASE_URL: mockUrl,
    AI_MODELS: models.join(","),
    DATABASE_PATH: ":memory:",
    ...extraEnv,
  });
  const db = openDb(":memory:");
  const ai = providerFromConfig(config);
  const server = createApp({ db, ai, config });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    db,
    ai,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export class Client {
  base: string;
  cookie = "";
  constructor(base: string) {
    this.base = base;
  }
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = res.headers.getSetCookie()[0];
    if (set) this.cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null, headers: res.headers };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b: unknown = {}) => this.req("POST", p, b);
  put = (p: string, b: unknown) => this.req("PUT", p, b);
  del = (p: string) => this.req("DELETE", p);
}

export const AGENT = {
  name: "Redactor",
  description: "Redacta resúmenes",
  role: "Redactor profesional",
  objective: "Resumir textos con claridad",
  instructions: "Resume el texto recibido en tres frases claras y neutrales.",
  tools: ["text_generation"],
};
