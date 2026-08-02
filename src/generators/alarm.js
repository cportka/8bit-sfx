// alarm — the alternating two-tone siren: a square wave flipping between two
// pitches a rough third/fourth/fifth apart, held flat and then dropped by a
// short linear release over the last fifth of its length.
//
// Ported 1:1 from `gen_alarm` / `describe_alarm` in scripts/generate_sfx.py.
// Two things are load-bearing and neither may be "improved":
//
//   * the rng draw order — uniform, randint, choice, uniform, choice — which is
//     what turns the name `alarm_042` into this particular sound, and
//   * the absence of post-processing. The Python returns `render_tone(...)`
//     raw: no peak-normalization, no DC blocker, no edge fades. A 25%-duty
//     square really does ride a negative bias, and the tone really does start
//     full-on at sample zero. Adding `finish()` or `dcBlock()` here moves every
//     sample and breaks byte-parity with the published 0.4.1 WAVs.

import { SR, midi, noteName, renderTone } from '../dsp.js';

/** Python's round(): half-to-even, matching `int(round(x))` on the source side. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Mirror of the Python `_duty` lookup. */
function dutyLabel(d) {
  if (d === 0.125) return '12.5%';
  if (d === 0.25) return '25%';
  if (d === 0.5) return '50%';
  return String(d);
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const dur = rng.uniform(0.4, 1.0);
  const n = Math.floor(dur * SR); // Python int() truncates; dur > 0 so floor matches
  const root = rng.randint(69, 81); // inclusive both ends: A4..A5
  const fa = midi(root);
  const fb = fa * rng.choice([1.26, 1.33, 1.5]); // minor third / fourth / fifth-ish

  const cycle = rng.uniform(0.06, 0.15);
  const duty = rng.choice([0.25, 0.5]);

  rng.tags = {
    style: 'alarm',
    duty,
    low_hz: pyRound(fa),
    high_hz: pyRound(fb),
    cycle_ms: pyRound(cycle * 1000),
    pace: cycle < 0.09 ? 'frantic' : 'steady',
    note: noteName(root), // pitch of the low tone; the midi number gen() already drew
  };

  // int(t / cycle) % 2 — t is never negative, so floor and JS % agree with Python.
  const freq = (t) => (Math.floor(t / cycle) % 2 === 0 ? fa : fb);
  // Flat, then a linear ramp to zero across the final 20%.
  const env = (t) => (t < dur * 0.8 ? 1.0 : Math.max(0.0, (dur - t) / (dur * 0.2)));

  return renderTone(n, freq, duty, env);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const pace = typeof t.pace === 'string' && t.pace ? t.pace : 'steady';
  const lowHz = Math.trunc(Number(t.low_hz)) || 0;
  const highHz = Math.trunc(Number(t.high_hz)) || 0;
  const cycleMs = Math.trunc(Number(t.cycle_ms)) || 0;
  return `${pace} two-tone siren — ${lowHz} and ${highHz} Hz every ${cycleMs} ms, ${dutyLabel(t.duty)} duty`;
}

/** Short phrase for the README category table. */
export const character = 'alternating two-tone sirens, frantic to steady';
