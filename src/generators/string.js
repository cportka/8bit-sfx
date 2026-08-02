// string — bowed and plucked chip strings, eleven ways. A string section is not
// one sound, it is a *gesture*: the same note is a different instrument
// depending on where the bow sits, how fast it moves and whether it ever stops.
// So every variation here is built from the bow's vocabulary — a swell that
// leans in, a stroke that stops dead, a tremolo shivering at the tip, a
// pizzicato snapped off the fingerboard, a whole desk of players who never
// quite agree on the pitch.
//
// Every voice is an exact MIDI note between C2 and C5, so a swell sits in tune
// under a lead, over the bass, inside a chord — and each variation records its
// PITCH, because a musician picks a string line by the note it plays.
//
// The eleven sub-styles are the section's working vocabulary: a sustained bowed
// swell, a dry staccato stroke, tremolo bowing, orchestral pizzicato (with the
// Bartok snap), a detuned multi-desk ensemble, glassy sul ponticello, a slow
// crescendo from nothing, bouncing spiccato, a portamento legato slur, a
// touched flageolet harmonic, and a hard-accented marcato attack.
//
// The instrument is a caricature, not a sample: naive sawtooth and square for
// the bowed spectrum (a bowed string *is* a sawtooth — Helmholtz motion), a
// triangle for the harmonic ranks, LFSR noise for rosin scrape and fingerboard
// thock, hand-rolled one-pole filters for the body, tanh for bow pressure, and
// sample-and-hold crush where the bow is digging in. Post chain is uniform — DC
// block (narrow-duty squares carry a bias), de-click both edges, then normalize
// last so the peak is exact even when the loudest sample sits inside the first
// millisecond.

import {
  SR, Lfsr, square, triangle, midi, noteName, renderTone, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.2 * SR);
const MAX_N = Math.round(2.0 * SR);

const LO_M = 36; // C2 — the cello/bass end of this category
const HI_M = 72; // C5 — the top of a comfortable violin position

const NYQ = SR * 0.45; // ranks above this are dropped rather than aliased

/** Seconds to a sample count, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

/** One-pole coefficient for a cutoff in Hz. */
function alphaOf(cut) {
  return 1.0 - Math.exp((-2.0 * Math.PI * Math.max(20, Math.min(NYQ, cut))) / SR);
}

/** "12.5% duty" / "25% duty" / "sawtooth". */
function toneLabel(wave, duty) {
  return wave === 'tri' ? 'triangle' : wave === 'saw' ? 'sawtooth' : `${duty * 100}% duty`;
}

/** Cutoff source: a constant or a function of t. */
function cutoffReader(cutoff) {
  return typeof cutoff === 'function' ? (i) => cutoff(i / SR) : () => cutoff;
}

/** One-pole lowpass in place — the instrument body, cutoff in Hz or f(t). */
function lowpass(buf, cutoff) {
  const fc = cutoffReader(cutoff);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += alphaOf(fc(i)) * (buf[i] - p);
    buf[i] = p;
  }
  return buf;
}

/** One-pole highpass in place — thins the box out without touching the pitch. */
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

/** Soft saturation — bow pressure, normalized so the level does not jump. */
function drive(buf, amount) {
  const k = Math.max(1e-3, amount);
  const norm = 1.0 / Math.tanh(k);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * k) * norm;
  return buf;
}

/**
 * Bow envelope: the hair grabs over `atk`, settles to `sus` across `dec`, holds,
 * then the release taper guarantees the note reaches zero at `dur` however hard
 * the bow is still pulling.
 */
function bowEnv(atk, dec, sus, dur, rel) {
  const a = Math.max(1e-4, atk);
  const d = Math.max(1e-4, dec);
  const r = Math.max(1e-4, rel);
  return (t) => {
    let v;
    if (t < a) v = t / a;
    else if (t < a + d) v = 1.0 - (1.0 - sus) * ((t - a) / d);
    else v = sus;
    const left = dur - t;
    if (left < r) v *= Math.max(0.0, left / r);
    return v;
  };
}

/** Plucked envelope — pizzicato and the marcato bite: attack, exp decay, taper. */
function pluckEnv(atk, rate, dur, rel) {
  const a = Math.max(1e-4, atk);
  const r = Math.max(1e-4, rel);
  return (t) => {
    let v = t < a ? t / a : Math.exp(-rate * (t - a));
    const left = dur - t;
    if (left < r) v *= Math.max(0.0, left / r);
    return v;
  };
}

/** Vibrato that fades in — the hand only starts rocking once the note speaks. */
function vibratoFn(baseFn, cents, hz, onset, phase) {
  const on = Math.max(1e-3, onset);
  const k = cents / 1200.0;
  if (cents < 0.5) return baseFn;
  return (t) => baseFn(t)
    * Math.pow(2.0, k * Math.min(1.0, t / on) * Math.sin(2.0 * Math.PI * hz * t + phase));
}

/**
 * Portamento across a short list of breakpoints — the finger sliding into the
 * next stop. Each breakpoint smoothsteps in over `glide` seconds.
 */
function glideFn(f0, pts, glide) {
  const g = Math.max(1e-3, glide);
  return (t) => {
    let semi = pts[0].semi;
    for (let i = 1; i < pts.length; i++) {
      const x = Math.min(1.0, Math.max(0.0, (t - pts[i].t) / g));
      semi += (pts[i].semi - semi) * (x * x * (3.0 - 2.0 * x));
    }
    return f0 * Math.pow(2.0, semi / 12.0);
  };
}

/** Rosin scrape: LFSR noise band-limited by a one-pole pair, shaped by envFn. */
function bowNoise(rng, n, period, lo, hi, envFn) {
  const lf = new Lfsr(rng, period);
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

/** Mix a harmonic rank in, unless it would alias. */
function addRank(out, n, freqFn, mult, gain, envFn, wave, duty, f0) {
  if (f0 * mult > NYQ || gain < 0.01) return;
  mixAt(out, renderTone(n, (t) => freqFn(t) * mult, duty, envFn, wave), 0, gain);
}

const INTERVALS = {
  1: 'minor 2nd', 2: 'major 2nd', 3: 'minor 3rd', 4: 'major 3rd', 5: 'fourth',
  6: 'tritone', 7: 'fifth', 8: 'minor 6th', 9: 'major 6th', 10: 'minor 7th',
  11: 'major 7th', 12: 'octave',
};

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'sustain', 'staccato', 'tremolo', 'pizz', 'ensemble', 'ponticello',
    'crescendo', 'spiccato', 'legato', 'harmonic', 'marcato',
  ]);

  let out;
  let tags;

  if (style === 'sustain') {
    // Bowed swell: the plain sustained note the whole category is measured
    // against — Helmholtz sawtooth, two harmonic ranks, vibrato blooming in
    // after the hair grabs, and the body opening as the bow settles.
    const m = rng.randint(LO_M, HI_M);
    const f = midi(m);
    const dur = rng.uniform(0.6, 2.0);
    const n = secs(dur);
    const atk = rng.uniform(0.03, 0.17);
    const sus = rng.uniform(0.58, 0.95);
    const vibCents = rng.uniform(0.0, 40.0);
    const vibHz = rng.uniform(4.0, 7.4);
    const freqFn = vibratoFn(() => f, vibCents, vibHz, rng.uniform(0.1, 0.5), rng.uniform(0, 6.283));
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    const env = bowEnv(atk, rng.uniform(0.05, 0.25), sus, dur, Math.max(0.06, dur * 0.22));
    out = renderTone(n, freqFn, duty, env, wave);
    addRank(out, n, freqFn, 2, rng.uniform(0.16, 0.46), env, 'tri', 0.5, f);
    const rosy = rng.random() < 0.6;
    if (rosy) addRank(out, n, freqFn, 3, rng.uniform(0.07, 0.24), env, 'tri', 0.5, f);
    const scrape = rng.uniform(0.03, 0.16);
    const stau = rng.uniform(0.02, 0.09);
    mixAt(out, bowNoise(rng, n, rng.randint(1, 3), f * 1.5, Math.min(NYQ, f * 9.0),
      (t) => (0.28 + Math.exp(-t / stau)) * env(t)), 0, scrape);
    const cut = Math.min(NYQ, f * rng.uniform(4.0, 12.0));
    const open = Math.max(0.04, atk + 0.06);
    lowpass(out, (t) => cut * (0.5 + 0.5 * Math.min(1.0, t / open)));
    tags = {
      style: 'sustain',
      bow: sus > 0.8 ? 'steady pressure' : 'breathing',
      vibrato: vibCents < 8 ? 'senza vibrato' : vibCents > 25 ? 'wide vibrato' : 'gentle vibrato',
      color: rosy ? 'reedy' : 'warm',
      vib_hz: Math.round(vibHz * 10) / 10,
      note: noteName(m),
    };
  } else if (style === 'staccato') {
    // Staccato: the bow bites, speaks and stops. One to three strokes, dry as
    // a board, with the rosin transient carrying most of the character.
    const m = rng.randint(LO_M, HI_M);
    const f = midi(m);
    const pat = rng.choice([
      { name: 'down-bow', offs: [0, 0, 0] },
      { name: 'down-bow', offs: [0, 0, 0] },
      { name: 'alternating bow', offs: [0, 0, 0] },
      { name: 'walking pair', offs: [0, 7, 12] },
      { name: 'falling pair', offs: [0, -5, -12] },
    ]);
    const strokes = pat.name === 'down-bow' ? rng.randint(1, 2) : rng.randint(2, 3);
    const atkMs = rng.uniform(4.0, 17.0);
    const strokeDur = rng.uniform(0.11, 0.24);
    const gap = rng.uniform(strokeDur * 0.85, 0.3);
    const rate = rng.uniform(9.0, 24.0);
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const bite = rng.uniform(0.08, 0.34);
    const cut = Math.min(NYQ, f * rng.uniform(5.0, 14.0));
    out = [];
    for (let k = 0; k < strokes; k++) {
      const at = k * gap;
      if (at + strokeDur > 1.98) break;
      const mk = Math.max(24, Math.min(84, m + pat.offs[Math.min(k, 2)]));
      const fk = midi(mk);
      const sn = secs(strokeDur);
      const env = pluckEnv(atkMs / 1000, rate, strokeDur, Math.max(0.02, strokeDur * 0.3));
      const v = renderTone(sn, () => fk, duty, env, wave);
      addRank(v, sn, () => fk, 2, rng.uniform(0.14, 0.4), env, 'tri', 0.5, fk);
      mixAt(v, bowNoise(rng, Math.min(sn, secs(0.03)), rng.randint(1, 3), fk * 2.0,
        Math.min(NYQ, fk * 11.0), pluckEnv(0.0008, rng.uniform(60, 190), 0.03, 0.006)), 0, bite);
      mixAt(out, v, secs(at), k === 0 ? 1.0 : rng.uniform(0.62, 1.0));
    }
    lowpass(out, cut);
    tags = {
      style: 'staccato',
      bowing: pat.name,
      attack: atkMs < 9 ? 'crisp' : 'brushed',
      tone: toneLabel(wave, duty),
      strokes,
      attack_ms: Math.round(atkMs),
      note: noteName(m),
    };
  } else if (style === 'tremolo') {
    // Tremolo bowing: the same note re-attacked seven to seventeen times a
    // second at the tip of the bow. The shiver is amplitude, not pitch.
    const m = rng.randint(LO_M, HI_M);
    const f = midi(m);
    const dur = rng.uniform(0.45, 2.0);
    const n = secs(dur);
    const strokeHz = rng.uniform(7.0, 17.0);
    const depth = rng.uniform(0.5, 1.0);
    const sharp = rng.uniform(2.0, 7.5);
    const ramp = Math.min(0.45, 0.0018 * strokeHz);
    const base = bowEnv(rng.uniform(0.008, 0.05), rng.uniform(0.05, 0.2),
      rng.uniform(0.65, 0.95), dur, Math.max(0.05, dur * 0.2));
    const strokeAmp = (t) => {
      const ph = (t * strokeHz) % 1.0;
      const a = ph < ramp ? ph / ramp : Math.exp(-sharp * (ph - ramp));
      return 1.0 - depth + depth * a;
    };
    const env = (t) => base(t) * strokeAmp(t);
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    out = renderTone(n, () => f, duty, env, wave);
    addRank(out, n, () => f, 2, rng.uniform(0.14, 0.42), env, 'tri', 0.5, f);
    const tasto = rng.random() < 0.45;
    if (!tasto) addRank(out, n, () => f, 3, rng.uniform(0.08, 0.26), env, 'tri', 0.5, f);
    const scrape = rng.uniform(0.06, 0.24);
    mixAt(out, bowNoise(rng, n, rng.randint(1, 3), f * 2.0, Math.min(NYQ, f * 10.0), env), 0, scrape);
    const cut = Math.min(NYQ, f * (tasto ? rng.uniform(3.0, 6.0) : rng.uniform(6.0, 14.0)));
    lowpass(out, cut);
    tags = {
      style: 'tremolo',
      pressure: depth > 0.8 ? 'hard-pressed' : 'feathered',
      position: tasto ? 'sul tasto' : 'ordinario',
      grain: scrape > 0.15 ? 'rosin-heavy' : 'clean',
      stroke_hz: Math.round(strokeHz * 10) / 10,
      note: noteName(m),
    };
  } else if (style === 'pizz') {
    // Pizzicato: plucked off the fingerboard, damped almost immediately. A
    // section pizz smears its desks by a few milliseconds; a Bartok snap
    // slaps the string back onto the wood.
    const m = rng.randint(LO_M, HI_M);
    const f = midi(m);
    const dur = rng.uniform(0.2, 0.62);
    const n = secs(dur);
    const rate = rng.uniform(7.0, 24.0);
    const bartok = rng.random() < 0.3;
    const spread = rng.uniform(0.0, 0.014);
    const section = spread > 0.005;
    const rel = Math.max(0.02, dur * 0.28);
    const env = pluckEnv(0.0012, rate, dur, rel);
    const one = renderTone(n, () => f, 0.5, env, 'tri');
    addRank(one, n, () => f, 2, rng.uniform(0.2, 0.55),
      pluckEnv(0.0009, rate * rng.uniform(1.3, 2.1), dur, rel), 'tri', 0.5, f);
    addRank(one, n, () => f, 3, rng.uniform(0.06, 0.24),
      pluckEnv(0.0007, rate * rng.uniform(1.8, 3.0), dur, rel), 'tri', 0.5, f);
    const boxHz = f * rng.uniform(1.6, 4.4);
    mixAt(one, bowNoise(rng, Math.min(n, secs(0.02)), rng.randint(1, 4), f * 0.8,
      Math.min(NYQ, boxHz * 2.4), pluckEnv(0.0006, rng.uniform(160, 460), 0.02, 0.004)),
    0, rng.uniform(0.1, 0.36));
    out = [];
    mixAt(out, one, 0, 1.0);
    if (section) {
      mixAt(out, one, secs(spread), rng.uniform(0.5, 0.85));
      mixAt(out, one, secs(spread * 1.9), rng.uniform(0.3, 0.65));
    }
    if (bartok) {
      const sn = Math.min(n, secs(0.03));
      const slap = bowNoise(rng, sn, 1, f * 2.0, Math.min(NYQ, f * 16.0),
        pluckEnv(0.0004, rng.uniform(120, 320), 0.03, 0.006));
      crush(slap, rng.randint(2, 6), rng.randint(1, 4));
      mixAt(out, slap, 0, rng.uniform(0.3, 0.7));
    }
    highpass(out, f * 0.45);
    lowpass(out, Math.min(NYQ, f * rng.uniform(5.0, 13.0)));
    tags = {
      style: 'pizz',
      snap: bartok ? 'bartok snap' : 'finger pluck',
      voicing: section ? 'section spread' : 'solo desk',
      damp: rate > 16 ? 'choked' : 'ringing',
      body_hz: Math.round(boxHz),
      note: noteName(m),
    };
  } else if (style === 'ensemble') {
    // Detuned ensemble: three to six desks on the same note, none of them
    // agreeing about the pitch, each drifting on its own slow cycle. The
    // beating between them is the entire sound of a string section.
    const m = rng.randint(LO_M, Math.min(HI_M, 69));
    const f = midi(m);
    const dur = rng.uniform(0.7, 2.0);
    const n = secs(dur);
    const players = rng.randint(3, 6);
    const spread = rng.uniform(4.0, 34.0);
    const atk = rng.uniform(0.04, 0.2);
    const divisi = rng.random() < 0.35;
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    const rel = Math.max(0.07, dur * 0.24);
    out = [];
    for (let k = 0; k < players; k++) {
      const cents = spread * ((k / Math.max(1, players - 1)) - 0.5);
      const driftHz = rng.uniform(0.25, 1.6);
      const driftC = rng.uniform(1.5, 7.0);
      const ph = rng.uniform(0, 6.283);
      const fk = (divisi && k === players - 1 ? f * 0.5 : f) * Math.pow(2.0, cents / 1200.0);
      const freqFn = vibratoFn(() => fk, driftC, driftHz, rng.uniform(0.05, 0.3), ph);
      const env = bowEnv(atk * rng.uniform(0.8, 1.35), rng.uniform(0.06, 0.3),
        rng.uniform(0.62, 0.95), dur, rel);
      const v = renderTone(n, freqFn, duty, env, wave);
      addRank(v, n, freqFn, 2, rng.uniform(0.12, 0.34), env, 'tri', 0.5, fk);
      mixAt(out, v, secs(rng.uniform(0.0, 0.012)), rng.uniform(0.6, 1.0) / Math.sqrt(players));
    }
    const scrape = rng.uniform(0.02, 0.1);
    mixAt(out, bowNoise(rng, n, rng.randint(2, 5), f * 1.2, Math.min(NYQ, f * 7.0),
      bowEnv(atk, 0.15, 0.5, dur, rel)), 0, scrape);
    lowpass(out, Math.min(NYQ, f * rng.uniform(4.0, 11.0)));
    tags = {
      style: 'ensemble',
      blend: spread > 18 ? 'sour' : 'lush',
      voicing: divisi ? 'divisi octaves' : 'unison',
      entry: atk > 0.11 ? 'soft entry' : 'together',
      players,
      spread_cents: Math.round(spread),
      note: noteName(m),
    };
  } else if (style === 'ponticello') {
    // Sul ponticello: the bow crowds the bridge, the fundamental collapses and
    // a fistful of upper partials screams instead. Glassy, metallic, wrong in
    // exactly the right way.
    const m = rng.randint(LO_M, HI_M);
    const f = midi(m);
    const dur = rng.uniform(0.3, 1.6);
    const n = secs(dur);
    const peakK = rng.uniform(3.5, 7.5);
    const width = rng.uniform(1.1, 2.6);
    const atk = rng.uniform(0.01, 0.09);
    const env = bowEnv(atk, rng.uniform(0.05, 0.2), rng.uniform(0.6, 0.95), dur,
      Math.max(0.05, dur * 0.22));
    const rootG = rng.uniform(0.08, 0.3);
    out = renderTone(n, () => f, 0.5, env, 'tri');
    for (let i = 0; i < out.length; i++) out[i] *= rootG;
    for (let k = 2; k <= 10; k++) {
      const g = Math.exp(-Math.pow((k - peakK) / width, 2.0));
      addRank(out, n, () => f, k, g * rng.uniform(0.7, 1.0), env, k % 2 ? 'tri' : null, 0.5, f);
    }
    const ringHz = f * rng.uniform(6.0, 13.0);
    const ringD = rng.uniform(0.1, 0.42);
    let mp = 0.0;
    for (let i = 0; i < n; i++) {
      mp += ringHz / SR;
      out[i] *= 1.0 - ringD + ringD * square(mp, 0.5);
    }
    const scrape = rng.uniform(0.12, 0.4);
    mixAt(out, bowNoise(rng, n, 1, f * peakK * 0.6, Math.min(NYQ, f * peakK * 3.0), env), 0, scrape);
    const scratched = rng.random() < 0.35;
    if (scratched) crush(out, rng.randint(4, 12), rng.randint(1, 3));
    highpass(out, f * rng.uniform(1.2, 2.6));
    lowpass(out, Math.min(NYQ, f * rng.uniform(9.0, 20.0)));
    tags = {
      style: 'ponticello',
      edge: peakK > 5.5 ? 'glassy' : 'metallic',
      grain: scratched ? 'scratched' : 'smooth',
      ring: ringD > 0.26 ? 'hollow' : 'shimmering',
      edge_hz: Math.round(f * peakK),
      note: noteName(m),
    };
  } else if (style === 'crescendo') {
    // Slow crescendo: in from niente, the body opening as the bow leans in and
    // the vibrato widening with it. The cue-builder's favourite gesture.
    const m = rng.randint(LO_M, HI_M);
    const f = midi(m);
    const dur = rng.uniform(0.9, 2.0);
    const n = secs(dur);
    const peakT = dur * rng.uniform(0.6, 0.93);
    const curve = rng.uniform(1.2, 3.2);
    const rel = Math.max(0.06, dur * rng.uniform(0.1, 0.25));
    const vibCents = rng.uniform(6.0, 42.0);
    const vibHz = rng.uniform(4.2, 7.0);
    const kv = vibCents / 1200.0;
    const vph = rng.uniform(0, 6.283);
    const freqFn = (t) => f * Math.pow(2.0,
      kv * Math.min(1.0, t / peakT) * Math.sin(2.0 * Math.PI * vibHz * t + vph));
    const env = (t) => {
      let v = t < peakT ? Math.pow(t / peakT, curve) : 1.0;
      const left = dur - t;
      if (left < rel) v *= Math.max(0.0, left / rel);
      return v;
    };
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    out = renderTone(n, freqFn, duty, env, wave);
    addRank(out, n, freqFn, 2, rng.uniform(0.16, 0.44), env, 'tri', 0.5, f);
    const thick = rng.random() < 0.5;
    if (thick) addRank(out, n, freqFn, 3, rng.uniform(0.08, 0.26), env, 'tri', 0.5, f);
    mixAt(out, bowNoise(rng, n, rng.randint(1, 4), f * 1.4, Math.min(NYQ, f * 8.0), env),
      0, rng.uniform(0.03, 0.14));
    const lo = Math.min(NYQ, f * rng.uniform(1.8, 3.2));
    const open = Math.min(NYQ, f * rng.uniform(6.0, 16.0));
    lowpass(out, (t) => lo + (open - lo) * Math.min(1.0, Math.pow(t / peakT, curve * 0.7)));
    tags = {
      style: 'crescendo',
      shape: curve > 2.0 ? 'slow burn' : 'even rise',
      color: thick ? 'full-bodied' : 'thin',
      vibrato: vibCents > 24 ? 'widening' : 'narrow',
      open_hz: Math.round(open),
      note: noteName(m),
    };
  } else if (style === 'spiccato') {
    // Spiccato: the bow is thrown and allowed to bounce. Four to eight tiny
    // strokes on a grid, sometimes accelerating, sometimes climbing.
    const m = rng.randint(LO_M, Math.min(HI_M, 67));
    const f = midi(m);
    const pat = rng.choice([
      { name: 'repeated note', offs: [0, 0, 0, 0, 0, 0, 0, 0] },
      { name: 'repeated note', offs: [0, 0, 0, 0, 0, 0, 0, 0] },
      { name: 'octave leap', offs: [0, 12, 0, 12, 0, 12, 0, 12] },
      { name: 'rising arpeggio', offs: [0, 4, 7, 12, 16, 19, 24, 24] },
      { name: 'falling arpeggio', offs: [12, 7, 4, 0, -5, -8, -12, -12] },
      { name: 'neighbour figure', offs: [0, 2, 0, -1, 0, 2, 0, -1] },
    ]);
    const bounces = rng.randint(4, 8);
    const step = rng.uniform(0.075, 0.22);
    const accel = rng.uniform(0.82, 1.1);
    const swing = rng.uniform(0.0, 0.18);
    const feel = accel < 0.93 ? 'accelerating' : swing > 0.09 ? 'swung' : 'even';
    const hitDur = Math.min(step * rng.uniform(0.6, 0.95), 0.16);
    const rate = rng.uniform(14.0, 34.0);
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    const bite = rng.uniform(0.1, 0.32);
    out = [];
    let at = 0.0;
    let gap = step;
    let placed = 0;
    for (let k = 0; k < bounces; k++) {
      const off = at + (k % 2 === 1 ? swing * gap : 0.0);
      if (off + hitDur > 1.97) break;
      const mk = Math.max(24, Math.min(84, m + pat.offs[Math.min(k, 7)]));
      const fk = midi(mk);
      const hn = secs(hitDur);
      const env = pluckEnv(rng.uniform(0.003, 0.009), rate, hitDur, Math.max(0.012, hitDur * 0.35));
      const v = renderTone(hn, () => fk, duty, env, wave);
      addRank(v, hn, () => fk, 2, rng.uniform(0.12, 0.36), env, 'tri', 0.5, fk);
      mixAt(v, bowNoise(rng, Math.min(hn, secs(0.014)), rng.randint(1, 3), fk * 2.0,
        Math.min(NYQ, fk * 12.0), pluckEnv(0.0006, rng.uniform(140, 400), 0.014, 0.004)), 0, bite);
      mixAt(out, v, secs(off), k === 0 ? 1.0 : rng.uniform(0.6, 1.0));
      placed++;
      at += gap;
      gap *= accel;
    }
    lowpass(out, Math.min(NYQ, f * rng.uniform(6.0, 15.0)));
    tags = {
      style: 'spiccato',
      pattern: pat.name,
      feel,
      tone: toneLabel(wave, duty),
      bounces: placed,
      bpm: Math.round(15.0 / step), // each bounce is a sixteenth note
      note: noteName(m),
    };
  } else if (style === 'legato') {
    // Legato slur: one bow, two or three stops, the finger sliding between
    // them. The bow never lifts — only the pitch moves, and the small dip at
    // each shift is the hand travelling.
    const m = rng.randint(LO_M, Math.min(HI_M, 64));
    const f = midi(m);
    const dur = rng.uniform(0.55, 2.0);
    const n = secs(dur);
    const stepSemi = rng.choice([2, 3, 4, 5, 7, 12, -2, -3, -5, -7, -12]);
    const shape = rng.choice(['two-note slur', 'two-note slur', 'slur and back', 'three-note climb']);
    const glide = rng.uniform(0.02, 0.16);
    const pts = [{ t: 0, semi: 0 }];
    if (shape === 'slur and back') {
      pts.push({ t: dur * 0.34, semi: stepSemi }, { t: dur * 0.68, semi: 0 });
    } else if (shape === 'three-note climb') {
      pts.push({ t: dur * 0.34, semi: stepSemi }, { t: dur * 0.67, semi: stepSemi * 2 });
    } else {
      pts.push({ t: dur * rng.uniform(0.38, 0.6), semi: stepSemi });
    }
    const vibCents = rng.uniform(4.0, 34.0);
    const freqFn = vibratoFn(glideFn(f, pts, glide), vibCents, rng.uniform(4.2, 7.0),
      rng.uniform(0.08, 0.4), rng.uniform(0, 6.283));
    const dip = rng.uniform(0.1, 0.4);
    const dtau = Math.max(0.012, glide * 0.7);
    const base = bowEnv(rng.uniform(0.02, 0.1), rng.uniform(0.05, 0.2),
      rng.uniform(0.7, 0.96), dur, Math.max(0.06, dur * 0.2));
    const shifts = pts.slice(1).map((p) => p.t);
    const env = (t) => {
      let v = base(t);
      for (let i = 0; i < shifts.length; i++) {
        const x = (t - shifts[i]) / dtau;
        if (x > -3 && x < 3) v *= 1.0 - dip * Math.exp(-x * x);
      }
      return v;
    };
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    const section = rng.random() < 0.45;
    out = renderTone(n, freqFn, duty, env, wave);
    addRank(out, n, freqFn, 2, rng.uniform(0.16, 0.44), env, 'tri', 0.5, f);
    if (section) {
      const det = Math.pow(2.0, rng.uniform(5.0, 16.0) / 1200.0);
      mixAt(out, renderTone(n, (t) => freqFn(t) * det, duty, env, wave), 0, rng.uniform(0.4, 0.8));
    }
    mixAt(out, bowNoise(rng, n, rng.randint(1, 4), f * 1.4, Math.min(NYQ, f * 8.0), env),
      0, rng.uniform(0.03, 0.13));
    lowpass(out, Math.min(NYQ, f * rng.uniform(4.5, 12.0)));
    tags = {
      style: 'legato',
      voice: section ? 'section' : 'solo',
      motion: shape === 'slur and back' ? 'there and back' : stepSemi > 0 ? 'rising' : 'falling',
      interval: INTERVALS[Math.abs(stepSemi)] || 'fifth',
      glide_ms: Math.round(glide * 1000),
      note: noteName(m),
    };
  } else if (style === 'harmonic') {
    // Flageolet: the finger only touches the node, so the string speaks its
    // partial and nothing else. Almost a sine, all air and no rosin.
    const m = rng.randint(48, HI_M);
    const f = midi(m);
    const node = rng.choice(['octave', 'twelfth', 'double octave']);
    const stopped = node === 'octave' ? m - 12 : node === 'twelfth' ? m - 19 : m - 24;
    const dur = rng.uniform(0.4, 1.7);
    const n = secs(dur);
    const atk = rng.uniform(0.02, 0.12);
    const env = bowEnv(atk, rng.uniform(0.06, 0.25), rng.uniform(0.6, 0.95), dur,
      Math.max(0.06, dur * 0.25));
    const vibCents = rng.uniform(0.0, 14.0);
    const freqFn = vibratoFn(() => f, vibCents, rng.uniform(4.5, 7.2), rng.uniform(0.1, 0.5),
      rng.uniform(0, 6.283));
    out = renderTone(n, freqFn, 0.5, env, 'tri');
    const shimmer = rng.uniform(0.05, 0.22);
    addRank(out, n, freqFn, 2, shimmer, env, 'tri', 0.5, f);
    const ghost = rng.random() < 0.4;
    if (ghost) {
      mixAt(out, renderTone(n, () => midi(stopped), 0.5, env, 'tri'), 0, rng.uniform(0.04, 0.12));
    }
    const airHz = Math.min(NYQ, f * rng.uniform(1.5, 4.0));
    const air = rng.uniform(0.05, 0.2);
    mixAt(out, bowNoise(rng, n, rng.randint(1, 3), airHz * 0.6, airHz * 2.2, env), 0, air);
    lowpass(out, Math.min(NYQ, f * rng.uniform(3.0, 7.0)));
    tags = {
      style: 'harmonic',
      touch: air > 0.13 ? 'breathy' : 'glassy',
      node,
      body: ghost ? 'with the stopped ghost' : 'pure node',
      air_hz: Math.round(airHz),
      note: noteName(m),
    };
  } else {
    // Marcato: the bow lands with the full weight of the arm on it, growls for
    // a moment, then backs off into the note. The accent is the sound.
    const m = rng.randint(LO_M, HI_M);
    const f = midi(m);
    const dur = rng.uniform(0.25, 0.95);
    const n = secs(dur);
    const sus = rng.uniform(0.25, 0.6);
    const accTau = rng.uniform(0.012, 0.06);
    const atk = rng.uniform(0.003, 0.012);
    const rel = Math.max(0.03, dur * 0.26);
    const env = (t) => {
      let v = (sus + (1.0 - sus) * Math.exp(-t / accTau));
      if (t < atk) v *= t / atk;
      const left = dur - t;
      if (left < rel) v *= Math.max(0.0, left / rel);
      return v;
    };
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    out = renderTone(n, () => f, duty, env, wave);
    addRank(out, n, () => f, 2, rng.uniform(0.18, 0.5), env, 'tri', 0.5, f);
    addRank(out, n, () => f, 3, rng.uniform(0.06, 0.24), env, 'tri', 0.5, f);
    const push = rng.uniform(0.8, 3.4);
    drive(out, push);
    const biteHz = Math.min(NYQ, f * rng.uniform(3.0, 9.0));
    const biteN = Math.min(n, secs(rng.uniform(0.02, 0.06)));
    const grit = bowNoise(rng, biteN, rng.randint(1, 3), biteHz * 0.5, biteHz * 2.0,
      pluckEnv(0.0009, rng.uniform(40, 150), biteN / SR, 0.008));
    const growl = rng.random() < 0.4;
    if (growl) crush(grit, rng.randint(2, 7), rng.randint(1, 4));
    mixAt(out, grit, 0, rng.uniform(0.12, 0.4));
    lowpass(out, (t) => Math.min(NYQ, f * (3.0 + 9.0 * Math.exp(-t / (accTau * 2.0)))));
    tags = {
      style: 'marcato',
      bite: push > 2.0 ? 'growling' : 'firm',
      grain: growl ? 'crushed' : 'clean',
      tone: toneLabel(wave, duty),
      bite_hz: Math.round(biteHz),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every string inside 0.2 - 2.0 s, block the duty-cycle DC bias, then
  // de-click both edges before normalizing so the peak is exact even when the
  // loudest sample sits inside the first millisecond.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  const fi = Math.min(out.length >> 2, Math.round(0.0015 * SR));
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.006 * SR), Math.round(0.02 * out.length)));
  dcBlock(out, 0.997);
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  while (out.length < MIN_N) out.push(0.0);
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C3';
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  const dec = (v, d) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : d.toFixed(1));
  switch (t.style) {
    case 'staccato':
      return `staccato bow — ${t.bowing || 'down-bow'}, ${t.attack || 'crisp'} ${t.tone || 'sawtooth'}, ${num(t.strokes)} strokes ${num(t.attack_ms)} ms, ${note}`;
    case 'tremolo':
      return `tremolo bowing — ${t.pressure || 'feathered'} ${t.position || 'ordinario'}, ${t.grain || 'clean'}, ${dec(t.stroke_hz, 12)} Hz on ${note}`;
    case 'pizz':
      return `pizzicato string — ${t.snap || 'finger pluck'}, ${t.voicing || 'solo desk'} ${t.damp || 'ringing'}, ${num(t.body_hz)} Hz on ${note}`;
    case 'ensemble':
      return `detuned string ensemble — ${t.blend || 'lush'} ${t.voicing || 'unison'}, ${num(t.players)} desks ${num(t.spread_cents)} cents, ${note}`;
    case 'ponticello':
      return `sul ponticello string — ${t.edge || 'glassy'} ${t.grain || 'smooth'}, ${t.ring || 'shimmering'}, ${num(t.edge_hz)} Hz on ${note}`;
    case 'crescendo':
      return `string crescendo — ${t.shape || 'even rise'}, ${t.color || 'thin'} ${t.vibrato || 'narrow'} vibrato, ${num(t.open_hz)} Hz, ${note}`;
    case 'spiccato':
      return `spiccato bow — ${t.pattern || 'repeated note'}, ${t.feel || 'even'} ${num(t.bounces)} bounces at ${num(t.bpm)} BPM, ${note}`;
    case 'legato':
      return `legato string slur — ${t.voice || 'solo'} ${t.motion || 'rising'} ${t.interval || 'fifth'}, ${num(t.glide_ms)} ms shift from ${note}`;
    case 'harmonic':
      return `string harmonic — ${t.touch || 'glassy'} ${t.node || 'octave'} flageolet, ${t.body || 'pure node'}, ${num(t.air_hz)} Hz, ${note}`;
    case 'marcato':
      return `marcato bow — ${t.bite || 'firm'} ${t.grain || 'clean'} accent, ${t.tone || 'sawtooth'}, ${num(t.bite_hz)} Hz bite, ${note}`;
    default:
      return `bowed string swell — ${t.bow || 'breathing'}, ${t.color || 'warm'} ${t.vibrato || 'gentle vibrato'}, ${dec(t.vib_hz, 5)} Hz, ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'bowed swells, tremolo and spiccato bowing, pizzicato, detuned ensembles';
