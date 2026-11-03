// 9Hells server: auth, server-side runs, save import/export, and the admin content API.
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { existsSync } from "node:fs";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildView, choose, createRun, validateContent } from "../engine/index.js";
import type { Content, RunState } from "../engine/types.js";
import { COLLECTIONS, type Collection, loadContentSync, saveCollection, seedContent } from "./content.js";
import { Store, type User } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data"));
const CONTENT_DIR = path.resolve(process.env.CONTENT_DIR ?? path.join(DATA_DIR, "content"));
const DEFAULT_CONTENT = path.join(ROOT, "content");
const CLIENT_DIR = path.join(ROOT, "dist", "client");
const ALLOW_REGISTRATION = (process.env.ALLOW_REGISTRATION ?? "true") !== "false";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

await seedContent(CONTENT_DIR, DEFAULT_CONTENT);
let content: Content = loadContentSync(CONTENT_DIR);
const store = new Store(DATA_DIR);
if (process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) store.upsertAdmin(process.env.ADMIN_USER, process.env.ADMIN_PASSWORD);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 4 * 1024 * 1024 });
await app.register(cookie);

declare module "fastify" { interface FastifyRequest { user?: User } }

app.addHook("preHandler", async (req) => {
  req.user = store.userBySession(req.cookies.sid);
});

const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return reply.code(401).send({ error: "Not logged in" });
};
const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return reply.code(401).send({ error: "Not logged in" });
  if (!req.user.is_admin) return reply.code(403).send({ error: "Admins only" });
};

const setSession = (reply: FastifyReply, userId: number) => {
  reply.setCookie("sid", store.createSession(userId), {
    path: "/", httpOnly: true, sameSite: "lax", secure: COOKIE_SECURE, maxAge: 30 * 86400,
  });
};
const me = (u: User) => ({ username: u.username, isAdmin: !!u.is_admin });

// ---------- auth ----------
app.get("/api/config", async () => ({ title: content.config.title ?? "9Hells", allowRegistration: ALLOW_REGISTRATION }));

app.post<{ Body: { username?: string; password?: string } }>("/api/register", async (req, reply) => {
  if (!ALLOW_REGISTRATION) return reply.code(403).send({ error: "Registration is closed" });
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!/^[\w.-]{3,32}$/.test(username)) return reply.code(400).send({ error: "Username: 3–32 letters, numbers, . _ or -" });
  if (password.length < 6) return reply.code(400).send({ error: "Password must be at least 6 characters" });
  if (store.userByName(username)) return reply.code(409).send({ error: "That username is taken" });
  const firstAdmin = store.countAdmins() === 0; // first account becomes admin if none was configured
  const user = store.createUser(username, password, firstAdmin);
  setSession(reply, user.id);
  return me(user);
});

app.post<{ Body: { username?: string; password?: string } }>("/api/login", async (req, reply) => {
  const user = store.checkLogin(String(req.body?.username ?? "").trim(), String(req.body?.password ?? ""));
  if (!user) { await new Promise((r) => setTimeout(r, 400)); return reply.code(401).send({ error: "Wrong username or password" }); }
  setSession(reply, user.id);
  return me(user);
});

app.post("/api/logout", async (req, reply) => {
  if (req.cookies.sid) store.deleteSession(req.cookies.sid);
  reply.clearCookie("sid", { path: "/" });
  return { ok: true };
});

app.get("/api/me", { preHandler: requireUser }, async (req) => me(req.user!));

// ---------- runs ----------
const loadRun = (userId: number): RunState | undefined => {
  const raw = store.getSave(userId);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as RunState; } catch { return undefined; }
};
const persistRun = (userId: number, s: RunState) => {
  store.putSave(userId, JSON.stringify(s));
  if (s.onceSeen.length) {
    const meta = store.getMeta(userId);
    const once = new Set<string>([...(meta.onceSeen ?? []), ...s.onceSeen]);
    meta.onceSeen = [...once];
    store.setMeta(userId, meta);
  }
};

app.get("/api/run", { preHandler: requireUser }, async (req) => {
  const s = loadRun(req.user!.id);
  return { view: s ? buildView(content, s) : null, events: [] };
});

app.post("/api/run/new", { preHandler: requireUser }, async (req) => {
  const meta = store.getMeta(req.user!.id);
  const { state, events } = createRun(content, randomInt(1, 2 ** 31 - 1), { onceSeen: meta.onceSeen ?? [] });
  persistRun(req.user!.id, state);
  return { view: buildView(content, state), events };
});

app.post<{ Body: { side?: string; turn?: number } }>("/api/run/choose", { preHandler: requireUser }, async (req, reply) => {
  const s = loadRun(req.user!.id);
  if (!s) return reply.code(404).send({ error: "No run in progress" });
  const side = req.body?.side;
  if (side !== "left" && side !== "right") return reply.code(400).send({ error: "side must be left or right" });
  if (typeof req.body?.turn === "number" && req.body.turn !== s.turn) {
    return reply.code(409).send({ error: "Out of date", view: buildView(content, s), events: [] });
  }
  if (s.status !== "active" || !s.current) return reply.code(409).send({ error: "Run is over", view: buildView(content, s), events: [] });
  try {
    const { state, events } = choose(content, s, side);
    persistRun(req.user!.id, state);
    return { view: buildView(content, state), events };
  } catch (e: any) {
    req.log.error(e);
    return reply.code(500).send({ error: `Engine error: ${e.message}` });
  }
});

// ---------- saves ----------
app.get("/api/save/export", { preHandler: requireUser }, async (req, reply) => {
  const s = loadRun(req.user!.id);
  if (!s) return reply.code(404).send({ error: "No save to export" });
  reply.header("Content-Disposition", `attachment; filename="9hells-${req.user!.username}-turn${s.turn}.json"`);
  return { format: "9hells-save", version: 1, exportedAt: new Date().toISOString(), state: s };
});

app.post<{ Body: { save?: any } }>("/api/save/import", { preHandler: requireUser }, async (req, reply) => {
  const save = req.body?.save;
  const s = save?.state as RunState | undefined;
  const looksValid = save?.format === "9hells-save" && s && s.version === 1 && Array.isArray(s.chars) && Array.isArray(s.draw) && Array.isArray(s.order) && typeof s.rng === "number";
  if (!looksValid) return reply.code(400).send({ error: "That isn't a 9Hells save file" });
  try { buildView(content, s); } catch (e: any) { return reply.code(400).send({ error: `Save can't be loaded: ${e.message}` }); }
  persistRun(req.user!.id, s);
  return { view: buildView(content, s), events: [] };
});

// ---------- admin ----------
app.get("/api/admin/content", { preHandler: requireAdmin }, async () => ({ content, issues: validateContent(content) }));

app.post<{ Body: { content?: Content } }>("/api/admin/check", { preHandler: requireAdmin }, async (req) => {
  return { issues: validateContent(req.body?.content ?? content) };
});

app.put<{ Params: { collection: string }; Body: { data?: unknown; force?: boolean } }>(
  "/api/admin/content/:collection", { preHandler: requireAdmin }, async (req, reply) => {
    const name = req.params.collection as Collection;
    if (!COLLECTIONS.includes(name)) return reply.code(404).send({ error: "Unknown collection" });
    const data = req.body?.data;
    if (data === undefined || (name === "config" ? typeof data !== "object" || Array.isArray(data) : !Array.isArray(data)))
      return reply.code(400).send({ error: name === "config" ? "config must be an object" : `${name} must be an array` });
    const draft = { ...content, [name]: data } as Content;
    let issues;
    try { issues = validateContent(draft); } catch (e: any) { return reply.code(400).send({ error: `Content check crashed: ${e.message}` }); }
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length && !req.body?.force) return reply.code(422).send({ error: "Content has errors (not saved)", issues });
    await saveCollection(CONTENT_DIR, name, data);
    content = loadContentSync(CONTENT_DIR);
    return { ok: true, issues };
  });

app.post("/api/admin/reload", { preHandler: requireAdmin }, async () => {
  content = loadContentSync(CONTENT_DIR);
  return { ok: true, issues: validateContent(content) };
});

// ---------- client ----------
if (existsSync(CLIENT_DIR)) {
  await app.register(fastifyStatic, { root: CLIENT_DIR, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
} else {
  app.log.warn(`No client build at ${CLIENT_DIR}; run "npm run build" (or use the Vite dev server).`);
}

app.get("/healthz", async () => ({ ok: true }));

await app.listen({ port: PORT, host: HOST });
app.log.info(`9Hells listening on ${HOST}:${PORT}. Data: ${DATA_DIR}. Content: ${CONTENT_DIR}`);
