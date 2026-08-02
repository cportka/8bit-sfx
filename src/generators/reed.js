// reed — pitched chip-caricature winds. A wind instrument is mostly two things
// a chip can actually do: a very small harmonic recipe (the clarinet's odd-only
// hollow, the oboe's narrow-duty nasal pinch, the flute's near-triangle purity)
// and *breath* — LFSR noise band-limited around the note and pushed hardest at
// the moment the air arrives. Neither is a sample. Every voice here is a naive
// square/triangle/saw stack plus a hand-rolled one-pole air band, and the thing
// that sells it as a player rather than an oscillator is the onset: a soft
// smoothstep attack, a chiff of breath in the first few milliseconds, and
// vibrato that shows up *late*, the way a real held note does.
//
// Every note lands on an exact MIDI pitch between C3 and C6 and records that
// pitch, so a flute line sits in tune over the bass and a clarinet answers the
// lead. Nine caricatured winds (flute, clarinet, oboe, ocarina, panflute,
// whistle, recorder, bassoon, shakuhachi) each carry their own partial recipe,
// their own brightness ceiling, their own breath level and the slice of C3-C6 a
// player of that pipe actually lives in — so the pitch you get is playable.
//
// Eleven sub-styles cover the wind vocabulary a track needs: the held breathy
// sustain, the hollow chalumeau tone, the nasal double reed, the round ocarina
// vessel, the breath-forward pan pipe, the soft high whistle, the trill, a
// short melodic phrase, tongued staccato notes, an expressive bend/overblow,
// and a detuned wind choir.
//
// All chip primitives: naive squares/triangles/saws at harmonic ratios, LFSR
// noise for air and chiff, sample-and-hold pitch-stepping for chiptune vibrato,
// coarse bit crush for grit, tanh drive for the overblown edge. Post chain is
// uniform — DC block (narrow-duty square stacks carry a real bias), de-click
// both edges, normalize LAST so the peak is exact even when the loudest sample
// sits inside the first millisecond.

import {
  SR, Lfsr, square, triangle, sawtooth, midi, noteName, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.22 * SR);
const MAX_N = Math.round(1.46 * SR);

const LO_M = 48; // C3 — the bassoon floor
const HI_M = 84; // C6 — the whistle ceiling

const NYQ = SR * 0.45; // partials above this are dropped rather than aliased

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

/** Semitones to a frequency multiplier. */
function semis(s) {
  return Math.pow(2.0, s / 12.0);
}

/** One decimal, for tags that read better as 5.4 than 5.37. */
function r1(x) {
  return Math.round(x * 10) / 10;
}

/** One-pole coefficient for a cutoff in Hz. */
function alphaOf(cut) {
  return 1.0 - Math.exp((-2.0 * Math.PI * Math.max(20, Math.min(SR * 0.45, cut))) / SR);
}

/** One-pole lowpass in place; cutoff is Hz, constant or a function of t. */
function lowpass(buf, cutoff) {
  const fc = typeof cutoff === 'function' ? (i) => cutoff(i / SR) : () => cutoff;
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += alphaOf(fc(i)) * (buf[i] - p);
    buf[i] = p;
  }
  return buf;
}

/** One-pole highpass in place — thins a reed without touching the pitch. */
function highpass(buf, cut) {
  const a = alphaOf(cut);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += a * (buf[i] - p);
    buf[i] -= p;
  }
  return buf;
}

/** Symmetric tanh drive — the overblown pipe. */
function drive(buf, amount) {
  const k = Math.max(1.0, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(k * buf[i]) / norm;
  return buf;
}

/** Sample-and-hold rate reduction plus a coarse level crush, blended in place. */
function crush(buf, steps, hold, mix = 1.0) {
  const h = Math.max(1, Math.round(hold));
  let held = 0.0;
  for (let i = 0; i < buf.length; i++) {
    if (i % h === 0) held = buf[i];
    const q = Math.round(held * steps) / steps;
    buf[i] += (q - buf[i]) * mix;
  }
  return buf;
}

/** Amplitude modulation in place — trill re-articulation, choir tremolo. */
function amMod(buf, hz, depth, phase0 = 0.0) {
  for (let i = 0; i < buf.length; i++) {
    const ph = hz * (i / SR) + phase0;
    buf[i] *= 1.0 - depth * 0.5 * (1.0 - Math.cos(2 * Math.PI * ph));
  }
  return buf;
}

/**
 * Wind envelope: a smoothstep attack (no chip click, no brass-style snap), a
 * fall to a sustain plateau, then a linear release into the note's end.
 */
function windEnv(dur, atk, dec, sus, rel) {
  const a0 = Math.max(1e-4, atk);
  const d0 = Math.max(1e-4, dec);
  const r0 = Math.max(1e-4, rel);
  return (t) => {
    let v;
    if (t < a0) {
      const x = t / a0;
      v = x * x * (3.0 - 2.0 * x);
    } else if (t < a0 + d0) {
      v = 1.0 + (sus - 1.0) * ((t - a0) / d0);
    } else {
      v = sus;
    }
    const left = dur - t;
    if (left < r0) v *= Math.max(0.0, left / r0);
    return v;
  };
}

/** Percussive envelope for a breath chiff: near-instant attack, exponential fall. */
function burstEnv(atk, rate) {
  const a = Math.max(1e-5, atk);
  return (t) => Math.min(1.0, t / a) * Math.exp(-rate * t);
}

/** Cutoff ramps open across the attack as the air arrives, then settles back. */
function sweepCut(loHz, hiHz, atk, fall, sus) {
  const a = Math.max(1e-4, atk);
  const fl = Math.max(1e-4, fall);
  return (t) => {
    const s = t < a ? t / a : sus + (1.0 - sus) * Math.exp(-(t - a) / fl);
    return loHz + (hiHz - loHz) * s;
  };
}

/**
 * Vibrato as cents of pitch offset, arriving late (players lean into it) and
 * optionally sample-and-held into steps — the chiptune version of a vibrato.
 */
function vibratoFn(rateHz, depthCents, onset, steps) {
  const on = Math.max(1e-4, onset);
  return (t) => {
    const g = Math.min(1.0, t / on);
    let s = Math.sin(2 * Math.PI * rateHz * t);
    if (steps > 0) s = Math.round(s * steps) / steps;
    return depthCents * g * g * s;
  };
}

/** Band-limited LFSR air: sample-and-hold noise, lowpassed then highpassed. */
function airLayer(rng, n, period, loCut, hiCut, envFn) {
  const lf = new Lfsr(rng, Math.max(1, period));
  const a = alphaOf(hiCut);
  const b = alphaOf(Math.min(loCut, hiCut * 0.7));
  const out = new Array(Math.max(1, n));
  let p = 0.0;
  let q = 0.0;
  for (let i = 0; i < out.length; i++) {
    p += a * (lf.next() - p);
    q += b * (p - q);
    out[i] = (p - q) * envFn(i / SR);
  }
  return out;
}

/**
 * Render a partial stack additively: one phase accumulator per partial, all
 * summed against a shared per-sample frequency (so scoops, bends and trills
 * move the whole pipe in tune) and a shared amplitude envelope.
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
      s += p.g * w;
    }
    out[i] = s * norm * envFn(t);
  }
  return out;
}

// --- the pipes -------------------------------------------------------------

// Each caricature is a partial recipe ([ratio, gain, wave, duty]), a brightness
// ceiling as a multiple of the fundamental, a resting breath level, and the
// slice of C3-C6 a player of that pipe actually lives in.
const TIMBRES = [
  { name: 'flute', lo: 60, hi: 84, bright: 6, air: 0.34, ranks: [[1, 1.0, 'tri', 0.5], [2, 0.16, 'tri', 0.5], [3, 0.05, null, 0.5]] },
  { name: 'clarinet', lo: 50, hi: 74, bright: 9, air: 0.12, ranks: [[1, 1.0, null, 0.5], [3, 0.3, 'tri', 0.5], [5, 0.1, 'tri', 0.5]] },
  { name: 'oboe', lo: 58, hi: 80, bright: 12, air: 0.1, ranks: [[1, 1.0, null, 0.22], [2, 0.3, 'saw', 0.5], [3, 0.14, null, 0.3]] },
  { name: 'ocarina', lo: 60, hi: 82, bright: 4, air: 0.18, ranks: [[1, 1.0, 'tri', 0.5], [2, 0.1, 'tri', 0.5]] },
  { name: 'panflute', lo: 55, hi: 79, bright: 5, air: 0.5, ranks: [[1, 1.0, 'tri', 0.5], [3, 0.13, 'tri', 0.5], [2, 0.06, null, 0.5]] },
  { name: 'whistle', lo: 70, hi: 84, bright: 3, air: 0.24, ranks: [[1, 1.0, 'tri', 0.5], [2, 0.07, 'tri', 0.5]] },
  { name: 'recorder', lo: 62, hi: 84, bright: 7, air: 0.28, ranks: [[1, 1.0, null, 0.5], [2, 0.18, 'tri', 0.5], [3, 0.07, 'tri', 0.5]] },
  { name: 'bassoon', lo: 48, hi: 64, bright: 10, air: 0.14, ranks: [[1, 1.0, 'saw', 0.5], [2, 0.26, null, 0.33], [3, 0.1, 'tri', 0.5]] },
  { name: 'shakuhachi', lo: 53, hi: 76, bright: 6, air: 0.55, ranks: [[1, 1.0, 'tri', 0.5], [2, 0.12, null, 0.25], [3, 0.07, 'tri', 0.5]] },
];

const HOLLOW_VOICES = ['clarinet', 'bassoon', 'recorder', 'panflute'];
const NASAL_VOICES = ['oboe', 'bassoon', 'clarinet'];
const PURE_VOICES = ['ocarina', 'whistle', 'flute'];
const BREATH_VOICES = ['panflute', 'shakuhachi', 'flute', 'ocarina'];
const HIGH_VOICES = ['whistle', 'ocarina', 'flute', 'recorder'];

/** The odd-harmonic-only recipe — a stopped pipe, the clarinet's hollow. */
const ODD_RANKS = [[1, 1.0, null, 0.5], [3, 0.34, null, 0.5], [5, 0.14, 'tri', 0.5], [7, 0.06, 'tri', 0.5]];

/** Pick a named caricature. */
function voiceOf(rng, names) {
  const nm = rng.choice(names);
  for (const tb of TIMBRES) if (tb.name === nm) return tb;
  return TIMBRES[0];
}

/** A pitch inside both the pipe's range and the category's, given a figure's span. */
function pickBase(rng, tb, loOff, hiOff) {
  const a = Math.max(tb.lo, LO_M - Math.min(0, loOff));
  const b = Math.min(tb.hi, HI_M - Math.max(0, hiOff));
  return b >= a ? rng.randint(a, b) : clampM(Math.round((a + b) / 2));
}

/**
 * A pipe's partial stack, optionally re-voiced and detuned. The fundamental is
 * never detuned — only the partials above it drift, which beats and thickens
 * the tone without pulling the note out of tune. A whole voice is moved by
 * `opts.detune` instead (that is what a choir wants).
 */
function partsFor(rng, tb, opts = {}) {
  const ranks = opts.ranks || tb.ranks;
  const spread = opts.spread || 0;
  const parts = [];
  for (let k = 0; k < ranks.length; k++) {
    const r = ranks[k];
    parts.push({
      ratio: spread && k > 0 ? r[0] * cents(rng.uniform(-spread, spread)) : r[0],
      g: r[1] * (opts.tilt === undefined ? 1.0 : Math.pow(opts.tilt, k)),
      wave: opts.wave === undefined ? r[2] : opts.wave,
      duty: opts.duty === undefined ? r[3] : opts.duty,
      ph: rng.random(), // partials start decorrelated, so the onset isn't one spike
    });
  }
  return parts;
}

/**
 * One wind note, whole: stacked partials, late vibrato, an optional bend, the
 * filter opening as the air arrives, then breath under it and a chiff on top.
 * Every multi-note style (phrase, staccato, choir) is built out of these.
 */
function reedNote(rng, tb, m, dur, opts = {}) {
  const f = midi(m) * (opts.detune ? cents(opts.detune) : 1.0);
  const n = secs(dur);
  const parts = partsFor(rng, tb, opts);
  const atk = opts.atk === undefined ? 0.03 : opts.atk;
  const env = windEnv(
    dur,
    atk,
    opts.dec === undefined ? 0.08 : opts.dec,
    opts.sus === undefined ? 0.82 : opts.sus,
    Math.min(dur * 0.6, opts.rel === undefined ? 0.09 : opts.rel)
  );
  const vib = opts.vib || null;
  const bend = opts.bend || null;
  const buf = stackTone(n, (t) => {
    let ff = f;
    if (vib) ff *= cents(vib(t));
    if (bend) ff *= semis(bend(t));
    return ff;
  }, parts, env);

  const loHz = Math.max(160, f * (opts.lo === undefined ? 1.4 : opts.lo));
  const hiHz = Math.max(loHz * 1.3, Math.min(NYQ, f * (opts.hi === undefined ? tb.bright : opts.hi)));
  lowpass(buf, sweepCut(
    loHz, hiHz,
    opts.catk === undefined ? Math.max(0.006, atk * 0.8) : opts.catk,
    opts.cfall === undefined ? 0.14 : opts.cfall,
    opts.csus === undefined ? 0.7 : opts.csus
  ));
  if (opts.hp) highpass(buf, Math.max(60, f * opts.hp));
  if (opts.drive && opts.drive > 1.05) drive(buf, opts.drive);

  const air = opts.air === undefined ? tb.air : opts.air;
  if (air > 0.02) {
    const punch = opts.airPunch === undefined ? 0.6 : opts.airPunch;
    mixAt(buf, airLayer(
      rng, n,
      opts.grain === undefined ? 1 : opts.grain,
      Math.max(120, f * (opts.airLo === undefined ? 1.2 : opts.airLo)),
      Math.min(NYQ, f * (opts.airHi === undefined ? 6.0 : opts.airHi)),
      (t) => env(t) * (1.0 + punch * Math.exp(-t / 0.05))
    ), 0, air);
  }

  const chiff = opts.chiff || 0;
  if (chiff > 0.02) {
    const cn = Math.min(n, secs(opts.chiffLen === undefined ? 0.06 : opts.chiffLen));
    mixAt(buf, airLayer(
      rng, cn,
      opts.chiffGrain === undefined ? 1 : opts.chiffGrain,
      Math.max(200, f * 1.6), Math.min(NYQ, f * 9.0),
      burstEnv(opts.chiffAtk === undefined ? 0.004 : opts.chiffAtk,
        opts.chiffRate === undefined ? 60 : opts.chiffRate)
    ), 0, chiff);
  }

  return { buf, hiHz, f, n };
}

// --- figures ---------------------------------------------------------------

/** Melodic phrases, as semitone steps over the root with relative note lengths. */
const FIGURES = [
  { name: 'rising third', steps: [0, 2, 4], holds: [1, 1, 2] },
  { name: 'grace turn', steps: [2, 0], holds: [0.5, 3] },
  { name: 'fifth pickup', steps: [7, 12], holds: [1, 3] },
  { name: 'stepwise climb', steps: [0, 2, 4, 5], holds: [1, 1, 1, 2] },
  { name: 'falling line', steps: [12, 10, 7], holds: [1, 1, 2] },
  { name: 'neighbour turn', steps: [0, 2, 0, -1], holds: [1, 1, 1, 2] },
  { name: 'octave call', steps: [0, 12], holds: [1, 2] },
  { name: 'pentatonic run', steps: [0, 2, 4, 7], holds: [1, 1, 1, 2] },
  { name: 'sighing fall', steps: [4, 0], holds: [1, 3] },
  { name: 'answer figure', steps: [7, 4, 2, 0], holds: [1, 1, 1, 2] },
  { name: 'arch', steps: [0, 5, 0], holds: [1, 2, 2] },
  { name: 'lonely call', steps: [0, -3, 0], holds: [1, 1, 2] },
];

/** Choir voicings — how a stacked wind section is spread. */
const CHOIRS = [
  { name: 'unison pair', offsets: [0, 0] },
  { name: 'octave pair', offsets: [0, 12] },
  { name: 'open fifth', offsets: [0, 7] },
  { name: 'major triad', offsets: [0, 4, 7] },
  { name: 'minor triad', offsets: [0, 3, 7] },
  { name: 'sus4 voicing', offsets: [0, 5, 12] },
  { name: 'wide octaves', offsets: [0, 12, 19] },
  { name: 'sixth pair', offsets: [0, 9] },
];

/** Trill intervals, in semitones, with the name a player would use. */
const TRILLS = [
  { iv: 1, name: 'semitone' },
  { iv: 2, name: 'whole-tone' },
  { iv: 2, name: 'whole-tone' },
  { iv: 3, name: 'minor-third' },
  { iv: 4, name: 'major-third' },
  { iv: 5, name: 'fourth' },
  { iv: 7, name: 'fifth' },
  { iv: 12, name: 'octave' },
];

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'sustain', 'hollow', 'nasal', 'ocarina', 'panpipe', 'whistle',
    'trill', 'phrase', 'staccato', 'bend', 'choir',
  ]);

  let out;
  let tags;

  if (style === 'hollow') {
    // The stopped pipe: odd harmonics only, 50% duty, filtered down to the
    // woody chalumeau. This is the clarinet caricature, and it is the one wind
    // a square wave is already halfway to being.
    const tb = voiceOf(rng, HOLLOW_VOICES);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const dur = rng.uniform(0.3, 1.4);
    const tilt = rng.uniform(0.6, 1.5); // how fast the odd partials fall away
    const rate = rng.uniform(4.0, 6.8);
    const depth = rng.uniform(2, 26);
    const note = reedNote(rng, tb, m, dur, {
      ranks: ODD_RANKS,
      tilt,
      spread: rng.uniform(0, 5),
      atk: rng.uniform(0.012, 0.06),
      dec: rng.uniform(0.05, 0.22),
      sus: rng.uniform(0.65, 0.95),
      rel: Math.min(dur * 0.5, rng.uniform(0.06, 0.24)),
      vib: vibratoFn(rate, depth, dur * rng.uniform(0.25, 0.7), 0),
      lo: rng.uniform(1.1, 1.8),
      hi: tb.bright * rng.uniform(0.5, 1.1),
      csus: rng.uniform(0.5, 0.85),
      air: tb.air * rng.uniform(0.4, 1.2),
      grain: rng.randint(1, 3),
      chiff: rng.uniform(0.0, 0.14),
    });
    out = note.buf;
    if (rng.random() < 0.3) crush(out, rng.randint(6, 15), rng.randint(1, 3), rng.uniform(0.3, 0.8));
    tags = {
      style: 'hollow',
      voice: tb.name,
      register: m < 58 ? 'chalumeau' : m < 72 ? 'clarion' : 'altissimo',
      body: tilt > 1.2 ? 'reedy' : tilt < 0.85 ? 'glassy' : 'woody',
      cut_hz: Math.round(note.hiHz),
      note: noteName(m),
    };
  } else if (style === 'nasal') {
    // Double reed: a narrow-duty square with a saw partial over it, thinned by
    // a highpass so the body drops out and only the pinched cane is left.
    const tb = voiceOf(rng, NASAL_VOICES);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const dur = rng.uniform(0.28, 1.35);
    const duty = rng.uniform(0.1, 0.32);
    const dr = rng.uniform(1.0, 2.4);
    const rate = rng.uniform(4.5, 7.2);
    const ranks = [
      [1, 1.0, null, duty],
      [2, rng.uniform(0.2, 0.5), 'saw', 0.5],
      [3, rng.uniform(0.08, 0.25), null, Math.max(0.08, duty * 0.9)],
    ];
    const note = reedNote(rng, tb, m, dur, {
      ranks,
      spread: rng.uniform(0, 7),
      atk: rng.uniform(0.008, 0.04),
      dec: rng.uniform(0.04, 0.18),
      sus: rng.uniform(0.6, 0.92),
      rel: Math.min(dur * 0.5, rng.uniform(0.05, 0.2)),
      vib: vibratoFn(rate, rng.uniform(4, 34), dur * rng.uniform(0.2, 0.6), 0),
      lo: rng.uniform(1.3, 2.4),
      hi: tb.bright * rng.uniform(0.6, 1.3),
      csus: rng.uniform(0.55, 0.9),
      hp: rng.uniform(0.6, 1.5),
      drive: dr,
      air: tb.air * rng.uniform(0.5, 1.6),
      grain: rng.randint(1, 2),
      chiff: rng.uniform(0.03, 0.2),
      chiffRate: rng.uniform(50, 160),
    });
    out = note.buf;
    if (rng.random() < 0.35) crush(out, rng.randint(5, 12), rng.randint(1, 2), rng.uniform(0.3, 0.9));
    tags = {
      style: 'nasal',
      voice: tb.name,
      reed: duty < 0.16 ? 'pinched' : dr > 1.8 ? 'buzzing' : 'caney',
      bite: dr > 1.9 ? 'overblown' : dr > 1.4 ? 'edgy' : 'even',
      duty_pct: Math.round(duty * 100),
      note: noteName(m),
    };
  } else if (style === 'ocarina') {
    // Vessel flute: almost a sine once the lowpass has done its work, with a
    // soft puff of air on the way in and, often, a sighing drop on the way out.
    const tb = voiceOf(rng, PURE_VOICES);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const dur = rng.uniform(0.24, 0.95);
    const sigh = rng.random() < 0.45 ? rng.uniform(0.15, 0.9) : 0; // semitones down at the tail
    const tail = Math.max(0.05, dur * rng.uniform(0.5, 0.85));
    const rate = rng.uniform(4.2, 7.0);
    const bright = rng.uniform(2.6, 5.2);
    const note = reedNote(rng, tb, m, dur, {
      spread: rng.uniform(0, 4),
      atk: rng.uniform(0.012, 0.055),
      dec: rng.uniform(0.05, 0.2),
      sus: rng.uniform(0.6, 0.92),
      rel: Math.min(dur * 0.6, rng.uniform(0.06, 0.25)),
      vib: vibratoFn(rate, rng.uniform(3, 22), dur * rng.uniform(0.3, 0.75), 0),
      bend: sigh ? (t) => (t < tail ? 0 : -sigh * ((t - tail) / Math.max(1e-4, dur - tail))) : null,
      lo: rng.uniform(1.05, 1.6),
      hi: bright,
      csus: rng.uniform(0.6, 0.95),
      air: tb.air * rng.uniform(0.5, 1.4),
      airHi: rng.uniform(3.5, 7.0),
      grain: rng.randint(1, 3),
      chiff: rng.uniform(0.04, 0.24),
      chiffRate: rng.uniform(40, 120),
    });
    out = note.buf;
    tags = {
      style: 'ocarina',
      voice: tb.name,
      body: bright > 4.2 ? 'glassy' : bright > 3.3 ? 'round' : 'hollow',
      tail: sigh > 0.5 ? 'sighing' : sigh ? 'drooping' : 'steady',
      hz: Math.round(note.f),
      note: noteName(m),
    };
  } else if (style === 'panpipe') {
    // Breath first, pitch second: a wide chiff of LFSR air across the mouth of
    // the pipe, with the hollow tone arriving underneath it.
    const tb = voiceOf(rng, BREATH_VOICES);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const dur = rng.uniform(0.26, 1.2);
    const chiffMs = rng.uniform(14, 90);
    const chiff = rng.uniform(0.3, 0.95);
    const airAmt = tb.air * rng.uniform(0.8, 1.8);
    const rate = rng.uniform(4.0, 7.4);
    const note = reedNote(rng, tb, m, dur, {
      spread: rng.uniform(0, 6),
      atk: rng.uniform(0.014, 0.06),
      dec: rng.uniform(0.05, 0.2),
      sus: rng.uniform(0.6, 0.9),
      rel: Math.min(dur * 0.55, rng.uniform(0.06, 0.24)),
      vib: vibratoFn(rate, rng.uniform(3, 28), dur * rng.uniform(0.25, 0.7), 0),
      lo: rng.uniform(1.1, 1.9),
      hi: tb.bright * rng.uniform(0.7, 1.4),
      csus: rng.uniform(0.55, 0.9),
      air: airAmt,
      airLo: rng.uniform(0.8, 1.8),
      airHi: rng.uniform(4.0, 9.0),
      airPunch: rng.uniform(0.5, 1.8),
      grain: rng.randint(1, 3),
      chiff,
      chiffLen: chiffMs / 1000,
      chiffAtk: rng.uniform(0.002, 0.008),
      chiffRate: rng.uniform(25, 90),
      chiffGrain: rng.randint(1, 2),
    });
    out = note.buf;
    tags = {
      style: 'panpipe',
      voice: tb.name,
      breath: chiff > 0.72 ? 'gusty' : chiff > 0.5 ? 'full' : 'soft',
      edge: airAmt > 0.55 ? 'windy' : airAmt > 0.3 ? 'hissing' : 'dry',
      chiff_ms: Math.round(chiffMs),
      note: noteName(m),
    };
  } else if (style === 'whistle') {
    // The soft high whistle — the purest thing in the category, so what makes
    // it musical is the entry: scooped up into pitch, swooped over it, or let
    // go at the end.
    const tb = voiceOf(rng, HIGH_VOICES);
    const m = clampM(rng.randint(Math.max(tb.lo, 67), Math.max(tb.hi, 72)));
    const dur = rng.uniform(0.24, 1.1);
    const shape = rng.choice(['scooped', 'scooped', 'falling', 'swooped', 'straight']);
    const amt = shape === 'straight' ? 0 : rng.uniform(0.2, 2.6);
    const tau = rng.uniform(0.02, 0.1);
    const letGo = Math.max(0.05, dur * rng.uniform(0.55, 0.85));
    const bendFn = shape === 'straight' ? null : shape === 'falling'
      ? (t) => (t < letGo ? 0 : -amt * ((t - letGo) / Math.max(1e-4, dur - letGo)))
      : shape === 'swooped'
        ? (t) => amt * Math.exp(-t / tau) * 0.6 - amt * 0.6 * Math.exp(-t / (tau * 4))
        : (t) => -amt * Math.exp(-t / tau);
    const bright = rng.uniform(2.4, 4.6);
    const rate = rng.uniform(4.5, 7.8);
    const note = reedNote(rng, tb, m, dur, {
      spread: rng.uniform(0, 3),
      atk: rng.uniform(0.01, 0.05),
      dec: rng.uniform(0.04, 0.18),
      sus: rng.uniform(0.65, 0.95),
      rel: Math.min(dur * 0.6, rng.uniform(0.05, 0.22)),
      vib: vibratoFn(rate, rng.uniform(3, 26), dur * rng.uniform(0.3, 0.8), rng.random() < 0.25 ? rng.randint(1, 2) : 0),
      bend: bendFn,
      lo: rng.uniform(1.05, 1.5),
      hi: bright,
      csus: rng.uniform(0.65, 0.95),
      air: tb.air * rng.uniform(0.4, 1.2),
      airHi: rng.uniform(3.0, 6.0),
      grain: rng.randint(1, 3),
      chiff: rng.uniform(0.02, 0.16),
    });
    out = note.buf;
    tags = {
      style: 'whistle',
      voice: tb.name,
      shape,
      tone: bright > 3.8 ? 'silvery' : bright > 3.0 ? 'glassy' : 'pure',
      cents: Math.round(amt * 100),
      hz: Math.round(note.f),
      note: noteName(m),
    };
  } else if (style === 'trill') {
    // The shake: pitch rocks between the note and its neighbour on a hard chip
    // switch, with a small dip in level at each flip so it re-articulates.
    const tb = rng.choice(TIMBRES);
    const tr = rng.choice(TRILLS);
    const m = clampM(pickBase(rng, tb, 0, tr.iv));
    const dur = rng.uniform(0.3, 1.4);
    const rateHz = rng.uniform(5.0, 16.0);
    const hard = rng.random() < 0.7; // chip trills switch, they don't glide
    const grow = Math.max(0.02, dur * rng.uniform(0.05, 0.45));
    const artic = rng.uniform(0.0, 0.35);
    const note = reedNote(rng, tb, m, dur, {
      spread: rng.uniform(0, 5),
      atk: rng.uniform(0.008, 0.045),
      dec: rng.uniform(0.04, 0.16),
      sus: rng.uniform(0.62, 0.95),
      rel: Math.min(dur * 0.5, rng.uniform(0.05, 0.2)),
      bend: (t) => {
        const lfo = 0.5 - 0.5 * Math.cos(2 * Math.PI * rateHz * t);
        const shp = hard ? (lfo > 0.5 ? 1.0 : 0.0) : lfo;
        return tr.iv * shp * Math.min(1.0, t / grow);
      },
      lo: rng.uniform(1.2, 2.0),
      hi: tb.bright * rng.uniform(0.6, 1.3),
      csus: rng.uniform(0.55, 0.9),
      air: tb.air * rng.uniform(0.5, 1.4),
      grain: rng.randint(1, 3),
      chiff: rng.uniform(0.03, 0.2),
    });
    out = note.buf;
    if (artic > 0.05) amMod(out, rateHz, artic, rng.random());
    tags = {
      style: 'trill',
      voice: tb.name,
      interval: tr.name,
      feel: hard ? (rateHz > 11 ? 'fluttering' : 'stepped') : rateHz > 11 ? 'shimmering' : 'slurred',
      rate_hz: r1(rateHz),
      note: noteName(m),
    };
  } else if (style === 'phrase') {
    // A line, not a note: two to four steps of a real figure, the last one
    // held. The tempo is real (the unit is an eighth) but the figure is
    // squeezed if it would run past the category's ceiling.
    const tb = rng.choice(TIMBRES);
    const fig = rng.choice(FIGURES);
    let lo = 0;
    let hi = 0;
    for (const s of fig.steps) {
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    const m = clampM(pickBase(rng, tb, lo, hi));
    let bpm = rng.randint(84, 176);
    let unit = 60.0 / bpm / 2.0;
    let units = 0;
    for (const h of fig.holds) units += h;
    if (unit * units > 1.28) unit = 1.28 / units;
    const gate = rng.uniform(0.72, 1.12); // >1 slurs the notes into each other
    const swing = rng.random() < 0.26 ? rng.uniform(0.08, 0.2) : 0;
    const legato = gate > 0.96;
    const spread = rng.uniform(0, 6);
    const airScale = rng.uniform(0.5, 1.5);
    out = [];
    let at = 0.0;
    for (let k = 0; k < fig.steps.length; k++) {
      const last = k === fig.steps.length - 1;
      const slot = unit * fig.holds[k];
      const dur = Math.max(0.07, slot * (last ? Math.min(1.15, gate + 0.25) : gate));
      const nm = clampM(m + fig.steps[k]);
      const note = reedNote(rng, tb, nm, dur, {
        spread,
        atk: legato ? rng.uniform(0.02, 0.07) : rng.uniform(0.006, 0.026),
        dec: rng.uniform(0.03, 0.13),
        sus: rng.uniform(0.6, 0.95),
        rel: Math.min(dur * 0.55, last ? rng.uniform(0.07, 0.25) : rng.uniform(0.03, 0.1)),
        vib: last ? vibratoFn(rng.uniform(4.2, 7.2), rng.uniform(4, 30), dur * 0.5, 0) : null,
        lo: rng.uniform(1.1, 2.0),
        hi: tb.bright * rng.uniform(0.6, 1.3),
        csus: rng.uniform(0.55, 0.9),
        air: tb.air * airScale,
        grain: rng.randint(1, 3),
        chiff: legato ? rng.uniform(0.0, 0.1) : rng.uniform(0.04, 0.22),
      });
      mixAt(out, note.buf, secs(at), last ? 1.0 : rng.uniform(0.78, 1.0));
      at += slot + (swing && k % 2 === 0 ? slot * swing : 0);
    }
    bpm = Math.round(60.0 / (unit * 2.0));
    tags = {
      style: 'phrase',
      voice: tb.name,
      pattern: fig.name,
      feel: swing ? 'swung' : legato ? 'legato' : gate < 0.82 ? 'clipped' : 'tongued',
      bpm,
      note: noteName(m),
    };
  } else if (style === 'staccato') {
    // Tongued chops: two to six short notes on a grid, accented on the first,
    // occasionally kicking up to the fifth or the octave.
    const tb = rng.choice(TIMBRES);
    const m = clampM(pickBase(rng, tb, -5, 12));
    const hits = rng.randint(2, 6);
    let step = 60.0 / rng.randint(96, 184) / 2.0;
    const gate = rng.uniform(0.25, 0.65);
    const swing = rng.random() < 0.28 ? rng.uniform(0.08, 0.2) : 0;
    if (step * (hits - 1) > 1.16) step = 1.16 / Math.max(1, hits - 1);
    const noteDur = Math.min(0.22, Math.max(0.055, step * gate));
    const spread = rng.uniform(0, 6);
    const airScale = rng.uniform(0.5, 1.6);
    out = [];
    let at = 0.0;
    for (let k = 0; k < hits; k++) {
      const jump = k === 0 ? 0 : rng.choice([0, 0, 0, 0, 7, 12, -5, 2]);
      const note = reedNote(rng, tb, clampM(m + jump), noteDur, {
        spread,
        atk: rng.uniform(0.003, 0.012),
        dec: rng.uniform(0.012, 0.05),
        sus: rng.uniform(0.35, 0.7),
        rel: Math.min(noteDur * 0.5, rng.uniform(0.02, 0.06)),
        lo: rng.uniform(1.3, 2.4),
        hi: tb.bright * rng.uniform(0.7, 1.4),
        catk: rng.uniform(0.003, 0.012),
        cfall: rng.uniform(0.02, 0.08),
        csus: rng.uniform(0.4, 0.75),
        air: tb.air * airScale,
        grain: rng.randint(1, 2),
        chiff: rng.uniform(0.08, 0.32),
        chiffLen: rng.uniform(0.008, 0.03),
        chiffRate: rng.uniform(80, 260),
      });
      mixAt(out, note.buf, secs(at), k === 0 ? 1.0 : rng.uniform(0.62, 0.95));
      at += step + (swing && k % 2 === 0 ? step * swing : 0);
    }
    tags = {
      style: 'staccato',
      voice: tb.name,
      feel: swing ? 'swung' : gate < 0.4 ? 'clipped' : gate > 0.55 ? 'round' : 'tongued',
      hits,
      bpm: Math.round(60.0 / (step * 2.0)),
      note: noteName(m),
    };
  } else if (style === 'bend') {
    // The expressive move: scooped in from underneath, let go at the end, or
    // overblown up an octave partway through — a shakuhachi meri-kari in chip.
    const tb = rng.choice(TIMBRES);
    const kind = rng.choice(['scoop', 'scoop', 'fall', 'fall', 'overblow', 'rise']);
    const upward = kind === 'overblow' || kind === 'rise';
    const m = clampM(pickBase(rng, tb, kind === 'fall' ? -12 : 0, upward ? 12 : 0));
    const dur = rng.uniform(0.3, 1.35);
    const amt = kind === 'overblow' ? 12 : kind === 'scoop' ? rng.uniform(0.5, 5.0) : rng.uniform(1.0, 11.0);
    const tau = rng.uniform(0.02, 0.12);
    const hold = rng.uniform(0.25, 0.7); // fraction of the note held in tune first
    const start = dur * hold;
    const lazy = rng.uniform(0.7, 2.6);
    const bendFn = kind === 'scoop'
      ? (t) => -amt * Math.exp(-t / tau)
      : kind === 'overblow'
        ? (t) => (t < start ? 0 : amt * Math.min(1.0, (t - start) / Math.max(1e-4, tau)))
        : (t) => {
          const p = Math.max(0.0, (t - start) / Math.max(1e-4, dur - start));
          const s = Math.pow(p, lazy);
          return kind === 'rise' ? amt * s : -amt * s;
        };
    const note = reedNote(rng, tb, m, dur, {
      spread: rng.uniform(0, 6),
      atk: rng.uniform(0.008, 0.05),
      dec: rng.uniform(0.04, 0.18),
      sus: rng.uniform(0.6, 0.95),
      rel: Math.min(dur * 0.55, rng.uniform(0.06, 0.26)),
      bend: bendFn,
      lo: rng.uniform(1.1, 2.0),
      hi: tb.bright * rng.uniform(0.6, 1.4),
      csus: rng.uniform(0.5, 0.9),
      drive: kind === 'overblow' ? rng.uniform(1.4, 2.8) : rng.uniform(1.0, 1.6),
      air: tb.air * rng.uniform(0.6, 1.7),
      airPunch: rng.uniform(0.4, 1.6),
      grain: rng.randint(1, 3),
      chiff: rng.uniform(0.04, 0.26),
    });
    out = note.buf;
    tags = {
      style: 'bend',
      voice: tb.name,
      direction: kind === 'scoop' ? 'scoop' : kind === 'overblow' ? 'overblow' : kind === 'rise' ? 'rise' : 'fall-off',
      speed: kind === 'scoop' ? (tau > 0.07 ? 'lazy' : 'quick') : lazy > 1.8 ? 'lazy' : lazy > 1.1 ? 'slurred' : 'quick',
      semis: r1(amt),
      note: noteName(m),
    };
  } else if (style === 'choir') {
    // Several pipes missing each other slightly: detuned in cents, staggered by
    // a few milliseconds, spread across a voicing. A wind pad in miniature.
    const tb = rng.choice(TIMBRES);
    const ch = rng.choice(CHOIRS);
    let hi = 0;
    for (const o of ch.offsets) if (o > hi) hi = o;
    const m = clampM(pickBase(rng, tb, 0, hi));
    const dur = rng.uniform(0.5, 1.4);
    const spread = rng.uniform(3, 26);
    const stagger = rng.uniform(0, 0.03);
    const rate = rng.uniform(3.6, 6.6);
    const airScale = rng.uniform(0.5, 1.5);
    out = [];
    let voices = 0;
    for (let k = 0; k < ch.offsets.length; k++) {
      const nm = clampM(m + ch.offsets[k]);
      const note = reedNote(rng, tb, nm, dur * rng.uniform(0.9, 1.0), {
        detune: k === 0 ? rng.uniform(-spread * 0.25, spread * 0.25) : rng.uniform(-spread, spread),
        spread: spread * 0.4,
        atk: rng.uniform(0.03, 0.14),
        dec: rng.uniform(0.06, 0.25),
        sus: rng.uniform(0.65, 0.95),
        rel: rng.uniform(0.1, 0.35),
        vib: vibratoFn(rate * rng.uniform(0.9, 1.1), rng.uniform(3, 24), dur * rng.uniform(0.2, 0.6), 0),
        lo: rng.uniform(1.05, 1.7),
        hi: tb.bright * rng.uniform(0.6, 1.2),
        csus: rng.uniform(0.6, 0.95),
        air: tb.air * airScale,
        grain: rng.randint(1, 3),
        chiff: rng.uniform(0.0, 0.12),
      });
      mixAt(out, note.buf, secs(stagger * voices * rng.uniform(0.5, 1.5)), rng.uniform(0.72, 1.0));
      voices++;
    }
    const trem = rng.uniform(0, 0.22);
    if (trem > 0.06) amMod(out, rng.uniform(3.0, 6.5), trem, rng.random());
    tags = {
      style: 'choir',
      voice: tb.name,
      stack: ch.name,
      blend: spread > 18 ? 'ragged' : spread > 10 ? 'wide' : 'tight',
      voices,
      cents: r1(spread),
      note: noteName(m),
    };
  } else {
    // sustain — the default and the workhorse: one held breathy note, the
    // filter opening as the air arrives and the vibrato leaning in late.
    const tb = rng.choice(TIMBRES);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const dur = rng.uniform(0.4, 1.42);
    const soft = rng.random() < 0.55;
    const rate = rng.uniform(3.8, 7.6);
    const depth = rng.uniform(3, 48);
    const steps = rng.random() < 0.28 ? rng.randint(1, 3) : 0;
    const airAmt = tb.air * rng.uniform(0.5, 1.7);
    const note = reedNote(rng, tb, m, dur, {
      spread: rng.uniform(0, 6),
      atk: soft ? rng.uniform(0.03, 0.13) : rng.uniform(0.008, 0.03),
      dec: rng.uniform(0.04, 0.2),
      sus: rng.uniform(0.62, 0.95),
      rel: Math.min(dur * 0.55, rng.uniform(0.07, 0.3)),
      vib: vibratoFn(rate, depth, dur * rng.uniform(0.15, 0.6), steps),
      lo: rng.uniform(1.1, 2.0),
      hi: tb.bright * rng.uniform(0.6, 1.4),
      cfall: rng.uniform(0.06, 0.25),
      csus: rng.uniform(0.5, 0.92),
      air: airAmt,
      airLo: rng.uniform(0.9, 1.8),
      airHi: rng.uniform(4.0, 8.0),
      airPunch: rng.uniform(0.3, 1.4),
      grain: rng.randint(1, 3),
      chiff: soft ? rng.uniform(0.0, 0.12) : rng.uniform(0.05, 0.28),
    });
    out = note.buf;
    if (rng.random() < 0.28) crush(out, rng.randint(6, 15), rng.randint(1, 3), rng.uniform(0.25, 0.75));
    tags = {
      style: 'sustain',
      voice: tb.name,
      breath: airAmt > 0.4 ? 'breathy' : airAmt > 0.18 ? 'airy' : 'clean',
      motion: steps ? 'stepped' : depth > 30 ? 'singing' : depth > 12 ? 'shimmering' : 'still',
      vib_hz: r1(rate),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every wind inside 0.22 - 1.46 s, block the narrow-duty stack's DC
  // bias, then de-click both edges before normalizing, so the peak is exact
  // even when the loudest sample sits inside the first millisecond.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  while (out.length < MIN_N) out.push(0.0);
  const fi = Math.min(out.length >> 2, 16);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.008 * SR), Math.round(0.02 * out.length)));
  dcBlock(out, 0.997);
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C4';
  const voice = t.voice || 'flute';
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  const dec = (v, d) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : d.toFixed(1));
  switch (t.style) {
    case 'hollow':
      return `hollow chip ${voice} — ${t.register || 'clarion'} register, ${t.body || 'woody'} body, ${num(t.cut_hz)} Hz on ${note}`;
    case 'nasal':
      return `nasal chip ${voice} — ${t.reed || 'caney'} double reed, ${t.bite || 'even'}, ${num(t.duty_pct)}% duty on ${note}`;
    case 'ocarina':
      return `chip ${voice} vessel tone — ${t.body || 'round'}, ${t.tail || 'steady'} tail, ${num(t.hz)} Hz ${note}`;
    case 'panpipe':
      return `chip pan pipe — ${t.breath || 'full'} ${num(t.chiff_ms)} ms chiff, ${t.edge || 'windy'} ${voice} on ${note}`;
    case 'whistle':
      return t.cents
        ? `soft chip whistle — ${t.shape || 'scooped'} ${num(t.cents)}-cent entry, ${t.tone || 'pure'} ${voice} on ${note}`
        : `soft chip whistle — straight ${t.tone || 'pure'} ${voice} tone, ${num(t.hz)} Hz on ${note}`;
    case 'trill':
      return `chip ${voice} trill — ${t.interval || 'whole-tone'} shake, ${t.feel || 'stepped'}, ${dec(t.rate_hz, 9)} Hz on ${note}`;
    case 'phrase':
      return `chip ${voice} phrase — ${t.pattern || 'rising third'}, ${t.feel || 'legato'}, ${num(t.bpm)} BPM from ${note}`;
    case 'staccato': {
      const n = num(t.hits);
      return `tongued chip ${voice} — ${n} ${t.feel || 'clipped'} note${n === 1 ? '' : 's'} at ${num(t.bpm)} BPM on ${note}`;
    }
    case 'bend':
      return `chip ${voice} ${t.direction || 'scoop'} — ${t.speed || 'lazy'} ${dec(t.semis, 3)}-semitone bend on ${note}`;
    case 'choir':
      return `chip ${voice} choir — ${t.stack || 'octave pair'}, ${num(t.voices)} voices ${dec(t.cents, 12)} cents apart on ${note}`;
    default:
      return `breathy chip ${voice} — ${t.breath || 'airy'} sustain, ${t.motion || 'singing'}, ${dec(t.vib_hz, 5)} Hz vibrato on ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'breathy chip flutes, hollow clarinet, nasal oboe, ocarina, pan pipes';
