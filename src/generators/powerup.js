// powerup — the pickup fanfare: a square wave marching up a scale, one step per
// slice of the effect, held flat until a hard linear ramp yanks the tail away.
//
// `gen` is ported 1:1 from `gen_powerup` in scripts/generate_sfx.py. That half is
// a translation, not a redesign: the five draws (dur, steps, root, scale, duty)
// are the effect's identity, and the Python function did no post-processing at
// all — no normalize, no DC block, no edge fades — so neither does this. That
// literalism is what makes `powerup_017` synthesize to the same bytes the
// published 0.4.1 WAV shipped.
//
// `describe` is *not* a port. The Python describer only had to separate 100
// variations and keyed on four coarse fields (flavor, steps, root, duty), which
// collapsed 202 effects onto 132 blurbs. It now reads the climb the way a buyer
// hears it — timbre, interval set, the pitch it starts and lands on, how many
// notes, how fast they arrive. Every field it prints is derived from values gen
// already computed, so the extra tags cost no draw and move no sample.

import { SR, midi, noteName, renderTone } from '../dsp.js';

/** Python's round(): half-to-even, matching `int(round(x))` on the source side. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Mirror of the Python describer's `_duty` lookup. */
function dutyLabel(d) {
  if (d === 0.125) return '12.5%';
  if (d === 0.25) return '25%';
  if (d === 0.5) return '50%';
  return typeof d === 'number' && Number.isFinite(d) ? String(d) : '50%';
}

// How each duty reads to the ear: the narrower pulse is thin and nasal, the
// even one is the full, round NES square. Keyed off the printed label so the
// word and the percentage can never disagree.
const TIMBRES = { '12.5%': 'thin', '25%': 'reedy', '50%': 'full' };

// The ladders a seed can climb. The middle one is a *minor* pentatonic, but the
// Python flavor lookup keys on `len(scale)`, so it prints "major-pentatonic" for
// it too and the "minor-pentatonic" default is unreachable — see LADDERS below.
const SCALES = [
  [0, 2, 4, 7, 9],
  [0, 3, 5, 7, 10],
  [0, 4, 7],
];

const FLAVORS = { 5: 'major-pentatonic', 3: 'major-triad' };

// What each ladder in SCALES actually is, positionally. `flavor` above keeps the
// ported len()-keyed lookup (and its collision) so the tag anyone already reads
// keeps its meaning; `ladder` names the interval set the synth really climbed,
// which is both truthful and one more axis separating two otherwise-alike effects.
const LADDERS = ['major-pentatonic', 'minor-pentatonic', 'major-triad'];

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  // Five draws, in this order — nothing added, nothing reordered.
  const dur = rng.uniform(0.4, 0.8);
  const n = Math.floor(dur * SR); // Python int() truncates; dur > 0, so floor matches
  const steps = rng.randint(4, 8); // inclusive both ends
  const root = rng.randint(60, 72); // inclusive both ends
  const scale = rng.choice(SCALES);
  const duty = rng.choice([0.25, 0.5]);

  // Each step is scale degree i % len, transposed one octave per wrap.
  const seq = new Array(steps);
  for (let i = 0; i < steps; i++) {
    seq[i] = midi(root + scale[i % scale.length] + 12 * Math.floor(i / scale.length));
  }

  // The note the climb lands on — same formula as the loop above, at its last i.
  const last = steps - 1;
  const topMidi = root + scale[last % scale.length] + 12 * Math.floor(last / scale.length);

  // All derived from what the five draws already decided: no extra draw, and
  // nothing here is read by the render below.
  rng.tags = {
    style: 'powerup',
    duty,
    steps,
    root_hz: pyRound(midi(root)), // Python: int(round(midi(root)))
    flavor: FLAVORS[scale.length] || 'minor-pentatonic',
    ladder: LADDERS[SCALES.indexOf(scale)] || 'major-pentatonic',
    note: noteName(root), // musicians pick fanfares by pitch; derived, costs no draw
    top_note: noteName(topMidi), // where it tops out — the other half of the range
    top_hz: pyRound(seq[last]),
    pace: steps / dur, // steps per second: how urgent the run feels
  };

  const freq = (t) => seq[Math.min(Math.floor((t / dur) * steps), steps - 1)];
  const env = (t) => Math.min(1.0, (8.0 * (dur - t)) / dur); // flat, then a hard drop

  return renderTone(n, freq, duty, env);
}

/** A tag that should be a non-empty string, or the fallback. */
function word(v, fallback) {
  return typeof v === 'string' && v ? v : fallback;
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const ladder = word(t.ladder, word(t.flavor, 'major-pentatonic'));
  const from = word(t.note, 'C4');
  const to = word(t.top_note, from);
  const steps = Number.isFinite(Number(t.steps)) ? Math.trunc(Number(t.steps)) : 0;
  const pace = Number.isFinite(Number(t.pace)) ? Number(t.pace) : 0;
  const duty = dutyLabel(t.duty);
  return (
    `${TIMBRES[duty] || 'full'} ${ladder} climb from ${from} to ${to} — ` +
    `${steps} notes, ${pace.toFixed(1)} steps/s, ${duty} pulse`
  );
}

/** Short phrase for the README category table. */
export const character = 'rising scale fanfares, bright pickup arpeggios';
