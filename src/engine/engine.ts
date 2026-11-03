// The 9Hells game engine. Pure and deterministic: all randomness comes from the seeded RNG in the
// run state, so the server can replay or validate a run. Public API: createRun, choose, buildView.

import { evaluate, evalNum } from "./expr.js";
import { isDice, randInt, rollDice, shuffle } from "./dice.js";
import type {
  ActionDef, ActionMod, ActionSlot, CardTemplate, CharState, CharStatus, Choice, Content, Effect,
  GameEvent, Instance, Placement, RollResult, RollSpec, RunState, RunView, SpawnSpec,
} from "./types.js";

export const ENGINE_VERSION = 1;

export interface StepResult { state: RunState; events: GameEvent[] }

interface SpawnSource { spawns?: Record<string, SpawnSpec>; inst: Instance | null }

class Runner {
  events: GameEvent[] = [];
  private tpls = new Map<string, CardTemplate>();
  private cur: Instance | null = null;          // instance whose effects are being resolved
  private spawnSrc: SpawnSource = { inst: null };
  private boundId: string | undefined;          // "bound" character for rules and death events
  private roller: string | undefined;
  private levelQueue: string[] = [];
  private depth = 0;

  constructor(public c: Content, public s: RunState) {
    for (const t of c.cards) this.tpls.set(t.id, t);
  }

  tpl(id: string) { return this.tpls.get(id); }

  // ---------- logging ----------
  log(text: string, event = true) {
    this.s.log.push(text);
    if (this.s.log.length > 40) this.s.log.splice(0, this.s.log.length - 40);
    if (event) this.events.push({ type: "text", text });
  }

  // ---------- characters / turn order ----------
  char(id?: string) { return id ? this.s.chars.find((c) => c.id === id) : undefined; }

  /** The actor deck: alive characters in turn order, starting with the current actor. */
  actorDeck(): CharState[] {
    const n = this.s.order.length;
    const out: CharState[] = [];
    for (let k = 0; k < n; k++) {
      const ch = this.char(this.s.order[(this.s.actorIdx + k) % n]);
      if (ch && ch.status === "alive") out.push(ch);
    }
    return out;
  }
  actor(): CharState | undefined { return this.actorDeck()[0]; }

  advanceActor() {
    const a = this.actor();
    const n = this.s.order.length;
    if (!a || n === 0) return;
    this.s.actorIdx = (this.s.order.indexOf(a.id) + 1) % n;
  }

  rollInitiative() {
    const rolls = this.s.chars.map((ch) => ({ id: ch.id, r: randInt(this.s, 1, 20) + (ch.mods.dex ?? 0) + randInt(this.s, 0, 99) / 100 }));
    rolls.sort((a, b) => b.r - a.r);
    this.s.order = rolls.map((r) => r.id);
    this.s.actorIdx = 0;
  }

  moveInTurnOrder(ch: CharState, pos: number) {
    const deck = this.actorDeck().filter((c) => c.id !== ch.id);
    if (ch.status !== "alive") return;
    const p = pos < 0 ? Math.max(0, deck.length + 1 + pos) : Math.min(pos, deck.length);
    deck.splice(p, 0, ch);
    const ids = deck.map((c) => c.id);
    this.s.order = [...ids, ...this.s.order.filter((id) => !ids.includes(id))];
    this.s.actorIdx = 0;
  }

  // ---------- expressions ----------
  monsterView(inst: Instance | null | undefined) {
    if (!inst) return undefined;
    const t = this.tpl(inst.tid);
    return { ...(inst.state ?? {}), name: t?.name ?? t?.speaker ?? inst.tid, maxHp: t?.tracked?.hp, iid: inst.iid } as Record<string, any>;
  }

  charView(ch?: CharState) {
    if (!ch) return undefined;
    return { ...ch, alive: ch.status === "alive", ...ch.mods };
  }

  ctx(inst: Instance | null = this.cur): Record<string, any> {
    const alive = this.s.chars.filter((c) => c.status === "alive");
    const levels = this.s.chars.filter((c) => c.status !== "dead").map((c) => c.level);
    return {
      self: this.monsterView(inst) ?? {},
      source: this.monsterView(inst?.source != null ? this.findInst(inst.source) : undefined) ?? {},
      actor: this.charView(this.actor()) ?? {},
      bound: this.charView(this.char(inst?.bound ?? this.boundId)) ?? {},
      party: {
        gold: this.s.gold,
        size: this.s.chars.length,
        alive: alive.length,
        down: this.s.chars.filter((c) => c.status === "down").length,
        dead: this.s.chars.filter((c) => c.status === "dead").length,
        maxLevel: levels.length ? Math.max(...levels) : 0,
        minLevel: levels.length ? Math.min(...levels) : 0,
      },
      chars: Object.fromEntries(this.s.chars.map((c) => [c.id, this.charView(c)])),
      lastRoll: this.s.lastRoll ?? {},
      flags: this.s.flags,
      seen: this.s.seen,
      decks: Object.fromEntries(this.s.activeDecks.map((d) => [d, true])),
      gold: this.s.gold,
      turn: this.s.turn,
      layer: this.s.layer,
    };
  }

  test(conds: string[] | undefined, inst: Instance | null = this.cur): boolean {
    return (conds ?? []).every((c) => !!evaluate(c, this.ctx(inst)));
  }

  amount(v: unknown, times = 1): number {
    if (typeof v === "number") return v;
    if (v == null || v === "") return 0;
    if (isDice(v)) return rollDice(this.s, v, times).total;
    return Math.round(evalNum(String(v), this.ctx()));
  }

  render(text: string, inst: Instance | null): string {
    return text.replace(/\{([^{}]+)\}/g, (_m, expr) => {
      try {
        const v = evaluate(expr.trim(), this.ctx(inst));
        if (v && typeof v === "object") return v.name ?? "";
        return v == null ? "" : String(v);
      } catch { return `{${expr}}`; }
    });
  }

  // ---------- instances / placement ----------
  newInst(tid: string, extra: Partial<Instance> = {}): Instance {
    const t = this.tpl(tid);
    const inst: Instance = { iid: this.s.nextIid++, tid, ...extra };
    if (t?.tracked) inst.state = JSON.parse(JSON.stringify(t.tracked));
    return inst;
  }

  findInst(iid: number): Instance | undefined {
    if (this.s.current?.iid === iid) return this.s.current;
    return this.s.draw.find((i) => i.iid === iid);
  }

  insert(inst: Instance, place: Placement | undefined, batch?: Map<string, number[]>) {
    const d = this.s.draw;
    const len = d.length;
    const range = (r: number | [number, number]) => (Array.isArray(r) ? randInt(this.s, r[0], r[1]) : r);
    let idx: number;
    const p = place ?? "shuffle";
    if (p === "top") idx = 0;
    else if (p === "bottom") idx = len;
    else if (p === "shuffle") idx = randInt(this.s, 0, len);
    else if ("at" in p) idx = Math.max(0, Math.min(p.at - 1, len));
    else if ("shuffleTop" in p) idx = randInt(this.s, 0, Math.max(0, Math.min(range(p.shuffleTop), len + 1) - 1));
    else if ("below" in p) {
      const ids = batch?.get(p.below) ?? [];
      let max = -1;
      d.forEach((x, i) => { if (ids.includes(x.iid)) max = i; });
      idx = max + 1 + (p.within ? randInt(this.s, 0, Math.max(0, range(p.within) - 1)) : 0);
      idx = Math.min(idx, len);
    } else idx = randInt(this.s, 0, len);
    d.splice(idx, 0, inst);
  }

  addDeck(deckId: string, place?: Placement) {
    if (this.s.activeDecks.includes(deckId)) return;
    const deck = this.c.decks.find((d) => d.id === deckId);
    if (!deck) { this.log(`(missing deck "${deckId}")`, false); return; }
    this.s.activeDecks.push(deckId);
    for (const tid of deck.cards) {
      const t = this.tpl(tid);
      if (!t || this.s.onceSeen.includes(tid)) continue;
      for (let k = 0; k < (t.weight ?? 1); k++) this.insert(this.newInst(tid, { deck: deckId }), place ?? "shuffle");
    }
    this.events.push({ type: "deck", deck: deckId, added: true });
  }

  removeDeck(deckId: string) {
    this.s.activeDecks = this.s.activeDecks.filter((d) => d !== deckId);
    this.s.draw = this.s.draw.filter((i) => i.deck !== deckId);
    this.events.push({ type: "deck", deck: deckId, added: false });
  }

  spawn(keys: string[], batch = new Map<string, number[]>()) {
    const src = this.spawnSrc;
    for (const key of keys) {
      const spec = src.spawns?.[key];
      const ids = batch.get(key) ?? [];
      batch.set(key, ids);
      if (!spec) {
        if (key === "self" && src.inst) { this.insert(src.inst, "top", batch); ids.push(src.inst.iid); }
        else this.log(`(missing spawn "${key}")`, false);
        continue;
      }
      for (let k = 0; k < (spec.count ?? 1); k++) {
        if (!spec.template) {
          if (src.inst) { this.insert(src.inst, spec.place, batch); ids.push(src.inst.iid); }
          continue;
        }
        const t = this.tpl(spec.template);
        if (!t) { this.log(`(missing template "${spec.template}")`, false); continue; }
        const extra: Partial<Instance> = {};
        if (src.inst?.deck) extra.deck = src.inst.deck;
        if (t.kind === "monsterAttack" && src.inst) {
          const srcT = this.tpl(src.inst.tid);
          const monsterIid = srcT?.kind === "monster" || srcT?.kind === "boss" ? src.inst.iid : src.inst.source;
          if (monsterIid != null) {
            const pendingCount = this.s.draw.filter((i) => i.source === monsterIid).length;
            if (pendingCount >= this.c.config.maxPendingAttacksPerMonster) continue; // safeguard
            extra.source = monsterIid;
          }
        }
        if (spec.bind) { const b = this.targets(spec.bind).chars[0]; if (b) extra.bound = b.id; }
        else if (this.boundId) extra.bound = this.boundId;
        const inst = this.newInst(spec.template, extra);
        this.insert(inst, spec.place, batch);
        ids.push(inst.iid);
      }
    }
  }

  // ---------- targets ----------
  targets(target: string | undefined, fallback?: string, depth = 0): { chars: CharState[]; monsters: Instance[] } {
    const t = target ?? "actor";
    const notDead = this.s.chars.filter((c) => c.status !== "dead");
    const alive = this.s.chars.filter((c) => c.status === "alive");
    let chars: CharState[] = [];
    let monsters: Instance[] = [];
    const m = /^actor([+-]\d+)$/.exec(t);
    if (t === "actor") { const a = this.actor(); if (a) chars = [a]; }
    else if (m) { const deck = this.actorDeck(); if (deck.length) { const n = parseInt(m[1], 10); chars = [deck[((n % deck.length) + deck.length) % deck.length]]; } }
    else if (t === "party" || t === "party_not_dead") chars = notDead;
    else if (t === "party_alive") chars = alive;
    else if (t === "random_alive" || t === "random") { if (alive.length) chars = [alive[randInt(this.s, 0, alive.length - 1)]]; }
    else if (t === "random_down") { const d = this.s.chars.filter((c) => c.status === "down"); if (d.length) chars = [d[randInt(this.s, 0, d.length - 1)]]; }
    else if (t === "random_not_dead") { if (notDead.length) chars = [notDead[randInt(this.s, 0, notDead.length - 1)]]; }
    else if (t === "lowest_hp" || t === "highest_hp") {
      const sorted = [...alive].sort((a, b) => (t === "lowest_hp" ? a.hp - b.hp : b.hp - a.hp));
      if (sorted.length) chars = [sorted[0]];
    }
    else if (t.startsWith("role:")) chars = alive.filter((c) => c.roles.includes(t.slice(5)));
    else if (t.startsWith("char:")) { const ch = this.char(t.slice(5)); if (ch && ch.status !== "dead") chars = [ch]; }
    else if (t === "roller") { const ch = this.char(this.roller); if (ch) chars = [ch]; }
    else if (t === "bound") { const ch = this.char(this.cur?.bound ?? this.boundId); if (ch) chars = [ch]; }
    else if (t === "self") { if (this.cur?.state) monsters = [this.cur]; }
    else if (t === "source") { const src = this.cur?.source != null ? this.findInst(this.cur.source) : undefined; if (src) monsters = [src]; }
    const isCharTarget = t !== "self" && t !== "source";
    if (isCharTarget && chars.length === 0 && depth < 3) {
      if (fallback) return this.targets(fallback, undefined, depth + 1);
      if (t !== "actor" && !t.startsWith("party") && t !== "random_down") return this.targets("actor", undefined, depth + 1);
    }
    return { chars, monsters };
  }

  // ---------- effects ----------
  apply(effects: Effect[] | undefined) {
    for (const e of effects ?? []) {
      if (this.s.status !== "active") return;
      this.one(e);
    }
  }

  one(e: Effect) {
    if (++this.depth > 200) throw new Error("Effect recursion limit reached");
    try { this.oneInner(e); } finally { this.depth--; }
  }

  private oneInner(e: Effect) {
    if (e.if !== undefined) {
      const ok = !!evaluate(e.if, this.ctx());
      if (e.then || e.else) { this.apply(ok ? e.then : e.else); if (!e.op && !e.roll) return; }
      else if (!ok) return;
    }
    if (e.roll) {
      const r = this.doRoll(e.roll);
      this.apply(r.success ? e.success : e.fail);
      if (!e.op) return;
    }
    if (!e.op) return;
    const T = () => this.targets(e.target, e.fallback);
    switch (e.op) {
      case "damage": {
        const amt = Math.max(0, this.amount(e.value));
        const { chars, monsters } = T();
        for (const ch of chars) this.damageChar(ch, amt);
        for (const m of monsters) this.damageMonster(m, amt);
        break;
      }
      case "heal": {
        const amt = Math.max(0, this.amount(e.value));
        const { chars, monsters } = T();
        for (const ch of chars) {
          if (ch.status === "dead") continue;
          const before = ch.hp;
          ch.hp = Math.min(ch.maxHp, ch.hp + amt);
          if (ch.hp !== before) this.events.push({ type: "heal", who: ch.id, amount: ch.hp - before });
        }
        for (const m of monsters) {
          const max = this.tpl(m.tid)?.tracked?.hp ?? Infinity;
          m.state!.hp = Math.min(max, (m.state!.hp ?? 0) + amt);
        }
        break;
      }
      case "addExp": {
        const amt = Math.max(0, this.amount(e.value));
        const dead = this.s.chars.filter((c) => c.status === "dead").length;
        const gain = amt + Math.floor(amt * this.c.config.catchUpPerDead * dead);
        const chars = this.targets(e.target ?? "party_alive", e.fallback).chars.filter((c) => c.status === "alive");
        for (const ch of chars) this.gainExp(ch, gain);
        if (chars.length) this.events.push({ type: "exp", amount: gain });
        break;
      }
      case "addGold": {
        const amt = this.amount(e.value);
        const before = this.s.gold;
        this.s.gold = Math.max(0, this.s.gold + amt);
        if (this.s.gold !== before) this.events.push({ type: "gold", amount: this.s.gold - before });
        break;
      }
      case "setFlag": {
        if (typeof e.value === "string") this.s.flags[e.value] = true;
        else if (e.value && typeof e.value === "object") {
          for (const [k, v] of Object.entries(e.value)) this.s.flags[k] = typeof v === "string" && !isDice(v) ? evaluate(v, this.ctx()) : v;
        }
        break;
      }
      case "clearFlag": delete this.s.flags[String(e.value)]; break;
      case "setSoulOwner": for (const ch of T().chars) ch.soulOwner = String(e.value); break;
      case "clearSoulOwner": for (const ch of T().chars) delete ch.soulOwner; break;
      case "addDeck": this.addDeck(String(e.value), e.place); break;
      case "removeDeck": this.removeDeck(String(e.value)); break;
      case "spawn": this.spawn(Array.isArray(e.value) ? e.value : [String(e.value)]); break;
      case "addBuff": for (const ch of T().chars) { ch.buffs = ch.buffs.filter((b) => b.id !== e.value); ch.buffs.push({ id: String(e.value), turns: e.turns }); } break;
      case "removeBuff": for (const ch of T().chars) ch.buffs = ch.buffs.filter((b) => b.id !== e.value); break;
      case "addActionMod": for (const ch of T().chars) { const mod = { ...(e.value as ActionMod), id: this.render(String(e.value?.id), this.cur) }; ch.actionMods = ch.actionMods.filter((m) => m.id !== mod.id); ch.actionMods.push(mod); } break;
      case "removeActionMod": for (const ch of T().chars) ch.actionMods = ch.actionMods.filter((m) => m.id !== e.value); break;
      case "modifyStat": {
        const amt = this.amount(e.value);
        const { chars, monsters } = T();
        const stat = e.stat ?? "hp";
        for (const ch of chars) {
          if (stat.startsWith("mods.")) { const k = stat.slice(5); ch.mods[k] = (ch.mods[k] ?? 0) + amt; }
          else if (stat === "maxHp" || stat === "ac" || stat === "hp" || stat === "exp") {
            if (stat === "exp") this.gainExp(ch, amt); else (ch as any)[stat] += amt;
          }
        }
        for (const m of monsters) m.state![stat] = (m.state![stat] ?? 0) + amt;
        break;
      }
      case "setStat": {
        const { monsters } = T();
        for (const m of monsters) m.state![e.stat ?? "hp"] = typeof e.value === "number" ? e.value : evaluate(String(e.value), this.ctx());
        break;
      }
      case "resurrect": {
        const hp = e.hp != null ? this.amount(e.hp) : 1;
        for (const ch of this.targets(e.target ?? "bound", e.fallback).chars.concat(this.deadTargets(e.target))) this.resurrect(ch, hp, e.keepOwner);
        break;
      }
      case "resurrectIn":
      case "resurrectAtLayer": {
        const id = this.targetId(e.target);
        if (!id) break;
        const hp = e.hp != null ? this.amount(e.hp) : 1;
        this.s.pending.push(e.op === "resurrectIn" ? { charId: id, turns: e.turns ?? 1, hp, keepOwner: e.keepOwner } : { charId: id, layer: e.layer ?? this.s.layer - 1, hp, keepOwner: e.keepOwner });
        break;
      }
      case "replaceWith": {
        const id = this.targetId(e.target);
        const def = this.c.characters.find((d) => d.id === e.value);
        const ch = this.char(id);
        if (!ch || !def) break;
        const fresh = makeChar(def);
        fresh.level = ch.level; fresh.exp = ch.exp;
        const idx = this.s.chars.indexOf(ch);
        fresh.id = `${def.id}#${this.s.nextIid++}`;
        this.s.chars.splice(idx, 1, fresh);
        this.s.order = this.s.order.map((o) => (o === ch.id ? fresh.id : o));
        this.log(`${ch.name} is gone. ${fresh.name} takes their place.`);
        break;
      }
      case "moveInTurnOrder": for (const ch of T().chars) this.moveInTurnOrder(ch, Number(e.value ?? 0)); break;
      case "rollInitiative": this.rollInitiative(); break;
      case "useAction": this.useAction(String(e.value) as ActionSlot); break;
      case "monsterStrike": this.monsterStrike(e.target); break;
      case "text": this.log(this.render(String(e.value), this.cur)); break;
      case "endLayer": this.endLayer(); break;
      case "endRun": this.s.status = e.outcome === "lost" ? "lost" : "won"; this.s.endingId = String(e.value ?? "escape"); break;
      default: this.log(`(unknown op "${e.op}")`, false);
    }
  }

  deadTargets(target?: string): CharState[] {
    // resurrect can target dead characters, which normal targeting skips.
    if (!target || target === "bound") return [];
    if (target.startsWith("char:")) { const ch = this.char(target.slice(5)); return ch && ch.status === "dead" ? [ch] : []; }
    if (target === "random_dead") { const d = this.s.chars.filter((c) => c.status === "dead"); return d.length ? [d[randInt(this.s, 0, d.length - 1)]] : []; }
    return [];
  }

  targetId(target?: string): string | undefined {
    const t = target ?? "bound";
    if (t === "bound") return this.cur?.bound ?? this.boundId;
    if (t.startsWith("char:")) return t.slice(5);
    return this.targets(t).chars[0]?.id;
  }

  resurrect(ch: CharState, hp: number, keepOwner?: boolean) {
    if (ch.status === "alive") return;
    ch.hp = Math.max(1, Math.min(ch.maxHp, hp));
    ch.status = "alive";
    if (!keepOwner) delete ch.soulOwner;
    this.events.push({ type: "resurrect", who: ch.id });
    this.log(`${ch.name} returns to the fight.`);
  }

  damageChar(ch: CharState, amt: number) {
    if (ch.status === "dead" || amt <= 0) return;
    ch.hp -= amt;
    this.events.push({ type: "damage", who: ch.id, amount: amt });
  }

  damageMonster(m: Instance, amt: number) {
    const t = this.tpl(m.tid);
    if (!m.state) return;
    const dmg = t?.tags?.includes("minion") ? Math.max(amt, m.state.hp ?? 1) : amt;
    m.state.hp = (m.state.hp ?? 0) - dmg;
    this.events.push({ type: "damage", who: t?.name ?? m.tid, amount: dmg, monster: true });
  }

  gainExp(ch: CharState, amt: number) {
    ch.exp += amt;
    const lv = levelFor(this.c.config.levels, ch.exp);
    while (ch.level < lv) {
      ch.level++;
      this.events.push({ type: "levelUp", who: ch.id, level: ch.level });
      this.log(`${ch.name} reaches level ${ch.level}!`, false);
      this.levelQueue.push(ch.id);
    }
  }

  doRoll(spec: RollSpec, defaults: Partial<RollSpec> = {}): RollResult {
    const sp = { ...defaults, ...spec };
    const who = sp.who === "none" ? undefined : this.targets(sp.who ?? "actor").chars[0];
    const dice = sp.dice ?? "1d20";
    const { total: raw, natural } = rollDice(this.s, dice);
    const mod = sp.mod ? (who?.mods[sp.mod] ?? 0) : 0;
    const bonus = this.amount(sp.bonus);
    const vs = typeof sp.vs === "number" ? sp.vs : Math.round(evalNum(String(sp.vs), this.ctx()));
    const total = raw + mod + bonus;
    const isD20 = /^1?d20$/i.test(dice.trim());
    const crit = isD20 && natural === 20;
    const fumble = isD20 && natural === 1;
    const success = crit ? true : fumble ? false : total >= vs;
    const r: RollResult = { who: who?.id, label: sp.label, natural, total, vs, success, margin: total - vs, crit, fumble, visible: sp.visible !== false };
    this.s.lastRoll = r;
    if (who) this.roller = who.id;
    this.events.push({ type: "roll", roll: r });
    return r;
  }

  effectiveAction(ch: CharState, slot: ActionSlot): (ActionDef & { mods: ActionMod[] }) | undefined {
    const base = ch.actions[slot];
    if (!base) return undefined;
    const mods = ch.actionMods.filter((m) => m.action === slot);
    const label = [...mods].reverse().find((m) => m.label)?.label ?? base.label;
    return { ...base, label, mods };
  }

  useAction(slot: ActionSlot) {
    const a = this.actor();
    if (!a) return;
    const act = this.effectiveAction(a, slot);
    if (!act) { this.log(`${a.name} hesitates.`); return; }
    const toHit = (act.bonus ?? 0) + act.mods.reduce((s, m) => s + (m.toHit ?? 0), 0);
    if (slot === "attackLeft" || slot === "attackRight") {
      const target = this.cur?.state ? this.cur : null;
      if (!target) { this.log(`${a.name} swings at nothing.`); return; }
      const r = this.doRoll({ mod: act.stat, bonus: toHit, vs: target.state!.ac ?? 10, label: act.label, who: "actor" });
      if (!r.success) { this.log(`${a.name}'s ${act.label} misses.`); return; }
      const times = r.crit ? 2 : 1;
      let dmg = (act.damage ? rollDice(this.s, act.damage, times).total : 0) + (a.mods[act.stat] ?? 0);
      for (const m of act.mods) if (m.damage) dmg += rollDice(this.s, m.damage, times).total;
      this.damageMonster(target, Math.max(1, dmg));
      this.apply(act.onHit);
      for (const m of act.mods) this.apply(m.onHit);
    } else {
      const src = this.cur?.source != null ? this.findInst(this.cur.source) : undefined;
      if (!src?.state) { this.log(`${a.name} braces, but nothing comes.`); return; }
      const r = this.doRoll({ mod: act.stat, bonus: toHit, vs: 10 + (src.state.attack ?? 0), label: act.label, who: "actor" });
      const dmg = rollDice(this.s, String(src.state.damage ?? "1d4")).total;
      if (r.success) {
        if (act.half) { this.damageChar(a, Math.floor(dmg / 2)); this.log(`${a.name} takes a glancing blow.`); }
        else this.log(`${a.name} avoids the attack.`);
      } else { this.damageChar(a, dmg); this.log(`${a.name} is hit for ${dmg}.`); }
    }
  }

  monsterStrike(target?: string) {
    const src = this.cur?.source != null ? this.findInst(this.cur.source) : this.cur?.state ? this.cur : undefined;
    if (!src?.state) return;
    const name = this.monsterView(src)?.name;
    for (const ch of this.targets(target ?? "actor").chars) {
      const r = this.doRoll({ dice: "1d20", bonus: src.state.attack ?? 0, vs: ch.ac, who: "none", label: `${name} attacks ${ch.name}` });
      if (r.success) { const dmg = rollDice(this.s, String(src.state.damage ?? "1d4"), r.crit ? 2 : 1).total; this.damageChar(ch, dmg); this.log(`${name} hits ${ch.name} for ${dmg}.`); }
      else this.log(`${name} misses ${ch.name}.`);
    }
  }

  // ---------- statuses, death, rules ----------
  statusFor(hp: number): CharStatus {
    if (hp > this.c.config.downAt) return "alive";
    if (hp > this.c.config.deadAt) return "down";
    return "dead";
  }

  processStatus() {
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const ch of [...this.s.chars]) {
        if (ch.status === "dead") continue;
        const ns = this.statusFor(ch.hp);
        if (ns === ch.status) continue;
        changed = true;
        ch.status = ns;
        this.events.push({ type: "status", who: ch.id, status: ns });
        if (ns === "down") this.log(`${ch.name} falls and can still be saved.`);
        if (ns === "dead") this.handleDeath(ch);
      }
      while (this.levelQueue.length) {
        changed = true;
        const id = this.levelQueue.shift()!;
        this.fireRules("levelUp", id);
      }
      if (!changed) break;
    }
  }

  handleDeath(ch: CharState) {
    const owner = ch.soulOwner ? this.c.soulOwners.find((o) => o.id === ch.soulOwner) : undefined;
    this.events.push({ type: "death", who: ch.id, soulOwner: owner?.id });
    const prevBound = this.boundId, prevCur = this.cur, prevSrc = this.spawnSrc;
    this.boundId = ch.id; this.cur = null; this.spawnSrc = { inst: null };
    try {
      if (owner) { this.log(`${ch.name} dies. ${owner.name} collects.`); this.apply(owner.onDeath); }
      else this.log(`${ch.name} is dead.`);
    } finally { this.boundId = prevBound; this.cur = prevCur; this.spawnSrc = prevSrc; }
    this.fireRules("death", ch.id);
  }

  fireRules(trigger: string, boundId?: string) {
    for (const rule of this.c.rules) {
      if (rule.trigger !== trigger) continue;
      if (rule.once && this.s.firedRules.includes(rule.id)) continue;
      const prevBound = this.boundId, prevCur = this.cur, prevSrc = this.spawnSrc;
      this.boundId = boundId; this.cur = null; this.spawnSrc = { spawns: rule.spawns, inst: null };
      try {
        if (!this.test(rule.conditions, null)) continue;
        if (rule.once) this.s.firedRules.push(rule.id);
        this.apply(rule.actions);
      } finally { this.boundId = prevBound; this.cur = prevCur; this.spawnSrc = prevSrc; }
    }
  }

  tickTurn() {
    for (const ch of this.s.chars) {
      ch.buffs = ch.buffs.filter((b) => b.turns === undefined || --b.turns > 0);
    }
    const due: typeof this.s.pending = [];
    this.s.pending = this.s.pending.filter((p) => {
      if (p.turns === undefined) return true;
      if (--p.turns <= 0) { due.push(p); return false; }
      return true;
    });
    for (const p of due) { const ch = this.char(p.charId); if (ch) this.resurrect(ch, p.hp, p.keepOwner); }
  }

  endLayer() {
    if (this.s.status !== "active") return;
    this.fireRules("layerEnd");
    if (this.s.status === "active") { this.s.status = "layerComplete"; this.log(`Layer ${this.s.layer} cleared.`); }
  }

  checkEnd() {
    if (this.s.status !== "active") return;
    const anyAlive = this.s.chars.some((c) => c.status === "alive");
    if (!anyAlive && this.s.pending.length === 0) { this.s.status = "lost"; this.s.endingId = "wiped"; this.log("The party has fallen. The Hells keep them."); }
  }

  // ---------- drawing and choosing ----------
  fizzles(inst: Instance, t: CardTemplate): boolean {
    if (t.kind !== "monsterAttack" || inst.source == null) return false;
    return this.s.deadMonsters.includes(inst.source) || !this.s.draw.some((i) => i.iid === inst.source);
  }

  drawNext() {
    let failures = 0;
    while (this.s.status === "active") {
      if (this.s.draw.length === 0) { this.endLayer(); return; }
      const inst = this.s.draw.shift()!;
      const t = this.tpl(inst.tid);
      if (!t) continue;
      if (this.s.onceSeen.includes(t.id)) continue;
      if (this.fizzles(inst, t)) continue;
      if (inst.bound && this.char(inst.bound)?.status === "dead") continue;
      if (!this.test(t.conditions, inst)) {
        this.s.draw.push(inst);
        if (++failures > this.s.draw.length) { this.endLayer(); return; }
        continue;
      }
      this.s.current = inst;
      this.s.seen[t.id] = (this.s.seen[t.id] ?? 0) + 1;
      return;
    }
  }

  choiceFor(t: CardTemplate, side: "left" | "right"): Choice {
    const own = side === "left" ? t.left : t.right;
    if (own) return own;
    const a = this.actor();
    const kind = t.kind ?? "event";
    if (kind === "monster" || kind === "boss") {
      const slot: ActionSlot = side === "left" ? "attackLeft" : "attackRight";
      const act = a && this.effectiveAction(a, slot);
      return { label: act?.label ?? (side === "left" ? "Attack" : "Attack"), effects: [{ op: "useAction", value: slot }] };
    }
    if (kind === "monsterAttack") {
      const slot: ActionSlot = side === "left" ? "defenceLeft" : "defenceRight";
      const act = a && this.effectiveAction(a, slot);
      if (act) return { label: act.label, effects: [{ op: "useAction", value: slot }] };
      return { label: side === "left" ? "Brace" : "Take it", effects: [{ op: "monsterStrike", target: "actor" }] };
    }
    return { label: side === "left" ? "No" : "Yes", effects: [] };
  }

  resolveAfterPlay(inst: Instance, t: CardTemplate) {
    const ap = t.afterPlay ?? "discard";
    this.spawnSrc = { spawns: t.spawns, inst };
    let disposal: string = "discard";
    let place: Placement | undefined;
    let reinserted = false;
    if (typeof ap === "string") disposal = ap;
    else {
      const branch = ap.find((b) => b.else || (b.if !== undefined && !!evaluate(b.if, this.ctx(inst))) || (b.if === undefined && !b.else));
      if (branch) {
        this.apply(branch.effects);
        disposal = branch.do ?? "discard";
        place = branch.place;
        if (branch.spawn?.length) {
          const batch = new Map<string, number[]>();
          // Reinsert self first when requeueing so spawns can be placed relative to it.
          if (disposal === "requeue") { this.insert(inst, place ?? "shuffle", batch); reinserted = true; batch.set("self", [inst.iid]); }
          this.spawn(branch.spawn, batch);
          reinserted ||= this.s.draw.some((i) => i.iid === inst.iid);
        }
      }
    }
    if (!reinserted) {
      if (disposal === "requeue") { this.insert(inst, place ?? "shuffle"); reinserted = true; }
      else if (disposal === "reshuffle") { this.insert(this.freshCopy(inst), "shuffle"); reinserted = true; }
      else if (disposal === "once") { if (!this.s.onceSeen.includes(t.id)) this.s.onceSeen.push(t.id); }
    }
    if (!reinserted && inst.state && (t.kind === "monster" || t.kind === "boss")) {
      if ((inst.state.hp ?? 0) <= 0) {
        this.s.deadMonsters.push(inst.iid);
        if (this.s.deadMonsters.length > 200) this.s.deadMonsters.splice(0, 100);
        this.events.push({ type: "monsterDefeated", name: t.name ?? t.id });
      }
    }
  }

  freshCopy(inst: Instance): Instance {
    return this.newInst(inst.tid, { deck: inst.deck, source: inst.source, bound: inst.bound });
  }

  choose(side: "left" | "right") {
    if (this.s.status !== "active") throw new Error("Run is not active");
    const inst = this.s.current;
    if (!inst) throw new Error("No card to play");
    const t = this.tpl(inst.tid);
    this.s.current = null;
    this.s.turn++;
    if (t) {
      this.cur = inst;
      this.spawnSrc = { spawns: t.spawns, inst };
      const choice = this.choiceFor(t, side);
      this.apply(choice.effects);
      if (this.s.status === "active") this.resolveAfterPlay(inst, t);
      this.cur = null;
      this.spawnSrc = { inst: null };
    }
    this.processStatus();
    if (this.s.status === "active") this.fireRules("afterChoice");
    this.processStatus();
    this.tickTurn();
    this.advanceActor();
    this.checkEnd();
    if (this.s.status === "active") this.drawNext();
  }

  start() {
    this.rollInitiative();
    for (const d of this.c.decks) if (d.startActive) this.addDeck(d.id, "shuffle");
    this.events = this.events.filter((e) => e.type !== "deck");
    this.fireRules("runStart");
    this.fireRules("layerEnter");
    this.processStatus();
    this.drawNext();
  }
}

export function levelFor(levels: number[], exp: number): number {
  let lv = 0;
  for (const need of levels) if (exp >= need) lv++;
  return Math.max(1, lv);
}

export function makeChar(def: Content["characters"][number]): CharState {
  return {
    id: def.id, name: def.name, roles: [...(def.roles ?? [])], hp: def.maxHp, maxHp: def.maxHp, ac: def.ac,
    mods: { ...def.mods }, level: 1, exp: 0, status: "alive", buffs: [], actionMods: [],
    actions: JSON.parse(JSON.stringify(def.actions ?? {})),
  };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function createRun(content: Content, seed: number, opts: { onceSeen?: string[] } = {}): StepResult {
  const s: RunState = {
    version: 1, seed, rng: seed | 0, turn: 0, layer: content.config.startLayer, status: "active",
    gold: content.config.startGold, flags: {}, chars: content.characters.filter((d) => !d.reserve).map(makeChar),
    order: [], actorIdx: 0, draw: [], activeDecks: [], current: null, deadMonsters: [], pending: [], firedRules: [],
    seen: {}, onceSeen: [...(opts.onceSeen ?? [])], nextIid: 1, log: [],
  };
  const r = new Runner(content, s);
  r.start();
  return { state: s, events: r.events };
}

export function choose(content: Content, state: RunState, side: "left" | "right"): StepResult {
  const s = clone(state);
  const r = new Runner(content, s);
  r.choose(side);
  return { state: s, events: r.events };
}

export function buildView(content: Content, s: RunState): RunView {
  const r = new Runner(content, s);
  const actor = s.status === "active" ? r.actor() : undefined;
  let card: RunView["card"] = null;
  if (s.current && s.status === "active") {
    const t = r.tpl(s.current.tid);
    if (t) {
      const kind = t.kind ?? "event";
      const mv = r.monsterView(kind === "monsterAttack" && s.current.source != null ? r.findInst(s.current.source) : s.current.state ? s.current : undefined);
      card = {
        iid: s.current.iid, kind, speaker: t.speaker ? r.render(t.speaker, s.current) : undefined, name: t.name,
        text: r.render(t.text, s.current),
        left: r.render(r.choiceFor(t, "left").label, s.current),
        right: r.render(r.choiceFor(t, "right").label, s.current),
        monster: mv && mv.hp !== undefined ? { name: mv.name, hp: mv.hp, maxHp: mv.maxHp ?? mv.hp } : undefined,
        tags: t.tags ?? [],
      };
    }
  }
  const defs = new Map(content.characters.map((d) => [d.id, d]));
  return {
    status: s.status, endingId: s.endingId, turn: s.turn, layer: s.layer, gold: s.gold, deckCount: s.draw.length,
    actorId: actor?.id ?? null,
    chars: s.chars.map((ch) => {
      const def = defs.get(ch.id.split("#")[0]);
      const next = content.config.levels[ch.level];
      return {
        id: ch.id, name: ch.name, roles: ch.roles, hp: ch.hp, maxHp: ch.maxHp, ac: ch.ac, status: ch.status,
        level: ch.level, exp: ch.exp, nextLevelExp: next ?? null, soulOwner: ch.soulOwner,
        soulOwnerName: ch.soulOwner ? content.soulOwners.find((o) => o.id === ch.soulOwner)?.name ?? ch.soulOwner : undefined,
        buffs: ch.buffs.map((b) => b.id), isActor: actor?.id === ch.id, color: def?.color, sound: def?.sound,
        pendingRes: s.pending.some((p) => p.charId === ch.id),
      };
    }),
    card,
    log: s.log.slice(-12),
  };
}
