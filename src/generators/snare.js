// snare — the backbeat. Ten sub-styles cover what a chip track actually needs:
// the classic noise-plus-tone body, a tight crack, a fat gated slam, a rimshot,
// a brushed swish, a two-tone layered hit, a lo-fi crushed hit, a pitch-bent
// tuned snare, a short flam roll, and a high piccolo crack with wire buzz.
//
// Everything is built from two primitives: `noiseLayer` (LFSR noise through a
// one-pole lowpass minus a one-pole tracker, i.e. a cheap band-pass) and
// `renderTone` for the shell partials. The style lives in the filter pair, the
// envelope shape, and how the pitched layers are tuned against each other —
// snares are semi-pitched, so the body note is recorded for musicians who tune
// their kit to the track.

import { SR, Lfsr, square, midi, noteName, renderTone, finish, mixAt, dcBlock } from '../dsp.js';

const MIN_N = Math.round(0.055 * SR);
const MAX_N = Math.round(0.6 * SR);

const INTERVALS = { 3: 'minor third', 4: 'major third', 5: 'fourth', 7: 'fifth', 12: 'octave' };

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'classic', 'crack', 'gated', 'rimshot', 'brush',
    'two-tone', 'crushed', 'bent', 'flam', 'piccolo',
  ]);

  // linear attack into an exponential decay
  const env = (atk, rate) => {
    const inv = 1.0 / Math.max(atk, 1e-5);
    return (t) => Math.min(1.0, t * inv) * Math.exp(-rate * t);
  };

  // LFSR noise band-passed by a one-pole lowpass minus a one-pole tracker
  const noiseLayer = (n, period, lpA, hpA, envFn, gain = 1.0) => {
    const lf = new Lfsr(rng, period);
    const out = new Array(n);
    let lp = 0.0;
    let hp = 0.0;
    for (let i = 0; i < n; i++) {
      lp += lpA * (lf.next() - lp);
      hp += hpA * (lp - hp);
      out[i] = (lp - hp) * envFn(i / SR) * gain;
    }
    return out;
  };

  // nominal cutoff of a one-pole coefficient, for the catalog blurb only
  const cutoffHz = (a) => Math.round((SR * a) / (2 * Math.PI));

  let buf;
  let tags;

  if (style === 'classic') {
    // noise crack over a two-partial shell tone — the default backbeat snare
    const dur = rng.uniform(0.11, 0.28);
    const n = Math.trunc(dur * SR);
    const m = rng.randint(45, 59);
    const f0 = midi(m);
    const ratio = rng.uniform(1.45, 2.05);
    const wave = rng.choice(['tri', null]);
    const duty = rng.choice([0.25, 0.5]);
    const bodyRate = rng.uniform(22.0, 55.0);
    const toneGain = rng.uniform(0.35, 0.8);
    const lpA = rng.uniform(0.35, 0.8);
    const hpA = rng.uniform(0.03, 0.12);
    const nRate = rng.uniform(16.0, 40.0);
    const atk = rng.uniform(0.0008, 0.003);
    buf = noiseLayer(n, 1, lpA, hpA, env(atk, nRate), rng.uniform(0.7, 1.0));
    mixAt(buf, renderTone(n, () => f0, duty, env(0.001, bodyRate), wave), 0, toneGain);
    mixAt(buf, renderTone(n, () => f0 * ratio, duty, env(0.001, bodyRate * 1.6), wave), 0, toneGain * 0.55);
    tags = {
      style: 'classic',
      body: toneGain > 0.58 ? 'fat' : 'dry',
      snap: lpA > 0.58 ? 'crisp' : 'woolly',
      note: noteName(m),
      decay_ms: Math.round(1000.0 / nRate),
    };
  } else if (style === 'crack') {
    // very short, very bright: a stick crack with a pitched tick on the transient
    const dur = rng.uniform(0.055, 0.11);
    const n = Math.trunc(dur * SR);
    const lpA = rng.uniform(0.55, 0.95);
    const hpA = rng.uniform(0.08, 0.22);
    const nRate = rng.uniform(55.0, 140.0);
    buf = noiseLayer(n, 1, lpA, hpA, env(0.0005, nRate), 1.0);
    const m = rng.randint(64, 79);
    const tickGain = rng.uniform(0.18, 0.45);
    mixAt(buf, renderTone(Math.trunc(n * 0.5), () => midi(m), 0.125, env(0.0004, nRate * 1.5), null), 0, tickGain);
    const hasThump = rng.random() < 0.5;
    if (hasThump) {
      const mt = rng.randint(38, 46);
      const thumpRate = rng.uniform(60.0, 120.0);
      mixAt(buf, renderTone(n, () => midi(mt), 0.5, env(0.001, thumpRate), 'tri'), 0, rng.uniform(0.25, 0.5));
    }
    tags = {
      style: 'crack',
      edge: lpA > 0.75 ? 'glassy' : 'papery',
      weight: hasThump ? 'with a low thump' : 'no low end',
      note: noteName(m),
      cut_hz: cutoffHz(lpA),
    };
  } else if (style === 'gated') {
    // 80s gated slam: body plus early reflections, all chopped by one hard gate
    const gateT = rng.uniform(0.14, 0.42);
    const rel = rng.uniform(0.006, 0.03);
    const dur = Math.min(0.58, gateT + rel + 0.012);
    const n = Math.trunc(dur * SR);
    const holdRate = rng.uniform(1.5, 6.0);
    const gEnv = (t) => {
      const a = Math.min(1.0, t / 0.002);
      const g = t < gateT ? 1.0 : Math.max(0.0, 1.0 - (t - gateT) / rel);
      return a * Math.exp(-holdRate * t) * g;
    };
    const lpA = rng.uniform(0.3, 0.7);
    const hpA = rng.uniform(0.02, 0.08);
    buf = noiseLayer(n, 1, lpA, hpA, gEnv, rng.uniform(0.7, 1.0));
    const m = rng.randint(40, 52);
    const duty = rng.choice([0.25, 0.5]);
    const bodyRate = rng.uniform(10.0, 30.0);
    const toneGain = rng.uniform(0.4, 0.85);
    mixAt(buf, renderTone(n, () => midi(m), duty, (t) => gEnv(t) * Math.exp(-bodyRate * t), 'tri'), 0, toneGain);
    const taps = rng.randint(1, 3);
    for (let k = 1; k <= taps; k++) {
      const off = Math.min(Math.trunc(rng.uniform(0.012, 0.05) * SR * k), n - 1);
      mixAt(buf, noiseLayer(n - off, 1, lpA * 0.9, hpA, (t) => gEnv(t + off / SR), 0.5 / k), off);
    }
    tags = {
      style: 'gated',
      weight: toneGain > 0.62 ? 'heavy' : 'lean',
      gate: rel < 0.015 ? 'hard' : 'soft',
      note: noteName(m),
      gate_ms: Math.round(gateT * 1000.0),
    };
  } else if (style === 'rimshot') {
    // stick on rim: two inharmonic ring partials struck by a millisecond click
    const dur = rng.uniform(0.06, 0.16);
    const n = Math.trunc(dur * SR);
    const m = rng.randint(69, 86);
    const f0 = midi(m);
    const ratio = rng.uniform(1.35, 2.7);
    const ringRate = rng.uniform(28.0, 70.0);
    const duty = rng.choice([0.125, 0.25, 0.5]);
    buf = renderTone(n, () => f0, duty, env(0.0004, ringRate), null);
    mixAt(buf, renderTone(n, () => f0 * ratio, 0.5, env(0.0004, ringRate * 1.3), 'tri'), 0, rng.uniform(0.3, 0.6));
    const clickN = Math.trunc(rng.uniform(0.002, 0.008) * SR);
    const clickGain = rng.uniform(0.6, 1.0);
    mixAt(buf, noiseLayer(clickN, 1, rng.uniform(0.75, 0.98), 0.15, env(0.0003, rng.uniform(200.0, 450.0)), 1.0), 0, clickGain);
    tags = {
      style: 'rimshot',
      ring: ratio > 2.0 ? 'clangy' : 'woody',
      click: clickGain > 0.8 ? 'hard' : 'light',
      note: noteName(m),
      ring_ms: Math.round(1000.0 / ringRate),
    };
  } else if (style === 'brush') {
    // brushed swish: dark slow-swelling noise stirred by a slow amplitude swirl
    const dur = rng.uniform(0.18, 0.45);
    const n = Math.trunc(dur * SR);
    const atk = rng.uniform(0.008, 0.045);
    const nRate = rng.uniform(6.0, 16.0);
    const lpA = rng.uniform(0.08, 0.3);
    const hpA = rng.uniform(0.01, 0.05);
    const swirlHz = rng.uniform(8.0, 26.0);
    const depth = rng.uniform(0.15, 0.5);
    const base = env(atk, nRate);
    const swirl = (t) => base(t) * (1.0 - depth + depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * swirlHz * t)));
    buf = noiseLayer(n, rng.randint(1, 3), lpA, hpA, swirl, 1.0);
    const m = rng.randint(43, 55);
    mixAt(buf, renderTone(n, () => midi(m), 0.5, env(atk, nRate * 1.4), 'tri'), 0, rng.uniform(0.1, 0.3));
    tags = {
      style: 'brush',
      motion: depth > 0.33 ? 'swirling' : 'even',
      texture: lpA > 0.19 ? 'papery' : 'dark',
      note: noteName(m),
      swell_ms: Math.round(atk * 1000.0),
    };
  } else if (style === 'two-tone') {
    // two shells tuned to an interval, glued with a noise crack
    const dur = rng.uniform(0.12, 0.32);
    const n = Math.trunc(dur * SR);
    const m = rng.randint(45, 57);
    const iv = rng.choice([3, 4, 5, 7, 12]);
    const waveA = rng.choice(['tri', null]);
    const waveB = rng.choice(['tri', null]);
    const rateA = rng.uniform(16.0, 38.0);
    const rateB = rng.uniform(24.0, 60.0);
    const dutyB = rng.choice([0.25, 0.5]);
    const gB = rng.uniform(0.4, 0.9);
    buf = renderTone(n, () => midi(m), 0.5, env(0.001, rateA), waveA);
    mixAt(buf, renderTone(n, () => midi(m + iv), dutyB, env(0.001, rateB), waveB), 0, gB);
    const nGain = rng.uniform(0.35, 0.8);
    mixAt(buf, noiseLayer(n, 1, rng.uniform(0.4, 0.85), rng.uniform(0.04, 0.14), env(0.001, rng.uniform(20.0, 45.0)), 1.0), 0, nGain);
    tags = {
      style: 'two-tone',
      interval: INTERVALS[iv],
      blend: gB > 0.65 ? 'even mix' : 'low-led mix',
      note: noteName(m),
      top: noteName(m + iv),
      decay_ms: Math.round(1000.0 / rateA),
    };
  } else if (style === 'crushed') {
    // lo-fi: a plain snare run through a step quantizer and a sample-hold
    const dur = rng.uniform(0.09, 0.26);
    const n = Math.trunc(dur * SR);
    const lpA = rng.uniform(0.35, 0.9);
    const nRate = rng.uniform(18.0, 45.0);
    buf = noiseLayer(n, 1, lpA, rng.uniform(0.03, 0.12), env(0.001, nRate), 1.0);
    const m = rng.randint(45, 58);
    const duty = rng.choice([0.25, 0.5]);
    const wave = rng.choice(['tri', null]);
    mixAt(buf, renderTone(n, () => midi(m), duty, env(0.001, rng.uniform(25.0, 60.0)), wave), 0, rng.uniform(0.4, 0.9));
    let pk = 0.0;
    for (const v of buf) {
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
    }
    const sc = pk > 1e-9 ? 0.95 / pk : 1.0;
    const steps = rng.randint(2, 7);
    const hold = rng.randint(2, 9);
    let held = 0.0;
    for (let i = 0; i < n; i++) {
      if (i % hold === 0) held = Math.round(buf[i] * sc * steps) / steps;
      buf[i] = held;
    }
    tags = {
      style: 'crushed',
      tone: lpA > 0.62 ? 'bright' : 'dull',
      steps,
      note: noteName(m),
      hold_hz: Math.round(SR / hold),
    };
  } else if (style === 'bent') {
    // tuned snare with a pitch bend across the hit — the 808/trap move
    const dur = rng.uniform(0.1, 0.34);
    const n = Math.trunc(dur * SR);
    const m = rng.randint(46, 60);
    const f0 = midi(m);
    const semis = rng.randint(3, 15);
    const up = rng.random() < 0.25;
    const sign = up ? 1 : -1;
    const span = dur * rng.uniform(0.5, 1.0);
    const wave = rng.choice(['tri', null]);
    const duty = rng.choice([0.25, 0.5]);
    const rate = rng.uniform(14.0, 34.0);
    buf = renderTone(
      n,
      (t) => f0 * Math.pow(2.0, ((sign * semis) / 12.0) * Math.min(1.0, t / span)),
      duty,
      env(0.001, rate),
      wave
    );
    const nGain = rng.uniform(0.3, 0.8);
    mixAt(buf, noiseLayer(n, 1, rng.uniform(0.4, 0.85), rng.uniform(0.04, 0.14), env(0.001, rng.uniform(22.0, 50.0)), 1.0), 0, nGain);
    tags = {
      style: 'bent',
      direction: up ? 'rising' : 'diving',
      grit: nGain > 0.55 ? 'noisy tail' : 'tonal tail',
      note: noteName(m),
      target: noteName(m + sign * semis),
      semitones: semis,
    };
  } else if (style === 'flam') {
    // flam / short roll: two to five compact hits, accented in or out
    const hits = rng.randint(2, 5);
    const gap = rng.uniform(0.018, 0.055);
    const hitDur = rng.uniform(0.06, 0.13);
    const hn = Math.trunc(hitDur * SR);
    const m = rng.randint(46, 58);
    const crescendo = rng.random() < 0.5;
    const lpA = rng.uniform(0.4, 0.85);
    const hpA = rng.uniform(0.04, 0.14);
    const nRate = rng.uniform(30.0, 70.0);
    const bodyRate = rng.uniform(30.0, 70.0);
    const toneGain = rng.uniform(0.3, 0.7);
    buf = [];
    for (let k = 0; k < hits; k++) {
      const off = Math.trunc(k * gap * SR);
      const p = k / (hits - 1);
      const g = crescendo ? 0.5 + 0.5 * p : 1.0 - 0.45 * p;
      mixAt(buf, noiseLayer(hn, 1, lpA, hpA, env(0.0006, nRate), 1.0), off, g);
      mixAt(buf, renderTone(hn, () => midi(m), 0.5, env(0.001, bodyRate), 'tri'), off, g * toneGain);
    }
    tags = {
      style: 'flam',
      accent: crescendo ? 'crescendo' : 'decrescendo',
      grain: lpA > 0.62 ? 'bright' : 'thick',
      note: noteName(m),
      hits,
      gap_ms: Math.round(gap * 1000.0),
    };
  } else {
    // piccolo: high tight crack with the snare wires rattling underneath
    const dur = rng.uniform(0.07, 0.2);
    const n = Math.trunc(dur * SR);
    const m = rng.randint(58, 72);
    const f0 = midi(m);
    const ringRate = rng.uniform(30.0, 70.0);
    const buzzHz = rng.uniform(55.0, 170.0);
    const depth = rng.uniform(0.25, 0.6);
    const lpA = rng.uniform(0.6, 0.95);
    const hpA = rng.uniform(0.1, 0.25);
    const nRate = rng.uniform(25.0, 60.0);
    const base = env(0.0006, nRate);
    const wires = (t) => base(t) * (1.0 - depth + depth * (0.5 + 0.5 * square(buzzHz * t, 0.5)));
    buf = noiseLayer(n, 1, lpA, hpA, wires, 1.0);
    const duty = rng.choice([0.25, 0.5]);
    const ratio = rng.uniform(1.5, 2.4);
    mixAt(buf, renderTone(n, () => f0, duty, env(0.0006, ringRate), null), 0, rng.uniform(0.35, 0.7));
    mixAt(buf, renderTone(n, () => f0 * ratio, 0.5, env(0.0006, ringRate * 1.5), 'tri'), 0, rng.uniform(0.2, 0.45));
    tags = {
      style: 'piccolo',
      ring: ringRate > 50.0 ? 'tight' : 'ringing',
      buzz: depth > 0.42 ? 'rattling' : 'subtle',
      note: noteName(m),
      buzz_hz: Math.round(buzzHz),
    };
  }

  rng.tags = tags;

  // keep every hit inside the category's stated window
  if (buf.length > MAX_N) buf.length = MAX_N;
  while (buf.length < MIN_N) buf.push(0.0);

  // de-bias, de-click, then set the level last so the peak is exact
  dcBlock(buf);
  const target = rng.uniform(0.84, 0.95);
  finish(buf, target, 0.6, buf.length < 0.09 * SR ? 3 : 6);
  let pk = 0.0;
  for (const v of buf) {
    const a = v < 0 ? -v : v;
    if (a > pk) pk = a;
  }
  if (pk > 1e-9) {
    const g = target / pk;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  return buf;
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  const note = typeof t.note === 'string' && t.note ? t.note : 'D3';

  switch (t.style) {
    case 'classic':
      return `noise-and-tone snare — ${t.body || 'dry'} ${note} body, ${t.snap || 'crisp'} snap, ${num(t.decay_ms)} ms decay`;
    case 'crack':
      return `tight snare crack — ${t.edge || 'papery'} noise near ${num(t.cut_hz)} Hz, ${note} tick, ${t.weight || 'no low end'}`;
    case 'gated':
      return `fat gated snare — ${t.weight || 'lean'} ${note} body, ${t.gate || 'hard'} gate at ${num(t.gate_ms)} ms`;
    case 'rimshot':
      return `chip rimshot — ${t.ring || 'woody'} ${note} ring, ${t.click || 'light'} stick click, ${num(t.ring_ms)} ms decay`;
    case 'brush':
      return `brushed snare — ${t.motion || 'even'} ${t.texture || 'dark'} sweep over ${note}, ${num(t.swell_ms)} ms swell`;
    case 'two-tone':
      return `layered two-tone snare — ${note} + ${t.top || 'A3'} ${t.interval || 'fifth'}, ${t.blend || 'even mix'}, ${num(t.decay_ms)} ms decay`;
    case 'crushed':
      return `lo-fi crushed snare — ${num(t.steps)}-step crush, ${num(t.hold_hz)} Hz hold, ${t.tone || 'dull'} ${note} body`;
    case 'bent':
      return `pitch-bent snare — ${note} ${t.direction || 'diving'} ${num(t.semitones)} semitones to ${t.target || 'G2'}, ${t.grit || 'noisy tail'}`;
    case 'flam':
      return `flam roll snare — ${num(t.hits)} ${t.grain || 'bright'} hits ${num(t.gap_ms)} ms apart, ${t.accent || 'crescendo'} on ${note}`;
    case 'piccolo':
      return `piccolo snare — ${t.ring || 'tight'} ${note} crack, ${t.buzz || 'subtle'} wire buzz at ${num(t.buzz_hz)} Hz`;
    default:
      return `chip snare — noise-and-tone backbeat crack for chiptune drum patterns`;
  }
}

/** Short phrase for the README category table. */
export const character = 'noise-and-tone backbeats, cracks, gated slams, rimshots, flams';
