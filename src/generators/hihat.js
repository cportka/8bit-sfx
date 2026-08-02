// hihat — the chatter on top of the beat, ten ways. Every variation starts from
// the same two chip ingredients: NES LFSR noise (sample-and-held at 1-6 samples,
// which is the only "brightness" knob real chips had) and the TR-808 trick of
// summing six square oscillators at inharmonic ratios to fake struck metal.
// Hand-rolled one-pole filters do the rest — a highpass sets where the hat sits
// above the kick, a lowpass darkens it — and the envelope decides which member of
// the hat family it is: a 20 ms tick is closed, a 400 ms sizzle is open, a
// medium tail cut by a hard gate is half-open, and a low triangle thump under a
// short chick is the pedal.
//
// The metallic, shimmer and pedal styles have a real oscillator core, so they
// report the MIDI note they were built on — hats get layered against basslines
// and a clanging 6-square cluster in the wrong key is audible. The noise-only
// styles report their filter corner in Hz instead, which is the honest number.
//
// Post-processing is uniform: DC block (narrow-duty square clusters carry a
// bias), a sub-millisecond fade at the front so the attack stays snappy, a short
// taper at the tail, then peak-normalize last — the loudest sample in a hi-hat
// almost always lives inside the first 2 ms.

import { SR, Lfsr, square, midi, noteName, renderTone, finish, mixAt, dcBlock } from '../dsp.js';

/** The TR-808 metal ratios: six squares, deliberately inharmonic. */
const METAL_RATIOS = [1.0, 1.4471, 1.617, 1.9265, 2.5028, 2.6637];

/** One decimal place, for tag values that read better rounded. */
function r1(x) {
  return Math.round(x * 10) / 10;
}

/** -3 dB corner of a one-pole with coefficient `alpha`, in Hz. */
function cornerHz(alpha) {
  const a = Math.min(0.999, Math.max(1e-4, alpha));
  return Math.round((-SR * Math.log(1 - a)) / (2 * Math.PI));
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'closed', 'open', 'pedal', 'half', 'metallic', 'dark', 'shimmer', 'stutter', 'crushed', 'reverse',
  ]);

  const secs = (s) => Math.max(1, Math.round(s * SR));

  // LFSR noise through hand-rolled one-poles: lowpass first (darkens), then
  // highpass (lifts the hat off the kick). `hpA` may be a function of t so a
  // filter can open or close across the sound.
  const noiseBed = (n, period, envFn, hpA, lpA = 0) => {
    const src = new Lfsr(rng, period);
    const out = new Array(n);
    const sweep = typeof hpA === 'function';
    let lpS = 0.0;
    let hpS = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let x = src.next();
      if (lpA > 0) {
        lpS += lpA * (x - lpS);
        x = lpS;
      }
      const a = sweep ? hpA(t) : hpA;
      if (a > 0) {
        hpS += a * (x - hpS);
        x -= hpS;
      }
      out[i] = x * envFn(t);
    }
    return out;
  };

  // Six square oscillators at inharmonic ratios, highpassed — struck metal, the
  // way an 808 faked it. The highpass also kills the duty-cycle DC bias.
  const metalCluster = (n, base, ratios, duty, envFn, hpA) => {
    const out = new Array(n);
    const ph = new Array(ratios.length).fill(0.0);
    const g = 1.0 / ratios.length;
    let hpS = 0.0;
    for (let i = 0; i < n; i++) {
      let s = 0.0;
      for (let k = 0; k < ratios.length; k++) {
        ph[k] += (base * ratios[k]) / SR;
        s += square(ph[k], duty);
      }
      s *= g;
      hpS += hpA * (s - hpS);
      out[i] = (s - hpS) * envFn(i / SR);
    }
    return out;
  };

  // A single hat tick: the atom the roll and flam styles repeat.
  const tick = (n, period, hpA, lpA, rate, atk) =>
    noiseBed(n, period, (t) => Math.min(1.0, t / atk) * Math.exp(-rate * t), hpA, lpA);

  const brightWord = (p) => (p === 1 ? 'crisp' : p === 2 ? 'papery' : p === 3 ? 'grainy' : 'dusky');

  let out;
  let tags;

  if (style === 'closed') {
    // closed tick: the workhorse — a few dozen milliseconds of filtered noise,
    // optionally tipped with a very short metal cluster for a chip-metal edge
    const dur = rng.uniform(0.02, 0.085);
    const n = secs(dur);
    const period = rng.randint(1, 3);
    const hpA = rng.uniform(0.35, 0.85);
    const damped = rng.random() < 0.4;
    const lpA = damped ? rng.uniform(0.45, 0.95) : 0;
    const rate = rng.uniform(7.0, 16.0) / dur;
    const atk = rng.uniform(0.0002, 0.0008);
    out = tick(n, period, hpA, lpA, rate, atk);
    const metalG = rng.uniform(0.0, 0.5);
    const tipped = metalG > 0.18;
    if (tipped) {
      const m = rng.randint(74, 90);
      mixAt(
        out,
        metalCluster(
          Math.min(n, secs(rng.uniform(0.006, 0.03))),
          midi(m),
          METAL_RATIOS,
          0.5,
          (t) => Math.exp(-1.3 * rate * t),
          Math.min(0.9, hpA + 0.05)
        ),
        0,
        metalG
      );
    }
    tags = {
      style: 'closed',
      tone: brightWord(period),
      top: lpA > 0 ? 'tamed' : 'wide open',
      accent: tipped ? 'metal-tipped' : 'pure noise',
      edge_hz: cornerHz(hpA),
      decay_ms: r1(1000 / rate),
    };
  } else if (style === 'open') {
    // open sizzle: a two-stage tail (fast bloom into a slow wash) with an
    // optional flutter tremolo, plus a metal cluster underneath for body
    const dur = rng.uniform(0.25, 0.7);
    const n = secs(dur);
    const period = rng.randint(1, 2);
    const hpA = rng.uniform(0.3, 0.8);
    const fast = rng.uniform(22.0, 60.0);
    const slow = rng.uniform(3.0, 8.0) / dur;
    const mix = rng.uniform(0.25, 0.6);
    const flutterHz = rng.uniform(24.0, 140.0);
    const depth = rng.uniform(0.0, 0.45);
    const fluttered = depth > 0.12;
    const atk = rng.uniform(0.0003, 0.0012);
    const env = (t) => {
      const a = Math.min(1.0, t / atk);
      const body = mix * Math.exp(-fast * t) + (1 - mix) * Math.exp(-slow * t);
      const trem = fluttered ? 1.0 - depth * 0.5 * (1.0 - Math.cos(2 * Math.PI * flutterHz * t)) : 1.0;
      return a * body * trem;
    };
    out = noiseBed(n, period, env, hpA);
    const metalG = rng.uniform(0.0, 0.65);
    const metallic = metalG > 0.2;
    if (metallic) {
      const m = rng.randint(66, 84);
      mixAt(out, metalCluster(n, midi(m), METAL_RATIOS, 0.5, (t) => Math.exp(-slow * 1.15 * t), hpA), 0, metalG);
    }
    tags = {
      style: 'open',
      texture: fluttered ? 'sizzling' : 'smooth',
      body: metallic ? 'metal-backed' : 'all noise',
      tail: slow < 14.0 ? 'washy' : 'contained',
      flutter_hz: r1(flutterHz),
      edge_hz: cornerHz(hpA),
    };
  } else if (style === 'pedal') {
    // pedal chick: a short dry tick riding a low triangle thump — the sound of
    // the foot closing the hats rather than the stick hitting them
    const dur = rng.uniform(0.03, 0.12);
    const n = secs(dur);
    const period = rng.randint(2, 5);
    const hpA = rng.uniform(0.15, 0.5);
    const lpA = rng.uniform(0.3, 0.9);
    const rate = rng.uniform(9.0, 20.0) / dur;
    out = tick(n, period, hpA, lpA, rate, rng.uniform(0.0004, 0.0014));
    const m = rng.randint(36, 52); // C2..E3 foot thump
    const footG = rng.uniform(0.15, 0.7);
    const heavy = footG > 0.42;
    mixAt(
      out,
      renderTone(
        n,
        () => midi(m),
        0.5,
        (t) => Math.min(1.0, t / 0.0012) * Math.exp(-rng.uniform(0.7, 1.2) * rate * t),
        'tri'
      ),
      0,
      footG
    );
    tags = {
      style: 'pedal',
      foot: heavy ? 'stomped' : 'light',
      top: brightWord(period),
      seal: lpA > 0.6 ? 'tight seal' : 'loose seal',
      chick_ms: r1(1000 / rate),
      note: noteName(m),
    };
  } else if (style === 'half') {
    // half-open hat: a tail long enough to be heard, then either choked by a
    // hard gate (the classic "hat cut short by the next closed hit") or let ring
    const dur = rng.uniform(0.1, 0.34);
    const n = secs(dur);
    const period = rng.randint(1, 3);
    const hpA = rng.uniform(0.28, 0.75);
    const damped = rng.random() < 0.35;
    const lpA = damped ? rng.uniform(0.5, 0.95) : 0;
    const rate = rng.uniform(4.0, 9.0) / dur;
    out = tick(n, period, hpA, lpA, rate, rng.uniform(0.0003, 0.001));
    const choked = rng.random() < 0.65;
    let openFor = dur;
    if (choked) {
      openFor = rng.uniform(0.4, 0.85) * dur;
      const rel = rng.uniform(0.004, 0.018);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        if (t > openFor) out[i] *= Math.max(0.0, 1.0 - (t - openFor) / rel);
      }
      out = out.slice(0, Math.min(n, secs(openFor + rel + 0.004)));
    }
    tags = {
      style: 'half',
      gate: choked ? 'choked' : 'left ringing',
      top: brightWord(period),
      color: lpA > 0 ? 'rolled off' : 'bright',
      open_ms: r1(openFor * 1000),
      edge_hz: cornerHz(hpA),
    };
  } else if (style === 'metallic') {
    // bright metallic hat: the six-square 808 cluster out front, detuned by a
    // spread factor so the beating between partials changes with the seed
    const m = rng.randint(62, 86); // D4..D6 core
    const base = midi(m);
    const dur = rng.uniform(0.04, 0.35);
    const n = secs(dur);
    const spread = rng.uniform(0.0, 0.035);
    const ratios = METAL_RATIOS.map((r, k) => r * (1 + spread * (k % 2 ? 1 : -1)));
    const duty = rng.choice([0.5, 0.5, 0.4, 0.32]);
    const hpA = rng.uniform(0.4, 0.85);
    const rate = rng.uniform(4.0, 13.0) / dur;
    const atk = rng.uniform(0.0002, 0.0009);
    out = metalCluster(n, base, ratios, duty, (t) => Math.min(1.0, t / atk) * Math.exp(-rate * t), hpA);
    const noiseG = rng.uniform(0.0, 0.7);
    const blended = noiseG > 0.18;
    if (blended) {
      mixAt(
        out,
        tick(n, rng.randint(1, 2), Math.min(0.9, hpA + 0.05), 0, rate * rng.uniform(1.0, 1.8), 0.0004),
        0,
        noiseG
      );
    }
    tags = {
      style: 'metallic',
      ring: spread > 0.015 ? 'clangy' : 'glassy',
      shape: duty === 0.5 ? 'hollow squares' : 'thin squares',
      blend: blended ? 'noise-blended' : 'pure metal',
      edge_hz: cornerHz(hpA),
      note: noteName(m),
    };
  } else if (style === 'dark') {
    // dark filtered hat: the same noise, rolled off hard — the hat that sits
    // under a busy mix instead of on top of it
    const dur = rng.uniform(0.03, 0.2);
    const n = secs(dur);
    const period = rng.randint(1, 4);
    const lpA = rng.uniform(0.06, 0.3);
    const hpA = rng.uniform(0.03, 0.16);
    const rate = rng.uniform(5.0, 13.0) / dur;
    out = noiseBed(
      n,
      period,
      (t) => Math.min(1.0, t / rng.uniform(0.0006, 0.002)) * Math.exp(-rate * t),
      hpA,
      lpA
    );
    const foldG = rng.uniform(0.0, 0.5);
    const driven = foldG > 0.2;
    if (driven) {
      // a touch of saturation puts some of the lost top back as harmonics
      const drive = 1.0 + 4.0 * foldG;
      const norm = Math.tanh(drive);
      for (let i = 0; i < n; i++) out[i] = Math.tanh(drive * out[i]) / norm;
    }
    tags = {
      style: 'dark',
      filter: lpA < 0.15 ? 'muffled' : 'shaded',
      body: driven ? 'saturated' : 'clean',
      grain: brightWord(period),
      top_hz: cornerHz(lpA),
      decay_ms: r1(1000 / rate),
    };
  } else if (style === 'shimmer') {
    // short shimmer: two detuned triangle partials way up top, beating against
    // each other over a thin noise bed, optionally drifting upward
    const m = rng.randint(84, 102); // C6..F#7
    const f1 = midi(m);
    const det = rng.uniform(0.002, 0.02);
    const f2 = f1 * (1 + det);
    const dur = rng.uniform(0.08, 0.4);
    const n = secs(dur);
    const rate = rng.uniform(4.0, 10.0) / dur;
    const climb = rng.uniform(0.0, 0.35);
    const rising = climb > 0.08;
    const atk = rng.uniform(0.0004, 0.0016);
    const env = (t) => Math.min(1.0, t / atk) * Math.exp(-rate * t);
    const glide = (f) => (t) => f * (1 + climb * (t / dur));
    out = renderTone(n, glide(f1), 0.5, env, 'tri');
    mixAt(out, renderTone(n, glide(f2), 0.5, env, 'tri'), 0, rng.uniform(0.7, 1.0));
    const airG = rng.uniform(0.15, 0.75);
    const airy = airG > 0.45;
    mixAt(out, tick(n, 1, rng.uniform(0.5, 0.85), 0, rate * rng.uniform(1.1, 2.0), 0.0004), 0, airG);
    tags = {
      style: 'shimmer',
      motion: rising ? 'rising' : 'steady',
      air: airy ? 'breathy' : 'glassy',
      pair: det > 0.01 ? 'wide detune' : 'tight detune',
      beat_hz: r1(f2 - f1),
      note: noteName(m),
    };
  } else if (style === 'stutter') {
    // stuttered burst: either a retriggered roll of discrete ticks or one
    // sustained sizzle chopped by a square gate — 16th-note chatter, either way
    const period = rng.randint(1, 3);
    const hpA = rng.uniform(0.3, 0.8);
    const roll = rng.random() < 0.6;
    let ticks;
    let spacingMs;
    let motion;
    if (roll) {
      const count = rng.randint(3, 7);
      const gap0 = rng.uniform(0.016, 0.06);
      const accel = rng.uniform(0.78, 1.06);
      const tickDur = rng.uniform(0.012, 0.05);
      const fall = rng.uniform(0.7, 1.08);
      const rate = rng.uniform(6.0, 14.0) / tickDur;
      out = [];
      let pos = 0.0;
      let gap = gap0;
      for (let k = 0; k < count; k++) {
        const g = fall >= 1 ? Math.pow(fall, k - (count - 1)) : Math.pow(fall, k);
        mixAt(out, tick(secs(tickDur), period, hpA, 0, rate, 0.0004), secs(pos), Math.max(0.25, g));
        pos += gap;
        gap *= accel;
      }
      ticks = count;
      spacingMs = r1(gap0 * 1000);
      motion = accel < 0.95 ? 'accelerating' : accel > 1.02 ? 'slowing' : 'even';
    } else {
      const dur = rng.uniform(0.15, 0.5);
      const n = secs(dur);
      const gateHz = rng.uniform(18.0, 75.0);
      const gDuty = rng.uniform(0.3, 0.7);
      const floor = rng.uniform(0.0, 0.2);
      const slow = rng.uniform(3.0, 7.0) / dur;
      out = noiseBed(n, period, (t) => Math.min(1.0, t / 0.0006) * Math.exp(-slow * t), hpA);
      let g = 0.0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        g += 0.4 * ((square(t * gateHz, gDuty) > 0 ? 1.0 : floor) - g);
        out[i] *= g;
      }
      ticks = Math.max(1, Math.round(dur * gateHz));
      spacingMs = r1(1000 / gateHz);
      motion = gDuty > 0.55 ? 'loose chop' : gDuty < 0.4 ? 'tight chop' : 'even chop';
    }
    tags = {
      style: 'stutter',
      pattern: roll ? 'retriggered roll' : 'gated chop',
      motion,
      tone: brightWord(period),
      ticks,
      spacing_ms: spacingMs,
    };
  } else if (style === 'crushed') {
    // crushed lo-fi hat: sample-and-hold rate reduction on top of the LFSR's own
    // hold, then a coarse amplitude crush — a hat recorded onto a dying chip
    const dur = rng.uniform(0.03, 0.22);
    const n = secs(dur);
    const period = rng.randint(1, 4);
    const hpA = rng.uniform(0.25, 0.8);
    const rate = rng.uniform(6.0, 15.0) / dur;
    out = tick(n, period, hpA, 0, rate, rng.uniform(0.0003, 0.001));
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = out[i] < 0 ? -out[i] : out[i];
      if (a > peak) peak = a;
    }
    if (peak > 1e-9) for (let i = 0; i < n; i++) out[i] /= peak;
    const steps = rng.randint(2, 7);
    const hold = rng.randint(2, 14);
    let held = 0.0;
    for (let i = 0; i < n; i++) {
      if (i % hold === 0) held = out[i];
      out[i] = Math.round(held * steps) / steps;
    }
    tags = {
      style: 'crushed',
      grain: hold > 7 ? 'coarse' : 'fine',
      source: brightWord(period),
      bite: steps < 4 ? 'brutal' : 'gentle',
      steps,
      crush_hz: Math.round(SR / hold),
    };
  } else {
    // reverse swell: level rises and the highpass opens across the swell, then a
    // short tick closes it — the pickup hat before a downbeat
    const swell = rng.uniform(0.08, 0.45);
    const tail = rng.uniform(0.012, 0.05);
    const dur = swell + tail;
    const n = secs(dur);
    const period = rng.randint(1, 3);
    const curve = rng.uniform(1.2, 3.5);
    const hp0 = rng.uniform(0.05, 0.3);
    const hp1 = rng.uniform(0.45, 0.9);
    const tailRate = rng.uniform(4.0, 9.0) / tail;
    out = noiseBed(
      n,
      period,
      (t) => (t < swell ? Math.pow(t / swell, curve) : Math.exp(-tailRate * (t - swell))),
      (t) => hp0 + (hp1 - hp0) * Math.min(1.0, t / swell)
    );
    const snapG = rng.uniform(0.0, 0.6);
    const snapped = snapG > 0.2;
    if (snapped) {
      mixAt(out, tick(Math.min(n, secs(0.02)), 1, hp1, 0, 4.0 / tail, 0.0004), secs(swell), snapG);
    }
    tags = {
      style: 'reverse',
      curve: curve > 2.2 ? 'steep' : 'gradual',
      sweep: hp1 - hp0 > 0.45 ? 'opening filter' : 'even filter',
      landing: snapped ? 'sharp tick' : 'soft close',
      swell_ms: r1(swell * 1000),
      edge_hz: cornerHz(hp1),
    };
  }

  rng.tags = tags;

  // Keep every hat inside 0.02 - 0.7 s, block any square-cluster bias, de-click
  // the front with a sub-millisecond ramp (the transient IS the sound), taper the
  // tail, then normalize last so the peak lands exactly on target.
  const minN = Math.round(0.02 * SR);
  const maxN = Math.round(0.7 * SR);
  if (out.length > maxN) out = out.slice(0, maxN);
  while (out.length < minN) out.push(0.0);
  dcBlock(out);
  const fi = Math.min(out.length >> 3, 6);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.002 * SR), Math.round(0.04 * out.length)));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C5';
  const edge = Number.isFinite(Number(t.edge_hz)) ? Math.trunc(Number(t.edge_hz)) : 0;
  switch (t.style) {
    case 'open':
      return `open sizzle hat — ${t.texture || 'smooth'} ${t.tail || 'washy'} tail, ${t.body || 'all noise'}, ${Number(t.flutter_hz || 0).toFixed(1)} Hz flutter`;
    case 'pedal':
      return `pedal chick — ${t.foot || 'light'} foot, ${t.seal || 'tight seal'}, ${Number(t.chick_ms || 0).toFixed(1)} ms tick on ${note}`;
    case 'half':
      return `half-open hat — ${t.gate || 'choked'} ${t.color || 'bright'} tail, ${Number(t.open_ms || 0).toFixed(1)} ms open, ${edge} Hz edge`;
    case 'metallic':
      return `bright metallic hat — ${t.ring || 'glassy'} ${t.shape || 'hollow squares'}, ${t.blend || 'pure metal'}, ${note} core`;
    case 'dark':
      return `dark filtered hat — ${t.filter || 'muffled'} top at ${t.top_hz | 0} Hz, ${t.grain || 'crisp'} grain, ${t.body || 'clean'}`;
    case 'shimmer':
      return `short shimmer hat — ${t.motion || 'steady'} and ${t.air || 'glassy'}, ${Number(t.beat_hz || 0).toFixed(1)} Hz beat on ${note}`;
    case 'stutter':
      return `stuttered hat burst — ${t.pattern || 'retriggered roll'}, ${t.motion || 'even'}, ${t.ticks | 0} hits ${Number(t.spacing_ms || 0).toFixed(1)} ms apart`;
    case 'crushed':
      return `crushed lo-fi hat — ${t.grain || 'coarse'} ${t.bite || 'brutal'} grit, ${t.steps | 0} steps, ${t.crush_hz | 0} Hz hold`;
    case 'reverse':
      return `reverse swell hat — ${t.curve || 'steep'} rise, ${t.sweep || 'opening filter'}, ${Number(t.swell_ms || 0).toFixed(1)} ms into a ${t.landing || 'sharp tick'}`;
    default:
      return `closed chip hat — ${t.tone || 'crisp'} tick, ${t.top || 'tamed'} top, ${t.accent || 'pure noise'}, ${edge} Hz edge`;
  }
}

/** Short phrase for the README category table. */
export const character = 'crisp closed ticks, open sizzles, pedal chicks, metallic sheen';
