// bell — pitched bells and chimes, eleven ways. A bell is the one instrument
// that is *almost* a chip sound already: a handful of loud, badly-tuned partials
// over a fundamental that keeps ringing long after the strike is gone. So every
// voice here is a stack of naive squares and triangles at deliberately
// inharmonic ratios — hum, prime, tierce, quint, nominal — each with its own
// decay, the high ones dying first exactly as metal does.
//
// Everything is a *note*: the fundamental is an exact MIDI number, so a
// glockenspiel line or a temple-bell drone drops into a track next to the bass
// and the pads without retuning. Where `pluck` attacks and lets go, these hang
// on — 0.3 s for a music-box tine, the full 2.5 s for a bronze temple bell.
//
// The eleven sub-styles are the pitched-metal vocabulary: a struck church bell
// with a beating twin, an orchestral tubular bell, a music-box comb tine, a
// felt-hammered celesta, a hard-mallet glockenspiel, a scatter of tinkling
// bells, a deep temple bell that swells before it rings, an octave-stacked
// shimmer tail, a doorbell/Westminster chime phrase, a ring-modulated crystal
// bell, and a swung handbell with its clapper thock.
//
// The acoustic instruments are caricatures, not samples: triangles stand in for
// the sine-ish partials, squares supply the clang, LFSR noise is every clapper,
// mallet and comb tick, filters are hand-rolled one-poles, and the crystal voice
// gets sample-and-hold plus a level crush. Partials past ~9.5 kHz are dropped
// rather than left to alias into mush. Post chain is uniform — DC block (narrow
// duty squares carry a bias), de-click both edges, normalize last so the peak is
// exact even when the loudest sample sits inside the first millisecond.

import {
  SR, Lfsr, square, triangle, midi, noteName, renderTone, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.3 * SR);
const MAX_N = Math.round(2.5 * SR);

/** Partials above this alias into mush at 22 kHz — drop them instead. */
const TOP_HZ = 9500;

/** Seconds to a sample count, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

/** Keep a MIDI note inside the range these voices actually sound in. */
function clampM(m) {
  return Math.max(24, Math.min(108, Math.round(m)));
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

/** One-pole highpass in place — thins a body out without touching the pitch. */
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

/**
 * Struck-partial envelope: a near-instant linear attack, an exponential ring,
 * and a release taper into the note's end so a partial that is still sounding
 * when the buffer runs out still arrives at zero.
 */
function bellEnv(atk, rate, dur, rel) {
  const a = Math.max(1e-4, atk);
  const r = Math.max(1e-4, rel);
  return (t) => {
    let v = t < a ? t / a : Math.exp(-rate * (t - a));
    const left = dur - t;
    if (left < r) v *= Math.max(0.0, left / r);
    return v;
  };
}

/** Same, but the attack is a raised cosine — a big bell blooms, it doesn't click. */
function swellEnv(atk, rate, dur, rel) {
  const a = Math.max(1e-4, atk);
  const r = Math.max(1e-4, rel);
  return (t) => {
    let v = t < a ? 0.5 - 0.5 * Math.cos((Math.PI * t) / a) : Math.exp(-rate * (t - a));
    const left = dur - t;
    if (left < r) v *= Math.max(0.0, left / r);
    return v;
  };
}

/**
 * The core of every voice here: a stack of independently-decaying partials at
 * ratios of one fundamental. Partial phases are staggered by index so eight
 * squares don't all slam +1 on sample zero and eat the whole headroom.
 *
 * @param {number} n samples
 * @param {number} f fundamental in Hz
 * @param {{r:number,g:number,atk:number,rate:number,w?:string,d?:number,rel?:number,swell?:boolean}[]} parts
 * @param {number} dur voice length in seconds (drives the release taper)
 */
function ring(n, f, parts, dur) {
  const out = new Array(n).fill(0.0);
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    const fr = f * p.r;
    if (!(fr > 12.0) || fr > TOP_HZ) continue; // inaudible or aliasing — skip it
    const rel = p.rel === undefined ? Math.max(0.02, dur * 0.18) : p.rel;
    const env = (p.swell ? swellEnv : bellEnv)(p.atk, p.rate, dur, rel);
    const duty = p.d === undefined ? 0.5 : p.d;
    const inc = fr / SR;
    let ph = (k * 0.31) % 1.0;
    for (let i = 0; i < n; i++) {
      ph += inc;
      const s = p.w === 'tri' ? triangle(ph) : square(ph, duty);
      out[i] += s * env(i / SR) * p.g;
    }
  }
  return out;
}

/** Lowpassed LFSR burst — every clapper, mallet head and comb tick. */
function tick(rng, n, period, cut, atk, rate) {
  const lf = new Lfsr(rng, period);
  const a = alphaOf(cut);
  const at = Math.max(1e-5, atk);
  const out = new Array(n);
  let p = 0.0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    p += a * (lf.next() - p);
    out[i] = p * Math.min(1.0, t / at) * Math.exp(-rate * t);
  }
  return out;
}

/** Sine tremolo in place — a rung bell swinging away from the ear. */
function tremolo(buf, hz, depth) {
  for (let i = 0; i < buf.length; i++) {
    const lfo = 0.5 + 0.5 * Math.cos(2.0 * Math.PI * hz * (i / SR));
    buf[i] *= 1.0 - depth + depth * lfo;
  }
  return buf;
}

/** Sample-and-hold amplitude drift — the unsteady glitter of a shimmer tail. */
function flutter(rng, buf, rateHz, depth) {
  const lf = new Lfsr(rng, Math.max(1, Math.round(SR / Math.max(1, rateHz))));
  const a = alphaOf(rateHz * 2.0);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += a * (lf.next() - p);
    buf[i] *= 1.0 - depth * 0.5 * (1.0 + p);
  }
  return buf;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'struck', 'tubular', 'musicbox', 'celesta', 'glock', 'tinkle',
    'temple', 'shimmer', 'chime', 'crystal', 'handbell',
  ]);

  let out;
  let tags;

  if (style === 'struck') {
    // Church/tower bell: the classic partial set — hum an octave below, prime,
    // tierce a third up, quint, nominal an octave up — plus a twin a few cents
    // off so the pair beats the way a real casting does.
    const m = rng.randint(48, 79); // C3..G5
    const f = midi(m);
    const dur = rng.uniform(0.9, 2.4);
    const n = secs(dur);
    const tierceR = rng.choice([1.19, 1.2, 1.21, 1.26]);
    const bronze = rng.random() < 0.55;
    const w = bronze ? 'tri' : null;
    const duty = rng.choice([0.5, 0.25]);
    const base = rng.uniform(1.6, 3.6);
    const parts = [
      { r: 0.5, g: rng.uniform(0.3, 0.7), atk: 0.004, rate: base * 0.45, w: 'tri' },
      { r: 1.0, g: 1.0, atk: 0.0015, rate: base, w, d: duty },
      { r: tierceR, g: rng.uniform(0.3, 0.7), atk: 0.0015, rate: base * 1.3, w: 'tri' },
      { r: 1.5, g: rng.uniform(0.15, 0.45), atk: 0.001, rate: base * 1.8, w: 'tri' },
      { r: 2.0, g: rng.uniform(0.3, 0.7), atk: 0.001, rate: base * 2.2, w, d: duty },
      { r: rng.uniform(2.45, 2.72), g: rng.uniform(0.1, 0.3), atk: 0.0008, rate: base * 3.2, w: 'tri' },
      { r: rng.uniform(2.95, 3.1), g: rng.uniform(0.06, 0.24), atk: 0.0008, rate: base * 4.0, w, d: duty },
      { r: rng.uniform(4.0, 4.3), g: rng.uniform(0.04, 0.16), atk: 0.0006, rate: base * 6.0, w: 'tri' },
    ];
    out = ring(n, f, parts, dur);
    const cents = rng.uniform(1.5, 16.0);
    const det = Math.pow(2.0, cents / 1200.0);
    const beatHz = f * (det - 1.0);
    mixAt(out, ring(n, f * det, parts, dur), 0, rng.uniform(0.5, 0.9));
    const clap = rng.uniform(0.05, 0.32);
    mixAt(out, tick(rng, Math.min(n, secs(0.02)), rng.randint(1, 4), f * rng.uniform(4.0, 10.0),
      0.0006, rng.uniform(150, 400)), 0, clap);
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(6.0, 16.0)));
    tags = {
      style: 'struck',
      metal: bronze ? 'bronze' : 'brass',
      tierce: tierceR < 1.24 ? 'minor tierce' : 'major tierce',
      clapper: clap > 0.19 ? 'hard' : 'soft',
      beat_hz: Math.round(beatHz * 100) / 100,
      note: noteName(m),
    };
  } else if (style === 'tubular') {
    // Orchestral tubular bell: a hung brass tube whose loud modes sit near 2:3:4
    // over the strike note, with a metallic clang on top of the hammer.
    const m = rng.randint(52, 76); // E3..E5
    const f = midi(m);
    const dur = rng.uniform(1.2, 2.5);
    const n = secs(dur);
    const base = rng.uniform(0.9, 2.2);
    const w = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    const nomR = 2.0 * rng.uniform(0.985, 1.015);
    const hum = rng.uniform(0.1, 0.4);
    const parts = [
      { r: 0.5, g: hum, atk: 0.006, rate: base * 0.5, w: 'tri' },
      { r: 1.0, g: rng.uniform(0.5, 0.9), atk: 0.002, rate: base * 0.8, w: 'tri' },
      { r: nomR, g: 1.0, atk: 0.0015, rate: base, w, d: duty },
      { r: 3.0 * rng.uniform(0.985, 1.015), g: rng.uniform(0.35, 0.8), atk: 0.0012, rate: base * 1.5, w: 'tri' },
      { r: 4.0 * rng.uniform(0.985, 1.015), g: rng.uniform(0.2, 0.6), atk: 0.001, rate: base * 2.1, w, d: duty },
      { r: rng.uniform(5.3, 5.6), g: rng.uniform(0.1, 0.35), atk: 0.0008, rate: base * 3.0, w: 'tri' },
      { r: rng.uniform(6.7, 6.95), g: rng.uniform(0.05, 0.2), atk: 0.0008, rate: base * 4.2, w: 'tri' },
    ];
    out = ring(n, f, parts, dur);
    const clang = rng.uniform(0.08, 0.4);
    mixAt(out, ring(Math.min(n, secs(0.35)), f * rng.uniform(4.4, 5.1),
      [{ r: 1.0, g: 1.0, atk: 0.0005, rate: rng.uniform(9.0, 22.0), w: null, d: 0.25 }],
      Math.min(dur, 0.35)), 0, clang);
    mixAt(out, tick(rng, Math.min(n, secs(0.025)), rng.randint(1, 3), f * rng.uniform(5.0, 12.0),
      0.0005, rng.uniform(120, 320)), 0, rng.uniform(0.06, 0.28));
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(7.0, 18.0)));
    tags = {
      style: 'tubular',
      tube: hum > 0.25 ? 'heavy' : 'thin',
      clang: clang > 0.24 ? 'ringing' : 'muted',
      hammer: w === 'tri' ? 'rawhide' : 'hard',
      nominal_hz: Math.round(f * nomR),
      note: noteName(m),
    };
  } else if (style === 'musicbox') {
    // Music-box comb: a plucked steel tine, nearly pure, with one high
    // inharmonic ping and the cylinder pin's tick — often a two or three note
    // fragment, because a music box never plays just one.
    const m = rng.randint(72, 96); // C5..C7
    const f = midi(m);
    const pat = rng.choice([
      { name: 'single tine', offs: [0] },
      { name: 'single tine', offs: [0] },
      { name: 'rising third', offs: [0, 4] },
      { name: 'rising fifth', offs: [0, 7] },
      { name: 'octave lift', offs: [0, 12] },
      { name: 'triplet run', offs: [0, 4, 7] },
      { name: 'falling turn', offs: [0, -2, -5] },
    ]);
    const step = rng.uniform(0.09, 0.22);
    const noteDur = rng.uniform(0.3, 0.8);
    const base = rng.uniform(5.0, 13.0);
    // The tine's inharmonic ping, pulled down under the alias ceiling on the
    // top octaves so a C7 tine still pings instead of losing the partial.
    const pingR = Math.min(rng.uniform(5.0, 6.4), (TOP_HZ / f) * rng.uniform(0.85, 1.0));
    const comb = rng.uniform(0.05, 0.3);
    out = [];
    for (let k = 0; k < pat.offs.length; k++) {
      const mk = clampM(m + pat.offs[k]);
      const fk = midi(mk);
      const d = k === pat.offs.length - 1 ? noteDur * rng.uniform(1.0, 1.5) : noteDur;
      const hn = secs(d);
      const v = ring(hn, fk, [
        { r: 1.0, g: 1.0, atk: 0.0012, rate: base, w: 'tri' },
        { r: rng.uniform(1.98, 2.04), g: rng.uniform(0.06, 0.22), atk: 0.001, rate: base * 2.0, w: 'tri' },
        { r: pingR, g: rng.uniform(0.05, 0.2), atk: 0.0006, rate: base * 3.0, w: 'tri' },
      ], d);
      mixAt(v, tick(rng, Math.min(hn, secs(0.005)), 1, fk * rng.uniform(3.0, 7.0),
        0.0003, rng.uniform(500, 1200)), 0, comb);
      mixAt(out, v, secs(step * k), k === 0 ? 1.0 : rng.uniform(0.6, 1.0));
    }
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(4.0, 9.0)));
    tags = {
      style: 'musicbox',
      comb: comb > 0.18 ? 'brass' : 'steel',
      phrase: pat.name,
      touch: base > 9.0 ? 'clipped' : 'ringing',
      ping_hz: Math.round(f * pingR),
      note: noteName(m),
    };
  } else if (style === 'celesta') {
    // Celesta: felt hammers on steel bars over wooden resonator boxes. The
    // softest voice here — no clang at all, just a rounded ping and a warm hum.
    const m = rng.randint(60, 88); // C4..E6
    const f = midi(m);
    const dur = rng.uniform(0.5, 1.4);
    const n = secs(dur);
    const atk = rng.uniform(0.004, 0.014);
    const base = rng.uniform(2.5, 6.0);
    const boxG = rng.uniform(0.05, 0.24);
    out = ring(n, f, [
      { r: 0.5, g: boxG, atk: atk * 1.6, rate: base * 0.7, w: 'tri' },
      { r: 1.0, g: 1.0, atk, rate: base, w: 'tri' },
      { r: rng.uniform(1.99, 2.03), g: rng.uniform(0.1, 0.35), atk: atk * 0.8, rate: base * 1.8, w: 'tri' },
      { r: rng.uniform(3.9, 4.15), g: rng.uniform(0.15, 0.45), atk: atk * 0.6, rate: base * 2.6, w: 'tri' },
      { r: rng.uniform(5.3, 5.6), g: rng.uniform(0.03, 0.14), atk: 0.001, rate: base * 4.0, w: null, d: 0.25 },
    ], dur);
    mixAt(out, tick(rng, Math.min(n, secs(0.02)), rng.randint(3, 8), f * rng.uniform(1.2, 3.0),
      0.0015, rng.uniform(90, 260)), 0, rng.uniform(0.04, 0.18));
    const warm = Math.min(SR * 0.4, f * rng.uniform(3.0, 8.0));
    lowpass(out, warm);
    tags = {
      style: 'celesta',
      hammer: atk > 0.009 ? 'felt' : 'leather',
      box: boxG > 0.14 ? 'boxy' : 'open',
      ring: base < 4.0 ? 'blooming' : 'short',
      warm_hz: Math.round(warm),
      note: noteName(m),
    };
  } else if (style === 'glock') {
    // Glockenspiel: a small hard steel bar hit with a brass or plastic head.
    // Tuned on the fundamental, with the free-free bar's 2.76 mode over it.
    const m = rng.randint(74, 98); // D5..D7
    const f = midi(m);
    const dur = rng.uniform(0.4, 1.4);
    const n = secs(dur);
    const base = rng.uniform(4.0, 11.0);
    const modeR = 2.76 * rng.uniform(0.97, 1.03);
    const hard = rng.random() < 0.5;
    const w = hard ? null : 'tri';
    out = ring(n, f, [
      { r: 1.0, g: 1.0, atk: 0.0006, rate: base, w: 'tri' },
      { r: modeR, g: rng.uniform(0.3, 0.7), atk: 0.0005, rate: base * 2.2, w, d: rng.choice([0.5, 0.25]) },
      { r: rng.uniform(5.2, 5.6), g: rng.uniform(0.1, 0.35), atk: 0.0004, rate: base * 3.5, w: 'tri' },
      { r: rng.uniform(8.6, 9.2), g: rng.uniform(0.03, 0.12), atk: 0.0004, rate: base * 5.0, w: 'tri' },
    ], dur);
    const head = hard ? rng.uniform(0.14, 0.4) : rng.uniform(0.04, 0.16);
    mixAt(out, tick(rng, Math.min(n, secs(0.006)), 1, f * rng.uniform(2.5, 6.0),
      0.0003, rng.uniform(500, 1300)), 0, head);
    highpass(out, f * 0.4);
    lowpass(out, Math.min(SR * 0.44, f * rng.uniform(5.0, 12.0)));
    tags = {
      style: 'glock',
      mallet: hard ? 'brass' : 'plastic',
      bar: base > 7.5 ? 'dry' : 'singing',
      tone: w === 'tri' ? 'glassy' : 'clangy',
      mode_hz: Math.round(f * modeR),
      note: noteName(m),
    };
  } else if (style === 'tinkle') {
    // Tinkling bells: three to seven tiny castings scattered across a scale,
    // each too small to have a hum note — just a ping and two bright partials.
    const m = rng.randint(76, 96); // E5..C7
    const scale = rng.choice([
      { name: 'pentatonic', offs: [0, 2, 4, 7, 9] },
      { name: 'minor pentatonic', offs: [0, 3, 5, 7, 10] },
      { name: 'whole tone', offs: [0, 2, 4, 6, 8] },
      { name: 'major seventh', offs: [0, 4, 7, 11] },
    ]);
    const hits = rng.randint(3, 7);
    const step = rng.uniform(0.05, 0.2);
    const jitter = rng.uniform(0.0, 0.5);
    const accel = rng.uniform(0.85, 1.15);
    const noteDur = rng.uniform(0.18, 0.45);
    const base = rng.uniform(7.0, 16.0);
    out = [];
    let at = 0.0;
    let gap = step;
    let placed = 0;
    let firstM = m; // the scale degree actually struck first — what you hear
    for (let k = 0; k < hits; k++) {
      if (at > 1.85) break;
      const mk = clampM(m + rng.choice(scale.offs) + rng.choice([0, 0, 0, 12, -12]));
      if (k === 0) firstM = mk;
      const fk = midi(mk);
      const d = noteDur * rng.uniform(0.7, 1.3);
      const hn = secs(d);
      const v = ring(hn, fk, [
        { r: 1.0, g: 1.0, atk: 0.0008, rate: base, w: 'tri' },
        { r: rng.uniform(2.35, 2.85), g: rng.uniform(0.25, 0.7), atk: 0.0006, rate: base * 1.6, w: 'tri' },
        { r: rng.uniform(4.05, 4.5), g: rng.uniform(0.08, 0.3), atk: 0.0005, rate: base * 2.4, w: null, d: 0.25 },
      ], d);
      mixAt(v, tick(rng, Math.min(hn, secs(0.004)), 1, fk * rng.uniform(3.0, 7.0),
        0.0003, rng.uniform(600, 1400)), 0, rng.uniform(0.05, 0.22));
      mixAt(out, v, secs(at + jitter * gap * rng.random()), k === 0 ? 1.0 : rng.uniform(0.4, 1.0));
      placed++;
      at += gap;
      gap *= accel;
    }
    lowpass(out, Math.min(SR * 0.44, midi(m) * rng.uniform(4.0, 10.0)));
    tags = {
      style: 'tinkle',
      size: m > 88 ? 'tiny' : 'small',
      scale: scale.name,
      feel: jitter > 0.28 ? 'loose' : accel < 0.95 ? 'accelerating' : 'even',
      hits: placed,
      bpm: Math.round(15.0 / step),
      note: noteName(firstM),
    };
  } else if (style === 'temple') {
    // Temple bell: a huge thick-walled casting struck with a padded beam. The
    // fundamental blooms in over tens of milliseconds instead of clicking, and
    // the twin casting a few cents away beats under it for the whole tail.
    const m = rng.randint(31, 52); // G1..E3
    const f = midi(m);
    const dur = rng.uniform(1.7, 2.5);
    const n = secs(dur);
    const swell = rng.uniform(0.02, 0.09);
    const base = rng.uniform(0.5, 1.4);
    const parts = [
      { r: 1.0, g: 1.0, atk: swell, rate: base, w: 'tri', swell: true },
      { r: rng.uniform(1.48, 1.53), g: rng.uniform(0.3, 0.7), atk: swell * 0.7, rate: base * 1.4, w: 'tri', swell: true },
      { r: rng.uniform(1.95, 2.05), g: rng.uniform(0.25, 0.6), atk: 0.004, rate: base * 1.8, w: 'tri' },
      { r: rng.uniform(2.55, 2.75), g: rng.uniform(0.12, 0.4), atk: 0.003, rate: base * 2.6, w: 'tri' },
      { r: rng.uniform(3.3, 3.6), g: rng.uniform(0.06, 0.25), atk: 0.002, rate: base * 3.5, w: 'tri' },
      { r: rng.uniform(4.6, 5.2), g: rng.uniform(0.03, 0.14), atk: 0.0015, rate: base * 5.0, w: null, d: 0.25 },
    ];
    out = ring(n, f, parts, dur);
    const cents = rng.uniform(3.0, 22.0);
    const det = Math.pow(2.0, cents / 1200.0);
    const beatHz = f * (det - 1.0);
    mixAt(out, ring(n, f * det, parts, dur), 0, rng.uniform(0.6, 0.95));
    const beam = rng.uniform(0.08, 0.35);
    mixAt(out, tick(rng, Math.min(n, secs(0.06)), rng.randint(4, 12), f * rng.uniform(2.0, 5.0),
      0.003, rng.uniform(30, 90)), 0, beam);
    lowpass(out, Math.min(SR * 0.35, f * rng.uniform(6.0, 15.0)));
    tags = {
      style: 'temple',
      size: m < 41 ? 'huge' : 'big',
      strike: beam > 0.2 ? 'padded beam' : 'soft beam',
      swell: swell > 0.055 ? 'slow swell' : 'quick swell',
      beat_hz: Math.round(beatHz * 100) / 100,
      note: noteName(m),
    };
  } else if (style === 'shimmer') {
    // Shimmer tail: one strike, then two to four copies an octave (or an octave
    // and a fifth) higher, each swelling in later and quieter — the pitch-shifted
    // reverb trick, built out of bells instead of a reverb.
    const m = rng.randint(55, 79); // G3..G5
    const f = midi(m);
    const dur = rng.uniform(1.4, 2.5);
    const n = secs(dur);
    const base = rng.uniform(1.2, 3.0);
    const layers = rng.randint(2, 4);
    const lift = rng.choice([12, 12, 19, 24]);
    const bloom = rng.uniform(0.06, 0.5);
    const delay = rng.uniform(0.08, 0.3);
    const drift = rng.uniform(0.05, 0.4);
    out = ring(n, f, [
      { r: 0.5, g: rng.uniform(0.15, 0.45), atk: 0.004, rate: base * 0.6, w: 'tri' },
      { r: 1.0, g: 1.0, atk: 0.0015, rate: base, w: 'tri' },
      { r: rng.uniform(1.19, 1.22), g: rng.uniform(0.2, 0.5), atk: 0.0012, rate: base * 1.5, w: 'tri' },
      { r: 2.0, g: rng.uniform(0.2, 0.5), atk: 0.001, rate: base * 2.2, w: null, d: rng.choice([0.5, 0.25]) },
      { r: rng.uniform(2.9, 3.05), g: rng.uniform(0.05, 0.2), atk: 0.0008, rate: base * 3.4, w: 'tri' },
    ], dur);
    let g = rng.uniform(0.45, 0.8);
    let stacked = 0;
    for (let k = 1; k <= layers; k++) {
      const off = secs(delay * k);
      if (off >= n - secs(0.25)) break;
      const ln = n - off;
      const ld = ln / SR;
      const mk = clampM(m + lift * k);
      const layer = ring(ln, midi(mk), [
        { r: 1.0, g: 1.0, atk: Math.min(bloom * k, ld * 0.6), rate: base * rng.uniform(0.6, 1.2), w: 'tri', swell: true },
        { r: rng.uniform(1.99, 2.02), g: rng.uniform(0.15, 0.45), atk: Math.min(bloom * k * 0.7, ld * 0.5), rate: base * 1.6, w: 'tri', swell: true },
        { r: rng.uniform(2.7, 2.85), g: rng.uniform(0.05, 0.2), atk: 0.002, rate: base * 2.5, w: 'tri' },
      ], ld);
      flutter(rng, layer, rng.uniform(4.0, 14.0), drift);
      mixAt(out, layer, off, g);
      g *= rng.uniform(0.5, 0.8);
      stacked++;
    }
    lowpass(out, Math.min(SR * 0.44, f * rng.uniform(8.0, 22.0)));
    tags = {
      style: 'shimmer',
      stack: lift === 24 ? 'two-octave stack' : lift === 19 ? 'octave-fifth stack' : 'octave stack',
      motion: drift > 0.22 ? 'drifting' : 'steady',
      layers: stacked,
      bloom_ms: Math.round(bloom * 1000),
      note: noteName(m),
    };
  } else if (style === 'chime') {
    // Chime phrase: a doorbell's two notes, a Westminster fragment, a triad, a
    // pentatonic fall — tuned tubes struck in order, the last one left ringing.
    const m = rng.randint(58, 76); // A#3..E5
    const pat = rng.choice([
      { name: 'ding-dong', offs: [7, 3] },
      { name: 'doorbell pair', offs: [9, 4] },
      { name: 'rising fourth', offs: [0, 5] },
      { name: 'westminster', offs: [4, 2, 0, -5] },
      { name: 'triad ring', offs: [0, 4, 7] },
      { name: 'pentatonic fall', offs: [12, 9, 7, 4] },
    ]);
    const count = pat.offs.length;
    const step = rng.uniform(0.2, 0.5);
    const noteDur = Math.max(0.3, Math.min(rng.uniform(0.55, 1.1), 2.42 - (count - 1) * step));
    const base = rng.uniform(1.4, 4.0);
    const brassy = rng.random() < 0.5;
    const w = brassy ? null : 'tri';
    const duty = rng.choice([0.5, 0.25]);
    const firstM = clampM(m + pat.offs[0]); // the phrase's opening tube
    out = [];
    for (let k = 0; k < count; k++) {
      const last = k === count - 1;
      const mk = clampM(m + pat.offs[k]);
      const fk = midi(mk);
      const d = last ? Math.min(noteDur * 1.6, 2.42 - (count - 1) * step) : noteDur;
      const hn = secs(Math.max(0.2, d));
      const dd = Math.max(0.2, d);
      const v = ring(hn, fk, [
        { r: 0.5, g: rng.uniform(0.1, 0.35), atk: 0.005, rate: base * 0.6, w: 'tri' },
        { r: 1.0, g: 1.0, atk: 0.0018, rate: base, w: 'tri' },
        { r: rng.uniform(1.98, 2.03), g: rng.uniform(0.3, 0.8), atk: 0.0012, rate: base * 1.7, w, d: duty },
        { r: rng.uniform(2.96, 3.06), g: rng.uniform(0.12, 0.4), atk: 0.001, rate: base * 2.6, w: 'tri' },
        { r: rng.uniform(4.1, 4.4), g: rng.uniform(0.04, 0.18), atk: 0.0008, rate: base * 4.0, w: 'tri' },
      ], dd);
      mixAt(v, tick(rng, Math.min(hn, secs(0.012)), rng.randint(1, 4), fk * rng.uniform(4.0, 9.0),
        0.0005, rng.uniform(200, 500)), 0, rng.uniform(0.05, 0.25));
      mixAt(out, v, secs(step * k), k === 0 ? 1.0 : rng.uniform(0.6, 1.0));
    }
    lowpass(out, Math.min(SR * 0.42, midi(m) * rng.uniform(6.0, 16.0)));
    tags = {
      style: 'chime',
      pattern: pat.name,
      voice: brassy ? 'brassy' : 'glassy',
      notes: count,
      bpm: Math.round(30.0 / step),
      note: noteName(firstM),
    };
  } else if (style === 'crystal') {
    // Crystal bell: a triangle rung through a square ring-modulator at an
    // inharmonic ratio, with a sample-and-held octave layer glittering over it.
    const m = rng.randint(67, 91); // G4..G6
    const f = midi(m);
    const dur = rng.uniform(0.5, 1.6);
    const n = secs(dur);
    const base = rng.uniform(2.5, 7.0);
    const ratio = rng.choice([2.0, 2.76, 3.0, 3.47, 4.0, 5.4]) * rng.uniform(0.97, 1.03);
    const depth = rng.uniform(0.15, 0.5);
    const rel = Math.max(0.04, dur * 0.22);
    out = renderTone(n, () => f, 0.5, bellEnv(0.0012, base, dur, rel), 'tri');
    let mp = 0.0;
    for (let i = 0; i < n; i++) {
      mp += (f * ratio) / SR;
      out[i] *= 1.0 - depth + depth * square(mp, 0.5);
    }
    const steps = rng.randint(3, 13);
    const hold = rng.randint(2, 8);
    const sh = ring(n, f * 2.0, [
      { r: 1.0, g: 1.0, atk: 0.0008, rate: base * 2.0, w: 'tri' },
      { r: rng.uniform(1.48, 1.52), g: rng.uniform(0.2, 0.6), atk: 0.0006, rate: base * 3.0, w: 'tri' },
    ], dur);
    crush(sh, steps, hold);
    mixAt(out, sh, 0, rng.uniform(0.12, 0.45));
    mixAt(out, tick(rng, Math.min(n, secs(0.005)), 1, f * rng.uniform(3.0, 8.0),
      0.0003, rng.uniform(600, 1500)), 0, rng.uniform(0.05, 0.2));
    highpass(out, f * 0.45);
    lowpass(out, Math.min(SR * 0.44, f * rng.uniform(5.0, 13.0)));
    tags = {
      style: 'crystal',
      glass: depth > 0.33 ? 'thick' : 'thin',
      grit: steps < 7 ? 'coarse' : 'fine',
      glitter: hold > 4 ? 'stepped' : 'smooth',
      ratio: Math.round(ratio * 100) / 100,
      note: noteName(m),
    };
  } else {
    // Handbell: a small bronze bell rung by hand — the clapper thocks against
    // the lip, and the whole bell swings, so the tail wobbles in and out of the
    // ear. Sometimes it comes back for the up-stroke.
    const m = rng.randint(55, 84); // G3..C6
    const f = midi(m);
    const dur = rng.uniform(0.7, 2.0);
    const n = secs(dur);
    const base = rng.uniform(2.0, 5.0);
    const w = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    const heavy = rng.random() < 0.5;
    const hit = ring(n, f, [
      { r: 0.5, g: heavy ? rng.uniform(0.25, 0.6) : rng.uniform(0.05, 0.25), atk: 0.003, rate: base * 0.5, w: 'tri' },
      { r: 1.0, g: 1.0, atk: 0.0012, rate: base, w: 'tri' },
      { r: rng.uniform(1.19, 1.22), g: rng.uniform(0.25, 0.6), atk: 0.001, rate: base * 1.4, w: 'tri' },
      { r: rng.uniform(1.98, 2.04), g: rng.uniform(0.35, 0.8), atk: 0.0008, rate: base * 2.0, w, d: duty },
      { r: rng.uniform(2.9, 3.1), g: rng.uniform(0.1, 0.35), atk: 0.0008, rate: base * 3.0, w: 'tri' },
      { r: rng.uniform(4.5, 5.3), g: rng.uniform(0.04, 0.18), atk: 0.0006, rate: base * 4.5, w: null, d: 0.25 },
    ], dur);
    const wob = rng.uniform(3.0, 7.5);
    tremolo(hit, wob, rng.uniform(0.08, 0.35));
    mixAt(hit, tick(rng, Math.min(n, secs(0.015)), rng.randint(2, 6), f * rng.uniform(2.0, 5.0),
      0.0008, rng.uniform(180, 450)), 0, rng.uniform(0.08, 0.3));
    const twice = rng.random() < 0.4;
    const gap = rng.uniform(0.22, 0.5);
    out = [];
    mixAt(out, hit, 0, 1.0);
    if (twice) mixAt(out, hit, secs(gap), rng.uniform(0.5, 0.85));
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(6.0, 15.0)));
    tags = {
      style: 'handbell',
      weight: heavy ? 'heavy' : 'light',
      strikes: twice ? 'double strike' : 'single strike',
      tone: w === 'tri' ? 'round' : 'clangy',
      wob_hz: Math.round(wob * 10) / 10,
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every bell inside 0.3 - 2.5 s, block the duty-cycle DC bias, then
  // de-click both edges before normalizing so the peak is exact even when the
  // loudest sample sits inside the first millisecond of the strike.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  const fi = Math.min(out.length >> 2, 12);
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
  const note = t.note || 'C4';
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  const dec = (v, p) => (Number.isFinite(Number(v)) ? Number(v).toFixed(p) : '0');
  switch (t.style) {
    case 'tubular':
      return `tubular bell — ${t.tube || 'thin'} tube, ${t.clang || 'ringing'} ${t.hammer || 'hard'} clang, ${num(t.nominal_hz)} Hz on ${note}`;
    case 'musicbox':
      return `music box tine — ${t.comb || 'steel'} comb, ${t.phrase || 'single tine'}, ${num(t.ping_hz)} Hz ping on ${note}`;
    case 'celesta':
      return `celesta bar — ${t.hammer || 'felt'} hammer, ${t.box || 'open'} ${t.ring || 'short'}, ${num(t.warm_hz)} Hz on ${note}`;
    case 'glock':
      return `glockenspiel — ${t.mallet || 'brass'} mallet, ${t.tone || 'glassy'} ${t.bar || 'dry'} bar, ${num(t.mode_hz)} Hz on ${note}`;
    case 'tinkle':
      return `tinkling bells — ${t.size || 'tiny'} ${t.scale || 'pentatonic'}, ${t.feel || 'even'} ${num(t.hits)} at ${num(t.bpm)} BPM from ${note}`;
    case 'temple':
      return `temple bell — ${t.size || 'huge'} bronze, ${t.swell || 'slow swell'}, ${dec(t.beat_hz, 2)} Hz beat on ${note}`;
    case 'shimmer':
      return `shimmer tail — ${t.stack || 'octave stack'}, ${t.motion || 'steady'} ${num(t.layers)} layers, ${num(t.bloom_ms)} ms bloom, ${note}`;
    case 'chime':
      return `chime phrase — ${t.pattern || 'ding-dong'}, ${t.voice || 'brassy'}, ${num(t.notes)} notes at ${num(t.bpm)} BPM from ${note}`;
    case 'crystal':
      return `crystal bell — ${t.glass || 'thin'} glass, ${t.grit || 'fine'} ${t.glitter || 'smooth'}, ${dec(t.ratio, 2)}x ring on ${note}`;
    case 'handbell':
      return `handbell — ${t.weight || 'light'} ${t.tone || 'round'}, ${t.strikes || 'single strike'}, ${dec(t.wob_hz, 1)} Hz swing, ${note}`;
    default:
      return `struck bell — ${t.metal || 'bronze'} ${t.tierce || 'minor tierce'}, ${t.clapper || 'hard'} clapper, ${dec(t.beat_hz, 2)} Hz beat on ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'struck bronze bells, tubular chimes, music-box tines, shimmer tails';
