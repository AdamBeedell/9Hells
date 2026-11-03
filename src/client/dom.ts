// Tiny DOM helper: h("div.class#id", { attrs, on* handlers }, ...children)
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(sel: K | string, props: Record<string, any> = {}, ...kids: Child[]): HTMLElement {
  const [tag, ...rest] = sel.split(/(?=[.#])/);
  const el = document.createElement(tag || "div");
  for (const r of rest) {
    if (r.startsWith(".")) el.classList.add(r.slice(1));
    else if (r.startsWith("#")) el.id = r.slice(1);
  }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style" && typeof v === "object") for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk.startsWith("--") ? sk : sk.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()), String(sv));
    else if (k === "class") el.className += " " + v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}

function append(el: HTMLElement, kids: Child[]) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}

export function clear(el: HTMLElement) { while (el.firstChild) el.firstChild.remove(); }

export function toast(text: string, kind: "info" | "error" = "info") {
  let host = document.getElementById("toasts");
  if (!host) { host = h("div#toasts", { role: "status", "aria-live": "polite" }); document.body.append(host); }
  const t = h(`div.toast.${kind}`, {}, text);
  host.append(t);
  setTimeout(() => t.remove(), 4200);
}
