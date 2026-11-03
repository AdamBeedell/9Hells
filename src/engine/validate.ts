// Content check: catches authoring mistakes before they reach a run.

import { checkExpr } from "./expr.js";
import { isDice } from "./dice.js";
import type { Content, Effect, Placement, SpawnSpec } from "./types.js";

export interface Issue { level: "error" | "warning"; where: string; message: string }

export const KNOWN_OPS = new Set([
  "damage", "heal", "addExp", "addGold", "setFlag", "clearFlag", "setSoulOwner", "clearSoulOwner", "addDeck",
  "removeDeck", "spawn", "addBuff", "removeBuff", "addActionMod", "removeActionMod", "modifyStat", "setStat",
  "resurrect", "resurrectIn", "resurrectAtLayer", "replaceWith", "moveInTurnOrder", "rollInitiative", "useAction",
  "monsterStrike", "text", "endLayer", "endRun",
]);

const TARGET_RE = /^(actor([+-]\d+)?|party|party_alive|party_not_dead|random|random_alive|random_not_dead|random_dead|random_down|lowest_hp|highest_hp|roller|bound|self|source|role:[\w-]+|char:[\w#-]+)$/;
const SLOTS = new Set(["attackLeft", "attackRight", "defenceLeft", "defenceRight"]);

export function validateContent(c: Content): Issue[] {
  const issues: Issue[] = [];
  const err = (where: string, message: string) => issues.push({ level: "error", where, message });
  const warn = (where: string, message: string) => issues.push({ level: "warning", where, message });

  const cardIds = new Set<string>();
  for (const t of c.cards ?? []) {
    if (!t.id) err("cards", "A card has no id");
    else if (cardIds.has(t.id)) err(`card ${t.id}`, "Duplicate card id");
    cardIds.add(t.id);
  }
  const deckIds = new Set((c.decks ?? []).map((d) => d.id));
  const ownerIds = new Set((c.soulOwners ?? []).map((o) => o.id));
  const charIds = new Set((c.characters ?? []).map((ch) => ch.id));

  const expr = (where: string, src: unknown) => {
    if (typeof src !== "string" || isDice(src)) return;
    const e = checkExpr(src);
    if (e) err(where, e);
  };
  const amount = (where: string, v: unknown) => { if (typeof v === "string") expr(where, v); };
  const template = (where: string, text: unknown) => {
    if (typeof text !== "string") return;
    for (const m of text.matchAll(/\{([^{}]+)\}/g)) expr(`${where} placeholder {${m[1]}}`, m[1].trim());
  };
  const target = (where: string, t?: string) => { if (t && !TARGET_RE.test(t)) err(where, `Unknown target "${t}"`); };
  const placement = (where: string, p?: Placement, spawnKeys?: string[]) => {
    if (!p) return;
    if (typeof p === "string") { if (!["top", "bottom", "shuffle"].includes(p)) err(where, `Unknown placement "${p}"`); return; }
    if ("below" in p && spawnKeys && !spawnKeys.includes(p.below)) warn(where, `"below" refers to "${p.below}", which isn't spawned before it`);
  };

  const effects = (where: string, list: Effect[] | undefined, spawns?: Record<string, SpawnSpec>) => {
    (list ?? []).forEach((e, i) => {
      const w = `${where} #${i + 1}`;
      if (e.if !== undefined) expr(w, e.if);
      if (e.roll) { expr(w, e.roll.vs); amount(w, e.roll.bonus); target(w, e.roll.who); }
      effects(`${w} success`, e.success, spawns); effects(`${w} fail`, e.fail, spawns);
      effects(`${w} then`, e.then, spawns); effects(`${w} else`, e.else, spawns);
      if (!e.op) { if (!e.roll && e.if === undefined) warn(w, "Effect has no op"); return; }
      if (!KNOWN_OPS.has(e.op)) { err(w, `Unknown op "${e.op}"`); return; }
      target(w, e.target); target(w, e.fallback);
      if (["damage", "heal", "addExp", "addGold", "modifyStat", "setStat"].includes(e.op)) amount(w, e.value);
      amount(w, e.hp);
      if (e.op === "text") template(w, e.value);
      if ((e.op === "addDeck" || e.op === "removeDeck") && !deckIds.has(e.value)) err(w, `Unknown deck "${e.value}"`);
      if (e.op === "setSoulOwner" && !ownerIds.has(e.value)) err(w, `Unknown soul owner "${e.value}"`);
      if (e.op === "replaceWith" && !charIds.has(e.value)) err(w, `Unknown character "${e.value}"`);
      if (e.op === "useAction" && !SLOTS.has(e.value)) err(w, `Unknown action slot "${e.value}"`);
      if (e.op === "spawn") for (const k of ([] as string[]).concat(e.value)) if (!spawns?.[k] && k !== "self") err(w, `Spawn "${k}" isn't defined in this card's spawns`);
      if (e.op === "addActionMod" && (!e.value?.id || !SLOTS.has(e.value?.action))) err(w, "addActionMod needs value.id and a valid value.action");
    });
  };

  const spawnDefs = (where: string, spawns?: Record<string, SpawnSpec>) => {
    for (const [k, s] of Object.entries(spawns ?? {})) {
      if (s.template && !cardIds.has(s.template)) err(`${where} spawns.${k}`, `Unknown template "${s.template}"`);
      placement(`${where} spawns.${k}`, s.place);
      target(`${where} spawns.${k}`, s.bind);
    }
  };

  for (const t of c.cards ?? []) {
    const w = `card ${t.id}`;
    const kind = t.kind ?? "event";
    if (!t.text) warn(w, "Card has no text");
    template(`${w} text`, t.text);
    template(`${w} speaker`, t.speaker);
    template(`${w} left label`, t.left?.label);
    template(`${w} right label`, t.right?.label);
    (t.conditions ?? []).forEach((x) => expr(`${w} conditions`, x));
    spawnDefs(w, t.spawns);
    for (const side of ["left", "right"] as const) {
      const ch = t[side];
      if (!ch) { if (kind === "event" || kind === "levelUp") warn(w, `No ${side} choice (it will show a default label and do nothing)`); continue; }
      effects(`${w} ${side}`, ch.effects, t.spawns);
    }
    if ((kind === "monster" || kind === "boss") && t.tracked?.hp === undefined) err(w, "Monster needs tracked.hp");
    if ((kind === "monster" || kind === "boss") && !t.afterPlay) warn(w, "Monster has no afterPlay, so it is discarded after one hit even if it survives");
    if (kind === "monsterAttack" && t.tracked) warn(w, "monsterAttack cards use their source monster's stats; tracked is ignored");
    if (Array.isArray(t.afterPlay)) {
      t.afterPlay.forEach((b, i) => {
        const bw = `${w} afterPlay #${i + 1}`;
        if (b.if !== undefined) expr(bw, b.if);
        effects(bw, b.effects, t.spawns);
        placement(bw, b.place);
        const seen: string[] = b.do === "requeue" ? ["self"] : [];
        let shuffledTop = 0;
        for (const k of b.spawn ?? []) {
          const s = t.spawns?.[k];
          if (!s && k !== "self") { err(bw, `Spawn "${k}" isn't defined in this card's spawns`); continue; }
          if (s) placement(`${bw} spawn ${k}`, s.place, seen);
          const p = s?.place;
          if (p && typeof p === "object" && "shuffleTop" in p) {
            const n = Array.isArray(p.shuffleTop) ? p.shuffleTop[1] : p.shuffleTop;
            shuffledTop = Math.max(shuffledTop, n);
          }
          if (p && typeof p === "object" && "at" in p && shuffledTop && p.at <= shuffledTop + (s?.count ?? 1))
            warn(`${bw} spawn ${k}`, `"at: ${p.at}" may land above cards just shuffled into the top ${shuffledTop}. Use { "below": "<spawn>" } to guarantee order.`);
          seen.push(k);
        }
      });
      if (!t.afterPlay.some((b) => b.else || b.if === undefined)) warn(w, "afterPlay has no else branch, so the card is discarded when nothing matches");
    }
  }

  for (const d of c.decks ?? []) {
    if (!d.cards?.length) warn(`deck ${d.id}`, "Deck is empty");
    for (const id of d.cards ?? []) if (!cardIds.has(id)) err(`deck ${d.id}`, `Unknown card "${id}"`);
  }
  if (!(c.decks ?? []).some((d) => d.startActive)) err("decks", "No deck has startActive: true");

  for (const r of c.rules ?? []) {
    const w = `rule ${r.id}`;
    (r.conditions ?? []).forEach((x) => expr(`${w} conditions`, x));
    spawnDefs(w, r.spawns);
    effects(w, r.actions, r.spawns);
  }
  for (const o of c.soulOwners ?? []) effects(`soulOwner ${o.id}`, o.onDeath);

  const party = (c.characters ?? []).filter((ch) => !ch.reserve);
  if (party.length === 0) err("characters", "No party characters");
  if (party.length > 4) warn("characters", "More than 4 party characters");
  for (const ch of c.characters ?? []) {
    for (const [slot, a] of Object.entries(ch.actions ?? {})) {
      if (!SLOTS.has(slot)) err(`character ${ch.id}`, `Unknown action slot "${slot}"`);
      if (a && !(a.stat in (ch.mods ?? {}))) warn(`character ${ch.id} ${slot}`, `Uses stat "${a.stat}", which this character has no modifier for`);
      if (a?.damage && !isDice(a.damage)) err(`character ${ch.id} ${slot}`, `Bad damage dice "${a.damage}"`);
      effects(`character ${ch.id} ${slot} onHit`, a?.onHit);
    }
  }
  return issues;
}
