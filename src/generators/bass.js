// bass — playable low notes, ten ways. Where `kick` is a drum that happens to
// have a pitch, everything here is a *note*: the fundamental is an exact MIDI
// number between E1 and G3, so these sit in a track next to the leads and
// chords without retuning.
//
// The ten sub-styles are the bass patch vocabulary a chip track actually needs:
// a plucked finger/pick note, a sustained NES square (steady, vibrato or PWM),
// a 303-flavoured acid line with a resonant sweep and an optional slide, an
// LFO wobble, a slap with its thumb thump or string pop, a palm-muted staccato
// stab, a detuned multi-voice fat patch, an octave-doubled patch, a
// ring-modulated growl, and a short walking riff of two to four notes.
//
// Everything is built from the chip primitives: naive squares/triangles/saws,
// LFSR noise for pick and thumb transients, a 4-bit sample-and-hold for the
// wobble LFO, hand-rolled one-pole and state-variable filters, and a level
// crush. Post-processing is uniform — DC block (narrow-duty squares carry a
// big bias), de-click both edges, then normalize last so the peak lands exactly
// on target even when the loudest sample is inside the first millisecond.

import {
  SR, Lfsr, square, midi, noteName, renderTone, finish, mixAt, dcBlock,
} from '../dsp.js';

const MIN_N = Math.round(0.1 * SR);
const MAX_N = Math.round(1.5 * SR);

/** Seconds to a sample count, never zero-length. */
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
    const c = Math.max(20, Math.min(SR * 0.45, fc(i)));
    const a = 1.0 - Math.exp((-2.0 * Math.PI * c) / SR);
    p += a * (buf[i] - p);
    buf[i] = p;
  }
  return buf;
}

/**
 * Chamberlin state-variable lowpass with resonance, 2x oversampled so the
 * squelchy end of the Q range stays stable. `q` is 1/Q; the states are clamped
 * so a hard sweep can never blow the filter up.
 */
function resonant(buf, cutoff, q) {
  const fc = cutoffReader(cutoff);
  const damp = Math.max(0.15, Math.min(1.6, q));
  const drive = 0.45 + 0.55 * damp; // keep the resonant peak near the passband
  let low = 0.0;
  let band = 0.0;
  for (let i = 0; i < buf.length; i++) {
    const c = Math.max(25, Math.min(SR / 6, fc(i)));
    const f = 2.0 * Math.sin((Math.PI * c) / (2 * SR));
    const x = buf[i] * drive;
    for (let k = 0; k < 2; k++) {
      const high = x - low - damp * band;
      band += f * high;
      if (band > 4.0) band = 4.0;
      else if (band < -4.0) band = -4.0;
      low += f * band;
      if (low > 4.0) low = 4.0;
      else if (low < -4.0) low = -4.0;
    }
    buf[i] = low;
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

/** Sample-and-hold rate reduction plus a coarse level crush, in place. */
function crush(buf, steps, hold) {
  let held = 0.0;
  for (let i = 0; i < buf.length; i++) {
    if (i % hold === 0) held = buf[i];
    buf[i] = Math.round(held * steps) / steps;
  }
  return buf;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'pluck', 'square', 'acid', 'wobble', 'slap', 'muted', 'fat', 'octave', 'growl', 'walk',
  ]);

  // Lowpassed LFSR burst — the pick scrape / thumb slap transient.
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

  if (style === 'pluck') {
    // plucked bass: hard attack, filter closing as the string dies away
    const m = rng.randint(28, 50); // E1..D3
    const f = midi(m);
    const dur = rng.uniform(0.16, 0.55);
    const n = secs(dur);
    const wave = rng.choice([null, null, 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const rate = rng.uniform(3.5, 8.0) / dur;
    const atk = rng.uniform(0.0008, 0.004);
    const blip = rng.uniform(0.0, 0.05); // attack pitch snap, like a string stretching
    const btau = rng.uniform(0.004, 0.02);
    out = renderTone(
      n,
      (t) => f * (1.0 + blip * Math.exp(-t / btau)),
      duty,
      (t) => Math.min(1.0, t / atk) * Math.exp(-rate * t),
      wave
    );
    const cTop = f * rng.uniform(8.0, 26.0);
    const cEnd = f * rng.uniform(1.6, 4.0);
    const ctau = rng.uniform(0.02, 0.12);
    lowpass(out, (t) => cEnd + (cTop - cEnd) * Math.exp(-t / ctau));
    const pickG = rng.uniform(0.0, 0.5);
    const picked = pickG > 0.15;
    if (picked) {
      mixAt(
        out,
        noiseTick(Math.min(n, secs(rng.uniform(0.003, 0.012))), rng.randint(1, 3), rng.uniform(0.5, 0.9), 0.0005, rng.uniform(220, 620)),
        0,
        pickG
      );
    }
    tags = {
      style: 'pluck',
      tone: toneLabel(wave, duty),
      attack: picked ? 'picked' : 'fingered',
      decay: rate * dur > 6.0 ? 'short' : 'ringing',
      open_hz: Math.round(cTop),
      note: noteName(m),
    };
  } else if (style === 'square') {
    // sustained NES square bass: steady, vibrato'd, or breathing on a PWM sweep
    const m = rng.randint(28, 55); // E1..G3
    const f = midi(m);
    const dur = rng.uniform(0.3, 1.2);
    const n = secs(dur);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const motion = rng.choice(['steady', 'steady', 'vibrato', 'pwm']);
    const atk = rng.uniform(0.002, 0.02);
    const dec = rng.uniform(0.02, 0.14);
    const sus = rng.uniform(0.55, 0.92);
    const rel = Math.min(dur * 0.45, rng.uniform(0.03, 0.2));
    const env = shaped(dur, atk, dec, sus, rel);
    const vibHz = rng.uniform(4.0, 7.5);
    const vibCents = rng.uniform(6.0, 32.0);
    const vibDelay = rng.uniform(0.04, 0.25);
    const pwmHz = rng.uniform(0.4, 3.0);
    const pwmDepth = rng.uniform(0.05, 0.22);
    if (motion === 'pwm') {
      out = new Array(n);
      let phase = 0.0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        phase += f / SR;
        const d = Math.max(0.06, Math.min(0.9, duty + pwmDepth * Math.sin(2 * Math.PI * pwmHz * t)));
        out[i] = square(phase, d) * env(t);
      }
    } else {
      const depth = motion === 'vibrato' ? vibCents : 0.0;
      out = renderTone(
        n,
        (t) => f * Math.pow(2.0, ((depth * Math.min(1.0, t / vibDelay)) / 1200.0) * Math.sin(2 * Math.PI * vibHz * t)),
        duty,
        env
      );
    }
    lowpass(out, f * rng.uniform(4.0, 14.0));
    tags = {
      style: 'square',
      tone: dutyLabel(duty),
      motion: motion === 'vibrato' ? 'vibrato' : motion === 'pwm' ? 'pwm sweep' : 'steady hold',
      body: sus > 0.78 ? 'full' : 'tapered',
      sus_pct: Math.round(sus * 100),
      note: noteName(m),
    };
  } else if (style === 'acid') {
    // 303-flavoured acid: resonant cutoff sweep, optional slide into the note
    const m = rng.randint(28, 47); // E1..B2
    const f = midi(m);
    const dur = rng.uniform(0.22, 0.95);
    const n = secs(dur);
    const wave = rng.choice(['saw', 'saw', null]);
    const duty = rng.choice([0.5, 0.25]);
    const slid = rng.random() < 0.45;
    const step = rng.choice([-12, -7, -5, 5, 7, 12]);
    const fromM = slid ? Math.max(26, Math.min(55, m + step)) : m;
    const glide = rng.uniform(0.02, 0.09);
    const cTop = Math.min(SR / 6, f * rng.uniform(6.0, 22.0));
    const cEnd = Math.max(40.0, f * rng.uniform(1.1, 3.0));
    const ctau = rng.uniform(0.04, 0.35);
    const qFactor = rng.uniform(2.0, 6.5);
    const accent = rng.random() < 0.45;
    const rate = rng.uniform(1.2, 4.5) / dur;
    const rel = Math.min(dur * 0.4, rng.uniform(0.02, 0.1));
    out = renderTone(
      n,
      (t) => midi(m + (fromM - m) * Math.exp(-t / glide)),
      duty,
      (t) => {
        const a = Math.min(1.0, t / 0.002) * Math.exp(-rate * t);
        const left = dur - t;
        return left < rel ? a * Math.max(0.0, left / rel) : a;
      },
      wave
    );
    resonant(out, (t) => cEnd + (cTop - cEnd) * Math.exp(-t / ctau), 1.0 / qFactor);
    const drive = accent ? rng.uniform(1.8, 4.0) : rng.uniform(1.0, 1.8);
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) out[i] = Math.tanh(drive * out[i]) / norm;
    tags = {
      style: 'acid',
      filter: qFactor > 4.2 ? 'squelchy' : 'liquid',
      glide: slid ? `slide from ${noteName(fromM)}` : 'no slide',
      bite: accent ? 'accented' : 'flat',
      cutoff_hz: Math.round(cTop),
      res: r1(qFactor),
      note: noteName(m),
    };
  } else if (style === 'wobble') {
    // LFO bass: a sustained note chewed by a filter sweep or an amplitude gate
    const m = rng.randint(28, 45); // E1..A2
    const f = midi(m);
    const dur = rng.uniform(0.45, 1.5);
    const n = secs(dur);
    const wave = rng.choice([null, 'saw']);
    const duty = rng.choice([0.5, 0.25]);
    const shape = rng.choice(['sine', 'square', 'ramp', 's&h']);
    const wobHz = rng.uniform(2.0, 11.0);
    const target = rng.choice(['filter', 'filter', 'amp']);
    const rel = Math.min(dur * 0.35, rng.uniform(0.03, 0.15));
    out = renderTone(n, () => f, duty, shaped(dur, rng.uniform(0.003, 0.02), 0.05, 0.9, rel), wave);
    // The LFO, in [0,1]. s&h reads four successive LFSR bits per hold — a
    // 4-bit sample-and-hold, exactly what a chip's noise channel gives you.
    const lfo = new Array(n);
    const sh = new Lfsr(rng, 1);
    const hold = Math.max(1, Math.round(SR / Math.max(1.0, wobHz * 2)));
    let held = 0.5;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      if (shape === 'sine') lfo[i] = 0.5 + 0.5 * Math.sin(2 * Math.PI * wobHz * t);
      else if (shape === 'square') lfo[i] = square(t * wobHz, 0.5) > 0 ? 1.0 : 0.0;
      else if (shape === 'ramp') lfo[i] = 1.0 - (((t * wobHz) % 1.0) + 1.0) % 1.0;
      else {
        if (i % hold === 0) {
          let v = 0;
          for (let k = 0; k < 4; k++) v = v * 2 + (sh.next() > 0 ? 1 : 0);
          held = v / 15.0;
        }
        lfo[i] = held;
      }
    }
    let numeric;
    if (target === 'filter') {
      const cLo = Math.max(45.0, f * rng.uniform(1.2, 2.5));
      const cHi = Math.min(SR / 6, f * rng.uniform(6.0, 20.0));
      const qFactor = rng.uniform(1.6, 5.0);
      const cut = new Array(n);
      for (let i = 0; i < n; i++) cut[i] = cLo * Math.pow(cHi / cLo, lfo[i]);
      resonant(out, cut, 1.0 / qFactor);
      numeric = Math.round(cHi);
    } else {
      const floor = rng.uniform(0.0, 0.3);
      let g = 0.0;
      for (let i = 0; i < n; i++) {
        g += 0.25 * (floor + (1.0 - floor) * lfo[i] - g); // smoothed so the gate never clicks
        out[i] *= g;
      }
      lowpass(out, f * rng.uniform(4.0, 12.0));
      numeric = Math.round(floor * 100);
    }
    tags = {
      style: 'wobble',
      lfo: shape === 's&h' ? 'sample-hold' : shape === 'ramp' ? 'ramp' : shape,
      target: target === 'filter' ? 'filter sweep' : 'amp gate',
      tone: toneLabel(wave, duty),
      wob_hz: r1(wobHz),
      depth_hz: numeric,
      note: noteName(m),
    };
  } else if (style === 'slap') {
    // slap bass: a thumb thump or a string pop, then a fast-closing bright body
    const m = rng.randint(31, 52); // G1..E3
    const f = midi(m);
    const pop = rng.random() < 0.45;
    const dur = pop ? rng.uniform(0.18, 0.42) : rng.uniform(0.22, 0.6);
    const n = secs(dur);
    const wave = rng.choice([null, 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const rate = rng.uniform(4.0, 9.0) / dur;
    const bend = rng.uniform(0.0, 0.07); // the string stretches under the thumb
    out = renderTone(
      n,
      (t) => f * (1.0 + bend * Math.exp(-t / 0.012)),
      duty,
      (t) => Math.min(1.0, t / 0.0009) * (0.25 + 0.75 * Math.exp(-rate * t)) * Math.exp(-2.2 * t),
      wave
    );
    const cTop = Math.min(SR / 6, f * rng.uniform(14.0, 40.0));
    const cEnd = f * rng.uniform(1.8, 4.5);
    const ctau = rng.uniform(0.01, 0.05);
    resonant(out, (t) => cEnd + (cTop - cEnd) * Math.exp(-t / ctau), 1.0 / rng.uniform(1.4, 3.4));
    const snapG = pop ? rng.uniform(0.35, 0.7) : rng.uniform(0.2, 0.45);
    mixAt(
      out,
      noiseTick(Math.min(n, secs(pop ? 0.006 : 0.012)), rng.randint(1, 2), pop ? rng.uniform(0.6, 0.95) : rng.uniform(0.15, 0.45), 0.0005, rng.uniform(300, 900)),
      0,
      snapG
    );
    if (pop) {
      // the popped string rings an octave up for a moment
      mixAt(
        out,
        renderTone(Math.min(n, secs(0.06)), () => f * 2.0, 0.5, (t) => Math.min(1.0, t / 0.001) * Math.exp(-38.0 * t)),
        0,
        rng.uniform(0.15, 0.45)
      );
    }
    // Soft-limit so the snap sits on top of the note instead of burying it —
    // without this the transient owns the peak and the body quantizes to mush.
    const lim = rng.uniform(1.6, 3.0);
    const lnorm = Math.tanh(lim);
    for (let i = 0; i < out.length; i++) out[i] = Math.tanh(lim * out[i]) / lnorm;
    tags = {
      style: 'slap',
      snap: pop ? 'string pop' : 'thumb thump',
      body: cTop > f * 26.0 ? 'bright' : 'round',
      decay: rate * dur > 6.5 ? 'clipped' : 'sustained',
      open_hz: Math.round(cTop),
      note: noteName(m),
    };
  } else if (style === 'muted') {
    // palm-muted staccato: a dead, thuddy stab, sometimes doubled
    const m = rng.randint(28, 55); // E1..G3
    const f = midi(m);
    const dur = rng.uniform(0.1, 0.26);
    const n = secs(dur);
    const wave = rng.choice([null, null, 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const rate = rng.uniform(6.0, 15.0) / dur;
    const cut = f * rng.uniform(2.2, 7.0);
    const hit = () => {
      const b = renderTone(n, () => f, duty, (t) => Math.min(1.0, t / 0.0012) * Math.exp(-rate * t), wave);
      lowpass(b, cut);
      return b;
    };
    out = hit();
    const doubled = rng.random() < 0.4;
    const gap = rng.uniform(0.06, 0.14);
    if (doubled) mixAt(out, hit(), secs(gap), rng.uniform(0.5, 0.9));
    const thumpG = rng.uniform(0.0, 0.4);
    const thumped = thumpG > 0.12;
    if (thumped) {
      mixAt(out, noiseTick(Math.min(n, secs(0.008)), rng.randint(2, 5), rng.uniform(0.1, 0.35), 0.0006, rng.uniform(120, 420)), 0, thumpG);
    }
    tags = {
      style: 'muted',
      damp: cut < f * 4.0 ? 'dead' : 'palm-muted',
      hits: doubled ? 'double stab' : 'single stab',
      tone: toneLabel(wave, duty),
      damp_hz: Math.round(cut),
      note: noteName(m),
    };
  } else if (style === 'fat') {
    // detuned fat bass: two or three voices beating slowly against each other
    const m = rng.randint(28, 48); // E1..C3
    const f = midi(m);
    const voices = rng.randint(2, 3);
    const cents = rng.uniform(4.0, 26.0);
    const dur = rng.uniform(0.3, 1.2);
    const n = secs(dur);
    const wave = rng.choice([null, null, 'saw']);
    const duty = rng.choice([0.5, 0.25]);
    const sus = rng.uniform(0.5, 0.9);
    const env = shaped(dur, rng.uniform(0.002, 0.018), rng.uniform(0.03, 0.15), sus, Math.min(dur * 0.4, rng.uniform(0.04, 0.2)));
    const offsets = voices === 2 ? [-cents / 2, cents / 2] : [-cents, 0.0, cents];
    out = new Array(n).fill(0.0);
    for (const c of offsets) {
      const vf = f * Math.pow(2.0, c / 1200.0);
      mixAt(out, renderTone(n, () => vf, duty, env, wave), 0, 1.0 / offsets.length);
    }
    const subG = rng.uniform(0.0, 0.5);
    const subbed = subG > 0.18;
    if (subbed) mixAt(out, renderTone(n, () => f, 0.5, env, 'tri'), 0, subG);
    lowpass(out, f * rng.uniform(4.0, 13.0));
    tags = {
      style: 'fat',
      spread: cents > 16.0 ? 'wide' : 'shimmering',
      stack: subbed ? 'triangle sub under' : 'raw stack',
      tone: toneLabel(wave, duty),
      voices,
      cents: r1(cents),
      note: noteName(m),
    };
  } else if (style === 'octave') {
    // octave-doubled bass: the root plus a chip octave above, a sub below, or both
    const pairing = rng.choice(['up', 'up', 'sub', 'both']);
    const m = pairing === 'up' ? rng.randint(28, 45) : rng.randint(40, 55);
    const f = midi(m);
    const dur = rng.uniform(0.2, 1.0);
    const n = secs(dur);
    const rootWave = rng.choice(['tri', null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const upDuty = rng.choice([0.5, 0.25, 0.125]);
    const rate = rng.uniform(1.6, 5.0) / dur;
    const rel = Math.min(dur * 0.4, rng.uniform(0.03, 0.16));
    const env = (t) => {
      const a = Math.min(1.0, t / 0.0015) * (0.35 + 0.65 * Math.exp(-rate * t));
      const left = dur - t;
      return left < rel ? a * Math.max(0.0, left / rel) : a;
    };
    out = renderTone(n, () => f, duty, env, rootWave);
    const mix = rng.uniform(0.25, 0.75);
    if (pairing !== 'sub') {
      mixAt(out, renderTone(n, () => f * 2.0, upDuty, (t) => env(t) * Math.exp(-1.2 * t)), 0, mix);
    }
    if (pairing !== 'up') {
      // Kept under the root on purpose: "sub-octave *under*" — the tagged note
      // stays the strongest partial so the patch reads at the pitch it claims.
      mixAt(out, renderTone(n, () => f * 0.5, 0.5, env, 'tri'), 0, rng.uniform(0.35, 0.7));
    }
    lowpass(out, f * rng.uniform(5.0, 16.0));
    tags = {
      style: 'octave',
      pairing: pairing === 'up' ? 'octave doubled' : pairing === 'sub' ? 'sub-octave under' : 'sub and octave',
      tone: toneLabel(rootWave, duty),
      upper: dutyLabel(upDuty),
      mix_pct: Math.round(mix * 100),
      note: noteName(m),
    };
  } else if (style === 'growl') {
    // growl bass: ring-modulated and crushed, the nastiest patch in the box
    const m = rng.randint(28, 43); // E1..G2
    const f = midi(m);
    const dur = rng.uniform(0.25, 1.0);
    const n = secs(dur);
    // Whole-number ratios only: ring modulation by a harmonic keeps the product's
    // period at 1/f, so the growl stays on the note instead of dropping an octave.
    const ratio = rng.choice([2.0, 3.0, 4.0, 6.0]);
    const depth = rng.uniform(0.35, 0.9);
    const sweep = rng.uniform(0.0, 0.14); // modulator drifts sharp over the note
    const duty = rng.choice([0.5, 0.25]);
    const sus = rng.uniform(0.5, 0.9);
    const env = shaped(dur, rng.uniform(0.002, 0.015), rng.uniform(0.04, 0.18), sus, Math.min(dur * 0.4, rng.uniform(0.03, 0.16)));
    out = new Array(n);
    let ph = 0.0;
    let mp = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += f / SR;
      mp += (f * ratio * (1.0 + sweep * (t / dur))) / SR;
      const mod = square(mp, 0.5);
      out[i] = square(ph, duty) * (1.0 - depth + depth * mod) * env(t);
    }
    const steps = rng.randint(3, 9);
    const hold = rng.randint(1, 7);
    crush(out, steps, hold);
    lowpass(out, f * rng.uniform(5.0, 18.0));
    tags = {
      style: 'growl',
      mod: depth > 0.7 ? 'ring-modulated' : 'shimmer-modulated',
      drift: sweep > 0.3 ? 'rising' : 'locked',
      tone: dutyLabel(duty),
      ratio: r1(ratio),
      crush_hz: Math.round(SR / hold),
      steps,
      note: noteName(m),
    };
  } else {
    // walking riff: two to four plucked notes, an instant bassline
    const pat = rng.choice([
      { name: 'root-octave', steps: [0, 12] },
      { name: 'root-fifth-octave', steps: [0, 7, 12] },
      { name: 'doubled root to octave', steps: [0, 0, 12] },
      { name: 'root-fourth-below', steps: [0, -5, 0] },
      { name: 'minor climb', steps: [0, 3, 7] },
      { name: 'octave bounce', steps: [0, 12, 0, 12] },
      { name: 'fifth walk-up', steps: [0, 5, 7, 12] },
    ]);
    const m = rng.randint(28, 43); // E1..G2 root, steps reach up to G3
    const step = rng.uniform(0.07, 0.19);
    const wave = rng.choice([null, null, 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const rate = rng.uniform(4.5, 9.0) / step;
    const cMul = rng.uniform(4.0, 16.0);
    const tail = rng.uniform(0.06, 0.22);
    const swing = rng.uniform(0.0, 0.14); // every other note nudged late
    out = [];
    for (let k = 0; k < pat.steps.length; k++) {
      const nm = Math.max(26, Math.min(55, m + pat.steps[k]));
      const nf = midi(nm);
      const last = k === pat.steps.length - 1;
      const nn = secs(step + (last ? tail : 0.03));
      const v = renderTone(nn, () => nf, duty, (t) => Math.min(1.0, t / 0.0015) * Math.exp(-rate * t), wave);
      lowpass(v, nf * cMul);
      const at = secs(k * step + (k % 2 === 1 ? swing * step : 0.0));
      mixAt(out, v, at, k === 0 ? 1.0 : rng.uniform(0.6, 1.0));
    }
    tags = {
      style: 'walk',
      pattern: pat.name,
      feel: swing > 0.07 ? 'swung' : 'straight',
      tone: toneLabel(wave, duty),
      steps: pat.steps.length,
      bpm: Math.round(15.0 / step), // each step is a sixteenth
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every bass note inside 0.1 - 1.5 s, block the duty-cycle DC bias, then
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
  const note = t.note || 'E1';
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  switch (t.style) {
    case 'square':
      return `sustained square bass — ${t.tone || '50% duty'}, ${t.motion || 'steady hold'}, holds ${num(t.sus_pct)}% at ${note}`;
    case 'acid':
      return `acid bass — ${t.filter || 'liquid'} Q${Number(t.res || 0).toFixed(1)} sweep, ${t.glide || 'no slide'}, ${num(t.cutoff_hz)} Hz on ${note}`;
    case 'wobble':
      return `wobble bass — ${t.lfo || 'sine'} LFO on ${t.target || 'filter sweep'}, ${Number(t.wob_hz || 0).toFixed(1)} Hz at ${note}`;
    case 'slap':
      return `slap bass — ${t.snap || 'thumb thump'}, ${t.body || 'round'} ${t.decay || 'sustained'} body, ${num(t.open_hz)} Hz on ${note}`;
    case 'muted':
      return `muted staccato bass — ${t.damp || 'dead'} ${t.tone || 'triangle'} ${t.hits || 'single stab'}, ${num(t.damp_hz)} Hz on ${note}`;
    case 'fat':
      return `detuned fat bass — ${num(t.voices)} ${t.spread || 'wide'} voices, ${t.stack || 'raw stack'}, ${Number(t.cents || 0).toFixed(1)} cents on ${note}`;
    case 'octave':
      return `octave bass — ${t.pairing || 'octave doubled'}, ${t.tone || 'triangle'} root, ${num(t.mix_pct)}% upper on ${note}`;
    case 'growl':
      return `growl bass — ${t.mod || 'ring-modulated'} ${Number(t.ratio || 0).toFixed(1)}x, ${t.drift || 'locked'}, ${num(t.steps)}-step crush on ${note}`;
    case 'walk':
      return `walking bass riff — ${t.pattern || 'root-octave'}, ${t.feel || 'straight'} ${num(t.steps)} steps at ${num(t.bpm)} BPM from ${note}`;
    default:
      return `plucked chip bass — ${t.tone || 'triangle'} body, ${t.attack || 'fingered'} ${t.decay || 'short'} decay, ${num(t.open_hz)} Hz on ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'plucked and sustained chip bass, acid sweeps, wobbles, slaps';
