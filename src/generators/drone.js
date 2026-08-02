// drone — the sustained low hum: a bass-register square or triangle whose pitch
// is vibrato'd by a slow sine, wrapped in a fade-in/fade-out swell.
//
// Ported 1:1 from `gen_drone` / `describe_drone` in scripts/generate_sfx.py. Two
// things are load-bearing and neither may be "improved":
//
//   * the rng draw order — dur, f0, wobble rate, wobble depth, duty, wave — which
//     is what turns the name `drone_042` into this particular sound, and
//   * the absence of post-processing. The Python returns `render_tone(...)` raw:
//     no peak-normalization, no DC blocker, no edge fades. A 25%-duty square
//     really does ride a negative bias, and the swell envelope is the only thing
//     shaping the edges. Adding `finish()` or `dcBlock()` here moves every sample
//     and breaks byte-parity with the published 0.4.1 WAVs.

import { SR, midi, noteOfHz, renderTone } from '../dsp.js';

/** Python's round(): half-to-even, matching `int(round(x))` on the source side. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  // Six draws, in this order — nothing may be added, removed, or reordered.
  const dur = rng.uniform(0.6, 1.2);
  const f0 = rng.uniform(midi(33), midi(45)); // A1..A2, bass register
  const wobRate = rng.uniform(3.0, 9.0); // vibrato speed, Hz
  const wobAmt = rng.uniform(0.01, 0.06); // vibrato depth, fraction of f0
  const duty = rng.choice([0.25, 0.5]);
  const wf = rng.choice([null, 'tri']); // null => square, matching Python's None

  rng.tags = {
    style: 'drone',
    wave: wf === 'tri' ? 'triangle' : 'square',
    hz: pyRound(f0),
    // Python's round(wob_rate, 1). No double can sit exactly on a tenth-tie
    // (that needs a denominator divisible by 5), so toFixed's round-half-up
    // never fires and this equals Python's round-half-even result.
    wobble_hz: Number(wobRate.toFixed(1)),
    depth: wobAmt > 0.035 ? 'seasick' : 'gentle',
    note: noteOfHz(f0), // musicians pick drones by pitch; derived, costs no draw
  };

  const freq = (t) => f0 * (1.0 + wobAmt * Math.sin(2 * Math.PI * wobRate * t));
  // Swell: 1/12 of the duration to rise, the last 1/6 to fall away.
  const env = (t) => Math.min(1.0, (12.0 * t) / dur, (6.0 * (dur - t)) / dur);

  // Python int() truncates toward zero; dur > 0, so floor matches.
  return renderTone(Math.floor(dur * SR), freq, duty, env, wf);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const wave = typeof t.wave === 'string' && t.wave ? t.wave : 'square';
  const depth = typeof t.depth === 'string' && t.depth ? t.depth : 'gentle';
  const hzNum = Number(t.hz);
  const hz = Number.isFinite(hzNum) ? Math.trunc(hzNum) : 0;
  const wobNum = Number(t.wobble_hz);
  const wobble = (Number.isFinite(wobNum) ? wobNum : 0).toFixed(1);
  return `low ${wave} hum at ${hz} Hz — ${depth} ${wobble} Hz wobble`;
}

/** Short phrase for the README category table. */
export const character = 'sustained bass hums, gentle to seasick wobble';
