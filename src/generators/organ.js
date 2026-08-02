// organ — pitched chip organ tones, ten ways. An organ is not one sound: it is a
// stack of ranks, and which ranks you pull is the whole instrument. So every
// variation here is built the way a real one is — additive: a fundamental plus
// harmonic ranks at the classic drawbar footages (16', 5 1/3', 8', 4', 2 2/3',
// 2', 1 3/5', 1 1/3', 1'), each with its own level, its own waveform and its own
// phase. Pull the low three and it is a jazz flute voice; pull all nine and the
// same note is a full shout.
//
// Every voice is an exact MIDI note between C2 and C5, so a hold lands in tune
// under a lead, next to the bass and the chords, and each variation records its
// PITCH — musicians pick an organ by the note it plays, not by a file number.
//
// The ten sub-styles are the organ vocabulary a track actually needs: a plain
// drawbar tonewheel, a church pipe rank with wind chiff and a 16' pedal, a
// driven rock voice with key click and bite, a leslie cabinet swirling between
// chorale and tremolo speeds, the percussive 2nd/3rd-harmonic tap, a thin reed
// organ breathing through its bellows, a full stack with the low octave under
// it, a cheap transistor combo organ, a rhythmically chopped skank, and the
// scanner vibrato/chorus line.
//
// Everything is chip primitives: naive squares and triangles at harmonic
// ratios (the drawbar stack itself), sawtooth for the driven voices, LFSR noise
// for key click and pipe chiff, hand-rolled one-pole filters, tanh drive, and a
// sample-and-hold crush for the transistor cheese. Post chain is uniform — DC
// block (a stack of narrow-duty squares carries a big bias), de-click both
// edges, normalize last so the peak is exact even when the loudest sample sits
// inside the first millisecond.

import {
  SR, Lfsr, square, triangle, sawtooth, midi, noteName, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.3 * SR);
const MAX_N = Math.round(2.0 * SR);

const LO_M = 36; // C2 — the pedal end of this category
const HI_M = 72; // C5 — above this a stacked square is mostly alias

const NYQ = SR * 0.45; // ranks above this are dropped rather than aliased

/** Drawbar footages as frequency ratios: 16', 5 1/3', 8', 4', 2 2/3', 2', 1 3/5', 1 1/3', 1'. */
const DRAWBARS = [0.5, 1.5, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0];

/** Seconds to a sample count, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

/** Keep a voice inside the category's playable window. */
function clampM(m) {
  return Math.max(LO_M, Math.min(HI_M, Math.round(m)));
}

/** Cents to a frequency multiplier. */
function cents(c) {
  return Math.pow(2.0, c / 1200.0);
}

/** "12.5% duty" / "25% duty" / "50% duty". */
function dutyLabel(d) {
  return `${d * 100}% duty`;
}

/** How a voice is described in the catalog. */
function toneLabel(edge, duty) {
  return edge <= 1 ? 'triangle ranks' : dutyLabel(duty);
}

/** One-pole coefficient for a cutoff in Hz. */
function alphaOf(cut) {
  return 1.0 - Math.exp((-2.0 * Math.PI * Math.max(20, Math.min(SR * 0.45, cut))) / SR);
}

/** One-pole lowpass in place, cutoff in Hz (constant or a function of t). */
function lowpass(buf, cutoff) {
  const fc = typeof cutoff === 'function' ? (i) => cutoff(i / SR) : () => cutoff;
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

/** Symmetric tanh drive — the rock organ's overdriven preamp. */
function drive(buf, amount) {
  const k = Math.max(1.0, amount);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(k * buf[i]) / Math.tanh(k);
  return buf;
}

/** Attack -> decay to a sustain plateau -> linear release into the note's end. */
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

/** Lowpassed LFSR layer — key click, pipe chiff, bellows breath. */
function noiseLayer(rng, n, period, cut, envFn) {
  const lf = new Lfsr(rng, Math.max(1, period));
  const a = alphaOf(cut);
  const out = new Array(Math.max(1, n));
  let p = 0.0;
  for (let i = 0; i < out.length; i++) {
    p += a * (lf.next() - p);
    out[i] = p * envFn(i / SR);
  }
  return out;
}

/** Percussive noise envelope: near-instant attack, exponential fall. */
function burstEnv(atk, rate) {
  const a = Math.max(1e-5, atk);
  return (t) => Math.min(1.0, t / a) * Math.exp(-rate * t);
}

/**
 * Build a rank set from a drawbar registration.
 * `edge` is the footage ratio at which ranks switch from square to triangle —
 * one knob for the whole voice, from all-flute (1) to all-buzz (99).
 */
function makeParts(rng, bars, opts = {}) {
  const duty = opts.duty === undefined ? 0.5 : opts.duty;
  const edge = opts.edge === undefined ? 3 : opts.edge;
  const spread = opts.spread || 0; // per-rank detune, cents
  const base = opts.base || null; // waveform for the 16'/8' ranks
  const parts = [];
  for (let k = 0; k < bars.length; k++) {
    const lvl = bars[k];
    if (lvl <= 0) continue;
    const ratio = DRAWBARS[k];
    const wave = ratio >= edge ? 'tri' : base && ratio <= 1.0 ? base : null;
    parts.push({
      ratio: spread ? ratio * cents(rng.uniform(-spread, spread)) : ratio,
      g: lvl / 8.0,
      wave,
      duty,
      ph: rng.random(), // ranks start decorrelated, so the stack isn't one spike
      env: null,
    });
  }
  return parts;
}

/** Add an extra rank (percussion tap, pedal octave) to a rank set. */
function addRank(rng, parts, ratio, g, wave, duty, env) {
  parts.push({ ratio, g, wave, duty, ph: rng.random(), env: env || null });
  return parts;
}

/**
 * Render a rank set additively: one phase accumulator per rank, all summed
 * against a shared per-sample frequency (so vibrato and leslie doppler bend the
 * whole stack in tune) and a shared amplitude envelope.
 */
function stackTone(n, freqFn, parts, envFn) {
  const out = new Array(n);
  let norm = 0.0;
  for (const p of parts) norm += Math.abs(p.g);
  norm = norm > 1e-9 ? 1.0 / norm : 1.0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = freqFn(t);
    let s = 0.0;
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      const f = f0 * p.ratio;
      p.ph += f / SR;
      if (f > NYQ) continue;
      const w = p.wave === 'tri' ? triangle(p.ph) : p.wave === 'saw' ? sawtooth(p.ph) : square(p.ph, p.duty);
      s += p.g * w * (p.env ? p.env(t) : 1.0);
    }
    out[i] = s * norm * envFn(t);
  }
  return out;
}

/** Amplitude tremolo in place. */
function tremolo(buf, hz, depth, phase0 = 0.0) {
  for (let i = 0; i < buf.length; i++) {
    const ph = hz * (i / SR) + phase0;
    buf[i] *= 1.0 - depth * 0.5 * (1.0 - Math.cos(2 * Math.PI * ph));
  }
  return buf;
}

// --- registrations ---------------------------------------------------------

/** Tonewheel drawbar settings, the way a player names them. */
const REGISTRATIONS = [
  { name: 'full drawbars', bars: [8, 8, 8, 8, 8, 8, 8, 8, 8] },
  { name: 'jazz flutes', bars: [8, 8, 8, 0, 0, 0, 0, 0, 0] },
  { name: 'gospel shout', bars: [8, 8, 8, 8, 0, 0, 0, 0, 8] },
  { name: 'blues bark', bars: [8, 8, 8, 8, 8, 0, 0, 0, 0] },
  { name: 'hollow flute', bars: [8, 0, 8, 0, 0, 0, 0, 0, 8] },
  { name: 'bright reed', bars: [0, 0, 8, 8, 6, 8, 4, 0, 0] },
  { name: 'soft flute', bars: [0, 0, 8, 4, 0, 0, 0, 0, 0] },
  { name: 'whistle top', bars: [0, 0, 6, 0, 0, 6, 0, 0, 8] },
  { name: 'string stop', bars: [0, 0, 6, 8, 4, 6, 2, 4, 2] },
  { name: 'pedal sub', bars: [8, 0, 6, 0, 0, 0, 0, 0, 0] },
  { name: 'fifth stack', bars: [0, 8, 8, 0, 6, 0, 0, 4, 0] },
  { name: 'mellow eight', bars: [4, 0, 8, 6, 0, 0, 0, 0, 0] },
];

const REG_BY = {};
for (const r of REGISTRATIONS) REG_BY[r.name] = r;

const ROCK_REGS = ['blues bark', 'gospel shout', 'jazz flutes', 'full drawbars', 'bright reed', 'string stop']
  .map((n) => REG_BY[n]);
const FULL_REGS = ['full drawbars', 'gospel shout', 'string stop', 'blues bark', 'fifth stack']
  .map((n) => REG_BY[n]);

/** Pipe ranks — each carries its own brightness, since a rank IS its timbre. */
const CHURCH_RANKS = [
  { name: 'principal', bars: [0, 0, 8, 6, 0, 4, 0, 0, 2], edge: 3 },
  { name: 'flute', bars: [0, 0, 8, 4, 0, 0, 0, 0, 0], edge: 1 },
  { name: 'mixture', bars: [0, 4, 8, 6, 5, 5, 3, 3, 2], edge: 4 },
  { name: 'diapason', bars: [6, 0, 8, 5, 0, 3, 0, 0, 0], edge: 2 },
  { name: 'gemshorn', bars: [0, 0, 7, 0, 4, 3, 0, 0, 0], edge: 1 },
  { name: 'tibia', bars: [8, 0, 8, 4, 0, 0, 0, 0, 0], edge: 1 },
];

/** Transistor combo voices — bright, thin, and proudly cheap. */
const COMBO_REGS = [
  { name: 'vox', bars: [0, 0, 8, 6, 0, 5, 0, 0, 3] },
  { name: 'farfisa', bars: [0, 0, 8, 8, 0, 6, 0, 0, 0] },
  { name: 'transistor', bars: [0, 4, 8, 5, 4, 4, 0, 0, 2] },
];

/** Free-reed voices — a couple of ranks and a lot of air. */
const REED_REGS = [
  { name: 'harmonium', bars: [0, 0, 8, 3, 0, 2, 0, 0, 0] },
  { name: 'reed stop', bars: [0, 0, 8, 0, 4, 0, 3, 0, 0] },
  { name: 'melodeon', bars: [0, 2, 8, 4, 2, 0, 0, 0, 0] },
];

const CHOP_PATTERNS = [
  { name: 'offbeat skank', steps: [0, 1, 0, 1, 0, 1, 0, 1] },
  { name: 'reggae bubble', steps: [0, 1, 1, 0, 0, 1, 1, 0] },
  { name: 'eighth chop', steps: [1, 0, 1, 0, 1, 0, 1, 0] },
  { name: 'sixteenth run', steps: [1, 1, 1, 1, 1, 1, 1, 1] },
  { name: 'dotted pulse', steps: [1, 0, 0, 1, 0, 0, 1, 0] },
  { name: 'stutter fill', steps: [1, 1, 0, 1, 1, 0, 1, 1] },
  { name: 'shuffle chop', steps: [1, 0, 1, 1, 0, 1, 0, 0] },
];

/** Scanner settings, as they are labelled on the drawbar panel. */
const SCANNER_MODES = ['V1', 'V2', 'V3', 'C1', 'C2', 'C3'];

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'drawbar', 'church', 'rock', 'leslie', 'percussive', 'reed', 'full', 'combo', 'chop', 'chorus',
  ]);

  let out;
  let tags;

  if (style === 'drawbar') {
    // The plain tonewheel hold: pull a registration, press a key, let go. This
    // is the organ everything else on the list is a variation of.
    const m = clampM(rng.randint(36, 72));
    const f = midi(m);
    const custom = rng.random() < 0.3;
    let regName;
    let bars;
    if (custom) {
      bars = [];
      for (let k = 0; k < DRAWBARS.length; k++) bars.push(rng.randint(0, 8));
      bars[2] = rng.randint(5, 8); // the 8' always carries the pitch
      regName = 'custom drawbars';
    } else {
      const reg = rng.choice(REGISTRATIONS);
      bars = reg.bars;
      regName = reg.name;
    }
    const dur = rng.uniform(0.4, 1.6);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.5, 0.25]);
    const edge = rng.choice([2, 3, 4, 99]);
    const parts = makeParts(rng, bars, { duty, edge, spread: rng.uniform(0, 3) });
    const env = shaped(dur, rng.uniform(0.002, 0.02), rng.uniform(0.03, 0.2),
      rng.uniform(0.7, 1.0), Math.max(0.03, dur * rng.uniform(0.12, 0.3)));
    out = stackTone(n, () => f, parts, env);
    const click = rng.uniform(0.0, 0.5);
    if (click > 0.12) {
      mixAt(out, noiseLayer(rng, Math.min(out.length, secs(0.007)), rng.randint(1, 4),
        Math.min(NYQ, f * 10.0), burstEnv(0.0004, rng.uniform(500, 1600))), 0, click * 0.6);
    }
    const cut = Math.min(SR * 0.42, f * rng.uniform(6.0, 20.0));
    lowpass(out, cut);
    tags = {
      style: 'drawbar',
      registration: regName,
      attack: click > 0.12 ? 'clicked' : 'clean',
      cut_hz: Math.round(cut),
      note: noteName(m),
    };
  } else if (style === 'church') {
    // Pipe organ: wind takes a moment to fill the pipe, the mouth chiffs as it
    // speaks, and a 16' pedal sits an octave under the manual.
    const m = clampM(rng.randint(36, 64));
    const f = midi(m);
    const rank = rng.choice(CHURCH_RANKS);
    const dur = rng.uniform(0.9, 2.0);
    const n = secs(dur);
    const parts = makeParts(rng, rank.bars, { duty: 0.5, edge: rank.edge, spread: rng.uniform(1, 5) });
    const pedal = m >= 45 && rng.random() < 0.55;
    if (pedal) addRank(rng, parts, 0.5, rng.uniform(0.5, 1.1), 'tri', 0.5, null);
    const atk = rng.uniform(0.02, 0.09);
    const env = shaped(dur, atk, rng.uniform(0.08, 0.3), rng.uniform(0.78, 1.0),
      Math.max(0.06, dur * rng.uniform(0.15, 0.3)));
    // The wind never sits perfectly still: a few cents of slow drift.
    const wobHz = rng.uniform(2.5, 6.0);
    const wobC = rng.uniform(0.0, 6.0);
    out = stackTone(n, (t) => f * cents(wobC * Math.sin(2 * Math.PI * wobHz * t)), parts, env);
    const chiff = rng.uniform(0.012, 0.06);
    mixAt(out, noiseLayer(rng, Math.min(out.length, secs(chiff * 2.5)), rng.randint(1, 5),
      Math.min(NYQ, f * rng.uniform(3.0, 8.0)), burstEnv(0.004, 1.0 / chiff)), 0, rng.uniform(0.06, 0.3));
    const tremulant = wobC > 3.0;
    if (tremulant) tremolo(out, wobHz, rng.uniform(0.1, 0.3));
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(4.0, 12.0)));
    tags = {
      style: 'church',
      rank: rank.name,
      pedal: pedal ? 'with 16ft pedal' : 'manual only',
      wind: tremulant ? 'tremulant' : 'steady wind',
      chiff_ms: Math.round(chiff * 1000),
      note: noteName(m),
    };
  } else if (style === 'rock') {
    // Tonewheel into an overdriven preamp: key click up front, the upper ranks
    // folding into each other, the low end trimmed so it barks instead of booms.
    const m = clampM(rng.randint(40, 70));
    const f = midi(m);
    const reg = rng.choice(ROCK_REGS);
    const dur = rng.uniform(0.35, 1.3);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.5, 0.25, 0.125]);
    const parts = makeParts(rng, reg.bars, {
      duty,
      edge: rng.choice([4, 6, 99]),
      spread: rng.uniform(1, 6),
      base: rng.choice([null, null, 'saw']),
    });
    const env = shaped(dur, rng.uniform(0.001, 0.006), rng.uniform(0.02, 0.12),
      rng.uniform(0.6, 0.95), Math.max(0.03, dur * rng.uniform(0.1, 0.25)));
    out = stackTone(n, () => f, parts, env);
    mixAt(out, noiseLayer(rng, Math.min(out.length, secs(0.008)), rng.randint(1, 4),
      Math.min(NYQ, f * 12.0), burstEnv(0.0003, rng.uniform(400, 1400))), 0, rng.uniform(0.15, 0.55));
    const amount = rng.uniform(1.6, 8.0);
    drive(out, amount);
    const cut = Math.min(SR * 0.42, f * rng.uniform(5.0, 16.0));
    lowpass(out, cut);
    highpass(out, f * rng.uniform(0.3, 0.7));
    tags = {
      style: 'rock',
      registration: reg.name,
      grind: amount > 4.5 ? 'snarling' : 'growling',
      cut_hz: Math.round(cut),
      note: noteName(m),
    };
  } else if (style === 'leslie') {
    // Rotary cabinet: the horn swings toward you and away, so the pitch doppler
    // shifts, the level swells and the top end brightens — all on one rotor,
    // parked slow, parked fast, or ramping between the two.
    const m = clampM(rng.randint(36, 69));
    const f = midi(m);
    const rotor = rng.choice(['chorale', 'chorale', 'tremolo', 'tremolo', 'ramping up', 'ramping down']);
    const slow = rng.uniform(0.6, 1.4);
    const fast = rng.uniform(5.0, 7.6);
    const s0 = rotor === 'tremolo' ? fast : rotor === 'ramping down' ? fast : slow;
    const s1 = rotor === 'chorale' ? slow : rotor === 'ramping up' ? fast : rotor === 'tremolo' ? fast : slow;
    const dur = rng.uniform(0.8, 2.0);
    const n = secs(dur);
    const reg = rng.choice(REGISTRATIONS);
    const parts = makeParts(rng, reg.bars, {
      duty: rng.choice([0.5, 0.5, 0.25]),
      edge: rng.choice([3, 4, 99]),
      spread: rng.uniform(0, 4),
    });
    const env = shaped(dur, rng.uniform(0.004, 0.03), rng.uniform(0.05, 0.25),
      rng.uniform(0.75, 1.0), Math.max(0.05, dur * rng.uniform(0.12, 0.28)));
    // Rotor phase = integral of a linearly ramping speed, so nothing steps.
    const rot = (t) => s0 * t + ((s1 - s0) * t * t) / (2.0 * dur);
    const fmC = rng.uniform(5.0, 30.0);
    out = stackTone(n, (t) => f * cents(fmC * Math.sin(2 * Math.PI * rot(t))), parts, env);
    const amDepth = rng.uniform(0.2, 0.7);
    for (let i = 0; i < out.length; i++) {
      const ph = rot(i / SR) + 0.12;
      out[i] *= 1.0 - amDepth * 0.5 * (1.0 - Math.cos(2 * Math.PI * ph));
    }
    const base = Math.min(SR * 0.36, f * rng.uniform(4.0, 12.0));
    lowpass(out, (t) => base * (1.0 + 0.35 * Math.sin(2 * Math.PI * (rot(t) + 0.25))));
    tags = {
      style: 'leslie',
      rotor,
      throw: fmC > 16.0 ? 'wide' : 'tight',
      speed_hz: Math.round(((s0 + s1) / 2.0) * 10) / 10,
      note: noteName(m),
    };
  } else if (style === 'percussive') {
    // The Hammond percussion tap: one extra rank at the 2nd or 3rd harmonic
    // that decays away in a blink, leaving the sustained drawbars behind it.
    const m = clampM(rng.randint(40, 72));
    const f = midi(m);
    const reg = rng.choice(REGISTRATIONS);
    const dur = rng.uniform(0.35, 1.2);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.5, 0.25]);
    const parts = makeParts(rng, reg.bars, { duty, edge: rng.choice([3, 4, 99]), spread: rng.uniform(0, 3) });
    const harm = rng.choice(['2nd', '2nd', '3rd']);
    const fastTap = rng.random() < 0.6;
    const tapRate = fastTap ? rng.uniform(14.0, 34.0) : rng.uniform(4.5, 12.0);
    const tapG = rng.uniform(0.5, 1.6);
    addRank(rng, parts, harm === '3rd' ? 3.0 : 2.0, tapG, rng.choice([null, 'tri']), duty,
      (t) => Math.exp(-tapRate * t));
    const env = shaped(dur, rng.uniform(0.001, 0.008), rng.uniform(0.02, 0.1),
      rng.uniform(0.5, 0.9), Math.max(0.03, dur * rng.uniform(0.12, 0.3)));
    out = stackTone(n, () => f, parts, env);
    mixAt(out, noiseLayer(rng, Math.min(out.length, secs(0.006)), rng.randint(1, 4),
      Math.min(NYQ, f * 9.0), burstEnv(0.0003, rng.uniform(600, 1800))), 0, rng.uniform(0.1, 0.4));
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(5.0, 16.0)));
    tags = {
      style: 'percussive',
      harmonic: harm,
      tap: fastTap ? 'fast' : 'slow',
      volume: tapG > 1.0 ? 'normal' : 'soft',
      tap_ms: Math.round(1000.0 / tapRate),
      note: noteName(m),
    };
  } else if (style === 'reed') {
    // Free reeds and a bellows: two ranks, a lot of air, and a wheeze that
    // never quite settles. Thin on purpose — it sits under everything.
    const m = clampM(rng.randint(40, 72));
    const f = midi(m);
    const reg = rng.choice(REED_REGS);
    const dur = rng.uniform(0.5, 1.8);
    const n = secs(dur);
    const duty = rng.choice([0.125, 0.2, 0.25, 0.3]);
    const det = rng.uniform(5.0, 30.0);
    const env = shaped(dur, rng.uniform(0.03, 0.15), rng.uniform(0.1, 0.35),
      rng.uniform(0.7, 1.0), Math.max(0.05, dur * rng.uniform(0.15, 0.3)));
    const a = makeParts(rng, reg.bars, { duty, edge: rng.choice([2, 3, 99]) });
    const b = makeParts(rng, reg.bars, { duty, edge: rng.choice([2, 3, 99]) });
    out = stackTone(n, () => f * cents(-det * 0.5), a, env);
    mixAt(out, stackTone(n, () => f * cents(det * 0.5), b, env), 0, 0.9);
    const air = rng.uniform(0.04, 0.2);
    const wheeze = rng.uniform(3.5, 7.5);
    mixAt(out, noiseLayer(rng, n, rng.randint(2, 9), Math.min(NYQ, f * rng.uniform(1.5, 4.0)),
      (t) => env(t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * wheeze * t))), 0, air);
    tremolo(out, wheeze, rng.uniform(0.05, 0.22));
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(3.0, 9.0)));
    tags = {
      style: 'reed',
      voice: reg.name,
      breath: air > 0.12 ? 'airy' : 'dry',
      detune_cents: Math.round(det),
      note: noteName(m),
    };
  } else if (style === 'full') {
    // Everything out: all nine drawbars plus the octave underneath, pushed just
    // far enough into the preamp to glue. The "hold the last chord" organ.
    const m = clampM(rng.randint(36, 64));
    const f = midi(m);
    const reg = rng.choice(FULL_REGS);
    const dur = rng.uniform(0.6, 1.8);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.5, 0.25]);
    const parts = makeParts(rng, reg.bars, {
      duty,
      edge: rng.choice([3, 4, 6]),
      spread: rng.uniform(1, 5),
    });
    const subG = rng.uniform(0.4, 1.5);
    addRank(rng, parts, m >= 45 ? 0.5 : 1.0, subG, 'tri', 0.5, null);
    const env = shaped(dur, rng.uniform(0.003, 0.025), rng.uniform(0.05, 0.25),
      rng.uniform(0.8, 1.0), Math.max(0.05, dur * rng.uniform(0.12, 0.28)));
    out = stackTone(n, () => f, parts, env);
    drive(out, rng.uniform(1.0, 3.2));
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(5.0, 18.0)));
    highpass(out, f * 0.28);
    tags = {
      style: 'full',
      weight: subG > 1.0 ? 'thunderous' : 'bright',
      registration: reg.name,
      ranks: parts.length,
      note: noteName(m),
    };
  } else if (style === 'combo') {
    // Transistor combo: no tonewheels, just a divider chain of squares, a
    // shallow fast tremolo and a bit of converter grit. Cheap and glorious.
    const m = clampM(rng.randint(48, 72));
    const f = midi(m);
    const reg = rng.choice(COMBO_REGS);
    const dur = rng.uniform(0.34, 1.0);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const parts = makeParts(rng, reg.bars, { duty, edge: 99, spread: rng.uniform(0, 4) });
    const env = shaped(dur, rng.uniform(0.001, 0.005), rng.uniform(0.02, 0.1),
      rng.uniform(0.7, 1.0), Math.max(0.03, dur * rng.uniform(0.1, 0.25)));
    out = stackTone(n, () => f, parts, env);
    const tremHz = rng.uniform(3.5, 8.0);
    const tremD = rng.uniform(0.12, 0.55);
    tremolo(out, tremHz, tremD);
    crush(out, rng.randint(3, 13), rng.randint(1, 5));
    highpass(out, f * rng.uniform(0.5, 1.1));
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(6.0, 18.0)));
    tags = {
      style: 'combo',
      voice: reg.name,
      tremolo: tremD > 0.33 ? 'deep' : 'shallow',
      trem_hz: Math.round(tremHz * 10) / 10,
      note: noteName(m),
    };
  } else if (style === 'chop') {
    // One held registration cut into sixteenths by the player's left hand: the
    // skank, the bubble, the stutter. The rhythm is what you buy this one for.
    const m = clampM(rng.randint(40, 72));
    const f = midi(m);
    const reg = rng.choice(REGISTRATIONS);
    const pat = rng.choice(CHOP_PATTERNS);
    const bpm = rng.randint(80, 168);
    const stepN = Math.max(4, Math.round((15.0 / bpm) * SR)); // one sixteenth
    const dur = rng.uniform(0.6, 2.0);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const edge = rng.choice([2, 3, 4, 99]);
    const parts = makeParts(rng, reg.bars, { duty, edge, spread: rng.uniform(0, 3) });
    const env = shaped(dur, 0.003, 0.15, rng.uniform(0.75, 1.0), Math.max(0.03, dur * 0.1));
    out = stackTone(n, () => f, parts, env);
    const hold = rng.uniform(0.3, 0.9); // how much of each step stays open
    const openN = Math.max(3, Math.round(stepN * hold));
    const edgeN = Math.max(2, Math.round(0.0015 * SR));
    const g = new Array(out.length).fill(0.0);
    for (let s = 0; s * stepN < out.length; s++) {
      if (!pat.steps[s % pat.steps.length]) continue;
      const start = s * stepN;
      for (let i = 0; i < openN && start + i < g.length; i++) {
        const up = Math.min(1.0, i / edgeN);
        const dn = Math.min(1.0, (openN - i) / edgeN);
        g[start + i] = Math.max(g[start + i], up * dn);
      }
    }
    for (let i = 0; i < out.length; i++) out[i] *= g[i];
    const click = rng.uniform(0.0, 0.35);
    if (click > 0.1) {
      for (let s = 0; s * stepN < out.length; s++) {
        if (!pat.steps[s % pat.steps.length]) continue;
        const len = Math.min(secs(0.005), out.length - s * stepN);
        if (len < 2) break;
        mixAt(out, noiseLayer(rng, len, 2, Math.min(NYQ, f * 8.0), burstEnv(0.0003, 900)), s * stepN, click);
      }
    }
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(5.0, 15.0)));
    tags = {
      style: 'chop',
      pattern: pat.name,
      tone: toneLabel(edge, duty),
      bpm,
      note: noteName(m),
    };
  } else {
    // Scanner vibrato: the whole stack runs through a delay-line scanner, so
    // the pitch sweeps a few cents. V settings send the wet signal alone,
    // C settings blend it back over the dry ranks and chorus against them.
    const m = clampM(rng.randint(40, 72));
    const f = midi(m);
    const mode = rng.choice(SCANNER_MODES);
    const kind = mode[0] === 'C' ? 'chorus' : 'vibrato';
    const step = Number(mode[1]) || 1;
    const det = rng.uniform(4.0, 12.0) * step; // V1 shallow, V3 deep
    const rate = rng.uniform(5.5, 7.6);
    const reg = rng.choice(REGISTRATIONS);
    const dur = rng.uniform(0.6, 1.8);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.5, 0.25]);
    const edge = rng.choice([3, 4, 99]);
    const env = shaped(dur, rng.uniform(0.003, 0.025), rng.uniform(0.04, 0.2),
      rng.uniform(0.75, 1.0), Math.max(0.05, dur * rng.uniform(0.12, 0.28)));
    const wetParts = makeParts(rng, reg.bars, { duty, edge, spread: rng.uniform(0, 3) });
    out = stackTone(n, (t) => f * cents(det * Math.sin(2 * Math.PI * rate * t)), wetParts, env);
    if (kind === 'chorus') {
      const dryParts = makeParts(rng, reg.bars, { duty, edge, spread: rng.uniform(0, 3) });
      mixAt(out, stackTone(n, () => f, dryParts, env), 0, rng.uniform(0.6, 1.0));
    }
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(5.0, 16.0)));
    tags = {
      style: 'chorus',
      kind,
      mode,
      width: det > 18.0 ? 'wide' : 'tight',
      detune_cents: Math.round(det),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every organ tone inside 0.3 - 2.0 s, block the drawbar stack's DC bias
  // (narrow-duty squares each carry one), then de-click both edges before
  // normalizing so the peak is exact even when the loudest sample sits inside
  // the first millisecond.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  while (out.length < MIN_N) out.push(0.0);
  const fi = Math.min(out.length >> 2, 16);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.006 * SR), Math.round(0.02 * out.length)));
  dcBlock(out, 0.997);
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C3';
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  const dec = (v, d) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : d.toFixed(1));
  switch (t.style) {
    case 'church':
      return `church organ — ${t.rank || 'principal'} rank, ${t.pedal || 'manual only'}, ${num(t.chiff_ms)} ms chiff on ${note}`;
    case 'rock':
      return `rock organ — ${t.registration || 'blues bark'}, ${t.grind || 'growling'} drive, ${num(t.cut_hz)} Hz on ${note}`;
    case 'leslie':
      return `rotary organ — ${t.rotor || 'chorale'} rotor, ${t.throw || 'tight'} throw, ${dec(t.speed_hz, 1)} Hz on ${note}`;
    case 'percussive':
      return `percussive organ — ${t.harmonic || '2nd'} harmonic, ${t.tap || 'fast'} ${t.volume || 'soft'} tap, ${num(t.tap_ms)} ms on ${note}`;
    case 'reed':
      return `reed organ — ${t.voice || 'harmonium'}, ${t.breath || 'dry'} breath, ${num(t.detune_cents)} cents on ${note}`;
    case 'full':
      return `full organ stack — ${t.weight || 'bright'}, ${t.registration || 'full drawbars'}, ${num(t.ranks)} ranks on ${note}`;
    case 'combo':
      return `combo organ — ${t.voice || 'vox'}, ${t.tremolo || 'shallow'} tremolo, ${dec(t.trem_hz, 5)} Hz on ${note}`;
    case 'chop':
      return `chopped organ — ${t.pattern || 'eighth chop'}, ${t.tone || '50% duty'}, ${num(t.bpm)} BPM on ${note}`;
    case 'chorus':
      return `scanner ${t.kind || 'vibrato'} organ — ${t.mode || 'V1'} setting, ${t.width || 'tight'}, ${num(t.detune_cents)} cents on ${note}`;
    default:
      return `drawbar organ — ${t.registration || 'jazz flutes'}, ${t.attack || 'clean'} attack, ${num(t.cut_hz)} Hz on ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'drawbar stacks, church pipes, rock bite, leslie swirl, percussive taps';
