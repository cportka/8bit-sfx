// glitch — the digital-artifact category. Everything here is a chip failing on
// purpose: a buffer retriggering before it finished, a bus dropping bits, a
// sample-rate divider wandering, a transport losing speed, a read pointer
// landing somewhere it shouldn't. These are instruments, not error messages —
// stutters land on a tempo grid, chirps land on scale degrees, tape stops
// collapse from a real note — so a set of 202 can be dropped into a beat and
// used as fills, transitions and percussion rather than novelty noises.
//
// Eleven sub-styles, each a different way for audio to break:
//   stutter   — buffer retrigger on a BPM grid, re-pitched and ramped
//   bitcrush  — bit-depth burst, crumbling or clearing across the hit
//   srmangle  — sample-rate divider modulated into aliasing whistles
//   tapestop  — transport collapse (or spin-up), darkening as it slows
//   jump      — read pointer landing at random block boundaries
//   click     — pop/tick/ping errors, the DAC complaining
//   granular  — grain cloud scattered across a scale
//   datachirp — modem-style corruption chirps sweeping semitone spans
//   dropout   — holes punched in a held source, silent or filled with static
//   scrub     — pointer jogged forward and back like a jog wheel
//   ringmod   — inharmonic ring-mod corruption, metallic and crushed
//
// The instrument stays a chip caricature throughout: naive squares (DC-
// corrected so narrow duties don't shove the mix off centre), triangles, saws,
// LFSR noise clocked by a sample-and-hold divider, hand-rolled one-pole
// filters, and honest bit crushing. Every pitched element sits on an exact MIDI
// note and records it, because a glitch that lands off-key is just a mistake.
//
// Post chain is uniform: clamp to the 0.06-0.97 s bracket, trim dead air, block
// the pulse-duty DC bias, de-click both edges, then normalize LAST so the peak
// is exact even when the loudest sample is a single-frame pop.

import {
  SR, Lfsr, square, triangle, sawtooth, midi, noteName, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.06 * SR); // 0.06 s — inside the 0.05-1.0 s bracket
const MAX_N = Math.round(0.97 * SR); // 0.97 s

const NYQ = SR * 0.45; // anything above this is dropped rather than aliased

/** Seconds to a sample count, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function peakOf(buf) {
  let pk = 0.0;
  for (const v of buf) {
    const a = v < 0 ? -v : v;
    if (a > pk) pk = a;
  }
  return pk;
}

function r1(x) {
  return Math.round(x * 10) / 10;
}

function r2(x) {
  return Math.round(x * 100) / 100;
}

// --- filters ---------------------------------------------------------------

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

/** Two one-poles in series with the band fed back — 12 dB with a cheap bump. */
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

/** Resonant lowpass plus a highpass `octs` octaves below: a band. */
function band(buf, cut, octs, res = 0.0) {
  const f = typeof cut === 'function' ? cut : () => cut;
  lowpass2(buf, f, res);
  const k = Math.pow(2, Math.max(0.2, octs));
  highpass(buf, (t) => f(t) / k);
  return buf;
}

// --- sources ---------------------------------------------------------------

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
 * The tone generator. Square is DC-corrected so narrow duties do not bias the
 * mix, and each shape starts on a zero crossing.
 * @param {"sq"|"tri"|"saw"} shape
 */
function voice(n, freq, envFn, shape = 'sq', duty = 0.5, phase0 = null) {
  const out = new Array(n);
  const fFn = typeof freq === 'function' ? freq : () => freq;
  const dFn = typeof duty === 'function' ? duty : () => duty;
  let ph = phase0 === null ? (shape === 'tri' ? 0.25 : shape === 'saw' ? 0.5 : 0.0) : phase0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = fFn(t);
    ph += (f > NYQ ? NYQ : f < 0 ? 0 : f) / SR;
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

/** Attack ramp, exponential body, release ramp — all in seconds. */
function ampEnv(dur, atk, rate, rel) {
  const a = Math.max(1e-5, atk);
  const r = Math.max(1e-5, rel);
  return (t) => {
    if (t < 0 || t > dur) return 0.0;
    const up = t < a ? t / a : 1.0;
    const dn = t > dur - r ? Math.max(0.0, (dur - t) / r) : 1.0;
    return up * dn * Math.exp(-rate * t);
  };
}

// --- mangling --------------------------------------------------------------

/**
 * Sample-and-hold rate reduction plus a level crush, both peak-relative and
 * both accepting either a constant or f(t). This is the whole category's
 * signature move, so it takes the time-varying form.
 */
function crush(buf, steps, hold) {
  const pk = peakOf(buf);
  if (pk < 1e-9) return buf;
  const S = typeof steps === 'function' ? steps : () => steps;
  const H = typeof hold === 'function' ? hold : () => hold;
  let held = 0.0;
  let cnt = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    if (cnt <= 0) {
      held = buf[i] / pk;
      cnt = Math.max(1, Math.round(H(t)));
    }
    cnt--;
    const s = Math.max(1, Math.round(S(t)));
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

/** Linear read of a buffer at a fractional position; silence outside it. */
function sampleAt(src, pos) {
  if (!(pos >= 0) || pos > src.length - 1) return 0.0;
  const i = Math.floor(pos);
  if (i >= src.length - 1) return src[src.length - 1];
  const f = pos - i;
  return src[i] * (1.0 - f) + src[i + 1] * f;
}

/** Ramp a block's head and tail so a hard edit doesn't spit. */
function shapeBlock(buf, atkN, relN) {
  const half = Math.max(1, buf.length >> 1);
  const a = Math.max(1, Math.min(half, atkN));
  const r = Math.max(1, Math.min(half, relN));
  for (let i = 0; i < a; i++) buf[i] *= i / a;
  for (let i = 0; i < r; i++) buf[buf.length - 1 - i] *= i / r;
  return buf;
}

/** Ramp both ends to silence — the de-click, applied before normalizing. */
function fadeEdges(buf, fiN, foN) {
  const half = Math.max(1, buf.length >> 1);
  const fi = Math.max(1, Math.min(half, fiN));
  const fo = Math.max(1, Math.min(half, foN));
  for (let i = 0; i < fi; i++) buf[i] *= i / fi;
  for (let i = 0; i < fo; i++) buf[buf.length - 1 - i] *= i / fo;
  return buf;
}

/**
 * Drop near-silence from both ends. A one-shot has to start when you trigger
 * it, and the 16-level crush downstream zeroes anything under ~9% of peak
 * anyway, so padding under 2% is already silence in the exported audio.
 */
function trimEnds(buf, headMs, tailMs) {
  const pk = peakOf(buf);
  if (pk < 1e-9) return buf;
  const thr = pk * 0.02;
  const abs = (i) => (buf[i] < 0 ? -buf[i] : buf[i]);
  let last = buf.length - 1;
  while (last > 0 && abs(last) < thr) last--;
  let first = 0;
  while (first < last && abs(first) < thr) first++;
  const from = Math.max(0, first - secs(headMs / 1000));
  const to = Math.min(buf.length, last + 1 + secs(tailMs / 1000));
  return to - from < buf.length ? buf.slice(from, to) : buf;
}

// --- pitch -----------------------------------------------------------------

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  penta: [0, 3, 5, 7, 10],
  whole: [0, 2, 4, 6, 8, 10],
  fifths: [0, 7],
  chrom: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const SCALE_NAMES = ['minor', 'major', 'penta', 'whole', 'fifths', 'chrom'];

/** Degree `k` of `scale` above (or below) `root`, wrapping by octaves. */
function scaleNote(root, scale, k) {
  const s = SCALES[scale] || SCALES.minor;
  const L = s.length;
  const oct = Math.floor(k / L);
  const idx = ((k % L) + L) % L;
  return root + 12 * oct + s[idx];
}

const SHAPE_WORD = { sq: 'square', tri: 'triangle', saw: 'saw' };

// --- the material the glitch machinery chews on ----------------------------

/**
 * A short musical cell, rendered once and then stuttered, scrubbed, jumped
 * through or punched full of holes.
 * @param {"held tone"|"dyad"|"chord"|"arpeggio"|"hat ticks"|"noise"} kind
 */
function sourceCell(rng, n, kind, root, scale, shape, duty) {
  const out = new Array(n).fill(0.0);
  if (kind === 'arpeggio') {
    const steps = rng.randint(3, 7);
    const noteN = Math.max(secs(0.018), Math.floor(n / steps));
    const dir = rng.choice([1, 1, -1]);
    const stride = rng.randint(1, 2);
    const rate = rng.uniform(2.0, 16.0);
    for (let k = 0; k < steps; k++) {
      const f = midi(scaleNote(root, scale, dir * k * stride));
      if (f > NYQ) continue;
      const env = ampEnv(noteN / SR, 0.0012, rate, 0.004);
      mixAt(out, voice(noteN, f, env, shape, duty), k * noteN, 1.0);
    }
  } else if (kind === 'dyad') {
    const iv = rng.choice([7, 12, 5, 3, 4]);
    const env = ampEnv(n / SR, 0.002, rng.uniform(0.0, 3.0), 0.01);
    mixAt(out, voice(n, midi(root), env, shape, duty), 0, 0.62);
    if (midi(root + iv) < NYQ) mixAt(out, voice(n, midi(root + iv), env, shape, duty), 0, 0.5);
  } else if (kind === 'chord') {
    const third = rng.choice([3, 4]);
    const env = ampEnv(n / SR, 0.003, rng.uniform(0.0, 2.5), 0.01);
    for (const iv of [0, third, 7]) {
      const f = midi(root + iv);
      if (f > NYQ) continue;
      mixAt(out, voice(n, f, env, shape, duty), 0, 0.42);
    }
  } else if (kind === 'hat ticks') {
    // A roll, not three lonely clicks. The spacing is absolute rather than a
    // fraction of the cell: a long cell has to stay just as chewable, since
    // whatever mangles it may only read 30 ms of the thing.
    const gap = secs(rng.uniform(0.018, 0.07));
    const rate = rng.uniform(40.0, 130.0);
    const cut = rng.uniform(2200, 6500);
    for (let at = 0, k = 0; at < n; at += gap, k++) {
      const len = Math.min(gap * 2, secs(rng.uniform(0.014, 0.05)));
      const nz = noiseAt(rng, len, rng.randint(1, 3));
      for (let i = 0; i < len; i++) nz[i] *= Math.exp((-rate * i) / SR);
      highpass(nz, cut);
      mixAt(out, nz, at, k % 4 === 0 ? 0.95 : 0.6);
    }
  } else if (kind === 'noise') {
    const nz = noiseAt(rng, n, rng.randint(1, 6));
    band(nz, rng.uniform(900, 5200), rng.uniform(0.8, 2.2), 0.5);
    mixAt(out, nz, 0, 1.0);
  } else {
    const env = ampEnv(n / SR, 0.002, rng.uniform(0.0, 4.0), 0.01);
    mixAt(out, voice(n, midi(root), env, shape, duty), 0, 1.0);
  }
  if (out.length > n) out.length = n;
  return out;
}

/** How a cell is named in the catalog: the shape only matters when pitched. */
function cellWord(kind, shape) {
  if (kind === 'hat ticks') return 'hat ticks';
  if (kind === 'noise') return 'noise';
  return `${SHAPE_WORD[shape] || 'square'} ${kind}`;
}

// --- the styles ------------------------------------------------------------

const STYLES = [
  'stutter', 'bitcrush', 'srmangle', 'tapestop', 'jump',
  'click', 'granular', 'datachirp', 'dropout', 'scrub', 'ringmod',
];

/** Note-division grid: label plus subdivisions per beat. */
const DIVS = [
  ['8th', 2], ['12th', 3], ['16th', 4], ['16th', 4],
  ['24th', 6], ['32nd', 8], ['32nd', 8], ['48th', 12],
];

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice(STYLES);
  let out;
  let tags;

  if (style === 'stutter') {
    // A buffer retriggered before it finished: one cell, re-read on a grid.
    const bpm = rng.randint(84, 172);
    const div = rng.choice(DIVS);
    const division = div[0];
    const slice0 = 60.0 / bpm / div[1];
    const ramp = rng.choice(['even', 'even', 'accelerating', 'decelerating']);
    const ratio = ramp === 'accelerating'
      ? rng.uniform(0.78, 0.93)
      : ramp === 'decelerating' ? rng.uniform(1.07, 1.26) : 1.0;
    const wanted = rng.randint(3, 14);
    const gateAmt = rng.choice([1.0, 1.0, 0.85, 0.62, 0.45]);
    const motion = rng.choice(['flat', 'flat', 'rising', 'falling', 'octave-up', 'scattered']);
    const stepSt = rng.choice([1, 2, 3, 5, 7]);
    const shading = rng.choice(['even', 'fading', 'swelling']);
    const kind = rng.choice(['held tone', 'dyad', 'arpeggio', 'hat ticks', 'noise', 'chord']);
    const shape = rng.choice(['sq', 'tri', 'saw']);
    const duty = rng.choice([0.125, 0.25, 0.375, 0.5]);
    const m = rng.randint(45, 76);
    const scale = rng.choice(SCALE_NAMES);

    const srcN = Math.min(secs(0.42), Math.max(secs(0.07), Math.round(secs(slice0) * 2.4)));
    const src = sourceCell(rng, srcN, kind, m, scale, shape, duty);

    out = [];
    let offset = 0;
    let sl = slice0;
    let reps = 0;
    for (let k = 0; k < wanted; k++) {
      const sliceN = Math.max(secs(0.006), secs(sl));
      const gateN = Math.max(secs(0.005), Math.round(sliceN * gateAmt));
      let step = 1.0;
      if (motion === 'rising') step = Math.pow(2, Math.min(24, k * stepSt) / 12);
      else if (motion === 'falling') step = Math.pow(2, -Math.min(24, k * stepSt) / 12);
      else if (motion === 'octave-up') step = k >= wanted - 2 ? 2.0 : 1.0;
      else if (motion === 'scattered') step = Math.pow(2, rng.choice([-12, -5, 0, 0, 3, 7, 12]) / 12);
      const g = shading === 'fading'
        ? Math.pow(0.86, k)
        : shading === 'swelling' ? 0.45 + (0.55 * k) / Math.max(1, wanted - 1) : 1.0;
      const blk = new Array(gateN);
      for (let i = 0; i < gateN; i++) blk[i] = sampleAt(src, i * step) * g;
      shapeBlock(blk, Math.max(3, secs(0.0006)), Math.max(4, secs(0.0015)));
      mixAt(out, blk, offset, 1.0);
      offset += sliceN;
      sl *= ratio;
      reps++;
      if (offset >= MAX_N) break;
    }

    tags = {
      style: 'stutter',
      source: cellWord(kind, shape),
      motion: motion === 'flat' ? ramp : motion,
      gate: gateAmt > 0.95 ? 'seamless' : 'gapped',
      division,
      reps,
      bpm,
      note: noteName(m),
    };
  } else if (style === 'bitcrush') {
    // A bus losing bits mid-note: depth and rate both move across the hit.
    const m = rng.randint(38, 74);
    const kind = rng.choice(['held tone', 'held tone', 'dyad', 'chord']);
    const shape = rng.choice(['sq', 'tri', 'saw']);
    const duty = rng.choice([0.125, 0.25, 0.5]);
    const scale = rng.choice(SCALE_NAMES);
    const motion = rng.choice(['crumbling', 'clearing', 'stepping', 'locked']);
    const dur = rng.uniform(0.09, 0.62);
    const n = secs(dur);
    const src = sourceCell(rng, n, kind, m, scale, shape, duty);

    const b0 = rng.randint(2, 6);
    const b1 = rng.randint(1, 5);
    const hzA = rng.uniform(700, 11000);
    const hzB = rng.uniform(500, 9000);
    let bitsFn;
    let holdFn;
    let bitsTag;
    let rateTag;
    if (motion === 'locked') {
      const lv = Math.pow(2, b1) - 1;
      const hd = Math.max(1, Math.round(SR / hzB));
      bitsFn = () => lv;
      holdFn = () => hd;
      bitsTag = b1;
      rateTag = Math.round(SR / hd);
    } else if (motion === 'stepping') {
      // The bus flips between two settings on a fast grid.
      const segN = secs(rng.uniform(0.008, 0.045));
      const lvA = Math.pow(2, b0) - 1;
      const lvB = Math.pow(2, b1) - 1;
      const hdA = Math.max(1, Math.round(SR / hzA));
      const hdB = Math.max(1, Math.round(SR / hzB));
      const odd = (t) => Math.floor((t * SR) / segN) % 2 === 1;
      bitsFn = (t) => (odd(t) ? lvB : lvA);
      holdFn = (t) => (odd(t) ? hdB : hdA);
      bitsTag = Math.min(b0, b1);
      rateTag = Math.round(SR / Math.max(hdA, hdB));
    } else {
      const up = motion === 'clearing';
      const lo = Math.min(b0, b1);
      const hi = Math.max(b0, b1);
      const fLo = Math.min(hzA, hzB);
      const fHi = Math.max(hzA, hzB);
      const p = rng.uniform(0.6, 2.2);
      const x = (t) => Math.pow(clamp01(t / dur), p);
      bitsFn = (t) => Math.pow(2, up ? lo + (hi - lo) * x(t) : hi - (hi - lo) * x(t)) - 1;
      holdFn = (t) => {
        const hz = up ? fLo + (fHi - fLo) * x(t) : fHi - (fHi - fLo) * x(t);
        return Math.max(1, Math.round(SR / Math.max(120, hz)));
      };
      bitsTag = lo;
      rateTag = Math.round(fLo);
    }
    crush(src, bitsFn, holdFn);
    if (rng.random() < 0.45) drive(src, rng.uniform(1.4, 4.5));
    out = src;

    tags = {
      style: 'bitcrush',
      tone: cellWord(kind, shape),
      motion,
      bits: bitsTag,
      rate_hz: rateTag,
      note: noteName(m),
    };
  } else if (style === 'srmangle') {
    // The sample-rate divider wandering: the aliasing whistle is the melody.
    const m = rng.randint(46, 79);
    const shape = rng.choice(['sq', 'tri', 'saw']);
    const duty = rng.choice([0.125, 0.25, 0.5]);
    const motion = rng.choice(['wobbling', 'stepping', 'sweeping', 'stepping']);
    const texture = rng.choice(['aliased', 'ringing', 'warbled', 'metallic']);
    const dur = rng.uniform(0.10, 0.70);
    const n = secs(dur);
    const env = ampEnv(dur, rng.uniform(0.001, 0.006), rng.uniform(0.0, 5.0), rng.uniform(0.01, 0.09));
    out = voice(n, midi(m), env, shape, duty);

    const holdA = Math.max(1, Math.round(SR / rng.uniform(900, 9000)));
    const holdB = Math.max(1, Math.round(SR / rng.uniform(300, 4000)));
    const lfoHz = rng.uniform(4, 90);
    const segN = secs(rng.uniform(0.006, 0.04));
    let holdFn;
    if (motion === 'wobbling') {
      const mid = (holdA + holdB) / 2;
      const dep = Math.abs(holdA - holdB) / 2;
      holdFn = (t) => mid + dep * Math.sin(2 * Math.PI * lfoHz * t);
    } else if (motion === 'sweeping') {
      holdFn = (t) => holdA + (holdB - holdA) * clamp01(t / dur);
    } else {
      const table = [holdA, holdB, Math.max(1, Math.round((holdA + holdB) / 2)), Math.max(1, holdA * 2)];
      holdFn = (t) => table[Math.floor((t * SR) / segN) % table.length];
    }
    const steps = rng.choice([3, 5, 7, 15, 31]);
    crush(out, steps, holdFn);
    if (texture === 'ringing') lowpass2(out, rng.uniform(1800, 6000), 1.4);
    if (texture === 'metallic') drive(out, rng.uniform(2.0, 6.0));

    tags = {
      style: 'srmangle',
      motion,
      texture,
      steps,
      floor_hz: Math.round(SR / Math.max(holdA, holdB)),
      note: noteName(m),
    };
  } else if (style === 'tapestop') {
    // Transport collapse: the cell slows, darkens and dies (or spins up).
    const dir = rng.choice(['stop', 'stop', 'stop', 'spin-up']);
    const dur = rng.uniform(0.14, 0.92);
    const n = secs(dur);
    const m = rng.randint(40, 72);
    const scale = rng.choice(SCALE_NAMES);
    const kind = rng.choice(['held tone', 'dyad', 'chord', 'arpeggio', 'hat ticks']);
    const shape = rng.choice(['sq', 'tri', 'saw']);
    const duty = rng.choice([0.125, 0.25, 0.5]);
    const p = rng.uniform(0.65, 3.0);
    const endRate = rng.uniform(0.015, 0.14);
    const damping = rng.choice(['darkening', 'darkening', 'bright']);
    const curve = p < 1.0 ? 'immediate' : p < 1.8 ? 'even' : 'gentle at first';

    const src = sourceCell(rng, n + 8, kind, m, scale, shape, duty);
    const rateAt = (u) => (dir === 'stop'
      ? 1.0 - (1.0 - endRate) * Math.pow(clamp01(u), p)
      : endRate + (1.0 - endRate) * Math.pow(clamp01(u), p));

    out = new Array(n);
    let pos = 0.0;
    for (let i = 0; i < n; i++) {
      const rate = rateAt(i / n);
      out[i] = sampleAt(src, pos) * (0.25 + 0.75 * Math.pow(rate, 0.4));
      pos += rate;
    }
    if (damping === 'darkening') {
      lowpass2(out, (t) => 500 + 7000 * Math.pow(rateAt(t / dur), 0.7), 0.6);
    }
    if (rng.random() < 0.4) crush(out, rng.choice([7, 15, 31]), rng.randint(1, 4));

    tags = {
      style: 'tapestop',
      motion: dir,
      curve,
      damping,
      stop_ms: Math.round(dur * 1000),
      note: noteName(m),
    };
  } else if (style === 'jump') {
    // A read pointer landing wherever it likes, on block boundaries.
    const m = rng.randint(44, 76);
    const scale = rng.choice(SCALE_NAMES);
    const kind = rng.choice(['arpeggio', 'arpeggio', 'held tone', 'dyad', 'hat ticks', 'chord']);
    const shape = rng.choice(['sq', 'tri', 'saw']);
    const duty = rng.choice([0.125, 0.25, 0.5]);
    const order = rng.choice(['scrambled', 'ping-pong', 'ratcheting', 'walking']);
    const blockMs = rng.uniform(9, 46);
    const blocks = rng.randint(4, 16);
    const srcN = secs(rng.uniform(0.35, 0.85));
    const src = sourceCell(rng, srcN, kind, m, scale, shape, duty);

    const blkN = secs(blockMs / 1000);
    const pitches = [1.0, 1.0, 1.0, 0.5, 2.0, 1.5, 0.75];
    out = [];
    let offset = 0;
    let cursor = rng.randint(0, Math.max(0, srcN - blkN - 1));
    let held = cursor;
    let count = 0;
    for (let k = 0; k < blocks; k++) {
      if (order === 'scrambled') {
        cursor = rng.randint(0, Math.max(0, srcN - blkN - 1));
      } else if (order === 'ping-pong') {
        cursor = k % 2 === 0 ? held : Math.max(0, srcN - blkN - 1 - held);
      } else if (order === 'ratcheting') {
        if (k % rng.randint(2, 3) === 0) held = rng.randint(0, Math.max(0, srcN - blkN - 1));
        cursor = held;
      } else {
        cursor = (cursor + blkN + rng.randint(-blkN >> 1, blkN)) % Math.max(1, srcN - blkN - 1);
        if (cursor < 0) cursor += Math.max(1, srcN - blkN - 1);
      }
      const back = order === 'ping-pong' ? k % 2 === 1 : rng.random() < 0.28;
      const step = rng.choice(pitches);
      const blk = new Array(blkN);
      for (let i = 0; i < blkN; i++) {
        const off = i * step;
        blk[i] = sampleAt(src, back ? cursor + blkN - off : cursor + off);
      }
      shapeBlock(blk, Math.max(3, secs(0.0007)), Math.max(4, secs(0.0012)));
      mixAt(out, blk, offset, 1.0);
      offset += blkN;
      count++;
      if (offset >= MAX_N) break;
    }
    if (rng.random() < 0.4) crush(out, rng.choice([7, 15, 31]), rng.randint(1, 3));

    tags = {
      style: 'jump',
      content: cellWord(kind, shape),
      order,
      blocks: count,
      block_ms: r1(blockMs),
      note: noteName(m),
    };
  } else if (style === 'click') {
    // The DAC complaining: pops, ticks, an error ping, a zap.
    const flavor = rng.choice(['crackle', 'sputter', 'static burst', 'pop train']);
    const weight = rng.choice(['hard', 'soft', 'tiny']);
    const spread = rng.choice(['clustered', 'even', 'scattered']);
    const pops = rng.randint(2, 9);
    const gapMs = rng.uniform(6, 42);
    const m = rng.randint(72, 100);
    const amp = weight === 'hard' ? 1.0 : weight === 'soft' ? 0.6 : 0.35;

    const gapN = secs(gapMs / 1000);
    out = new Array(Math.max(MIN_N, pops * gapN + secs(0.03))).fill(0.0);
    for (let k = 0; k < pops; k++) {
      let at;
      if (spread === 'even') at = k * gapN;
      else if (spread === 'clustered') at = Math.round(k * gapN * rng.uniform(0.15, 0.6));
      else at = rng.randint(0, Math.max(1, pops * gapN - 1));
      const kindPop = rng.choice(
        flavor === 'static burst' ? ['tick', 'tick', 'dc pop'] : ['dc pop', 'tick', 'zap', 'dc pop']
      );
      const g = amp * rng.uniform(0.45, 1.0);
      if (kindPop === 'dc pop') {
        const tau = rng.uniform(0.0002, 0.0022);
        const len = secs(tau * 6);
        const sign = rng.choice([1, -1]);
        const blk = new Array(len);
        const rise = Math.max(1, secs(0.00008));
        for (let i = 0; i < len; i++) {
          const t = i / SR;
          blk[i] = sign * g * Math.min(1, i / rise) * Math.exp(-t / tau);
        }
        mixAt(out, blk, at, 1.0);
      } else if (kindPop === 'tick') {
        const len = secs(rng.uniform(0.0008, 0.005));
        const nz = noiseAt(rng, len, rng.randint(1, 2));
        const rate = rng.uniform(400, 2500);
        for (let i = 0; i < len; i++) nz[i] *= Math.exp((-rate * i) / SR);
        lowpass(nz, rng.uniform(3000, 9000));
        mixAt(out, nz, at, g);
      } else {
        const len = secs(rng.uniform(0.002, 0.007));
        const span = rng.uniform(10, 30);
        const f0 = midi(m);
        const blk = voice(len, (t) => f0 * Math.pow(2, (-span * t * SR) / len / 12), ampEnv(len / SR, 0.0004, 40, 0.001), 'sq', 0.25);
        mixAt(out, blk, at, g);
      }
    }
    // The error ping: one short pitched beep so the cluster has a key.
    const pingLen = secs(rng.uniform(0.004, 0.016));
    const ping = voice(pingLen, midi(m), ampEnv(pingLen / SR, 0.0004, rng.uniform(120, 420), 0.0012), rng.choice(['sq', 'tri']), rng.choice([0.125, 0.5]));
    mixAt(out, ping, spread === 'clustered' ? 0 : rng.randint(0, Math.max(1, pops * gapN - pingLen - 1)), 0.9 * amp);

    tags = {
      style: 'click',
      weight,
      flavor,
      spread,
      pops,
      gap_ms: r1(gapMs),
      note: noteName(m),
    };
  } else if (style === 'granular') {
    // A grain cloud: tiny windowed fragments scattered across a scale.
    const grains = rng.randint(16, 70);
    const grainMs = rng.uniform(3, 16);
    const root = rng.randint(48, 79);
    const scale = rng.choice(SCALE_NAMES);
    const density = rng.choice(['sparse', 'dense', 'swarming']);
    const material = rng.choice(['squares', 'triangles', 'saws', 'noise flecks', 'mixed grains']);
    const motion = rng.choice(['scattered', 'accelerating', 'settling', 'even spray', 'clustered']);
    const shape = material === 'triangles' ? 'tri' : material === 'saws' ? 'saw' : 'sq';
    const duty = rng.choice([0.125, 0.25, 0.5]);
    const lo = rng.randint(-7, 0);
    const hi = rng.randint(2, 12);
    const centres = [rng.uniform(0.12, 0.3), rng.uniform(0.55, 0.8)];
    // The cloud sets its own length: grain count times spacing. Otherwise a
    // sparse setting scatters 17 four-millisecond grains over a second and the
    // sample is mostly silence.
    const spacing = (grainMs * (density === 'swarming' ? 0.45 : density === 'dense' ? 0.8 : 1.7)) / 1000;
    const dur = Math.max(0.1, Math.min(0.9, grains * spacing));

    const n = secs(dur);
    out = new Array(n).fill(0.0);
    for (let k = 0; k < grains; k++) {
      const x = k / Math.max(1, grains - 1);
      let u;
      if (motion === 'even spray') u = x;
      else if (motion === 'accelerating') u = Math.pow(x, 1.9);
      else if (motion === 'settling') u = Math.pow(x, 0.5);
      else if (motion === 'clustered') u = clamp01(centres[k % 2] + rng.uniform(-0.11, 0.11));
      else u = rng.random();
      const at = Math.min(n - 2, Math.round(u * n));
      const len = Math.max(4, secs((grainMs * rng.uniform(0.55, 1.6)) / 1000));
      const g = rng.uniform(0.35, 1.0);
      const useNoise = material === 'noise flecks' || (material === 'mixed grains' && rng.random() < 0.4);
      let blk;
      if (useNoise) {
        blk = noiseAt(rng, len, rng.randint(1, 5));
      } else {
        const f = midi(scaleNote(root, scale, rng.randint(lo, hi)));
        blk = voice(len, f > NYQ ? NYQ : f, () => 1.0, shape, duty);
      }
      for (let i = 0; i < len; i++) blk[i] *= g * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)));
      mixAt(out, blk, at, 1.0);
    }
    if (density === 'sparse') highpass(out, rng.uniform(200, 700));
    if (density === 'swarming') drive(out, rng.uniform(1.5, 3.5));

    tags = {
      style: 'granular',
      material: `${density} ${material}`,
      motion,
      grains,
      grain_ms: r1(grainMs),
      note: noteName(root),
    };
  } else if (style === 'datachirp') {
    // Modem-style corruption: short chirps landing on scale degrees.
    const wanted = rng.randint(3, 12);
    const span = rng.randint(4, 26);
    const contour = rng.choice(['rising ladder', 'falling ladder', 'zigzag', 'scattered', 'stuck loop']);
    const shape = rng.choice(['sq', 'sq', 'saw', 'tri']);
    const grit = rng.choice(['clean', 'crushed', 'crushed', 'driven']);
    const duty = rng.choice([0.125, 0.25, 0.5, 0.375]);
    const root = rng.randint(52, 84);
    const scale = rng.choice(SCALE_NAMES);
    const chirpMs = rng.uniform(6, 30);
    const gapMs = rng.uniform(1, 24);
    const stride = rng.randint(1, 3);

    out = [];
    let offset = 0;
    let chirps = 0;
    for (let k = 0; k < wanted; k++) {
      let deg;
      if (contour === 'rising ladder') deg = k * stride;
      else if (contour === 'falling ladder') deg = -k * stride;
      else if (contour === 'zigzag') deg = (k % 2 === 0 ? 1 : -1) * (k + 1) * stride;
      else if (contour === 'stuck loop') deg = k % 2 === 0 ? 0 : stride;
      else deg = rng.randint(-6, 10);
      const up = contour === 'falling ladder' ? -1 : contour === 'zigzag' ? (k % 2 === 0 ? 1 : -1) : 1;
      const f0 = midi(scaleNote(root, scale, deg));
      const len = Math.max(4, secs((chirpMs * rng.uniform(0.6, 1.5)) / 1000));
      const dur = len / SR;
      const env = ampEnv(dur, 0.0006, rng.uniform(0, 30), Math.min(0.004, dur * 0.3));
      const blk = voice(len, (t) => f0 * Math.pow(2, (up * span * clamp01(t / dur)) / 12), env, shape, duty);
      mixAt(out, blk, offset, 1.0);
      offset += len + Math.max(1, secs((gapMs * rng.uniform(0.4, 1.6)) / 1000));
      chirps++;
      if (offset >= MAX_N) break;
    }
    if (grit === 'crushed') crush(out, rng.choice([3, 7, 15]), rng.randint(1, 5));
    if (grit === 'driven') drive(out, rng.uniform(2.0, 6.0));

    tags = {
      style: 'datachirp',
      contour,
      tone: `${grit} ${SHAPE_WORD[shape]}`,
      chirps,
      span_st: span,
      note: noteName(root),
    };
  } else if (style === 'dropout') {
    // Holes punched in a held source — silence, static, or a stuck grain.
    const dur = rng.uniform(0.2, 0.92);
    const n = secs(dur);
    const m = rng.randint(40, 74);
    const scale = rng.choice(SCALE_NAMES);
    const kind = rng.choice(['held tone', 'chord', 'dyad', 'arpeggio', 'hat ticks']);
    const shape = rng.choice(['sq', 'tri', 'saw']);
    const duty = rng.choice([0.125, 0.25, 0.5]);
    const fill = rng.choice(['silent', 'silent', 'static', 'stuck-note', 'crushed']);
    const bpm = rng.randint(88, 170);
    const div = rng.choice(DIVS);
    const grid = rng.choice(['grid', 'grid', 'random']);
    const wanted = rng.randint(2, 9);

    out = sourceCell(rng, n, kind, m, scale, shape, duty);
    const unit = grid === 'grid' ? secs(60.0 / bpm / div[1]) : secs(rng.uniform(0.012, 0.07));
    const xf = Math.max(2, secs(0.0008));
    let covered = 0;
    let holes = 0;
    for (let k = 0; k < wanted; k++) {
      const len = Math.min(unit * rng.randint(1, 2), Math.round(n * 0.3));
      if (len < 4 || covered + len > n * 0.55) break;
      const at = grid === 'grid'
        ? Math.min(n - len - 1, rng.randint(0, Math.max(1, Math.floor(n / unit) - 1)) * unit)
        : rng.randint(0, Math.max(1, n - len - 1));
      if (at < 0) continue;
      let patch = new Array(len).fill(0.0);
      if (fill === 'static') {
        patch = noiseAt(rng, len, rng.randint(1, 4));
        const g = rng.uniform(0.25, 0.7);
        for (let i = 0; i < len; i++) patch[i] *= g;
        highpass(patch, rng.uniform(400, 2500));
      } else if (fill === 'stuck-note') {
        const grain = Math.max(8, secs(rng.uniform(0.004, 0.02)));
        const from = Math.max(0, at - grain);
        for (let i = 0; i < len; i++) patch[i] = out[from + (i % grain)] || 0.0;
      } else if (fill === 'crushed') {
        for (let i = 0; i < len; i++) patch[i] = out[at + i] || 0.0;
        crush(patch, rng.choice([1, 2, 3]), rng.randint(4, 30));
      }
      for (let i = 0; i < len && at + i < n; i++) {
        const w = Math.min(1, Math.min(i, len - 1 - i) / xf);
        out[at + i] = out[at + i] * (1 - w) + patch[i] * w;
      }
      covered += len;
      holes++;
    }
    if (holes === 0) holes = 1;

    tags = {
      style: 'dropout',
      source: cellWord(kind, shape),
      fill,
      grid: grid === 'grid' ? `${div[0]} grid` : 'off-grid',
      holes,
      bpm,
      note: noteName(m),
    };
  } else if (style === 'scrub') {
    // A jog wheel on the buffer: forward, back, and the pitch that implies.
    const motion = rng.choice(['jogging', 'rewinding', 'wobbling', 'ratcheting']);
    const grit = rng.choice(['clean', 'gritty', 'crushed']);
    const dur = rng.uniform(0.12, 0.9);
    const n = secs(dur);
    const m = rng.randint(42, 74);
    const scale = rng.choice(SCALE_NAMES);
    const kind = rng.choice(['arpeggio', 'held tone', 'chord', 'hat ticks', 'dyad']);
    const shape = rng.choice(['sq', 'tri', 'saw']);
    const duty = rng.choice([0.125, 0.25, 0.5]);
    const srcN = Math.round(n * rng.uniform(1.0, 1.8));
    const src = sourceCell(rng, srcN, kind, m, scale, shape, duty);

    const passes = rng.randint(2, 7);
    const wobHz = rng.uniform(3, 22);
    const segN = Math.max(1, Math.floor(n / passes));
    // Scrub speeds are semitone ratios, never arbitrary: a jog wheel that lands
    // on -5 stays in key with the note this was built from, where a uniform
    // speed would detune the whole cell by a fraction of a semitone and make
    // the sample unusable next to anything else in the track.
    const speeds = new Array(passes);
    let shiftSt = 0;
    for (let k = 0; k < passes; k++) {
      const st = rng.choice([-24, -19, -17, -12, -12, -7, -7, -5, -3, 0, 0, 4, 5, 7, 7, 12, 12, 16, 19]);
      const mag = Math.pow(2, st / 12);
      if (Math.abs(st) > Math.abs(shiftSt)) shiftSt = st;
      speeds[k] = motion === 'rewinding'
        ? (k % 2 === 0 ? -mag : mag)
        : motion === 'ratcheting' ? mag * rng.choice([1, 1, -1]) : (k % 2 === 0 ? mag : -mag);
    }
    const top = Math.max(...speeds.map((v) => (v < 0 ? -v : v)));
    out = new Array(n);
    let pos = rng.uniform(0, Math.max(1, srcN * 0.3));
    for (let i = 0; i < n; i++) {
      let v;
      if (motion === 'wobbling') {
        v = top * Math.sin(2 * Math.PI * wobHz * (i / SR));
      } else {
        v = speeds[Math.min(passes - 1, Math.floor(i / segN))];
      }
      pos += v;
      if (pos < 0) pos = -pos;
      if (pos > srcN - 2) pos = 2 * (srcN - 2) - pos;
      if (!(pos >= 0)) pos = 0;
      out[i] = sampleAt(src, pos);
    }
    if (grit === 'gritty') drive(out, rng.uniform(1.8, 4.5));
    if (grit === 'crushed') crush(out, rng.choice([3, 7, 15]), rng.randint(2, 8));

    tags = {
      style: 'scrub',
      motion,
      grit,
      content: cellWord(kind, shape),
      passes,
      shift_st: shiftSt,
      note: noteName(m),
    };
  } else {
    // ringmod — two oscillators multiplied at an inharmonic ratio.
    const m = rng.randint(40, 76);
    const cShape = rng.choice(['sq', 'tri', 'saw']);
    const mShape = rng.choice(['sq', 'tri']);
    const motion = rng.choice(['static', 'sweeping', 'sweeping', 'wobbling']);
    const grit = rng.choice(['clean', 'crushed', 'crushed', 'hard-driven']);
    const ratio0 = rng.uniform(1.15, 5.4);
    const ratio1 = motion === 'sweeping' ? ratio0 * rng.uniform(0.3, 2.8) : ratio0;
    const wobHz = rng.uniform(5, 70);
    const wobD = motion === 'wobbling' ? rng.uniform(0.06, 0.45) : 0.0;
    const dur = rng.uniform(0.07, 0.6);
    const n = secs(dur);
    const env = ampEnv(dur, rng.uniform(0.0008, 0.005), rng.uniform(1.0, 14.0), rng.uniform(0.008, 0.07));
    const f0 = midi(m);
    const car = voice(n, f0, env, cShape, rng.choice([0.125, 0.25, 0.5]));
    const ratAt = (t) => {
      const u = clamp01(t / dur);
      return (ratio0 + (ratio1 - ratio0) * u) * (1.0 + wobD * Math.sin(2 * Math.PI * wobHz * t));
    };
    const mod = voice(n, (t) => f0 * ratAt(t), () => 1.0, mShape, 0.5);
    out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = car[i] * mod[i];
    if (grit === 'crushed') crush(out, rng.choice([3, 7, 15]), rng.randint(1, 6));
    if (grit === 'hard-driven') drive(out, rng.uniform(2.5, 8.0));
    if (rng.random() < 0.4) lowpass(out, rng.uniform(2500, 9000));

    tags = {
      style: 'ringmod',
      tone: `${SHAPE_WORD[cShape]} x ${SHAPE_WORD[mShape]}`,
      motion,
      grit,
      ratio: r2(ratio0),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every artifact inside 0.06 - 0.97 s. The DC block runs FIRST: a tape
  // stop that freezes, or a scrub that parks on a sample, leaves a near-DC
  // plateau that reads as loud here but is silent once blocked — trimming
  // before blocking would keep it and ship a sample of nothing.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  dcBlock(out, 0.996);
  out = trimEnds(out, 4, 18);
  while (out.length < MIN_N) out.push(0.0);
  if (peakOf(out) < 1e-4) {
    // Belt and braces: a variation that mangled itself into silence still has
    // to be an audible sample.
    const len = Math.min(out.length, secs(0.05));
    const blip = voice(len, midi(60), ampEnv(len / SR, 0.001, 24, 0.006), 'sq', 0.25);
    mixAt(out, blip, 0, 1.0);
  }
  // De-click both edges before normalizing, so the peak lands exactly on target
  // even when the loudest sample sits inside the fade.
  fadeEdges(out, Math.min(14, out.length >> 3), Math.min(out.length >> 2, Math.max(24, secs(0.005))));
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const w = (v, d) => (typeof v === 'string' && v ? v : d);
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const int = (v, d) => Math.trunc(num(v, d));
  const note = w(t.note, 'C4');
  switch (t.style) {
    case 'stutter':
      return `buffer stutter — ${w(t.gate, 'seamless')} ${w(t.source, 'square tone')} ${w(t.motion, 'even')}, ${int(t.reps, 4)} x ${w(t.division, '16th')} at ${int(t.bpm, 120)} BPM, ${note}`;
    case 'bitcrush':
      return `bitcrush burst — ${w(t.tone, 'square tone')} ${w(t.motion, 'crumbling')}, ${int(t.bits, 3)}-bit at ${int(t.rate_hz, 4000)} Hz, ${note}`;
    case 'srmangle':
      return `sample-rate mangle — ${w(t.motion, 'wobbling')} ${w(t.texture, 'aliased')}, ${int(t.steps, 7)} steps, ${int(t.floor_hz, 900)} Hz floor, ${note}`;
    case 'tapestop':
      return t.motion === 'spin-up'
        ? `tape spin-up — ${w(t.curve, 'even')}, ${w(t.damping, 'darkening')}, ${int(t.stop_ms, 400)} ms up to ${note}`
        : `tape-stop collapse — ${w(t.curve, 'even')}, ${w(t.damping, 'darkening')}, ${int(t.stop_ms, 400)} ms from ${note}`;
    case 'jump':
      return `random-jump garble — ${w(t.content, 'square arpeggio')} ${w(t.order, 'scrambled')}, ${int(t.blocks, 8)} blocks of ${num(t.block_ms, 20).toFixed(1)} ms, ${note}`;
    case 'click':
      return `digital ${w(t.flavor, 'crackle')} — ${w(t.weight, 'hard')} and ${w(t.spread, 'even')}, ${int(t.pops, 4)} pops ${num(t.gap_ms, 20).toFixed(1)} ms apart, ${note}`;
    case 'granular':
      return `granular scatter — ${w(t.motion, 'scattered')} ${w(t.material, 'dense squares')}, ${int(t.grains, 40)} x ${num(t.grain_ms, 8).toFixed(1)} ms, ${note}`;
    case 'datachirp':
      return `data-corruption chirps — ${w(t.contour, 'zigzag')} ${w(t.tone, 'crushed square')}, ${int(t.chirps, 6)} sweeps over ${int(t.span_st, 12)} st, ${note}`;
    case 'dropout': {
      const holes = int(t.holes, 4);
      return `digital dropout — ${w(t.source, 'square tone')}, ${holes} ${w(t.fill, 'silent')} ${w(t.grid, '16th grid')} hole${holes === 1 ? '' : 's'} at ${int(t.bpm, 120)} BPM, ${note}`;
    }
    case 'scrub': {
      const st = int(t.shift_st, 0);
      const shift = st === 0 ? 'unison' : `${st > 0 ? '+' : ''}${st} st`;
      return `buffer scrub — ${w(t.motion, 'jogging')} ${w(t.content, 'square arpeggio')}, ${w(t.grit, 'clean')}, ${int(t.passes, 3)} passes at ${shift}, ${note}`;
    }
    default:
      return `ring-mod corruption — ${w(t.motion, 'static')} ${w(t.tone, 'square x square')}, ${w(t.grit, 'crushed')}, ${num(t.ratio, 2).toFixed(2)}x over ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'buffer stutters, bitcrush bursts, tape stops, garbled data chirps';
