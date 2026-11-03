// Synthesised sounds (WebAudio), so v0.1 ships no audio files.
// Each character has its own semitone offset and waveform, so simultaneous level-ups form a chord
// rather than four copies of the same sound; they're also staggered into an arpeggio.

let ctx: AudioContext | null = null;
let muted = (() => { try { return localStorage.getItem("9h-muted") === "1"; } catch { return false; } })();

export function isMuted() { return muted; }
export function setMuted(m: boolean) {
  muted = m;
  try { localStorage.setItem("9h-muted", m ? "1" : "0"); } catch { /* storage unavailable */ }
}

function ac(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch { return null; }
}

function note(freq: number, start: number, dur: number, wave: OscillatorType, gain = 0.12) {
  const a = ac(); if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = wave;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(a.destination);
  o.start(start);
  o.stop(start + dur + 0.05);
}

/** Bright rising chime. `index` staggers simultaneous level-ups by ~80ms. */
export function levelUpChime(semitone = 0, wave: OscillatorType = "triangle", index = 0) {
  const a = ac(); if (!a) return;
  const base = 523.25 * Math.pow(2, semitone / 12); // C5 shifted per character
  const t0 = a.currentTime + 0.02 + index * 0.08;
  const quiet = wave === "square" || wave === "sawtooth" ? 0.05 : 0.12;
  [0, 4, 7, 12].forEach((st, i) => note(base * Math.pow(2, st / 12), t0 + i * 0.07, 0.5, wave, quiet));
}

export function hitThud() {
  const a = ac(); if (!a) return;
  note(110, a.currentTime, 0.18, "sine", 0.18);
}

export function diceTick() {
  const a = ac(); if (!a) return;
  note(1400, a.currentTime, 0.04, "square", 0.025);
}
