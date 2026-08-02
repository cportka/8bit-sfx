// perc — the hand-percussion shelf: everything you reach for once the kick,
// snare, hat and toms are already placed. These are the sounds that make a chip
// groove swing rather than march, so the whole category is built around two
// promises: every hit lands on an exact pitch (bells and blocks are *tuned*
// instruments — a cowbell that fights the bassline is useless), and every attack
// is clean enough to sit on a 16th grid.
//
// The chip caricature of struck wood, skin and metal is small:
//
//   metal   two or more squares at an INHARMONIC ratio (the 808 cowbell is
//           540 Hz against 800 Hz — 1.48, deliberately not a musical interval),
//           lightly lowpassed so the aliasing reads as bronze rather than fizz
//   wood    one pitch that overshoots and settles in a few milliseconds, a
//           hollow partial 2.5-3.5x above it, and almost no tail
//   skin    a membrane: a short downward bend onto the tuned note, plus a
//           lowpassed LFSR crack for the hand
//   rattle  band-shaped LFSR — a one-pole lowpass with a second pole subtracted
//           back out — is the shaker, the tambourine's jingles and the scrape
//
// Eleven sub-styles spend that vocabulary:
//
//   cowbell     twin/triple detuned squares, 808 and 909 territory
//   woodblock   high hollow knock, hard bend, no tail
//   clave       near-pure tuned ping, the cleanest thing in the category
//   shaker      band-shaped noise with a soft swell, 1-3 shakes
//   tambourine  jingle stack over a rattle, single hit or shaken
//   triangle    long inharmonic ring with two detuned stacks beating
//   conga       tuned membrane — open, slap, muff or heel
//   bongo       small tight heads, optional macho/hembra answer
//   rim         cross-stick and rimshot: crack first, pitch second
//   agogo       paired bells a real interval apart, struck one or both
//   guiro       5-16 scrape teeth, accelerating or even
//
// Post-processing is uniform: DC block (narrow-duty squares carry a bias), fade
// both edges, normalize last so the peak is exact even when the loudest sample
// sits inside the first millisecond.

import { SR, Lfsr, midi, noteName, noteOfHz, renderTone, finish, mixAt, dcBlock } from '../dsp.js';

const MIN_N = Math.round(0.032 * SR);
const MAX_N = Math.round(0.7 * SR);

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
function foldDown(f, ceiling = 7900.0) {
  let out = f;
  while (out > ceiling) out *= 0.5;
  return out;
}

/** Name an inharmonic partial ratio for the catalog blurb. */
function ratioName(ratio) {
  if (ratio < 1.45) return 'narrow';
  if (ratio < 1.55) return 'fifth-ish';
  if (ratio < 1.7) return 'golden';
  if (ratio < 2.2) return 'octave';
  if (ratio < 2.6) return 'metallic';
  if (ratio < 3.2) return 'hollow';
  return 'clangy';
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'cowbell', 'woodblock', 'clave', 'shaker', 'tambourine', 'triangle',
    'conga', 'bongo', 'rim', 'agogo', 'guiro',
  ]);

  const secs = (s) => Math.max(1, Math.round(s * SR));

  // linear attack into an exponential decay
  const env = (atk, rate) => {
    const inv = 1.0 / Math.max(atk, 1e-5);
    return (t) => Math.min(1.0, t * inv) * Math.exp(-rate * t);
  };

  // A fixed partial — the bar, bell or shell mode.
  const partial = (n, f, atk, rate, wave, duty) => renderTone(n, () => f, duty, env(atk, rate), wave);

  // Struck skin/wood: pitch overshoots to f0 and relaxes onto fEnd with tau.
  const bendTone = (n, f0, fEnd, tau, atk, rate, wave, duty) =>
    renderTone(n, (t) => fEnd + (f0 - fEnd) * Math.exp(-t / tau), duty, env(atk, rate), wave);

  // Band-shaped LFSR: one-pole lowpass, minus a slower pole to open the bottom.
  // hpA < lpA always, so the result is a broad chip bandpass.
  const noiseBurst = (n, period, lpA, hpA, atk, rate) => {
    const lf = new Lfsr(rng, period);
    const out = new Array(n);
    const inv = 1.0 / Math.max(atk, 1e-5);
    let lp = 0.0;
    let hp = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      lp += lpA * (lf.next() - lp);
      hp += hpA * (lp - hp);
      out[i] = (lp - hp) * Math.min(1.0, t * inv) * Math.exp(-rate * t);
    }
    return out;
  };

  // Hand-rolled one-pole lowpass, in place.
  const lowpass = (buf, alpha) => {
    let p = 0.0;
    for (let i = 0; i < buf.length; i++) {
      p += alpha * (buf[i] - p);
      buf[i] = p;
    }
    return buf;
  };

  // Peak-normalize in place — a crusher has to see a full-scale signal or the
  // whole burst rounds to zero.
  const norm = (buf, target = 0.95) => {
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
  };

  // Sample-and-hold rate reduction over a coarse amplitude crush, in place.
  const crush = (buf, steps, hold) => {
    norm(buf);
    const dry = buf.slice();
    let held = 0.0;
    let pk = 0.0;
    for (let i = 0; i < buf.length; i++) {
      if (i % hold === 0) held = buf[i];
      const v = Math.round(held * steps) / steps;
      buf[i] = v;
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
    }
    // A grid this coarse can land between steps and erase the burst outright.
    if (pk < 0.05) for (let i = 0; i < buf.length; i++) buf[i] = dry[i];
    return buf;
  };

  // A stack of inharmonic partials over one fundamental — bells and bars.
  // Anything past 8 kHz is dropped rather than folded back as fizz.
  const bellStack = (n, f, ratios, atk, rate, wave, duty, spread, gains) => {
    const buf = new Array(n).fill(0.0);
    for (let k = 0; k < ratios.length; k++) {
      const fk = f * ratios[k];
      if (fk > 8000.0) continue;
      mixAt(buf, partial(n, fk, atk, rate * (1.0 + spread * k), fk > 2600.0 ? 'tri' : wave, duty), 0, gains[k]);
    }
    return buf;
  };

  let out;
  let tags;

  if (style === 'cowbell') {
    // 808/909 territory: two squares at a ratio chosen to *not* be an interval
    const m = rng.randint(69, 86); // A4..D6
    const f0 = midi(m);
    const ratio = rng.choice([1.3348, 1.4815, 1.5, 1.618, 2.0]);
    const cents = rng.uniform(-22.0, 22.0);
    const fTop = f0 * ratio * Math.pow(2.0, cents / 1200.0);
    const dur = rng.uniform(0.09, 0.45);
    const n = secs(dur);
    const rate = rng.uniform(3.2, 6.0) / dur;
    const atk = rng.uniform(0.0004, 0.0016);
    const wave = rng.choice([null, null, 'tri']);
    const duty = rng.choice([0.5, 0.25]);
    out = partial(n, f0, atk, rate, wave, duty);
    mixAt(out, partial(n, fTop, atk, rate * rng.uniform(0.85, 1.3), wave, duty), 0, rng.uniform(0.55, 0.95));
    const thirdG = rng.uniform(0.0, 0.4);
    const triple = thirdG > 0.16;
    if (triple) mixAt(out, partial(n, Math.min(fTop * 1.5, 7800.0), atk, rate * 1.7, 'tri', duty), 0, thirdG);
    lowpass(out, rng.uniform(0.3, 0.85));
    const stickG = rng.uniform(0.0, 0.35);
    const hard = stickG > 0.13;
    if (hard) {
      mixAt(
        out,
        noiseBurst(Math.min(n, secs(0.005)), rng.randint(1, 3), rng.uniform(0.6, 0.95), rng.uniform(0.1, 0.45), 0.0004, rng.uniform(500, 1400)),
        0,
        stickG
      );
    }
    tags = {
      style: 'cowbell',
      body: triple ? 'three-bell stack' : 'twin-square bell',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      hit: hard ? 'hard stick' : 'soft mallet',
      top_hz: Math.round(fTop),
      note: noteName(m),
    };
  } else if (style === 'woodblock') {
    // a hollow knock: hard bend, one hollow partial, essentially no tail
    const m = rng.randint(76, 96); // E5..C7
    const fEnd = midi(m);
    const bend = rng.uniform(1.15, 2.1);
    const f0 = fEnd * bend;
    const dur = rng.uniform(0.035, 0.12);
    const n = secs(dur);
    const tau = rng.uniform(0.0012, 0.006);
    const rate = rng.uniform(5.0, 10.0) / dur;
    const atk = rng.uniform(0.0003, 0.0012);
    const wave = rng.choice([null, 'tri', 'tri']);
    const duty = rng.choice([0.5, 0.25]);
    out = bendTone(n, f0, fEnd, tau, atk, rate, wave, duty);
    const ratio = rng.uniform(2.3, 3.7);
    const boreG = rng.uniform(0.12, 0.5);
    mixAt(out, partial(n, Math.min(fEnd * ratio, 7600.0), atk, rate * 1.5, 'tri', duty), 0, boreG);
    lowpass(out, rng.uniform(0.35, 0.9));
    const tickG = rng.uniform(0.05, 0.45);
    const ticked = tickG > 0.2;
    mixAt(
      out,
      noiseBurst(Math.min(n, secs(0.004)), rng.randint(1, 2), rng.uniform(0.7, 0.98), rng.uniform(0.2, 0.6), 0.0003, rng.uniform(700, 1900)),
      0,
      tickG
    );
    tags = {
      style: 'woodblock',
      bore: boreG > 0.3 ? `${ratioName(ratio)} bore` : 'tight bore',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      tick: ticked ? 'sharp tick' : 'soft tick',
      bend_hz: Math.round(f0 - fEnd),
      note: noteName(m),
    };
  } else if (style === 'clave') {
    // the cleanest thing here: a tuned ping, one faint upper mode, gone fast
    const m = rng.randint(84, 99); // C6..D#7
    const f = midi(m);
    const dur = rng.uniform(0.04, 0.15);
    const n = secs(dur);
    const rate = rng.uniform(4.5, 9.0) / dur;
    const atk = rng.uniform(0.0004, 0.0018);
    const wave = rng.choice(['tri', 'tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    out = partial(n, f, atk, rate, wave, duty);
    const ratio = rng.uniform(2.6, 4.4);
    const ringHz = foldDown(f * ratio);
    const upperG = rng.uniform(0.06, 0.34);
    mixAt(out, partial(n, ringHz, atk, rate * rng.uniform(1.4, 2.4), 'tri', duty), 0, upperG);
    const alpha = rng.uniform(0.4, 0.95);
    lowpass(out, alpha);
    mixAt(
      out,
      noiseBurst(Math.min(n, secs(0.003)), rng.randint(1, 2), rng.uniform(0.75, 0.98), rng.uniform(0.3, 0.7), 0.0003, rng.uniform(900, 2200)),
      0,
      rng.uniform(0.04, 0.28)
    );
    tags = {
      style: 'clave',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      feel: alpha > 0.7 ? (upperG > 0.2 ? 'bright rosewood' : 'dry rosewood') : 'soft plastic',
      ring_hz: Math.round(ringHz),
      note: noteName(m),
    };
  } else if (style === 'shaker') {
    // band-shaped LFSR with a real swell on the front — 1 to 3 shakes
    const shakes = rng.randint(1, 3);
    const period = rng.randint(1, 4);
    const lpA = rng.uniform(0.4, 0.95);
    const hpA = lpA * rng.uniform(0.3, 0.9);
    const atk = rng.uniform(0.002, 0.022);
    const dur = rng.uniform(0.05, 0.17);
    const n = secs(dur);
    const rate = rng.uniform(4.0, 9.0) / dur;
    const gap = rng.uniform(0.07, 0.18);
    const accent = rng.uniform(0.45, 0.85);
    out = [];
    for (let h = 0; h < shakes; h++) {
      const g = h === 0 ? 1.0 : accent;
      mixAt(out, noiseBurst(n, period, lpA, hpA, atk, rate), secs(h * gap), g);
    }
    const steps = rng.randint(4, 12);
    const hold = rng.randint(1, 5);
    const crushed = hold > 2;
    if (crushed) crush(out, steps, hold);
    const airHz = poleHz(hpA);
    tags = {
      style: 'shaker',
      pattern: shakes === 1 ? 'single shake' : shakes === 2 ? 'double shake' : 'triple shake',
      grain: period <= 1 ? 'fine' : period <= 2 ? 'sandy' : 'coarse',
      texture: crushed ? `${steps}-step crush` : 'smooth swell',
      air_hz: airHz,
      note: noteOfHz(airHz),
    };
  } else if (style === 'tambourine') {
    // jingle stack riding a rattle: one hard hit, or a shaken pair/triple
    const rattles = rng.randint(1, 3);
    const f = rng.uniform(1500.0, 3100.0);
    const jingles = rng.randint(3, 6);
    const ratios = [1.0, 1.34, 1.63, 2.07, 2.53, 3.11].slice(0, jingles);
    const gains = ratios.map((_, k) => 0.9 / (1.0 + 0.8 * k));
    const dur = rattles > 1 ? rng.uniform(0.09, 0.24) : rng.uniform(0.12, 0.45);
    const n = secs(dur);
    const rate = rng.uniform(4.0, 8.5) / dur;
    const atk = rng.uniform(0.0005, 0.003);
    const spread = rng.uniform(0.15, 0.6);
    const duty = rng.choice([0.5, 0.25]);
    const gap = rng.uniform(0.07, 0.16);
    const noiseG = rng.uniform(0.3, 0.9);
    const lpA = rng.uniform(0.55, 0.98);
    const hit = bellStack(n, f, ratios, atk, rate, null, duty, spread, gains);
    mixAt(hit, noiseBurst(n, rng.randint(1, 3), lpA, lpA * rng.uniform(0.4, 0.85), atk, rate * rng.uniform(1.2, 2.2)), 0, noiseG);
    const accent = rng.uniform(0.4, 0.8);
    out = [];
    for (let h = 0; h < rattles; h++) mixAt(out, hit, secs(h * gap), h === 0 ? 1.0 : accent);
    // the highest jingle bellStack actually kept — anything past 8 kHz was dropped
    let topHz = f;
    for (const rt of ratios) {
      const fk = f * rt;
      if (fk <= 8000.0) topHz = fk;
    }
    tags = {
      style: 'tambourine',
      rattle: rattles === 1 ? 'single strike' : rattles === 2 ? 'shaken pair' : 'shaken triple',
      skin: noiseG > 0.6 ? 'noisy head' : 'jingles forward',
      jingles,
      shimmer_hz: Math.round(topHz),
      note: noteOfHz(f),
    };
  } else if (style === 'triangle') {
    // a struck bar: five inharmonic modes, two stacks a few cents apart so the
    // ring shimmers instead of sitting still
    const damped = rng.random() < 0.3;
    const f = rng.uniform(1500.0, 3200.0);
    const ratios = [1.0, 1.36, 1.79, 2.41, 3.02];
    const gains = [0.9, 0.62, 0.46, 0.33, 0.24];
    const dur = damped ? rng.uniform(0.06, 0.18) : rng.uniform(0.32, 0.7);
    const n = secs(dur);
    const rate = rng.uniform(damped ? 5.0 : 2.4, damped ? 9.0 : 4.2) / dur;
    const atk = rng.uniform(0.0004, 0.002);
    const spread = rng.uniform(0.1, 0.45);
    const duty = rng.choice([0.5, 0.25]);
    const cents = rng.uniform(4.0, 26.0);
    const det = Math.pow(2.0, cents / 1200.0);
    out = bellStack(n, f, ratios, atk, rate, 'tri', duty, spread, gains);
    mixAt(out, bellStack(n, f * det, ratios, atk, rate, 'tri', duty, spread, gains), 0, rng.uniform(0.5, 0.95));
    mixAt(
      out,
      noiseBurst(Math.min(n, secs(0.006)), rng.randint(1, 2), rng.uniform(0.75, 0.98), rng.uniform(0.35, 0.8), 0.0004, rng.uniform(400, 1200)),
      0,
      rng.uniform(0.06, 0.3)
    );
    tags = {
      style: 'triangle',
      ring: damped ? 'hand-damped' : 'open ring',
      shimmer: cents > 15.0 ? 'wide beating' : 'slow beating',
      tone: dutyLabel(duty),
      beat_hz: r1(f * (det - 1.0)),
      note: noteOfHz(f),
    };
  } else if (style === 'conga') {
    // a tuned head, four ways to strike it
    const hit = rng.choice(['open', 'open', 'slap', 'muff', 'heel']);
    const m = rng.randint(43, 64); // G2..E4
    const fEnd = midi(m);
    const f0 = fEnd * (hit === 'slap' ? rng.uniform(1.45, 2.4) : rng.uniform(1.12, 1.7));
    const dur =
      hit === 'open' ? rng.uniform(0.18, 0.5)
      : hit === 'slap' ? rng.uniform(0.07, 0.2)
      : hit === 'muff' ? rng.uniform(0.05, 0.13)
      : rng.uniform(0.06, 0.17);
    const n = secs(dur);
    const tau = rng.uniform(0.003, 0.02);
    const rate = rng.uniform(hit === 'open' ? 3.2 : 5.0, hit === 'open' ? 5.5 : 9.0) / dur;
    const atk = rng.uniform(0.0006, 0.0022);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    out = bendTone(n, f0, fEnd, tau, atk, rate, wave, duty);
    const ratio = hit === 'slap' ? rng.choice([2.4, 2.9, 3.4]) : rng.choice([1.5, 1.59, 2.0]);
    mixAt(out, partial(n, fEnd * ratio, atk, rate * 1.7, wave, duty), 0, rng.uniform(0.12, 0.45));
    const handG = hit === 'slap' ? rng.uniform(0.4, 0.85) : rng.uniform(0.06, 0.32);
    mixAt(
      out,
      noiseBurst(
        Math.min(n, secs(hit === 'slap' ? 0.03 : 0.007)),
        rng.randint(1, 3),
        rng.uniform(0.45, 0.95),
        rng.uniform(0.05, 0.4),
        0.0005,
        rng.uniform(hit === 'slap' ? 90 : 250, hit === 'slap' ? 320 : 800)
      ),
      0,
      handG
    );
    const alpha = rng.uniform(0.06, 0.35);
    if (hit === 'muff' || hit === 'heel') lowpass(out, alpha);
    tags = {
      style: 'conga',
      hit: hit === 'open' ? 'open tone' : hit === 'slap' ? 'bright slap' : hit === 'muff' ? 'muffed press' : 'heel thud',
      shell: m >= 57 ? 'quinto shell' : m >= 49 ? 'conga shell' : 'tumba shell',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      bend_hz: Math.round(f0 - fEnd),
      note: noteName(m),
    };
  } else if (style === 'bongo') {
    // small tight heads — often answered a few semitones up (or down)
    const m = rng.randint(60, 79); // C4..G5
    const pairUp = rng.random() < 0.45;
    const semis = rng.randint(3, 8);
    const gap = rng.uniform(0.055, 0.16);
    const bend = rng.uniform(1.2, 2.0);
    const tau = rng.uniform(0.002, 0.01);
    const atk = rng.uniform(0.0005, 0.0018);
    const wave = rng.choice(['tri', null, null]);
    const duty = rng.choice([0.5, 0.25]);
    const dur = pairUp ? rng.uniform(0.05, 0.14) : rng.uniform(0.06, 0.2);
    const n = secs(dur);
    const rate = rng.uniform(6.0, 11.0) / dur;
    const slapG = rng.uniform(0.15, 0.6);
    const ratio = rng.choice([1.59, 2.0, 2.44]);
    const voice = (mm) => {
      const fEnd = midi(mm);
      const b = bendTone(n, fEnd * bend, fEnd, tau, atk, rate, wave, duty);
      mixAt(b, partial(n, Math.min(fEnd * ratio, 7800.0), atk, rate * 1.6, 'tri', duty), 0, rng.uniform(0.1, 0.4));
      mixAt(
        b,
        noiseBurst(Math.min(n, secs(0.008)), rng.randint(1, 3), rng.uniform(0.55, 0.95), rng.uniform(0.15, 0.5), 0.0004, rng.uniform(300, 900)),
        0,
        slapG
      );
      return b;
    };
    out = voice(m);
    if (pairUp) mixAt(out, voice(m + semis), secs(gap), rng.uniform(0.5, 0.9));
    tags = {
      style: 'bongo',
      pair: pairUp ? `macho answer +${semis}` : 'single hit',
      drum: m >= 70 ? 'macho head' : 'hembra head',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      snap_hz: Math.round(midi(m) * bend),
      note: noteName(m),
    };
  } else if (style === 'rim') {
    // crack first, pitch second — cross-stick is woody, rimshot is a gunshot
    const shot = rng.random() < 0.45;
    const m = rng.randint(60, 82); // C4..A#5
    const f = midi(m);
    const ratio = rng.uniform(2.4, 4.6);
    const dur = shot ? rng.uniform(0.04, 0.11) : rng.uniform(0.032, 0.085);
    const n = secs(dur);
    const rate = rng.uniform(7.0, 14.0) / dur;
    const atk = rng.uniform(0.0002, 0.001);
    const wave = rng.choice([null, 'tri']);
    const duty = rng.choice([0.5, 0.25]);
    const crackHz = foldDown(f * ratio);
    out = partial(n, f, atk, rate, wave, duty);
    mixAt(out, partial(n, crackHz, atk, rate * rng.uniform(1.2, 2.0), 'tri', duty), 0, rng.uniform(0.2, 0.6));
    const noiseG = shot ? rng.uniform(0.5, 1.0) : rng.uniform(0.15, 0.5);
    mixAt(
      out,
      noiseBurst(
        Math.min(n, secs(shot ? 0.02 : 0.005)),
        rng.randint(1, 2),
        rng.uniform(0.6, 0.98),
        rng.uniform(0.2, 0.65),
        0.0003,
        rng.uniform(shot ? 150 : 600, shot ? 600 : 1800)
      ),
      0,
      noiseG
    );
    lowpass(out, rng.uniform(0.45, 0.95));
    tags = {
      style: 'rim',
      kind: shot ? 'rimshot' : 'cross-stick',
      wood: noiseG > 0.45 ? 'metal-edged' : 'woody',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      crack_hz: Math.round(crackHz),
      note: noteName(m),
    };
  } else if (style === 'agogo') {
    // two bells a real interval apart: strike one, or answer it with the other
    const m = rng.randint(72, 84); // C5..C6 — the low bell
    const semis = rng.randint(3, 7);
    const both = rng.random() < 0.55;
    const highFirst = rng.random() < 0.4;
    const cents = rng.uniform(-14.0, 14.0);
    const det = Math.pow(2.0, cents / 1200.0);
    const ratios = [1.0, 2.0, 2.76, 3.66];
    const gains = [0.9, 0.5, 0.34, 0.2];
    const dur = both ? rng.uniform(0.16, 0.38) : rng.uniform(0.18, 0.48);
    const n = secs(dur);
    const rate = rng.uniform(3.0, 6.0) / dur;
    const atk = rng.uniform(0.0004, 0.0016);
    const spread = rng.uniform(0.2, 0.7);
    const duty = rng.choice([0.5, 0.25]);
    const gap = rng.uniform(0.08, 0.2);
    const strikeG = rng.uniform(0.1, 0.4);
    const bell = (mm) => {
      const b = bellStack(n, midi(mm) * det, ratios, atk, rate, null, duty, spread, gains);
      lowpass(b, rng.uniform(0.4, 0.9));
      mixAt(
        b,
        noiseBurst(Math.min(n, secs(0.004)), rng.randint(1, 2), rng.uniform(0.7, 0.98), rng.uniform(0.25, 0.65), 0.0003, rng.uniform(600, 1600)),
        0,
        strikeG
      );
      return b;
    };
    const lowM = m;
    const highM = m + semis;
    out = [];
    if (both) {
      mixAt(out, bell(highFirst ? highM : lowM), 0, 1.0);
      mixAt(out, bell(highFirst ? lowM : highM), secs(gap), rng.uniform(0.55, 0.95));
    } else {
      mixAt(out, bell(highFirst ? highM : lowM), 0, 1.0);
    }
    tags = {
      style: 'agogo',
      pattern: both ? (highFirst ? 'high-then-low' : 'low-then-high') : 'single bell',
      tone: strikeG > 0.25 ? 'hard beater' : 'soft beater',
      semis,
      bell_hz: Math.round(midi(m) * det * 2.76),
      note: noteName(m),
    };
  } else {
    // guiro: 5-16 teeth under the stick, even or accelerating, then a last bite
    const teeth = rng.randint(5, 16);
    const span = rng.uniform(0.13, 0.58);
    const accel = rng.uniform(-0.5, 0.5);
    const up = rng.random() < 0.6;
    const lpA = rng.uniform(0.5, 0.95);
    const hpFrac = rng.uniform(0.35, 0.85);
    const tick = rng.uniform(0.005, 0.02);
    const tn = secs(tick);
    const rate = rng.uniform(2.5, 6.0) / tick;
    const period = rng.randint(1, 3);
    const swell = rng.uniform(0.45, 0.95);
    const bite = rng.uniform(0.0, 0.5);
    const bitten = bite > 0.2;
    out = [];
    for (let k = 0; k < teeth; k++) {
      const u = teeth > 1 ? k / (teeth - 1) : 0.0;
      // accel warps the tooth spacing: negative crowds the end, positive the start
      const at = span * (u + accel * u * (1.0 - u));
      const bright = up ? 0.6 + 0.4 * u : 1.0 - 0.4 * u;
      const g = (swell + (1.0 - swell) * u) * (k % 2 === 0 ? 1.0 : 0.82);
      mixAt(out, noiseBurst(tn, period, Math.min(0.98, lpA * bright), lpA * hpFrac, 0.0006, rate), secs(at), g);
    }
    if (bitten) {
      mixAt(
        out,
        noiseBurst(secs(Math.min(0.06, 0.68 - span)), period, Math.min(0.98, lpA), lpA * hpFrac * 0.6, 0.001, rng.uniform(40, 140)),
        secs(span),
        bite
      );
    }
    const raspHz = Math.round(teeth / span);
    tags = {
      style: 'guiro',
      direction: up ? 'up-scrape' : 'down-scrape',
      spacing: accel > 0.12 ? 'slowing' : accel < -0.12 ? 'accelerating' : 'even',
      texture: bitten ? 'bitten tail' : 'clean release',
      teeth,
      rasp_hz: raspHz,
      note: noteOfHz(poleHz(lpA * hpFrac)),
    };
  }

  rng.tags = tags;

  // Keep every hit inside 0.032 - 0.7 s, block the duty-cycle DC bias, fade both
  // edges, then normalize last so the peak is exact even when the loudest sample
  // sits inside the first millisecond.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  while (out.length < MIN_N) out.push(0.0);
  dcBlock(out);
  const fi = Math.min(out.length >> 3, 10);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.005 * SR), Math.round(0.035 * out.length)));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C5';
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const int = (v) => Math.trunc(num(v));
  switch (t.style) {
    case 'woodblock':
      return `woodblock — ${t.bore || 'tight bore'}, ${t.tick || 'sharp tick'}, ${int(t.bend_hz)} Hz knock at ${note}`;
    case 'clave':
      return `clave — ${t.feel || 'dry rosewood'}, ${t.tone || 'triangle'}, ${int(t.ring_hz)} Hz ping on ${note}`;
    case 'shaker':
      return `shaker — ${t.pattern || 'single shake'}, ${t.grain || 'sandy'} grain, ${t.texture || 'smooth swell'} near ${note}`;
    case 'tambourine':
      return `tambourine — ${t.rattle || 'single strike'}, ${int(t.jingles)} jingles, ${int(t.shimmer_hz)} Hz shimmer near ${note}`;
    case 'triangle':
      return `triangle ding — ${t.ring || 'open ring'}, ${t.shimmer || 'slow beating'}, ${num(t.beat_hz).toFixed(1)} Hz beat near ${note}`;
    case 'conga':
      return `conga ${t.hit || 'open tone'} — ${t.shell || 'conga shell'}, ${t.tone || 'triangle'}, ${int(t.bend_hz)} Hz bend onto ${note}`;
    case 'bongo':
      return `bongo — ${t.pair || 'single hit'}, ${t.drum || 'macho head'}, ${int(t.snap_hz)} Hz snap on ${note}`;
    case 'rim':
      return `${t.kind || 'cross-stick'} — ${t.wood || 'woody'}, ${t.tone || 'triangle'}, ${int(t.crack_hz)} Hz crack over ${note}`;
    case 'agogo':
      return `agogo bell — ${t.pattern || 'single bell'}, ${int(t.semis)} semitones up, ${int(t.bell_hz)} Hz ring on ${note}`;
    case 'guiro':
      return `guiro scrape — ${int(t.teeth)} teeth ${t.direction || 'up-scrape'}, ${t.spacing || 'even'}, ${int(t.rasp_hz)} Hz rasp near ${note}`;
    default:
      return `cowbell — ${t.body || 'twin-square bell'}, ${t.hit || 'hard stick'}, ${int(t.top_hz)} Hz clank over ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'tuned cowbells, blocks, claves, shakers, congas, agogo bells';
