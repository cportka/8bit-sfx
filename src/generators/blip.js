// blip — the tiny UI tick: one high square note at a fixed pitch, snuffed out by
// a steep exponential decay. The shortest effect in the library and the one the
// menus lean on hardest, so its identity has to survive the port exactly.
//
// Ported 1:1 from `gen_blip` / `describe_blip` in scripts/generate_sfx.py. Two
// things are load-bearing and neither may be "improved":
//
//   * the rng draw order — uniform, randint, choice, uniform — which is what
//     turns the name `blip_017` into this particular sound, and
//   * the absence of post-processing. The Python returns `render_tone(...)`
//     raw: no peak-normalization, no DC blocker, no edge fades. A 12.5%-duty
//     square really does ride a negative bias, and the decay tail really is cut
//     mid-air. Adding `finish()` or `dcBlock()` here would move every sample and
//     break byte-parity with the published 0.4.1 WAVs.

import { SR, midi, noteName, renderTone, decay } from '../dsp.js';

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
  const dur = rng.uniform(0.04, 0.12);
  const note = rng.randint(72, 96); // inclusive both ends: 25 pitches, C5..C7
  const f = midi(note);
  const duty = rng.choice([0.125, 0.25, 0.5]);
  const rate = rng.uniform(20.0, 40.0);

  rng.tags = {
    style: 'blip',
    duty,
    hz: pyRound(f),
    note: noteName(note), // the midi number gen() already drew — no extra draw
    fade: pyRound(rate),
  };

  // Python int() truncates toward zero; dur * SR > 0, so floor matches.
  return renderTone(Math.floor(dur * SR), () => f, duty, decay(rate));
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const hz = Math.trunc(Number(t.hz)) || 0;
  const fade = Math.trunc(Number(t.fade)) || 0;
  return `single UI tick at ${hz} Hz, ${dutyLabel(t.duty)} duty square, ${fade}/s fade`;
}

/** Short phrase for the README category table. */
export const character = 'tiny UI ticks and menu selects, crisp square clicks';
