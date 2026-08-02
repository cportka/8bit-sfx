// Human body foley, chip-imitated: heartbeats, breathing, sneezes, coughs,
// snores, yawns, gulps, chewing, claps, applause, snaps, shivers, gut growls.
// Deliberately non-vocal (dialog/grunts/laughs live in `voice`): everything
// here is air, impact, and gut — LFSR noise pushed through hand-rolled one-pole
// filters, plus low triangle thumps for the body resonance.

import { SR, Lfsr, square, triangle, dcBlock } from '../dsp.js';

/** Round half to EVEN, matching Python's built-in `round()`. */
function rnd(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  rng.random();
  rng.random();
  rng.random();
  rng.random(); // warm-up draws: decorrelates style pick across nearby seeds
  const out = [];

  const add = (buf, at) => {
    const need = at + buf.length;
    while (out.length < need) out.push(0.0);
    for (let i = 0; i < buf.length; i++) out[at + i] += buf[i];
  };

  // readable cutoff of the hand-rolled one-pole lowpass, for the tags
  const onePoleHz = (alpha) => rnd((-SR * Math.log(1.0 - alpha)) / (2.0 * Math.PI) / 10.0) * 10;

  // low triangle knock, pitch sagging to drop*f0 — heart / chest / jaw body
  const thump = (dur, f0, drop, rate, amp = 1.0) => {
    const n = Math.trunc(SR * dur);
    let ph = 0.0;
    const buf = [];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const u = i / n;
      ph += (f0 * Math.pow(drop, u)) / SR;
      buf.push(triangle(ph) * Math.min(1.0, t / 0.004) * Math.exp(-rate * u) * amp);
    }
    return buf;
  };

  // shaped air: LFSR noise through a one-pole lowpass whose alpha glides
  // a0 -> a1; sine-window envelope; optional soft-palate gate (snores)
  const gust = (dur, a0, a1, amp, lf, shape = 1.0, gateHz = 0.0, gateDepth = 0.0) => {
    const n = Math.trunc(SR * dur);
    let y = 0.0;
    const buf = [];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const u = i / n;
      y += (a0 + (a1 - a0) * u) * (lf.next() - y);
      let env = Math.pow(Math.sin(Math.PI * u), shape);
      if (gateHz > 0.0) env *= 1.0 - gateDepth * (0.5 + 0.5 * square(t * gateHz, 0.5));
      buf.push(y * env * amp);
    }
    return buf;
  };

  // percussive air burst: instant attack, exponential decay (coughs, claps)
  const bark = (dur, a0, a1, amp, dk, lf, gateHz = 0.0, gateDepth = 0.0) => {
    const n = Math.trunc(SR * dur);
    let y = 0.0;
    const buf = [];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const u = i / n;
      y += (a0 + (a1 - a0) * u) * (lf.next() - y);
      let env = Math.min(1.0, t / 0.003) * Math.exp(-dk * u);
      if (gateHz > 0.0) env *= 1.0 - gateDepth * (0.5 + 0.5 * square(t * gateHz, 0.5));
      buf.push(y * env * amp);
    }
    return buf;
  };

  // falling triangle blip — the liquid knock of a swallow
  const glug = (dur, fa, fb, amp) => {
    const n = Math.trunc(SR * dur);
    let ph = 0.0;
    const buf = [];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const u = i / n;
      ph += (fa + (fb - fa) * u) / SR;
      buf.push(triangle(ph) * Math.min(1.0, t / 0.004) * Math.pow(1.0 - u, 1.2) * amp);
    }
    return buf;
  };

  const style = rng.choice(['heartbeat', 'breath', 'sneeze', 'cough', 'snore', 'yawn',
    'gulp', 'chew', 'clap', 'applause', 'snap', 'shiver', 'growl']);

  if (style === 'heartbeat') {
    // lub-dub pairs on a falling triangle thump, dub softer and lower
    const bpm = rng.randint(52, 96);
    let pairs = rng.choice([1, 2, 2, 3]);
    const f0 = rng.uniform(46.0, 72.0);
    const gap = rng.uniform(0.13, 0.2);
    const rate = rng.uniform(4.5, 7.0);
    const beat = 60.0 / bpm;
    while (pairs > 1 && (pairs - 1) * beat + 0.4 > 2.0) pairs -= 1;
    rng.tags = {
      style: 'heartbeat', bpm, beats: pairs,
      thump_hz: rnd(f0),
      depth: f0 < 58.0 ? 'deep' : 'light',
    };
    for (let k = 0; k < pairs; k++) {
      const t0 = k * beat;
      add(thump(0.16, f0 * 1.15, 0.45, rate), Math.trunc(t0 * SR));
      add(thump(0.14, f0, 0.5, rate * 1.15, 0.8), Math.trunc((t0 + gap) * SR));
    }
  } else if (style === 'breath') {
    // in/out air cycles; the one-pole cutoff sets how open the mouth sounds
    const mode = rng.choice(['calm', 'heavy', 'winded']);
    const lf = new Lfsr(rng, 1);
    let gusts;
    let a;
    if (mode === 'calm') {
      gusts = 2;
      a = rng.uniform(0.03, 0.055);
      const inh = rng.uniform(0.5, 0.75);
      const pause = rng.uniform(0.08, 0.16);
      add(gust(inh, a * 0.6, a, 0.9, lf, 1.3), 0);
      add(gust(rng.uniform(0.65, 0.95), a, a * 0.4, 0.7, lf, 1.5), Math.trunc((inh + pause) * SR));
    } else if (mode === 'heavy') {
      gusts = 2;
      a = rng.uniform(0.07, 0.13);
      const inh = rng.uniform(0.35, 0.5);
      const pause = rng.uniform(0.05, 0.1);
      add(gust(inh, a * 0.5, a * 1.2, 1.0, lf, 0.8), 0);
      add(gust(rng.uniform(0.45, 0.65), a, a * 0.35, 0.85, lf, 1.0), Math.trunc((inh + pause) * SR));
    } else {
      // winded: quick alternating puffs, in bright, out duller
      gusts = rng.randint(3, 5);
      a = rng.uniform(0.12, 0.22);
      const puff = rng.uniform(0.15, 0.22);
      const gap = rng.uniform(0.05, 0.11);
      let pos = 0;
      for (let k = 0; k < gusts; k++) {
        const inhale = k % 2 === 0;
        add(gust(puff, a * (inhale ? 1.1 : 0.6), a * (inhale ? 0.5 : 0.3),
          inhale ? 1.0 : 0.75, lf, 0.7), pos);
        pos += Math.trunc((puff + gap) * SR);
      }
    }
    const airHz = onePoleHz(a);
    rng.tags = {
      style: 'breath', mode, gusts,
      air_hz: airHz, tone: airHz >= 400 ? 'bright' : 'dark',
    };
  } else if (style === 'sneeze') {
    // soft rising wind-up, then an explosive bright burst over a chest thump
    const lf = new Lfsr(rng, 1);
    const wind = rng.uniform(0.12, 0.3);
    const burst = rng.uniform(0.16, 0.3);
    const ab = rng.uniform(0.18, 0.34);
    const dk = rng.uniform(7.0, 11.0);
    const kick = rng.uniform(0.3, 0.7);
    rng.tags = {
      style: 'sneeze',
      buildup: wind > 0.21 ? 'long' : 'short',
      burst_hz: onePoleHz(ab),
      kick: kick > 0.5 ? 'chesty' : 'airy',
    };
    add(gust(wind, 0.02, 0.1, 0.4, lf, 1.2), 0);
    const p = Math.trunc(wind * SR);
    add(thump(0.09, rng.uniform(70.0, 110.0), 0.4, 9.0, kick), p);
    add(bark(burst, ab, ab * 0.25, 1.0, dk, lf), p);
  } else if (style === 'cough') {
    // noise barks over a chest thud; chesty adds a slow amplitude rattle
    const kind = rng.choice(['dry', 'dry', 'chesty']);
    const barks = rng.choice([1, 2, 2, 3]);
    const lf = new Lfsr(rng, rng.choice([1, 2]));
    const grit = lf.period === 2 ? 'coarse' : 'fine';
    let pos = 0;
    if (kind === 'dry') {
      const fthud = rng.uniform(85.0, 130.0);
      rng.tags = {
        style: 'cough', kind, barks,
        thud_hz: rnd(fthud), grit,
      };
      for (let b = 0; b < barks; b++) {
        const d = rng.uniform(0.09, 0.16);
        add(thump(0.07, fthud, 0.5, 10.0, 0.55), pos);
        add(bark(d, rng.uniform(0.16, 0.28), 0.05, 1.0, rng.uniform(7.0, 10.0), lf), pos);
        pos += Math.trunc((d + rng.uniform(0.09, 0.18)) * SR);
      }
    } else {
      const rat = rng.uniform(24.0, 44.0);
      rng.tags = {
        style: 'cough', kind, barks,
        rattle_hz: rnd(rat), grit,
      };
      for (let b = 0; b < barks; b++) {
        const d = rng.uniform(0.16, 0.28);
        add(thump(0.09, rng.uniform(65.0, 100.0), 0.45, 8.0, 0.7), pos);
        add(bark(d, rng.uniform(0.07, 0.12), 0.03, 1.0, rng.uniform(4.5, 6.5), lf, rat, 0.7), pos);
        pos += Math.trunc((d + rng.uniform(0.1, 0.2)) * SR);
      }
    }
  } else if (style === 'snore') {
    // one cycle: long rattly drag in (gated dark noise), soft puff out
    const rat = rng.uniform(15.0, 27.0);
    const inh = rng.uniform(0.7, 1.05);
    const pause = rng.uniform(0.1, 0.2);
    const a = rng.uniform(0.035, 0.08);
    const lf = new Lfsr(rng, rng.choice([1, 2, 3]));
    const puffed = rng.random() < 0.75;
    rng.tags = {
      style: 'snore', rattle_hz: rnd(rat),
      air_hz: onePoleHz(a),
      depth: rat < 20.0 ? 'deep' : 'light',
      exhale: puffed ? 'puffed' : 'held',
    };
    add(gust(inh, a * 0.7, a * 1.3, 1.0, lf, 0.9, rat, 0.85), 0);
    if (puffed) {
      add(gust(rng.uniform(0.35, 0.6), a * 1.2, a * 0.5, 0.45, lf, 1.4),
        Math.trunc((inh + pause) * SR));
    }
  } else if (style === 'yawn') {
    // airflow swells to a crest then relaxes; a faint undertone sags with it
    const dur = rng.uniform(1.0, 1.7);
    const crest = rng.uniform(0.35, 0.6);
    const peakA = rng.uniform(0.05, 0.12);
    const fall = rng.uniform(0.5, 1.2);
    const f0 = rng.uniform(150.0, 240.0);
    const under = rng.uniform(0.1, 0.22);
    const lf = new Lfsr(rng, 1);
    rng.tags = {
      style: 'yawn', fall_oct: Number(fall.toFixed(1)),
      sag_hz: rnd(f0),
      air: peakA > 0.085 ? 'breathy' : 'hollow',
      crest: crest < 0.47 ? 'early' : 'late',
    };
    const n = Math.trunc(SR * dur);
    let y = 0.0;
    let ph = 0.0;
    const buf = [];
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const w = u < crest ? u / crest : (1.0 - u) / (1.0 - crest);
      y += (0.015 + peakA * w * w) * (lf.next() - y);
      ph += (f0 * Math.pow(2.0, -fall * u)) / SR;
      buf.push((y + triangle(ph) * under * w) * Math.pow(w, 0.7));
    }
    add(buf, 0);
  } else if (style === 'gulp') {
    // two falling glugs and a throat thump; optional dry tick up front
    const f0 = rng.uniform(210.0, 340.0);
    const ticked = rng.random() < 0.6;
    const lf = new Lfsr(rng, 1);
    rng.tags = {
      style: 'gulp', start_hz: rnd(f0),
      size: f0 < 270.0 ? 'big' : 'small',
      onset: ticked ? 'ticked' : 'clean',
    };
    if (ticked) add(bark(0.02, 0.5, 0.2, 0.5, 6.0, lf), 0);
    let pos = Math.trunc(rng.uniform(0.015, 0.04) * SR);
    add(glug(rng.uniform(0.05, 0.08), f0, f0 * 0.45, 0.9), pos);
    pos += Math.trunc(rng.uniform(0.07, 0.12) * SR);
    add(glug(rng.uniform(0.07, 0.11), f0 * 0.7, f0 * 0.28, 1.0), pos);
    add(thump(0.08, rng.uniform(60.0, 90.0), 0.5, 8.0, 0.5), pos + Math.trunc(0.02 * SR));
  } else if (style === 'chew') {
    // jaw thud + crunch per bite; slow sample-and-hold noise = crunchier
    const bites = rng.randint(2, 5);
    const period = rng.choice([4, 6, 10, 14]);
    const lf = new Lfsr(rng, period);
    const step = rng.uniform(0.16, 0.28);
    rng.tags = {
      style: 'chew', bites,
      gap_ms: rnd(step * 1000),
      texture: period <= 6 ? 'crunchy' : 'soft',
      pace: step < 0.21 ? 'brisk' : 'lazy',
    };
    let pos = 0;
    for (let b = 0; b < bites; b++) {
      add(thump(0.05, rng.uniform(90.0, 140.0), 0.5, 9.0, 0.6), pos);
      add(bark(rng.uniform(0.05, 0.09), 0.3, 0.08, rng.uniform(0.75, 1.0), 5.0, lf), pos);
      pos += Math.trunc(step * rng.uniform(0.85, 1.15) * SR);
    }
  } else if (style === 'clap') {
    // one tight bright burst, optionally answered by a small slapback
    const d = rng.uniform(0.03, 0.06);
    const lf = new Lfsr(rng, rng.choice([1, 1, 2]));
    const a0 = rng.uniform(0.3, 0.55);
    const echo = rng.random() < 0.5;
    rng.tags = {
      style: 'clap', burst_ms: rnd(d * 1000),
      grit: lf.period === 1 ? 'tight' : 'gritty',
      room: echo ? 'slapback' : 'dry',
    };
    add(bark(d, a0, a0 * 0.4, 1.0, 6.0, lf), 0);
    if (echo) {
      const tail = bark(d * 0.9, a0 * 0.7, a0 * 0.3, 0.35, 6.0, lf);
      add(tail, Math.trunc(rng.uniform(0.055, 0.09) * SR));
    }
  } else if (style === 'applause') {
    // many tiny claps scattered over the window, density shaping the arc
    const dur = rng.uniform(1.2, 1.9);
    const claps = rng.randint(14, 34);
    const arc = rng.choice(['building', 'fading', 'steady']);
    const lf = new Lfsr(rng, 1);
    rng.tags = {
      style: 'applause', claps, arc,
      crowd: claps >= 24 ? 'thick' : 'sparse',
    };
    for (let c = 0; c < claps; c++) {
      let r = rng.random();
      if (arc === 'building') r = Math.pow(r, 0.55);
      else if (arc === 'fading') r = Math.pow(r, 1.8);
      const a0 = rng.uniform(0.25, 0.5);
      const hit = bark(rng.uniform(0.018, 0.035), a0, a0 * 0.5, rng.uniform(0.4, 1.0), 5.0, lf);
      add(hit, Math.trunc(r * (dur - 0.06) * SR));
    }
  } else if (style === 'snap') {
    // skin click then a narrow triangle ping — the knuckle resonance
    const fp = rng.uniform(1500.0, 3200.0);
    const pd = rng.uniform(0.04, 0.08);
    const lf = new Lfsr(rng, 1);
    rng.tags = {
      style: 'snap', ping_hz: rnd(fp),
      tone: fp > 2300.0 ? 'glassy' : 'woody',
      tail: pd > 0.06 ? 'ringing' : 'tight',
    };
    add(bark(0.012, 0.6, 0.3, 0.8, 4.0, lf), 0);
    const n = Math.trunc(SR * pd);
    let ph = 0.0;
    const buf = [];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const u = i / n;
      ph += fp / SR;
      buf.push(triangle(ph) * Math.min(1.0, t / 0.001) * Math.exp(-7.0 * u) * 0.9);
    }
    add(buf, Math.trunc(0.004 * SR));
  } else if (style === 'shiver') {
    // teeth chatter: jittered tick train, upper/lower teeth alternating
    const rate = rng.uniform(13.0, 24.0);
    const dur = rng.uniform(0.5, 1.1);
    const lf = new Lfsr(rng, rng.choice([1, 2]));
    let t0 = 0.0;
    let k = 0;
    while (t0 < dur) {
      const a0 = k % 2 === 0 ? 0.5 : 0.28;
      const amp = (0.55 + 0.45 * Math.sin((Math.PI * t0) / dur)) * rng.uniform(0.7, 1.0);
      add(bark(rng.uniform(0.006, 0.012), a0, a0 * 0.6, amp, 3.0, lf), Math.trunc(t0 * SR));
      t0 += rng.uniform(0.85, 1.15) / rate;
      k += 1;
    }
    rng.tags = {
      style: 'shiver', rate_hz: rnd(rate), ticks: k,
      tremble: rate > 18.5 ? 'violent' : 'mild',
      grit: lf.period === 1 ? 'icy' : 'bony',
    };
  } else {
    // stomach growl: wandering low triangle with sample-and-hold pitch wobble,
    // crackle bed, and a few rising glug bubbles working their way up
    const dur = rng.uniform(0.9, 1.7);
    const f0 = rng.uniform(42.0, 88.0);
    const bubbles = rng.randint(2, 5);
    const crackle = new Lfsr(rng, rng.randint(10, 16));
    const hold = Math.trunc(SR * rng.uniform(0.05, 0.12));
    rng.tags = {
      style: 'growl', base_hz: rnd(f0),
      bubbles,
      mood: f0 >= 62.0 ? 'hungry' : 'queasy',
    };
    const n = Math.trunc(SR * dur);
    let ph = 0.0;
    let w = 0.0;
    let wt = 0.0;
    const buf = [];
    for (let i = 0; i < n; i++) {
      const u = i / n;
      if (i % hold === 0) wt = rng.uniform(-1.0, 1.0);
      w += (wt - w) * 0.0015;
      ph += (f0 * (1.0 + 0.3 * w)) / SR;
      const env = Math.min(1.0, u / 0.12) * Math.min(1.0, (1.0 - u) / 0.18);
      buf.push((triangle(ph) * 0.85 + crackle.next() * 0.2) * env);
    }
    add(buf, 0);
    for (let b = 0; b < bubbles; b++) {
      const t0 = rng.uniform(0.1, dur - 0.15);
      const fb = rng.uniform(120.0, 260.0);
      const m = Math.trunc(SR * rng.uniform(0.04, 0.07));
      let ph2 = 0.0;
      const bb = [];
      for (let i = 0; i < m; i++) {
        const uu = i / m;
        ph2 += (fb * (1.0 + 0.9 * uu)) / SR;
        bb.push(triangle(ph2) * Math.sin(Math.PI * uu) * 0.5);
      }
      add(bb, Math.trunc(t0 * SR));
    }
  }

  // shared finish: pad/clamp to 0.12-2.0 s, DC-block, de-click, normalize
  if (out.length === 0) out.push(0.0);
  const nMin = Math.trunc(SR * 0.12);
  const nMax = Math.trunc(SR * 2.0);
  if (out.length < nMin) {
    while (out.length < nMin) out.push(0.0);
  } else if (out.length > nMax) {
    out.length = nMax;
  }
  dcBlock(out, 0.997); // hand-rolled one-pole DC blocker (~10 Hz corner)
  const fi = Math.min(Math.floor(out.length / 2), Math.trunc(SR * 0.002));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  const fo = Math.min(Math.floor(out.length / 2), Math.trunc(SR * 0.012));
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  let peak = 0.0;
  for (const v of out) {
    const a = v < 0.0 ? -v : v;
    if (a > peak) peak = a;
  }
  if (peak > 1e-9) {
    const g = rng.uniform(0.7, 0.92) / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}

const str = (v, fallback) => (typeof v === 'string' && v ? v : fallback);
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const oct = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toFixed(1);
const plural = (v) => (int(v) === 1 ? '' : 's');

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  switch (t.style) {
    case 'heartbeat':
      return `heartbeat lub-dub — ${str(t.depth, 'deep')} ${int(t.thump_hz)} Hz thump, ${int(t.beats)} beat${plural(t.beats)} at ${int(t.bpm)} bpm`;
    case 'breath':
      return `${str(t.mode, 'calm')} breathing — ${int(t.gusts)} gusts of ${str(t.tone, 'dark')} ${int(t.air_hz)} Hz chip air`;
    case 'sneeze':
      return `chip sneeze — ${str(t.buildup, 'short')} wind-up into a ${int(t.burst_hz)} Hz noise burst, ${str(t.kick, 'airy')} kick`;
    case 'cough':
      if (t.kind === 'chesty') {
        return `chesty cough — ${int(t.barks)} bark${plural(t.barks)} rattling at ${int(t.rattle_hz)} Hz, ${str(t.grit, 'fine')} phlegmy grit`;
      }
      return `dry cough — ${int(t.barks)} sharp bark${plural(t.barks)} over a ${int(t.thud_hz)} Hz chest thud, ${str(t.grit, 'fine')} grit`;
    case 'snore':
      return `snore cycle — ${str(t.depth, 'deep')} ${int(t.rattle_hz)} Hz rattle over ${int(t.air_hz)} Hz air, ${str(t.exhale, 'held')} exhale`;
    case 'yawn':
      return `stretching yawn — ${str(t.air, 'hollow')} swell cresting ${str(t.crest, 'early')}, ${int(t.sag_hz)} Hz airflow falling ${oct(t.fall_oct)} octaves`;
    case 'gulp':
      return `gulp swallow — ${str(t.size, 'big')} glug dropping from ${int(t.start_hz)} Hz, ${str(t.onset, 'clean')} onset`;
    case 'chew':
      return `chewing — ${int(t.bites)} ${str(t.texture, 'soft')} bite${plural(t.bites)} at a ${str(t.pace, 'lazy')} ${int(t.gap_ms)} ms munch`;
    case 'clap':
      return `single clap — ${int(t.burst_ms)} ms ${str(t.grit, 'tight')} burst, ${str(t.room, 'dry')} room`;
    case 'applause':
      return `applause patter — ${int(t.claps)} scattered claps, ${str(t.arc, 'steady')} arc, ${str(t.crowd, 'sparse')} crowd`;
    case 'snap':
      return `finger snap — ${str(t.tone, 'woody')} ${int(t.ping_hz)} Hz ping over a dry click, ${str(t.tail, 'tight')} tail`;
    case 'shiver':
      return `teeth-chatter shiver — ${int(t.rate_hz)} Hz train of ${int(t.ticks)} ${str(t.grit, 'icy')} ticks, ${str(t.tremble, 'mild')} tremble`;
    default:
      return `stomach growl — ${str(t.mood, 'hungry')} ${int(t.base_hz)} Hz rumble with ${int(t.bubbles)} bubble${plural(t.bubbles)} rising`;
  }
}

/** Short phrase for the README category table. */
export const character = 'heartbeats, breaths, sneezes, snores, claps, gut growls';
