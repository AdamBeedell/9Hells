// SQLite storage (Node's built-in node:sqlite, so there are no native modules to build).
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";

export interface User { id: number; username: string; is_admin: number; meta: string }

export class Store {
  db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "9hells.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS saves (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  static hash(password: string): string {
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 64);
    return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
  }

  static verify(password: string, stored: string): boolean {
    const [scheme, saltHex, keyHex] = stored.split("$");
    if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
    const key = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
    const expected = Buffer.from(keyHex, "hex");
    return key.length === expected.length && timingSafeEqual(key, expected);
  }

  countAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get() as { n: number }).n;
  }

  createUser(username: string, password: string, isAdmin: boolean): User {
    this.db.prepare("INSERT INTO users (username, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?)")
      .run(username, Store.hash(password), isAdmin ? 1 : 0, Date.now());
    return this.userByName(username)!;
  }

  upsertAdmin(username: string, password: string) {
    const u = this.userByName(username);
    if (!u) this.createUser(username, password, true);
    else this.db.prepare("UPDATE users SET pass_hash = ?, is_admin = 1 WHERE id = ?").run(Store.hash(password), u.id);
  }

  userByName(username: string): User | undefined {
    return this.db.prepare("SELECT id, username, is_admin, meta FROM users WHERE username = ?").get(username) as User | undefined;
  }

  checkLogin(username: string, password: string): User | undefined {
    const row = this.db.prepare("SELECT id, username, is_admin, meta, pass_hash FROM users WHERE username = ?").get(username) as (User & { pass_hash: string }) | undefined;
    if (!row || !Store.verify(password, row.pass_hash)) return undefined;
    const { pass_hash: _ph, ...user } = row;
    return user;
  }

  createSession(userId: number, days = 30): string {
    const token = randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, Date.now() + days * 86400_000);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    return token;
  }

  userBySession(token: string | undefined): User | undefined {
    if (!token) return undefined;
    return this.db.prepare(
      "SELECT u.id, u.username, u.is_admin, u.meta FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
    ).get(token, Date.now()) as User | undefined;
  }

  deleteSession(token: string) { this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token); }

  getMeta(userId: number): Record<string, any> {
    const row = this.db.prepare("SELECT meta FROM users WHERE id = ?").get(userId) as { meta: string } | undefined;
    try { return JSON.parse(row?.meta ?? "{}"); } catch { return {}; }
  }
  setMeta(userId: number, meta: Record<string, any>) {
    this.db.prepare("UPDATE users SET meta = ? WHERE id = ?").run(JSON.stringify(meta), userId);
  }

  getSave(userId: number): string | undefined {
    return (this.db.prepare("SELECT state FROM saves WHERE user_id = ?").get(userId) as { state: string } | undefined)?.state;
  }
  putSave(userId: number, state: string) {
    this.db.prepare("INSERT INTO saves (user_id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at")
      .run(userId, state, Date.now());
  }
}
