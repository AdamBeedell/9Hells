import type { GameEvent, RunView } from "../engine/types";
import { api, ApiError, type Me } from "./api";
import { clear, h, toast } from "./dom";
import { diceTick, hitThud, isMuted, levelUpChime, setMuted } from "./audio";

const LAYERS: Record<number, { name: string; lord: string }> = {
  1: { name: "Avernus", lord: "Zariel" },
  2: { name: "Dis", lord: "Dispater" },
  3: { name: "Minauros", lord: "Mammon" },
  4: { name: "Phlegethos", lord: "Belial and Fierna" },
  5: { name: "Stygia", lord: "Levistus" },
  6: { name: "Malbolge", lord: "Glasya" },
  7: { name: "Maladomini", lord: "Baalzebul" },
  8: { name: "Cania", lord: "Mephistopheles" },
  9: { name: "Nessus", lord: "Asmodeus" },
};

const ROLE_GLYPH: Record<string, string> = { fighter: "⚔", cleric: "✚", rogue: "🗡", wizard: "✦", demon: "♆" };

interface Ctx { me: Me; onAdmin: () => void; onLogout: () => void }

export function mountGame(root: HTMLElement, ctx: Ctx) {
  let view: RunView | null = null;
  let busy = false;
  const chronicle: { text: string; kind: string }[][] = [];
  const prevLevels = new Map<string, number>();

  const ladder = h("ol.ladder", { "aria-label": "Layers of the Nine Hells" });
  const party = h("section.party", { "aria-label": "Party" });
  const stage = h("section.stage");
  const choices = h("section.choices");
  const feed = h("ol.feed", { "aria-live": "polite" });
  const status = h("div.status");

  const fileInput = h("input", { type: "file", accept: "application/json,.json", hidden: true }) as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (!f) return;
    try {
      const save = JSON.parse(await f.text());
      const res = await api.importSave(save);
      chronicle.length = 0;
      push({ text: "Save imported.", kind: "sys" }, true);
      apply(res.view, []);
    } catch (e: any) { toast(e instanceof ApiError ? e.message : "That file isn't valid JSON.", "error"); }
  });

  const soundBtn = h("button.ghost", { type: "button", onClick: () => { setMuted(!isMuted()); soundBtn.textContent = isMuted() ? "Sound off" : "Sound on"; } }, isMuted() ? "Sound off" : "Sound on");
  const menu = h("nav.menu", {},
    h("button.ghost", { type: "button", onClick: () => newRun(true) }, "New run"),
    h("button.ghost", { type: "button", onClick: exportSave }, "Export save"),
    h("button.ghost", { type: "button", onClick: () => fileInput.click() }, "Import save"),
    soundBtn,
    ctx.me.isAdmin ? h("button.ghost", { type: "button", onClick: ctx.onAdmin }, "Edit content") : null,
    h("button.ghost", { type: "button", onClick: ctx.onLogout }, `Log out ${ctx.me.username}`),
    fileInput,
  );

  clear(root);
  root.append(h("div.game", {},
    h("aside.side", {}, h("h1.wordmark", {}, "9Hells"), ladder),
    h("main.table", {}, status, party, stage, choices),
    h("aside.chronicle", {}, h("h2", {}, "Chronicle"), feed, menu),
  ));

  /** Lines are grouped per turn: newest turn first, lines within a turn in the order they happened. */
  function push(line: { text: string; kind: string }, newGroup = false) {
    if (newGroup || !chronicle.length) chronicle.push([]);
    chronicle[chronicle.length - 1].push(line);
    if (chronicle.length > 25) chronicle.splice(0, chronicle.length - 25);
  }

  const name = (id?: string) => view?.chars.find((c) => c.id === id)?.name ?? id ?? "Someone";

  function describe(e: GameEvent): { text: string; kind: string } | null {
    switch (e.type) {
      case "roll": {
        if (!e.roll.visible) return null;
        const r = e.roll;
        const who = r.who ? name(r.who) : "";
        const lbl = r.label ? `${r.label}: ` : "";
        const verdict = r.crit ? "critical!" : r.fumble ? "fumble." : r.success ? "success." : "failure.";
        return { text: `${lbl}${who ? who + " rolls " : "rolled "}${r.total} (d20 showed ${r.natural}) against ${r.vs}, ${verdict}`, kind: r.success ? "roll good" : "roll bad" };
      }
      case "damage": return e.monster ? { text: `${e.who} takes ${e.amount}.`, kind: "hit" } : { text: `${name(e.who)} loses ${e.amount} HP.`, kind: "hurt" };
      case "heal": return { text: `${name(e.who)} recovers ${e.amount} HP.`, kind: "heal" };
      case "levelUp": return { text: `${name(e.who)} reaches level ${e.level}.`, kind: "level" };
      case "death": return null; // the engine's text event covers it
      case "status": return e.status === "down" ? null : null;
      case "resurrect": return null;
      case "deck": return { text: e.added ? `New cards enter the deck (${e.deck}).` : `Cards leave the deck (${e.deck}).`, kind: "sys" };
      case "monsterDefeated": return { text: `The ${e.name} is destroyed.`, kind: "good" };
      case "gold": return { text: e.amount > 0 ? `+${e.amount} gold.` : `${e.amount} gold.`, kind: "gold" };
      case "exp": return { text: `+${e.amount} EXP to everyone standing.`, kind: "exp" };
      case "text": return { text: e.text, kind: "text" };
    }
  }

  function apply(v: RunView | null, events: GameEvent[]) {
    const before = view;
    view = v;
    for (const e of events) { const d = describe(e); if (d) push(d); }
    render(before, events);
  }

  function render(before: RunView | null, events: GameEvent[]) {
    renderLadder();
    renderStatus();
    renderParty(before, events);
    renderStage();
    renderFeed();
    // sound
    if (events.some((e) => e.type === "roll" && e.roll.visible)) diceTick();
    if (events.some((e) => e.type === "damage" && !e.monster)) hitThud();
  }

  function renderLadder() {
    clear(ladder);
    const current = view?.layer ?? 9;
    ladder.append(h("li.rung.out", {}, h("span.num", {}, ""), h("span.lname", {}, "Out")));
    for (let n = 1; n <= 9; n++) {
      const l = LAYERS[n];
      const state = n === current ? "here" : n > current ? "behind" : "ahead";
      ladder.append(h(`li.rung.${state}`, { "aria-current": n === current ? "step" : null, title: `Ruled by ${l.lord}` },
        h("span.num", {}, String(n)), h("span.lname", {}, l.name)));
    }
  }

  function renderStatus() {
    clear(status);
    if (!view) return;
    status.append(
      h("span.stat", { title: "Party gold" }, h("b", {}, String(view.gold)), " gold"),
      h("span.stat", { title: "Cards left in the deck" }, h("b", {}, String(view.deckCount)), " cards left"),
      h("span.stat", { title: "Turn" }, "Turn ", h("b", {}, String(view.turn))),
    );
  }

  function renderParty(before: RunView | null, events: GameEvent[]) {
    clear(party);
    if (!view) return;
    const levelled = events.filter((e) => e.type === "levelUp").map((e) => (e as any).who as string);
    let chimeIdx = 0;
    const order = [...new Set(levelled)];
    view.chars.forEach((c) => {
      const prev = before?.chars.find((p) => p.id === c.id);
      const hpPct = Math.max(0, Math.min(100, (c.hp / c.maxHp) * 100));
      const glyph = ROLE_GLYPH[c.roles[0]] ?? c.name[0];
      const isLevel = order.includes(c.id);
      const med = h(`div.medallion.${c.status}`, {
        style: { "--tint": c.color ?? "#9a7b4f" },
        class: [c.isActor ? "actor" : "", isLevel ? "levelled" : ""].join(" "),
        tabindex: 0,
        "aria-label": `${c.name}, ${c.status}, ${c.hp} of ${c.maxHp} HP, level ${c.level}${c.isActor ? ", acting now" : ""}${c.soulOwnerName ? `, soul owned by ${c.soulOwnerName}` : ""}`,
      },
        h("div.disc", {}, c.status === "dead" ? "☠" : glyph),
        c.soulOwner ? h("span.chain", { title: `Soul owned by ${c.soulOwnerName}` }, "⛓") : null,
        h("span.lvl", { title: `${c.exp} EXP${c.nextLevelExp ? ` / ${c.nextLevelExp} for next level` : ""}` }, `Lv ${c.level}`),
        h("div.cname", {}, c.name),
        h("div.hp", { title: `${c.hp} / ${c.maxHp} HP` }, h("i", { style: { width: `${hpPct}%` } })),
        h("div.hpnum", {}, c.status === "dead" ? (c.pendingRes ? "Returning…" : "Dead") : c.status === "down" ? `Down (${c.hp})` : `${c.hp} / ${c.maxHp}`),
      );
      party.append(med);
      // floating numbers
      const dmg = events.filter((e) => e.type === "damage" && !e.monster && e.who === c.id).reduce((s, e: any) => s + e.amount, 0);
      const heal = events.filter((e) => e.type === "heal" && e.who === c.id).reduce((s, e: any) => s + e.amount, 0);
      if (dmg) med.append(h("span.float.bad", {}, `−${dmg}`));
      if (heal) med.append(h("span.float.good", { style: { animationDelay: dmg ? "0.35s" : "0s" } }, `+${heal}`));
      if (isLevel) {
        levelUpChime(c.sound?.semitone ?? 0, (c.sound?.wave ?? "triangle") as OscillatorType, chimeIdx++);
        setTimeout(() => med.classList.remove("levelled"), 1800);
      }
      if (prev && prev.level !== c.level) prevLevels.set(c.id, c.level);
    });
  }

  function renderStage() {
    clear(stage); clear(choices);
    if (!view) {
      stage.append(h("div.empty", {},
        h("p", {}, "Your party wakes in Nessus, the deepest layer of the Hells. The only way out is up."),
        h("button.primary", { type: "button", onClick: () => newRun(false) }, "Start the climb")));
      return;
    }
    if (view.status !== "active" || !view.card) {
      const t = view.status === "lost"
        ? { h: "The Hells keep you", p: "Your whole party has fallen. Start again from Nessus." }
        : view.status === "won"
          ? { h: "You escaped", p: `Ending: ${view.endingId ?? "escape"}.` }
          : { h: `${LAYERS[view.layer]?.name ?? "This layer"} is behind you`, p: "That's the end of the v0.1 demo. Later versions will carry on to the next layer up." };
      stage.append(h(`div.ending.${view.status}`, {}, h("h2", {}, t.h), h("p", {}, t.p),
        h("button.primary", { type: "button", onClick: () => newRun(false) }, "Start a new run")));
      return;
    }
    const card = view.card;
    const actor = view.chars.find((c) => c.isActor);
    const overlay = h("div.verdict", { "aria-hidden": "true" });
    const el = h(`article.card.${card.kind}`, { tabindex: 0, "aria-label": "Current card. Use the left and right arrow keys to choose." },
      overlay,
      card.speaker ? h("header.speaker", {}, h("span.seal", { "aria-hidden": "true" }, card.speaker.replace(/^(an?|the)\s+/i, "")[0]?.toUpperCase()), h("span", {}, card.speaker)) : null,
      card.monster ? h("div.foe", {},
        h("div.foename", {}, card.kind === "monsterAttack" ? `${card.monster.name} attacks` : card.monster.name),
        h("div.foehp", { title: `${card.monster.hp} / ${card.monster.maxHp} HP` }, h("i", { style: { width: `${Math.max(0, (card.monster.hp / card.monster.maxHp) * 100)}%` } })),
      ) : null,
      h("p.text", {}, card.text),
      actor ? h("footer.turn", {}, `${actor.name} acts`) : null,
    );
    stage.append(el);

    const preview = (side: "left" | "right" | null) => {
      el.classList.toggle("lean-left", side === "left");
      el.classList.toggle("lean-right", side === "right");
      overlay.textContent = side ? (side === "left" ? card.left : card.right) : "";
    };
    const L = h("button.choice.left", { type: "button", onClick: () => pick("left"), onMouseenter: () => preview("left"), onMouseleave: () => preview(null), onFocus: () => preview("left"), onBlur: () => preview(null) },
      h("kbd", {}, "←"), h("span", {}, card.left));
    const R = h("button.choice.right", { type: "button", onClick: () => pick("right"), onMouseenter: () => preview("right"), onMouseleave: () => preview(null), onFocus: () => preview("right"), onBlur: () => preview(null) },
      h("span", {}, card.right), h("kbd", {}, "→"));
    choices.append(L, R);

    // drag / swipe
    let startX: number | null = null;
    el.addEventListener("pointerdown", (ev) => { startX = ev.clientX; el.setPointerCapture(ev.pointerId); el.classList.add("dragging"); });
    el.addEventListener("pointermove", (ev) => {
      if (startX == null) return;
      const dx = ev.clientX - startX;
      el.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
      preview(dx < -30 ? "left" : dx > 30 ? "right" : null);
    });
    const end = (ev: PointerEvent) => {
      if (startX == null) return;
      const dx = ev.clientX - startX;
      startX = null;
      el.classList.remove("dragging");
      el.style.transform = "";
      if (dx < -90) pick("left"); else if (dx > 90) pick("right"); else preview(null);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  function renderFeed() {
    clear(feed);
    chronicle.slice().reverse().forEach((group, gi) => {
      feed.append(h(`li.turn-group${gi === 0 ? ".latest" : ""}`, {},
        h("ol", {}, group.map((line) => h(`li.${line.kind.split(" ").map((k) => "k-" + k).join(".")}`, {}, line.text)))));
    });
  }

  async function pick(side: "left" | "right") {
    if (busy || !view || view.status !== "active") return;
    busy = true;
    const el = stage.querySelector(".card");
    el?.classList.add(side === "left" ? "fly-left" : "fly-right");
    try {
      const res = await api.choose(side, view.turn);
      const card = view.card;
      if (card) push({ text: `${card.left === card.right ? card.left : side === "left" ? card.left : card.right}`, kind: "choice" }, true);
      await new Promise((r) => setTimeout(r, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160));
      apply(res.view, res.events);
    } catch (e: any) {
      if (e instanceof ApiError && e.body?.view) apply(e.body.view, []);
      else render(view, []);
      toast(e.message ?? "Something went wrong", "error");
    } finally { busy = false; }
  }

  async function newRun(confirmFirst: boolean) {
    if (confirmFirst && view?.status === "active" && !window.confirm("Abandon the current run and start a new one?")) return;
    try {
      const res = await api.newRun();
      chronicle.length = 0;
      push({ text: "The climb begins in Nessus.", kind: "sys" }, true);
      apply(res.view, res.events);
    } catch (e: any) { toast(e.message, "error"); }
  }

  async function exportSave() {
    try {
      const save = await api.exportSave();
      const blob = new Blob([JSON.stringify(save, null, 2)], { type: "application/json" });
      const a = h("a", { href: URL.createObjectURL(blob), download: `9hells-save-turn${save.state.turn}.json` }) as HTMLAnchorElement;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e: any) { toast(e.message, "error"); }
  }

  const onKey = (ev: KeyboardEvent) => {
    if (!root.isConnected) { window.removeEventListener("keydown", onKey); return; }
    if ((ev.target as HTMLElement)?.closest("input, textarea")) return;
    if (ev.key === "ArrowLeft") { ev.preventDefault(); pick("left"); }
    if (ev.key === "ArrowRight") { ev.preventDefault(); pick("right"); }
  };
  window.addEventListener("keydown", onKey);

  api.run().then((res) => apply(res.view, [])).catch((e) => toast(e.message, "error"));
}
