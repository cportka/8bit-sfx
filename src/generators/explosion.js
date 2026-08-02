// explosion — the cabinet blast: 15-bit LFSR noise smoothed by a one-pole
// average until the hiss thickens into a boom, optionally sitting on a 30-60 Hz
// triangle sub-rumble, all under an exponential decay.
//
// Ported 1:1 from gen_explosion/describe_explosion in scripts/generate_sfx.py.
// The port is literal on purpose: the same six rng draws in the same order (dur,
// grit period, LFSR seed, fade rate, rumble depth, rumble Hz — that last one sat
// behind Python's rng_freq_cache() and fired on the loop's first sample), and no
// post-processing the Python never did. No fade, no normalization, no DC
// blocking: the raw noise burst is the published sound, hard attack and quiet
// tail included, and adding anything here would move every sample.

import { SR, Lfsr } from '../dsp.js';

/** Python's round(): half-to-even, unlike JS's half-up Math.round. */
function pyRound(x) {
  if (!Number.isFinite(x)) return 0;
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's round(x, 1) — one decimal, ties to even. */
function pyRound1(x) {
  return Number.isFinite(x) ? pyRound(x * 10) / 10 : 0;
}

/** Python's `%d`: truncate toward zero. */
function asInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Python's `triangle()` verbatim: `4.0 * abs((phase % 1.0) - 0.5) - 1.0`.
 *
 * dsp.js wraps the modulo as `((phase % 1) + 1) % 1` so negative phases fold
 * correctly — but that extra `+ 1` rounds the fraction to the 2^-52 grid of
 * [1, 2) and comes back a ULP off for roughly one phase in a hundred. Phase is
 * `t * rumbleHz`, never negative, so the guard is dead weight here and the bare
 * modulo is what the published WAVs were rendered through.
 */
function pyTriangle(phase) {
  return 4.0 * Math.abs((phase % 1.0) - 0.5) - 1.0;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const dur = rng.uniform(0.5, 1.2);
  const n = Math.trunc(dur * SR); // Python int() truncates toward zero
  // Argument first, constructor second — same two draws, same order, as Python's
  // Lfsr(rng, rng.randint(2, 8)): grit period, then the LFSR's own seed.
  const noise = new Lfsr(rng, rng.randint(2, 8));
  const rate = rng.uniform(2.5, 6.0);
  const rumble = rng.uniform(0.0, 0.5);

  rng.tags = {
    style: 'explosion',
    grit: noise.period, // sample-and-hold period: 2 = fine hiss, 8 = coarse crunch
    fade: pyRound1(rate),
    tail: rate < 4.0 ? 'long' : 'short',
    rumble_pct: pyRound(rumble * 100), // Python: int(round(rumble * 100))
  };

  // Python decided the sub-rumble frequency on first use, inside the loop
  // (rng_freq_cache). Nothing else touches the rng in between, so the lazy
  // draw sits at the same point in the stream either way — kept lazy anyway so
  // the draw order is legible against the source.
  let rumbleHz = null;
  const rumbleFreq = () => (rumbleHz === null ? (rumbleHz = rng.uniform(30.0, 60.0)) : rumbleHz);

  const out = new Array(n);
  let prev = 0.0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // one-pole average tames the hiss into a boom
    prev = prev * 0.6 + noise.next() * 0.4;
    const s = prev + rumble * pyTriangle(t * rumbleFreq());
    out[i] = s * Math.exp(-rate * t);
  }
  return out;
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const pct = asInt(t.rumble_pct);
  const body = pct <= 25 ? 'dry' : `${pct}% sub-rumble`;
  const tail = typeof t.tail === 'string' && t.tail ? t.tail : 'short';
  const fade = Number.isFinite(Number(t.fade)) ? Number(t.fade) : 0;
  return `noise boom — grit ${asInt(t.grit)}, ${tail} ${fade.toFixed(1)}/s fade, ${body}`;
}

/** Short phrase for the README category table. */
export const character = 'noise booms, dry cracks to sub-heavy rolling blasts';
