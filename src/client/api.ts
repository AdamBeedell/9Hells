import type { Content, GameEvent, RunView } from "../engine/types";

export interface Me { username: string; isAdmin: boolean }
export interface RunResponse { view: RunView | null; events: GameEvent[] }
export interface Issue { level: "error" | "warning"; where: string; message: string }

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) { super(message); }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data);
  return data as T;
}

export const api = {
  config: () => call<{ title: string; allowRegistration: boolean }>("GET", "/api/config"),
  me: () => call<Me>("GET", "/api/me"),
  login: (username: string, password: string) => call<Me>("POST", "/api/login", { username, password }),
  register: (username: string, password: string) => call<Me>("POST", "/api/register", { username, password }),
  logout: () => call("POST", "/api/logout", {}),
  run: () => call<RunResponse>("GET", "/api/run"),
  newRun: () => call<RunResponse>("POST", "/api/run/new", {}),
  choose: (side: "left" | "right", turn: number) => call<RunResponse>("POST", "/api/run/choose", { side, turn }),
  exportSave: () => call<any>("GET", "/api/save/export"),
  importSave: (save: unknown) => call<RunResponse>("POST", "/api/save/import", { save }),
  adminContent: () => call<{ content: Content; issues: Issue[] }>("GET", "/api/admin/content"),
  adminCheck: (content: Content) => call<{ issues: Issue[] }>("POST", "/api/admin/check", { content }),
  adminSave: (collection: string, data: unknown, force = false) =>
    call<{ ok: boolean; issues: Issue[] }>("PUT", `/api/admin/content/${collection}`, { data, force }),
};
