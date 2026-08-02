// impact — the cinematic hit: what lands when the riser stops. This is the
// downbeat of a trailer cut and the accent of a chip track, so the whole
// category is built around one promise: the weight is *tuned*. Every boom,
// slam, drop and braam settles onto an exact MIDI note (`note` in the tags),
// which is what lets an impact sit under a bassline instead of fighting it.
//
// The chip caricature of "expensive cinematic hit" is small, and every style
// spends the same four coins:
//
//   drop     a triangle whose pitch falls exponentially from a bright top
//            frequency onto the fundamental — the boom itself
//   metal    two or more squares at INHARMONIC ratios (spread^k, lightly
//            detuned), upper partials decaying faster than lower ones, then a
//            one-pole lowpass so the aliasing reads as steel, not fizz
//   air      band-shaped LFSR noise (one-pole lowpass with a slower pole
//            subtracted back out) — the crack, the wash, the rumble
//   damage   tanh drive, hard clipping, sine wavefolding, sample-and-hold rate
//            reduction and amplitude crushing
//
// Ten sub-styles spend that vocabulary:
//
//   boom     deep tuned boom, octave-down or unison sub layer, lowpassed rumble
//   slam     metallic slam: 3-6 inharmonic squares over a noise crack
//   subdrop  sub-drop hit — an 8-26x pitch dive settling on a sub note
//   crash    layered boom + noise wash, optional metallic shimmer partials
//   crush    distorted crush: clipped or wavefolded, then bit- and rate-crushed
//   reverse  reverse swell (noise, tonal or blended) crescendoing into the hit
//   gated    stutter gate at a musical division of a real BPM
//   debris   the hit plus 6-24 scattered shards, accelerating or thinning out
//   braam    trailer braam: 3-6 detuned voices in a unison/fifth/octave stack
//   cavern   the hit through a feedback comb — a slapback room, or a comb tuned
//            to a harmonic of the impact note so the tail rings in key
//
// Post-processing is uniform: keep the length inside 0.42 - 2.45 s, block the
// duty-cycle DC bias (a gentle 0.998 pole, so 30 Hz fundamentals survive), fade
// both edges, and normalize last so the peak is exact even when the loudest
// sample sits inside the first millisecond.

import { SR, Lfsr, square, midi, noteName, renderTone, finish, mixAt, dcBlock } from '../dsp.js';

const MIN_N = Math.round(0.42 * SR);
const MAX_N = Math.round(2.45 * SR);

/** Seconds to samples, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

/** One decimal place, for tag values that read better rounded. */
function r1(x) {
  return Math.round(x * 10) / 10;
}

/** "12.5% duty" / "25% duty" / "50% duty". */
function dutyLabel(d) {
  return `${d * 100}% duty`;
}

/** One-pole coefficient to its approximate -3 dB corner, for tag values. */
function poleHz(a) {
  const c = Math.min(Math.max(a, 1e-4), 0.999);
  return Math.round((-Math.log(1 - c) * SR) / (2 * Math.PI));
}

/** Fold a partial down by octaves until it clears Nyquist's fizz zone. */
function foldDown(f, ceiling = 7600.0) {
  let x = f;
  while (x > ceiling) x *= 0.5;
  return x;
}

/** Peak magnitude of a buffer. */
function peakOf(buf) {
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i];
    if (a > p) p = a;
  }
  return p;
}

/** Scale a layer's peak to `target` so mix gains mean the same thing everywhere. */
function scaleTo(buf, target) {
  const p = peakOf(buf);
  if (p > 1e-9) {
    const g = target / p;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  return buf;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'boom', 'slam', 'subdrop', 'crash', 'crush', 'reverse', 'gated', 'debris', 'braam', 'cavern',
  ]);

  // The shared skeleton: pitch falls from fStart onto fEnd with time-constant
  // tau, amplitude ramps in over atk then decays at `rate`.
  const body = (n, fStart, fEnd, tau, atk, rate, wave, duty) =>
    renderTone(
      n,
      (t) => fEnd + (fStart - fEnd) * Math.exp(-t / tau),
      duty,
      (t) => Math.min(1.0, t / atk) * Math.exp(-rate * t),
      wave
    );

  // Band-shaped LFSR: a one-pole lowpass with a slower pole subtracted back
  // out. hpFrac 0 leaves a pure lowpass — the rumble; 0.3-0.5 opens a band.
  const noiseBand = (n, period, lpA, hpFrac, envFn) => {
    const nz = new Lfsr(rng, period);
    const out = new Array(n);
    const hpA = lpA * hpFrac;
    let lp = 0.0;
    let hp = 0.0;
    for (let i = 0; i < n; i++) {
      lp += lpA * (nz.next() - lp);
      hp += hpA * (lp - hp);
      out[i] = (lp - hp) * envFn(i / SR);
    }
    return out;
  };

  /** tanh saturation, gain-compensated so the level stays put. */
  const saturate = (buf, amount) => {
    const k = Math.tanh(amount);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(amount * buf[i]) / k;
    return buf;
  };

  let out;
  let tags;

  if (style === 'boom') {
    // deep cinematic boom: a long triangle drop with a sub layer beneath it and
    // an optional lowpassed rumble, warmed with tanh
    const m = rng.randint(24, 38); // C1..D2
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(4.0, 11.0);
    const dur = rng.uniform(0.9, 2.2);
    const n = secs(dur);
    const tau = rng.uniform(0.03, 0.13);
    const rate = rng.uniform(2.2, 4.2) / dur;
    const atk = rng.uniform(0.001, 0.005);
    out = body(n, f0, fEnd, tau, atk, rate, 'tri', 0.5);
    const subM = m >= 32 ? m - 12 : m; // stay above the DC blocker's corner
    const subF = midi(subM);
    const subG = rng.uniform(0.2, 0.75);
    mixAt(
      out,
      renderTone(n, () => subF, 0.5, (t) => Math.min(1.0, t / 0.008) * Math.exp(-0.65 * rate * t), 'tri'),
      0,
      subG
    );
    const rumbleG = rng.uniform(0.0, 0.55);
    const rumbling = rumbleG > 0.18;
    if (rumbling) {
      const per = rng.randint(6, 40);
      const lpA = rng.uniform(0.02, 0.12);
      const rRate = 0.8 * rate;
      mixAt(
        out,
        scaleTo(noiseBand(n, per, lpA, 0.0, (t) => Math.min(1.0, t / 0.012) * Math.exp(-rRate * t)), 1.0),
        0,
        rumbleG
      );
    }
    const dr = rng.uniform(1.0, 3.6);
    saturate(out, dr);
    tags = {
      style: 'boom',
      weight: dr > 2.2 ? 'saturated' : 'clean',
      layer: subM < m ? 'octave-down sub' : 'unison sub',
      rumble: rumbling ? 'rumbling' : 'dry',
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  } else if (style === 'slam') {
    // metallic slam: inharmonic squares that overshoot and settle, a noise
    // crack on top, then a lowpass to pick the alloy
    const m = rng.randint(28, 46); // E1..A#2
    const f = midi(m);
    const parts = rng.randint(3, 6);
    const spread = rng.uniform(1.24, 1.78);
    const bendUp = rng.uniform(1.06, 1.55);
    const bendTau = rng.uniform(0.004, 0.02);
    const dur = rng.uniform(0.5, 1.5);
    const n = secs(dur);
    const rate = rng.uniform(2.8, 5.5) / dur;
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const wave = rng.choice([null, null, 'tri']);
    out = new Array(n).fill(0.0);
    let top = f;
    for (let k = 0; k < parts; k++) {
      const ratio = Math.pow(spread, k) * (k === 0 ? 1.0 : rng.uniform(0.94, 1.07));
      const fk = foldDown(f * ratio);
      if (fk > top) top = fk;
      const kRate = rate * (1.0 + 0.55 * k);
      mixAt(
        out,
        renderTone(
          n,
          (t) => fk * (1.0 + (bendUp - 1.0) * Math.exp(-t / bendTau)),
          duty,
          (t) => Math.min(1.0, t / 0.0012) * Math.exp(-kRate * t),
          wave
        ),
        0,
        Math.pow(0.62, k)
      );
    }
    const crackG = rng.uniform(0.25, 0.9);
    const crackPer = rng.randint(1, 3);
    const crackA = rng.uniform(0.45, 0.95);
    const crackHp = rng.uniform(0.0, 0.4);
    const crackRate = rng.uniform(40.0, 160.0);
    const crackN = Math.min(n, secs(rng.uniform(0.01, 0.05)));
    mixAt(
      out,
      scaleTo(
        noiseBand(crackN, crackPer, crackA, crackHp, (t) => Math.min(1.0, t / 0.0005) * Math.exp(-crackRate * t)),
        1.0
      ),
      0,
      crackG
    );
    const lpA = rng.uniform(0.08, 0.7);
    let prev = 0.0;
    for (let i = 0; i < n; i++) {
      prev += lpA * (out[i] - prev);
      out[i] = prev;
    }
    tags = {
      style: 'slam',
      metal: lpA < 0.3 ? 'dull iron' : 'bright steel',
      crack: crackG > 0.55 ? 'hard crack' : 'soft crack',
      clang: spread > 1.5 ? 'wide clang' : 'tight clang',
      partials: parts,
      top_hz: Math.round(top),
      note: noteName(m),
    };
  } else if (style === 'subdrop') {
    // sub-drop hit: a huge pitch dive that settles onto a playable sub note
    const m = rng.randint(24, 34); // C1..A#1
    const fEnd = midi(m);
    const mult = rng.uniform(8.0, 26.0);
    const f0 = fEnd * mult;
    const slide = rng.uniform(0.12, 0.55);
    const dur = rng.uniform(0.8, 2.2);
    const n = secs(dur);
    const rate = rng.uniform(1.6, 3.4) / dur;
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    const atk = rng.uniform(0.0008, 0.003);
    out = body(n, f0, fEnd, slide / 3.0, atk, rate, wave, duty);
    const kind = rng.choice(['noise', 'square', 'clean']);
    const tickG = rng.uniform(0.3, 0.95);
    if (kind === 'noise') {
      const tn = Math.min(n, secs(rng.uniform(0.004, 0.02)));
      const tPer = rng.randint(1, 3);
      const tA = rng.uniform(0.5, 0.95);
      const tRate = rng.uniform(120.0, 400.0);
      mixAt(
        out,
        scaleTo(noiseBand(tn, tPer, tA, 0.3, (t) => Math.min(1.0, t / 0.0006) * Math.exp(-tRate * t)), 1.0),
        0,
        tickG
      );
    } else if (kind === 'square') {
      const tn = Math.min(n, secs(rng.uniform(0.003, 0.012)));
      const tf = rng.uniform(1400.0, 3600.0);
      const tRate = rng.uniform(300.0, 900.0);
      mixAt(out, renderTone(tn, () => tf, 0.5, (t) => Math.min(1.0, t / 0.0005) * Math.exp(-tRate * t)), 0, tickG);
    }
    const dr = rng.uniform(1.0, 3.0);
    saturate(out, dr);
    tags = {
      style: 'subdrop',
      dive: mult > 16.0 ? 'plunging dive' : 'steep dive',
      transient: kind === 'noise' ? 'noise tick' : kind === 'square' ? 'square tick' : 'clean head',
      weight: dr > 2.0 ? 'saturated' : 'clean',
      slide_ms: r1(slide * 1000.0),
      note: noteName(m),
    };
  } else if (style === 'crash') {
    // layered boom + noise crash: the wash outlives the thump, and inharmonic
    // squares can add a sheet-metal shimmer over it
    const m = rng.randint(26, 41); // D1..F2
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(3.0, 9.0);
    const dur = rng.uniform(0.9, 2.3);
    const n = secs(dur);
    const tau = rng.uniform(0.015, 0.08);
    const bodyRate = rng.uniform(2.6, 5.0) / dur;
    const atk = rng.uniform(0.001, 0.004);
    out = body(n, f0, fEnd, tau, atk, bodyRate, 'tri', 0.5);
    const per = rng.randint(1, 4);
    const lpA = rng.uniform(0.12, 0.8);
    const hpFrac = rng.uniform(0.0, 0.5);
    const nRate = rng.uniform(1.4, 3.2) / dur;
    const nG = rng.uniform(0.35, 1.1);
    mixAt(
      out,
      scaleTo(noiseBand(n, per, lpA, hpFrac, (t) => Math.min(1.0, t / 0.0015) * Math.exp(-nRate * t)), 1.0),
      0,
      nG
    );
    const shimG = rng.uniform(0.0, 0.5);
    const shimmering = shimG > 0.18;
    if (shimmering) {
      const ra = rng.uniform(2.6, 4.4);
      const rb = rng.uniform(5.1, 7.9);
      const sRate = rng.uniform(2.0, 4.0) / dur;
      const sDuty = rng.choice([0.5, 0.25, 0.125]);
      const fa = foldDown(fEnd * ra);
      const fb = foldDown(fEnd * rb);
      mixAt(out, renderTone(n, () => fa, sDuty, (t) => Math.min(1.0, t / 0.002) * Math.exp(-sRate * t)), 0, shimG);
      mixAt(
        out,
        renderTone(n, () => fb, sDuty, (t) => Math.min(1.0, t / 0.002) * Math.exp(-1.3 * sRate * t)),
        0,
        shimG * 0.7
      );
    }
    tags = {
      style: 'crash',
      wash: lpA > 0.45 ? 'bright wash' : 'dark wash',
      shimmer: shimmering ? 'metallic shimmer' : 'pure noise',
      balance: nG > 0.7 ? 'noise-forward' : 'boom-forward',
      hiss_hz: poleHz(lpA),
      note: noteName(m),
    };
  } else if (style === 'crush') {
    // distorted crush: drive it into clipping or a wavefold, then throw away
    // sample rate and amplitude resolution until it crunches
    const m = rng.randint(26, 42); // D1..F#2
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(3.0, 9.0);
    const dur = rng.uniform(0.5, 1.6);
    const n = secs(dur);
    const tau = rng.uniform(0.01, 0.06);
    const rate = rng.uniform(2.4, 5.0) / dur;
    const wave = rng.choice(['tri', null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const atk = rng.uniform(0.001, 0.003);
    out = body(n, f0, fEnd, tau, atk, rate, wave, duty);
    const gritG = rng.uniform(0.0, 0.6);
    const gritty = gritG > 0.2;
    if (gritty) {
      const gPer = rng.randint(2, 10);
      const gA = rng.uniform(0.05, 0.4);
      const gRate = 1.2 * rate;
      mixAt(
        out,
        scaleTo(noiseBand(n, gPer, gA, 0.0, (t) => Math.min(1.0, t / 0.004) * Math.exp(-gRate * t)), 1.0),
        0,
        gritG
      );
    }
    const fold = rng.random() < 0.4;
    const dr = fold ? rng.uniform(1.4, 4.0) : rng.uniform(2.5, 12.0);
    for (let i = 0; i < n; i++) {
      const x = out[i] * dr;
      out[i] = fold ? Math.sin(1.6 * x) : Math.max(-1.0, Math.min(1.0, x));
    }
    const steps = rng.randint(3, 9);
    const hold = rng.randint(2, 14);
    let held = 0.0;
    for (let i = 0; i < n; i++) {
      if (i % hold === 0) held = out[i];
      out[i] = Math.round(held * steps) / steps;
    }
    tags = {
      style: 'crush',
      shape: fold ? 'wavefolded' : 'hard-clipped',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      grit: gritty ? 'gritty' : 'dry',
      steps,
      crush_hz: Math.round(SR / hold),
      note: noteName(m),
    };
  } else if (style === 'reverse') {
    // reverse swell into hit: a rising, brightening crescendo cut dead at the
    // downbeat, where the boom lands
    const m = rng.randint(26, 40); // D1..E2
    const fEnd = midi(m);
    const rise = rng.uniform(0.3, 1.1);
    const tail = rng.uniform(0.45, 1.2);
    const curve = rng.uniform(1.2, 3.5);
    const kind = rng.choice(['noise', 'tone', 'blend']);
    const rn = secs(rise);
    const swell = new Array(rn).fill(0.0);
    if (kind !== 'tone') {
      const per = rng.randint(1, 6);
      const lpStart = rng.uniform(0.02, 0.1);
      const lpEnd = rng.uniform(0.25, 0.9);
      const nz = new Lfsr(rng, per);
      let lp = 0.0;
      for (let i = 0; i < rn; i++) {
        const f = i / rn;
        lp += (lpStart + (lpEnd - lpStart) * f) * (nz.next() - lp);
        swell[i] += lp * Math.pow(f, curve);
      }
    }
    if (kind !== 'noise') {
      const startMult = rng.uniform(0.35, 0.9);
      const topMult = rng.uniform(2.0, 6.0);
      const sDuty = rng.choice([0.5, 0.25, 0.125]);
      const sWave = rng.choice(['tri', null, 'saw']);
      const tone = renderTone(
        rn,
        (t) => fEnd * (startMult + (topMult - startMult) * Math.pow(Math.min(1.0, t / rise), 1.4)),
        sDuty,
        (t) => Math.pow(Math.min(1.0, t / rise), curve),
        sWave
      );
      const tg = kind === 'blend' ? 0.7 : 1.0;
      for (let i = 0; i < rn; i++) swell[i] += tone[i] * tg;
    }
    scaleTo(swell, rng.uniform(0.35, 0.65));
    const tp = Math.min(rn, secs(0.002)); // clean cut into the downbeat
    for (let i = 0; i < tp; i++) swell[rn - 1 - i] *= i / tp;
    const tn = secs(tail);
    const f0 = fEnd * rng.uniform(3.5, 9.0);
    const hRate = rng.uniform(2.5, 5.0) / tail;
    const hTau = rng.uniform(0.015, 0.06);
    const hAtk = rng.uniform(0.001, 0.003);
    const hit = body(tn, f0, fEnd, hTau, hAtk, hRate, 'tri', 0.5);
    const hnG = rng.uniform(0.1, 0.6);
    const hPer = rng.randint(1, 4);
    const hA = rng.uniform(0.2, 0.8);
    mixAt(
      hit,
      scaleTo(noiseBand(tn, hPer, hA, 0.2, (t) => Math.min(1.0, t / 0.002) * Math.exp(-1.4 * hRate * t)), 1.0),
      0,
      hnG
    );
    out = [];
    mixAt(out, swell, 0, 1.0);
    mixAt(out, hit, rn, 1.0);
    tags = {
      style: 'reverse',
      swell: kind === 'noise' ? 'noise swell' : kind === 'tone' ? 'tonal swell' : 'blended swell',
      rise: curve > 2.3 ? 'steep rise' : 'gradual rise',
      landing: hnG > 0.35 ? 'noisy landing' : 'clean landing',
      rise_ms: r1(rise * 1000.0),
      note: noteName(m),
    };
  } else if (style === 'gated') {
    // gated stutter impact: a sustaining boom chopped at a musical division of
    // a real tempo, so it drops straight onto a grid
    const m = rng.randint(26, 40);
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(3.0, 8.0);
    const dur = rng.uniform(0.6, 1.8);
    const n = secs(dur);
    const tau = rng.uniform(0.015, 0.07);
    const rate = rng.uniform(1.6, 3.2) / dur;
    const atk = rng.uniform(0.001, 0.003);
    out = body(n, f0, fEnd, tau, atk, rate, 'tri', 0.5);
    const nG = rng.uniform(0.2, 0.8);
    const per = rng.randint(1, 6);
    const lpA = rng.uniform(0.15, 0.7);
    const hpFrac = rng.uniform(0.0, 0.4);
    mixAt(
      out,
      scaleTo(noiseBand(n, per, lpA, hpFrac, (t) => Math.min(1.0, t / 0.002) * Math.exp(-0.9 * rate * t)), 1.0),
      0,
      nG
    );
    const bpm = rng.choice([90, 100, 110, 120, 124, 128, 132, 140, 150, 160, 174]);
    const divName = rng.choice(['8th', '16th', 'triplet 16th', '32nd']);
    const mult = divName === '8th' ? 2 : divName === '16th' ? 4 : divName === 'triplet 16th' ? 6 : 8;
    const stepHz = (bpm / 60.0) * mult;
    const gDuty = rng.uniform(0.3, 0.7);
    const ducked = rng.random() < 0.5;
    const floorL = ducked ? rng.uniform(0.1, 0.35) : 0.0;
    const smooth = rng.uniform(0.15, 0.5);
    let g = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      g += smooth * ((square(t * stepHz, gDuty) > 0 ? 1.0 : floorL) - g);
      out[i] *= g;
    }
    tags = {
      style: 'gated',
      division: `${divName} gate`,
      gaps: ducked ? 'ducked gaps' : 'silent gaps',
      chop: gDuty > 0.5 ? 'long chops' : 'tight chops',
      bpm,
      note: noteName(m),
    };
  } else if (style === 'debris') {
    // debris tail: the hit, then shards raining down — accelerating, even or
    // thinning out, dull rock or pitched metal and glass
    const m = rng.randint(26, 42);
    const fEnd = midi(m);
    const hitDur = rng.uniform(0.18, 0.45);
    const hn = secs(hitDur);
    const f0 = fEnd * rng.uniform(3.5, 9.0);
    const hRate = rng.uniform(3.0, 6.0) / hitDur;
    const hTau = rng.uniform(0.008, 0.035);
    const hAtk = rng.uniform(0.0008, 0.002);
    out = body(hn, f0, fEnd, hTau, hAtk, hRate, 'tri', 0.5);
    const hPer = rng.randint(1, 4);
    const hA = rng.uniform(0.3, 0.9);
    const hG = rng.uniform(0.25, 0.7);
    mixAt(
      out,
      scaleTo(noiseBand(hn, hPer, hA, 0.25, (t) => Math.min(1.0, t / 0.001) * Math.exp(-1.6 * hRate * t)), 1.0),
      0,
      hG
    );
    const pieces = rng.randint(6, 24);
    const tailLen = rng.uniform(0.6, 1.7);
    const accel = rng.uniform(0.86, 1.22);
    const material = rng.choice(['rock', 'metal', 'glass']);
    const fallCurve = rng.uniform(0.8, 2.6);
    let tPos = rng.uniform(0.04, 0.14);
    let spacing = (tailLen / pieces) * rng.uniform(0.7, 1.2);
    let placed = 0;
    for (let k = 0; k < pieces && tPos < tailLen; k++) {
      const frac = Math.min(0.999, tPos / tailLen);
      const g = Math.pow(1.0 - frac, fallCurve) * rng.uniform(0.35, 1.0);
      const tickDur = rng.uniform(0.012, 0.06);
      const tn = secs(tickDur);
      let tick;
      if (material === 'rock') {
        const tPer = rng.randint(2, 8);
        const tA = rng.uniform(0.1, 0.45);
        const tRate = rng.uniform(4.0, 9.0) / tickDur;
        tick = scaleTo(
          noiseBand(tn, tPer, tA, 0.15, (t) => Math.min(1.0, t / 0.0008) * Math.exp(-tRate * t)),
          1.0
        );
      } else {
        const semi = rng.choice([12, 19, 24, 28, 31, 36]) + (material === 'glass' ? 12 : 0);
        const pf = foldDown(midi(m + semi));
        const pd = rng.choice([0.5, 0.25, 0.125]);
        const pRate = rng.uniform(3.5, 7.0) / tickDur;
        tick = renderTone(tn, () => pf, pd, (t) => Math.min(1.0, t / 0.0006) * Math.exp(-pRate * t));
      }
      mixAt(out, tick, secs(tPos), g * 0.7);
      tPos += spacing;
      spacing *= accel;
      placed++;
    }
    tags = {
      style: 'debris',
      material: `${material} shards`,
      scatter: accel > 1.06 ? 'thinning out' : accel < 0.94 ? 'accelerating' : 'even scatter',
      landing: hitDur > 0.3 ? 'heavy landing' : 'quick landing',
      pieces: placed,
      note: noteName(m),
    };
  } else if (style === 'braam') {
    // trailer braam: a detuned chip-horn stack that scoops up into the note,
    // growls through tanh and sits on its own sub
    const m = rng.randint(30, 45); // F#1..A2
    const stack = rng.choice(['unison', 'octave', 'fifth', 'octave+fifth']);
    const ivs =
      stack === 'unison' ? [0] : stack === 'octave' ? [0, 12] : stack === 'fifth' ? [0, 7] : [0, 7, 12];
    const voices = rng.randint(3, 6);
    const cents = rng.uniform(4.0, 28.0);
    const dur = rng.uniform(0.9, 2.4);
    const n = secs(dur);
    const atk = rng.uniform(0.012, 0.07);
    const rate = rng.uniform(1.4, 3.0) / dur;
    const scoop = rng.uniform(0.02, 0.09);
    const scoopTau = rng.uniform(0.02, 0.09);
    const wave = rng.choice(['saw', null, null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    out = new Array(n).fill(0.0);
    for (let v = 0; v < voices; v++) {
      const iv = ivs[v % ivs.length];
      const det = ((v % 2 === 0 ? 1 : -1) * cents * (0.4 + (0.6 * v) / voices)) / 1200.0;
      const fv = foldDown(midi(m + iv) * Math.pow(2.0, det));
      mixAt(
        out,
        renderTone(
          n,
          (t) => fv * (1.0 - scoop * Math.exp(-t / scoopTau)),
          duty,
          (t) => Math.min(1.0, t / atk) * Math.exp(-rate * t),
          wave
        ),
        0,
        0.6 / (1.0 + 0.6 * v)
      );
    }
    const subF = midi(m - 12);
    const subG = rng.uniform(0.3, 0.9);
    mixAt(
      out,
      renderTone(n, () => subF, 0.5, (t) => Math.min(1.0, t / 0.006) * Math.exp(-0.8 * rate * t), 'tri'),
      0,
      subG
    );
    const dr = rng.uniform(1.2, 4.0);
    saturate(out, dr);
    tags = {
      style: 'braam',
      growl: dr > 2.5 ? 'growling' : 'smooth',
      stack: `${stack} stack`,
      tone: wave === 'saw' ? 'sawtooth' : dutyLabel(duty),
      voices,
      detune_cents: r1(cents),
      note: noteName(m),
    };
  } else {
    // cavern: the hit fed through a damped feedback comb — a slapback stone
    // room, or a comb tuned to a harmonic so the tail rings in key
    const m = rng.randint(26, 41);
    const fEnd = midi(m);
    const hitDur = rng.uniform(0.2, 0.6);
    const hn = secs(hitDur);
    const f0 = fEnd * rng.uniform(3.0, 9.0);
    const hRate = rng.uniform(2.5, 5.5) / hitDur;
    const hTau = rng.uniform(0.01, 0.05);
    const hAtk = rng.uniform(0.001, 0.003);
    const hit = body(hn, f0, fEnd, hTau, hAtk, hRate, 'tri', 0.5);
    const hPer = rng.randint(1, 4);
    const hA = rng.uniform(0.2, 0.85);
    const hG = rng.uniform(0.2, 0.7);
    mixAt(
      hit,
      scaleTo(noiseBand(hn, hPer, hA, 0.2, (t) => Math.min(1.0, t / 0.0015) * Math.exp(-1.5 * hRate * t)), 1.0),
      0,
      hG
    );
    const mode = rng.choice(['slap', 'ring']);
    const ringM = m + rng.choice([12, 19, 24]);
    const slapMs = rng.uniform(0.03, 0.16);
    const D = mode === 'ring' ? Math.max(2, Math.round(SR / midi(ringM))) : Math.max(2, secs(slapMs));
    const fb = rng.uniform(0.45, 0.86);
    const damp = rng.uniform(0.15, 0.75);
    const wet = rng.uniform(0.4, 0.95);
    // Length follows the comb, not a coin flip: one pass loses -ln(fb) nepers,
    // so the tail is roughly 6.5 nepers' worth of passes.
    const ringSecs = Math.min(2.0, Math.max(0.3, (6.5 * D) / (SR * -Math.log(fb))));
    const dur = Math.min(2.4, hitDur + ringSecs * rng.uniform(0.7, 1.15));
    const n = secs(dur);
    out = new Array(n).fill(0.0);
    mixAt(out, hit, 0, 1.0);
    const line = new Array(D).fill(0.0);
    let wi = 0;
    let lp = 0.0;
    for (let i = 0; i < n; i++) {
      lp += damp * (line[wi] - lp);
      const x = out[i];
      line[wi] = x + fb * lp;
      wi = wi + 1 === D ? 0 : wi + 1;
      out[i] = x + wet * lp;
    }
    tags = {
      style: 'cavern',
      space: mode === 'ring' ? 'tuned ring tail' : fb > 0.68 ? 'cavernous slap' : 'stone room slap',
      damping: damp < 0.35 ? 'dark tail' : 'bright tail',
      blend: wet > 0.7 ? 'wet' : 'dry-forward',
      delay_ms: r1((D / SR) * 1000.0),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every impact inside 0.42 - 2.45 s, block the duty-cycle DC bias with a
  // gentle pole (30 Hz fundamentals have to survive it), fade both edges, then
  // normalize last so the peak is exact even when the loudest sample sits
  // inside the first millisecond.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  // Trim dead air. The 16-level crush downstream zeroes anything under ~9% of
  // the normalized peak, so a tail below 3% of peak is already silence in the
  // exported audio — cut it (keeping 40 ms of breath) rather than ship padding.
  const pk = peakOf(out);
  if (pk > 1e-9) {
    const thr = pk * 0.03;
    let last = out.length - 1;
    while (last > 0 && (out[last] < 0 ? -out[last] : out[last]) < thr) last--;
    const keep = Math.max(MIN_N, Math.min(out.length, last + 1 + Math.round(0.04 * SR)));
    if (keep < out.length) out = out.slice(0, keep);
  }
  while (out.length < MIN_N) out.push(0.0);
  dcBlock(out, 0.998);
  const fi = Math.min(out.length >> 3, 12);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.01 * SR), Math.round(0.05 * out.length)));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C2';
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const int = (v) => Math.trunc(num(v));
  switch (t.style) {
    case 'slam':
      return `metallic slam — ${t.metal || 'bright steel'} ${t.crack || 'hard crack'}, ${int(t.partials)} partials, ${t.clang || 'wide clang'}, ${int(t.top_hz)} Hz over ${note}`;
    case 'subdrop':
      return `sub-drop hit — ${t.dive || 'steep dive'}, ${t.transient || 'clean head'}, ${t.weight || 'clean'}, ${num(t.slide_ms).toFixed(1)} ms slide onto ${note}`;
    case 'crash':
      return `layered boom crash — ${t.wash || 'dark wash'}, ${t.shimmer || 'pure noise'}, ${t.balance || 'boom-forward'}, ${int(t.hiss_hz)} Hz over ${note}`;
    case 'crush':
      return `distorted crush — ${t.shape || 'hard-clipped'} ${t.tone || 'triangle'}, ${t.grit || 'dry'}, ${int(t.steps)}-step at ${int(t.crush_hz)} Hz on ${note}`;
    case 'reverse':
      return `reverse swell into hit — ${t.swell || 'noise swell'}, ${t.rise || 'steep rise'}, ${t.landing || 'clean landing'}, ${num(t.rise_ms).toFixed(0)} ms onto ${note}`;
    case 'gated':
      return `gated stutter impact — ${t.division || '16th gate'}, ${t.gaps || 'silent gaps'}, ${t.chop || 'tight chops'}, ${int(t.bpm)} BPM on ${note}`;
    case 'debris':
      return `impact with debris tail — ${int(t.pieces)} ${t.material || 'rock shards'}, ${t.scatter || 'even scatter'}, ${t.landing || 'heavy landing'} on ${note}`;
    case 'braam':
      return `trailer braam — ${t.growl || 'growling'} ${t.stack || 'fifth stack'}, ${t.tone || 'sawtooth'}, ${int(t.voices)} voices ${num(t.detune_cents).toFixed(1)} cents on ${note}`;
    case 'cavern':
      return `cavernous impact — ${t.space || 'stone room slap'}, ${t.damping || 'dark tail'}, ${t.blend || 'wet'}, ${num(t.delay_ms).toFixed(1)} ms taps on ${note}`;
    default:
      return `deep cinematic boom — ${t.weight || 'clean'}, ${t.layer || 'unison sub'}, ${t.rumble || 'dry'}, ${int(t.top_hz)} Hz fall to ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'cinematic booms, metallic slams, sub drops, braams, debris tails';
