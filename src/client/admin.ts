import type { Content } from "../engine/types";
import { api, ApiError, type Issue } from "./api";
import { clear, h, toast } from "./dom";

type Coll = "cards" | "decks" | "rules" | "characters" | "soulOwners" | "config";
const TABS: { id: Coll; label: string }[] = [
  { id: "cards", label: "Cards" },
  { id: "decks", label: "Decks" },
  { id: "rules", label: "Rules" },
  { id: "characters", label: "Characters" },
  { id: "soulOwners", label: "Soul owners" },
  { id: "config", label: "Settings" },
];

const BLANK: Record<Exclude<Coll, "config">, () => any> = {
  cards: () => ({ id: "new_card", text: "Describe the situation. {actor} is acting.", left: { label: "No", effects: [] }, right: { label: "Yes", effects: [] } }),
  decks: () => ({ id: "new_deck", name: "New deck", cards: [] }),
  rules: () => ({ id: "new_rule", trigger: "afterChoice", once: true, conditions: ["flags.example"], actions: [{ op: "text", value: "Something happens." }] }),
  characters: () => ({ id: "new_char", name: "New character", roles: [], maxHp: 10, ac: 12, mods: { str: 0, dex: 0, wis: 0 }, actions: {} }),
  soulOwners: () => ({ id: "new_owner", name: "New soul owner", onDeath: [{ op: "resurrectIn", target: "bound", turns: 3, hp: 3 }] }),
};

const REFERENCE = `Effect ops
  damage, heal, addExp, addGold, setFlag, clearFlag, setSoulOwner, clearSoulOwner,
  addDeck, removeDeck, spawn, addBuff, removeBuff, addActionMod, removeActionMod,
  modifyStat, setStat, resurrect, resurrectIn, resurrectAtLayer, replaceWith,
  moveInTurnOrder, rollInitiative, useAction, monsterStrike, text, endLayer, endRun

Rolls
  { "roll": { "mod": "dex", "vs": 13, "who": "actor", "visible": true },
    "success": [...], "fail": [...] }

Conditions on an effect
  { "if": "gold >= 10", "then": [...], "else": [...] }

Targets
  actor, actor+1, actor-1, party, party_alive, party_not_dead, random_alive,
  random_down, random_dead, lowest_hp, highest_hp, role:cleric, char:fighter,
  roller, bound, self (this monster), source (monster behind an attack card)
  Add "fallback": "<target>" to any effect. With none set, it falls back to actor.

Placement (spawns, requeue, addDeck)
  "top", "bottom", "shuffle", { "at": 4 }, { "shuffleTop": 3 },
  { "shuffleTop": [1, 3] }, { "below": "counter", "within": [2, 4] }

afterPlay
  "discard" (default), "reshuffle", "once", or branches:
  [ { "if": "self.hp <= 0", "do": "discard", "effects": [...] },
    { "else": true, "do": "discard", "spawn": ["counter", "self"] } ]

Expressions can read
  self.*, source.*, actor.*, bound.*, chars.<id>.*, party.alive/down/dead/size/
  maxLevel/minLevel, gold, turn, layer, flags.*, decks.<id>, seen.<cardId>,
  lastRoll.total/margin/crit, and min/max/floor/ceil/abs/round.

Text placeholders
  "{actor} hits {self.name} ({self.hp} HP left)"`;

export async function mountAdmin(root: HTMLElement, onBack: () => void) {
  clear(root);
  root.append(h("div.admin-loading", {}, "Loading content…"));
  let draft: Content;
  let issues: Issue[] = [];
  try { const r = await api.adminContent(); draft = r.content; issues = r.issues; }
  catch (e: any) { toast(e.message, "error"); onBack(); return; }

  let tab: Coll = "cards";
  let sel = 0;
  let filter = "";
  const dirty = new Set<Coll>();

  const tabsEl = h("nav.tabs", { role: "tablist" });
  const listEl = h("ul.items");
  const editor = h("textarea.json", { spellcheck: "false", "aria-label": "Item JSON" }) as HTMLTextAreaElement;
  const editorMsg = h("div.editor-msg", { role: "status" });
  const issuesEl = h("ul.issues");
  const saveBtn = h("button.primary", { type: "button", onClick: () => saveCollection(false) }, "Save to server");
  const filterInput = h("input.filter", { type: "search", placeholder: "Filter by id", "aria-label": "Filter items" }) as HTMLInputElement;
  filterInput.addEventListener("input", () => { filter = filterInput.value.toLowerCase(); renderList(); });

  const arr = () => (tab === "config" ? null : (draft as any)[tab] as any[]);

  clear(root);
  root.append(h("div.admin", {},
    h("header.admin-head", {},
      h("h1", {}, "Content editor"),
      h("div.spacer"),
      h("button.ghost", { type: "button", onClick: runCheck }, "Check content"),
      saveBtn,
      h("button.ghost", { type: "button", onClick: () => { if (dirty.size && !confirm("You have unsaved changes. Leave anyway?")) return; onBack(); } }, "Back to the game"),
    ),
    tabsEl,
    h("div.admin-body", {},
      h("div.list-pane", {}, filterInput,
        h("div.list-actions", {},
          h("button.ghost", { type: "button", onClick: addItem }, "New"),
          h("button.ghost", { type: "button", onClick: duplicateItem }, "Duplicate"),
          h("button.ghost.danger", { type: "button", onClick: deleteItem }, "Delete")),
        listEl),
      h("div.edit-pane", {}, editor,
        h("div.edit-actions", {},
          h("button.ghost", { type: "button", onClick: applyEdit }, "Apply edit"),
          h("span.hint", {}, "Apply updates the draft. Save to server writes this tab's file."),
        ),
        editorMsg),
      h("aside.ref-pane", {},
        h("h2", {}, "Problems"), issuesEl,
        h("details", {}, h("summary", {}, "Reference"), h("pre.ref", {}, REFERENCE))),
    ),
  ));

  editor.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "s") { ev.preventDefault(); if (applyEdit()) void saveCollection(false); }
    if (ev.key === "Tab") { ev.preventDefault(); editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end"); }
  });

  function renderTabs() {
    clear(tabsEl);
    for (const t of TABS) {
      const count = issues.filter((i) => i.level === "error" && whereColl(i.where) === t.id).length;
      tabsEl.append(h("button.tab", {
        type: "button", role: "tab", "aria-selected": String(t.id === tab),
        onClick: () => { if (!applyEditSilently()) return; tab = t.id; sel = 0; filter = ""; filterInput.value = ""; renderAll(); },
      }, t.label, dirty.has(t.id) ? " •" : "", count ? h("span.badge", {}, String(count)) : null));
    }
  }

  function renderList() {
    clear(listEl);
    const a = arr();
    listEl.parentElement!.style.display = a ? "" : "none";
    if (!a) return;
    a.forEach((item, i) => {
      if (filter && !String(item.id ?? "").toLowerCase().includes(filter)) return;
      const bad = issues.some((x) => x.level === "error" && whereColl(x.where) === tab && whereId(x.where) === item.id);
      listEl.append(h("li", {},
        h("button.item", { type: "button", "aria-current": i === sel ? "true" : null, class: bad ? "bad" : "", onClick: () => { if (!applyEditSilently()) return; sel = i; renderList(); renderEditor(); } },
          h("span.iid", {}, item.id ?? "(no id)"), item.kind ? h("span.kind", {}, item.kind) : null)));
    });
  }

  function renderEditor() {
    const a = arr();
    const item = a ? a[sel] : draft.config;
    editor.value = item ? JSON.stringify(item, null, 2) : "";
    editor.disabled = !item;
    editorMsg.textContent = "";
    editorMsg.className = "editor-msg";
  }

  function renderIssues() {
    clear(issuesEl);
    if (!issues.length) { issuesEl.append(h("li.ok", {}, "No problems found.")); return; }
    for (const i of issues) {
      issuesEl.append(h(`li.${i.level}`, {},
        h("button.issue", { type: "button", onClick: () => jumpTo(i.where) }, h("b", {}, i.where), " ", i.message)));
    }
  }

  function renderAll() { renderTabs(); renderList(); renderEditor(); renderIssues(); }

  function whereColl(where: string): Coll | null {
    const w = where.split(" ")[0];
    return ({ card: "cards", deck: "decks", decks: "decks", cards: "cards", rule: "rules", soulOwner: "soulOwners", character: "characters", characters: "characters" } as Record<string, Coll>)[w] ?? null;
  }
  function whereId(where: string) { return where.split(" ")[1]; }

  function jumpTo(where: string) {
    const c = whereColl(where);
    if (!c || !applyEditSilently()) return;
    tab = c;
    const idx = (draft as any)[c].findIndex((x: any) => x.id === whereId(where));
    sel = Math.max(0, idx);
    renderAll();
    editor.focus();
  }

  function parseEditor(): any | undefined {
    try { return JSON.parse(editor.value); }
    catch (e: any) { editorMsg.textContent = `This isn't valid JSON: ${e.message}`; editorMsg.className = "editor-msg error"; return undefined; }
  }

  function applyEdit(): boolean {
    const v = parseEditor();
    if (v === undefined) return false;
    const a = arr();
    if (a) {
      if (!v || typeof v !== "object" || !v.id) { editorMsg.textContent = 'Each item needs an "id".'; editorMsg.className = "editor-msg error"; return false; }
      if (a.some((x, i) => i !== sel && x.id === v.id)) { editorMsg.textContent = `Another item already uses the id "${v.id}".`; editorMsg.className = "editor-msg error"; return false; }
      a[sel] = v;
    } else draft.config = v;
    dirty.add(tab);
    editorMsg.textContent = "Applied to the draft. Not saved to the server yet.";
    editorMsg.className = "editor-msg ok";
    renderTabs(); renderList();
    void runCheck(true);
    return true;
  }

  /** Applies pending edits before navigating. Returns false (and stays) if the JSON is broken. */
  function applyEditSilently(): boolean {
    const a = arr();
    const current = a ? a[sel] : draft.config;
    if (!current) return true;
    if (editor.value.trim() === JSON.stringify(current, null, 2).trim()) return true;
    return applyEdit();
  }

  function addItem() {
    const a = arr(); if (!a || !applyEditSilently()) return;
    const item = BLANK[tab as Exclude<Coll, "config">]();
    let n = 1; const base = item.id; while (a.some((x) => x.id === item.id)) item.id = `${base}_${++n}`;
    a.push(item); sel = a.length - 1; dirty.add(tab); renderAll(); editor.focus();
  }
  function duplicateItem() {
    const a = arr(); if (!a || !a[sel] || !applyEditSilently()) return;
    const copy = JSON.parse(JSON.stringify(a[sel]));
    let n = 1; const base = copy.id; while (a.some((x) => x.id === copy.id)) copy.id = `${base}_copy${n++ > 1 ? n : ""}`;
    a.splice(sel + 1, 0, copy); sel++; dirty.add(tab); renderAll();
  }
  function deleteItem() {
    const a = arr(); if (!a || !a[sel]) return;
    if (!confirm(`Delete "${a[sel].id}" from the draft?`)) return;
    a.splice(sel, 1); sel = Math.max(0, sel - 1); dirty.add(tab); renderAll(); void runCheck(true);
  }

  async function runCheck(quiet = false) {
    if (!quiet && !applyEditSilently()) return;
    try { issues = (await api.adminCheck(draft)).issues; renderTabs(); renderList(); renderIssues(); if (!quiet) toast(issues.length ? `${issues.length} problem(s) found.` : "No problems found."); }
    catch (e: any) { toast(e.message, "error"); }
  }

  async function saveCollection(force: boolean) {
    if (!applyEditSilently()) return;
    const data = tab === "config" ? draft.config : (draft as any)[tab];
    try {
      const r = await api.adminSave(tab, data, force);
      issues = r.issues; dirty.delete(tab);
      toast(`Saved ${TABS.find((t) => t.id === tab)!.label.toLowerCase()}.`);
      renderAll();
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 422) {
        issues = e.body.issues ?? issues; renderAll();
        if (confirm("This tab has errors, so it wasn't saved. Runs may break on broken cards. Save anyway?")) return saveCollection(true);
      } else toast(e.message, "error");
    }
  }

  window.addEventListener("beforeunload", (ev) => { if (dirty.size && root.isConnected) ev.preventDefault(); });
  renderAll();
}
