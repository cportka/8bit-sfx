// jump — the classic platformer hop: a square pulse whose pitch rockets upward
// while an exponential decay yanks it away.
//
// Ported 1:1 from `gen_jump` / `describe_jump` in scripts/generate_sfx.py. The
// five rng draws (dur, f0, sweep, duty, rate) are the effect's identity, and the
// Python function did no post-processing at all — no normalize, no DC block, no
// edge fades — so neither does this. That literalism is what makes `jump_017`
// synthesize to the same bytes the published 0.4.1 WAV shipped.

import { SR, midi, noteOfHz, renderTone, decay } from '../dsp.js';

/** Python's round(): half-to-even, matching `int(round(x))` on the source side. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Python's round(x, 1). Only odd quarters (x.25 / x.75) are exact ties at one
 * decimal; Python breaks them to even where JS's toFixed breaks them upward.
 */
function pyRound1(x) {
  const quarters = x * 4;
  if (Number.isInteger(quarters) && quarters % 2 !== 0) {
    const lo = Math.floor(x * 10);
    return (lo % 2 === 0 ? lo : lo + 1) / 10;
  }
  return Number(x.toFixed(1));
}

/** Mirror of the Python describer's `_duty` lookup. */
function dutyLabel(d) {
  if (d === 0.125) return '12.5%';
  if (d === 0.25) return '25%';
  if (d === 0.5) return '50%';
  return typeof d === 'number' && Number.isFinite(d) ? String(d) : '50%';
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const dur = rng.uniform(0.15, 0.35);
  const f0 = rng.uniform(midi(55), midi(67));
  const sweep = rng.uniform(2.0, 4.0); // octaves-ish upward glide
  const duty = rng.choice([0.125, 0.25, 0.5]);
  const rate = rng.uniform(4.0, 9.0);

  rng.tags = {
    style: 'jump',
    duty,
    f0: pyRound(f0),
    sweep: pyRound1(sweep),
    snap: rate > 6.5 ? 'snappy' : 'floaty',
    note: noteOfHz(f0), // musicians pick hops by pitch; derived, costs no draw
  };

  // Python int() truncates toward zero; dur * SR > 0, so floor matches.
  return renderTone(
    Math.floor(dur * SR),
    (t) => f0 * Math.pow(2.0, (sweep * t) / dur),
    duty,
    decay(rate)
  );
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const f0 = Number(t.f0);
  const sweep = Number(t.sweep);
  const hz = Number.isFinite(f0) ? Math.trunc(f0) : 0;
  const octaves = (Number.isFinite(sweep) ? sweep : 0).toFixed(1);
  const snap = typeof t.snap === 'string' && t.snap ? t.snap : 'floaty';
  return `upward square sweep — ${dutyLabel(t.duty)} duty, ${hz} Hz climbing ${octaves} octaves, ${snap} tail`;
}

/** Short phrase for the README category table. */
export const character = 'rising square hops, snappy or floaty tails';
