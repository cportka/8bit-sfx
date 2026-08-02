// coin — the classic two-note pickup blip: a high square tone that hops up a
// scale interval partway through and decays away.
//
// Ported 1:1 from `gen_coin` / `describe_coin` in scripts/generate_sfx.py. This
// is a translation, not a redesign: the draw order (uniform, randint, choice,
// uniform, choice, uniform) is the effect's identity, and the samples are
// returned exactly as `render_tone` produced them — no normalization, no DC
// blocking, no edge fades, because the published WAVs have none. `coin_017`
// stays byte-for-byte the sound it has always been.

import { SR, midi, noteName, renderTone, decay } from '../dsp.js';

/** Python's round(): half-to-even, matching `int(round(x))` on the source side. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's round(x, 1) — one decimal, ties to even. */
function pyRound1(x) {
  return pyRound(x * 10) / 10;
}

/** Semitone jump -> the interval name the catalog prints. */
const INTERVAL_NAMES = { 3: 'minor third', 4: 'major third', 5: 'fourth', 7: 'fifth' };

/** Mirror of the Python `_duty` lookup. */
function dutyLabel(d) {
  if (d === 0.125) return '12.5%';
  if (d === 0.25) return '25%';
  if (d === 0.5) return '50%';
  return typeof d === 'number' && Number.isFinite(d) ? String(d) : '50%';
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  // Six draws, in this order — nothing added, nothing reordered.
  const dur = rng.uniform(0.25, 0.5);
  const n = Math.floor(dur * SR); // Python int() truncates; dur > 0 so floor matches
  const root = rng.randint(76, 88); // high register, inclusive both ends
  const jumpIv = rng.choice([3, 4, 5, 7]);
  const split = rng.uniform(0.2, 0.35);
  const duty = rng.choice([0.25, 0.5]);
  const rate = rng.uniform(5.0, 10.0);
  const env = decay(rate);

  rng.tags = {
    style: 'coin',
    duty,
    root_hz: pyRound(midi(root)),
    interval: INTERVAL_NAMES[jumpIv],
    note: noteName(root), // pitch of the first note; derived, costs no draw
    split_pct: pyRound(split * 100),
    fade: pyRound1(rate),
  };

  const lo = midi(root);
  const hi = midi(root + jumpIv);
  const tSplit = dur * split;
  return renderTone(n, (t) => (t < tSplit ? lo : hi), duty, env);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const rootHz = Math.trunc(Number(t.root_hz)) || 0;
  const interval = typeof t.interval === 'string' && t.interval ? t.interval : 'fourth';
  const splitPct = Math.trunc(Number(t.split_pct)) || 0;
  const fadeNum = Number(t.fade);
  const fade = Number.isFinite(fadeNum) ? fadeNum : 0;
  return (
    `two-note pickup blip — ${rootHz} Hz hopping up a ${interval} at ${splitPct}%, ` +
    `${dutyLabel(t.duty)} duty, ${fade.toFixed(1)}/s fade`
  );
}

/** Short phrase for the README category table. */
export const character = 'bright two-note pickup blips, classic coin grab';
