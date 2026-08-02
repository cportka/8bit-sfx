// brass — pitched chip-caricature brass. A brass instrument is not a waveform,
// it is a *behaviour*: the bell brightens as the player leans in, the pitch is
// lipped into place from just underneath, and the note ends the way the air
// does — cut, fallen off, or blown open. So none of these are samples. Each
// variation is a small stack of naive chip partials (saw for the bright bore,
// squares for the buzz, triangles for the mellow flugel/horn end) run through a
// hand-rolled one-pole lowpass whose cutoff OPENS with the attack and settles
// back — that filter move is the whole brass illusion, and it is what makes a
// square stack read as a horn section instead of an organ.
//
// Every voice lands on an exact MIDI note between C2 and C5 and records its
// PITCH, so a stab sits in tune over the bass and a fanfare answers the lead.
// Seven caricatured horns (trumpet, cornet, trombone, french horn, tuba,
// flugelhorn, piccolo trumpet) each carry their own partial recipe, their own
// brightness ceiling and their own playable range, so the pitch you get is one
// a real player of that horn would actually have.
//
// Ten sub-styles cover the brass vocabulary a track needs: the hard accent
// stab, a multi-note fanfare call, the slow crescendo swell, muted harmon /
// cup / straight buzz, the fall off the note (and its rip-up twin), a detuned
// section ensemble stack, staccato section chops, a flutter-tongue growl, a
// lip-trill shake, and the plunger wah.
//
// All chip primitives: naive squares/triangles/saws at harmonic ratios, LFSR
// noise for breath and attack chiff, sample-and-hold crush for the mutes, tanh
// drive for the overblown edge. Post chain is uniform — DC block (narrow-duty
// square stacks carry a real bias), de-click both edges, normalize LAST so the
// peak is exact even when the loudest sample is in the first millisecond.

import {
  SR, Lfsr, square, triangle, sawtooth, midi, noteName, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.16 * SR);
const MAX_N = Math.round(1.48 * SR);

const LO_M = 36; // C2 — the tuba floor
const HI_M = 72; // C5 — the piccolo-trumpet ceiling

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

/** One decimal, for tags that read better as 12.4 than 12.37. */
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

/** One-pole highpass in place — thins a mute without touching the pitch. */
function highpass(buf, cut) {
  const a = alphaOf(cut);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += a * (buf[i] - p);
    buf[i] -= p;
  }
  return buf;
}

/** Symmetric tanh drive — the overblown bell. */
function drive(buf, amount) {
  const k = Math.max(1.0, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(k * buf[i]) / norm;
  return buf;
}

/** Sample-and-hold rate reduction plus a coarse level crush, in place. */
function crush(buf, steps, hold) {
  const h = Math.max(1, Math.round(hold));
  let held = 0.0;
  for (let i = 0; i < buf.length; i++) {
    if (i % h === 0) held = buf[i];
    buf[i] = Math.round(held * steps) / steps;
  }
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

/** Percussive envelope: near-instant attack, exponential fall. */
function burstEnv(atk, rate) {
  const a = Math.max(1e-5, atk);
  return (t) => Math.min(1.0, t / a) * Math.exp(-rate * t);
}

/**
 * The brass move: cutoff ramps from `loHz` to `hiHz` across the attack, then
 * settles back toward `sus` of that span. This is what separates a horn from
 * a held organ rank.
 */
function sweepCut(loHz, hiHz, atk, fall, sus) {
  const a = Math.max(1e-4, atk);
  const fl = Math.max(1e-4, fall);
  return (t) => {
    const s = t < a ? t / a : sus + (1.0 - sus) * Math.exp(-(t - a) / fl);
    return loHz + (hiHz - loHz) * s;
  };
}

/** Lowpassed LFSR layer — breath, attack chiff, mute fizz. */
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

/** Amplitude modulation in place — growl flutter, section tremolo. */
function amMod(buf, hz, depth, phase0 = 0.0) {
  for (let i = 0; i < buf.length; i++) {
    const ph = hz * (i / SR) + phase0;
    buf[i] *= 1.0 - depth * 0.5 * (1.0 - Math.cos(2 * Math.PI * ph));
  }
  return buf;
}

/**
 * Render a partial stack additively: one phase accumulator per partial, all
 * summed against a shared per-sample frequency (so scoops, falls and shakes
 * bend the whole horn in tune) and a shared amplitude envelope.
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

// --- the horns -------------------------------------------------------------

// Each caricature is a partial recipe ([ratio, gain, wave, duty]), a brightness
// ceiling as a multiple of the fundamental, and the slice of C2-C5 a player of
// that horn actually lives in.
const TIMBRES = [
  { name: 'trumpet', lo: 52, hi: 72, bright: 13, ranks: [[1, 1.0, 'saw', 0.5], [2, 0.32, null, 0.5], [3, 0.15, null, 0.25]] },
  { name: 'cornet', lo: 50, hi: 70, bright: 9, ranks: [[1, 1.0, 'saw', 0.5], [2, 0.22, 'tri', 0.5], [3, 0.08, null, 0.5]] },
  { name: 'trombone', lo: 40, hi: 62, bright: 10, ranks: [[1, 1.0, 'saw', 0.5], [2, 0.34, null, 0.33], [4, 0.12, null, 0.5]] },
  { name: 'french horn', lo: 41, hi: 65, bright: 7, ranks: [[1, 1.0, null, 0.5], [2, 0.24, 'tri', 0.5], [3, 0.09, 'tri', 0.5]] },
  { name: 'tuba', lo: 36, hi: 52, bright: 6, ranks: [[0.5, 0.4, 'tri', 0.5], [1, 1.0, null, 0.5], [2, 0.2, null, 0.25]] },
  { name: 'flugelhorn', lo: 48, hi: 66, bright: 8, ranks: [[1, 1.0, 'tri', 0.5], [2, 0.3, 'saw', 0.5], [3, 0.06, null, 0.5]] },
  { name: 'piccolo trumpet', lo: 60, hi: 72, bright: 16, ranks: [[1, 1.0, 'saw', 0.5], [2, 0.4, null, 0.25], [3, 0.18, null, 0.25]] },
];

/** A horn's partial stack, optionally detuned and re-voiced. */
function partsFor(rng, tb, opts = {}) {
  const spread = opts.spread || 0;
  const parts = [];
  for (let k = 0; k < tb.ranks.length; k++) {
    const r = tb.ranks[k];
    parts.push({
      ratio: spread ? r[0] * cents(rng.uniform(-spread, spread)) : r[0],
      g: r[1] * (opts.tilt === undefined ? 1.0 : Math.pow(opts.tilt, k)),
      wave: opts.wave === undefined ? r[2] : opts.wave,
      duty: opts.duty === undefined ? r[3] : opts.duty,
      ph: rng.random(), // partials start decorrelated, so the attack isn't one spike
    });
  }
  return parts;
}

/**
 * One brass note, whole: scooped-into pitch, stacked partials, and the filter
 * opening across the attack. Every multi-note style (fanfare, staccato,
 * ensemble) is built out of these.
 */
function brassNote(rng, tb, m, dur, opts = {}) {
  const f = midi(m);
  const n = secs(dur);
  const parts = partsFor(rng, tb, opts);
  const env = shaped(
    dur,
    opts.atk === undefined ? 0.006 : opts.atk,
    opts.dec === undefined ? 0.05 : opts.dec,
    opts.sus === undefined ? 0.5 : opts.sus,
    Math.min(dur * 0.5, opts.rel === undefined ? 0.05 : opts.rel)
  );
  const scoop = opts.scoop || 0;
  const tau = opts.tau || 0.015;
  const buf = stackTone(n, (t) => f * semis(-scoop * Math.exp(-t / tau)), parts, env);
  const loHz = Math.max(180, f * (opts.lo === undefined ? 2.0 : opts.lo));
  const hiHz = Math.max(loHz * 1.4, Math.min(NYQ, f * (opts.hi === undefined ? tb.bright : opts.hi)));
  lowpass(buf, sweepCut(loHz, hiHz, opts.catk === undefined ? 0.012 : opts.catk,
    opts.cfall === undefined ? 0.08 : opts.cfall, opts.csus === undefined ? 0.35 : opts.csus));
  if (opts.drive && opts.drive > 1.05) drive(buf, opts.drive);
  return { buf, hiHz };
}

// --- figures ---------------------------------------------------------------

/** Fanfare calls, as semitone steps over the root with relative note lengths. */
const FANFARES = [
  { name: 'rising triad call', steps: [0, 4, 7], holds: [1, 1, 2] },
  { name: 'fifth call', steps: [0, 7], holds: [1, 2] },
  { name: 'octave leap', steps: [0, 12], holds: [1, 2] },
  { name: 'triple tongue', steps: [0, 0, 0, 7], holds: [1, 1, 1, 2] },
  { name: 'fifth pickup', steps: [7, 0], holds: [1, 3] },
  { name: 'royal ascent', steps: [0, 4, 7, 12], holds: [1, 1, 1, 2] },
  { name: 'call and answer', steps: [0, 7, 4], holds: [1, 1, 2] },
  { name: 'bugle charge', steps: [0, 0, 4, 7], holds: [1, 1, 1, 2] },
  { name: 'falling call', steps: [12, 7, 0], holds: [1, 1, 2] },
  { name: 'stepwise climb', steps: [0, 2, 4, 5], holds: [1, 1, 1, 2] },
  { name: 'answer figure', steps: [7, 5, 4, 0], holds: [1, 1, 1, 2] },
];

/** Section voicings — how an ensemble stack is spread. */
const STACKS = [
  { name: 'unison', offsets: [0, 0, 0] },
  { name: 'octave stack', offsets: [0, 12, 0] },
  { name: 'major triad', offsets: [0, 4, 7] },
  { name: 'minor triad', offsets: [0, 3, 7] },
  { name: 'open fifths', offsets: [0, 7] },
  { name: 'power stack', offsets: [0, 7, 12] },
  { name: 'wide voicing', offsets: [0, 7, 16] },
  { name: 'sus voicing', offsets: [0, 5, 12] },
];

/** Mute characters — a mute is a duty cycle and a highpass, in chip terms. */
const MUTES = [
  { name: 'harmon', duty: 0.12, hp: 2.4, fizz: 0.1 },
  { name: 'cup', duty: 0.3, hp: 1.2, fizz: 0.05 },
  { name: 'straight', duty: 0.2, hp: 1.8, fizz: 0.08 },
  { name: 'bucket', duty: 0.42, hp: 0.7, fizz: 0.03 },
];

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'stab', 'fanfare', 'swell', 'harmon', 'fall', 'ensemble', 'staccato', 'growl', 'shake', 'wah',
  ]);

  let out;
  let tags;

  if (style === 'fanfare') {
    // A call, not a note: two to four steps over the root, the last one held.
    // The tempo is real (the unit is an eighth) but it is squeezed if the
    // figure would run past the category's 1.5 s ceiling.
    const tb = rng.choice(TIMBRES);
    const fig = rng.choice(FANFARES);
    let top = 0;
    for (const s of fig.steps) top = Math.max(top, s);
    const m = clampM(rng.randint(tb.lo, Math.max(tb.lo, Math.min(tb.hi, HI_M - top) )));
    let bpm = rng.randint(88, 184);
    let unit = 60.0 / bpm / 2.0;
    let units = 0;
    for (const h of fig.holds) units += h;
    if (unit * units > 1.32) unit = 1.32 / units;
    const gate = rng.uniform(0.72, 1.0);
    const swing = rng.random() < 0.28 ? rng.uniform(0.1, 0.22) : 0;
    const dr = rng.uniform(1.0, 2.6);
    const spread = rng.uniform(0, 7);
    out = [];
    let at = 0.0;
    for (let k = 0; k < fig.steps.length; k++) {
      const last = k === fig.steps.length - 1;
      const slot = unit * fig.holds[k];
      const dur = Math.max(0.06, slot * (last ? Math.min(1.0, gate + 0.2) : gate));
      const nm = clampM(m + fig.steps[k]);
      const note = brassNote(rng, tb, nm, dur, {
        spread,
        atk: rng.uniform(0.003, 0.012),
        dec: rng.uniform(0.02, 0.08),
        sus: rng.uniform(0.45, 0.85),
        rel: last ? Math.min(dur * 0.5, rng.uniform(0.05, 0.16)) : Math.min(dur * 0.5, 0.03),
        scoop: rng.uniform(0.2, 1.2),
        tau: rng.uniform(0.006, 0.02),
        lo: rng.uniform(1.6, 2.6),
        hi: tb.bright * rng.uniform(0.7, 1.3),
        cfall: rng.uniform(0.04, 0.12),
        drive: dr,
      });
      mixAt(out, note.buf, secs(at), last ? 1.0 : rng.uniform(0.8, 1.0));
      at += slot + (swing && k % 2 === 0 ? slot * swing : 0);
    }
    bpm = Math.round(60.0 / (unit * 2.0));
    tags = {
      style: 'fanfare',
      pattern: fig.name,
      voice: tb.name,
      feel: swing ? 'swung' : gate < 0.82 ? 'clipped' : dr > 2.0 ? 'blazing' : 'straight',
      notes: fig.steps.length,
      bpm,
      note: noteName(m),
    };
  } else if (style === 'swell') {
    // The crescendo: amplitude and cutoff climb together for most of the note,
    // then either hold at the top or get cut off at the peak.
    const tb = rng.choice(TIMBRES);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const f = midi(m);
    const dur = rng.uniform(0.55, 1.45);
    const n = secs(dur);
    const rise = rng.uniform(0.45, 0.85); // fraction of the note spent climbing
    const atk = dur * rise;
    const cutOff = rng.random() < 0.4;
    const rel = cutOff ? Math.min(dur * 0.15, 0.05) : Math.min(dur * 0.45, rng.uniform(0.1, 0.4));
    const parts = partsFor(rng, tb, { spread: rng.uniform(1, 9) });
    const curve = rng.uniform(1.3, 3.0); // >1 = the classic slow-then-sudden swell
    const env = (t) => {
      const up = t < atk ? Math.pow(t / atk, curve) : 1.0;
      const left = dur - t;
      return up * (left < rel ? Math.max(0.0, left / rel) : 1.0);
    };
    const vibHz = rng.uniform(4.5, 7.0);
    const vibDepth = rng.uniform(0, 22); // cents, and it only arrives at the top
    out = stackTone(n, (t) => {
      const g = Math.min(1.0, t / Math.max(1e-4, atk));
      return f * cents(vibDepth * g * g * Math.sin(2 * Math.PI * vibHz * t));
    }, parts, env);
    const hiHz = Math.max(400, Math.min(NYQ, f * tb.bright * rng.uniform(0.9, 1.7)));
    const loHz = Math.max(180, f * rng.uniform(1.2, 2.0));
    lowpass(out, (t) => loHz + (hiHz - loHz) * Math.min(1.0, Math.pow(t / Math.max(1e-4, atk), curve * 0.6)));
    const dr = rng.uniform(1.0, 3.2);
    if (dr > 1.3) drive(out, dr);
    const air = rng.uniform(0.0, 0.16);
    if (air > 0.04) {
      mixAt(out, noiseLayer(rng, n, rng.randint(2, 6), Math.min(NYQ, f * 5.0),
        (t) => Math.min(1.0, t / Math.max(1e-4, atk)) * 0.9), 0, air);
    }
    tags = {
      style: 'swell',
      rise: rise > 0.72 ? 'slow' : rise > 0.58 ? 'steady' : 'urgent',
      peak: dr > 2.4 ? 'blaring' : dr > 1.6 ? 'gritty' : 'warm',
      voice: tb.name,
      cut_hz: Math.round(hiHz),
      note: noteName(m),
    };
  } else if (style === 'harmon') {
    // Mutes, in chip terms: a narrow-duty square stack, highpassed until the
    // body is gone, with a slow wobble on the stem and a little fizz.
    const tb = rng.choice(TIMBRES);
    const mute = rng.choice(MUTES);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const f = midi(m);
    const dur = rng.uniform(0.25, 1.1);
    const n = secs(dur);
    const duty = Math.max(0.06, mute.duty * rng.uniform(0.7, 1.3));
    const parts = partsFor(rng, tb, { spread: rng.uniform(0, 5), wave: null, duty, tilt: rng.uniform(0.9, 1.5) });
    const env = shaped(dur, rng.uniform(0.004, 0.03), rng.uniform(0.03, 0.14),
      rng.uniform(0.5, 0.9), Math.min(dur * 0.5, rng.uniform(0.04, 0.16)));
    out = stackTone(n, () => f, parts, env);
    const hiHz = Math.max(500, Math.min(NYQ, f * tb.bright * rng.uniform(0.8, 1.6)));
    lowpass(out, sweepCut(Math.max(250, f * 2.0), hiHz, rng.uniform(0.008, 0.03),
      rng.uniform(0.05, 0.2), rng.uniform(0.4, 0.8)));
    highpass(out, Math.max(120, f * mute.hp * rng.uniform(0.8, 1.3)));
    const wob = rng.uniform(14, 55);
    const depth = rng.uniform(0.12, 0.5);
    amMod(out, wob, depth, rng.random());
    if (mute.fizz > 0.04) {
      mixAt(out, noiseLayer(rng, n, rng.randint(1, 3), Math.min(NYQ, f * 8.0),
        (t) => Math.min(1.0, t / 0.01) * (0.5 + 0.5 * Math.exp(-3.0 * t))), 0, mute.fizz * rng.uniform(0.6, 1.6));
    }
    if (rng.random() < 0.45) crush(out, rng.randint(5, 13), rng.randint(1, 3));
    tags = {
      style: 'harmon',
      mute: mute.name,
      buzz: depth > 0.36 ? 'fizzing' : duty < 0.18 ? 'nasal' : 'tight',
      duty_pct: Math.round(duty * 100),
      wobble_hz: r1(wob),
      note: noteName(m),
    };
  } else if (style === 'fall') {
    // The exit: hold the note, then let the pitch go — off the bottom (fall),
    // up and out (rip), or scooped in from underneath (smear).
    const tb = rng.choice(TIMBRES);
    const kind = rng.choice(['fall', 'fall', 'fall', 'rip', 'smear']);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const f = midi(m);
    const dur = rng.uniform(0.3, 1.2);
    const n = secs(dur);
    const amt = kind === 'smear' ? rng.uniform(2, 9) : rng.uniform(4, 19);
    const hold = kind === 'smear' ? 0 : rng.uniform(0.15, 0.6); // fraction held in tune
    const start = dur * hold;
    const lazy = rng.uniform(0.8, 3.0); // curve of the slide
    const smearTau = rng.uniform(0.02, 0.09); // how fast a scoop arrives in tune
    const parts = partsFor(rng, tb, { spread: rng.uniform(0, 6) });
    const env = shaped(dur, rng.uniform(0.003, 0.02), rng.uniform(0.03, 0.12),
      rng.uniform(0.45, 0.85), Math.min(dur * 0.6, rng.uniform(0.08, 0.35)));
    const bend = (t) => {
      if (kind === 'smear') return -amt * Math.exp(-t / smearTau);
      const p = Math.max(0.0, (t - start) / Math.max(1e-4, dur - start));
      const s = Math.pow(p, lazy);
      return kind === 'rip' ? amt * s : -amt * s;
    };
    out = stackTone(n, (t) => f * semis(bend(t)), parts, env);
    const hiHz = Math.max(400, Math.min(NYQ, f * tb.bright * rng.uniform(0.8, 1.4)));
    const loHz = Math.max(200, f * rng.uniform(1.4, 2.4));
    lowpass(out, (t) => {
      const p = Math.max(0.0, Math.min(1.0, (t - start) / Math.max(1e-4, dur - start)));
      const close = kind === 'rip' ? 1.0 : 1.0 - 0.75 * p;
      return loHz + (hiHz - loHz) * close;
    });
    const dr = rng.uniform(1.0, 2.8);
    if (dr > 1.3) drive(out, dr);
    tags = {
      style: 'fall',
      direction: kind === 'rip' ? 'rip-up' : kind === 'smear' ? 'smear' : 'fall-off',
      voice: tb.name,
      speed: lazy > 2.0 ? 'lazy' : lazy > 1.3 ? 'slurred' : 'quick',
      semis: r1(amt),
      note: noteName(m),
    };
  } else if (style === 'ensemble') {
    // A section is many players missing each other slightly: detuned in cents,
    // staggered by a few milliseconds, spread across a voicing.
    const tb = rng.choice(TIMBRES);
    const stack = rng.choice(STACKS);
    const m = clampM(rng.randint(tb.lo, tb.hi - 4 > tb.lo ? tb.hi - 4 : tb.hi));
    const dur = rng.uniform(0.4, 1.35);
    const spread = rng.uniform(4, 30);
    const stagger = rng.uniform(0, 0.022);
    const doubles = rng.randint(1, 2); // players per voicing seat
    const dr = rng.uniform(1.0, 2.4);
    out = [];
    let voices = 0;
    for (let k = 0; k < stack.offsets.length; k++) {
      for (let d = 0; d < doubles; d++) {
        const nm = clampM(m + stack.offsets[k]);
        const note = brassNote(rng, tb, nm, dur * rng.uniform(0.9, 1.0), {
          spread,
          atk: rng.uniform(0.006, 0.05),
          dec: rng.uniform(0.04, 0.16),
          sus: rng.uniform(0.5, 0.9),
          rel: rng.uniform(0.06, 0.25),
          scoop: rng.uniform(0.1, 1.0),
          tau: rng.uniform(0.01, 0.035),
          lo: rng.uniform(1.4, 2.4),
          hi: tb.bright * rng.uniform(0.7, 1.3),
          cfall: rng.uniform(0.05, 0.2),
          csus: rng.uniform(0.3, 0.7),
        });
        mixAt(out, note.buf, secs(stagger * (voices * rng.uniform(0.5, 1.5))), rng.uniform(0.7, 1.0));
        voices++;
      }
    }
    if (dr > 1.3) drive(out, dr);
    const trem = rng.uniform(0, 0.2);
    if (trem > 0.06) amMod(out, rng.uniform(3.5, 7.0), trem, rng.random());
    tags = {
      style: 'ensemble',
      stack: stack.name,
      voice: tb.name,
      blend: spread > 20 ? 'ragged' : spread > 11 ? 'wide' : 'tight',
      voices,
      cents: r1(spread),
      note: noteName(m),
    };
  } else if (style === 'staccato') {
    // Section chops: two to six short hits on a grid, accented on the first,
    // occasionally kicking up to the fifth or the octave.
    const tb = rng.choice(TIMBRES);
    const m = clampM(rng.randint(tb.lo, Math.max(tb.lo, Math.min(tb.hi, HI_M - 12))));
    const hits = rng.randint(2, 6);
    let step = 60.0 / rng.randint(92, 182) / 2.0;
    const gate = rng.uniform(0.3, 0.72);
    const swing = rng.random() < 0.3 ? rng.uniform(0.08, 0.2) : 0;
    if (step * (hits - 1) > 1.2) step = 1.2 / Math.max(1, hits - 1);
    const noteDur = Math.min(0.24, Math.max(0.05, step * gate));
    const spread = rng.uniform(2, 16);
    const dr = rng.uniform(1.2, 3.0);
    out = [];
    let at = 0.0;
    for (let k = 0; k < hits; k++) {
      const jump = k === 0 ? 0 : rng.choice([0, 0, 0, 7, 12, -5]);
      const note = brassNote(rng, tb, clampM(m + jump), noteDur, {
        spread,
        atk: rng.uniform(0.002, 0.006),
        dec: rng.uniform(0.015, 0.05),
        sus: rng.uniform(0.2, 0.5),
        rel: Math.min(noteDur * 0.5, rng.uniform(0.02, 0.06)),
        scoop: rng.uniform(0.3, 1.4),
        tau: rng.uniform(0.004, 0.012),
        lo: rng.uniform(1.8, 3.0),
        hi: tb.bright * rng.uniform(0.8, 1.4),
        catk: rng.uniform(0.003, 0.012),
        cfall: rng.uniform(0.02, 0.07),
        csus: rng.uniform(0.2, 0.5),
        drive: dr,
      });
      mixAt(out, note.buf, secs(at), k === 0 ? 1.0 : rng.uniform(0.62, 0.95));
      at += step + (swing && k % 2 === 0 ? step * swing : 0);
    }
    tags = {
      style: 'staccato',
      hits,
      feel: swing ? 'swung' : gate < 0.45 ? 'clipped' : dr > 2.4 ? 'punchy' : 'straight',
      voice: tb.name,
      bpm: Math.round(60.0 / (step * 2.0)),
      note: noteName(m),
    };
  } else if (style === 'growl') {
    // Flutter tongue: a fast amplitude tear plus breath through the bell, then
    // driven hard enough that the tear becomes part of the timbre.
    const tb = rng.choice(TIMBRES);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const f = midi(m);
    const dur = rng.uniform(0.3, 1.25);
    const n = secs(dur);
    const parts = partsFor(rng, tb, { spread: rng.uniform(2, 14) });
    const env = shaped(dur, rng.uniform(0.004, 0.03), rng.uniform(0.03, 0.12),
      rng.uniform(0.55, 0.95), Math.min(dur * 0.5, rng.uniform(0.05, 0.2)));
    out = stackTone(n, () => f, parts, env);
    const flutter = rng.uniform(18, 52);
    const depth = rng.uniform(0.35, 0.9);
    amMod(out, flutter, depth, rng.random());
    const hiHz = Math.max(400, Math.min(NYQ, f * tb.bright * rng.uniform(0.8, 1.5)));
    lowpass(out, sweepCut(Math.max(200, f * 1.6), hiHz, rng.uniform(0.01, 0.05),
      rng.uniform(0.06, 0.25), rng.uniform(0.4, 0.8)));
    const dr = rng.uniform(1.8, 5.5);
    drive(out, dr);
    const air = rng.uniform(0.02, 0.22);
    mixAt(out, noiseLayer(rng, n, rng.randint(2, 7), Math.min(NYQ, f * 6.0),
      (t) => Math.min(1.0, t / 0.02) * (dur - t > 0.05 ? 1.0 : Math.max(0.0, (dur - t) / 0.05))), 0, air);
    tags = {
      style: 'growl',
      grit: dr > 4.0 ? 'torn' : dr > 2.8 ? 'snarling' : 'raspy',
      voice: tb.name,
      air: air > 0.12 ? 'breathy' : 'dry',
      flutter_hz: r1(flutter),
      note: noteName(m),
    };
  } else if (style === 'shake') {
    // The lip trill: the pitch rocks between the note and its neighbour, the
    // width growing as the player leans into it.
    const tb = rng.choice(TIMBRES);
    const iv = rng.choice([1, 2, 2, 3]);
    const m = clampM(rng.randint(tb.lo, Math.max(tb.lo, tb.hi - iv)));
    const f = midi(m);
    const dur = rng.uniform(0.3, 1.3);
    const n = secs(dur);
    const rate = rng.uniform(4.5, 14.0);
    const hard = rng.random() < 0.4; // squared-off rock, not a smooth vibrato
    const grow = rng.uniform(0.05, 0.5) * dur;
    const parts = partsFor(rng, tb, { spread: rng.uniform(0, 8) });
    const env = shaped(dur, rng.uniform(0.004, 0.02), rng.uniform(0.03, 0.12),
      rng.uniform(0.55, 0.95), Math.min(dur * 0.5, rng.uniform(0.05, 0.2)));
    out = stackTone(n, (t) => {
      const lfo = 0.5 - 0.5 * Math.cos(2 * Math.PI * rate * t);
      const shp = hard ? (lfo > 0.5 ? 1.0 : 0.0) : lfo;
      return f * semis(iv * shp * Math.min(1.0, t / Math.max(1e-4, grow)));
    }, parts, env);
    const hiHz = Math.max(400, Math.min(NYQ, f * tb.bright * rng.uniform(0.8, 1.4)));
    lowpass(out, sweepCut(Math.max(200, f * 1.8), hiHz, rng.uniform(0.008, 0.04),
      rng.uniform(0.05, 0.2), rng.uniform(0.4, 0.85)));
    const dr = rng.uniform(1.0, 2.8);
    if (dr > 1.3) drive(out, dr);
    tags = {
      style: 'shake',
      interval: iv === 1 ? 'semitone' : iv === 2 ? 'whole-tone' : 'minor-third',
      voice: tb.name,
      width: hard ? 'wild' : rate > 9.5 ? 'fast' : 'tight',
      rate_hz: r1(rate),
      note: noteName(m),
    };
  } else if (style === 'wah') {
    // Plunger over the bell: the cutoff itself is the performance, sweeping
    // closed-to-open one to three times across the note.
    const tb = rng.choice(TIMBRES);
    const mute = rng.choice(['plunger', 'wah-wah', 'hand-over-bell']);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const f = midi(m);
    const dur = rng.uniform(0.3, 1.3);
    const n = secs(dur);
    const sweeps = rng.randint(1, 3);
    const parts = partsFor(rng, tb, { spread: rng.uniform(0, 7), duty: rng.choice([0.5, 0.33, 0.25]) });
    const env = shaped(dur, rng.uniform(0.004, 0.025), rng.uniform(0.03, 0.12),
      rng.uniform(0.55, 0.95), Math.min(dur * 0.5, rng.uniform(0.05, 0.2)));
    out = stackTone(n, () => f, parts, env);
    const hiHz = Math.max(500, Math.min(NYQ, f * tb.bright * rng.uniform(0.9, 1.6)));
    const loHz = Math.max(180, f * rng.uniform(1.1, 1.9));
    const phase0 = rng.random() < 0.5 ? 0 : 0.5;
    const shp = rng.uniform(0.7, 2.2); // how long it sits closed
    lowpass(out, (t) => {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (sweeps * (t / dur) + phase0));
      return loHz + (hiHz - loHz) * Math.pow(w, shp);
    });
    highpass(out, Math.max(90, f * rng.uniform(0.4, 1.1)));
    const dr = rng.uniform(1.0, 2.6);
    if (dr > 1.3) drive(out, dr);
    tags = {
      style: 'wah',
      mute,
      sweeps,
      voice: tb.name,
      throw: shp > 1.6 ? 'deep' : hiHz / loHz > 6 ? 'wide' : 'tight',
      cut_hz: Math.round(hiHz),
      note: noteName(m),
    };
  } else {
    // stab — the default and the workhorse: one hard accent, lipped into pitch
    // from just underneath, the filter snapping open and closing behind it.
    const tb = rng.choice(TIMBRES);
    const m = clampM(rng.randint(tb.lo, tb.hi));
    const dur = rng.uniform(0.17, 0.5);
    const hard = rng.random() < 0.45;
    const tongued = !hard && rng.random() < 0.5;
    const scoop = rng.random() < 0.6 ? rng.uniform(0.4, 2.4) : 0;
    const dr = rng.uniform(1.0, 3.6);
    const note = brassNote(rng, tb, m, dur, {
      spread: rng.uniform(0, 8),
      atk: hard ? rng.uniform(0.0015, 0.006) : rng.uniform(0.008, 0.03),
      dec: rng.uniform(0.025, 0.11),
      sus: rng.uniform(0.22, 0.62),
      rel: Math.min(dur * 0.55, rng.uniform(0.04, 0.16)),
      scoop,
      tau: rng.uniform(0.006, 0.028),
      lo: rng.uniform(1.3, 2.6),
      hi: tb.bright * rng.uniform(0.7, 1.6),
      catk: rng.uniform(0.004, 0.025),
      cfall: rng.uniform(0.03, 0.14),
      csus: rng.uniform(0.2, 0.5),
      drive: dr,
    });
    out = note.buf;
    const chiff = rng.uniform(0.0, 0.25);
    if (chiff > 0.05) {
      mixAt(out, noiseLayer(rng, Math.min(out.length, secs(rng.uniform(0.006, 0.03))),
        rng.randint(1, 4), Math.min(NYQ, midi(m) * 7.0),
        burstEnv(0.001, rng.uniform(60, 400))), 0, chiff);
    }
    tags = {
      style: 'stab',
      voice: tb.name,
      attack: hard ? 'hard' : tongued ? 'tongued' : 'lipped',
      bite: dr > 2.6 ? 'overblown' : dr > 1.7 ? 'edgy' : 'clean',
      scoop_cents: Math.round(scoop * 100),
      cut_hz: Math.round(note.hiHz),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every horn inside 0.16 - 1.48 s, block the narrow-duty stack's DC
  // bias, then de-click both edges before normalizing, so the peak is exact
  // even when the loudest sample sits inside the first millisecond.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  while (out.length < MIN_N) out.push(0.0);
  const fi = Math.min(out.length >> 2, 14);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.005 * SR), Math.round(0.02 * out.length)));
  dcBlock(out, 0.997);
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C3';
  const voice = t.voice || 'trumpet';
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  const dec = (v, d) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : d.toFixed(1));
  switch (t.style) {
    case 'fanfare':
      return `brass fanfare — ${t.pattern || 'fifth call'}, ${t.feel || 'straight'} ${voice}, ${num(t.bpm)} BPM from ${note}`;
    case 'swell':
      return `brass crescendo — ${t.rise || 'slow'} rise into ${t.peak || 'warm'} ${voice}, ${num(t.cut_hz)} Hz on ${note}`;
    case 'harmon':
      return `${t.mute || 'harmon'}-muted brass — ${t.buzz || 'nasal'} buzz, ${num(t.duty_pct)}% duty, ${dec(t.wobble_hz, 30)} Hz on ${note}`;
    case 'fall':
      return `brass ${t.direction || 'fall-off'} — ${t.speed || 'lazy'} ${dec(t.semis, 8)}-semitone slide, ${voice} on ${note}`;
    case 'ensemble':
      return `brass section — ${t.stack || 'unison'}, ${num(t.voices)} ${t.blend || 'tight'} ${voice}s ${dec(t.cents, 12)} cents apart on ${note}`;
    case 'staccato':
      return `staccato brass — ${num(t.hits)} ${t.feel || 'straight'} ${voice} hits at ${num(t.bpm)} BPM on ${note}`;
    case 'growl':
      return `growled brass — ${t.grit || 'raspy'} ${voice}, ${t.air || 'dry'} flutter at ${dec(t.flutter_hz, 30)} Hz on ${note}`;
    case 'shake':
      return `brass shake — ${t.interval || 'whole-tone'} lip trill at ${dec(t.rate_hz, 8)} Hz, ${t.width || 'tight'} ${voice} on ${note}`;
    case 'wah': {
      const n = num(t.sweeps);
      return `${t.mute || 'plunger'} brass — ${n} wah sweep${n === 1 ? '' : 's'}, ${t.throw || 'wide'} throw, ${num(t.cut_hz)} Hz on ${note}`;
    }
    default:
      return `brass stab — ${t.attack || 'hard'} ${voice}, ${t.bite || 'clean'} bite, ${num(t.cut_hz)} Hz on ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'chip brass stabs, fanfares, swells, muted buzz, section falls';
