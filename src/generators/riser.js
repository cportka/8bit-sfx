// riser — the transition category, and the only one that runs both ways. A
// riser is the bar before the drop and the bar after it: a noise sweep opening
// into a crash, a pitch glide climbing three octaves onto the downbeat, a gate
// accelerating from eighths to 32nds — and every one of those played backwards
// as a downlifter, a pitch fall, a filter closing to nothing.
//
// So every variation records a DIRECTION. `up` is the build (energy, pitch and
// brightness growing into a cut); `down` is the release (the same machinery
// unwound — falls, dives, decelerating rolls, filters shutting). Both halves of
// the pair come out of the same code path, which is what keeps a set of 202
// coherent: seed 007's downlifter is genuinely seed 006's riser inverted.
//
// The eleven sub-styles are a transition designer's working kit: a filtered
// noise sweep, a portamento pitch glide, a tempo-locked gated stutter,
// accelerating ticks, a scale run, a Shepard glide that never arrives, a drum
// roll build, a resonant filter open/close on a held chord, a modulated siren
// whoop, a sample-and-hold stepper, and a reverse-crash swell.
//
// Anything pitched lands on an exact MIDI note and records it: a riser has to
// hand off in tune to whatever it is introducing. Tempo-locked styles record
// BPM and the division they end on, so a build can be dropped straight into a
// track at the right speed.
//
// The instrument stays a chip caricature: naive squares, saws and triangles,
// LFSR noise clocked by a sample-and-hold divider, hand-rolled one-pole filters
// (cascaded, with a cheap resonant bump) for every sweep, tanh for weight, bit
// crush for grit. Post chain is uniform — DC block (narrow pulses carry a
// bias), de-click both edges, then normalize last so the peak is exact even
// when the loudest sample sits on the final frame of a build.

import {
  SR, Lfsr, square, triangle, sawtooth, midi, noteName, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.55 * SR); // 0.55 s — inside the 0.5-3.0 s bracket
const MAX_N = Math.round(2.95 * SR); // 2.95 s

const NYQ = SR * 0.45; // partials above this are dropped rather than aliased

/** Seconds to a sample count, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
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

/** One-pole lowpass in place. */
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
 * Two one-poles in series with the band between them fed back in — a 12 dB
 * slope with a cheap resonant bump, which is what makes a sweep audible.
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

/** One-pole highpass in place. */
function highpass(buf, cut) {
  const A = alphaReader(cut);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += A(i) * (buf[i] - p);
    buf[i] -= p;
  }
  return buf;
}

/** Resonant lowpass plus a highpass `octs` octaves below it: a sweeping band. */
function band(buf, cut, octs, res = 0.0) {
  const f = typeof cut === 'function' ? cut : () => cut;
  lowpass2(buf, f, res);
  const k = Math.pow(2, Math.max(0.2, octs));
  highpass(buf, (t) => f(t) / k);
  return buf;
}

/** LFSR noise, sample-and-held every `per` samples (constant or f(t)). */
function noiseAt(rng, n, per) {
  const lf = new Lfsr(rng, 1);
  const pf = typeof per === 'function' ? per : () => per;
  const out = new Array(n);
  let held = lf.next();
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (--cnt <= 0) {
      held = lf.next();
      cnt = Math.max(1, Math.round(pf(i / SR)));
    }
    out[i] = held;
  }
  return out;
}

/**
 * The tone generator. Square is DC-corrected so narrow duties do not shove the
 * mix off centre, and each shape starts on a zero crossing.
 * @param {"sq"|"tri"|"saw"} shape
 */
function voice(n, freq, envFn, shape = 'sq', duty = 0.5, phase0 = null) {
  const out = new Array(n);
  const fFn = typeof freq === 'function' ? freq : () => freq;
  const dFn = typeof duty === 'function' ? duty : () => duty;
  let ph = phase0 === null ? (shape === 'tri' ? 0.25 : shape === 'saw' ? 0.5 : 0.0) : phase0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += fFn(t) / SR;
    let s;
    if (shape === 'tri') {
      s = triangle(ph);
    } else if (shape === 'saw') {
      s = sawtooth(ph);
    } else {
      const d = dFn(t);
      s = square(ph, d) - (2.0 * d - 1.0);
    }
    out[i] = s * envFn(t);
  }
  return out;
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

/** Soft saturation, gain-compensated so drive only changes shape. */
function drive(buf, amount) {
  const k = Math.max(1e-3, amount);
  const norm = 1.0 / Math.tanh(k);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * k) * norm;
  return buf;
}

/** Ramp both ends to silence — the de-click, applied before normalizing. */
function fadeEdges(buf, inMs, outMs) {
  const fi = Math.min(buf.length >> 1, Math.round((SR * inMs) / 1000));
  const fo = Math.min(buf.length >> 1, Math.round((SR * outMs) / 1000));
  for (let i = 0; i < fi; i++) buf[i] *= i / fi;
  for (let i = 0; i < fo; i++) buf[buf.length - 1 - i] *= i / fo;
  return buf;
}

/**
 * The direction's amplitude contour: `up` swells out of a floor into the cut,
 * `down` snaps in and falls away. Never starts from true silence, so the whole
 * transition is audible rather than just its last third.
 */
function ampFn(rng, dir, dur) {
  const curve = rng.uniform(0.7, 2.6);
  const floor = rng.uniform(0.04, 0.3);
  const atk = dir === 'up' ? 0.004 : rng.uniform(0.002, 0.02);
  const inv = 1.0 / atk;
  const rise = dir === 'up';
  return (t) => {
    const x = clamp01(t / dur);
    const s = rise ? Math.pow(x, curve) : Math.pow(1.0 - x, curve);
    return Math.min(1.0, t * inv) * (floor + (1.0 - floor) * s);
  };
}

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'minor pentatonic': [0, 3, 5, 7, 10],
  'major pentatonic': [0, 2, 4, 7, 9],
  'whole tone': [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  octatonic: [0, 1, 3, 4, 6, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

const SCALE_NAMES = Object.keys(SCALES);

/** Snap a MIDI number onto the nearest scale degree — keeps runs in tune. */
function snap(m, root, degs) {
  const rel = m - root;
  const oct = Math.floor(rel / 12);
  const pc = rel - oct * 12;
  let best = 0;
  let bd = 1e9;
  for (const d of degs) {
    for (const o of [-12, 0, 12]) {
      const dd = Math.abs(d + o - pc);
      if (dd < bd) {
        bd = dd;
        best = d + o;
      }
    }
  }
  return Math.round(root + oct * 12 + best);
}

const DIV_WORDS = {
  1: 'quarters',
  2: 'eighths',
  3: 'eighth triplets',
  4: '16ths',
  6: '16th triplets',
  8: '32nds',
  12: '32nd triplets',
  16: '64ths',
};

function divWord(d) {
  return DIV_WORDS[d] || 'stutters';
}

const STYLES = [
  'sweep', 'pitch', 'gate', 'ticks', 'run', 'shepard', 'roll', 'filter', 'siren', 'sandh',
  'reverse',
];

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice(STYLES);
  const dir = rng.random() < 0.5 ? 'up' : 'down';
  const up = dir === 'up';

  let out;
  let tags;

  if (style === 'sweep') {
    // --- filtered noise sweep: the whoosh, opening or closing -------------
    const dur = rng.uniform(0.8, 2.7);
    const n = secs(dur);
    const lo = rng.uniform(90, 340);
    const hi = rng.uniform(2400, 8200);
    const curve = rng.uniform(0.55, 2.4);
    const res = rng.uniform(0.3, 2.6);
    const octs = rng.uniform(0.9, 3.0);
    const perMax = rng.randint(1, 9);
    const whistleG = rng.uniform(0.0, 0.5);
    const rumbleG = rng.uniform(0.0, 0.45);
    const amp = ampFn(rng, dir, dur);

    const climb = (t) => Math.pow(up ? clamp01(t / dur) : 1.0 - clamp01(t / dur), curve);
    const cutFn = (t) => lo * Math.pow(hi / lo, climb(t));
    // The sample-and-hold divider tracks the band: bright noise where the band
    // is high, coarse grain where it is low.
    const perFn = (t) => 1 + (perMax - 1) * (1.0 - climb(t));

    out = noiseAt(rng, n, perFn);
    for (let i = 0; i < n; i++) out[i] *= amp(i / SR);
    band(out, cutFn, octs, res);

    if (whistleG > 0.18) {
      // A triangle riding the top of the band — the sweep's audible "pitch".
      mixAt(out, voice(n, (t) => Math.min(NYQ, cutFn(t) * 0.8), (t) => amp(t) * 0.5, 'tri'),
        0, whistleG);
    }
    if (rumbleG > 0.2) {
      const rum = noiseAt(rng, n, 6);
      for (let i = 0; i < n; i++) rum[i] *= amp(i / SR);
      lowpass(rum, 120);
      mixAt(out, rum, 0, rumbleG * 1.6);
    }

    tags = {
      style: 'sweep',
      direction: dir,
      texture: perMax >= 5 ? 'gritty S&H' : perMax >= 3 ? 'coarse air' : 'airy',
      curve: curve < 0.85 ? 'steep' : curve > 1.55 ? 'slow' : 'even',
      top_hz: Math.round(hi),
    };
  } else if (style === 'pitch') {
    // --- portamento glide: a pitch rise, or the same fall inverted --------
    const dur = rng.uniform(0.6, 2.4);
    const n = secs(dur);
    const anchor = rng.randint(55, 86);
    const wanted = rng.choice([12, 12, 19, 24, 24, 31, 36]);
    const shape = rng.choice(['sq', 'sq', 'saw', 'tri', 'pwm']);
    const duty0 = rng.choice([0.5, 0.375, 0.25, 0.125]);
    const gc = rng.uniform(0.5, 2.2);
    const hold = rng.uniform(0.72, 1.0);
    const vibHz = rng.uniform(4.5, 8.5);
    const vibC = rng.uniform(0.0, 55.0);
    const detC = rng.uniform(3.0, 20.0);
    const subG = rng.uniform(0.0, 0.55);
    const track = rng.uniform(3.0, 9.0);
    const amp = ampFn(rng, dir, dur);

    const lowM = Math.max(28, anchor - wanted);
    const span = anchor - lowM;
    const mStart = up ? lowM : anchor;
    const mEnd = up ? anchor : lowM;
    const mAt = (t) => {
      const x = clamp01(t / dur / hold);
      const bell = Math.sin(Math.PI * clamp01(t / dur));
      return mStart + (mEnd - mStart) * Math.pow(x, gc)
        + (vibC / 100.0) * bell * Math.sin(2.0 * Math.PI * vibHz * t);
    };
    const fAt = (t) => midi(mAt(t));
    const dutyFn = shape === 'pwm'
      ? (t) => 0.5 - 0.35 * clamp01(t / dur)
      : duty0;
    const wave = shape === 'saw' ? 'saw' : shape === 'tri' ? 'tri' : 'sq';

    out = voice(n, fAt, amp, wave, dutyFn);
    const det = Math.pow(2.0, detC / 1200.0);
    mixAt(out, voice(n, (t) => fAt(t) * det, (t) => amp(t) * 0.7, wave, dutyFn), 0, 1.0);
    if (subG > 0.16) {
      mixAt(out, voice(n, (t) => fAt(t) * 0.5, amp, 'tri'), 0, subG);
    }
    lowpass2(out, (t) => Math.min(NYQ, fAt(t) * track), rng.uniform(0.1, 1.0));

    tags = {
      style: 'pitch',
      direction: dir,
      wave: shape === 'pwm' ? 'PWM pulse'
        : shape === 'saw' ? 'saw'
          : shape === 'tri' ? 'triangle'
            : duty0 <= 0.2 ? 'narrow pulse' : 'square',
      vibrato: vibC < 9 ? 'no vibrato' : vibC < 28 ? 'light vibrato' : 'deep vibrato',
      span_st: span,
      note: noteName(anchor),
    };
  } else if (style === 'gate') {
    // --- tempo-locked gated stutter, accelerating or slowing --------------
    const dur = rng.uniform(0.7, 2.6);
    const n = secs(dur);
    const bpm = rng.randint(84, 168);
    const divS = rng.choice([1, 2, 2, 3, 4]);
    const divE = rng.choice([6, 8, 8, 12, 16]);
    const gd = rng.uniform(0.3, 0.75);
    const src = rng.choice(['square', 'square', 'saw', 'noise', 'square + noise']);
    const m = rng.randint(38, 67);
    const bend = rng.choice([0, 0, 2, 5, 7, 12]);
    const duty = rng.choice([0.5, 0.35, 0.25, 0.125]);
    const loC = rng.uniform(200, 700);
    const hiC = rng.uniform(2200, 8000);
    const res = rng.uniform(0.2, 1.8);
    const amp = ampFn(rng, dir, dur);

    const x = (t) => clamp01(t / dur);
    const divAt = (t) => divS * Math.pow(divE / divS, up ? x(t) : 1.0 - x(t));
    const rateFn = (t) => (bpm / 60.0) * divAt(t);
    const mAt = (t) => m + bend * (up ? x(t) : -x(t));

    // The gate itself: a hard window smoothed by fast one-pole slews so each
    // chop opens and closes without a click.
    const ka = 1.0 - Math.exp(-1.0 / (SR * 0.0015));
    const kr = 1.0 - Math.exp(-1.0 / (SR * 0.004));
    const gateArr = new Array(n);
    let gph = 0.0;
    let g = 0.0;
    for (let i = 0; i < n; i++) {
      gph += rateFn(i / SR) / SR;
      const open = ((gph % 1.0) + 1.0) % 1.0 < gd ? 1.0 : 0.0;
      g += (open > 0 ? ka : kr) * (open - g);
      gateArr[i] = g;
    }

    const flat = () => 1.0;
    if (src === 'noise') {
      out = noiseAt(rng, n, rng.randint(1, 3));
    } else {
      const wave = src === 'saw' ? 'saw' : 'sq';
      out = voice(n, (t) => midi(mAt(t)), flat, wave, duty);
      mixAt(out, voice(n, (t) => midi(mAt(t)) * 1.006, flat, wave, duty), 0, 0.6);
      mixAt(out, voice(n, (t) => midi(mAt(t)) * 0.5, flat, 'tri'), 0, 0.35);
      if (src === 'square + noise') {
        const nz = noiseAt(rng, n, 2);
        highpass(nz, 2200);
        mixAt(out, nz, 0, 0.35);
      }
    }
    for (let i = 0; i < n; i++) out[i] *= gateArr[i] * amp(i / SR);
    lowpass2(out, (t) => (up ? loC + (hiC - loC) * x(t) : hiC + (loC - hiC) * x(t)), res);

    tags = {
      style: 'gate',
      direction: dir,
      source: src,
      division: divWord(up ? divE : divS),
      bpm,
      note: noteName(m),
    };
  } else if (style === 'ticks') {
    // --- accelerating ticks: the countdown that turns into a blur ---------
    const dur = rng.uniform(0.7, 2.6);
    const count = rng.randint(10, 34);
    const timbre = rng.choice(['click', 'woodblock', 'blip', 'stick', 'tine']);
    const ratio = rng.uniform(1.05, 1.3);
    const scaleName = rng.choice(SCALE_NAMES);
    const root = rng.randint(48, 72);
    const climb = rng.choice([0, 5, 7, 12, 12, 19, 24]);
    const bedG = rng.uniform(0.0, 0.55);
    const sat = rng.uniform(1.1, 2.2);
    const amp = ampFn(rng, dir, dur);
    const degs = SCALES[scaleName];

    // Geometric gaps, then scaled so the whole run fills `dur` exactly.
    const gaps = new Array(count);
    let total = 0.0;
    for (let i = 0; i < count; i++) {
      const gp = Math.pow(ratio, up ? -i : i);
      gaps[i] = gp;
      total += gp;
    }
    const k = dur / total;
    const tickHit = (m, level) => {
      const f = midi(Math.min(100, m));
      if (timbre === 'click' || timbre === 'stick') {
        const len = secs(rng.uniform(0.005, 0.02));
        const b = noiseAt(rng, len, 1);
        const rate = rng.uniform(120, 320);
        for (let i = 0; i < len; i++) {
          b[i] *= Math.exp((-rate * i) / SR) * Math.min(1.0, i / 14.0) * level;
        }
        if (timbre === 'stick') band(b, rng.uniform(1200, 3600), 1.2, 1.4);
        else highpass(b, rng.uniform(1600, 4200));
        return b;
      }
      if (timbre === 'tine') {
        const len = secs(rng.uniform(0.05, 0.12));
        const rate = rng.uniform(18, 42);
        const b = voice(len, Math.min(NYQ, f * 2.0),
          (t) => Math.exp(-rate * t) * Math.min(1.0, t * 900.0) * level, 'tri');
        mixAt(b, voice(len, Math.min(NYQ, f * 3.01),
          (t) => Math.exp(-rate * 2.2 * t) * Math.min(1.0, t * 900.0) * level * 0.4, 'tri'), 0, 1.0);
        return b;
      }
      const len = secs(timbre === 'woodblock' ? rng.uniform(0.018, 0.05) : rng.uniform(0.03, 0.075));
      const rate = timbre === 'woodblock' ? rng.uniform(60, 150) : rng.uniform(22, 60);
      const b = voice(len, Math.min(NYQ, f), (t) => Math.exp(-rate * t)
        * Math.min(1.0, t * 1200.0) * level, 'sq', rng.choice([0.5, 0.25, 0.125]));
      if (timbre === 'woodblock') {
        const cl = noiseAt(rng, secs(0.004), 1);
        for (let i = 0; i < cl.length; i++) cl[i] *= Math.exp((-260.0 * i) / SR) * level;
        highpass(cl, 2600);
        mixAt(b, cl, 0, 0.5);
      }
      return b;
    };

    out = [0.0];
    let at = 0.0;
    let topM = root;
    for (let i = 0; i < count; i++) {
      const p = count > 1 ? i / (count - 1) : 1.0;
      const m = snap(root + climb * (up ? p : 1.0 - p), root, degs);
      if (m > topM) topM = m;
      const level = up ? 0.35 + 0.65 * p : 1.0 - 0.6 * p;
      mixAt(out, tickHit(m, level), secs(at), 1.0);
      at += gaps[i] * k;
    }
    if (bedG > 0.15) {
      // Ticks alone are mostly silence; a swept noise bed under them is what
      // makes the countdown read as a transition rather than a metronome.
      const bn = secs(dur);
      const bed = noiseAt(rng, bn, 4);
      band(bed, (t) => {
        const g = up ? clamp01(t / dur) : 1.0 - clamp01(t / dur);
        return 130.0 * Math.pow(2.0, 4.2 * g);
      }, 2.0, 1.1);
      mixAt(out, bed, 0, bedG * 0.7);
    }
    for (let i = 0; i < out.length; i++) out[i] *= amp(i / SR);
    drive(out, sat);

    tags = {
      style: 'ticks',
      direction: dir,
      timbre,
      motion: climb === 0 ? 'flat pitch' : up ? 'rising pitch' : 'falling pitch',
      ticks: count,
      note: noteName(topM),
    };
  } else if (style === 'run') {
    // --- a scale run: the staircase build, in tune both ways --------------
    const dur = rng.uniform(0.7, 2.7);
    const steps = rng.randint(7, 22);
    const scaleName = rng.choice(SCALE_NAMES);
    const startM = rng.randint(38, 62);
    const stepDeg = rng.choice([1, 1, 1, 2]);
    const art = rng.choice(['staccato', 'legato', 'gated', 'plucked']);
    const shape = rng.choice(['sq', 'sq', 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const octG = rng.uniform(0.0, 0.6);
    const detC = rng.uniform(0.0, 14.0);
    const loC = rng.uniform(400, 1200);
    const hiC = rng.uniform(3000, 8500);
    const res = rng.uniform(0.1, 1.6);
    const amp = ampFn(rng, dir, dur);

    const degs = SCALES[scaleName];
    const L = degs.length;
    const ladder = (i) => 12 * Math.floor(i / L) + degs[((i % L) + L) % L];
    const K = (steps - 1) * stepDeg;
    const spanSt = ladder(K) - ladder(0);
    const base = Math.max(30, Math.min(startM, 94 - spanSt));
    const noteOf = (i) => base + ladder(up ? i * stepDeg : K - i * stepDeg);

    const stepDur = dur / steps;
    const lenMul = art === 'staccato' ? 0.55 : art === 'gated' ? 0.45 : art === 'legato' ? 1.2 : 0.9;
    const rate = art === 'staccato' ? 22.0 : art === 'gated' ? 0.0 : art === 'legato' ? 5.0 : 34.0;
    const det = Math.pow(2.0, detC / 1200.0);

    out = [0.0];
    for (let i = 0; i < steps; i++) {
      const m = noteOf(i);
      const f = Math.min(NYQ, midi(m));
      const len = secs(stepDur * lenMul);
      const env = (t) => Math.exp(-rate * t) * Math.min(1.0, t * 1400.0)
        * Math.min(1.0, (len / SR - t) * 900.0 + 0.02);
      const b = voice(len, f, env, shape, duty);
      mixAt(b, voice(len, f * det, (t) => env(t) * 0.6, shape, duty), 0, 1.0);
      if (octG > 0.15 && f * 2.0 < NYQ) {
        mixAt(b, voice(len, f * 2.0, (t) => env(t) * 0.5, 'tri'), 0, octG);
      }
      mixAt(out, b, secs(i * stepDur), 1.0);
    }
    for (let i = 0; i < out.length; i++) out[i] *= amp(i / SR);
    lowpass2(out, (t) => {
      const x = clamp01(t / dur);
      return up ? loC + (hiC - loC) * x : hiC + (loC - hiC) * x;
    }, res);

    tags = {
      style: 'run',
      direction: dir,
      scale: scaleName,
      articulation: art,
      steps,
      note: noteName(noteOf(steps - 1)),
    };
  } else if (style === 'shepard') {
    // --- the glide that never arrives: octave ranks under a fixed window --
    const dur = rng.uniform(1.0, 2.9);
    const n = secs(dur);
    const ranks = rng.randint(4, 7);
    const shape = rng.choice(['tri', 'tri', 'sq', 'saw']);
    const duty = rng.choice([0.5, 0.25]);
    const glideOct = rng.choice([1.0, 1.0, 1.5, 2.0]);
    const centerM = rng.randint(52, 72);
    const sigma = rng.uniform(1.1, 2.0);
    const detC = rng.uniform(0.0, 10.0);
    const airG = rng.uniform(0.0, 0.3);
    const amp = ampFn(rng, dir, dur);

    const fc = midi(centerM);
    const baseM = centerM - 12 * Math.floor(ranks / 2);
    out = new Array(n).fill(0.0);
    for (let k = 0; k < ranks; k++) {
      const rootF = midi(baseM + 12 * k) * Math.pow(2.0, ((k % 3) - 1) * detC / 1200.0);
      const fAt = (t) => rootF * Math.pow(2.0, (up ? 1 : -1) * glideOct * clamp01(t / dur));
      const env = (t) => {
        const f = fAt(t);
        if (f > NYQ || f < 25) return 0.0;
        const u = Math.log2(f / fc) / sigma;
        return Math.exp(-u * u) * amp(t);
      };
      mixAt(out, voice(n, fAt, env, shape, duty), 0, 1.0 / Math.sqrt(ranks));
    }
    if (airG > 0.1) {
      const nz = noiseAt(rng, n, 2);
      for (let i = 0; i < n; i++) nz[i] *= amp(i / SR);
      band(nz, (t) => fc * Math.pow(2.0, (up ? 1 : -1) * glideOct * clamp01(t / dur) + 1.5), 1.5, 1.0);
      mixAt(out, nz, 0, airG);
    }

    tags = {
      style: 'shepard',
      direction: dir,
      timbre: shape === 'tri' ? 'triangle' : shape === 'saw' ? 'saw' : duty <= 0.25 ? 'pulse' : 'square',
      width: sigma > 1.6 ? 'wide window' : 'tight window',
      ranks,
      glide_st: Math.round(glideOct * 12),
      note: noteName(centerM),
    };
  } else if (style === 'roll') {
    // --- the drum roll build, and the roll that falls apart ---------------
    const dur = rng.uniform(0.8, 2.8);
    const n = secs(dur);
    const bpm = rng.randint(80, 170);
    const divS = rng.choice([2, 2, 3, 4]);
    const divE = rng.choice([8, 8, 12, 16]);
    const kit = rng.choice(['snare', 'noise', 'tom', 'clap', 'rim']);
    const tone = rng.uniform(140, 260);
    const bright = rng.uniform(1500, 5200);
    const amp = ampFn(rng, dir, dur);

    const x = (t) => clamp01(t / dur);
    const divAt = (t) => divS * Math.pow(divE / divS, up ? x(t) : 1.0 - x(t));
    const rateFn = (t) => (bpm / 60.0) * divAt(t);

    const hit = (level, tight) => {
      const nz = noiseAt(rng, secs(rng.uniform(0.02, 0.07)), rng.randint(1, 2));
      const rate = (kit === 'rim' ? 220 : 45) * tight;
      for (let i = 0; i < nz.length; i++) {
        nz[i] *= Math.exp((-rate * i) / SR) * Math.min(1.0, i / 10.0) * level;
      }
      if (kit === 'snare') {
        band(nz, bright, 2.4, 0.8);
        const body = voice(nz.length, tone,
          (t) => Math.exp(-70.0 * tight * t) * Math.min(1.0, t * 900.0) * level * 0.7, 'tri');
        mixAt(nz, body, 0, 1.0);
      } else if (kit === 'noise') {
        highpass(nz, bright * 0.6);
      } else if (kit === 'tom') {
        lowpass(nz, 900);
        const body = voice(nz.length, (t) => tone * Math.exp(-3.0 * t),
          (t) => Math.exp(-26.0 * tight * t) * Math.min(1.0, t * 700.0) * level, 'tri');
        mixAt(nz, body, 0, 1.4);
      } else if (kit === 'clap') {
        band(nz, 1800, 1.6, 1.6);
        mixAt(nz, nz.slice(0, Math.max(1, nz.length - secs(0.008))), secs(0.008), 0.7);
      } else {
        band(nz, 2600, 1.0, 1.2);
        const body = voice(nz.length, 420,
          (t) => Math.exp(-160.0 * t) * level * 0.8, 'sq', 0.25);
        mixAt(nz, body, 0, 1.0);
      }
      return nz;
    };

    out = [0.0];
    let ph = 0.0;
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const prev = ph;
      ph += rateFn(t) / SR;
      if (i === 0 || Math.floor(ph) > Math.floor(prev)) {
        const p = x(t);
        const level = up ? 0.4 + 0.6 * p : 1.0 - 0.55 * p;
        mixAt(out, hit(level, 0.7 + 0.9 * (up ? p : 1.0 - p)), i, 0.55);
        hits++;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] *= amp(i / SR);
    drive(out, rng.uniform(1.0, 2.4));

    tags = {
      style: 'roll',
      direction: dir,
      kit,
      density: divWord(up ? divE : divS),
      hits,
      bpm,
    };
  } else if (style === 'filter') {
    // --- a held chord with the filter opening, or closing to nothing ------
    const dur = rng.uniform(0.8, 2.9);
    const n = secs(dur);
    const m = rng.randint(31, 57);
    const voicing = rng.choice([
      'power chord', 'saw stack', 'octaves', 'minor triad', 'major triad', 'single saw',
      'fifth stack',
    ]);
    const shape = rng.choice(['saw', 'saw', 'sq']);
    const duty = rng.choice([0.5, 0.3, 0.2]);
    const res = rng.uniform(0.4, 3.0);
    const lo = rng.uniform(110, 420);
    const hi = rng.uniform(2200, 8500);
    const curve = rng.uniform(0.6, 2.2);
    const bend = rng.choice([0, 0, 0, 1, 2]);
    const noiseG = rng.uniform(0.0, 0.3);
    const sat = rng.uniform(1.0, 2.6);
    const amp = ampFn(rng, dir, dur);

    const INTERVALS = {
      'power chord': [0, 7, 12],
      'saw stack': [0, 0, 0],
      octaves: [0, 12, 24],
      'minor triad': [0, 3, 7, 12],
      'major triad': [0, 4, 7, 12],
      'single saw': [0],
      'fifth stack': [0, 7, 14],
    };
    const iv = INTERVALS[voicing];
    const x = (t) => clamp01(t / dur);
    const bendAt = (t) => (up ? bend * x(t) : -bend * x(t));

    out = new Array(n).fill(0.0);
    for (let j = 0; j < iv.length; j++) {
      const cents = (j - (iv.length - 1) / 2) * rng.uniform(4.0, 16.0);
      const f0 = midi(m + iv[j]) * Math.pow(2.0, cents / 1200.0);
      if (f0 > NYQ) continue;
      mixAt(out, voice(n, (t) => f0 * Math.pow(2.0, bendAt(t) / 12.0),
        (t) => amp(t) / iv.length, shape, duty), 0, 1.0);
    }
    if (noiseG > 0.1) {
      const nz = noiseAt(rng, n, 2);
      for (let i = 0; i < n; i++) nz[i] *= amp(i / SR);
      mixAt(out, nz, 0, noiseG * 0.5);
    }
    lowpass2(out, (t) => {
      const g = Math.pow(up ? x(t) : 1.0 - x(t), curve);
      return lo * Math.pow(hi / lo, g);
    }, res);
    drive(out, sat);

    tags = {
      style: 'filter',
      direction: dir,
      voicing,
      resonance: res > 1.8 ? 'screaming' : res > 0.9 ? 'resonant' : 'gentle',
      peak_hz: Math.round(hi),
      floor_hz: Math.round(lo),
      note: noteName(m),
    };
  } else if (style === 'siren') {
    // --- the siren whoop: a big glide with the wobble folded in -----------
    const dur = rng.uniform(0.6, 2.5);
    const n = secs(dur);
    const anchor = rng.randint(55, 84);
    const wanted = rng.choice([19, 24, 24, 31, 36]);
    const cycles = rng.randint(1, 4);
    const wobSt = rng.uniform(1.5, 7.0);
    const edge = rng.choice(['clean', 'PWM', 'noisy', 'crushed']);
    const shape = rng.choice(['sq', 'sq', 'saw']);
    const duty = rng.choice([0.5, 0.3, 0.15]);
    const gc = rng.uniform(0.6, 1.8);
    const track = rng.uniform(2.5, 7.0);
    const amp = ampFn(rng, dir, dur);

    const lowM = Math.max(26, anchor - wanted);
    const span = anchor - lowM;
    const mStart = up ? lowM : anchor;
    const mEnd = up ? anchor : lowM;
    const x = (t) => clamp01(t / dur);
    // `cycles` whole wobble periods, so the glide still lands dead on `anchor`.
    const mAt = (t) => mStart + (mEnd - mStart) * Math.pow(x(t), gc)
      + wobSt * Math.sin(2.0 * Math.PI * cycles * x(t));
    const fAt = (t) => midi(mAt(t));
    const dutyFn = edge === 'PWM' ? (t) => 0.5 - 0.32 * Math.sin(Math.PI * x(t)) : duty;

    out = voice(n, fAt, amp, shape, dutyFn);
    mixAt(out, voice(n, (t) => fAt(t) * 1.008, (t) => amp(t) * 0.6, shape, dutyFn), 0, 1.0);
    if (edge === 'noisy') {
      const nz = noiseAt(rng, n, 1);
      for (let i = 0; i < n; i++) nz[i] *= amp(i / SR);
      band(nz, (t) => Math.min(NYQ, fAt(t) * 3.0), 1.4, 1.2);
      mixAt(out, nz, 0, 0.4);
    }
    if (edge === 'crushed') crush(out, rng.randint(3, 7), rng.randint(2, 5));
    lowpass2(out, (t) => Math.min(NYQ, fAt(t) * track), rng.uniform(0.2, 1.4));

    tags = {
      style: 'siren',
      direction: dir,
      edge,
      tone: shape === 'saw' ? 'saw' : duty <= 0.2 ? 'thin pulse' : 'square',
      wobbles: cycles,
      span_st: span,
      note: noteName(anchor),
    };
  } else if (style === 'sandh') {
    // --- sample-and-hold stepper: random notes, climbing centre ----------
    const dur = rng.uniform(0.7, 2.7);
    const steps = rng.randint(12, 40);
    const scaleName = rng.choice(SCALE_NAMES);
    const spread = rng.uniform(3.0, 20.0);
    const climb = rng.choice([12, 19, 24, 24, 31]);
    const baseM = rng.randint(45, 62);
    const shape = rng.choice(['sq', 'sq', 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const lenMul = rng.uniform(0.5, 1.0);
    const rate = rng.uniform(8.0, 45.0);
    const clickG = rng.uniform(0.0, 0.4);
    const loC = rng.uniform(600, 1600);
    const hiC = rng.uniform(3000, 9000);
    const amp = ampFn(rng, dir, dur);
    const degs = SCALES[scaleName];

    const stepDur = dur / steps;
    out = [0.0];
    for (let i = 0; i < steps; i++) {
      const p = steps > 1 ? i / (steps - 1) : 1.0;
      const centre = baseM + climb * (up ? p : 1.0 - p);
      const m = Math.min(100, snap(Math.round(centre + rng.uniform(-spread, spread)), baseM, degs));
      const len = secs(stepDur * lenMul);
      const f = Math.min(NYQ, midi(m));
      const env = (t) => Math.exp(-rate * t) * Math.min(1.0, t * 1500.0);
      const b = voice(len, f, env, shape, duty);
      if (clickG > 0.12) {
        const cl = noiseAt(rng, Math.min(len, secs(0.004)), 1);
        for (let j = 0; j < cl.length; j++) cl[j] *= Math.exp((-300.0 * j) / SR);
        highpass(cl, 2800);
        mixAt(b, cl, 0, clickG);
      }
      mixAt(out, b, secs(i * stepDur), 1.0);
    }
    for (let i = 0; i < out.length; i++) out[i] *= amp(i / SR);
    lowpass2(out, (t) => {
      const g = clamp01(t / dur);
      return up ? loC + (hiC - loC) * g : hiC + (loC - hiC) * g;
    }, rng.uniform(0.1, 1.2));

    tags = {
      style: 'sandh',
      direction: dir,
      scale: scaleName,
      spread: spread < 7 ? 'tight' : spread < 14 ? 'medium' : 'wide',
      steps,
      note: noteName(baseM + climb),
    };
  } else {
    // --- reverse crash: inharmonic ranks swelling into the cut ------------
    const dur = rng.uniform(0.9, 2.9);
    const n = secs(dur);
    const partials = rng.randint(5, 9);
    const m = rng.randint(45, 69);
    const timbre = rng.choice(['metallic', 'glassy', 'trashy', 'gong-like']);
    const spreadR = rng.uniform(1.2, 2.6);
    const shimmerG = rng.uniform(0.0, 0.6);
    const shape = timbre === 'trashy' ? 'sq' : 'tri';
    const stagger = rng.uniform(0.15, 0.6);
    const loC = rng.uniform(500, 1400);
    const hiC = rng.uniform(3500, 9000);
    const res = rng.uniform(0.1, 1.3);
    const amp = ampFn(rng, dir, dur);

    const f0 = midi(m);
    const x = (t) => clamp01(t / dur);
    out = new Array(n).fill(0.0);
    for (let k = 0; k < partials; k++) {
      const ratio = Math.sqrt(1.0 + k * spreadR) * (1.0 + rng.uniform(-0.012, 0.012));
      const f = f0 * ratio;
      if (f > NYQ) continue;
      // Higher ranks arrive later in a build, and leave first in a decay.
      const shade = (t) => Math.pow(up ? x(t) : 1.0 - x(t), 1.0 + k * stagger);
      mixAt(out, voice(n, f, (t) => amp(t) * shade(t) / Math.sqrt(partials), shape, 0.5), 0, 1.0);
    }
    if (shimmerG > 0.12) {
      const nz = noiseAt(rng, n, 1);
      for (let i = 0; i < n; i++) nz[i] *= amp(i / SR);
      band(nz, (t) => {
        const g = up ? x(t) : 1.0 - x(t);
        return Math.min(NYQ, f0 * (3.0 + 9.0 * g));
      }, 1.0, 0.5);
      mixAt(out, nz, 0, shimmerG);
    }
    lowpass2(out, (t) => (up ? loC + (hiC - loC) * x(t) : hiC + (loC - hiC) * x(t)), res);

    tags = {
      style: 'reverse',
      direction: dir,
      timbre,
      shimmer: shimmerG > 0.3 ? 'hissy' : shimmerG > 0.12 ? 'light air' : 'dry',
      partials,
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every transition inside 0.55 - 2.95 s, block the pulse-duty bias,
  // then de-click both edges before normalizing so the peak is exact even when
  // the loudest sample is the last frame of a build.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  while (out.length < MIN_N) out.push(0.0);
  dcBlock(out, 0.997);
  fadeEdges(out, 4, 14);
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const up = t.direction !== 'down';
  const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
  const w = (v, d) => (typeof v === 'string' && v ? v : d);
  const note = w(t.note, 'C4');
  switch (t.style) {
    case 'pitch':
      return up
        ? `pitch riser — ${w(t.wave, 'square')}, ${w(t.vibrato, 'no vibrato')}, ${num(t.span_st, 12)} st up to ${note}`
        : `pitch fall — ${w(t.wave, 'square')}, ${w(t.vibrato, 'no vibrato')}, ${num(t.span_st, 12)} st down from ${note}`;
    case 'gate':
      return up
        ? `gated riser — ${w(t.source, 'square')}, into ${w(t.division, '32nds')}, ${num(t.bpm, 120)} BPM, ${note}`
        : `gated downlifter — ${w(t.source, 'square')}, out to ${w(t.division, 'eighths')}, ${num(t.bpm, 120)} BPM, ${note}`;
    case 'ticks':
      return up
        ? `accelerating ticks — ${w(t.timbre, 'click')}, ${w(t.motion, 'rising pitch')}, ${num(t.ticks, 16)} ticks, ${note}`
        : `decelerating ticks — ${w(t.timbre, 'click')}, ${w(t.motion, 'falling pitch')}, ${num(t.ticks, 16)} ticks, ${note}`;
    case 'run':
      return up
        ? `note run riser — ${w(t.scale, 'major')}, ${w(t.articulation, 'staccato')}, ${num(t.steps, 12)} steps up to ${note}`
        : `note run fall — ${w(t.scale, 'major')}, ${w(t.articulation, 'staccato')}, ${num(t.steps, 12)} steps down to ${note}`;
    case 'shepard':
      return `shepard ${up ? 'riser' : 'fall'} — endless ${w(t.timbre, 'triangle')}, ${w(t.width, 'wide window')}, ${num(t.ranks, 5)} ranks, ${note}`;
    case 'roll':
      return up
        ? `${w(t.kit, 'snare')} roll build — up to ${w(t.density, '32nds')}, ${num(t.hits, 24)} hits, ${num(t.bpm, 120)} BPM`
        : `${w(t.kit, 'snare')} roll fall — down to ${w(t.density, 'eighths')}, ${num(t.hits, 24)} hits, ${num(t.bpm, 120)} BPM`;
    case 'filter':
      return up
        ? `filter-open riser — ${w(t.voicing, 'saw stack')}, ${w(t.resonance, 'resonant')}, ${num(t.peak_hz, 6000)} Hz peak, ${note}`
        : `filter-close fall — ${w(t.voicing, 'saw stack')}, ${w(t.resonance, 'resonant')}, ${num(t.floor_hz, 200)} Hz floor, ${note}`;
    case 'siren':
      return up
        ? `siren riser — ${w(t.edge, 'clean')} ${w(t.tone, 'square')}, ${num(t.wobbles, 2)} wobbles, ${num(t.span_st, 24)} st to ${note}`
        : `siren fall — ${w(t.edge, 'clean')} ${w(t.tone, 'square')}, ${num(t.wobbles, 2)} wobbles, ${num(t.span_st, 24)} st from ${note}`;
    case 'sandh':
      return `sample-and-hold ${up ? 'riser' : 'fall'} — ${w(t.scale, 'whole tone')}, ${w(t.spread, 'wide')} spread, ${num(t.steps, 20)} steps, ${note}`;
    case 'reverse':
      return up
        ? `reverse-crash riser — ${w(t.timbre, 'metallic')}, ${w(t.shimmer, 'dry')}, ${num(t.partials, 7)} partials, ${note}`
        : `crash downlifter — ${w(t.timbre, 'metallic')}, ${w(t.shimmer, 'dry')}, ${num(t.partials, 7)} partials, ${note}`;
    default:
      return up
        ? `noise-sweep riser — ${w(t.texture, 'airy')}, ${w(t.curve, 'even')} curve, up to ${num(t.top_hz, 6000)} Hz`
        : `noise-sweep downlifter — ${w(t.texture, 'airy')}, ${w(t.curve, 'even')} curve, from ${num(t.top_hz, 6000)} Hz`;
  }
}

/** Short phrase for the README category table. */
export const character = 'noise sweeps, pitch glides, gated builds, drum rolls, filter falls';
