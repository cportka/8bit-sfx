// jingle — the short melodic stinger: 3-6 square-wave notes picked out of a
// major-pentatonic pool over the root, ending on a high resolve (octave, major
// tenth, or twelfth). Each note gets its own plucked decay, so the phrase reads
// as a little fanfare rather than one gliding tone.
//
// The synthesis is ported 1:1 from `gen_jingle` in scripts/generate_sfx.py.
// Two things are load-bearing and neither may be "improved":
//
//   * the rng draw order — uniform(dur), randint(notes), randint(root),
//     choice(duty), then ONE scale choice per non-final note, then the resolve
//     interval. That sequence is what turns the name `jingle_042` into this
//     particular tune; reordering or adding a draw rewrites every later note.
//   * the absence of post-processing. The Python returns `render_tone(...)`
//     raw: no peak-normalization, no DC blocker, no edge fades. A 25%-duty
//     square really does ride a positive bias and the phrase really does start
//     on a hard edge. Calling `finish()` or `dcBlock()` here would move every
//     sample and break byte-parity with the published 0.4.1 WAVs.
//
// The catalog wording is NOT part of that contract. The Python describer only
// had 100 variations to separate, so root + resolve + duty was enough; at 202 it
// collapsed a third of the category onto duplicate blurbs. The tags below carry
// the rest of the melody — the pentatonic degrees the draws already produced —
// so `describe()` can name the shape, its high point and the pace. Every one of
// them is derived from values `gen()` already holds: not one extra rng draw.

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
  return typeof d === 'number' && Number.isFinite(d) ? String(d) : '50%';
}

/** How each duty reads to the ear: a narrow pulse is reedy, a square is full. */
const TONES = { '25%': 'reedy 25% pulse', '50%': 'full 50% pulse' };

/** Major pentatonic plus the octave — the melody pool. */
const SCALE = [0, 2, 4, 7, 9, 12];
/** The closing leap: octave, major tenth, or twelfth. */
const RESOLVES = [12, 16, 19];
/** Semitones above the root, named as the interval a musician would call it. */
const INTERVALS = { 12: 'octave', 16: 'major tenth', 19: 'twelfth' };

/**
 * The melodic shape of the notes before the resolve — which is what actually
 * tells two same-key stingers apart. Degrees are semitones over the root.
 */
function shapeOf(degrees) {
  const first = degrees[0];
  const last = degrees[degrees.length - 1];
  let up = 0;
  let down = 0;
  for (let i = 1; i < degrees.length; i++) {
    if (degrees[i] > degrees[i - 1]) up++;
    else if (degrees[i] < degrees[i - 1]) down++;
  }
  if (!up && !down) return 'held';
  if (!down) return 'climb';
  if (!up) return 'fall';
  if (last > first) return 'zigzag-up';
  if (last < first) return 'zigzag-down';
  return Math.max(...degrees) > first ? 'arch' : 'dip';
}

/** Notes per second, the pace a listener hears — nothing about total length. */
function paceWord(notesPerSecond) {
  if (!(notesPerSecond > 0)) return 'steady';
  if (notesPerSecond < 3.2) return 'gentle';
  if (notesPerSecond < 4.6) return 'steady';
  if (notesPerSecond < 6.5) return 'brisk';
  return 'rapid';
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const dur = rng.uniform(0.5, 1.2);
  const n = Math.floor(dur * SR); // Python int() truncates; dur * SR > 0, so floor matches
  const notes = rng.randint(3, 6); // inclusive both ends
  const root = rng.randint(65, 77); // inclusive both ends
  const duty = rng.choice([0.25, 0.5]);

  // One draw per melody note, in order — Python's range(notes - 1) is 0..notes-2.
  // `degrees` just remembers each drawn scale step so the tags can describe the
  // melody; `seq` is byte-for-byte what the Python built.
  const degrees = [];
  const seq = [];
  for (let i = 0; i < notes - 1; i++) {
    const deg = rng.choice(SCALE);
    degrees.push(deg);
    seq.push(midi(root + deg));
  }
  const resolve = rng.choice(RESOLVES); // end on a high resolve
  seq.push(midi(root + resolve));

  const peak = Math.max(...degrees); // highest note before the closing leap
  const low = Math.min(...degrees);
  rng.tags = {
    style: 'jingle',
    duty,
    notes,
    root_hz: pyRound(midi(root)),
    resolve_hz: pyRound(seq[seq.length - 1]),
    note: noteName(root), // the midi root gen() already drew — no extra draw
    first_note: noteName(root + degrees[0]),
    peak_note: noteName(root + peak),
    resolve_note: noteName(root + resolve),
    interval: INTERVALS[resolve] || 'octave',
    shape: shapeOf(degrees),
    span: peak - low, // semitones the melody covers before it resolves
    pace: Math.round((notes / dur) * 100) / 100, // notes per second
  };

  const step = dur / notes; // Python 3 true division
  // int() truncates and t >= 0, so floor matches; likewise t % step on positives.
  const freq = (t) => seq[Math.min(Math.floor(t / step), notes - 1)];
  const env = (t) => Math.exp(-3.0 * ((t % step) / step));
  return renderTone(n, freq, duty, env);
}

/** How the pre-resolve melody is worded, given where its high note sits. */
function shapePhrase(shape, peak) {
  switch (shape) {
    case 'held':
      return `${peak} repeated`;
    case 'climb':
      return `stepping up to ${peak}`;
    case 'fall':
      return `stepping down from ${peak}`;
    case 'zigzag-up':
      return `zigzag up topping ${peak}`;
    case 'zigzag-down':
      return `zigzag down topping ${peak}`;
    case 'dip':
      return `dipping below ${peak}`;
    default:
      return `arching over ${peak}`;
  }
}

/**
 * Catalog blurb from the tags gen() recorded: how many notes, the key they sit
 * over, the shape of the run and its high note, where the closing leap lands,
 * and how fast and how bright the whole thing is. Stays inside 95 characters —
 * the longest each part can be sums to 94.
 */
export function describe(tags) {
  const t = tags || {};
  const notes = Math.trunc(Number(t.notes)) || 0;
  const root = t.note || 'C5';
  const peak = t.peak_note || root;
  const top = t.resolve_note || peak;
  const tone = TONES[dutyLabel(t.duty)] || 'full 50% pulse';
  const shape = shapePhrase(t.shape, peak);
  // A run that already touched the resolve pitch does not leap up to it.
  const landing = top === peak ? `settling on ${top}` : `${t.interval || 'octave'} up to ${top}`;
  return `${notes}-note stinger on ${root} — ${shape}, ${landing}, ${paceWord(Number(t.pace))} ${tone}`;
}

/** Short phrase for the README category table. */
export const character = 'short melodic stingers, 3-6 notes resolving upward';
