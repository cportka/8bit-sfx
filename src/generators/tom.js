// tom — the melodic drum of the kit. Where a kick lands on one note and a snare
// is mostly noise, a tom *is* a pitch: the whole point is that a fill walks down
// (or up) a set of tuned shells. So every variation here lands on an exact MIDI
// note and records it, and the fill style ('roll') walks a real semitone step.
//
// The chip caricature of a drum head is two things glued together: a fundamental
// that bends down from a short overshoot as the head relaxes, and one inharmonic
// partial above it (1.5x, 1.59x — the ideal membrane's 01/11 mode ratio — 2x, or
// something clangier for timbales). A lowpassed LFSR burst is the stick. That is
// the whole vocabulary; the ten sub-styles are what you do with it:
//
//   rack     standard high/mid/low rack tom, crisp stick, modest bend
//   floor    deep shell, slow settle, optional octave-down sub, lowpass warmth
//   falling  the long Simmons-style descending bend, with optional noise wash
//   roto     roto-tom: pitch *rises* through the ring, 3-12 semitones
//   muted    damped and choked — one-pole lowpass, fast decay, stick forward
//   ringing  two detuned heads beating against each other over a long ring
//   flam     a grace note either side of the main hit
//   crushed  sample-and-hold rate reduction plus a coarse amplitude crush
//   roll     3-6 hit fill stepping down (or up) the kit
//   timbale  high tight shell with a metallic upper partial and a rim tick
//
// Post-processing is uniform: DC block (narrow-duty squares carry a bias), fade
// both edges, then normalize last so the peak is exact even when the loudest
// sample sits inside the first millisecond.

import { SR, Lfsr, midi, noteName, renderTone, finish, mixAt, dcBlock } from '../dsp.js';

const MIN_N = Math.round(0.1 * SR);
const MAX_N = Math.round(0.9 * SR);

/** One decimal place, for tag values that read better rounded. */
function r1(x) {
  return Math.round(x * 10) / 10;
}

/** "12.5% duty" / "25% duty" / "50% duty". */
function dutyLabel(d) {
  return `${d * 100}% duty`;
}

/** Name the upper partial by its ratio, for the catalog blurb. */
function overtoneName(ratio) {
  if (ratio < 1.55) return 'fifth';
  if (ratio < 1.8) return 'membrane';
  if (ratio < 2.2) return 'octave';
  if (ratio < 2.6) return 'metallic';
  if (ratio < 2.9) return 'clangy';
  if (ratio < 3.4) return 'twelfth';
  return 'bell';
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'rack', 'floor', 'falling', 'roto', 'muted',
    'ringing', 'flam', 'crushed', 'roll', 'timbale',
  ]);

  const secs = (s) => Math.max(1, Math.round(s * SR));

  // linear attack into an exponential decay
  const env = (atk, rate) => {
    const inv = 1.0 / Math.max(atk, 1e-5);
    return (t) => Math.min(1.0, t * inv) * Math.exp(-rate * t);
  };

  // The drum head: pitch overshoots to f0 and relaxes onto fEnd with constant tau.
  const head = (n, f0, fEnd, tau, atk, rate, wave, duty) =>
    renderTone(n, (t) => fEnd + (f0 - fEnd) * Math.exp(-t / tau), duty, env(atk, rate), wave);

  // A fixed partial above the fundamental — the shell's inharmonic ring.
  const partial = (n, f, atk, rate, wave, duty) => renderTone(n, () => f, duty, env(atk, rate), wave);

  // Lowpassed LFSR burst — the stick / beater / rim tick.
  const stick = (n, period, alpha, atk, rate) => {
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

  // Hand-rolled one-pole lowpass, in place.
  const lowpass = (buf, alpha) => {
    let p = 0.0;
    for (let i = 0; i < buf.length; i++) {
      p += alpha * (buf[i] - p);
      buf[i] = p;
    }
    return buf;
  };

  let out;
  let tags;

  if (style === 'rack') {
    // the workhorse: high/mid/low rack tom, short bend, stick on top
    const m = rng.randint(45, 62); // A2..D4
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(1.3, 2.2);
    const dur = rng.uniform(0.16, 0.5);
    const n = secs(dur);
    const tau = rng.uniform(0.008, 0.032);
    const rate = rng.uniform(3.5, 6.5) / dur;
    const atk = rng.uniform(0.0008, 0.0025);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    out = head(n, f0, fEnd, tau, atk, rate, wave, duty);
    const ratio = rng.choice([1.5, 1.59, 2.0]);
    mixAt(out, partial(n, fEnd * ratio, atk, rate * 1.9, wave, duty), 0, rng.uniform(0.12, 0.45));
    const stickG = rng.uniform(0.0, 0.45);
    const hard = stickG > 0.16;
    if (hard) {
      mixAt(
        out,
        stick(Math.min(n, secs(0.006)), rng.randint(1, 3), rng.uniform(0.45, 0.9), 0.0006, rng.uniform(320, 900)),
        0,
        stickG
      );
    }
    tags = {
      style: 'rack',
      size: m >= 57 ? 'high rack tom' : m >= 51 ? 'mid rack tom' : 'low rack tom',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      stick: hard ? 'crisp stick' : 'soft mallet',
      bend_hz: Math.round(f0 - fEnd),
      note: noteName(m),
    };
  } else if (style === 'floor') {
    // deep floor tom: slow settle, lowpass warmth, optional octave-down sub
    const m = rng.randint(31, 45); // G1..A2
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(1.25, 1.9);
    const dur = rng.uniform(0.35, 0.88);
    const n = secs(dur);
    const tau = rng.uniform(0.02, 0.07);
    const rate = rng.uniform(3.0, 5.5) / dur;
    const atk = rng.uniform(0.0015, 0.005);
    out = head(n, f0, fEnd, tau, atk, rate, 'tri', 0.5);
    const ratio = rng.choice([1.5, 1.59, 2.0]);
    mixAt(out, partial(n, fEnd * ratio, atk, rate * 2.2, 'tri', 0.5), 0, rng.uniform(0.1, 0.3));
    const alpha = rng.uniform(0.1, 0.45);
    lowpass(out, alpha);
    const subG = rng.uniform(0.0, 0.55);
    const layered = subG > 0.18;
    if (layered) {
      mixAt(out, partial(n, Math.max(fEnd * 0.5, 38.0), 0.004, rate * 0.8, 'tri', 0.5), 0, subG);
    }
    const beaterG = rng.uniform(0.0, 0.32);
    if (beaterG > 0.1) {
      mixAt(
        out,
        stick(Math.min(n, secs(0.01)), rng.randint(2, 5), rng.uniform(0.2, 0.55), 0.001, rng.uniform(120, 400)),
        0,
        beaterG
      );
    }
    tags = {
      style: 'floor',
      depth: alpha < 0.25 ? 'cavernous' : 'round',
      layers: layered ? 'sub layer under' : 'single layer',
      decay_ms: Math.round(1000.0 / rate),
      note: noteName(m),
    };
  } else if (style === 'falling') {
    // the long descending bend — Simmons in a chip, optionally noise-washed
    const m = rng.randint(29, 45); // F1..A2
    const fEnd = midi(m);
    const oct = rng.uniform(1.2, 3.0);
    const f0 = fEnd * Math.pow(2.0, oct);
    const dur = rng.uniform(0.25, 0.8);
    const n = secs(dur);
    const shape = rng.uniform(0.12, 0.35);
    const tau = dur * shape;
    const rate = rng.uniform(2.5, 4.5) / dur;
    const atk = rng.uniform(0.0008, 0.003);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    out = head(n, f0, fEnd, tau, atk, rate, wave, duty);
    const noiseG = rng.uniform(0.0, 0.4);
    const noisy = noiseG > 0.12;
    if (noisy) {
      mixAt(out, stick(n, rng.randint(1, 4), rng.uniform(0.2, 0.6), 0.001, rng.uniform(6.0, 22.0)), 0, noiseG);
    }
    tags = {
      style: 'falling',
      sweep: shape > 0.24 ? 'slow drop' : 'quick drop',
      grit: noisy ? 'noisy shell' : 'clean shell',
      drop_oct: r1(oct),
      note: noteName(m),
    };
  } else if (style === 'roto') {
    // roto-tom: the head tightens as it rings, so the pitch climbs
    const m = rng.randint(43, 60); // G2..C4 — the struck pitch
    const f0 = midi(m);
    const semis = rng.randint(3, 12);
    const dur = rng.uniform(0.2, 0.7);
    const n = secs(dur);
    const shape = rng.uniform(0.08, 0.35);
    const tau = dur * shape;
    const rate = rng.uniform(3.0, 5.5) / dur;
    const atk = rng.uniform(0.0008, 0.003);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const glide = (t) => Math.pow(2.0, (semis / 12.0) * (1.0 - Math.exp(-t / tau)));
    out = renderTone(n, (t) => f0 * glide(t), duty, env(atk, rate), wave);
    mixAt(
      out,
      renderTone(n, (t) => 1.5 * f0 * glide(t), duty, env(atk, rate * 2.0), wave),
      0,
      rng.uniform(0.1, 0.35)
    );
    const stickG = rng.uniform(0.0, 0.4);
    if (stickG > 0.14) {
      mixAt(
        out,
        stick(Math.min(n, secs(0.005)), rng.randint(1, 3), rng.uniform(0.5, 0.9), 0.0005, rng.uniform(400, 1100)),
        0,
        stickG
      );
    }
    tags = {
      style: 'roto',
      bend: shape < 0.18 ? 'quick bend' : 'slow bend',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      semis,
      note: noteName(m),
    };
  } else if (style === 'muted') {
    // damped and choked: lowpassed body, fast decay, the stick left in front
    const m = rng.randint(41, 60); // F2..C4
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(1.2, 1.8);
    const dur = rng.uniform(0.1, 0.22);
    const n = secs(dur);
    const tau = rng.uniform(0.004, 0.015);
    const rate = rng.uniform(5.0, 9.0) / dur;
    const atk = rng.uniform(0.0006, 0.002);
    const wave = rng.choice(['tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    out = head(n, f0, fEnd, tau, atk, rate, wave, duty);
    const alpha = rng.uniform(0.06, 0.32);
    lowpass(out, alpha);
    const stickG = rng.uniform(0.1, 0.45);
    mixAt(
      out,
      stick(Math.min(n, secs(0.004)), rng.randint(1, 3), rng.uniform(0.35, 0.8), 0.0005, rng.uniform(500, 1400)),
      0,
      stickG
    );
    tags = {
      style: 'muted',
      damping: rng.choice(['palm-damped', 'towel-damped', 'tape-damped', 'hand-damped']),
      tone: alpha < 0.16 ? 'dull thud' : 'woody thud',
      decay_ms: Math.round(1000.0 / rate),
      note: noteName(m),
    };
  } else if (style === 'ringing') {
    // two heads a few cents apart, beating against each other over a long ring
    const m = rng.randint(38, 55); // D2..G3
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(1.15, 1.6);
    const dur = rng.uniform(0.45, 0.88);
    const n = secs(dur);
    const tau = rng.uniform(0.01, 0.04);
    const rate = rng.uniform(2.2, 4.0) / dur;
    const atk = rng.uniform(0.001, 0.003);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    const cents = rng.uniform(4.0, 30.0);
    const det = Math.pow(2.0, cents / 1200.0);
    out = head(n, f0, fEnd, tau, atk, rate, wave, duty);
    mixAt(out, head(n, f0 * det, fEnd * det, tau, atk, rate, wave, duty), 0, rng.uniform(0.5, 0.9));
    const ratio = rng.choice([1.5, 1.59, 2.0, 2.44]);
    mixAt(out, partial(n, fEnd * ratio, atk, rate * 1.5, wave, duty), 0, rng.uniform(0.15, 0.4));
    tags = {
      style: 'ringing',
      ring: rate < 4.0 ? 'long ring' : 'medium ring',
      overtone: overtoneName(ratio),
      beat_hz: r1(fEnd * (det - 1.0)),
      note: noteName(m),
    };
  } else if (style === 'flam') {
    // a grace note a few ms off the main hit, on either side of it
    const m = rng.randint(40, 58); // E2..A#3
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(1.3, 2.0);
    const gap = rng.uniform(0.018, 0.07);
    const mainDur = rng.uniform(0.18, 0.45);
    const tau = rng.uniform(0.008, 0.03);
    const atk = rng.uniform(0.0008, 0.002);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    const main = head(secs(mainDur), f0, fEnd, tau, atk, rng.uniform(3.5, 6.0) / mainDur, wave, duty);
    const gm = m + rng.randint(2, 7);
    const gf = midi(gm);
    const gDur = rng.uniform(0.06, 0.16);
    const grace = head(secs(gDur), gf * 1.5, gf, tau * 0.7, atk, rng.uniform(5.0, 9.0) / gDur, wave, duty);
    const graceG = rng.uniform(0.25, 0.6);
    const graceFirst = rng.random() < 0.7;
    out = [];
    if (graceFirst) {
      mixAt(out, grace, 0, graceG);
      mixAt(out, main, secs(gap), 1.0);
    } else {
      mixAt(out, main, 0, 1.0);
      mixAt(out, grace, secs(gap), graceG);
    }
    tags = {
      style: 'flam',
      order: graceFirst ? 'grace into main' : 'main into drag',
      grace: graceG > 0.45 ? 'loud grace' : 'soft grace',
      flam_ms: r1(gap * 1000.0),
      note: noteName(m),
    };
  } else if (style === 'crushed') {
    // lo-fi tom: sample-and-hold rate reduction over a coarse amplitude crush
    const m = rng.randint(36, 55); // C2..G3
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(1.3, 2.1);
    const dur = rng.uniform(0.15, 0.5);
    const n = secs(dur);
    const tau = rng.uniform(0.008, 0.03);
    const rate = rng.uniform(3.5, 6.5) / dur;
    const atk = rng.uniform(0.0008, 0.002);
    const wave = rng.choice(['tri', null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    out = head(n, f0, fEnd, tau, atk, rate, wave, duty);
    mixAt(out, partial(n, fEnd * rng.choice([1.5, 1.59, 2.0]), atk, rate * 1.8, wave, duty), 0, rng.uniform(0.12, 0.4));
    const noiseG = rng.uniform(0.0, 0.35);
    const gritty = noiseG > 0.12;
    if (gritty) {
      mixAt(
        out,
        stick(Math.min(n, secs(0.04)), rng.randint(2, 6), rng.uniform(0.2, 0.6), 0.0008, rng.uniform(50.0, 180.0)),
        0,
        noiseG
      );
    }
    const steps = rng.randint(3, 9);
    const hold = rng.randint(2, 14);
    let held = 0.0;
    for (let i = 0; i < out.length; i++) {
      if (i % hold === 0) held = out[i];
      out[i] = Math.round(held * steps) / steps;
    }
    tags = {
      style: 'crushed',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      grit: gritty ? 'gritty crunch' : 'clean crunch',
      steps,
      crush_hz: Math.round(SR / hold),
      note: noteName(m),
    };
  } else if (style === 'roll') {
    // a 3-6 hit fill walking down (or up) the kit in even semitone steps
    const hits = rng.randint(3, 6);
    const gap = rng.uniform(0.055, Math.min(0.14, 0.84 / hits));
    const down = rng.random() < 0.65;
    const step = rng.randint(2, 5);
    const m0 = down ? rng.randint(48, 62) : rng.randint(34, 46);
    const bend = rng.uniform(1.25, 1.9);
    const tau = rng.uniform(0.008, 0.028);
    const atk = rng.uniform(0.0008, 0.002);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    const hitDur = Math.min(0.32, gap * 2.6, 0.87 - (hits - 1) * gap);
    const rate = rng.uniform(3.5, 6.0) / hitDur;
    const ghost = rng.uniform(0.5, 0.85);
    const stickG = rng.uniform(0.0, 0.35);
    const ticked = stickG > 0.12;
    const tick = ticked
      ? stick(secs(0.004), rng.randint(1, 3), rng.uniform(0.5, 0.9), 0.0005, rng.uniform(500.0, 1200.0))
      : null;
    const hn = secs(hitDur);
    out = [];
    for (let h = 0; h < hits; h++) {
      const mh = m0 + (down ? -step * h : step * h);
      const fEnd = midi(mh);
      // accent the downbeat, dip, then swell back up into the last hit
      const g = h === 0 ? 1.0 : ghost + (1.0 - ghost) * (h / (hits - 1));
      const at = secs(h * gap);
      mixAt(out, head(hn, fEnd * bend, fEnd, tau, atk, rate, wave, duty), at, g);
      if (tick) mixAt(out, tick, at, stickG * g);
    }
    tags = {
      style: 'roll',
      direction: down ? 'descending' : 'ascending',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      hits,
      gap_ms: Math.round(gap * 1000.0),
      note: noteName(m0),
    };
  } else {
    // timbale: high, tight, metallic upper partial and a rim tick on the front
    const m = rng.randint(57, 72); // A3..C5
    const fEnd = midi(m);
    const f0 = fEnd * rng.uniform(1.2, 1.8);
    const dur = rng.uniform(0.1, 0.3);
    const n = secs(dur);
    const tau = rng.uniform(0.004, 0.016);
    const rate = rng.uniform(4.5, 8.0) / dur;
    const atk = rng.uniform(0.0006, 0.002);
    const wave = rng.choice([null, null, 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    out = head(n, f0, fEnd, tau, atk, rate, wave, duty);
    const ratio = rng.choice([2.44, 2.7, 3.0, 3.8]);
    const shellG = rng.uniform(0.1, 0.42);
    mixAt(out, partial(n, fEnd * ratio, atk, rate * 1.3, wave, duty), 0, shellG);
    mixAt(
      out,
      stick(Math.min(n, secs(0.003)), rng.randint(1, 2), rng.uniform(0.6, 0.95), 0.0004, rng.uniform(700, 1800)),
      0,
      rng.uniform(0.15, 0.55)
    );
    tags = {
      style: 'timbale',
      tone: wave === 'tri' ? 'triangle' : dutyLabel(duty),
      shell: shellG > 0.25 ? `${overtoneName(ratio)} shell` : 'dry shell',
      top_hz: Math.round(f0),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Keep every tom inside 0.1 - 0.9 s, block the duty-cycle DC bias, fade both
  // edges, then normalize last so the peak is exact even when the loudest sample
  // sits inside the first millisecond.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  while (out.length < MIN_N) out.push(0.0);
  dcBlock(out);
  const fi = Math.min(out.length >> 3, 10);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.006 * SR), Math.round(0.04 * out.length)));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C3';
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const int = (v) => Math.trunc(num(v));
  switch (t.style) {
    case 'floor':
      return `floor tom — ${t.depth || 'round'} shell, ${t.layers || 'single layer'}, ${int(t.decay_ms)} ms tail on ${note}`;
    case 'falling':
      return `falling tom — ${t.sweep || 'quick drop'}, ${t.grit || 'clean shell'}, ${num(t.drop_oct).toFixed(1)} oct fall onto ${note}`;
    case 'roto':
      return `roto-tom rise — ${t.bend || 'quick bend'}, ${t.tone || 'triangle'} shell, ${int(t.semis)} semitones up from ${note}`;
    case 'muted':
      return `muted tom — ${t.damping || 'hand-damped'}, ${t.tone || 'dull thud'}, ${int(t.decay_ms)} ms choke on ${note}`;
    case 'ringing':
      return `ringing tom — ${t.ring || 'long ring'}, ${t.overtone || 'fifth'} overtone, ${num(t.beat_hz).toFixed(1)} Hz beat on ${note}`;
    case 'flam':
      return `flammed tom — ${t.order || 'grace into main'}, ${t.grace || 'soft grace'}, ${num(t.flam_ms).toFixed(1)} ms apart on ${note}`;
    case 'crushed':
      return `crushed tom — ${int(t.steps)}-step ${t.grit || 'gritty crunch'}, ${t.tone || 'triangle'} shell, ${int(t.crush_hz)} Hz hold on ${note}`;
    case 'roll':
      return `tom roll — ${int(t.hits)} hits ${t.direction || 'descending'}, ${t.tone || 'triangle'} shells, ${int(t.gap_ms)} ms apart from ${note}`;
    case 'timbale':
      return `timbale tom — ${t.tone || 'triangle'} crack, ${t.shell || 'dry shell'}, ${int(t.top_hz)} Hz snap on ${note}`;
    default:
      return `${t.size || 'mid rack tom'} — ${t.tone || 'triangle'} shell, ${t.stick || 'crisp stick'}, ${int(t.bend_hz)} Hz bend onto ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'tuned rack and floor toms, falling bends, roto rises, fills';
