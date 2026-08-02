// The 28 sounds ported from cportka/pixel-rpg's `SOUNDS` table.
//
// These are the one part of the library that isn't procedural: they're an exact
// re-creation of that game's Web Audio engine (src/audio/engine.js) — linear
// frequency sweeps, exponential gain ramps to 0.001, and an LCG noise source
// pushed through a swept Q=1 bandpass. Rendered here in the same JS the game
// used, so they are the game's sounds, not an impression of them.

import { SR, square, triangle } from './dsp.js';

export const PORTED_SOUNDS = {
  'step-person': [{ type: 'noise', f0: 750, f1: 420, d: 0.045, v: 0.05 }],
  'step-dog': [{ type: 'noise', f0: 1400, f1: 900, d: 0.03, v: 0.035 }],
  caption: [
    { type: 'tone', wave: 'square', f0: 660, d: 0.04, v: 0.05 },
    { type: 'tone', wave: 'square', f0: 880, d: 0.055, v: 0.05, t: 0.05 },
  ],
  whimper: [
    { type: 'tone', wave: 'triangle', f0: 1150, f1: 920, d: 0.12, v: 0.07 },
    { type: 'tone', wave: 'triangle', f0: 1000, f1: 700, d: 0.18, v: 0.06, t: 0.16 },
  ],
  'menu-open': [
    { type: 'tone', wave: 'triangle', f0: 440, d: 0.06, v: 0.09 },
    { type: 'tone', wave: 'triangle', f0: 554, d: 0.06, v: 0.09, t: 0.06 },
    { type: 'tone', wave: 'triangle', f0: 659, d: 0.09, v: 0.09, t: 0.12 },
  ],
  'menu-move': [{ type: 'tone', wave: 'square', f0: 880, d: 0.03, v: 0.05 }],
  'menu-confirm': [
    { type: 'tone', wave: 'square', f0: 660, d: 0.05, v: 0.08 },
    { type: 'tone', wave: 'square', f0: 990, d: 0.07, v: 0.08, t: 0.055 },
  ],
  roll: [
    { type: 'noise', f0: 2600, f1: 2200, d: 0.03, v: 0.06 },
    { type: 'noise', f0: 2200, f1: 1800, d: 0.03, v: 0.06, t: 0.05 },
    { type: 'noise', f0: 1800, f1: 1500, d: 0.03, v: 0.06, t: 0.1 },
    { type: 'tone', wave: 'square', f0: 1320, d: 0.08, v: 0.07, t: 0.16 },
  ],
  damage: [{ type: 'tone', wave: 'square', f0: 220, f1: 96, d: 0.2, v: 0.11 }],
  heal: [
    { type: 'tone', wave: 'triangle', f0: 523, d: 0.07, v: 0.09 },
    { type: 'tone', wave: 'triangle', f0: 659, d: 0.07, v: 0.09, t: 0.07 },
    { type: 'tone', wave: 'triangle', f0: 784, d: 0.11, v: 0.09, t: 0.14 },
  ],
  collapse: [
    { type: 'tone', wave: 'sawtooth', f0: 440, f1: 52, d: 0.65, v: 0.13 },
    { type: 'noise', f0: 900, f1: 150, d: 0.5, v: 0.06, t: 0.12 },
  ],
  swap: [
    { type: 'tone', wave: 'square', f0: 440, f1: 233, d: 0.07, v: 0.08 },
    { type: 'tone', wave: 'square', f0: 233, f1: 466, d: 0.09, v: 0.08, t: 0.08 },
  ],
  throw: [{ type: 'noise', f0: 400, f1: 1900, d: 0.18, v: 0.08 }],
  pickup: [{ type: 'tone', wave: 'square', f0: 988, f1: 1175, d: 0.06, v: 0.08 }],
  deliver: [
    { type: 'tone', wave: 'square', f0: 523, d: 0.06, v: 0.09 },
    { type: 'tone', wave: 'square', f0: 659, d: 0.06, v: 0.09, t: 0.06 },
    { type: 'tone', wave: 'square', f0: 784, d: 0.06, v: 0.09, t: 0.12 },
    { type: 'tone', wave: 'square', f0: 1047, d: 0.1, v: 0.09, t: 0.18 },
  ],
  meet: [
    { type: 'tone', wave: 'triangle', f0: 392, d: 0.11, v: 0.13 },
    { type: 'tone', wave: 'triangle', f0: 523, d: 0.11, v: 0.13, t: 0.11 },
    { type: 'tone', wave: 'triangle', f0: 659, d: 0.11, v: 0.13, t: 0.22 },
    { type: 'tone', wave: 'triangle', f0: 784, d: 0.2, v: 0.13, t: 0.33 },
  ],
  inflatables: [
    { type: 'tone', wave: 'triangle', f0: 330, f1: 415, d: 0.12, v: 0.09 },
    { type: 'tone', wave: 'triangle', f0: 415, f1: 330, d: 0.12, v: 0.09, t: 0.12 },
    { type: 'tone', wave: 'triangle', f0: 330, f1: 494, d: 0.16, v: 0.09, t: 0.24 },
  ],
  genie: [
    { type: 'tone', wave: 'triangle', f0: 330, d: 0.09, v: 0.1 },
    { type: 'tone', wave: 'triangle', f0: 415, d: 0.09, v: 0.1, t: 0.09 },
    { type: 'tone', wave: 'triangle', f0: 494, d: 0.09, v: 0.1, t: 0.18 },
    { type: 'tone', wave: 'triangle', f0: 659, f1: 880, d: 0.22, v: 0.1, t: 0.27 },
  ],
  vision: [
    { type: 'tone', wave: 'triangle', f0: 523, f1: 554, d: 0.25, v: 0.08 },
    { type: 'tone', wave: 'triangle', f0: 622, f1: 659, d: 0.25, v: 0.08, t: 0.22 },
    { type: 'tone', wave: 'triangle', f0: 740, f1: 784, d: 0.35, v: 0.08, t: 0.44 },
  ],
  vanish: [
    { type: 'tone', wave: 'square', f0: 1200, f1: 2400, d: 0.07, v: 0.07 },
    { type: 'tone', wave: 'square', f0: 800, f1: 1600, d: 0.07, v: 0.06, t: 0.05 },
  ],
  zombie: [
    { type: 'tone', wave: 'sawtooth', f0: 95, f1: 62, d: 0.45, v: 0.1 },
    { type: 'noise', f0: 300, f1: 180, d: 0.3, v: 0.04, t: 0.1 },
  ],
  bonk: [
    { type: 'noise', f0: 320, f1: 130, d: 0.09, v: 0.12 },
    { type: 'tone', wave: 'triangle', f0: 150, f1: 110, d: 0.08, v: 0.1, t: 0.02 },
  ],
  eat: [
    { type: 'noise', f0: 700, f1: 400, d: 0.06, v: 0.08 },
    { type: 'noise', f0: 600, f1: 350, d: 0.07, v: 0.08, t: 0.12 },
    { type: 'tone', wave: 'triangle', f0: 523, f1: 659, d: 0.09, v: 0.07, t: 0.24 },
  ],
  drunk: [
    { type: 'tone', wave: 'triangle', f0: 440, f1: 392, d: 0.2, v: 0.09 },
    { type: 'tone', wave: 'triangle', f0: 392, f1: 466, d: 0.3, v: 0.09, t: 0.2 },
    { type: 'tone', wave: 'triangle', f0: 466, f1: 415, d: 0.35, v: 0.08, t: 0.5 },
  ],
  // added game-side in pixel-rpg v0.13.0 (levels) and v0.14.0 (the mansion)
  xp: [
    { type: 'tone', wave: 'square', f0: 1175, d: 0.05, v: 0.07 },
    { type: 'tone', wave: 'square', f0: 1568, d: 0.08, v: 0.07, t: 0.05 },
  ],
  levelup: [
    { type: 'tone', wave: 'triangle', f0: 523, d: 0.09, v: 0.11 },
    { type: 'tone', wave: 'triangle', f0: 659, d: 0.09, v: 0.11, t: 0.09 },
    { type: 'tone', wave: 'triangle', f0: 784, d: 0.09, v: 0.11, t: 0.18 },
    { type: 'tone', wave: 'triangle', f0: 1047, d: 0.2, v: 0.12, t: 0.27 },
    { type: 'noise', f0: 2500, f1: 3500, d: 0.15, v: 0.05, t: 0.3 },
  ],
  door: [
    { type: 'noise', f0: 300, f1: 70, d: 0.35, v: 0.09 },
    { type: 'tone', wave: 'triangle', f0: 82, f1: 60, d: 0.12, v: 0.1, t: 0.34 },
  ],
  clock: [
    { type: 'tone', wave: 'square', f0: 220, d: 0.03, v: 0.06 },
    { type: 'tone', wave: 'square', f0: 174, d: 0.03, v: 0.05, t: 0.45 },
  ],
};

export const PORTED_DESCRIPTIONS = {
  'step-person': "the person's footstep — a soft noise tick swept 750 down to 420 Hz",
  'step-dog': "the dog's lighter, brighter step tick, 1400 down to 900 Hz",
  caption: 'two-note square dialog blip, 660 then 880 Hz',
  whimper: 'drooping two-bend triangle whimper — the dog’s hint call',
  'menu-open': 'rising three-note triangle chime for opening a menu',
  'menu-move': 'single 880 Hz square tick for cursor movement',
  'menu-confirm': 'two-note square confirm, 660 into 990 Hz',
  roll: 'dice rattle — three falling noise chits and a 1320 Hz landing ping',
  damage: 'square hurt drop, 220 falling to 96 Hz',
  heal: 'gentle rising triangle triad, C5 E5 G5',
  collapse: 'long sawtooth fall 440 to 52 Hz over sinking noise — going down',
  swap: 'square down-up flip, 440-233 then 233-466 Hz — trading bodies',
  throw: 'rising noise whoosh 400 to 1900 Hz — the ball leaves the hand',
  pickup: 'quick square up-blip 988 to 1175 Hz — the ball is caught',
  deliver: 'four-note square arpeggio C E G C — GOOD DOG',
  meet: 'the meeting fanfare — four rising triangle notes G C E G',
  inflatables: 'wobbling triangle down-up-down bends around 330-494 Hz',
  genie: 'stepped triangle rise into a 659-880 Hz swell — smoke billows',
  vision: 'three slow up-bending triangle pairs — the psychedelic vision',
  vanish: 'two upward square zips, 1200-2400 and 800-1600 Hz — static out',
  zombie: 'low sawtooth groan 95 to 62 Hz over a dark noise rasp',
  bonk: 'blunt noise thump with a 150-110 Hz triangle knock — the bone lands',
  eat: 'two noise chomps and a happy 523-659 Hz triangle uptick',
  drunk: 'three woozy triangle bends drifting around 440 Hz — the room sways',
  xp: 'two-note square gain blip, 1175 up to 1568 Hz — experience earned',
  levelup: 'four-note rising triangle fanfare C E G C with a noise sparkle tail',
  door: 'long noise creak 300 down to 70 Hz, then a low triangle shut',
  clock: 'two dry square ticks 450 ms apart, 220 then 174 Hz — the grandfather clock',
};

export const PORTED_NAMES = Object.keys(PORTED_SOUNDS);

/**
 * Render one ported sound. Returns {samples, peak} — `peak` is the level before
 * normalization, which the catalog turns into the sound's `gain` relative to the
 * loudest of the set, preserving the game's deliberately soft mix.
 */
export function renderPorted(label) {
  const segments = PORTED_SOUNDS[label];
  if (!segments) throw new Error(`8bit-sfx: unknown ported sound "${label}"`);

  let total = 0;
  for (const seg of segments) total = Math.max(total, (seg.t ?? 0) + seg.d);
  const out = new Array(Math.floor((total + 0.05) * SR)).fill(0);

  for (const seg of segments) {
    const start = Math.floor((seg.t ?? 0) * SR);
    const dn = Math.floor(seg.d * SR);
    const v = seg.v;
    const f0 = seg.f0;
    const f1 = seg.f1 ?? seg.f0;
    const envBase = 0.001 / v; // exponentialRampToValueAtTime(0.001, at + d)

    if (seg.type === 'noise') {
      // engine.js noiseBuffer()'s LCG, then an RBJ bandpass (Q=1) with a swept centre
      let lcg = 1234567;
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < dn; i++) {
        lcg = (lcg * 1103515245 + 12345) & 0x7fffffff;
        const x0 = lcg / 0x3fffffff - 1.0;
        const f = f0 + (f1 - f0) * (i / dn);
        const w0 = (2.0 * Math.PI * Math.min(f, SR * 0.45)) / SR;
        const alpha = Math.sin(w0) / 2.0;
        const a0 = 1.0 + alpha;
        const y0 =
          (alpha / a0) * (x0 - x2) + ((2.0 * Math.cos(w0)) / a0) * y1 - ((1.0 - alpha) / a0) * y2;
        x2 = x1; // the biquad's x2 lags two samples, not one
        x1 = x0;
        y2 = y1;
        y1 = y0;
        out[start + i] += y0 * (v * Math.pow(envBase, i / dn));
      }
    } else {
      let phase = 0.0;
      for (let i = 0; i < dn; i++) {
        const f = f0 + (f1 - f0) * (i / dn);
        phase += f / SR;
        const s =
          seg.wave === 'triangle'
            ? triangle(phase)
            : seg.wave === 'sawtooth'
              ? 2.0 * (phase % 1.0) - 1.0
              : square(phase, 0.5);
        out[start + i] += s * (v * Math.pow(envBase, i / dn));
      }
    }
  }

  let peak = 0;
  for (const s of out) {
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  if (!peak) peak = 1.0;
  // 8 bits is too coarse for the game's soft mix (a quiet step would land on ~2
  // levels), so each sound fills the range and the catalog keeps the true ratio.
  return { samples: out.map((s) => (s * 0.9) / peak), peak };
}
