// hit — the blunt percussive impact: an LFSR noise burst layered over a square
// "thud" whose pitch dives a full octave across the hit, both crushed under a
// very fast exponential decay.
//
// Ported 1:1 from `gen_hit` / `describe_hit` in scripts/generate_sfx.py. The six
// rng draws (dur, noise period, LFSR seed, f0, duty, mix, fade rate) are the
// effect's identity, and the Python function did no post-processing at all — no
// normalize, no DC block, no edge fades — so neither does this. That literalism
// is what makes `hit_042` synthesize to the bytes the published 0.4.1 WAV shipped.

import { SR, Lfsr, square, midi, noteOfHz, decay } from '../dsp.js';

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

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const dur = rng.uniform(0.08, 0.2);
  // Python int() truncates toward zero; dur * SR > 0, so floor matches.
  const n = Math.floor(dur * SR);
  // The period argument is drawn *before* the Lfsr constructor's own
  // randint(1, 32767) seed draw — Python evaluates arguments left to right.
  const noise = new Lfsr(rng, rng.randint(1, 4));
  const f0 = rng.uniform(midi(50), midi(62));
  const duty = rng.choice([0.25, 0.5]);
  const mix = rng.uniform(0.4, 0.7);
  const env = decay(rng.uniform(15.0, 30.0));

  rng.tags = {
    style: 'hit',
    duty,
    thud_hz: pyRound(f0),
    balance: mix > 0.55 ? 'noise-forward' : 'tone-forward',
    note: noteOfHz(f0), // starting pitch of the thud; derived, costs no draw
  };

  const out = new Array(n);
  let phase = 0.0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    phase += (f0 * Math.pow(0.5, t / dur)) / SR;
    const s = mix * noise.next() + (1.0 - mix) * square(phase, duty);
    out[i] = s * env(t);
  }
  return out;
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const balance = typeof t.balance === 'string' && t.balance ? t.balance : 'tone-forward';
  const thud = Number(t.thud_hz);
  const hz = Number.isFinite(thud) ? Math.trunc(thud) : 0;
  return `${balance} impact — ${hz} Hz thud under the burst, ${dutyLabel(t.duty)} duty`;
}

/** Short phrase for the README category table. */
export const character = 'blunt impacts, noise burst over a diving low thud';
