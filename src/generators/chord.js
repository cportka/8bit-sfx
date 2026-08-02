// chord — pitched chord stabs and holds, ten ways. Every voice is an exact MIDI
// note, so a stab lands in tune next to the bass, the lead and the arps instead
// of merely "sounding chippy". Each variation records its ROOT and its QUALITY,
// so a musician picks "F#2 minor 7th, drop 2" out of the catalog rather than
// auditioning 202 files: `chord` is the harmony layer a chip track is written
// on, not a game event.
//
// Fourteen qualities are on the table — major, minor, dominant/minor/major 7th,
// sus4, sus2, diminished, diminished 7th, augmented, half-diminished, add9 and
// the two power chords — voiced seven ways (root position, both inversions,
// drop 2, open spread, octave doubled, two-octave spread), so the same triad
// reads as a tight keyboard stab or a wide, open pad depending on the seed.
//
// The ten sub-styles are the chord vocabulary a beat actually needs: a short
// punchy stab, a held sustain with tremolo or vibrato, a crunchy power chord
// (palm-muted or ringing), a strummed roll up or down the voicing, a wide
// two-octave voicing with a triangle in the cellar, a rhythmically gated chop,
// a bitcrushed digital chord, an orchestra-hit caricature with a noise
// transient, a filter swell, and a detuned PWM stack.
//
// Everything is built from the chip primitives: naive squares/triangles/saws,
// hand-rolled PWM, LFSR noise for the pick and hit transients, one-pole
// filters, tanh drive and a sample-and-hold level crush. Post chain is uniform
// — DC block (a chord of narrow-duty squares carries a big bias), de-click both
// edges, then normalize last so the peak is exact even when the loudest sample
// sits inside the first millisecond.

import {
  SR, Lfsr, square, midi, noteName, renderTone, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.1 * SR);
const MAX_N = Math.round(1.5 * SR);

const LO_M = 24; // C1 — nothing below this, the DC blocker eats it
const HI_M = 93; // A6 — above this a naive square is mostly alias

/** Seconds to a sample count, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

/** Keep a voice inside the category's playable window. */
function clampM(m) {
  return Math.max(LO_M, Math.min(HI_M, Math.round(m)));
}

/** "12.5% duty" / "25% duty" / "50% duty". */
function dutyLabel(d) {
  return `${d * 100}% duty`;
}

/** How a voice is described in the catalog. */
function toneLabel(wave, duty) {
  return wave === 'tri' ? 'triangle' : wave === 'saw' ? 'sawtooth' : dutyLabel(duty);
}

/** One-pole coefficient for a cutoff in Hz. */
function alphaOf(cut) {
  return 1.0 - Math.exp((-2.0 * Math.PI * Math.max(20, Math.min(SR * 0.45, cut))) / SR);
}

/** Cutoff source: a constant or a function of t. */
function cutoffReader(cutoff) {
  return typeof cutoff === 'function' ? (i) => cutoff(i / SR) : () => cutoff;
}

/** One-pole lowpass in place, cutoff in Hz (constant or a function of t). */
function lowpass(buf, cutoff) {
  const fc = cutoffReader(cutoff);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += alphaOf(fc(i)) * (buf[i] - p);
    buf[i] = p;
  }
  return buf;
}

/** One-pole highpass in place — thins the low end without touching the pitch. */
function highpass(buf, cut) {
  const a = alphaOf(cut);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += a * (buf[i] - p);
    buf[i] -= p;
  }
  return buf;
}

/** Sample-and-hold rate reduction plus a coarse level crush, in place. */
function crush(buf, steps, hold) {
  let held = 0.0;
  for (let i = 0; i < buf.length; i++) {
    if (i % hold === 0) held = buf[i];
    buf[i] = Math.round(held * steps) / steps;
  }
  return buf;
}

/** Symmetric tanh drive — amp grit for the power chords and the hits. */
function drive(buf, amount) {
  const k = Math.max(1.0, amount);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(k * buf[i]) / Math.tanh(k);
  return buf;
}

/** Cents to a frequency multiplier. */
function cents(c) {
  return Math.pow(2.0, c / 1200.0);
}

/**
 * Trim a decaying voice's length to its own decay. Eight time constants is
 * -70 dB: past that the buffer is dead air, and a 0.45 s stab that died at
 * 60 ms is really a 60 ms stab with silence stapled to it.
 */
function fitDur(dur, rate, lo) {
  return Math.max(lo, Math.min(dur, 8.0 / Math.max(0.5, rate)));
}

/**
 * Stab envelope: linear attack, exponential decay, and a release taper into the
 * note's end so the tail always reaches zero however hard the chord is ringing.
 */
function stabEnv(atk, rate, dur, rel) {
  const a = Math.max(1e-4, atk);
  const r = Math.max(1e-4, rel);
  return (t) => {
    let v = t < a ? t / a : Math.exp(-rate * (t - a));
    const left = dur - t;
    if (left < r) v *= Math.max(0.0, left / r);
    return v;
  };
}

/** Attack -> decay to a sustain level -> linear release into the chord's end. */
function shaped(dur, atk, dec, sus, rel) {
  const a0 = Math.max(1e-4, atk);
  const d0 = Math.max(1e-4, dec);
  const r0 = Math.max(1e-4, rel);
  return (t) => {
    let v = t < a0 ? t / a0 : t < a0 + d0 ? 1.0 + (sus - 1.0) * ((t - a0) / d0) : sus;
    const left = dur - t;
    if (left < r0) v *= Math.max(0.0, left / r0);
    return v;
  };
}

/** Lowpassed LFSR burst — the pick scrape, the key click, the hit's transient. */
function noiseBurst(rng, n, period, cut, atk, rate) {
  const lf = new Lfsr(rng, period);
  const a = alphaOf(cut);
  const at = Math.max(1e-5, atk);
  const out = new Array(Math.max(1, n));
  let p = 0.0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    p += a * (lf.next() - p);
    out[i] = p * Math.min(1.0, t / at) * Math.exp(-rate * t);
  }
  return out;
}

/** One pulse voice with a moving duty cycle — hand-rolled PWM. */
function pwmVoice(n, f, envFn, base, depth, hz) {
  const out = new Array(n);
  let ph = 0.0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += f / SR;
    const d = Math.max(0.06, Math.min(0.94, base + depth * Math.sin(2 * Math.PI * hz * t)));
    out[i] = square(ph, d) * envFn(t);
  }
  return out;
}

// --- harmony ---------------------------------------------------------------

/** Chord qualities, as semitone offsets from the root. */
const QUALITIES = {
  maj: { label: 'major', ivs: [0, 4, 7] },
  min: { label: 'minor', ivs: [0, 3, 7] },
  dom7: { label: 'dominant 7th', ivs: [0, 4, 7, 10] },
  min7: { label: 'minor 7th', ivs: [0, 3, 7, 10] },
  maj7: { label: 'major 7th', ivs: [0, 4, 7, 11] },
  sus4: { label: 'sus4', ivs: [0, 5, 7] },
  sus2: { label: 'sus2', ivs: [0, 2, 7] },
  dim: { label: 'diminished', ivs: [0, 3, 6] },
  dim7: { label: 'diminished 7th', ivs: [0, 3, 6, 9] },
  aug: { label: 'augmented', ivs: [0, 4, 8] },
  m7b5: { label: 'half-diminished', ivs: [0, 3, 6, 10] },
  add9: { label: 'add9', ivs: [0, 4, 7, 14] },
  pow: { label: 'power', ivs: [0, 7] },
  pow8: { label: 'power octave', ivs: [0, 7, 12] },
};

// Weighted pools: the bread-and-butter triads come up more often than the
// augmented and half-diminished colours, the way a real track uses them.
const FULL = [
  'maj', 'maj', 'maj', 'min', 'min', 'min', 'dom7', 'dom7', 'min7', 'min7',
  'sus4', 'sus4', 'maj7', 'sus2', 'dim', 'dim7', 'aug', 'm7b5', 'add9',
];
const TRIADS = ['maj', 'maj', 'maj', 'min', 'min', 'min', 'sus4', 'sus2', 'dim', 'aug'];
const SEVENTHS = ['dom7', 'dom7', 'min7', 'min7', 'maj7', 'm7b5', 'dim7', 'add9'];
const POWERS = ['pow', 'pow', 'pow8'];

const VOICINGS = [
  'root position', 'root position', 'first inversion', 'second inversion',
  'drop 2', 'open spread', 'octave doubled', 'two-octave spread',
];
const WIDE_VOICINGS = [
  'open spread', 'open spread', 'two-octave spread', 'two-octave spread', 'drop 2', 'octave doubled',
];
const TIGHT_VOICINGS = ['root position', 'first inversion', 'second inversion', 'octave doubled'];

/** Re-voice a set of intervals; unusable transforms fall back to root position. */
function voiceOf(ivs, voicing) {
  const a = ivs.slice();
  let v = a;
  if (voicing === 'first inversion' && a.length > 1) v = [...a.slice(1), a[0] + 12];
  else if (voicing === 'second inversion' && a.length > 2) v = [...a.slice(2), a[0] + 12, a[1] + 12];
  else if (voicing === 'drop 2' && a.length > 2) {
    v = a.slice();
    v[a.length - 2] -= 12;
  } else if (voicing === 'open spread' && a.length > 2) v = a.map((x, i) => x + (i % 2 === 1 ? 12 : 0));
  else if (voicing === 'octave doubled') v = [...a, a[0] + 12];
  else if (voicing === 'two-octave spread' && a.length > 2) v = [a[0] - 12, ...a, a[a.length - 1] + 12];
  return v.slice().sort((x, y) => x - y);
}

/**
 * Pick a chord: a root inside the style's register, a quality, and a voicing.
 * Returns the sounding MIDI notes low-to-high, deduplicated.
 */
function pickChord(rng, loRoot, hiRoot, qualities, voicings) {
  const rootM = rng.randint(loRoot, hiRoot);
  const key = rng.choice(qualities);
  const q = QUALITIES[key];
  const voicing = rng.choice(voicings);
  const notes = [];
  for (const o of voiceOf(q.ivs, voicing)) {
    const m = clampM(rootM + o);
    if (!notes.includes(m)) notes.push(m);
  }
  notes.sort((a, b) => a - b);
  return {
    rootM,
    quality: q.label,
    voicing,
    notes,
    span: notes[notes.length - 1] - notes[0],
    topF: midi(notes[notes.length - 1]),
    note: noteName(rootM),
  };
}

/** Per-voice gain: the root carries, the upper voices sit under it. */
function voiceGain(k, count) {
  return (1.0 / (1.0 + 0.35 * k)) * (1.0 / Math.sqrt(Math.max(1, count) * 0.5));
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'stab', 'held', 'power', 'strum', 'wide', 'gate', 'crush', 'hit', 'swell', 'fat',
  ]);

  let out;
  let tags;

  if (style === 'stab') {
    // The workhorse: every voice hits together, hard, and lets go. This is the
    // chord an off-beat chip track is actually made of.
    const ch = pickChord(rng, 36, 67, FULL, VOICINGS);
    const rate = rng.uniform(9.0, 34.0);
    const dur = fitDur(rng.uniform(0.12, 0.45), rate, 0.12);
    const n = secs(dur);
    const wave = rng.choice([null, null, null, 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const rel = Math.max(0.015, dur * 0.28);
    const skew = rng.uniform(0.0, 0.004); // voices land a hair apart, like a keybed
    const click = rng.uniform(0.0, 0.32);
    out = [];
    ch.notes.forEach((m, k) => {
      const f = midi(m) * cents(rng.uniform(-4, 4));
      const v = renderTone(n, () => f, duty, stabEnv(0.0008, rate * (1.0 + 0.14 * k), dur, rel), wave);
      mixAt(out, v, secs(skew * k), voiceGain(k, ch.notes.length));
    });
    if (click > 0.08) {
      mixAt(out, noiseBurst(rng, Math.min(out.length, secs(0.007)), rng.randint(1, 4),
        ch.topF * 4.0, 0.0004, rng.uniform(400, 1100)), 0, click * 0.5);
    }
    const cut = Math.min(SR * 0.42, ch.topF * rng.uniform(2.2, 8.0));
    lowpass(out, cut);
    tags = {
      style: 'stab',
      quality: ch.quality,
      voicing: ch.voicing,
      attack: click > 0.08 ? 'clicked' : 'clean',
      cut_hz: Math.round(cut),
      note: ch.note,
    };
  } else if (style === 'held') {
    // Sustained: attack, a small drop to a sustain plateau, and either a
    // tremolo, a slow vibrato, or nothing moving at all.
    const ch = pickChord(rng, 36, 64, FULL, VOICINGS);
    const dur = rng.uniform(0.6, 1.45);
    const n = secs(dur);
    const wave = rng.choice([null, null, 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const atk = rng.uniform(0.004, 0.08);
    const sus = rng.uniform(0.5, 0.92);
    const env = shaped(dur, atk, rng.uniform(0.05, 0.3), sus, Math.max(0.05, dur * 0.2));
    const mode = rng.choice(['tremolo', 'vibrato', 'steady', 'steady']);
    const lfoHz = rng.uniform(3.0, 9.0);
    const vibC = rng.uniform(8, 30);
    out = [];
    ch.notes.forEach((m, k) => {
      const f = midi(m) * cents(rng.uniform(-5, 5));
      const freqFn = mode === 'vibrato'
        ? (t) => f * cents(vibC * Math.sin(2 * Math.PI * lfoHz * t * 0.45))
        : () => f;
      const v = renderTone(n, freqFn, duty, env, k === 0 ? rng.choice([wave, 'tri']) : wave);
      mixAt(out, v, 0, voiceGain(k, ch.notes.length));
    });
    if (mode === 'tremolo') {
      const depth = rng.uniform(0.2, 0.6);
      for (let i = 0; i < out.length; i++) {
        out[i] *= 1.0 - depth * 0.5 * (1.0 - Math.cos(2 * Math.PI * lfoHz * (i / SR)));
      }
    }
    const cut = Math.min(SR * 0.42, ch.topF * rng.uniform(1.8, 6.5));
    lowpass(out, cut);
    tags = {
      style: 'held',
      quality: ch.quality,
      voicing: ch.voicing,
      motion: mode,
      cut_hz: Math.round(cut),
      note: ch.note,
    };
  } else if (style === 'power') {
    // Root and fifth, driven until the square edges fold — palm-muted for a
    // chug, ringing for a wall. The one chord chiptune borrowed from guitars.
    const ch = pickChord(rng, 28, 52, POWERS, ['root position', 'root position', 'octave doubled']);
    const muted = rng.random() < 0.5;
    const rate = muted ? rng.uniform(16.0, 40.0) : rng.uniform(1.6, 6.0);
    const dur = muted
      ? fitDur(rng.uniform(0.13, 0.32), rate, 0.13)
      : fitDur(rng.uniform(0.35, 1.2), rate, 0.35);
    const n = secs(dur);
    const wave = rng.choice([null, null, 'saw']);
    const duty = rng.choice([0.5, 0.25]);
    const rel = Math.max(0.015, dur * 0.25);
    const amount = rng.uniform(1.0, 7.0);
    out = [];
    ch.notes.forEach((m, k) => {
      const f = midi(m) * cents(rng.uniform(-7, 7));
      const v = renderTone(n, () => f, duty, stabEnv(0.0009, rate, dur, rel), wave);
      mixAt(out, v, 0, voiceGain(k, ch.notes.length));
    });
    mixAt(out, noiseBurst(rng, Math.min(out.length, secs(0.006)), rng.randint(1, 5),
      ch.topF * 6.0, 0.0004, rng.uniform(500, 1400)), 0, rng.uniform(0.04, 0.22));
    drive(out, amount);
    const cut = Math.min(SR * 0.4, ch.topF * (muted ? rng.uniform(1.4, 3.2) : rng.uniform(3.0, 8.0)));
    lowpass(out, cut);
    highpass(out, midi(ch.rootM) * 0.35);
    tags = {
      style: 'power',
      quality: ch.quality,
      mute: muted ? 'palm-muted' : 'ringing',
      grind: amount > 3.4 ? 'gritty' : 'clean',
      cut_hz: Math.round(cut),
      note: ch.note,
    };
  } else if (style === 'strum') {
    // Rolled: the voices arrive one at a time, low-to-high on a downstroke and
    // high-to-low on an upstroke, each with its own pick scrape.
    const ch = pickChord(rng, 40, 64, FULL, VOICINGS);
    const up = rng.random() < 0.45;
    const roll = rng.uniform(0.008, 0.05);
    const rate = rng.uniform(2.2, 9.0);
    const dur = fitDur(rng.uniform(0.35, 1.3), rate, 0.35);
    const wave = rng.choice([null, null, 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const order = up ? ch.notes.slice().reverse() : ch.notes.slice();
    out = [];
    order.forEach((m, k) => {
      const off = roll * k;
      const d = Math.max(0.06, dur - off);
      const f = midi(m) * cents(rng.uniform(-6, 6));
      const v = renderTone(secs(d), () => f, duty,
        stabEnv(0.0009, rate * rng.uniform(0.9, 1.3), d, Math.max(0.02, d * 0.25)), wave);
      mixAt(v, noiseBurst(rng, Math.min(v.length, secs(0.005)), rng.randint(1, 4),
        midi(m) * 7.0, 0.0004, rng.uniform(600, 1500)), 0, rng.uniform(0.03, 0.18));
      mixAt(out, v, secs(off), voiceGain(k, order.length) * rng.uniform(0.8, 1.05));
    });
    const cut = Math.min(SR * 0.42, ch.topF * rng.uniform(2.5, 9.0));
    lowpass(out, cut);
    tags = {
      style: 'strum',
      quality: ch.quality,
      voicing: ch.voicing,
      stroke: up ? 'upstroke' : 'downstroke',
      roll_ms: Math.round(roll * 1000),
      note: ch.note,
    };
  } else if (style === 'wide') {
    // Wide voicing: a triangle in the cellar, squares up top, two or three
    // octaves between them. Big without being loud.
    const ch = pickChord(rng, 36, 60, FULL, WIDE_VOICINGS);
    const dur = rng.uniform(0.3, 1.25);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const atk = rng.uniform(0.002, 0.05);
    const sus = rng.uniform(0.35, 0.85);
    const env = shaped(dur, atk, rng.uniform(0.04, 0.25), sus, Math.max(0.04, dur * 0.22));
    const bassG = rng.uniform(0.8, 1.6);
    out = [];
    ch.notes.forEach((m, k) => {
      const low = k === 0;
      const f = midi(m) * cents(rng.uniform(-5, 5));
      const v = renderTone(n, () => f, low ? 0.5 : duty, env, low ? 'tri' : rng.choice([null, null, 'tri']));
      mixAt(out, v, 0, voiceGain(k, ch.notes.length) * (low ? bassG : 1.0));
    });
    const airy = bassG < 1.15;
    const cut = Math.min(SR * 0.42, ch.topF * (airy ? rng.uniform(3.0, 8.0) : rng.uniform(1.6, 3.6)));
    lowpass(out, cut);
    tags = {
      style: 'wide',
      quality: ch.quality,
      voicing: ch.voicing,
      register: airy ? 'airy' : 'bass-heavy',
      span: ch.span,
      note: ch.note,
    };
  } else if (style === 'gate') {
    // Gated: one held chord chopped into sixteenths by a rhythm gate. The
    // pattern, not the harmony, is what you buy this one for.
    const ch = pickChord(rng, 40, 67, FULL, VOICINGS);
    const pat = rng.choice([
      { name: 'eighth chop', steps: [1, 0, 1, 0, 1, 0, 1, 0] },
      { name: 'sixteenth stutter', steps: [1, 1, 1, 1, 1, 1, 1, 1] },
      { name: 'offbeat skank', steps: [0, 1, 0, 1, 0, 1, 0, 1] },
      { name: 'trance gate', steps: [1, 0, 1, 1, 0, 1, 0, 1] },
      { name: 'dotted pulse', steps: [1, 0, 0, 1, 0, 0, 1, 0] },
      { name: 'stutter fill', steps: [1, 1, 0, 1, 1, 0, 1, 1] },
    ]);
    const bpm = rng.randint(88, 176);
    const stepN = Math.max(4, Math.round((15.0 / bpm) * SR)); // one sixteenth
    const dur = Math.min(1.45, rng.uniform(0.6, 1.45));
    const n = secs(dur);
    const wave = rng.choice([null, null, 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const hold = rng.uniform(0.35, 0.92); // how much of each step stays open
    out = [];
    ch.notes.forEach((m, k) => {
      const f = midi(m) * cents(rng.uniform(-5, 5));
      const v = renderTone(n, () => f, duty, shaped(dur, 0.004, 0.2, rng.uniform(0.7, 1.0), Math.max(0.03, dur * 0.12)), wave);
      mixAt(out, v, 0, voiceGain(k, ch.notes.length));
    });
    const openN = Math.max(3, Math.round(stepN * hold));
    const edge = Math.max(2, Math.round(0.0015 * SR));
    const g = new Array(out.length).fill(0.0);
    for (let s = 0; s * stepN < out.length; s++) {
      if (!pat.steps[s % pat.steps.length]) continue;
      const start = s * stepN;
      for (let i = 0; i < openN && start + i < g.length; i++) {
        const a = Math.min(1.0, i / edge);
        const r = Math.min(1.0, (openN - i) / edge);
        g[start + i] = Math.max(g[start + i], a * r);
      }
    }
    for (let i = 0; i < out.length; i++) out[i] *= g[i];
    const cut = Math.min(SR * 0.42, ch.topF * rng.uniform(2.0, 7.0));
    lowpass(out, cut);
    tags = {
      style: 'gate',
      quality: ch.quality,
      pattern: pat.name,
      tone: toneLabel(wave, duty),
      bpm,
      note: ch.note,
    };
  } else if (style === 'crush') {
    // Bitcrushed: a clean chord shoved through sample-and-hold and a coarse
    // level crush, so the sustain aliases into digital grit.
    const ch = pickChord(rng, 40, 70, FULL, VOICINGS);
    const rate = rng.uniform(3.0, 18.0);
    const dur = fitDur(rng.uniform(0.15, 0.85), rate, 0.15);
    const n = secs(dur);
    const wave = rng.choice([null, null, 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const rel = Math.max(0.02, dur * 0.26);
    out = [];
    ch.notes.forEach((m, k) => {
      const f = midi(m) * cents(rng.uniform(-8, 8));
      const v = renderTone(n, () => f, duty, stabEnv(0.0008, rate, dur, rel), wave);
      mixAt(out, v, 0, voiceGain(k, ch.notes.length));
    });
    const steps = rng.randint(2, 14);
    const holdN = rng.randint(1, 9);
    crush(out, steps, holdN);
    lowpass(out, Math.min(SR * 0.42, ch.topF * rng.uniform(2.0, 9.0)));
    // A coarse crush quantizes the decaying tail straight to digital zero, the
    // way a 4-bit DAC does. Trim the dead air that leaves rather than shipping
    // a stab that is half silence.
    let last = out.length - 1;
    while (last > MIN_N && Math.abs(out[last]) < 1e-3) last--;
    out = out.slice(0, Math.min(out.length, last + secs(0.008)));
    tags = {
      style: 'crush',
      quality: ch.quality,
      voicing: ch.voicing,
      grit: steps < 7 ? 'coarse' : 'fine',
      steps,
      rate_hz: Math.round(SR / holdN),
      note: ch.note,
    };
  } else if (style === 'hit') {
    // Orchestra hit, chip-style: a noise transient, a fast pitch dip into the
    // chord, saw voices driven hard. A caricature of the sampler cliché.
    const ch = pickChord(rng, 33, 60, rng.choice([TRIADS, SEVENTHS]), TIGHT_VOICINGS);
    const rate = rng.uniform(4.0, 16.0);
    const dur = fitDur(rng.uniform(0.18, 0.7), rate, 0.18);
    const n = secs(dur);
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    const dip = rng.uniform(0.01, 0.08);
    const dtau = rng.uniform(0.006, 0.03);
    const rel = Math.max(0.02, dur * 0.3);
    const stringy = rng.random() < 0.4;
    out = [];
    ch.notes.forEach((m, k) => {
      const f = midi(m) * cents(rng.uniform(-9, 9));
      const v = renderTone(n, (t) => f * (1.0 + dip * Math.exp(-t / dtau)), duty,
        stabEnv(stringy ? 0.008 : 0.0015, rate, dur, rel), wave);
      mixAt(out, v, 0, voiceGain(k, ch.notes.length));
    });
    mixAt(out, noiseBurst(rng, Math.min(out.length, secs(0.03)), rng.randint(1, 6),
      ch.topF * 2.5, 0.0006, rng.uniform(60, 260)), 0, rng.uniform(0.12, 0.45));
    drive(out, rng.uniform(1.0, 4.0));
    const cut = Math.min(SR * 0.42, ch.topF * rng.uniform(2.0, 7.5));
    lowpass(out, cut);
    highpass(out, midi(ch.rootM) * 0.4);
    tags = {
      style: 'hit',
      quality: ch.quality,
      voicing: ch.voicing,
      blast: stringy ? 'stringy' : 'brassy',
      cut_hz: Math.round(cut),
      note: ch.note,
    };
  } else if (style === 'swell') {
    // Swell: the chord fades up while a one-pole opens over it, then closes.
    // Drop it under a transition and let it hand off to the downbeat.
    const ch = pickChord(rng, 36, 62, FULL, VOICINGS);
    const dur = rng.uniform(0.7, 1.45);
    const n = secs(dur);
    const wave = rng.choice([null, null, 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const bloom = rng.random() < 0.4;
    const atk = bloom ? rng.uniform(0.1, 0.3) : rng.uniform(0.3, 0.75) * dur;
    const env = bloom
      ? shaped(dur, atk, rng.uniform(0.2, 0.5), rng.uniform(0.55, 0.9), Math.max(0.06, dur * 0.3))
      : (t) => Math.min(1.0, t / Math.max(1e-4, atk)) * Math.min(1.0, Math.max(0.0, (dur - t) / Math.max(0.03, dur * 0.15)));
    out = [];
    ch.notes.forEach((m, k) => {
      const f = midi(m) * cents(rng.uniform(-6, 6));
      const v = renderTone(n, () => f, duty, env, wave);
      mixAt(out, v, 0, voiceGain(k, ch.notes.length));
    });
    const open = Math.min(SR * 0.42, ch.topF * rng.uniform(2.5, 9.0));
    const shut = Math.max(120, ch.topF * rng.uniform(0.5, 1.1));
    const tau = Math.max(0.05, dur * rng.uniform(0.35, 0.8));
    lowpass(out, (t) => shut + (open - shut) * Math.min(1.0, t / tau));
    tags = {
      style: 'swell',
      quality: ch.quality,
      voicing: ch.voicing,
      shape: bloom ? 'bloom' : 'crescendo',
      open_hz: Math.round(open),
      note: ch.note,
    };
  } else {
    // Detuned PWM stack: every voice doubled a few cents apart with the pulse
    // width breathing under an LFO. Beats slow, chorus wide, still in tune.
    const ch = pickChord(rng, 36, 64, FULL, VOICINGS);
    const dur = rng.uniform(0.3, 1.2);
    const n = secs(dur);
    const det = rng.uniform(4, 34);
    const base = rng.uniform(0.2, 0.5);
    const depth = rng.uniform(0.02, 0.28);
    const lfoHz = rng.uniform(0.6, 6.0);
    const atk = rng.uniform(0.003, 0.05);
    const env = shaped(dur, atk, rng.uniform(0.05, 0.3), rng.uniform(0.45, 0.9), Math.max(0.04, dur * 0.22));
    out = [];
    ch.notes.forEach((m, k) => {
      const f = midi(m);
      const g = voiceGain(k, ch.notes.length);
      mixAt(out, pwmVoice(n, f * cents(-det * 0.5), env, base, depth, lfoHz * rng.uniform(0.8, 1.2)), 0, g * 0.7);
      mixAt(out, pwmVoice(n, f * cents(det * 0.5), env, base, depth, lfoHz * rng.uniform(0.8, 1.2)), 0, g * 0.7);
    });
    const cut = Math.min(SR * 0.42, ch.topF * rng.uniform(2.0, 7.0));
    lowpass(out, cut);
    tags = {
      style: 'fat',
      quality: ch.quality,
      voicing: ch.voicing,
      width: det > 18 ? 'lush' : 'tight',
      detune_cents: Math.round(det),
      note: ch.note,
    };
  }

  rng.tags = tags;

  // Keep every chord inside 0.1 - 1.5 s, block the duty-cycle DC bias, then
  // de-click both edges before normalizing so the peak is exact even when the
  // loudest sample sits inside the first millisecond.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  while (out.length < MIN_N) out.push(0.0);
  const fi = Math.min(out.length >> 2, 12);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.005 * SR), Math.round(0.03 * out.length)));
  dcBlock(out, 0.997);
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C3';
  const quality = t.quality || 'major';
  const voicing = t.voicing || 'root position';
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  switch (t.style) {
    case 'held':
      return `held chord — ${quality}, ${voicing}, ${t.motion || 'steady'}, ${num(t.cut_hz)} Hz on ${note}`;
    case 'power':
      return `power chord — ${quality}, ${t.mute || 'ringing'}, ${t.grind || 'clean'}, ${num(t.cut_hz)} Hz on ${note}`;
    case 'strum':
      return `strummed chord — ${quality}, ${voicing}, ${t.stroke || 'downstroke'}, ${num(t.roll_ms)} ms roll on ${note}`;
    case 'wide':
      return `wide voicing — ${quality} ${voicing}, ${t.register || 'airy'}, ${num(t.span)} semitones on ${note}`;
    case 'gate':
      return `gated chord — ${quality}, ${t.pattern || 'eighth chop'}, ${t.tone || '50% duty'}, ${num(t.bpm)} BPM on ${note}`;
    case 'crush':
      return `bitcrushed chord — ${quality}, ${t.grit || 'coarse'} ${voicing}, ${num(t.steps)} steps at ${num(t.rate_hz)} Hz, ${note}`;
    case 'hit':
      return `orchestra hit — ${quality}, ${voicing}, ${t.blast || 'brassy'}, ${num(t.cut_hz)} Hz on ${note}`;
    case 'swell':
      return `chord swell — ${quality}, ${voicing}, ${t.shape || 'crescendo'}, ${num(t.open_hz)} Hz peak on ${note}`;
    case 'fat':
      return `detuned chord — ${quality}, ${voicing}, ${t.width || 'lush'}, ${num(t.detune_cents)} cents on ${note}`;
    default:
      return `chord stab — ${quality}, ${voicing}, ${t.attack || 'clean'} attack, ${num(t.cut_hz)} Hz on ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'tuned chord stabs, power chords, wide voicings, gated chops';
