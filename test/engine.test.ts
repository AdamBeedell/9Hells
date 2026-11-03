import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildView, choose, createRun, evaluate, validateContent } from "../src/engine/index.js";
import type { Content, RunState } from "../src/engine/types.js";
import { loadContentSync } from "../src/server/content.js";

const content = loadContentSync(path.resolve(__dirname, "../content"));

function mini(overrides: Partial<Content>): Content {
  return {
    config: { ...content.config },
    characters: content.characters,
    cards: [],
    decks: [],
    rules: [],
    soulOwners: content.soulOwners,
    ...overrides,
  };
}

describe("expressions", () => {
  it("evaluates arithmetic, comparisons and paths", () => {
    const ctx = { self: { hp: 3 }, flags: { a: true }, gold: 12 };
    expect(evaluate("self.hp <= 0", ctx)).toBe(false);
    expect(evaluate("gold >= 10 && flags.a", ctx)).toBe(true);
    expect(evaluate("max(1, self.hp * 2) - 1", ctx)).toBe(5);
    expect(evaluate("flags.missing", ctx)).toBe(undefined);
    expect(() => evaluate("constructor.constructor", ctx)).not.toThrow();
    expect(evaluate("constructor.constructor", ctx)).toBe(undefined);
  });
});

describe("bundled content", () => {
  it("passes the content check with no errors", () => {
    const errors = validateContent(content).filter((i) => i.level === "error");
    expect(errors).toEqual([]);
  });

  it("survives many random runs", () => {
    for (let seed = 1; seed <= 300; seed++) {
      let { state } = createRun(content, seed);
      let steps = 0;
      while (state.status === "active" && steps < 500) {
        const side = (seed + steps) % 3 === 0 ? "right" : "left";
        state = choose(content, state, side).state;
        steps++;
        const ids = state.draw.map((i) => i.iid);
        expect(new Set(ids).size).toBe(ids.length);
        if (state.current) expect(ids).not.toContain(state.current.iid);
        buildView(content, state);
      }
      expect(["active", "lost", "won", "layerComplete"]).toContain(state.status);
    }
  });
});

describe("combat loop", () => {
  const c = mini({
    characters: [{ id: "a", name: "A", maxHp: 30, ac: 30, mods: { str: -10 }, actions: { attackLeft: { label: "Flail", stat: "str", damage: "1d4" } } }],
    cards: [
      {
        id: "brute", kind: "monster", name: "Brute", text: "brute", tracked: { hp: 10, ac: 30, attack: 0, damage: "1" },
        spawns: { counter: { template: "brute_attack", count: 2, place: { shuffleTop: 3 } }, self: { place: { below: "counter" } } },
        afterPlay: [{ if: "self.hp <= 0", do: "discard" }, { else: true, do: "discard", spawn: ["counter", "self"] }],
      },
      { id: "brute_attack", kind: "monsterAttack", text: "attack" },
      { id: "filler", text: "filler", left: { label: "x" }, right: { label: "y" } },
    ],
    decks: [{ id: "main", startActive: true, cards: ["brute", "filler", "filler2"] }],
  });
  c.cards.push({ id: "filler2", text: "f2", left: { label: "x" }, right: { label: "y" } });

  it("puts the monster below both of its counterattacks", () => {
    for (let seed = 1; seed < 50; seed++) {
      let { state } = createRun(c, seed);
      // play until the brute is current
      let guard = 0;
      while (state.current?.tid !== "brute" && guard++ < 10) state = choose(c, state, "left").state;
      if (state.current?.tid !== "brute") continue;
      const iid = state.current.iid;
      state = choose(c, state, "left").state; // misses (str -10 vs ac 30, unless nat 20)
      const all = [state.current!, ...state.draw];
      const monsterPos = all.findIndex((i) => i.iid === iid);
      const attackPos = all.map((i, k) => (i.source === iid ? k : -1)).filter((k) => k >= 0);
      if (monsterPos === -1) continue; // killed by a crit
      expect(attackPos.length).toBe(2);
      for (const p of attackPos) expect(p).toBeLessThan(monsterPos);
    }
  });

  it("fizzles attacks whose monster is dead", () => {
    const { state } = createRun(c, 3);
    const s: RunState = JSON.parse(JSON.stringify(state));
    s.draw.unshift({ iid: 999, tid: "brute_attack", source: 12345 });
    s.current = { iid: 998, tid: "filler" };
    const next = choose(c, s, "left").state;
    expect(next.current?.iid).not.toBe(999);
  });
});

describe("EXP and death", () => {
  const c = mini({
    cards: [
      { id: "xp", text: "xp", left: { label: "gain", effects: [{ op: "addExp", value: 50 }] }, right: { label: "kill", effects: [{ op: "damage", target: "char:fighter", value: 100 }] }, afterPlay: "reshuffle" },
    ],
    decks: [{ id: "main", startActive: true, cards: ["xp"] }],
  });

  it("gives the catch-up bonus per dead member", () => {
    let { state } = createRun(c, 1);
    state = choose(c, state, "right").state; // fighter dies
    expect(state.chars.find((ch) => ch.id === "fighter")!.status).toBe("dead");
    state = choose(c, state, "left").state;
    const alive = state.chars.filter((ch) => ch.status === "alive");
    for (const ch of alive) expect(ch.exp).toBe(55);
  });

  it("runs the soul owner's death event instead of the default", () => {
    let { state } = createRun(c, 1);
    state.chars.find((ch) => ch.id === "fighter")!.soulOwner = "imp_notary";
    state = choose(c, state, "right").state;
    expect(state.pending.some((p) => p.charId === "fighter")).toBe(true);
    for (let i = 0; i < 3; i++) state = choose(c, state, "left").state;
    const f = state.chars.find((ch) => ch.id === "fighter")!;
    expect(f.status).toBe("alive");
    expect(f.soulOwner).toBeUndefined();
  });
});
