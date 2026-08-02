// kick — the bass drum, ten ways. Every variation is the same skeleton: a wave
// whose pitch falls exponentially from a click-bright top note onto a fixed MIDI
// fundamental, under a linear attack into an exponential decay. What separates
// them is what happens around that skeleton — a hard gate chopping the body, a
// sample-and-hold plus level crush for lo-fi grit, a tanh/wavefold drive for 808
// warmth or outright distortion, a one-pole lowpass for the soft round variant,
// a noise transient for the click-forward one, a reversed swell for the riser
// kick, a second offset hit for the flam, and a ringing partial for the tuned
// bass-kick hybrid.
//
// The landing pitch is always an exact MIDI note, so these stay in tune with the
// rest of the catalog: `note` in the tags is the fundamental the kick settles on.
// Post-processing is uniform — DC block (narrow-duty squares carry a big bias),
// de-click both edges, taper the tail, then normalize last so the peak lands
// exactly on target even when the loudest sample is a 0.5 ms transient.

import { SR, Lfsr, square, midi, noteName, renderTone, finish, mixAt, dcBlock } from '../dsp.js';

/** One decimal place, for tag values that read better rounded. */
function r1(x) {
  return Math.round(x * 10) / 10;
}

/** "12.5% duty" / "25% duty" / "50% duty". */
function dutyLabel(d) {
  return `${d * 100}% duty`;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'chip', '808', 'gated', 'crushed', 'clipped', 'round', 'click', 'swell', 'flam', 'tuned',
  ]);

  const secs = (s) => Math.max(1, Math.round(s * SR));

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

  // Lowpassed LFSR transient — the beater click / grit layer.
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

  if (style === 'chip') {
    // tight chip kick: short drop, fast decay, optional beater snap
    const m = rng.randint(33, 45); // A1..A2
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(3.2, 6.5);
    const dur = rng.uniform(0.06, 0.16);
    const n = secs(dur);
    const tau = rng.uniform(0.0035, 0.011);
    const rate = rng.uniform(4.0, 7.0) / dur;
    const wave = rng.choice([null, null, 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    out = body(n, f0, fEnd, tau, rng.uniform(0.0006, 0.0015), rate, wave, duty);
    const snapG = rng.uniform(0.0, 0.45);
    const snapped = snapG > 0.12;
    if (snapped) {
      mixAt(
        out,
        noiseTick(Math.min(n, secs(rng.uniform(0.002, 0.006))), rng.randint(1, 3), rng.uniform(0.5, 0.9), 0.0006, rng.uniform(400, 900)),
        0,
        snapG
      );
    }
    tags = {
      style: 'chip',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      attack: snapped ? 'snappy' : 'clean',
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  } else if (style === '808') {
    // 808-style boom: deep sub, slow pitch settle, tanh warmth, long tail
    const m = rng.randint(26, 40); // D1..E2
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(3.5, 9.0);
    const dur = rng.uniform(0.4, 0.78);
    const n = secs(dur);
    const tau = rng.uniform(0.018, 0.055);
    const rate = rng.uniform(3.0, 6.0) / dur;
    const drive = rng.uniform(1.0, 3.4);
    out = body(n, f0, fEnd, tau, rng.uniform(0.0008, 0.002), rate, 'tri', 0.5);
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) out[i] = Math.tanh(drive * out[i]) / norm;
    const clickG = rng.uniform(0.0, 0.5);
    if (clickG > 0.15) {
      mixAt(out, noiseTick(secs(0.004), rng.randint(1, 3), rng.uniform(0.4, 0.8), 0.0006, rng.uniform(300, 700)), 0, clickG);
    }
    tags = {
      style: '808',
      tail: rate < 8.0 ? 'booming' : 'settled',
      drive: drive > 2.0 ? 'saturated' : 'clean',
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  } else if (style === 'gated') {
    // punchy gated kick: a sustaining body chopped by a hard cut or a stutter gate
    const m = rng.randint(31, 45);
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(3.0, 6.5);
    const dur = rng.uniform(0.14, 0.4);
    const n = secs(dur);
    const tau = rng.uniform(0.006, 0.02);
    const rate = rng.uniform(2.0, 4.5) / dur;
    const wave = rng.choice([null, 'tri']);
    const duty = rng.choice([0.5, 0.25]);
    out = body(n, f0, fEnd, tau, rng.uniform(0.0006, 0.0015), rate, wave, duty);
    const mode = rng.choice(['hard', 'stutter']);
    if (mode === 'stutter') {
      const gateHz = rng.uniform(14.0, 55.0);
      const gDuty = rng.uniform(0.35, 0.7);
      const floor = rng.uniform(0.0, 0.25);
      let g = 0.0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        g += 0.35 * ((square(t * gateHz, gDuty) > 0 ? 1.0 : floor) - g);
        out[i] *= g;
      }
    } else {
      const gateAt = rng.uniform(0.35, 0.8) * dur;
      const rel = rng.uniform(0.002, 0.012);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        if (t > gateAt) out[i] *= Math.max(0.0, 1.0 - (t - gateAt) / rel);
      }
      out = out.slice(0, Math.min(n, secs(gateAt + rel + 0.004)));
    }
    tags = {
      style: 'gated',
      gate: mode === 'stutter' ? 'stutter chop' : 'hard cut',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  } else if (style === 'crushed') {
    // lo-fi kick: sample-and-hold rate reduction plus a coarse amplitude crush
    const m = rng.randint(31, 45);
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(2.6, 5.5);
    const dur = rng.uniform(0.1, 0.4);
    const n = secs(dur);
    const tau = rng.uniform(0.005, 0.02);
    const rate = rng.uniform(3.5, 7.0) / dur;
    const wave = rng.choice([null, 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    out = body(n, f0, fEnd, tau, rng.uniform(0.0006, 0.0015), rate, wave, duty);
    const gritG = rng.uniform(0.0, 0.35);
    const gritty = gritG > 0.1;
    if (gritty) {
      mixAt(
        out,
        noiseTick(Math.min(n, secs(0.03)), rng.randint(2, 6), rng.uniform(0.2, 0.6), 0.0008, rng.uniform(60, 200)),
        0,
        gritG
      );
    }
    const steps = rng.randint(3, 8);
    const hold = rng.randint(2, 12);
    let held = 0.0;
    for (let i = 0; i < n; i++) {
      if (i % hold === 0) held = out[i];
      out[i] = Math.round(held * steps) / steps;
    }
    tags = {
      style: 'crushed',
      grit: gritty ? 'gritty' : 'dry',
      steps,
      crush_hz: Math.round(SR / hold),
      note: noteName(m),
    };
  } else if (style === 'clipped') {
    // distorted kick: hard clipping or sine wavefolding on a driven body
    const m = rng.randint(29, 43);
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(3.0, 7.0);
    const dur = rng.uniform(0.1, 0.45);
    const n = secs(dur);
    const tau = rng.uniform(0.006, 0.025);
    const rate = rng.uniform(3.5, 7.0) / dur;
    const wave = rng.choice(['tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    out = body(n, f0, fEnd, tau, rng.uniform(0.0006, 0.0015), rate, wave, duty);
    const fold = rng.random() < 0.35;
    const drive = fold ? rng.uniform(1.5, 4.5) : rng.uniform(3.0, 14.0);
    for (let i = 0; i < n; i++) {
      const x = out[i] * drive;
      out[i] = fold ? Math.sin(1.6 * x) : Math.max(-1.0, Math.min(1.0, x));
    }
    tags = {
      style: 'clipped',
      shape: fold ? 'wavefolded' : 'hard-clipped',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      drive: r1(drive),
      note: noteName(m),
    };
  } else if (style === 'round') {
    // soft round kick: triangle body through a one-pole lowpass, easy attack
    const m = rng.randint(30, 44);
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(2.0, 4.0);
    const dur = rng.uniform(0.15, 0.5);
    const n = secs(dur);
    const tau = rng.uniform(0.012, 0.045);
    const rate = rng.uniform(3.5, 6.5) / dur;
    out = body(n, f0, fEnd, tau, rng.uniform(0.002, 0.008), rate, 'tri', 0.5);
    const alpha = rng.uniform(0.08, 0.35);
    let prev = 0.0;
    for (let i = 0; i < n; i++) {
      prev += alpha * (out[i] - prev);
      out[i] = prev;
    }
    const subG = rng.uniform(0.0, 0.5);
    const layered = subG > 0.15;
    if (layered) {
      mixAt(
        out,
        renderTone(n, () => fEnd, 0.5, (t) => Math.min(1.0, t / 0.004) * Math.exp(-0.8 * rate * t), 'tri'),
        0,
        subG
      );
    }
    tags = {
      style: 'round',
      warmth: alpha < 0.2 ? 'muffled' : 'soft',
      layers: layered ? 'sub layer under' : 'single layer',
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  } else if (style === 'click') {
    // click-forward kick: the transient is the star, the body just backs it up
    const m = rng.randint(32, 45);
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(2.5, 5.0);
    const dur = rng.uniform(0.08, 0.28);
    const n = secs(dur);
    const tau = rng.uniform(0.004, 0.014);
    const rate = rng.uniform(4.0, 7.5) / dur;
    const wave = rng.choice([null, 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    out = body(n, f0, fEnd, tau, 0.0008, rate, wave, duty);
    const kind = rng.choice(['noise', 'square']);
    const cn = Math.min(n, secs(rng.uniform(0.0015, 0.006)));
    const cg = rng.uniform(0.5, 1.1);
    if (kind === 'noise') {
      mixAt(out, noiseTick(cn, rng.randint(1, 2), rng.uniform(0.6, 0.95), 0.0006, rng.uniform(600, 1600)), 0, cg);
    } else {
      const cf = rng.uniform(1200, 3200);
      const crate = rng.uniform(500, 1400);
      mixAt(out, renderTone(cn, () => cf, 0.5, (t) => Math.min(1.0, t / 0.0006) * Math.exp(-crate * t)), 0, cg);
    }
    tags = {
      style: 'click',
      attack: kind === 'noise' ? 'noise tick' : 'square tick',
      bite: cg > 0.8 ? 'sharp' : 'rounded',
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  } else if (style === 'swell') {
    // swelled kick: pitch and level rise into the hit, then drop onto the note
    const m = rng.randint(29, 43);
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(1.6, 3.5);
    const dur = rng.uniform(0.3, 0.78);
    const n = secs(dur);
    const rise = rng.uniform(0.35, 0.7) * dur;
    const curve = rng.uniform(1.2, 3.0);
    const tau = rng.uniform(0.01, 0.04);
    const rate = rng.uniform(3.5, 7.0) / (dur - rise);
    const wave = rng.choice(['tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    out = renderTone(
      n,
      (t) => fEnd + (f0 - fEnd) * (t < rise ? t / rise : Math.exp(-(t - rise) / tau)),
      duty,
      (t) => (t < rise ? Math.pow(t / rise, curve) : Math.exp(-rate * (t - rise))),
      wave
    );
    tags = {
      style: 'swell',
      curve: curve > 2.0 ? 'steep' : 'gradual',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  } else if (style === 'flam') {
    // flammed kick: a ghost hit a few ms off the main one, either side of it
    const m = rng.randint(31, 44);
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(3.0, 6.0);
    const gap = rng.uniform(0.018, 0.075);
    const mainDur = rng.uniform(0.12, 0.4);
    const tau = rng.uniform(0.005, 0.018);
    const atk = rng.uniform(0.0006, 0.0015);
    const wave = rng.choice([null, 'tri']);
    const duty = rng.choice([0.5, 0.25]);
    const main = body(secs(mainDur), f0, fEnd, tau, atk, rng.uniform(3.5, 7.0) / mainDur, wave, duty);
    const gDur = rng.uniform(0.04, 0.1);
    const ghost = body(
      secs(gDur),
      f0 * rng.uniform(0.8, 1.4),
      fEnd * rng.uniform(1.0, 1.6),
      0.7 * tau,
      atk,
      rng.uniform(4.0, 7.0) / gDur,
      wave,
      duty
    );
    const ghostG = rng.uniform(0.3, 0.65);
    const ghostFirst = rng.random() < 0.6;
    out = [];
    if (ghostFirst) {
      mixAt(out, ghost, 0, ghostG);
      mixAt(out, main, secs(gap), 1.0);
    } else {
      mixAt(out, main, 0, 1.0);
      mixAt(out, ghost, secs(gap), ghostG);
    }
    tags = {
      style: 'flam',
      order: ghostFirst ? 'ghost into main' : 'main into ghost',
      ghost: ghostG > 0.5 ? 'loud' : 'soft',
      flam_ms: r1(gap * 1000),
      note: noteName(m),
    };
  } else {
    // tuned bass kick: the drop settles into a sustained, playable fundamental
    const m = rng.randint(28, 41);
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(2.5, 6.0);
    const dur = rng.uniform(0.22, 0.7);
    const n = secs(dur);
    const tau = rng.uniform(0.005, 0.02);
    const rate = rng.uniform(2.5, 5.0) / dur;
    const wave = rng.choice(['tri', null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    out = body(n, f0, fEnd, tau, rng.uniform(0.0008, 0.002), rate, wave, duty);
    const harmG = rng.uniform(0.0, 0.45);
    const harm = rng.choice([2, 3, 4]);
    const hDuty = rng.choice([0.5, 0.25, 0.125]);
    const ringing = harmG > 0.12;
    if (ringing) {
      mixAt(out, renderTone(n, () => fEnd * harm, hDuty, (t) => Math.min(1.0, t / 0.002) * Math.exp(-1.8 * rate * t)), 0, harmG);
    }
    tags = {
      style: 'tuned',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      ring: ringing ? `${harm === 2 ? 'octave' : harm === 3 ? 'twelfth' : 'double-octave'} ring` : 'dry sustain',
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every kick inside 0.055 - 0.78 s, block the duty-cycle DC bias, de-click
  // both edges and taper the tail, then normalize last so the peak is exact even
  // when the loudest sample sits inside the first millisecond.
  const minN = Math.round(0.055 * SR);
  const maxN = Math.round(0.78 * SR);
  if (out.length > maxN) out = out.slice(0, maxN);
  while (out.length < minN) out.push(0.0);
  dcBlock(out);
  const fi = Math.min(out.length >> 3, 8);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.006 * SR), Math.round(0.06 * out.length)));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C2';
  const hz = Number.isFinite(Number(t.top_hz)) ? Math.trunc(Number(t.top_hz)) : 0;
  switch (t.style) {
    case '808':
      return `sub-drop 808 kick — ${t.tail || 'booming'} tail, ${t.drive || 'clean'}, ${hz} Hz fall to ${note}`;
    case 'gated':
      return `gated kick — ${t.gate || 'hard cut'}, ${t.tone || 'triangle'} body, ${hz} Hz drop to ${note}`;
    case 'crushed':
      return `lo-fi crushed kick — ${t.steps | 0}-step crunch, ${t.grit || 'dry'}, ${t.crush_hz | 0} Hz hold on ${note}`;
    case 'clipped':
      return `distorted kick — ${t.shape || 'hard-clipped'} ${t.tone || 'triangle'}, ${Number(t.drive || 0).toFixed(1)}x drive on ${note}`;
    case 'round':
      return `soft round kick — ${t.warmth || 'soft'} tone, ${t.layers || 'single layer'}, ${hz} Hz drop to ${note}`;
    case 'click':
      return `click-forward kick — ${t.bite || 'sharp'} ${t.attack || 'noise tick'}, ${hz} Hz drop to ${note}`;
    case 'swell':
      return `swelled kick — ${t.curve || 'steep'} rise, ${t.tone || 'triangle'} thump cresting ${hz} Hz over ${note}`;
    case 'flam':
      return `flammed double kick — ${t.order || 'ghost into main'}, ${t.ghost || 'soft'} ghost ${Number(t.flam_ms || 0).toFixed(1)} ms off ${note}`;
    case 'tuned':
      return `tuned bass kick — ${t.tone || 'triangle'} body, ${t.ring || 'dry sustain'}, ${hz} Hz drop to ${note}`;
    default:
      return `tight chip kick — ${t.tone || 'triangle'} body, ${t.attack || 'clean'} attack, ${hz} Hz drop to ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'tight chip kicks, 808 drops, gated and crushed thumps';
