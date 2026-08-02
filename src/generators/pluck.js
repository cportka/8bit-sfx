// pluck — pitched plucks and mallets, eleven ways. Everything here is a *note*:
// the fundamental is an exact MIDI number between C2 and C6, so a marimba line
// or a harp roll drops into a track next to the bass and leads without
// retuning. Where `perc` hits and `bell` rings, these attack hard and let go —
// the short, tuned voices a chip beat is actually built out of.
//
// The eleven sub-styles are the plucked/struck vocabulary: a Karplus-Strong
// harp string, a marimba bar tuned on its 4th partial, a xylophone tuned on its
// 3rd, a koto with a bent attack and a buzzing sawari, a palm-muted staccato
// stab, a glassy ring-modulated chime, an octave-doubled pluck, a soft round
// mallet, a damped pizzicato with a body thock, a bitcrushed digital pluck, and
// a two-to-five hit mallet roll.
//
// The acoustic instruments are caricatures, not samples: naive squares and
// triangles for the partials, LFSR noise for mallet and fingernail transients,
// hand-rolled one-pole filters, a delay line with a two-tap damper for the
// strings, and sample-and-hold plus level crush for the digital ones. Post
// chain is uniform — DC block (narrow-duty squares carry a bias), de-click both
// edges, then normalize last so the peak is exact even when the loudest sample
// sits inside the first millisecond.

import {
  SR, Lfsr, square, triangle, midi, noteName, renderTone, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.1 * SR);
const MAX_N = Math.round(1.2 * SR);

/** Seconds to a sample count, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

/** One-pole coefficient for a cutoff in Hz. */
function alphaOf(cut) {
  return 1.0 - Math.exp((-2.0 * Math.PI * Math.max(20, Math.min(SR * 0.45, cut))) / SR);
}

/** "12.5% duty" / "25% duty" / "50% duty". */
function dutyLabel(d) {
  return `${d * 100}% duty`;
}

/** How a voice is described in the catalog. */
function toneLabel(wave, duty) {
  return wave === 'tri' ? 'triangle' : wave === 'saw' ? 'sawtooth' : dutyLabel(duty);
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
 * Linear attack, exponential decay, and a release taper into the note's end so
 * the tail always reaches zero however hard the string is still ringing.
 */
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

/** Lowpassed LFSR burst — the mallet head, the fingernail, the pick scrape. */
function noiseBurst(rng, n, period, cut, atk, rate) {
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

/**
 * Hand-rolled Karplus-Strong string: a delay line filled with LFSR noise, a
 * two-tap damping filter, and a per-sample loss. The line length carries a
 * fractional part read by linear interpolation and is shortened by the damper's
 * own delay, so the loop period is exactly SR/freq — these land in tune.
 *
 * @param {number} n samples
 * @param {number} freq fundamental in Hz
 * @param {number} bright damper mix, 0.2 (dark, fast HF loss) .. 0.85 (wiry)
 * @param {number} loss per-sample amplitude loss, just under 1
 * @param {Float64Array} seed excitation, one value per delay-line slot
 */
function ksString(n, freq, bright, loss, seedFn) {
  const b = Math.max(0.2, Math.min(0.85, bright));
  const need = Math.max(2.0, SR / Math.max(20, freq) - (1.0 - b));
  const di = Math.floor(need);
  const frac = need - di;
  const size = di + 2;
  const line = new Float64Array(size);
  const seed = seedFn(size);
  for (let i = 0; i < size; i++) line[i] = seed[i];
  const g = Math.max(0.0, Math.min(0.99995, loss));
  const out = new Array(n);
  let w = 0;
  let prev = 0.0;
  for (let i = 0; i < n; i++) {
    const r0 = (w - di + size + size) % size;
    const r1 = (w - di - 1 + size + size) % size;
    const v = line[r0] * (1.0 - frac) + line[r1] * frac;
    const y = (b * v + (1.0 - b) * prev) * g;
    prev = v;
    line[w] = y;
    w = w + 1 === size ? 0 : w + 1;
    out[i] = y;
  }
  return out;
}

/** Excitation for the delay line: LFSR noise, softened and DC-free. */
function stringSeed(rng, period, cut) {
  return (size) => {
    const lf = new Lfsr(rng, period);
    const a = alphaOf(cut);
    const arr = new Float64Array(size);
    let p = 0.0;
    let sum = 0.0;
    for (let i = 0; i < size; i++) {
      p += a * (lf.next() - p);
      arr[i] = p;
      sum += p;
    }
    const mean = sum / size; // a DC-biased line would ring forever on nothing
    for (let i = 0; i < size; i++) arr[i] -= mean;
    return arr;
  };
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'harp', 'marimba', 'xylo', 'koto', 'muted', 'glass',
    'octave', 'mallet', 'pizz', 'crush', 'roll',
  ]);

  let out;
  let tags;

  if (style === 'harp') {
    // Karplus-Strong wire: a long, bright ring, optionally rolled into a
    // second string a third/fifth/octave up like a harp gliss fragment.
    const m = rng.randint(45, 76); // A2..E5
    const f = midi(m);
    const dur = rng.uniform(0.5, 1.15);
    const n = secs(dur);
    const bright = rng.uniform(0.42, 0.8);
    const ring = rng.uniform(1.4, 5.5);
    const soft = rng.uniform(1400, 9000); // pick softness: excitation cutoff
    const body = ksString(n, f, bright, Math.exp(-ring / SR), stringSeed(rng, rng.randint(1, 2), soft));
    const env = pluckEnv(0.0006, 0.0, dur, Math.max(0.03, dur * 0.22));
    for (let i = 0; i < n; i++) body[i] *= env(i / SR);
    out = [];
    mixAt(out, body, 0, 1.0);
    const rollOff = rng.choice([0, 0, 3, 4, 5, 7, 12]);
    const rolled = rollOff > 0;
    if (rolled) {
      const m2 = Math.min(84, m + rollOff);
      const d2 = dur * rng.uniform(0.55, 0.9);
      const n2 = secs(d2);
      const v2 = ksString(n2, midi(m2), bright * rng.uniform(0.9, 1.1), Math.exp(-(ring * 1.3) / SR),
        stringSeed(rng, rng.randint(1, 2), soft * rng.uniform(0.8, 1.3)));
      const e2 = pluckEnv(0.0006, 0.0, d2, Math.max(0.02, d2 * 0.25));
      for (let i = 0; i < n2; i++) v2[i] *= e2(i / SR);
      mixAt(out, v2, secs(rng.uniform(0.02, 0.075)), rng.uniform(0.45, 0.8));
    }
    const cut = Math.min(SR * 0.4, f * rng.uniform(7.0, 20.0));
    lowpass(out, cut);
    tags = {
      style: 'harp',
      string: soft > 4200 ? 'wire' : 'gut',
      touch: bright > 0.62 ? 'nailed' : 'soft',
      voicing: rolled ? 'rolled pair' : 'single string',
      bright_hz: Math.round(cut),
      note: noteName(m),
    };
  } else if (style === 'marimba') {
    // Rosewood bar: fundamental plus the tuned 4th partial, soft yarn head.
    const m = rng.randint(45, 79); // A2..G5
    const f = midi(m);
    const dur = rng.uniform(0.3, 0.95);
    const n = secs(dur);
    const ratio = rng.uniform(3.85, 4.18);
    const rate = rng.uniform(4.0, 9.5);
    const atk = rng.uniform(0.002, 0.007);
    const rel = Math.max(0.03, dur * 0.2);
    out = renderTone(n, () => f, 0.5, pluckEnv(atk, rate, dur, rel), 'tri');
    const upG = rng.uniform(0.18, 0.55);
    mixAt(out, renderTone(n, () => f * ratio, 0.5,
      pluckEnv(atk * 0.6, rate * rng.uniform(2.0, 3.4), dur, rel), 'tri'), 0, upG);
    const third = rng.random() < 0.45;
    if (third) {
      mixAt(out, renderTone(n, () => f * rng.uniform(9.0, 10.4), 0.5,
        pluckEnv(0.001, rate * 5.0, dur, rel), 'tri'), 0, rng.uniform(0.05, 0.16));
    }
    const headG = rng.uniform(0.06, 0.3);
    mixAt(out, noiseBurst(rng, Math.min(n, secs(0.012)), rng.randint(2, 5), f * 5.0, 0.0008, rng.uniform(180, 460)), 0, headG);
    lowpass(out, Math.min(SR * 0.4, f * rng.uniform(5.0, 11.0)));
    tags = {
      style: 'marimba',
      bar: third ? 'rosewood' : 'padauk',
      mallet: headG > 0.18 ? 'cord' : 'yarn',
      ring: rate < 6.2 ? 'blooming' : 'dry',
      partial: Math.round(ratio * 100) / 100,
      note: noteName(m),
    };
  } else if (style === 'xylo') {
    // Xylophone bar: tuned on the 3rd partial, hard head, brighter and drier.
    const m = rng.randint(60, 84); // C4..C6
    const f = midi(m);
    const dur = rng.uniform(0.16, 0.55);
    const n = secs(dur);
    const ratio = rng.uniform(2.9, 3.12);
    const rate = rng.uniform(9.0, 20.0);
    const rel = Math.max(0.02, dur * 0.25);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    out = renderTone(n, () => f, duty, pluckEnv(0.0009, rate, dur, rel), wave);
    mixAt(out, renderTone(n, () => f * ratio, 0.5, pluckEnv(0.0006, rate * rng.uniform(1.4, 2.4), dur, rel), 'tri'),
      0, rng.uniform(0.3, 0.7));
    const glassy = rng.random() < 0.4;
    if (glassy) {
      mixAt(out, renderTone(n, () => f * rng.uniform(5.8, 6.4), 0.5, pluckEnv(0.0004, rate * 3.0, dur, rel), 'tri'),
        0, rng.uniform(0.08, 0.2));
    }
    const tick = rng.uniform(0.12, 0.4);
    mixAt(out, noiseBurst(rng, Math.min(n, secs(0.006)), 1, f * 9.0, 0.0004, rng.uniform(500, 1100)), 0, tick);
    const cut = Math.min(SR * 0.42, f * rng.uniform(7.0, 14.0));
    lowpass(out, cut);
    tags = {
      style: 'xylo',
      strike: tick > 0.26 ? 'hard plastic' : 'wood',
      body: glassy ? 'glassy' : 'hollow',
      tone: toneLabel(wave, duty),
      ratio: Math.round(ratio * 100) / 100,
      note: noteName(m),
    };
  } else if (style === 'koto') {
    // Koto/shamisen: the pitch bends into place under the plectrum and the
    // sawari bridge buzzes a crushed partial over the top.
    const m = rng.randint(40, 74); // E2..D5
    const f = midi(m);
    const dur = rng.uniform(0.35, 1.15);
    const n = secs(dur);
    const bendSemi = rng.choice([0, 0, 1, 2, -1, -2]);
    const btau = rng.uniform(0.012, 0.05);
    const rate = rng.uniform(2.4, 6.0);
    const wave = rng.choice([null, null, 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const rel = Math.max(0.03, dur * 0.2);
    out = renderTone(n, (t) => f * Math.pow(2.0, (bendSemi * Math.exp(-t / btau)) / 12.0), duty,
      pluckEnv(0.0008, rate, dur, rel), wave);
    const buzzRatio = rng.uniform(4.6, 8.4);
    const buzzG = rng.uniform(0.08, 0.32);
    const buzz = renderTone(n, () => f * buzzRatio, 0.5, pluckEnv(0.001, rate * rng.uniform(2.5, 4.5), dur, rel), null);
    crush(buzz, rng.randint(2, 5), rng.randint(2, 6));
    mixAt(out, buzz, 0, buzzG);
    mixAt(out, noiseBurst(rng, Math.min(n, secs(0.008)), rng.randint(1, 3), f * 8.0, 0.0004, rng.uniform(320, 800)),
      0, rng.uniform(0.08, 0.26));
    lowpass(out, (t) => Math.min(SR * 0.4, f * (3.0 + 9.0 * Math.exp(-t / rng.uniform(0.05, 0.2)))));
    tags = {
      style: 'koto',
      buzz: buzzG > 0.2 ? 'wiry' : 'dry',
      bend: bendSemi === 0 ? 'straight' : bendSemi > 0 ? 'oshide fall' : 'scooped',
      tone: toneLabel(wave, duty),
      buzz_hz: Math.round(f * buzzRatio),
      note: noteName(m),
    };
  } else if (style === 'muted') {
    // Palm-muted staccato: choked, dark, and gone — the chip equivalent of a
    // hand resting on the strings. Sometimes a double stab.
    const m = rng.randint(36, 72); // C2..C5
    const f = midi(m);
    const dur = rng.uniform(0.11, 0.3);
    const n = secs(dur);
    // A hard choke on a low string kills the note before a single cycle lands,
    // so the damping tracks the pitch: low stabs stay short but stay *pitched*.
    const rate = Math.min(rng.uniform(16.0, 46.0), f * 0.25);
    const wave = rng.choice([null, null, 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const damp = Math.min(SR * 0.35, f * rng.uniform(1.6, 4.5));
    const hit = renderTone(n, () => f, duty, pluckEnv(0.0007, rate, dur, Math.max(0.012, dur * 0.3)), wave);
    lowpass(hit, damp);
    mixAt(hit, noiseBurst(rng, Math.min(n, secs(0.005)), rng.randint(2, 6), f * 4.0, 0.0004, rng.uniform(600, 1400)),
      0, rng.uniform(0.05, 0.22));
    const twice = rng.random() < 0.35;
    const gap = rng.uniform(0.06, 0.14);
    out = [];
    mixAt(out, hit, 0, 1.0);
    if (twice) mixAt(out, hit, secs(gap), rng.uniform(0.55, 0.9));
    tags = {
      style: 'muted',
      damp: rate > 32 ? 'choked' : 'palm',
      tone: toneLabel(wave, duty),
      hits: twice ? 'double stab' : 'single stab',
      damp_hz: Math.round(damp),
      note: noteName(m),
    };
  } else if (style === 'glass') {
    // Glassy pluck: a triangle rung through a square ring-modulator at a
    // near-harmonic ratio, with a slow shimmer on the tail.
    const m = rng.randint(62, 84); // D4..C6
    const f = midi(m);
    const dur = rng.uniform(0.45, 1.2);
    const n = secs(dur);
    const ratio = rng.choice([2.0, 3.0, 4.0, 5.0, 2.76, 3.47]);
    const depth = rng.uniform(0.12, 0.44);
    const rate = rng.uniform(2.2, 6.5);
    const rel = Math.max(0.04, dur * 0.25);
    out = renderTone(n, () => f, 0.5, pluckEnv(0.0015, rate, dur, rel), 'tri');
    let mp = 0.0;
    for (let i = 0; i < n; i++) {
      mp += (f * ratio) / SR;
      out[i] *= 1.0 - depth + depth * square(mp, 0.5);
    }
    const tremHz = rng.uniform(0.0, 8.0);
    const trem = tremHz > 3.0;
    if (trem) {
      const d2 = rng.uniform(0.12, 0.35);
      for (let i = 0; i < n; i++) out[i] *= 1.0 - d2 * 0.5 * (1.0 - Math.cos(2 * Math.PI * tremHz * (i / SR)));
    }
    mixAt(out, renderTone(n, () => f * 2.0, 0.5, pluckEnv(0.001, rate * rng.uniform(1.8, 3.2), dur, rel), 'tri'),
      0, rng.uniform(0.1, 0.3));
    highpass(out, f * 0.5);
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(6.0, 13.0)));
    tags = {
      style: 'glass',
      shimmer: ratio % 1 === 0 ? 'chime' : 'ice bowl',
      tail: trem ? 'tremolo tail' : 'still tail',
      touch: depth > 0.3 ? 'hollow' : 'pure',
      ratio: Math.round(ratio * 100) / 100,
      note: noteName(m),
    };
  } else if (style === 'octave') {
    // Octave-doubled: the oldest trick in the chip book — two voices locked an
    // octave (or two) apart so a thin pluck reads as a big one.
    const m = rng.randint(36, 69); // C2..A4
    const f = midi(m);
    const dur = rng.uniform(0.2, 0.8);
    const n = secs(dur);
    const pairing = rng.choice(['octave up', 'two octaves up', 'octave plus fifth', 'octave down']);
    const offs = pairing === 'two octaves up' ? 24 : pairing === 'octave plus fifth' ? 19 : pairing === 'octave down' ? -12 : 12;
    const m2 = Math.max(24, Math.min(84, m + offs));
    const wave = rng.choice([null, 'tri', 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const rate = rng.uniform(4.5, 14.0);
    const rel = Math.max(0.025, dur * 0.25);
    out = renderTone(n, () => f, duty, pluckEnv(0.0008, rate, dur, rel), wave);
    const mix = rng.uniform(0.3, 0.95);
    const flamS = rng.uniform(0.0, 0.02);
    const flam = flamS > 0.008;
    const up = renderTone(n, () => midi(m2), rng.choice([0.5, 0.25]),
      pluckEnv(0.0006, rate * rng.uniform(1.1, 2.2), dur, rel), rng.choice([null, 'tri']));
    mixAt(out, up, flam ? secs(flamS) : 0, mix);
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(8.0, 22.0)));
    tags = {
      style: 'octave',
      pairing,
      tone: toneLabel(wave, duty),
      lock: flam ? 'flammed' : 'tight',
      mix_pct: Math.round(mix * 100),
      note: noteName(m),
    };
  } else if (style === 'mallet') {
    // Soft round mallet: a slow-ish felt attack, a warm lowpassed body, and a
    // gentle bloom as the bar settles. The friendliest voice in the set.
    const m = rng.randint(38, 74); // D2..D5
    const f = midi(m);
    const dur = rng.uniform(0.25, 1.05);
    const n = secs(dur);
    const atk = rng.uniform(0.004, 0.018);
    const rate = rng.uniform(3.0, 9.0);
    const rel = Math.max(0.035, dur * 0.24);
    const warm = Math.min(SR * 0.35, f * rng.uniform(2.6, 7.0));
    out = renderTone(n, () => f, 0.5, pluckEnv(atk, rate, dur, rel), 'tri');
    const partG = rng.uniform(0.08, 0.34);
    mixAt(out, renderTone(n, () => f * rng.uniform(1.98, 2.05), 0.5,
      pluckEnv(atk * 1.2, rate * rng.uniform(1.6, 2.6), dur, rel), 'tri'), 0, partG);
    const bloom = rng.uniform(0.0, 0.06);
    const blooming = bloom > 0.025;
    if (blooming) {
      // the body opens for a moment before it closes, like a struck resonator
      lowpass(out, (t) => warm * (1.0 + 1.4 * Math.min(1.0, t / bloom) * Math.exp(-t / (bloom * 4.0))));
    } else {
      lowpass(out, warm);
    }
    mixAt(out, noiseBurst(rng, Math.min(n, secs(0.014)), rng.randint(3, 8), f * 3.0, 0.002, rng.uniform(120, 340)),
      0, rng.uniform(0.04, 0.18));
    tags = {
      style: 'mallet',
      head: atk > 0.011 ? 'felt' : 'yarn',
      body: partG > 0.2 ? 'woody' : 'round',
      swell: blooming ? 'blooming' : 'plain',
      warm_hz: Math.round(warm),
      note: noteName(m),
    };
  } else if (style === 'pizz') {
    // Pizzicato: a heavily damped string with the fingerboard thock under it.
    const m = rng.randint(40, 76); // E2..E5
    const f = midi(m);
    const dur = rng.uniform(0.14, 0.5);
    const n = secs(dur);
    const bright = rng.uniform(0.25, 0.55);
    const ring = rng.uniform(9.0, 26.0);
    const nail = rng.random() < 0.5;
    const body = ksString(n, f, bright, Math.exp(-ring / SR),
      stringSeed(rng, rng.randint(1, 3), nail ? rng.uniform(4000, 9000) : rng.uniform(900, 3000)));
    const env = pluckEnv(0.0005, 0.0, dur, Math.max(0.02, dur * 0.3));
    for (let i = 0; i < n; i++) body[i] *= env(i / SR);
    out = [];
    mixAt(out, body, 0, 1.0);
    const boxHz = f * rng.uniform(1.8, 4.2);
    mixAt(out, noiseBurst(rng, Math.min(n, secs(0.01)), rng.randint(2, 6), boxHz, 0.0006, rng.uniform(240, 700)),
      0, rng.uniform(0.1, 0.35));
    highpass(out, f * 0.4);
    lowpass(out, Math.min(SR * 0.4, f * rng.uniform(5.0, 14.0)));
    tags = {
      style: 'pizz',
      string: bright > 0.42 ? 'steel' : 'gut',
      snap: nail ? 'nail' : 'finger pad',
      damp: ring > 17 ? 'choked' : 'open',
      body_hz: Math.round(boxHz),
      note: noteName(m),
    };
  } else if (style === 'crush') {
    // Bitcrushed pluck: a clean tuned attack shoved through sample-and-hold and
    // a coarse level crush, so the tail aliases into chip grit.
    const m = rng.randint(48, 84); // C3..C6
    const f = midi(m);
    const dur = rng.uniform(0.14, 0.6);
    const n = secs(dur);
    const wave = rng.choice([null, 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const rate = rng.uniform(6.0, 20.0);
    const rel = Math.max(0.02, dur * 0.28);
    const snap = rng.uniform(0.0, 0.06);
    const stau = rng.uniform(0.004, 0.02);
    out = renderTone(n, (t) => f * (1.0 + snap * Math.exp(-t / stau)), duty,
      pluckEnv(0.0006, rate, dur, rel), wave);
    const steps = rng.randint(3, 13);
    const hold = rng.randint(2, 9);
    crush(out, steps, hold);
    const ghost = rng.random() < 0.4;
    if (ghost) {
      mixAt(out, renderTone(n, () => f * 2.0, 0.5, pluckEnv(0.0004, rate * 2.0, dur, rel), 'tri'),
        0, rng.uniform(0.1, 0.3));
    }
    lowpass(out, Math.min(SR * 0.42, f * rng.uniform(6.0, 18.0)));
    tags = {
      style: 'crush',
      grit: steps < 7 ? 'coarse' : 'fine',
      tone: toneLabel(wave, duty),
      attack: snap > 0.03 ? 'snapped' : 'flat',
      steps,
      rate_hz: Math.round(SR / hold),
      note: noteName(m),
    };
  } else {
    // Mallet roll: two to five quick strikes — a repeated roll, a grace note
    // into the main pitch, an octave alternation, or a small ascent.
    const m = rng.randint(48, 79); // C3..G5
    const f = midi(m);
    const pat = rng.choice([
      { name: 'buzz roll', offs: [0, 0, 0, 0, 0] },
      { name: 'grace note', offs: [-2, 0, 0, 0, 0] },
      { name: 'octave roll', offs: [0, 12, 0, 12, 0] },
      { name: 'rising third', offs: [0, 3, 7, 12, 15] },
      { name: 'falling third', offs: [12, 7, 3, 0, -5] },
    ]);
    const hits = pat.name === 'grace note' ? 2 : rng.randint(3, 5);
    const step = rng.uniform(0.05, 0.15);
    const accel = rng.uniform(0.75, 1.12);
    const swing = rng.uniform(0.0, 0.16);
    const feel = accel < 0.9 ? 'accelerating' : swing > 0.08 ? 'swung' : 'even';
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    const hitDur = rng.uniform(0.16, 0.42);
    const rate = rng.uniform(7.0, 18.0);
    out = [];
    let at = 0.0;
    let gap = step;
    for (let k = 0; k < hits; k++) {
      const last = k === hits - 1;
      const d = last ? Math.min(0.5, hitDur * rng.uniform(1.2, 1.8)) : hitDur;
      const hn = secs(d);
      const mk = Math.max(24, Math.min(84, m + pat.offs[Math.min(k, pat.offs.length - 1)]));
      const fk = midi(mk);
      const rel = Math.max(0.02, d * 0.26);
      const v = renderTone(hn, () => fk, duty, pluckEnv(0.0015, rate, d, rel), wave);
      mixAt(v, renderTone(hn, () => fk * rng.uniform(3.9, 4.1), 0.5, pluckEnv(0.001, rate * 2.4, d, rel), 'tri'),
        0, rng.uniform(0.12, 0.4));
      const off = at + (k % 2 === 1 ? swing * gap : 0.0);
      if (off > 1.15) break;
      mixAt(out, v, secs(off), k === 0 ? 1.0 : rng.uniform(0.55, 1.0));
      at += gap;
      gap *= accel;
    }
    mixAt(out, noiseBurst(rng, Math.min(out.length, secs(0.01)), rng.randint(2, 6), f * 5.0, 0.0009, rng.uniform(200, 520)),
      0, rng.uniform(0.05, 0.2));
    lowpass(out, Math.min(SR * 0.4, f * rng.uniform(5.0, 12.0)));
    tags = {
      style: 'roll',
      pattern: pat.name,
      feel,
      tone: toneLabel(wave, duty),
      hits,
      bpm: Math.round(7.5 / step), // each strike is a thirty-second note
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every pluck inside 0.1 - 1.2 s, block the duty-cycle DC bias, then
  // de-click both edges before normalizing so the peak is exact even when the
  // loudest sample sits inside the first millisecond.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  const fi = Math.min(out.length >> 2, 12);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.004 * SR), Math.round(0.03 * out.length)));
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
    case 'marimba':
      return `marimba bar — ${t.bar || 'rosewood'}, ${t.mallet || 'yarn'} mallet, ${dec(t.partial, 2)}x ring on ${note}`;
    case 'xylo':
      return `xylophone bar — ${t.strike || 'wood'} strike, ${t.body || 'hollow'} ${t.tone || 'triangle'}, ${dec(t.ratio, 2)}x on ${note}`;
    case 'koto':
      return `koto pluck — ${t.buzz || 'dry'} sawari, ${t.bend || 'straight'}, ${num(t.buzz_hz)} Hz buzz on ${note}`;
    case 'muted':
      return `muted staccato pluck — ${t.damp || 'palm'} ${t.hits || 'single stab'}, ${num(t.damp_hz)} Hz on ${note}`;
    case 'glass':
      return `glassy pluck — ${t.shimmer || 'chime'}, ${t.touch || 'pure'} ${t.tail || 'still tail'}, ${dec(t.ratio, 2)}x on ${note}`;
    case 'octave':
      return `octave pluck — ${t.pairing || 'octave up'}, ${t.lock || 'tight'} ${t.tone || 'triangle'}, ${num(t.mix_pct)}% on ${note}`;
    case 'mallet':
      return `soft mallet — ${t.head || 'felt'} head, ${t.body || 'round'} ${t.swell || 'plain'}, ${num(t.warm_hz)} Hz on ${note}`;
    case 'pizz':
      return `pizzicato pluck — ${t.string || 'gut'} string, ${t.snap || 'nail'}, ${num(t.body_hz)} Hz box on ${note}`;
    case 'crush':
      return `bitcrushed pluck — ${t.grit || 'coarse'} ${t.tone || 'triangle'}, ${num(t.steps)} steps at ${num(t.rate_hz)} Hz, ${note}`;
    case 'roll':
      return `mallet roll — ${t.pattern || 'buzz roll'}, ${t.feel || 'even'} ${num(t.hits)} hits at ${num(t.bpm)} BPM, ${note}`;
    default:
      return `harp pluck — ${t.string || 'gut'} ${t.touch || 'soft'}, ${t.voicing || 'single string'}, ${num(t.bright_hz)} Hz on ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'harp and marimba plucks, glassy mallets, muted stabs, octave doubles';
