// sub — the bottom octave, on purpose. Where `kick` is a transient that happens
// to have a pitch, a sub *is* the pitch: a note you play, roughly C0-C2, that a
// track sits on. So every variation here lands on an exact MIDI note and records
// it — musicians pick these by pitch, and a bassline built from `sub_017` and
// `sub_142` has to be in tune with itself.
//
// The chip caricature of a sine sub is a triangle: at 20-60 Hz its corners are
// far enough above the fundamental that a one-pole lowpass (or just the 16-level
// master crush) rounds it into something that reads as a sine on a real speaker,
// and it costs nothing to synthesize. Squares and sawtooths are the buzzy end;
// pulses are DC-corrected (`square(ph,d) - (2d-1)`) so a 15% duty sub doesn't
// ride a -0.7 bias into the quantizer. Every voice starts on a zero crossing —
// a triangle sampled from phase 0 starts at *peak*, and at 30 Hz that jump is an
// audible tick, which is exactly what a clean sub attack must not have.
//
// Ten sub-styles, all built from the same voice:
//
//   slide    the 808 portamento: hold a note, glide a real interval to another
//   drop     the long fall — 4-18x overshoot settling onto the fundamental
//   hit      clean short triangle sub, tight bend, optional attack tick
//   rumble   sustained sub churned by a sample-and-hold on pitch and level
//   swell    reverse crescendo, tape-start pitch rise, quick release
//   gate     a sustain chopped at a real BPM subdivision — 8ths, triplets, 16ths
//   octave   octave (or fifth, or two-octave) jumps, retriggered or legato
//   growl    detuned reese stack under a wobbling one-pole — dubstep by way of NES
//   crush    sample-and-hold rate reduction plus a coarse amplitude crush
//   pulse    PWM sub: the duty sweeps or LFOs, the harmonics move with it
//
// Post-processing is uniform and deliberately gentle at the bottom: the DC
// blocker runs at r=0.997 (~10 Hz corner) so it kills envelope-induced offset
// without eating a C0 fundamental, both edges fade to exactly zero, and
// normalization happens last so the peak is exact.

import {
  SR,
  Lfsr,
  square,
  triangle,
  sawtooth,
  midi,
  noteName,
  renderTone,
  finish,
  mixAt,
  dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.21 * SR);
const MAX_N = Math.round(1.98 * SR);

/** One decimal place, for tag values that read better rounded. */
function r1(x) {
  return Math.round(x * 10) / 10;
}

/** Wave shape to a word for the catalog blurb. */
function toneLabel(shape, duty) {
  if (shape === 'tri') return 'triangle';
  if (shape === 'saw') return 'sawtooth';
  return `${r1(duty * 100)}% pulse`;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'slide', 'drop', 'hit', 'rumble', 'swell', 'gate', 'octave', 'growl', 'crush', 'pulse',
  ]);

  const secs = (s) => Math.max(1, Math.round(s * SR));

  /** Linear attack into an exponential decay. */
  const envAD = (atk, rate) => {
    const inv = 1.0 / Math.max(atk, 1e-5);
    return (t) => Math.min(1.0, t * inv) * Math.exp(-rate * t);
  };

  /**
   * The sub voice. Zero-mean shapes, started on a zero crossing so the attack is
   * the envelope's business and not the waveform's.
   * @param {"tri"|"saw"|"pulse"} shape
   * @param {number|((t:number)=>number)} dutyFn pulse duty (ignored for tri/saw)
   */
  const voice = (n, freqFn, envFn, shape, dutyFn = 0.5, phase0 = null) => {
    const out = new Array(n);
    let ph = phase0 === null ? (shape === 'tri' ? 0.75 : shape === 'saw' ? 0.5 : 0.0) : phase0;
    const fixed = typeof dutyFn !== 'function';
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += freqFn(t) / SR;
      let s;
      if (shape === 'tri') {
        s = triangle(ph);
      } else if (shape === 'saw') {
        s = sawtooth(ph);
      } else {
        const d = fixed ? dutyFn : dutyFn(t);
        s = square(ph, d) - (2.0 * d - 1.0); // DC-corrected pulse
      }
      out[i] = s * envFn(t);
    }
    return out;
  };

  /** Hand-rolled one-pole lowpass, in place. */
  const lowpass = (buf, alpha) => {
    let p = 0.0;
    for (let i = 0; i < buf.length; i++) {
      p += alpha * (buf[i] - p);
      buf[i] = p;
    }
    return buf;
  };

  /** tanh saturation, gain-compensated so `drive` only changes shape. */
  const saturate = (buf, drive) => {
    const norm = Math.tanh(drive);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(drive * buf[i]) / norm;
    return buf;
  };

  /** Lowpassed LFSR burst — the attack tick that makes a sub read on a laptop. */
  const tick = (n, period, alpha, atk, rate) => {
    const lf = new Lfsr(rng, period);
    const out = new Array(n);
    let lp = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      lp += alpha * (lf.next() - lp);
      out[i] = lp * Math.min(1.0, t / atk) * Math.exp(-rate * t);
    }
    return out;
  };

  /** Smoothed sample-and-hold curve in [-1,1], `hz` steps per second. */
  const sampleHold = (n, hz, smooth) => {
    const lf = new Lfsr(rng, Math.max(1, Math.round(SR / Math.max(hz, 0.5))));
    const out = new Array(n);
    let p = 0.0;
    for (let i = 0; i < n; i++) {
      p += smooth * (lf.next() - p);
      out[i] = p;
    }
    return out;
  };

  let out;
  let tags;

  if (style === 'slide') {
    // 808 slide: hold the root, then portamento a real interval to the target.
    const m0 = rng.randint(12, 36);
    const opts = [-12, -7, -5, -4, -3, 3, 4, 5, 7, 12].filter((v) => m0 + v >= 12 && m0 + v <= 36);
    const iv = rng.choice(opts);
    const m1 = m0 + iv;
    const f0 = midi(m0);
    const f1 = midi(m1);
    const dur = rng.uniform(0.55, 1.6);
    const n = secs(dur);
    const hold = rng.uniform(0.04, 0.3) * dur;
    const glide = rng.uniform(0.06, 0.4) * dur;
    const even = rng.random() < 0.6; // constant semitones/sec vs constant Hz/sec
    const freqFn = (t) => {
      if (t <= hold) return f0;
      const u = Math.min(1.0, (t - hold) / glide);
      return even ? f0 * Math.pow(f1 / f0, u) : f0 + (f1 - f0) * u;
    };
    const shape = rng.choice(['tri', 'tri', 'tri', 'pulse']);
    const duty = rng.choice([0.5, 0.4, 0.3]);
    const atk = rng.uniform(0.002, 0.012);
    const rate = rng.uniform(1.1, 2.8) / dur;
    const env = envAD(atk, rate);
    out = voice(n, freqFn, env, shape, duty);
    const drive = rng.uniform(1.0, 3.2);
    saturate(out, drive);
    const ghostG = rng.uniform(0.0, 0.32);
    if (ghostG > 0.1) {
      mixAt(out, voice(n, (t) => 2.0 * freqFn(t), envAD(atk, rate * 1.6), 'tri'), 0, ghostG);
    }
    tags = {
      style: 'slide',
      direction: iv > 0 ? 'rising' : 'falling',
      glide: even ? 'even-semitone' : 'linear-Hz',
      tone: drive > 1.9 ? 'saturated' : 'clean',
      glide_ms: r1(glide * 1000),
      note: noteName(m0),
      to: noteName(m1),
    };
  } else if (style === 'drop') {
    // The long fall: a big overshoot settling exponentially onto the fundamental.
    const m = rng.randint(12, 31);
    const fEnd = midi(m);
    const ratio = rng.uniform(4.0, 18.0);
    const f0 = fEnd * ratio;
    const dur = rng.uniform(0.5, 1.9);
    const n = secs(dur);
    // Scale the settle to the note's length: a drop that is still a third sharp
    // halfway through isn't the note it claims to be. At tau = 5% of the duration
    // even an 18x overshoot is inside a few cents by the first third.
    const tau = dur * rng.uniform(0.012, 0.05);
    const atk = rng.uniform(0.001, 0.006);
    const rate = rng.uniform(1.4, 3.6) / dur;
    const shape = rng.choice(['tri', 'tri', 'pulse', 'saw']);
    const duty = rng.choice([0.5, 0.35]);
    out = voice(n, (t) => fEnd + (f0 - fEnd) * Math.exp(-t / tau), envAD(atk, rate), shape, duty);
    const drive = rng.uniform(1.0, 3.0);
    saturate(out, drive);
    const clickG = rng.uniform(0.0, 0.5);
    if (clickG > 0.18) {
      mixAt(out, tick(secs(0.006), rng.randint(1, 3), rng.uniform(0.4, 0.9), 0.0008, rng.uniform(250, 700)), 0, clickG);
    }
    tags = {
      style: 'drop',
      tail: rate * dur < 2.3 ? 'booming' : 'settled',
      drive: drive > 1.9 ? 'saturated' : 'clean',
      tone: toneLabel(shape, duty),
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  } else if (style === 'hit') {
    // Clean short sub hit: tight bend, quick decay, optional attack tick.
    const m = rng.randint(19, 36);
    const fEnd = midi(m);
    const ratio = rng.uniform(1.2, 3.0);
    const f0 = fEnd * ratio;
    const dur = rng.uniform(0.24, 0.7);
    const n = secs(dur);
    const tau = rng.uniform(0.004, 0.03);
    const atk = rng.uniform(0.001, 0.004);
    const rate = rng.uniform(2.5, 6.0) / dur;
    const shape = rng.choice(['tri', 'tri', 'tri', 'pulse']);
    const duty = rng.choice([0.5, 0.35, 0.2]);
    out = voice(n, (t) => fEnd + (f0 - fEnd) * Math.exp(-t / tau), envAD(atk, rate), shape, duty);
    const soft = rng.random() < 0.5;
    if (soft) lowpass(out, rng.uniform(0.01, 0.08));
    const tickG = rng.uniform(0.0, 0.55);
    const ticked = tickG > 0.2;
    if (ticked) {
      const cn = Math.min(n, secs(rng.uniform(0.002, 0.007)));
      if (rng.random() < 0.5) {
        mixAt(out, tick(cn, rng.randint(1, 3), rng.uniform(0.5, 0.95), 0.0006, rng.uniform(400, 1100)), 0, tickG);
      } else {
        const cf = rng.uniform(700, 2400);
        const crate = rng.uniform(400, 1200);
        mixAt(out, renderTone(cn, () => cf, 0.5, (t) => Math.min(1.0, t / 0.0005) * Math.exp(-crate * t)), 0, tickG);
      }
    }
    tags = {
      style: 'hit',
      body: soft ? 'rounded' : 'firm',
      attack: ticked ? 'ticked' : 'clean',
      tone: toneLabel(shape, duty),
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  } else if (style === 'rumble') {
    // Sustained sub churned by a sample-and-hold on both pitch and level.
    const m = rng.randint(12, 29);
    const f = midi(m);
    const dur = rng.uniform(0.9, 1.95);
    const n = secs(dur);
    const modHz = rng.uniform(3.5, 26.0);
    const depth = rng.uniform(0.006, 0.04); // +/- 68 cents at most — still the note
    const ampDepth = rng.uniform(0.08, 0.5);
    const mod = sampleHold(n, modHz, rng.uniform(0.002, 0.05));
    const at = (t) => mod[Math.min(n - 1, Math.max(0, Math.round(t * SR)))];
    const atk = rng.uniform(0.02, 0.2);
    const rate = rng.uniform(0.2, 1.2) / dur;
    const base = envAD(atk, rate);
    const shape = rng.choice(['tri', 'tri', 'saw', 'pulse']);
    const duty = rng.choice([0.5, 0.35, 0.15]);
    out = voice(
      n,
      (t) => f * (1.0 + depth * at(t)),
      (t) => base(t) * (1.0 - ampDepth * (0.5 - 0.5 * at(t))),
      shape,
      duty
    );
    const gritG = rng.uniform(0.0, 0.3);
    const gritty = gritG > 0.1;
    if (gritty) {
      const grit = tick(n, rng.randint(3, 14), rng.uniform(0.01, 0.06), atk, rate * 0.8);
      mixAt(out, grit, 0, gritG);
    }
    saturate(out, rng.uniform(1.0, 2.4));
    tags = {
      style: 'rumble',
      motion: depth > 0.022 ? 'churning' : 'steady',
      grit: gritty ? 'gritty' : 'smooth',
      tone: toneLabel(shape, duty),
      mod_hz: r1(modHz),
      note: noteName(m),
    };
  } else if (style === 'swell') {
    // Reverse crescendo with a tape-start pitch rise onto the note.
    const m = rng.randint(14, 34);
    const f = midi(m);
    const dur = rng.uniform(0.6, 1.9);
    const n = secs(dur);
    const rise = rng.uniform(0.5, 0.9) * dur;
    const curve = rng.uniform(1.2, 3.5);
    const bend = rng.uniform(0.02, 0.3);
    const relRate = rng.uniform(5.0, 22.0);
    const shape = rng.choice(['tri', 'tri', 'pulse', 'saw']);
    const duty = rng.choice([0.5, 0.4, 0.25]);
    const freqFn = (t) => f * (1.0 - bend * (1.0 - Math.min(1.0, t / rise)));
    const envFn = (t) => (t < rise ? Math.pow(t / rise, curve) : Math.exp(-relRate * (t - rise)));
    out = voice(n, freqFn, envFn, shape, duty);
    const shimG = rng.uniform(0.0, 0.4);
    const shimmer = shimG > 0.14;
    if (shimmer) {
      mixAt(out, renderTone(n, (t) => 2.0 * freqFn(t), 0.5, envFn, 'tri'), 0, shimG);
    }
    tags = {
      style: 'swell',
      curve: curve > 2.2 ? 'steep' : 'gradual',
      ring: shimmer ? 'octave shimmer' : 'pure sub',
      tone: toneLabel(shape, duty),
      rise_pct: r1(bend * 100),
      note: noteName(m),
    };
  } else if (style === 'gate') {
    // A sustain chopped at a real BPM subdivision — instant rhythm bed.
    const m = rng.randint(14, 34);
    const f = midi(m);
    const dur = rng.uniform(0.7, 1.95);
    const n = secs(dur);
    const bpm = rng.randint(78, 172);
    const divIdx = rng.randint(0, 3);
    const divName = ['quarter', '8th', 'triplet 8th', '16th'][divIdx];
    const perBeat = [1, 2, 3, 4][divIdx];
    const gateHz = (bpm / 60.0) * perBeat;
    const gDuty = rng.uniform(0.28, 0.72);
    const soft = rng.random() < 0.5;
    const alpha = soft ? rng.uniform(0.01, 0.06) : rng.uniform(0.25, 0.7);
    const floor = rng.uniform(0.0, 0.22);
    const shape = rng.choice(['tri', 'tri', 'pulse', 'saw']);
    const duty = rng.choice([0.5, 0.35, 0.2]);
    out = voice(n, () => f, envAD(0.004, rng.uniform(0.2, 1.0) / dur), shape, duty);
    let g = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      g += alpha * ((square(t * gateHz, gDuty) > 0 ? 1.0 : floor) - g);
      out[i] *= g;
    }
    saturate(out, rng.uniform(1.0, 2.2));
    tags = {
      style: 'gate',
      division: divName,
      edge: soft ? 'soft' : 'hard',
      tone: toneLabel(shape, duty),
      bpm,
      note: noteName(m),
    };
  } else if (style === 'octave') {
    // Octave (or fifth, or two-octave) jumps — the classic bassline move.
    const m = rng.randint(12, 26);
    const jump = rng.choice([7, 12, 12, 24].filter((j) => m + j <= 38));
    const steps = rng.randint(2, 6);
    const stepDur = rng.uniform(0.1, 0.3);
    const pattern = rng.choice(['alternating', 'inverted', 'pedal']);
    const retrig = rng.random() < 0.6;
    const shape = rng.choice(['tri', 'tri', 'pulse', 'saw']);
    const duty = rng.choice([0.5, 0.35, 0.2]);
    const noteAt = (k) => {
      if (pattern === 'alternating') return k % 2 === 0 ? m : m + jump;
      if (pattern === 'inverted') return k % 2 === 0 ? m + jump : m;
      return k === steps - 1 ? m + jump : m;
    };
    if (retrig) {
      out = [];
      const rate = rng.uniform(3.5, 7.0) / stepDur;
      for (let k = 0; k < steps; k++) {
        const fk = midi(noteAt(k));
        const nk = secs(stepDur * rng.uniform(0.9, 1.35));
        const seg = voice(nk, () => fk, envAD(0.003, rate), shape, duty);
        mixAt(out, seg, secs(stepDur * k), k === steps - 1 ? 1.0 : rng.uniform(0.72, 1.0));
      }
    } else {
      const n = secs(stepDur * steps);
      const total = stepDur * steps;
      out = voice(
        n,
        (t) => midi(noteAt(Math.min(steps - 1, Math.floor(t / stepDur)))),
        envAD(0.005, rng.uniform(0.6, 1.6) / total),
        shape,
        duty
      );
    }
    saturate(out, rng.uniform(1.0, 2.6));
    tags = {
      style: 'octave',
      pattern,
      leap: jump === 7 ? 'fifth' : jump === 12 ? 'octave' : 'two-octave',
      voicing: retrig ? 'retriggered' : 'legato',
      step_ms: r1(stepDur * 1000),
      note: noteName(m),
    };
  } else if (style === 'growl') {
    // Detuned reese stack under a wobbling one-pole — dubstep by way of the NES.
    const m = rng.randint(14, 32);
    const f = midi(m);
    const dur = rng.uniform(0.6, 1.9);
    const n = secs(dur);
    const cents = rng.uniform(6.0, 60.0);
    const det = Math.pow(2.0, cents / 1200.0);
    const triple = rng.random() < 0.4;
    const shape = rng.choice(['saw', 'saw', 'tri', 'pulse']);
    const duty = rng.choice([0.5, 0.3]);
    const wobHz = rng.uniform(1.2, 9.0);
    const stepped = rng.random() < 0.4;
    const env = envAD(rng.uniform(0.005, 0.03), rng.uniform(0.3, 1.4) / dur);
    out = voice(n, () => f, env, shape, duty);
    mixAt(out, voice(n, () => f * det, env, shape, duty, 0.37), 0, 0.85);
    if (triple) mixAt(out, voice(n, () => f / det, env, shape, duty, 0.12), 0, 0.7);
    const lfoBuf = stepped ? sampleHold(n, wobHz * 2.0, 0.12) : null;
    const aLo = rng.uniform(0.004, 0.02);
    const aHi = rng.uniform(0.05, 0.3);
    let p = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const l = lfoBuf ? 0.5 + 0.5 * lfoBuf[i] : 0.5 + 0.5 * Math.sin(2 * Math.PI * wobHz * t);
      const a = aLo + (aHi - aLo) * l;
      p += a * (out[i] - p);
      out[i] = p;
    }
    const fold = rng.random() < 0.35;
    if (fold) {
      const g = rng.uniform(1.4, 3.4);
      for (let i = 0; i < n; i++) out[i] = Math.sin(1.5 * g * out[i]);
    } else {
      saturate(out, rng.uniform(1.6, 4.0));
    }
    tags = {
      style: 'growl',
      voices: triple ? 'triple-stacked' : 'twin-detuned',
      drive: fold ? 'wavefolded' : 'saturated',
      motion: stepped ? 'stepped wobble' : 'sine wobble',
      wob_hz: r1(wobHz),
      note: noteName(m),
    };
  } else if (style === 'crush') {
    // Sample-and-hold rate reduction plus a coarse amplitude crush.
    const m = rng.randint(14, 34);
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(1.0, 3.0);
    const dur = rng.uniform(0.3, 1.1);
    const n = secs(dur);
    const tau = rng.uniform(0.01, 0.12);
    const atk = rng.uniform(0.001, 0.005);
    const rate = rng.uniform(1.8, 4.5) / dur;
    const shape = rng.choice(['tri', 'tri', 'pulse']);
    const duty = rng.choice([0.5, 0.4, 0.25]);
    out = voice(n, (t) => fEnd + (f0 - fEnd) * Math.exp(-t / tau), envAD(atk, rate), shape, duty);
    const hold = rng.randint(3, 40);
    const steps = rng.randint(2, 7);
    let held = 0.0;
    for (let i = 0; i < n; i++) {
      if (i % hold === 0) held = out[i];
      out[i] = Math.round(held * steps) / steps;
    }
    const softened = rng.random() < 0.4;
    if (softened) lowpass(out, rng.uniform(0.05, 0.3));
    tags = {
      style: 'crush',
      grit: hold > 16 ? 'chunky' : 'harsh',
      edge: softened ? 'softened' : 'raw',
      steps,
      crush_hz: Math.round(SR / hold),
      note: noteName(m),
    };
  } else {
    // PWM sub: the duty sweeps or LFOs and the harmonic stack moves with it.
    const m = rng.randint(14, 34);
    const f = midi(m);
    const dur = rng.uniform(0.4, 1.5);
    const n = secs(dur);
    const d0 = rng.uniform(0.08, 0.5);
    const d1 = rng.uniform(0.08, 0.5);
    const lfo = rng.random() < 0.45;
    const pwmHz = rng.uniform(0.8, 7.0);
    const dutyFn = lfo
      ? (t) => d0 + (d1 - d0) * (0.5 + 0.5 * Math.sin(2 * Math.PI * pwmHz * t))
      : (t) => d0 + (d1 - d0) * Math.min(1.0, t / dur);
    const atk = rng.uniform(0.004, 0.02);
    const rate = rng.uniform(0.5, 2.0) / dur;
    out = voice(n, () => f, envAD(atk, rate), 'pulse', dutyFn);
    const filtered = rng.random() < 0.6;
    if (filtered) lowpass(out, rng.uniform(0.01, 0.15));
    saturate(out, rng.uniform(1.0, 2.6));
    const subG = rng.uniform(0.0, 0.5);
    if (subG > 0.15) {
      mixAt(out, voice(n, () => f, envAD(atk, rate), 'tri'), 0, subG);
    }
    tags = {
      style: 'pulse',
      motion: lfo ? 'pulsing' : d1 > d0 ? 'opening' : 'closing',
      tone: filtered ? 'filtered' : 'raw',
      duty_from: r1(d0 * 100),
      duty_to: r1(d1 * 100),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every sub inside 0.21 - 1.98 s, block envelope-induced offset with a
  // corner low enough to leave a C0 fundamental alone, fade both edges to exactly
  // zero, then normalize last so the peak is exact.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  while (out.length < MIN_N) out.push(0.0);
  dcBlock(out, 0.997);
  const fi = Math.min(out.length >> 2, Math.round(0.0015 * SR));
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.015 * SR), Math.round(0.05 * out.length)));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = typeof t.note === 'string' && t.note ? t.note : 'C1';
  const tone = typeof t.tone === 'string' && t.tone ? t.tone : 'triangle';
  const num = (v, fb) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : fb;
  };
  switch (t.style) {
    case 'slide':
      return `808 sub slide — ${t.tone || 'clean'} ${t.glide || 'even-semitone'} portamento, ${note} to ${
        t.to || 'C2'
      } in ${num(t.glide_ms, 0).toFixed(1)} ms`;
    case 'drop':
      return `long sub drop — ${t.tail || 'booming'} ${t.drive || 'clean'} ${tone}, ${Math.trunc(
        num(t.top_hz, 0)
      )} Hz fall onto ${note}`;
    case 'hit':
      return `clean sub hit — ${t.body || 'firm'} ${tone} body, ${t.attack || 'clean'} attack, ${Math.trunc(
        num(t.top_hz, 0)
      )} Hz snap on ${note}`;
    case 'rumble':
      return `rumbling sub sustain — ${t.motion || 'steady'} ${tone}, ${t.grit || 'smooth'}, ${num(
        t.mod_hz,
        0
      ).toFixed(1)} Hz S&H on ${note}`;
    case 'swell':
      return `sub swell — ${t.curve || 'gradual'} ${tone} crescendo, ${t.ring || 'pure sub'}, ${num(
        t.rise_pct,
        0
      ).toFixed(1)}% bend onto ${note}`;
    case 'gate':
      return `gated sub — ${t.division || '8th'} chop at ${Math.trunc(num(t.bpm, 120))} BPM, ${
        t.edge || 'hard'
      } edges, ${tone} on ${note}`;
    case 'octave':
      return `octave-jump sub — ${t.pattern || 'alternating'} ${t.leap || 'octave'} hops, ${
        t.voicing || 'legato'
      }, ${num(t.step_ms, 0).toFixed(1)} ms steps on ${note}`;
    case 'growl':
      return `detuned sub growl — ${t.voices || 'twin-detuned'} ${t.drive || 'saturated'}, ${
        t.motion || 'sine wobble'
      } at ${num(t.wob_hz, 0).toFixed(1)} Hz on ${note}`;
    case 'crush':
      return `bit-crushed sub — ${Math.trunc(num(t.steps, 4))}-step ${t.grit || 'harsh'} ${
        t.edge || 'raw'
      }, ${Math.trunc(num(t.crush_hz, 0))} Hz hold on ${note}`;
    case 'pulse':
      return `pwm sub pulse — ${t.motion || 'opening'} ${t.tone || 'filtered'} sweep, ${num(
        t.duty_from,
        0
      ).toFixed(1)}% to ${num(t.duty_to, 0).toFixed(1)}% duty on ${note}`;
    default:
      return `sub-bass tone on ${note} — ${tone}, ${t.style || 'chip'} shaping`;
  }
}

/** Short phrase for the README category table. */
export const character = '808 slides, deep drops, gated and growling sub-bass';
