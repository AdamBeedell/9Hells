// Seeded RNG (mulberry32) whose state lives in the run state, plus dice parsing.

export interface RngHolder { rng: number }

export function nextRandom(h: RngHolder): number {
  h.rng = (h.rng + 0x6d2b79f5) | 0;
  let t = h.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Integer in [min, max] inclusive. */
export function randInt(h: RngHolder, min: number, max: number): number {
  if (max < min) return min;
  return min + Math.floor(nextRandom(h) * (max - min + 1));
}

export function shuffle<T>(h: RngHolder, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(h, 0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const DICE_RE = /^\s*(\d*)d(\d+)\s*(([+-])\s*(\d+))?\s*$/i;

export function isDice(s: unknown): s is string {
  return typeof s === "string" && DICE_RE.test(s);
}

/** Rolls e.g. "2d6+1". `times` multiplies the dice count (crits). Returns total and the first natural die. */
export function rollDice(h: RngHolder, spec: string, times = 1): { total: number; natural: number } {
  const m = DICE_RE.exec(spec);
  if (!m) throw new Error(`Bad dice "${spec}"`);
  const count = (m[1] ? parseInt(m[1], 10) : 1) * times;
  const sides = parseInt(m[2], 10);
  const flat = m[3] ? (m[4] === "-" ? -1 : 1) * parseInt(m[5], 10) : 0;
  let total = 0, natural = 0;
  for (let i = 0; i < count; i++) {
    const r = randInt(h, 1, sides);
    if (i === 0) natural = r;
    total += r;
  }
  return { total: total + flat, natural };
}
