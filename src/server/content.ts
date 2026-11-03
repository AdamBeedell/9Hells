// Loads and saves the JSON content folder. Each collection is one file.
import { promises as fs, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Content } from "../engine/types.js";

export const COLLECTIONS = ["config", "characters", "cards", "decks", "rules", "soulOwners"] as const;
export type Collection = (typeof COLLECTIONS)[number];

export function loadContentSync(dir: string): Content {
  const read = (name: Collection) => {
    const file = path.join(dir, `${name}.json`);
    if (!existsSync(file)) return name === "config" ? {} : [];
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const c = Object.fromEntries(COLLECTIONS.map((k) => [k, read(k)])) as unknown as Content;
  c.config = <Content["config"]>{
    title: "9Hells", startLayer: 9, startGold: 0, levels: [0, 60, 150, 280, 450], downAt: 0, deadAt: -10,
    maxPendingAttacksPerMonster: 3, catchUpPerDead: 0.1, ...((c.config ?? {}) as object),
  };
  return c;
}

export async function saveCollection(dir: string, name: Collection, data: unknown) {
  const file = path.join(dir, `${name}.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

/** On first start, copy the bundled default content into an empty content volume. */
export async function seedContent(dir: string, defaultsDir: string) {
  await fs.mkdir(dir, { recursive: true });
  for (const name of COLLECTIONS) {
    const target = path.join(dir, `${name}.json`);
    const src = path.join(defaultsDir, `${name}.json`);
    if (!existsSync(target) && existsSync(src) && path.resolve(src) !== path.resolve(target)) await fs.copyFile(src, target);
  }
}
