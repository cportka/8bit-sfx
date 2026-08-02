// pad — sustained chip pads, ten ways. A pad is the one voice in a chip track
// that never hits: it arrives, it holds, it leaves. Everything interesting has
// to happen *inside* the note, so every variation here is built around a
// different way of keeping a held note alive — desks of detuned squares beating
// against each other, a filter crawling open across three seconds, a tremolo
// shivering between two intervals, a gate chopping the sustain into eighths.
//
// Every voice is an exact MIDI note between C2 and C4, the register a pad
// actually occupies under a lead and over the bass, and each variation records
// its PITCH, because a musician picks a pad by the note it holds.
//
// The ten sub-styles are the pad section's working vocabulary: a warm detuned
// bed, a glassy bright stack, a dark ominous slab, a slowly evolving filter
// sweep, a formant-caricature choir, a shimmering tremolo pair, an
// octave-stacked registration, a tempo-locked pulsing gate, a sample-and-hold
// bubbler, and a swell that morphs from one timbre into another.
//
// The instrument is a chip caricature, not a sample: naive squares and
// sawtooths for the beds, triangles for the partial stacks and the choir's
// formant ranks, LFSR noise for air and rumble, hand-rolled one-pole filters
// (cascaded, with a cheap band-emphasis "resonance") for every sweep, tanh for
// weight and sample-and-hold crush for grit. Post chain is uniform — DC block
// (narrow-duty squares carry a bias), de-click both edges, then normalize last
// so the peak is exact even when the loudest sample sits mid-swell.

import {
  SR, Lfsr, square, triangle, sawtooth, midi, noteName, renderTone, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(1.55 * SR);
const MAX_N = Math.round(3.45 * SR);

const LO_M = 36; // C2 — the bottom of the pad register
const HI_M = 60; // C4 — the top before a pad turns into a lead

const NYQ = SR * 0.45; // ranks above this are dropped rather than aliased

/** Seconds to a sample count, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

/** One-pole coefficient for a cutoff in Hz. */
function alphaOf(cut) {
  return 1.0 - Math.exp((-2.0 * Math.PI * Math.max(20, Math.min(NYQ, cut))) / SR);
}

/** Per-sample coefficient source: a constant cutoff or f(t) in Hz. */
function alphaReader(cut) {
  if (typeof cut === 'function') return (i) => alphaOf(cut(i / SR));
  const a = alphaOf(cut);
  return () => a;
}

/** One-pole lowpass in place — the pad's tone control. */
function lowpass(buf, cut) {
  const A = alphaReader(cut);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += A(i) * (buf[i] - p);
    buf[i] = p;
  }
  return buf;
}

/**
 * Two one-poles in series with the band between them fed back into the output —
 * a 12 dB slope with a cheap resonant bump at the cutoff, which is what makes a
 * slow sweep audible at all.
 */
function lowpass2(buf, cut, res = 0.0) {
  const A = alphaReader(cut);
  let p1 = 0.0;
  let p2 = 0.0;
  for (let i = 0; i < buf.length; i++) {
    const a = A(i);
    p1 += a * (buf[i] - p1);
    p2 += a * (p1 - p2);
    buf[i] = p2 + res * (p1 - p2);
  }
  return buf;
}

/** One-pole highpass in place — thins a stack without touching the pitch. */
function highpass(buf, cut) {
  const a = alphaOf(cut);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += a * (buf[i] - p);
    buf[i] -= p;
  }
  return buf;
}

/** Sample-and-hold rate reduction plus a level crush, scaled to the peak. */
function crush(buf, steps, hold) {
  let pk = 0.0;
  for (const v of buf) {
    const a = v < 0 ? -v : v;
    if (a > pk) pk = a;
  }
  if (pk < 1e-9) return buf;
  const s = Math.max(1, steps);
  const h = Math.max(1, hold);
  let held = 0.0;
  for (let i = 0; i < buf.length; i++) {
    if (i % h === 0) held = buf[i] / pk;
    buf[i] = (Math.round(held * s) / s) * pk;
  }
  return buf;
}

/** Soft saturation — weight, normalized so the level does not jump. */
function drive(buf, amount) {
  const k = Math.max(1e-3, amount);
  const norm = 1.0 / Math.tanh(k);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * k) * norm;
  return buf;
}

/**
 * Pad envelope: raised-cosine in (no zipper on a slow fade), an optional slow
 * sag toward `sus`, and a raised-cosine release that guarantees the note has
 * reached zero by `dur` however long the tail wants to be.
 */
function padEnv(atk, dur, rel, sus = 1.0, sagTau = 1e9) {
  const a = Math.max(1e-3, Math.min(atk, dur * 0.8));
  const r = Math.max(1e-3, Math.min(rel, dur * 0.6));
  const tau = Math.max(1e-3, sagTau);
  return (t) => {
    let v = t < a ? 0.5 - 0.5 * Math.cos(Math.PI * (t / a)) : 1.0;
    if (sus < 1.0) v *= sus + (1.0 - sus) * Math.exp(-Math.max(0.0, t - a) / tau);
    const left = dur - t;
    if (left < r) {
      const x = Math.max(0.0, left / r);
      v *= 0.5 - 0.5 * Math.cos(Math.PI * x);
    }
    return v;
  };
}

/** Slow pitch drift / vibrato around a base frequency (constant or f(t)). */
function driftFn(base, cents, hz, phase, onset = 0.0) {
  const b = typeof base === 'function' ? base : () => base;
  if (cents < 0.2) return b;
  const k = cents / 1200.0;
  const on = Math.max(1e-3, onset);
  return (t) => b(t) * Math.pow(2.0,
    k * (onset > 0 ? Math.min(1.0, t / on) : 1.0) * Math.sin(2.0 * Math.PI * hz * t + phase));
}

/**
 * A whole partial stack in one pass — cheaper and steadier than N renderTones.
 *
 * The starting phases are Schroeder-spread rather than all zero: a stack that
 * starts coherent is an impulse train, which peak-normalizes to a thin buzz.
 * Spread, the same partials fill the note instead of spiking it.
 */
function additive(n, freqFn, parts, envFn) {
  const out = new Array(n);
  const ph = new Array(parts.length);
  for (let k = 0; k < parts.length; k++) ph[k] = ((k * (k + 1)) / (2 * parts.length)) % 1.0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = freqFn(t);
    let s = 0.0;
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      ph[k] += (f * p.mult) / SR;
      s += p.g * (p.wave === 'tri' ? triangle(ph[k])
        : p.wave === 'saw' ? sawtooth(ph[k])
          : square(ph[k], p.duty === undefined ? 0.5 : p.duty));
    }
    out[i] = s * envFn(t);
  }
  return out;
}

/** Band-limited LFSR noise shaped by an envelope — air, breath, rumble. */
function noiseBed(rng, n, period, lo, hi, envFn) {
  const lf = new Lfsr(rng, Math.max(1, period));
  const a = alphaOf(hi);
  const b = alphaOf(lo);
  const out = new Array(n);
  let lp = 0.0;
  let hp = 0.0;
  for (let i = 0; i < n; i++) {
    lp += a * (lf.next() - lp);
    hp += b * (lp - hp);
    out[i] = (lp - hp) * envFn(i / SR);
  }
  return out;
}

/**
 * Sample-and-hold control voltage in [0,1), clocked off the LFSR at `period`
 * samples. The register's state is hashed before use so consecutive holds do
 * not slide the way raw shift-register bits do.
 */
function shSequence(rng, n, period) {
  const p = Math.max(1, period);
  const lf = new Lfsr(rng, p);
  const out = new Array(n);
  let held = 0.5;
  for (let i = 0; i < n; i++) {
    lf.next();
    if (i % p === 0) held = (Math.imul(lf.state ^ 0x9e3779b9, 2654435761) >>> 0) / 4294967296.0;
    out[i] = held;
  }
  return out;
}

/** "12.5% duty" / "sawtooth" / "triangle" — how a tone reads in the catalog. */
function toneLabel(wave, duty) {
  if (wave === 'tri') return 'triangle';
  if (wave === 'saw') return 'sawtooth';
  return `${Math.round(duty * 1000) / 10}% duty`;
}

/** Mix a harmonic rank in, unless it would alias. */
function addRank(out, n, freqFn, mult, gain, envFn, wave, duty, f0) {
  if (f0 * mult > NYQ || gain < 0.01) return;
  mixAt(out, renderTone(n, (t) => freqFn(t) * mult, duty, envFn, wave), 0, gain);
}

/** Vowel caricatures — two formant bumps painted onto a harmonic series. */
const VOWELS = {
  ah: { f1: 730, f2: 1090 },
  oo: { f1: 300, f2: 870 },
  ee: { f1: 270, f2: 2290 },
  oh: { f1: 570, f2: 840 },
  eh: { f1: 530, f2: 1840 },
};

/** Drawbar-ish registrations for the octave-stacked pad, in semitones. */
const REGISTRATIONS = [
  { name: 'octaves', semis: [0, 12] },
  { name: 'sub and octave', semis: [-12, 0, 12] },
  { name: 'fifth stack', semis: [0, 7, 12] },
  { name: 'twelfth stack', semis: [0, 12, 19] },
  { name: 'double octave', semis: [0, 12, 24] },
  { name: 'full stack', semis: [-12, 0, 7, 12, 19] },
  { name: 'hollow fifths', semis: [0, 7, 19] },
];

/** Gate divisions, in beats. */
const DIVISIONS = [
  { name: 'quarters', beats: 1.0 },
  { name: 'eighths', beats: 0.5 },
  { name: 'eighths', beats: 0.5 },
  { name: 'sixteenths', beats: 0.25 },
  { name: 'triplet eighths', beats: 1.0 / 3.0 },
  { name: 'dotted eighths', beats: 0.75 },
];

/** Accent patterns the gate walks through, one entry per step. */
const ACCENTS = [
  { name: 'steady', amp: [1.0] },
  { name: 'steady', amp: [1.0] },
  { name: 'backbeat', amp: [1.0, 0.55] },
  { name: 'three-two', amp: [1.0, 0.6, 0.85, 0.6, 0.75] },
  { name: 'swelling', amp: [0.55, 0.72, 0.86, 1.0] },
  { name: 'stuttered', amp: [1.0, 0.32, 0.8, 0.32] },
];

/** Scales the sample-and-hold bubbler quantizes to, in semitones. */
const SCALES = [
  { name: 'minor pentatonic', degrees: [0, 3, 5, 7, 10, 12, 15, 19] },
  { name: 'major pentatonic', degrees: [0, 2, 4, 7, 9, 12, 14, 19] },
  { name: 'natural minor', degrees: [0, 2, 3, 5, 7, 8, 10, 12] },
  { name: 'whole tone', degrees: [0, 2, 4, 6, 8, 10, 12, 14] },
  { name: 'open fifths', degrees: [0, 7, 12, 19, 24, 12, 7, 0] },
];

/** Timbre pairs the swell morphs between. */
const MORPHS = [
  { from: 'dark square', to: 'bright saw', a: { wave: null, duty: 0.125 }, b: { wave: 'saw', duty: 0.5 } },
  { from: 'hollow triangle', to: 'reedy square', a: { wave: 'tri', duty: 0.5 }, b: { wave: null, duty: 0.25 } },
  { from: 'soft saw', to: 'glassy triangle', a: { wave: 'saw', duty: 0.5 }, b: { wave: 'tri', duty: 0.5 } },
  { from: 'thin pulse', to: 'full square', a: { wave: null, duty: 0.125 }, b: { wave: null, duty: 0.5 } },
  { from: 'muted triangle', to: 'buzzing saw', a: { wave: 'tri', duty: 0.5 }, b: { wave: 'saw', duty: 0.5 } },
];

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'warm', 'glass', 'dark', 'sweep', 'choir', 'shimmer', 'octave', 'gate', 'sandh', 'swell',
  ]);

  let out;
  let tags;

  if (style === 'warm') {
    // Warm detuned bed: two to five desks a few cents apart, each drifting on
    // its own slow cycle. The beating between them is the whole sound — a
    // single square held for three seconds is a test tone, five are a pad.
    const m = rng.randint(LO_M, 55);
    const f = midi(m);
    const dur = rng.uniform(1.9, 3.4);
    const n = secs(dur);
    const voices = rng.randint(2, 5);
    const spread = rng.uniform(5.0, 30.0);
    const atk = rng.uniform(0.15, 0.75);
    const rel = rng.uniform(0.35, 1.1);
    const wave = rng.choice(['saw', 'saw', null, null]);
    const duty = rng.choice([0.5, 0.25, 0.375]);
    const sus = rng.uniform(0.72, 1.0);
    const sub = rng.random() < 0.55;
    out = [];
    for (let k = 0; k < voices; k++) {
      const cents = spread * (k / Math.max(1, voices - 1) - 0.5);
      const fk = f * Math.pow(2.0, cents / 1200.0);
      const freqFn = driftFn(fk, rng.uniform(1.5, 6.0), rng.uniform(0.08, 0.5), rng.uniform(0, 6.283));
      const env = padEnv(atk * rng.uniform(0.85, 1.3), dur, rel, sus, rng.uniform(0.8, 3.0));
      mixAt(out, renderTone(n, freqFn, duty, env, wave), 0,
        rng.uniform(0.75, 1.0) / Math.sqrt(voices));
    }
    if (sub) {
      mixAt(out, renderTone(n, () => f * 0.5, 0.5, padEnv(atk * 1.25, dur, rel), 'tri'),
        0, rng.uniform(0.28, 0.6));
    }
    const air = rng.uniform(0.012, 0.06);
    mixAt(out, noiseBed(rng, n, rng.randint(3, 9), f * 0.7, Math.min(NYQ, f * 5.0),
      padEnv(atk * 1.4, dur, rel)), 0, air);
    lowpass(out, Math.min(NYQ, f * rng.uniform(3.0, 9.0)));
    tags = {
      style: 'warm',
      bed: voices > 3 ? 'thick' : 'lean',
      chorus: spread > 18 ? 'wide chorus' : 'close chorus',
      body: sub ? 'octave sub' : 'no sub',
      voices,
      beat_hz: Math.round(f * (Math.pow(2.0, spread / 1200.0) - 1.0) * 100) / 100,
      note: noteName(m),
    };
  } else if (style === 'glass') {
    // Glassy bright: a thin harmonic stack with one partial pushed forward, an
    // octave of shimmer tremoloing above it, and just enough bit crush to make
    // the whole thing ring like something struck rather than blown.
    const m = rng.randint(48, HI_M);
    const f = midi(m);
    const dur = rng.uniform(1.7, 3.2);
    const n = secs(dur);
    const atk = rng.uniform(0.08, 0.5);
    const rel = rng.uniform(0.3, 1.0);
    const tilt = rng.uniform(0.7, 1.8);
    const peakK = rng.choice([2, 3, 4, 6]);
    const rootWave = rng.choice(['tri', 'tri', null]);
    const rootDuty = rng.choice([0.5, 0.25]);
    const parts = [];
    for (const k of [1, 2, 3, 4, 5, 6, 8, 10, 12]) {
      if (f * k > NYQ) break;
      let g = 1.0 / Math.pow(k, tilt);
      if (k === peakK) g *= rng.uniform(1.6, 3.0);
      if (g < 0.04) continue;
      parts.push(k === 1 ? { mult: 1, g, wave: rootWave, duty: rootDuty } : { mult: k, g, wave: 'tri' });
    }
    const vibC = rng.uniform(0.0, 9.0);
    const freqFn = driftFn(f, vibC, rng.uniform(0.3, 1.4), rng.uniform(0, 6.283));
    const env = padEnv(atk, dur, rel, rng.uniform(0.7, 1.0), rng.uniform(1.0, 3.0));
    out = additive(n, freqFn, parts, env);
    const shimHz = rng.uniform(2.0, 7.0);
    const shimD = rng.uniform(0.2, 0.7);
    const shimPh = rng.uniform(0, 6.283);
    const shimEnv = (t) => env(t)
      * (1.0 - shimD + shimD * (0.5 - 0.5 * Math.cos(2.0 * Math.PI * shimHz * t + shimPh)));
    const det = Math.pow(2.0, rng.uniform(-7.0, 7.0) / 1200.0);
    addRank(out, n, (t) => freqFn(t) * det, 2, rng.uniform(0.12, 0.4), shimEnv, 'tri', 0.5, f);
    const bits = rng.choice([0, 0, 5, 7, 10]);
    if (bits) crush(out, bits, rng.randint(1, 3));
    highpass(out, f * rng.uniform(0.5, 1.1));
    lowpass(out, Math.min(NYQ, f * rng.uniform(8.0, 18.0)));
    tags = {
      style: 'glass',
      sparkle: bits ? 'bit-crushed' : 'clean',
      ring: peakK >= 4 ? 'ringing top' : 'bell-like',
      motion: shimD > 0.45 ? 'breathing shimmer' : 'steady shimmer',
      top_hz: Math.round(f * peakK),
      shim_hz: Math.round(shimHz * 10) / 10,
      note: noteName(m),
    };
  } else if (style === 'dark') {
    // Dark ominous: the low register, narrow duties, a sub underneath and a
    // filter clamped down near the fundamental. Slow beating and an even slower
    // lurch keep it from settling into a hum.
    const m = rng.randint(LO_M, 48);
    const f = midi(m);
    const dur = rng.uniform(2.0, 3.4);
    const n = secs(dur);
    const voices = rng.randint(2, 3);
    const spread = rng.uniform(10.0, 45.0);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const atk = rng.uniform(0.3, 1.1);
    const rel = rng.uniform(0.5, 1.3);
    out = [];
    for (let k = 0; k < voices; k++) {
      const cents = spread * (k / Math.max(1, voices - 1) - 0.5);
      const fk = f * Math.pow(2.0, cents / 1200.0);
      const freqFn = driftFn(fk, rng.uniform(2.0, 9.0), rng.uniform(0.05, 0.35), rng.uniform(0, 6.283));
      const env = padEnv(atk * rng.uniform(0.85, 1.25), dur, rel, rng.uniform(0.75, 1.0),
        rng.uniform(1.0, 3.5));
      mixAt(out, renderTone(n, freqFn, duty, env, null), 0, rng.uniform(0.7, 1.0) / voices);
    }
    const subEnv = padEnv(atk * 1.2, dur, rel);
    mixAt(out, renderTone(n, () => f * 0.5, 0.5, subEnv, 'tri'), 0, rng.uniform(0.4, 0.85));
    const rumble = rng.uniform(0.05, 0.22);
    mixAt(out, noiseBed(rng, n, rng.randint(9, 26), 40, Math.min(NYQ, f * 1.6), subEnv), 0, rumble);
    const growl = rng.uniform(0.6, 2.6);
    drive(out, growl);
    const lurchHz = rng.uniform(0.15, 1.2);
    const lurchD = rng.uniform(0.05, 0.45);
    const lurchPh = rng.uniform(0, 6.283);
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      out[i] *= 1.0 - lurchD + lurchD * (0.5 - 0.5 * Math.cos(2.0 * Math.PI * lurchHz * t + lurchPh));
    }
    lowpass2(out, Math.min(NYQ, f * rng.uniform(1.6, 3.6)), rng.uniform(0.0, 0.6));
    tags = {
      style: 'dark',
      weight: duty <= 0.125 ? 'hollow' : 'heavy',
      motion: lurchD > 0.25 ? 'lurching' : 'still',
      grain: growl > 1.6 ? 'growling' : 'smooth',
      beat_hz: Math.round(f * (Math.pow(2.0, spread / 1200.0) - 1.0) * 100) / 100,
      lurch_hz: Math.round(lurchHz * 100) / 100,
      note: noteName(m),
    };
  } else if (style === 'sweep') {
    // Slowly evolving filter: two or three detuned saws and a resonant one-pole
    // pair crawling across them. Nothing about the note changes — only what you
    // are allowed to hear of it.
    const m = rng.randint(LO_M, 55);
    const f = midi(m);
    const dur = rng.uniform(2.0, 3.4);
    const n = secs(dur);
    const voices = rng.randint(2, 3);
    const spread = rng.uniform(4.0, 22.0);
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    const atk = rng.uniform(0.05, 0.45);
    const rel = rng.uniform(0.3, 0.9);
    out = [];
    for (let k = 0; k < voices; k++) {
      const cents = spread * (k / Math.max(1, voices - 1) - 0.5);
      const fk = f * Math.pow(2.0, cents / 1200.0);
      const freqFn = driftFn(fk, rng.uniform(1.0, 5.0), rng.uniform(0.1, 0.6), rng.uniform(0, 6.283));
      const env = padEnv(atk, dur, rel, rng.uniform(0.8, 1.0), rng.uniform(1.2, 3.0));
      mixAt(out, renderTone(n, freqFn, duty, env, wave), 0, rng.uniform(0.75, 1.0) / voices);
    }
    const subG = rng.uniform(0.0, 0.4);
    if (subG > 0.12) {
      mixAt(out, renderTone(n, () => f * 0.5, 0.5, padEnv(atk * 1.3, dur, rel), 'tri'), 0, subG);
    }
    const motion = rng.choice(['opening', 'opening', 'closing', 'wah', 'arch', 'two-stage']);
    const lo = Math.min(NYQ, f * rng.uniform(1.1, 2.2));
    const hi = Math.min(NYQ, f * rng.uniform(6.0, 18.0));
    const curve = rng.uniform(0.7, 2.4);
    const lfoHz = rng.uniform(0.35, 2.2);
    const lfoPh = rng.uniform(0, 6.283);
    const res = rng.uniform(0.1, 2.2);
    const cutFn = (t) => {
      const x = Math.min(1.0, Math.max(0.0, t / dur));
      let u;
      if (motion === 'opening') u = Math.pow(x, curve);
      else if (motion === 'closing') u = Math.pow(1.0 - x, curve);
      else if (motion === 'wah') u = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * lfoHz * t + lfoPh);
      else if (motion === 'arch') u = Math.pow(Math.sin(Math.PI * x), curve);
      else u = x < 0.5 ? Math.pow(x * 2.0, curve) : 1.0 - 0.55 * Math.pow((x - 0.5) * 2.0, curve);
      return lo + (hi - lo) * Math.max(0.0, Math.min(1.0, u));
    };
    lowpass2(out, cutFn, res);
    tags = {
      style: 'sweep',
      motion,
      resonance: res > 1.2 ? 'resonant' : 'gentle',
      tone: toneLabel(wave, duty),
      peak_hz: Math.round(hi),
      note: noteName(m),
    };
  } else if (style === 'choir') {
    // Choir caricature: two or three singers, each a harmonic series with two
    // formant bumps painted on it and a vibrato that only arrives once the
    // voice has spoken. No samples, no words — just the vowel's shape.
    const m = rng.randint(43, HI_M);
    const f = midi(m);
    const dur = rng.uniform(1.8, 3.4);
    const n = secs(dur);
    const vowel = rng.choice(['ah', 'oo', 'ee', 'oh', 'eh']);
    const fm = VOWELS[vowel];
    const singers = rng.randint(2, 3);
    const spread = rng.uniform(4.0, 20.0);
    const atk = rng.uniform(0.18, 0.7);
    const rel = rng.uniform(0.35, 1.1);
    // Vibrato is measured in cents, but a fixed cent width is far more swing at
    // the bottom of the range than the top — a bass singer wobbling a third of
    // a semitone sounds seasick. Taper the width with the register.
    const vibC = rng.uniform(6.0, 32.0) * (0.5 + 0.5 * ((m - 43) / (HI_M - 43)));
    const vibHz = rng.uniform(4.2, 6.8);
    const parts = [];
    let sum = 0.0;
    for (let k = 1; k <= 16; k++) {
      const fk = f * k;
      if (fk > NYQ) break;
      const b1 = Math.exp(-Math.pow((fk - fm.f1) / (0.55 * fm.f1), 2.0));
      const b2 = 0.55 * Math.exp(-Math.pow((fk - fm.f2) / (0.5 * fm.f2), 2.0));
      const g = 0.3 / k + 0.9 * b1 + b2;
      if (g < 0.07) continue;
      parts.push({ mult: k, g, wave: 'tri' });
      sum += g;
    }
    if (!parts.length) parts.push({ mult: 1, g: 1.0, wave: 'tri' });
    for (const p of parts) p.g /= Math.max(0.2, sum);
    out = [];
    for (let s = 0; s < singers; s++) {
      const cents = spread * (s / Math.max(1, singers - 1) - 0.5);
      const fs = f * Math.pow(2.0, cents / 1200.0);
      const freqFn = driftFn(fs, vibC * rng.uniform(0.8, 1.2), vibHz * rng.uniform(0.9, 1.1),
        rng.uniform(0, 6.283), rng.uniform(0.25, 0.9));
      const env = padEnv(atk * rng.uniform(0.85, 1.25), dur, rel, rng.uniform(0.8, 1.0),
        rng.uniform(1.0, 3.0));
      mixAt(out, additive(n, freqFn, parts, env), 0, rng.uniform(0.75, 1.0) / singers);
    }
    const breath = rng.uniform(0.02, 0.12);
    mixAt(out, noiseBed(rng, n, rng.randint(1, 4), fm.f1 * 0.8, Math.min(NYQ, fm.f2 * 1.6),
      padEnv(atk * 1.3, dur, rel)), 0, breath);
    lowpass(out, Math.min(NYQ, Math.max(fm.f2 * 1.8, f * 5.0)));
    tags = {
      style: 'choir',
      vowel,
      section: singers > 2 ? 'full section' : 'duet',
      breath: breath > 0.07 ? 'breathy' : 'pure',
      singers,
      vib_hz: Math.round(vibHz * 10) / 10,
      note: noteName(m),
    };
  } else if (style === 'shimmer') {
    // Shimmering tremolo: two voices an interval apart, their tremolos in
    // antiphase, so the level barely moves while the colour swings back and
    // forth between them. The oldest trick in chip music, and still the best.
    const m = rng.randint(41, HI_M);
    const f = midi(m);
    const dur = rng.uniform(1.7, 3.3);
    const n = secs(dur);
    const tremHz = rng.uniform(2.5, 9.0);
    const depth = rng.uniform(0.35, 0.95);
    const shape = rng.choice(['sine', 'sine', 'stepped', 'falling']);
    const pair = rng.choice([
      { name: 'octave', semi: 12 }, { name: 'fifth', semi: 7 },
      { name: 'unison', semi: 0 }, { name: 'double octave', semi: 24 },
      { name: 'twelfth', semi: 19 },
    ]);
    const atk = rng.uniform(0.08, 0.5);
    const rel = rng.uniform(0.3, 0.9);
    const base = padEnv(atk, dur, rel, rng.uniform(0.8, 1.0), rng.uniform(1.0, 3.0));
    const wave = rng.choice(['tri', 'tri', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    const sharp = rng.uniform(2.5, 7.0);
    const tremAmp = (phase) => (t) => {
      const p = (((t * tremHz + phase) % 1.0) + 1.0) % 1.0;
      let a;
      if (shape === 'stepped') a = Math.floor(p * 4.0) / 3.0;
      else if (shape === 'falling') a = p < 0.08 ? p / 0.08 : Math.exp(-sharp * (p - 0.08));
      else a = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * p);
      return 1.0 - depth + depth * a;
    };
    const envA = (t) => base(t) * tremAmp(0.0)(t);
    const envB = (t) => base(t) * tremAmp(0.5)(t);
    const detA = Math.pow(2.0, rng.uniform(-8.0, 8.0) / 1200.0);
    const detB = Math.pow(2.0, rng.uniform(-8.0, 8.0) / 1200.0);
    const fB = f * Math.pow(2.0, pair.semi / 12.0);
    out = renderTone(n, () => f * detA, duty, envA, wave);
    if (fB * 1.0 < NYQ) {
      mixAt(out, renderTone(n, () => fB * detB, duty, envB, wave), 0, rng.uniform(0.55, 0.95));
    }
    const bedG = rng.uniform(0.2, 0.55);
    mixAt(out, renderTone(n, () => f * 0.5, 0.5, base, 'tri'), 0, bedG);
    lowpass(out, Math.min(NYQ, f * rng.uniform(4.0, 12.0)));
    tags = {
      style: 'shimmer',
      shape,
      pairing: pair.name,
      depth: depth > 0.7 ? 'deep' : 'gentle',
      trem_hz: Math.round(tremHz * 10) / 10,
      note: noteName(m),
    };
  } else if (style === 'octave') {
    // Octave-stacked: a registration rather than a timbre. Each rank is its own
    // slightly-out-of-tune oscillator, so the stack breathes instead of
    // locking into one rigid comb.
    const m = rng.randint(LO_M, 52);
    const f = midi(m);
    const dur = rng.uniform(1.8, 3.3);
    const n = secs(dur);
    const reg = rng.choice(REGISTRATIONS);
    const detune = rng.uniform(1.0, 14.0);
    const atk = rng.uniform(0.1, 0.6);
    const rel = rng.uniform(0.3, 1.0);
    const wave = rng.choice(['tri', 'tri', null, 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    out = [];
    let layers = 0;
    for (let k = 0; k < reg.semis.length; k++) {
      const fk = midi(m + reg.semis[k]) * Math.pow(2.0, rng.uniform(-detune, detune) / 1200.0);
      if (fk > NYQ) continue;
      const w = reg.semis[k] >= 19 ? 'tri' : wave;
      const freqFn = driftFn(fk, rng.uniform(0.5, 4.0), rng.uniform(0.08, 0.6), rng.uniform(0, 6.283));
      const env = padEnv(atk * rng.uniform(0.8, 1.4), dur, rel, rng.uniform(0.78, 1.0),
        rng.uniform(1.0, 3.0));
      const g = reg.semis[k] < 0 ? rng.uniform(0.7, 1.0)
        : reg.semis[k] === 0 ? rng.uniform(0.8, 1.0)
          : rng.uniform(0.3, 0.75) / Math.pow(2.0, reg.semis[k] / 24.0);
      mixAt(out, renderTone(n, freqFn, duty, env, w), 0, g);
      layers++;
    }
    const air = rng.uniform(0.01, 0.05);
    mixAt(out, noiseBed(rng, n, rng.randint(2, 7), f * 2.0, Math.min(NYQ, f * 9.0),
      padEnv(atk * 1.5, dur, rel)), 0, air);
    const topHz = Math.round(midi(m + reg.semis[reg.semis.length - 1]));
    lowpass(out, Math.min(NYQ, f * rng.uniform(4.0, 13.0)));
    tags = {
      style: 'octave',
      registration: reg.name,
      blend: detune > 6 ? 'beating' : 'locked',
      touch: atk > 0.35 ? 'slow bloom' : 'quick bloom',
      layers,
      top_hz: topHz,
      detune_cents: Math.round(detune * 10) / 10,
      note: noteName(m),
    };
  } else if (style === 'gate') {
    // Pulsing gate: a held chord chopped on the grid. The tempo is real — the
    // gate period is a division of a BPM and the pad lasts a whole number of
    // steps, so it loops against a drum part without drifting.
    const m = rng.randint(LO_M, 55);
    const f = midi(m);
    const bpm = rng.randint(84, 168);
    const div = rng.choice(DIVISIONS);
    const period = (60.0 / bpm) * div.beats;
    const target = rng.uniform(1.9, 3.2);
    let steps = Math.max(2, Math.round(target / period));
    while (steps > 2 && steps * period > 3.35) steps--;
    while (steps * period < 1.65) steps++;
    const dur = steps * period;
    const n = secs(dur);
    const gDuty = rng.uniform(0.3, 0.85);
    const edge = rng.uniform(0.004, 0.03);
    const floorV = rng.choice([0.0, 0.0, 0.08, 0.2]);
    const acc = rng.choice(ACCENTS);
    const swing = rng.choice([0.0, 0.0, 0.0, rng.uniform(0.05, 0.18)]);
    const voices = rng.randint(2, 3);
    const spread = rng.uniform(4.0, 20.0);
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    const base = padEnv(rng.uniform(0.02, 0.2), dur, rng.uniform(0.15, 0.45));
    const on = gDuty * period;
    const e = Math.min(edge, on * 0.49);
    const gateFn = (t) => {
      const idx = Math.floor(t / period);
      let ph = t - idx * period;
      if (swing > 0 && idx % 2 === 1) ph -= swing * period;
      let v;
      if (ph < 0 || ph >= on) v = 0.0;
      else if (ph < e) v = ph / e;
      else if (ph > on - e) v = (on - ph) / e;
      else v = 1.0;
      v = v * v * (3.0 - 2.0 * v);
      return (floorV + (1.0 - floorV) * v) * acc.amp[idx % acc.amp.length];
    };
    const env = (t) => base(t) * gateFn(t);
    out = [];
    for (let k = 0; k < voices; k++) {
      const cents = spread * (k / Math.max(1, voices - 1) - 0.5);
      const fk = f * Math.pow(2.0, cents / 1200.0);
      mixAt(out, renderTone(n, () => fk, duty, env, wave), 0, rng.uniform(0.75, 1.0) / voices);
    }
    const subG = rng.uniform(0.15, 0.5);
    mixAt(out, renderTone(n, () => f * 0.5, 0.5, env, 'tri'), 0, subG);
    lowpass(out, Math.min(NYQ, f * rng.uniform(4.0, 12.0)));
    tags = {
      style: 'gate',
      division: div.name,
      accent: acc.name,
      feel: swing > 0 ? 'swung' : floorV > 0 ? 'ducked' : 'chopped',
      bpm,
      gate_pct: Math.round(gDuty * 100),
      note: noteName(m),
    };
  } else if (style === 'sandh') {
    // Sample-and-hold: the held note never moves, but the LFSR re-rolls the
    // filter (and a quiet scale-locked bubble above it) several times a second.
    // Motion without melody — the pad that fills a menu screen.
    const m = rng.randint(LO_M, 55);
    const f = midi(m);
    const dur = rng.uniform(1.8, 3.4);
    const n = secs(dur);
    const rateHz = rng.uniform(4.0, 26.0);
    const period = Math.max(1, Math.round(SR / rateHz));
    const voices = rng.randint(2, 3);
    const spread = rng.uniform(5.0, 24.0);
    const wave = rng.choice(['saw', null, null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const atk = rng.uniform(0.06, 0.5);
    const rel = rng.uniform(0.3, 0.9);
    const base = padEnv(atk, dur, rel, rng.uniform(0.8, 1.0), rng.uniform(1.0, 3.0));
    out = [];
    for (let k = 0; k < voices; k++) {
      const cents = spread * (k / Math.max(1, voices - 1) - 0.5);
      const fk = f * Math.pow(2.0, cents / 1200.0);
      mixAt(out, renderTone(n, () => fk, duty, base, wave), 0, rng.uniform(0.75, 1.0) / voices);
    }
    const scale = rng.choice(SCALES);
    const bubbleG = rng.uniform(0.08, 0.32);
    const sh = shSequence(rng, n, period);
    const octave = rng.choice([1, 2, 2, 4]);
    const bubbleFreq = (t) => {
      const i = Math.min(n - 1, Math.max(0, Math.round(t * SR)));
      const deg = scale.degrees[Math.min(scale.degrees.length - 1,
        Math.floor(sh[i] * scale.degrees.length))];
      return Math.min(NYQ, f * octave * Math.pow(2.0, deg / 12.0));
    };
    const bubbleEnv = (t) => {
      const i = Math.min(n - 1, Math.max(0, Math.round(t * SR)));
      const ph = (i % period) / period;
      const shapeV = ph < 0.06 ? ph / 0.06 : Math.exp(-2.2 * (ph - 0.06));
      return base(t) * shapeV * (0.5 + 0.5 * sh[i]);
    };
    mixAt(out, renderTone(n, bubbleFreq, 0.5, bubbleEnv, 'tri'), 0, bubbleG);
    const lo = Math.min(NYQ, f * rng.uniform(1.4, 3.0));
    const hi = Math.min(NYQ, f * rng.uniform(5.0, 14.0));
    const res = rng.uniform(0.2, 1.8);
    lowpass2(out, (t) => {
      const i = Math.min(n - 1, Math.max(0, Math.round(t * SR)));
      return lo + (hi - lo) * sh[i];
    }, res);
    tags = {
      style: 'sandh',
      scale: scale.name,
      texture: res > 1.0 ? 'squelchy' : 'soft',
      bubbles: bubbleG > 0.2 ? 'chattering' : 'sparse',
      rate_hz: Math.round(rateHz * 10) / 10,
      note: noteName(m),
    };
  } else {
    // Slow swell: in from nothing, out to nothing, and a different instrument
    // at the crest than the one that started. The morph is two complementary
    // envelopes on two timbres plus a filter that opens with them.
    const m = rng.randint(LO_M, 57);
    const f = midi(m);
    const dur = rng.uniform(2.0, 3.4);
    const n = secs(dur);
    const morph = rng.choice(MORPHS);
    const crest = rng.uniform(0.4, 0.78);
    const peakT = dur * crest;
    const riseC = rng.uniform(0.8, 2.2);
    const fallC = rng.uniform(0.8, 2.0);
    const hump = (t) => {
      if (t <= 0) return 0.0;
      if (t < peakT) return Math.pow(0.5 - 0.5 * Math.cos(Math.PI * (t / peakT)), riseC);
      const x = Math.max(0.0, (dur - t) / Math.max(1e-3, dur - peakT));
      return Math.pow(0.5 - 0.5 * Math.cos(Math.PI * x), fallC);
    };
    const xfade = rng.uniform(0.6, 1.6);
    const mixFn = (t) => {
      const x = Math.min(1.0, Math.max(0.0, (t / dur) * xfade));
      return x * x * (3.0 - 2.0 * x);
    };
    const envA = (t) => hump(t) * (1.0 - mixFn(t));
    const envB = (t) => hump(t) * mixFn(t);
    const detA = Math.pow(2.0, rng.uniform(-9.0, 9.0) / 1200.0);
    const detB = Math.pow(2.0, rng.uniform(-9.0, 9.0) / 1200.0);
    out = renderTone(n, () => f * detA, morph.a.duty, envA, morph.a.wave);
    mixAt(out, renderTone(n, () => f * detB, morph.b.duty, envB, morph.b.wave), 0,
      rng.uniform(0.7, 1.0));
    const octG = rng.uniform(0.0, 0.45);
    if (octG > 0.12 && f * 2.0 < NYQ) {
      mixAt(out, renderTone(n, () => f * 2.0 * detB, 0.5, envB, 'tri'), 0, octG);
    }
    const subG = rng.uniform(0.0, 0.5);
    if (subG > 0.15) {
      mixAt(out, renderTone(n, () => f * 0.5, 0.5, hump, 'tri'), 0, subG);
    }
    mixAt(out, noiseBed(rng, n, rng.randint(2, 8), f * 0.9, Math.min(NYQ, f * 6.0), hump),
      0, rng.uniform(0.01, 0.06));
    const lo = Math.min(NYQ, f * rng.uniform(1.3, 2.6));
    const hi = Math.min(NYQ, f * rng.uniform(5.0, 15.0));
    const openC = rng.uniform(0.6, 1.7);
    lowpass2(out, (t) => lo + (hi - lo) * Math.min(1.0, Math.pow(hump(t), openC)),
      rng.uniform(0.1, 1.4));
    tags = {
      style: 'swell',
      from: morph.from,
      to: morph.to,
      crest: crest > 0.6 ? 'late crest' : 'early crest',
      crest_pct: Math.round(crest * 100),
      open_hz: Math.round(hi),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every pad inside 1.55 - 3.45 s, block the duty-cycle DC bias, then
  // de-click both edges before normalizing so the peak is exact even when the
  // loudest sample sits at the crest of a swell.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  while (out.length < MIN_N) out.push(0.0);
  dcBlock(out, 0.997);
  const fi = Math.min(out.length >> 2, Math.round(0.006 * SR));
  const fo = Math.min(out.length >> 1, Math.round(0.02 * SR));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C3';
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  const dec = (v, d, p = 1) => (Number.isFinite(Number(v)) ? Number(v).toFixed(p) : d.toFixed(p));
  switch (t.style) {
    case 'glass':
      return `glassy pad — ${t.sparkle || 'clean'} ${t.ring || 'bell-like'}, ${t.motion || 'steady shimmer'} ${dec(t.shim_hz, 4)} Hz, ${note}`;
    case 'dark':
      return `dark ominous pad — ${t.weight || 'heavy'}, ${t.motion || 'still'}, ${t.grain || 'smooth'}, ${dec(t.beat_hz, 1, 2)} Hz beat, ${note}`;
    case 'sweep':
      return `evolving filter pad — ${t.motion || 'opening'} ${t.resonance || 'gentle'} ${t.tone || 'sawtooth'}, ${num(t.peak_hz)} Hz peak, ${note}`;
    case 'choir':
      return `chip choir pad — "${t.vowel || 'ah'}" vowel ${t.section || 'duet'}, ${t.breath || 'pure'}, ${dec(t.vib_hz, 5)} Hz vibrato, ${note}`;
    case 'shimmer':
      return `shimmering tremolo pad — ${t.depth || 'gentle'} ${t.shape || 'sine'} ${t.pairing || 'octave'}, ${dec(t.trem_hz, 5)} Hz, ${note}`;
    case 'octave':
      return `octave-stacked pad — ${t.registration || 'octaves'}, ${t.blend || 'locked'} ${t.touch || 'slow bloom'}, ${num(t.layers)} ranks ${dec(t.detune_cents, 6)} cents, ${note}`;
    case 'gate':
      return `pulsing gated pad — ${t.division || 'eighths'} ${t.accent || 'steady'}, ${t.feel || 'chopped'} ${num(t.gate_pct)}%, ${num(t.bpm)} BPM, ${note}`;
    case 'sandh':
      return `sample-and-hold pad — ${t.scale || 'whole tone'} ${t.bubbles || 'sparse'}, ${t.texture || 'soft'}, ${dec(t.rate_hz, 9)} Hz, ${note}`;
    case 'swell':
      return `swelling morph pad — ${t.from || 'dark square'} into ${t.to || 'bright saw'}, ${t.crest || 'late crest'} ${num(t.crest_pct)}%, ${note}`;
    default:
      return `warm detuned pad — ${t.bed || 'lean'} ${t.chorus || 'close chorus'}, ${t.body || 'no sub'}, ${num(t.voices)} desks beating ${dec(t.beat_hz, 1, 2)} Hz, ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'warm detuned beds, glassy stacks, dark slabs, filter sweeps, gated pulses';
