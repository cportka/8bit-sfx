// cymbal — the loud, long end of the chip drum kit. Every variation is built
// from two ingredients: dense LFSR noise (two sample-and-held streams summed,
// because one alone is too sparse to read as a wobbling metal disc) and a stack
// of square/triangle partials at deliberately inharmonic ratios — the 808's
// trick for faking struck metal, widened to nine partials so a crash has
// somewhere to shimmer. Hand-rolled one-poles do the rest, and the important
// one is a highpass that *closes* as the tail decays: real cymbals get darker
// while they ring, and a static filter is the tell that a crash is synthetic.
//
// The family splits by envelope and filter, not by source. A two-stage decay
// over a couple of seconds is a crash; a quiet wash with a hard pitched attack
// on top is a ride; tonal partials each decaying at their own rate are the
// bell; a short bright burst is a splash; a wide-detuned cluster sagging in
// pitch is a china; a hard gate mid-tail is a choke; a rising envelope with an
// opening filter is the reverse swell before a downbeat.
//
// Anything with an oscillator core reports the MIDI note it was built on —
// cymbals get stacked under basslines and a clanging partial stack in the wrong
// key is audible. The rivet and roll styles report a rate in Hz instead, which
// is the honest number for them.
//
// Post-processing is uniform: DC block (narrow-duty square stacks carry a
// bias), a sub-millisecond fade at the front so the stick attack stays sharp, a
// proportional taper at the tail, then peak-normalize last.

import { SR, Lfsr, square, triangle, midi, noteName, renderTone, finish, mixAt, dcBlock } from '../dsp.js';

/** Nine inharmonic partials — the 808 metal ratios, extended upward for wash. */
const CRASH_RATIOS = [1.0, 1.4471, 1.617, 1.9265, 2.5028, 2.6637, 3.2277, 3.9312, 4.5623];

/** Ride-bell partials: tonal enough to carry a pitch, with a clang on top. */
const BELL_RATIOS = [1.0, 1.5023, 2.0, 2.6713, 3.4207, 4.6091];

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
    'crash', 'ride', 'bell', 'splash', 'china', 'choke', 'wash', 'reverse', 'sizzle', 'crushed',
  ]);

  const secs = (s) => Math.max(1, Math.round(s * SR));

  // Two LFSRs at different hold rates, summed, then lowpass -> highpass. Either
  // coefficient may be a function of t so a filter can open or close across the
  // decay; that sweep is most of what separates a crash from a splash.
  const noiseBed = (n, periods, envFn, hpA, lpA = 0) => {
    const srcs = [];
    for (let k = 0; k < periods.length; k++) srcs.push(new Lfsr(rng, periods[k]));
    const g = 1.0 / srcs.length;
    const hpSweep = typeof hpA === 'function';
    const lpSweep = typeof lpA === 'function';
    const out = new Array(n);
    let lpS = 0.0;
    let hpS = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let x = 0.0;
      for (let k = 0; k < srcs.length; k++) x += srcs[k].next();
      x *= g;
      const la = lpSweep ? lpA(t) : lpA;
      if (la > 0) {
        lpS += la * (x - lpS);
        x = lpS;
      }
      const ha = hpSweep ? hpA(t) : hpA;
      if (ha > 0) {
        hpS += ha * (x - hpS);
        x -= hpS;
      }
      out[i] = x * envFn(t);
    }
    return out;
  };

  // Inharmonic oscillator stack sharing one envelope — struck metal, chip-style.
  // `baseHz` may be a function of t so a china can sag in pitch as it rings.
  const metalStack = (n, baseHz, ratios, duty, envFn, hpA, wave = null) => {
    const bend = typeof baseHz === 'function';
    const out = new Array(n);
    const ph = new Array(ratios.length).fill(0.0);
    const g = 1.0 / ratios.length;
    let hpS = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = bend ? baseHz(t) : baseHz;
      let s = 0.0;
      for (let k = 0; k < ratios.length; k++) {
        ph[k] += (f * ratios[k]) / SR;
        s += wave === 'tri' ? triangle(ph[k]) : square(ph[k], duty);
      }
      s *= g;
      hpS += hpA * (s - hpS);
      out[i] = (s - hpS) * envFn(t);
    }
    return out;
  };

  // The same stack, but every partial gets its own decay rate. High partials
  // dying first is what makes a bell read as a bell instead of a chord.
  const partialRing = (n, baseHz, ratios, rates, atk, duty, wave = null) => {
    const out = new Array(n);
    const ph = new Array(ratios.length).fill(0.0);
    const g = 1.0 / ratios.length;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let s = 0.0;
      for (let k = 0; k < ratios.length; k++) {
        ph[k] += (baseHz * ratios[k]) / SR;
        const w = wave === 'tri' ? triangle(ph[k]) : square(ph[k], duty);
        s += w * Math.exp(-rates[k] * t);
      }
      out[i] = s * g * Math.min(1.0, t / atk);
    }
    return out;
  };

  /** The stick landing: a couple of milliseconds of very bright noise. */
  const stickTick = (dur, hpA, rate) =>
    noiseBed(secs(dur), [1], (t) => Math.exp(-rate * t), hpA);

  /** Detune the ratio table — small spread shimmers, large spread clangs. */
  const spreadRatios = (ratios, spread) => ratios.map((r, k) => r * (1 + spread * (k % 2 ? 1 : -1)));

  const brightWord = (a) => (a > 0.6 ? 'brilliant' : a > 0.38 ? 'bright' : a > 0.2 ? 'warm' : 'dark');

  let out;
  let tags;

  if (style === 'crash') {
    // full crash: a fast bloom into a long wash, with the highpass closing down
    // across the tail so the cymbal darkens as it dies
    const dur = rng.uniform(0.8, 2.3);
    const n = secs(dur);
    const m = rng.randint(69, 88); // A4..E6 metal core
    const spread = rng.uniform(0.0, 0.05);
    const ratios = spreadRatios(CRASH_RATIOS, spread);
    const atk = rng.uniform(0.0005, 0.0024);
    const fast = rng.uniform(12.0, 30.0);
    const slow = rng.uniform(2.4, 4.8) / dur;
    const mix = rng.uniform(0.3, 0.65);
    const hp0 = rng.uniform(0.35, 0.8);
    const hp1 = rng.uniform(0.08, 0.28);
    const env = (t) =>
      Math.min(1.0, t / atk) * (mix * Math.exp(-fast * t) + (1 - mix) * Math.exp(-slow * t));
    out = noiseBed(n, [1, rng.randint(2, 3)], env, (t) => hp0 + (hp1 - hp0) * Math.min(1.0, t / dur));
    const metalG = rng.uniform(0.2, 0.85);
    const metalRate = slow * rng.uniform(0.85, 1.4);
    mixAt(
      out,
      metalStack(
        n,
        midi(m),
        ratios,
        rng.choice([0.5, 0.5, 0.44]),
        (t) => Math.min(1.0, t / atk) * Math.exp(-metalRate * t),
        Math.min(0.9, hp0)
      ),
      0,
      metalG
    );
    tags = {
      style: 'crash',
      size: dur > 1.6 ? 'wide' : 'compact',
      tone: spread > 0.025 ? 'clangy' : 'shimmering',
      body: metalG > 0.5 ? 'metal-heavy' : 'air-heavy',
      decay_ms: r1(1000 / slow),
      note: noteName(m),
    };
  } else if (style === 'ride') {
    // ride: the ping carries the pitch and the wash sits underneath it, quiet
    // and long — the cymbal you can play a whole bar of eighths on
    const dur = rng.uniform(1.0, 2.4);
    const n = secs(dur);
    const m = rng.randint(74, 91); // D5..G6 ping
    const pingRatios = [1.0, 1.502, 2.01, 2.72, 3.46];
    const pingDur = rng.uniform(0.09, 0.34);
    const pingRate = rng.uniform(4.5, 9.0) / pingDur;
    const rates = pingRatios.map((_, k) => pingRate * (1 + 0.3 * k));
    const duty = rng.choice([0.5, 0.5, 0.42, 0.34]);
    const wave = rng.choice([null, null, 'tri']);
    const washSlow = rng.uniform(2.2, 4.2) / dur;
    const washHp = rng.uniform(0.28, 0.72);
    const depth = rng.uniform(0.0, 0.34);
    const tremHz = rng.uniform(3.5, 12.0);
    out = noiseBed(
      n,
      [1, 2],
      (t) =>
        Math.min(1.0, t / 0.001) *
        Math.exp(-washSlow * t) *
        (1 - depth * 0.5 * (1 - Math.cos(2 * Math.PI * tremHz * t))),
      washHp
    );
    const pingG = rng.uniform(0.9, 2.2);
    mixAt(
      out,
      partialRing(secs(pingDur), midi(m), pingRatios, rates, rng.uniform(0.0003, 0.0013), duty, wave),
      0,
      pingG
    );
    const stickG = rng.uniform(0.05, 0.5);
    mixAt(out, stickTick(0.012, rng.uniform(0.6, 0.9), rng.uniform(240.0, 600.0)), 0, stickG);
    tags = {
      style: 'ride',
      ping: wave === 'tri' ? 'woody' : duty > 0.45 ? 'glassy' : 'nasal',
      wash: depth > 0.15 ? 'breathing' : 'sustained',
      stick: stickG > 0.28 ? 'defined' : 'soft',
      ping_ms: r1(1000 / pingRate),
      note: noteName(m),
    };
  } else if (style === 'bell') {
    // ride bell: tonal partials, each with its own decay rate, plus a hard stick
    // tick — the most pitched member of the family, so keep it in tune
    const dur = rng.uniform(0.7, 2.1);
    const n = secs(dur);
    const m = rng.randint(70, 88); // A#4..E6
    const detune = rng.uniform(0.0, 0.013);
    const ratios = spreadRatios(BELL_RATIOS, detune);
    const rate0 = rng.uniform(2.0, 4.5) / dur;
    const tilt = rng.uniform(0.15, 0.62);
    const rates = ratios.map((_, k) => rate0 * (1 + tilt * k));
    const wave = rng.choice([null, 'tri', 'tri']);
    const duty = rng.choice([0.5, 0.5, 0.45, 0.3]);
    out = partialRing(n, midi(m), ratios, rates, rng.uniform(0.0003, 0.0016), duty, wave);
    const tickG = rng.uniform(0.05, 0.5);
    mixAt(out, stickTick(0.02, rng.uniform(0.55, 0.9), rng.uniform(180.0, 420.0)), 0, tickG);
    const airG = rng.uniform(0.0, 0.3);
    const airy = airG > 0.12;
    if (airy) {
      mixAt(out, noiseBed(n, [1, 3], (t) => Math.exp(-rate0 * 1.6 * t), rng.uniform(0.5, 0.85)), 0, airG);
    }
    tags = {
      style: 'bell',
      ring: detune > 0.006 ? 'clangy' : 'pure',
      voice: wave === 'tri' ? 'round' : 'reedy',
      strike: tickG > 0.28 ? 'hard' : 'soft',
      decay_ms: r1(1000 / rate0),
      note: noteName(m),
    };
  } else if (style === 'splash') {
    // splash: small, very bright, and gone — a crash envelope compressed into a
    // few hundred milliseconds with the filter parked wide open
    const dur = rng.uniform(0.3, 0.8);
    const n = secs(dur);
    const m = rng.randint(83, 100); // B5..E7 thin disc
    const hp = rng.uniform(0.45, 0.9);
    const atk = rng.uniform(0.0002, 0.0012);
    const fast = rng.uniform(24.0, 60.0);
    const slow = rng.uniform(5.0, 11.0) / dur;
    const mix = rng.uniform(0.35, 0.72);
    const flutterHz = rng.uniform(30.0, 150.0);
    const depth = rng.uniform(0.0, 0.4);
    const fluttering = depth > 0.13;
    const env = (t) =>
      Math.min(1.0, t / atk) *
      (mix * Math.exp(-fast * t) + (1 - mix) * Math.exp(-slow * t)) *
      (fluttering ? 1.0 - depth * 0.5 * (1 - Math.cos(2 * Math.PI * flutterHz * t)) : 1.0);
    out = noiseBed(n, [1, rng.randint(1, 2)], env, hp);
    const metalG = rng.uniform(0.15, 0.75);
    const topped = metalG > 0.4;
    mixAt(
      out,
      metalStack(
        n,
        midi(m),
        spreadRatios(CRASH_RATIOS.slice(0, 6), rng.uniform(0.0, 0.04)),
        0.5,
        (t) => Math.min(1.0, t / atk) * Math.exp(-slow * 1.25 * t),
        Math.min(0.92, hp)
      ),
      0,
      metalG
    );
    tags = {
      style: 'splash',
      bite: hp > 0.7 ? 'piercing' : 'biting',
      motion: fluttering ? 'fluttering' : 'even',
      top: topped ? 'glassy' : 'airy',
      edge_hz: cornerHz(hp),
      note: noteName(m),
    };
  } else if (style === 'china') {
    // china: trash. Wide detune so the partials fight, a downward pitch sag like
    // a gong, a mid-band noise scrape and an optional low triangle body
    const dur = rng.uniform(0.55, 1.8);
    const n = secs(dur);
    const m = rng.randint(60, 79); // C4..G5 — lower and nastier than a crash
    const base = midi(m);
    const sag = rng.uniform(0.02, 0.16);
    const spread = rng.uniform(0.03, 0.12);
    const ratios = spreadRatios(CRASH_RATIOS, spread);
    const duty = rng.choice([0.5, 0.36, 0.28, 0.2]);
    const atk = rng.uniform(0.0004, 0.002);
    const rate = rng.uniform(3.0, 6.5) / dur;
    const hp = rng.uniform(0.2, 0.6);
    const lp = rng.uniform(0.25, 0.7);
    const bendFn = (t) => base * (1 - sag * Math.min(1.0, t / dur));
    out = metalStack(
      n,
      bendFn,
      ratios,
      duty,
      (t) => Math.min(1.0, t / atk) * Math.exp(-rate * t),
      hp
    );
    const scrapeG = rng.uniform(0.3, 1.1);
    mixAt(
      out,
      noiseBed(n, [1, rng.randint(2, 4)], (t) => Math.min(1.0, t / atk) * Math.exp(-rate * 1.15 * t), hp, lp),
      0,
      scrapeG
    );
    const bodyG = rng.uniform(0.0, 0.45);
    const gongy = bodyG > 0.18;
    if (gongy) {
      mixAt(
        out,
        renderTone(n, (t) => bendFn(t) * 0.5, 0.5, (t) => Math.min(1.0, t / 0.003) * Math.exp(-rate * 0.8 * t), 'tri'),
        0,
        bodyG
      );
    }
    tags = {
      style: 'china',
      trash: spread > 0.07 ? 'shredded' : 'papery',
      body: gongy ? 'gong-backed' : 'all edge',
      shape: duty > 0.4 ? 'hollow' : 'thin',
      sag_hz: Math.round(base * sag),
      note: noteName(m),
    };
  } else if (style === 'choke') {
    // choked hit: a crash cut off by a hand on the bow. The grab is never
    // perfect, so a quiet damped hum keeps ringing under the clamp
    const openFor = rng.uniform(0.05, 0.42);
    const rel = rng.uniform(0.004, 0.03);
    const hum = rng.uniform(0.28, 0.7);
    const dur = openFor + rel + hum;
    const n = secs(dur);
    const bright = rng.random() < 0.5;
    const m = bright ? rng.randint(80, 96) : rng.randint(68, 84);
    const hp = bright ? rng.uniform(0.5, 0.88) : rng.uniform(0.3, 0.65);
    const atk = rng.uniform(0.0003, 0.0016);
    const fast = rng.uniform(14.0, 34.0);
    const slow = rng.uniform(3.0, 6.0) / dur;
    const mix = rng.uniform(0.35, 0.7);
    const floor = rng.uniform(0.03, 0.13);
    const humRate = rng.uniform(3.5, 8.0) / hum;
    const gate = (t) => {
      if (t < openFor) return 1.0;
      if (t < openFor + rel) return 1.0 - (1.0 - floor) * ((t - openFor) / rel);
      return floor * Math.exp(-humRate * (t - openFor - rel));
    };
    const env = (t) =>
      Math.min(1.0, t / atk) * (mix * Math.exp(-fast * t) + (1 - mix) * Math.exp(-slow * t)) * gate(t);
    out = noiseBed(n, [1, rng.randint(2, 3)], env, hp);
    const metalG = rng.uniform(0.2, 0.8);
    mixAt(
      out,
      metalStack(n, midi(m), spreadRatios(CRASH_RATIOS, rng.uniform(0.0, 0.045)), 0.5, env, Math.min(0.9, hp)),
      0,
      metalG
    );
    tags = {
      style: 'choke',
      hit: bright ? 'splash' : 'crash',
      grab: floor > 0.08 ? 'loose grab' : 'hard grab',
      release: rel > 0.016 ? 'smothered' : 'clamped',
      choke_ms: r1(openFor * 1000),
      note: noteName(m),
    };
  } else if (style === 'wash') {
    // long wash: either a mallet roll — repeated soft hits crescendoing into one
    // another — or a single continuous swell with the filter opening under it
    const rolled = rng.random() < 0.5;
    const m = rng.randint(66, 86);
    if (rolled) {
      const count = rng.randint(4, 9);
      const gap0 = rng.uniform(0.085, 0.2);
      const accel = rng.uniform(0.78, 1.03);
      const hitDur = rng.uniform(0.3, 0.8);
      const rising = rng.random() < 0.65;
      const hpA = rng.uniform(0.25, 0.7);
      const rate = rng.uniform(4.0, 9.0) / hitDur;
      const period2 = rng.randint(2, 3);
      const pos = [];
      let p = 0.0;
      let gap = gap0;
      for (let k = 0; k < count; k++) {
        pos.push(p);
        p += gap;
        gap *= accel;
      }
      out = [];
      for (let k = 0; k < count; k++) {
        const frac = count > 1 ? k / (count - 1) : 1.0;
        const g = rising ? 0.32 + 0.68 * frac : 1.0 - 0.6 * frac;
        mixAt(
          out,
          noiseBed(secs(hitDur), [1, period2], (t) => Math.min(1.0, t / 0.0007) * Math.exp(-rate * t), hpA),
          secs(pos[k]),
          g
        );
      }
      const ringRate = rng.uniform(1.2, 3.0);
      const metalG = rng.uniform(0.1, 0.5);
      mixAt(
        out,
        metalStack(
          out.length,
          midi(m),
          spreadRatios(CRASH_RATIOS, rng.uniform(0.0, 0.04)),
          0.5,
          (t) => Math.min(1.0, t / 0.02) * Math.exp(-ringRate * t),
          Math.min(0.9, hpA + 0.1)
        ),
        0,
        metalG
      );
      tags = {
        style: 'wash',
        pattern: 'rolled',
        motion: rising ? 'crescendo' : 'diminuendo',
        color: brightWord(hpA),
        hits: count,
        pace_ms: r1(gap0 * 1000),
        edge_hz: cornerHz(hpA),
        note: noteName(m),
      };
    } else {
      const dur = rng.uniform(1.2, 2.45);
      const n = secs(dur);
      const crest = rng.uniform(0.5, 0.85) * dur;
      const curve = rng.uniform(1.2, 3.0);
      const fall = rng.uniform(3.0, 8.0) / Math.max(0.05, dur - crest);
      const hp0 = rng.uniform(0.04, 0.2);
      const hp1 = rng.uniform(0.35, 0.85);
      const env = (t) => (t < crest ? Math.pow(t / crest, curve) : Math.exp(-fall * (t - crest)));
      out = noiseBed(n, [1, rng.randint(2, 3)], env, (t) => hp0 + (hp1 - hp0) * Math.min(1.0, t / crest));
      const metalG = rng.uniform(0.1, 0.55);
      mixAt(
        out,
        metalStack(n, midi(m), spreadRatios(CRASH_RATIOS, rng.uniform(0.0, 0.05)), 0.5, env, Math.min(0.9, hp1)),
        0,
        metalG
      );
      tags = {
        style: 'wash',
        pattern: 'swelling',
        motion: curve > 2.1 ? 'steep' : 'gradual',
        color: brightWord(hp1),
        floor_hz: cornerHz(hp0),
        edge_hz: cornerHz(hp1),
        note: noteName(m),
      };
    }
  } else if (style === 'reverse') {
    // reverse swell: level rises, the highpass opens with it, and the swell
    // either lands on a crash or is cut clean — the pickup before a downbeat
    const swell = rng.uniform(0.35, 1.55);
    const tail = rng.uniform(0.06, 0.5);
    const dur = swell + tail;
    const n = secs(dur);
    const m = rng.randint(70, 90);
    const curve = rng.uniform(1.3, 3.6);
    const hp0 = rng.uniform(0.04, 0.22);
    const hp1 = rng.uniform(0.4, 0.88);
    const tailRate = rng.uniform(4.0, 10.0) / tail;
    const backwards = rng.random() < 0.55;
    out = noiseBed(
      n,
      [1, rng.randint(2, 3)],
      (t) => (t < swell ? Math.pow(t / swell, curve) : Math.exp(-tailRate * (t - swell))),
      (t) => hp0 + (hp1 - hp0) * Math.min(1.0, t / swell)
    );
    const riseG = rng.uniform(0.1, 0.5);
    mixAt(
      out,
      metalStack(
        secs(swell),
        (t) => midi(m) * (backwards ? 1.0 : 0.85 + 0.15 * (t / swell)),
        spreadRatios(CRASH_RATIOS, rng.uniform(0.0, 0.05)),
        0.5,
        (t) => Math.pow(Math.min(1.0, t / swell), curve),
        Math.min(0.9, hp1)
      ),
      0,
      riseG
    );
    const landG = rng.uniform(0.0, 0.9);
    const landed = landG > 0.3;
    if (landed) {
      mixAt(
        out,
        metalStack(
          Math.max(1, n - secs(swell)),
          midi(m),
          spreadRatios(CRASH_RATIOS, 0.02),
          0.5,
          (t) => Math.min(1.0, t / 0.001) * Math.exp(-tailRate * 0.8 * t),
          Math.min(0.9, hp1)
        ),
        secs(swell),
        landG
      );
    }
    tags = {
      style: 'reverse',
      rise: curve > 2.3 ? 'steep' : 'gradual',
      landing: landed ? 'crash hit' : 'clean cut',
      pitch: backwards ? 'level' : 'lifting',
      edge_hz: cornerHz(hp1),
      note: noteName(m),
    };
  } else if (style === 'sizzle') {
    // sizzle cymbal: rivets in the bow. A bright noise layer is gated by its own
    // slow LFSR, so the rattle is random but locked to a rate you can hear
    const dur = rng.uniform(0.9, 2.3);
    const n = secs(dur);
    const m = rng.randint(68, 86);
    const rivetHz = rng.uniform(18.0, 95.0);
    const period = Math.max(1, Math.round(SR / (2 * rivetHz)));
    const hpA = rng.uniform(0.3, 0.7);
    const slow = rng.uniform(2.2, 4.5) / dur;
    const atk = rng.uniform(0.0006, 0.0025);
    const env = (t) => Math.min(1.0, t / atk) * Math.exp(-slow * t);
    out = noiseBed(n, [1, 2], env, hpA);
    // the rivet layer: bright noise, amplitude sample-and-held by a slow LFSR
    const rivHp = rng.uniform(0.6, 0.92);
    const rivFloor = rng.uniform(0.05, 0.4);
    const rivG = rng.uniform(0.25, 0.9);
    const src = new Lfsr(rng, 1);
    const riv = new Lfsr(rng, period);
    const layer = new Array(n);
    let hpS = 0.0;
    let gSm = 0.0;
    for (let i = 0; i < n; i++) {
      let x = src.next();
      hpS += rivHp * (x - hpS);
      x -= hpS;
      const target = riv.next() > 0 ? 1.0 : rivFloor;
      gSm += 0.2 * (target - gSm);
      layer[i] = x * gSm * env(i / SR);
    }
    mixAt(out, layer, 0, rivG);
    const metalG = rng.uniform(0.1, 0.5);
    mixAt(
      out,
      metalStack(
        n,
        midi(m),
        spreadRatios(CRASH_RATIOS, rng.uniform(0.0, 0.045)),
        0.5,
        (t) => Math.min(1.0, t / atk) * Math.exp(-slow * 1.2 * t),
        Math.min(0.9, hpA)
      ),
      0,
      metalG
    );
    tags = {
      style: 'sizzle',
      rattle: rivG > 0.55 ? 'busy' : 'sparse',
      wash: brightWord(hpA),
      grip: rivFloor > 0.22 ? 'loose rivets' : 'tight rivets',
      rivet_hz: Math.round(SR / (2 * period)),
      note: noteName(m),
    };
  } else {
    // crushed: a crash pushed through a sample-and-hold and a coarse amplitude
    // ladder — the cymbal as a dying 4-bit DAC hears it
    const dur = rng.uniform(0.45, 1.5);
    const n = secs(dur);
    const m = rng.randint(70, 90);
    const hp = rng.uniform(0.25, 0.75);
    const atk = rng.uniform(0.0004, 0.0018);
    const fast = rng.uniform(14.0, 32.0);
    const slow = rng.uniform(3.0, 6.5) / dur;
    const mix = rng.uniform(0.3, 0.65);
    const env = (t) =>
      Math.min(1.0, t / atk) * (mix * Math.exp(-fast * t) + (1 - mix) * Math.exp(-slow * t));
    out = noiseBed(n, [1, rng.randint(2, 3)], env, hp);
    const metalG = rng.uniform(0.25, 0.9);
    mixAt(
      out,
      metalStack(n, midi(m), spreadRatios(CRASH_RATIOS, rng.uniform(0.0, 0.06)), 0.5, env, Math.min(0.9, hp)),
      0,
      metalG
    );
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = out[i] < 0 ? -out[i] : out[i];
      if (a > peak) peak = a;
    }
    if (peak > 1e-9) for (let i = 0; i < n; i++) out[i] /= peak;
    const steps = rng.randint(2, 7);
    const hold = rng.randint(2, 12);
    let held = 0.0;
    for (let i = 0; i < n; i++) {
      if (i % hold === 0) held = out[i];
      out[i] = Math.round(held * steps) / steps;
    }
    tags = {
      style: 'crushed',
      grain: hold > 6 ? 'coarse' : 'fine',
      bite: steps < 4 ? 'brutal' : 'gentle',
      source: brightWord(hp),
      steps,
      crush_hz: Math.round(SR / hold),
      note: noteName(m),
    };
  }

  rng.tags = tags;

  // Hold every cymbal inside 0.3 - 2.5 s, block any square-stack bias, de-click
  // the front with a sub-millisecond ramp (the stick attack IS the sound),
  // taper the tail proportionally, then normalize last.
  const minN = Math.round(0.3 * SR);
  const maxN = Math.round(2.5 * SR);
  if (out.length > maxN) out = out.slice(0, maxN);
  while (out.length < minN) out.push(0.0);
  dcBlock(out);
  const fi = Math.min(out.length >> 3, 8);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.004 * SR), Math.round(0.035 * out.length)));
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
    case 'ride':
      return `ride cymbal — ${t.ping || 'glassy'} ${Number(t.ping_ms || 0).toFixed(1)} ms ping over a ${t.wash || 'sustained'} wash, ${note}`;
    case 'bell':
      return `ride bell — ${t.ring || 'pure'} ${t.voice || 'round'} partials, ${t.strike || 'hard'} strike, ${Number(t.decay_ms || 0).toFixed(1)} ms ring on ${note}`;
    case 'splash':
      return `splash cymbal — ${t.bite || 'biting'} and ${t.motion || 'even'}, ${t.top || 'glassy'} top, ${edge} Hz edge on ${note}`;
    case 'china':
      return `china cymbal — ${t.trash || 'papery'} ${t.shape || 'thin'} trash, ${t.body || 'all edge'}, sags ${t.sag_hz | 0} Hz from ${note}`;
    case 'choke':
      return `choked ${t.hit || 'crash'} — ${t.grab || 'hard grab'}, ${t.release || 'clamped'} at ${Number(t.choke_ms || 0).toFixed(1)} ms, ${note} core`;
    case 'wash':
      return t.pattern === 'rolled'
        ? `rolled cymbal wash — ${t.motion || 'crescendo'}, ${t.hits | 0} hits ${Number(t.pace_ms || 0).toFixed(1)} ms apart, ${note}`
        : `swelling cymbal wash — ${t.motion || 'gradual'} and ${t.color || 'bright'}, filter ${t.floor_hz | 0} to ${edge} Hz`;
    case 'reverse':
      return `reverse cymbal swell — ${t.rise || 'steep'} ${t.pitch || 'level'} rise into a ${t.landing || 'crash hit'}, ${edge} Hz on ${note}`;
    case 'sizzle':
      return `sizzle cymbal — ${t.rattle || 'busy'} ${t.grip || 'tight rivets'} at ${t.rivet_hz | 0} Hz, ${t.wash || 'bright'} wash, ${note}`;
    case 'crushed':
      return `crushed cymbal — ${t.grain || 'coarse'} ${t.bite || 'brutal'} grit, ${t.steps | 0} steps at ${t.crush_hz | 0} Hz, ${note}`;
    default:
      return `crash cymbal — ${t.size || 'wide'} ${t.tone || 'shimmering'} wash, ${t.body || 'air-heavy'}, ${Number(t.decay_ms || 0).toFixed(1)} ms decay on ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'long crashes, pinging rides, ride bells, splashes, chinas, chokes';
