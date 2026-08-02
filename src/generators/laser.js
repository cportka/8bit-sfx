// laser — the arcade pew: a square pulse diving from the top octaves down to the
// low mids, optionally warbled by a fixed 60 Hz vibrato.
//
// Ported 1:1 from gen_laser/describe_laser in scripts/generate_sfx.py. The port is
// literal on purpose: the same six rng draws in the same order (dur, f0, f1, duty,
// vib, rate — the rate draw sits inside the render_tone() argument list, so it
// happens last), and no post-processing the Python never did. No fade, no
// normalization, no DC blocking: the raw decaying square is the published sound,
// hard attack and all, and adding anything here would move every sample.

import { SR, midi, noteOfHz, renderTone, decay } from '../dsp.js';

// Mirrors the Python describer's _duty() lookup.
const DUTY_LABELS = { 0.125: '12.5%', 0.25: '25%', 0.5: '50%' };

function dutyLabel(d) {
  const hit = DUTY_LABELS[d];
  if (hit) return hit;
  return typeof d === 'number' && Number.isFinite(d) ? String(d) : '50%';
}

/** Python's round(): half-to-even, matching `int(round(x))` on the source side. */
function pyRound(x) {
  if (!Number.isFinite(x)) return 0;
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's `%d`: truncate toward zero. */
function asInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const dur = rng.uniform(0.15, 0.4);
  const f0 = rng.uniform(midi(84), midi(96)); // starts up in the whistle register
  const f1 = rng.uniform(midi(48), midi(64)); // and lands in the low mids
  const duty = rng.choice([0.125, 0.25, 0.5]);
  const vib = rng.uniform(0.0, 30.0); // Hz of swing, at a fixed 60 rad/s rate

  rng.tags = {
    style: 'laser',
    duty,
    from_hz: pyRound(f0), // Python: int(round(f0))
    to_hz: pyRound(f1),
    wobble: vib > 15 ? 'warbled' : 'clean',
    note: noteOfHz(f0), // musicians pick zaps by launch pitch; costs no draw
  };

  // Drawn last: Python evaluates decay(rng.uniform(3.0, 8.0)) as the 4th argument,
  // after int(dur * SR), the lambda and duty.
  const rate = rng.uniform(3.0, 8.0);

  return renderTone(
    Math.trunc(dur * SR), // Python int() truncates toward zero
    (t) => f0 * Math.pow(f1 / f0, t / dur) + vib * Math.sin(60.0 * t),
    duty,
    decay(rate)
  );
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const wobble = typeof t.wobble === 'string' && t.wobble ? t.wobble : 'clean';
  return `${wobble} falling zap — ${asInt(t.from_hz)} down to ${asInt(t.to_hz)} Hz, ${dutyLabel(t.duty)} duty`;
}

/** Short phrase for the README category table. */
export const character = 'fast downward zaps, clean or warbled pew';
