// A small, safe expression language for card conditions and amounts.
// Supports: numbers, 'strings', true/false/null, dotted paths (self.hp, actor.mods.str, flags.greedy),
// + - * / %, comparisons (< <= > >= == !=), && || !, parentheses, and min/max/floor/ceil/abs/round.
// No property access outside the provided context, no assignment, no calls other than the whitelist.

type Tok = { t: "num" | "str" | "id" | "op" | "eof"; v: string };

const OPS = ["&&", "||", "<=", ">=", "==", "!=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", ","];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: "num", v: src.slice(i, j) }); i = j; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1; while (j < src.length && src[j] !== c) j++;
      if (j >= src.length) throw new Error(`Unterminated string in "${src}"`);
      out.push({ t: "str", v: src.slice(i + 1, j) }); i = j + 1; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_$.]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) }); i = j; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`Unexpected "${c}" in expression "${src}"`);
    out.push({ t: "op", v: op }); i += op.length;
  }
  out.push({ t: "eof", v: "" });
  return out;
}

type Node =
  | { k: "lit"; v: any }
  | { k: "path"; p: string[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; f: string; args: Node[] };

const FUNCS: Record<string, (...a: number[]) => number> = {
  min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, abs: Math.abs, round: Math.round,
};

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p];
    if (v !== undefined && t.v !== v) throw new Error(`Expected "${v}" but found "${t.v || "end"}" in "${src}"`);
    p++; return t;
  };
  const bin = (next: () => Node, ops: string[]) => () => {
    let a = next();
    while (peek().t === "op" && ops.includes(peek().v)) { const op = eat().v; a = { k: "bin", op, a, b: next() }; }
    return a;
  };
  const primary = (): Node => {
    const t = peek();
    if (t.t === "num") { eat(); return { k: "lit", v: parseFloat(t.v) }; }
    if (t.t === "str") { eat(); return { k: "lit", v: t.v }; }
    if (t.t === "id") {
      eat();
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      if (peek().v === "(") {
        if (!FUNCS[t.v]) throw new Error(`Unknown function "${t.v}" in "${src}"`);
        eat("(");
        const args: Node[] = [];
        if (peek().v !== ")") { args.push(or()); while (peek().v === ",") { eat(","); args.push(or()); } }
        eat(")");
        return { k: "call", f: t.v, args };
      }
      return { k: "path", p: t.v.split(".") };
    }
    if (t.v === "(") { eat("("); const n = or(); eat(")"); return n; }
    throw new Error(`Unexpected "${t.v || "end"}" in "${src}"`);
  };
  const unary = (): Node => {
    if (peek().t === "op" && (peek().v === "!" || peek().v === "-")) { const op = eat().v; return { k: "un", op, a: unary() }; }
    return primary();
  };
  const mul = bin(unary, ["*", "/", "%"]);
  const add = bin(mul, ["+", "-"]);
  const cmp = bin(add, ["<", "<=", ">", ">=", "==", "!="]);
  const and = bin(cmp, ["&&"]);
  const or: () => Node = bin(and, ["||"]);
  const n = or();
  if (peek().t !== "eof") throw new Error(`Unexpected "${peek().v}" in "${src}"`);
  return n;
}

const cache = new Map<string, Node>();
function compiled(src: string): Node {
  let n = cache.get(src);
  if (!n) { n = parse(src); cache.set(src, n); }
  return n;
}

const num = (v: any) => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v ?? 0) || 0);

function ev(n: Node, ctx: Record<string, any>): any {
  switch (n.k) {
    case "lit": return n.v;
    case "path": {
      let v: any = ctx;
      for (const part of n.p) {
        if (v == null || !Object.prototype.hasOwnProperty.call(Object(v), part)) return undefined;
        v = v[part];
      }
      return v;
    }
    case "un": { const a = ev(n.a, ctx); return n.op === "!" ? !a : -num(a); }
    case "call": return FUNCS[n.f](...n.args.map((a) => num(ev(a, ctx))));
    case "bin": {
      if (n.op === "&&") return ev(n.a, ctx) && ev(n.b, ctx);
      if (n.op === "||") return ev(n.a, ctx) || ev(n.b, ctx);
      const a = ev(n.a, ctx), b = ev(n.b, ctx);
      switch (n.op) {
        case "+": return typeof a === "string" || typeof b === "string" ? `${a ?? ""}${b ?? ""}` : num(a) + num(b);
        case "-": return num(a) - num(b);
        case "*": return num(a) * num(b);
        case "/": return num(b) === 0 ? 0 : num(a) / num(b);
        case "%": return num(b) === 0 ? 0 : num(a) % num(b);
        case "<": return num(a) < num(b);
        case "<=": return num(a) <= num(b);
        case ">": return num(a) > num(b);
        case ">=": return num(a) >= num(b);
        // eslint-disable-next-line eqeqeq
        case "==": return a == b;
        // eslint-disable-next-line eqeqeq
        case "!=": return a != b;
      }
    }
  }
  throw new Error("bad node");
}

export function evaluate(src: string, ctx: Record<string, any>): any {
  return ev(compiled(src), ctx);
}

export function evalNum(src: string, ctx: Record<string, any>): number {
  return num(evaluate(src, ctx));
}

/** Returns an error message, or null if the expression parses. */
export function checkExpr(src: string): string | null {
  try { compiled(src); return null; } catch (e: any) { return e.message; }
}
