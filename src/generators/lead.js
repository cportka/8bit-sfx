// lead — the melody voice. Where `bass` holds down the bottom octaves, these are
// the notes that carry a tune: every fundamental is an exact MIDI number between
// C3 and C6, so a lead drops into a track already in tune with the bass, the
// chords and the arps.
//
// Ten sub-styles cover the lead patch vocabulary a chip track actually needs: a
// sustained NES square (steady or tremolo'd), a PWM lead whose pulse width
// breathes under an LFO or an envelope, a portamento glide between two notes, an
// expressive vibrato lead with a delayed onset, a two-to-four note lick, a note
// with rhythmic echo repeats, a detuned multi-voice fat lead, a hard staccato
// stab, a rapid two-pitch trill, and a pitch bend — scooped into, falling off,
// diving away or ramping up.
//
// Everything is built from the chip primitives: naive squares/triangles/saws,
// LFSR noise for the stab's attack click, hand-rolled one-pole filters, and a
// sample-and-hold level crush. Post-processing is uniform — DC block (narrow-duty
// squares carry a big bias), de-click both edges, then normalize last so the peak
// lands exactly on target even when the loudest sample is inside the first
// millisecond.

import {
  SR, Lfsr, square, midi, noteName, renderTone, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.1 * SR);
const MAX_N = Math.round(1.5 * SR);

const LO_M = 48; // C3
const HI_M = 84; // C6

/** Seconds to a sample count, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

/** One decimal place, for tag values that read better rounded. */
function r1(x) {
  return Math.round(x * 10) / 10;
}

/** Keep a MIDI note inside the category's C3..C6 window. */
function clampM(m) {
  return Math.max(LO_M, Math.min(HI_M, m));
}

/** "12.5% duty" / "25% duty" / "50% duty". */
function dutyLabel(d) {
  return `${d * 100}% duty`;
}

/** How a voice is described in the catalog. */
function toneLabel(wave, duty) {
  return wave === 'tri' ? 'triangle' : wave === 'saw' ? 'sawtooth' : dutyLabel(duty);
}

/** Cutoff source: a constant, a function of t, or a per-sample array. */
function cutoffReader(cutoff) {
  if (typeof cutoff === 'function') return (i) => cutoff(i / SR);
  if (Array.isArray(cutoff)) return (i) => cutoff[i];
  return () => cutoff;
}

/** One-pole lowpass in place, cutoff in Hz. */
function lowpass(buf, cutoff) {
  const fc = cutoffReader(cutoff);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    const c = Math.max(30, Math.min(SR * 0.45, fc(i)));
    const a = 1.0 - Math.exp((-2.0 * Math.PI * c) / SR);
    p += a * (buf[i] - p);
    buf[i] = p;
  }
  return buf;
}

/** Attack -> decay to a sustain level -> linear release into the note's end. */
function shaped(dur, atk, dec, sus, rel) {
  const a0 = Math.max(1e-4, atk);
  const d0 = Math.max(1e-4, dec);
  const r0 = Math.max(1e-4, rel);
  return (t) => {
    let a = t < a0 ? t / a0 : t < a0 + d0 ? 1.0 + (sus - 1.0) * ((t - a0) / d0) : sus;
    const left = dur - t;
    if (left < r0) a *= Math.max(0.0, left / r0);
    return a;
  };
}

/** Delayed vibrato: cents of pitch wobble, faded in over `delay` seconds. */
function vibratoFn(f, cents, hz, delay) {
  const d0 = Math.max(1e-4, delay);
  return (t) =>
    f * Math.pow(2.0, ((cents * Math.min(1.0, t / d0)) / 1200.0) * Math.sin(2 * Math.PI * hz * t));
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

const INTERVAL_NAMES = {
  1: 'semitone',
  2: 'whole-tone',
  3: 'minor third',
  4: 'major third',
  5: 'fourth',
  7: 'fifth',
  12: 'octave',
};

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'square', 'pwm', 'glide', 'vibrato', 'lick', 'echo', 'detune', 'stab', 'trill', 'bend',
  ]);

  // Lowpassed LFSR burst — the stab's pick/key click.
  const noiseTick = (n, period, alpha, atk, rate) => {
    const noise = new Lfsr(rng, period);
    const out = new Array(n);
    let prev = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      prev += alpha * (noise.next() - prev);
      out[i] = prev * Math.min(1.0, t / atk) * Math.exp(-rate * t);
    }
    return out;
  };

  let out;
  let tags;

  if (style === 'square') {
    // classic NES square lead: held, sometimes tremolo'd, sometimes blipped in
    const m = rng.randint(55, 84); // G3..C6
    const f = midi(m);
    const dur = rng.uniform(0.16, 1.15);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const wave = rng.choice([null, null, null, 'tri']);
    const atk = rng.uniform(0.001, 0.02);
    const dec = rng.uniform(0.02, 0.16);
    const sus = rng.uniform(0.45, 0.95);
    const rel = Math.min(dur * 0.45, rng.uniform(0.02, 0.18));
    const env = shaped(dur, atk, dec, sus, rel);
    const tremDepth = rng.uniform(0.0, 0.6);
    const trem = tremDepth > 0.22;
    const tremHz = rng.uniform(5.0, 15.0);
    out = renderTone(
      n,
      () => f,
      duty,
      (t) =>
        env(t) *
        (trem ? 1.0 - tremDepth * 0.5 * (1.0 - Math.cos(2 * Math.PI * tremHz * t)) : 1.0),
      wave
    );
    // A one-frame octave blip on the attack — the chip's way of saying "note on".
    const biteG = rng.uniform(0.0, 0.5);
    const bitten = biteG > 0.2;
    if (bitten) {
      mixAt(
        out,
        renderTone(Math.min(n, secs(0.02)), () => f * 2.0, 0.5, (t) => Math.min(1.0, t / 0.0006) * Math.exp(-90.0 * t)),
        0,
        biteG
      );
    }
    lowpass(out, f * rng.uniform(5.0, 18.0));
    tags = {
      style: 'square',
      tone: toneLabel(wave, duty),
      motion: trem ? 'tremolo' : 'steady hold',
      attack: bitten ? 'blipped' : 'clean',
      sus_pct: Math.round(sus * 100),
      note: noteName(m),
    };
  } else if (style === 'pwm') {
    // pulse-width lead: the duty cycle breathes under an LFO or an envelope
    const m = rng.randint(55, 84); // G3..C6
    const f = midi(m);
    const dur = rng.uniform(0.22, 1.3);
    const n = secs(dur);
    const motion = rng.choice(['lfo', 'lfo', 'rise', 'fall']);
    const center = rng.uniform(0.22, 0.5);
    const depth = rng.uniform(0.08, 0.3);
    const lo = Math.max(0.06, center - depth);
    const hi = Math.min(0.92, center + depth);
    const pwmHz = rng.uniform(0.5, 7.0);
    const tau = rng.uniform(0.04, 0.4);
    const sus = rng.uniform(0.55, 0.95);
    const env = shaped(
      dur,
      rng.uniform(0.002, 0.03),
      rng.uniform(0.02, 0.14),
      sus,
      Math.min(dur * 0.45, rng.uniform(0.03, 0.2))
    );
    out = new Array(n);
    let phase = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      phase += f / SR;
      let d;
      if (motion === 'lfo') {
        d = lo + (hi - lo) * (0.5 + 0.5 * Math.sin(2 * Math.PI * pwmHz * t));
      } else {
        const k = 1.0 - Math.exp(-t / tau);
        d = motion === 'rise' ? lo + (hi - lo) * k : hi - (hi - lo) * k;
      }
      out[i] = square(phase, d) * env(t);
    }
    lowpass(out, f * rng.uniform(6.0, 20.0));
    const rate = motion === 'lfo' ? pwmHz : 1.0 / tau;
    tags = {
      style: 'pwm',
      motion: motion === 'lfo' ? 'lfo sweep' : motion === 'rise' ? 'opening' : 'closing',
      speed: rate > 4.0 ? 'fluttering' : 'breathing',
      body: sus > 0.8 ? 'full' : 'tapered',
      rate_hz: r1(rate),
      low_pct: Math.round(lo * 100),
      high_pct: Math.round(hi * 100),
      note: noteName(m),
    };
  } else if (style === 'glide') {
    // portamento: the pitch slides out of a neighbouring note into this one
    const m = rng.randint(52, 82); // E3..A#5 landing pitch
    const step = rng.choice([-12, -7, -5, -4, -3, -2, 2, 3, 4, 5, 7, 12]);
    const fromM = clampM(m + step);
    const f = midi(m);
    const dur = rng.uniform(0.25, 1.2);
    const n = secs(dur);
    const glide = rng.uniform(0.015, 0.18);
    const curve = rng.choice(['exponential', 'exponential', 'linear']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const wave = rng.choice([null, null, 'tri']);
    const sus = rng.uniform(0.5, 0.95);
    const env = shaped(
      dur,
      rng.uniform(0.001, 0.012),
      rng.uniform(0.03, 0.15),
      sus,
      Math.min(dur * 0.45, rng.uniform(0.03, 0.2))
    );
    // A little vibrato creeps in once the slide has landed.
    const vibC = rng.uniform(0.0, 40.0);
    const vibHz = rng.uniform(4.5, 7.5);
    out = renderTone(
      n,
      (t) => {
        const k = curve === 'linear' ? Math.max(0.0, 1.0 - t / glide) : Math.exp(-t / glide);
        const wob = Math.min(1.0, Math.max(0.0, t - glide) / 0.15);
        return (
          midi(m + (fromM - m) * k) *
          Math.pow(2.0, ((vibC * wob) / 1200.0) * Math.sin(2 * Math.PI * vibHz * t))
        );
      },
      duty,
      env,
      wave
    );
    lowpass(out, f * rng.uniform(5.0, 16.0));
    tags = {
      style: 'glide',
      direction: fromM < m ? 'up' : 'down',
      curve,
      tone: toneLabel(wave, duty),
      from: noteName(fromM),
      glide_ms: Math.round(glide * 1000),
      note: noteName(m),
    };
  } else if (style === 'vibrato') {
    // expressive lead: deep vibrato, usually held back until the note settles
    const m = rng.randint(57, 84); // A3..C6
    const f = midi(m);
    const dur = rng.uniform(0.35, 1.4);
    const n = secs(dur);
    const cents = rng.uniform(12.0, 90.0);
    const vibHz = rng.uniform(3.8, 8.5);
    const delay = rng.uniform(0.01, 0.35);
    const atk = rng.uniform(0.002, 0.12);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const wave = rng.choice([null, null, 'tri']);
    const sus = rng.uniform(0.6, 0.98);
    const env = shaped(
      dur,
      atk,
      rng.uniform(0.03, 0.2),
      sus,
      Math.min(dur * 0.45, rng.uniform(0.04, 0.25))
    );
    out = renderTone(n, vibratoFn(f, cents, vibHz, delay), duty, env, wave);
    lowpass(out, f * rng.uniform(5.0, 16.0));
    tags = {
      style: 'vibrato',
      onset: delay > 0.09 ? 'delayed' : 'immediate',
      attack: atk > 0.03 ? 'swelled' : 'plucked',
      tone: toneLabel(wave, duty),
      depth_cents: Math.round(cents),
      vib_hz: r1(vibHz),
      note: noteName(m),
    };
  } else if (style === 'lick') {
    // a short melodic lick: two to four notes, straight or swung
    const pat = rng.choice([
      { name: 'root to fifth', steps: [0, 7] },
      { name: 'root to octave', steps: [0, 12] },
      { name: 'minor third up', steps: [0, 3] },
      { name: 'major third up', steps: [0, 4] },
      { name: 'fourth leap', steps: [0, 5] },
      { name: 'fifth down to root', steps: [7, 0] },
      { name: 'octave drop', steps: [12, 0] },
      { name: 'grace note run', steps: [0, 2, 3] },
      { name: 'up-down turn', steps: [0, 5, 0] },
      { name: 'major climb', steps: [0, 4, 7] },
      { name: 'pentatonic run', steps: [0, 3, 5, 7] },
    ]);
    let top = 0;
    for (const s of pat.steps) if (s > top) top = s;
    const m = rng.randint(52, HI_M - top); // every note stays inside C3..C6
    const step = rng.uniform(0.06, 0.17);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const wave = rng.choice([null, null, 'tri', 'saw']);
    const rate = rng.uniform(3.5, 9.0) / step;
    const cMul = rng.uniform(5.0, 18.0);
    const tail = rng.uniform(0.08, 0.3);
    const swing = rng.uniform(0.0, 0.16); // every other note nudged late
    const size = pat.steps.length === 2 ? 'two-note' : pat.steps.length === 3 ? 'three-note' : 'four-note';
    out = [];
    for (let k = 0; k < pat.steps.length; k++) {
      const nm = m + pat.steps[k];
      const nf = midi(nm);
      const last = k === pat.steps.length - 1;
      const nn = secs(step + (last ? tail : 0.03));
      const v = renderTone(
        nn,
        () => nf,
        duty,
        (t) => Math.min(1.0, t / 0.0015) * Math.exp(-(last ? rate * 0.55 : rate) * t),
        wave
      );
      lowpass(v, nf * cMul);
      mixAt(out, v, secs(k * step + (k % 2 === 1 ? swing * step : 0.0)), k === 0 ? 1.0 : rng.uniform(0.6, 1.0));
    }
    tags = {
      style: 'lick',
      pattern: pat.name,
      size,
      feel: swing > 0.08 ? 'swung' : 'straight',
      tone: toneLabel(wave, duty),
      bpm: Math.round(15.0 / step), // each step is a sixteenth
      note: noteName(m),
    };
  } else if (style === 'echo') {
    // one note plus its rhythmic repeats — instant chip delay, baked in
    // The mode is drawn first so an octave-up repeat still lands inside C6.
    const mode = rng.choice(['dark', 'dark', 'octave', 'plain']);
    const m = mode === 'octave' ? rng.randint(55, 72) : rng.randint(57, 82);
    const f = midi(m);
    const repeats = rng.randint(2, 5);
    const delay = rng.uniform(0.055, 0.18);
    const fb = rng.uniform(0.4, 0.78);
    const noteDur = Math.min(delay * rng.uniform(0.7, 1.4), 0.22);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const wave = rng.choice([null, null, 'tri']);
    const rate = rng.uniform(3.0, 8.0) / Math.max(0.03, noteDur);
    const cut0 = f * rng.uniform(6.0, 18.0);
    const tail = rng.uniform(0.04, 0.14);
    out = [];
    for (let k = 0; k <= repeats; k++) {
      const kf = mode === 'octave' && k > 0 ? f * 2.0 : f;
      const nn = secs(noteDur + (k === repeats ? tail : 0.02));
      const v = renderTone(
        nn,
        () => kf,
        duty,
        (t) => Math.min(1.0, t / 0.0012) * Math.exp(-rate * t),
        wave
      );
      lowpass(v, mode === 'dark' ? Math.max(f * 1.4, cut0 * Math.pow(0.7, k)) : cut0);
      mixAt(out, v, secs(k * delay), Math.pow(fb, k));
    }
    tags = {
      style: 'echo',
      mode: mode === 'dark' ? 'darkening' : mode === 'octave' ? 'octave-up' : 'plain',
      tone: toneLabel(wave, duty),
      repeats,
      delay_ms: Math.round(delay * 1000),
      fb_pct: Math.round(fb * 100),
      note: noteName(m),
    };
  } else if (style === 'detune') {
    // fat lead: two or three voices beating against each other
    const m = rng.randint(55, 82); // G3..A#5
    const f = midi(m);
    const voices = rng.randint(2, 3);
    const cents = rng.uniform(5.0, 32.0);
    const dur = rng.uniform(0.25, 1.3);
    const n = secs(dur);
    const wave = rng.choice([null, null, 'saw']);
    const duty = rng.choice([0.5, 0.25]);
    const sus = rng.uniform(0.55, 0.95);
    const env = shaped(
      dur,
      rng.uniform(0.002, 0.025),
      rng.uniform(0.03, 0.16),
      sus,
      Math.min(dur * 0.45, rng.uniform(0.03, 0.22))
    );
    const offsets = voices === 2 ? [-cents / 2, cents / 2] : [-cents, 0.0, cents];
    out = new Array(n).fill(0.0);
    for (const c of offsets) {
      const vf = f * Math.pow(2.0, c / 1200.0);
      mixAt(out, renderTone(n, () => vf, duty, env, wave), 0, 1.0 / offsets.length);
    }
    // An octave-down triangle adds weight without moving the perceived pitch.
    const octG = rng.uniform(0.0, 0.55);
    const stacked = octG > 0.2;
    if (stacked) mixAt(out, renderTone(n, () => f * 0.5, 0.5, env, 'tri'), 0, octG);
    lowpass(out, f * rng.uniform(5.0, 16.0));
    tags = {
      style: 'detune',
      spread: cents > 18.0 ? 'wide' : 'shimmering',
      stack: stacked ? 'octave under' : 'raw stack',
      tone: toneLabel(wave, duty),
      voices,
      cents: r1(cents),
      note: noteName(m),
    };
  } else if (style === 'stab') {
    // hard staccato stab: instant attack, gone before the next sixteenth
    const m = rng.randint(52, 84); // E3..C6
    const f = midi(m);
    const dur = rng.uniform(0.1, 0.3);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const wave = rng.choice([null, null, 'saw']);
    const rate = rng.uniform(7.0, 20.0) / dur;
    const drop = rng.uniform(0.0, 0.1); // the pitch sags as the stab dies
    const dtau = rng.uniform(0.02, 0.1);
    const rel = Math.min(dur * 0.5, rng.uniform(0.01, 0.06));
    out = renderTone(
      n,
      (t) => f * (1.0 - drop * (1.0 - Math.exp(-t / dtau))),
      duty,
      (t) => {
        const a = Math.min(1.0, t / 0.0008) * Math.exp(-rate * t);
        const left = dur - t;
        return left < rel ? a * Math.max(0.0, left / rel) : a;
      },
      wave
    );
    const cut = Math.min(SR * 0.44, f * rng.uniform(6.0, 24.0));
    lowpass(out, cut);
    const clickG = rng.uniform(0.0, 0.5);
    const clicked = clickG > 0.18;
    if (clicked) {
      mixAt(
        out,
        noiseTick(Math.min(n, secs(0.006)), rng.randint(1, 3), rng.uniform(0.5, 0.95), 0.0004, rng.uniform(400, 1200)),
        0,
        clickG
      );
    }
    const steps = rng.randint(3, 12);
    const crushed = steps < 8;
    if (crushed) crush(out, steps, rng.randint(1, 3));
    tags = {
      style: 'stab',
      grit: crushed ? 'crushed' : 'clean',
      hit: clicked ? 'clicked' : 'soft',
      fall: drop > 0.045 ? 'dropping' : 'steady',
      snap_hz: Math.round(cut),
      note: noteName(m),
    };
  } else if (style === 'trill') {
    // trill: two pitches alternating faster than the ear separates them
    const iv = rng.choice([1, 2, 3, 4, 5, 7, 12]);
    const m = rng.randint(57, HI_M - iv); // the upper pitch stays inside C6
    const f = midi(m);
    const dur = rng.uniform(0.2, 0.95);
    const n = secs(dur);
    const rate = rng.uniform(8.0, 26.0);
    const accel = rng.uniform(0.0, 1.2); // the trill can tighten as it goes
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const wave = rng.choice([null, null, 'tri']);
    const sus = rng.uniform(0.5, 0.95);
    const env = shaped(
      dur,
      rng.uniform(0.001, 0.01),
      rng.uniform(0.03, 0.2),
      sus,
      Math.min(dur * 0.45, rng.uniform(0.03, 0.15))
    );
    const up = Math.pow(2.0, iv / 12.0);
    out = renderTone(
      n,
      (t) => {
        // integral of rate*(1 + accel*t/dur) — the alternation phase in cycles
        const cyc = rate * t * (1.0 + (accel * t) / (2.0 * dur));
        return Math.floor(cyc * 2.0) % 2 === 0 ? f : f * up;
      },
      duty,
      env,
      wave
    );
    lowpass(out, f * rng.uniform(6.0, 18.0));
    tags = {
      style: 'trill',
      interval: INTERVAL_NAMES[iv],
      motion: accel > 0.4 ? 'accelerating' : 'even-paced',
      tone: toneLabel(wave, duty),
      rate_hz: r1(rate),
      note: noteName(m),
    };
  } else {
    // pitch bend: scooped into, falling off the end, diving away, or ramping up
    const shape = rng.choice(['scoop', 'scoop', 'fall', 'dive', 'rise']);
    const m = rng.randint(55, 82); // G3..A#5
    const f = midi(m);
    const dur = rng.uniform(0.18, 1.1);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const wave = rng.choice([null, null, 'saw']);
    const amt =
      shape === 'dive' ? rng.uniform(5.0, 20.0) : shape === 'rise' ? rng.uniform(2.0, 12.0) : rng.uniform(0.5, 5.0);
    const tau = rng.uniform(0.02, 0.12);
    const start = dur * rng.uniform(0.5, 0.8); // where a "fall off" lets go
    const sus = rng.uniform(0.5, 0.95);
    const env = shaped(
      dur,
      rng.uniform(0.001, 0.015),
      rng.uniform(0.03, 0.16),
      sus,
      Math.min(dur * 0.45, rng.uniform(0.03, 0.2))
    );
    const bendM = (t) => {
      if (shape === 'scoop') return m - amt * Math.exp(-t / tau);
      if (shape === 'fall') return m - amt * Math.max(0.0, (t - start) / Math.max(1e-4, dur - start));
      if (shape === 'dive') return m - amt * (t / dur);
      return m - amt * (1.0 - t / dur);
    };
    out = renderTone(n, (t) => midi(Math.max(30.0, bendM(t))), duty, env, wave);
    lowpass(out, f * rng.uniform(5.0, 18.0));
    tags = {
      style: 'bend',
      shape:
        shape === 'scoop'
          ? 'scooped up into'
          : shape === 'fall'
            ? 'falls off'
            : shape === 'dive'
              ? 'dives down from'
              : 'ramps up into',
      depth: amt > 7.0 ? 'whammy' : 'expressive',
      tone: toneLabel(wave, duty),
      semis: r1(amt),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every lead inside 0.1 - 1.5 s, block the duty-cycle DC bias, then
  // de-click both edges before normalizing so the peak is exact even when the
  // loudest sample sits inside the first millisecond.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  const fi = Math.min(out.length >> 2, 12);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.004 * SR), Math.round(0.04 * out.length)));
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
  const dec = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toFixed(1);
  switch (t.style) {
    case 'pwm':
      return `pwm chip lead — ${t.motion || 'lfo sweep'} ${num(t.low_pct)}-${num(t.high_pct)}% duty, ${dec(t.rate_hz)} Hz on ${note}`;
    case 'glide':
      return `portamento lead — ${t.curve || 'exponential'} glide ${t.direction || 'up'} from ${t.from || 'C4'}, ${num(t.glide_ms)} ms to ${note}`;
    case 'vibrato':
      return `vibrato lead — ${num(t.depth_cents)} cents at ${dec(t.vib_hz)} Hz, ${t.onset || 'delayed'} onset, ${t.attack || 'plucked'} on ${note}`;
    case 'lick':
      return `${t.size || 'two-note'} lead lick — ${t.pattern || 'root to fifth'}, ${t.feel || 'straight'} ${t.tone || '50% duty'} at ${num(t.bpm)} BPM from ${note}`;
    case 'echo':
      return `echo lead — ${num(t.repeats)} ${t.mode || 'darkening'} taps ${num(t.delay_ms)} ms apart, ${num(t.fb_pct)}% on ${note}`;
    case 'detune':
      return `detuned lead — ${num(t.voices)} ${t.spread || 'wide'} voices ${dec(t.cents)} cents apart, ${t.stack || 'raw stack'} on ${note}`;
    case 'stab':
      return `hard lead stab — ${t.hit || 'soft'} ${t.grit || 'clean'} ${t.tone || '50% duty'}, ${t.fall || 'steady'} pitch, ${num(t.snap_hz)} Hz snap on ${note}`;
    case 'trill':
      return `trill lead — ${t.interval || 'minor third'} trill at ${dec(t.rate_hz)} Hz, ${t.motion || 'even-paced'}, ${t.tone || '50% duty'} on ${note}`;
    case 'bend':
      return `bend lead — ${t.shape || 'scooped up into'} ${note}, ${t.depth || 'expressive'} ${dec(t.semis)}-semitone ${t.tone || '50% duty'}`;
    default:
      return `square chip lead — ${t.tone || '50% duty'}, ${t.motion || 'steady hold'}, ${t.attack || 'clean'} attack holding ${num(t.sus_pct)}% at ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'square and PWM chip leads, glides, licks, echoes, stabs';
