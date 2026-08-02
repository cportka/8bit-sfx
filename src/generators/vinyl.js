// vinyl — the lo-fi shelf: the noise you lay *under* a beat rather than on it.
//
// Everything here is a chip caricature of playback machinery, not a sample. A
// record has no oscillator, so the vocabulary is filters and time:
//
//   surface   sparse decaying LFSR clicks scattered over a dark filtered bed —
//             pop density is the whole difference between "clean pressing" and
//             "thrift-store find"
//   air       one-pole lowpassed noise minus a slower pole: the band between
//             those two corners *is* the tape hiss, and moving the corners is
//             the only tone control the category needs
//   drift     tape can't hold pitch, so every tuned voice rides a slow wow sine
//             plus a fast flutter sine, both measured in cents
//   machinery mains hum as a triangle stack, platter rumble as near-DC noise,
//             bearing whine as a thin vibrato'd tone
//
// Ten sub-styles spend it:
//
//   crackle  a bed: surface pops at 33/45/78 rpm, with the seam thump
//   needle   the stylus arriving, leaving, or skating across the grooves
//   hiss     tape air with dropouts and a faint bias whistle
//   wow      a tuned voice bent by wow and flutter — the pitched centerpiece
//   static   tuning across a dial: swept band, heterodyne squeal, stations
//   dust     a decimated, bit-crushed noise floor — grain you can hear
//   hum      motor hum: harmonic stack over rumble, optional bearing whine
//   rewind   spooling: swept squeal, accelerating reel ticks
//   skip     a locked groove stuttering on a grid, quoted in bpm
//   stop     the power-down (or spin-up): pitch and surface slow together
//
// Post-processing is uniform: DC block (the crackle scatter is not symmetric,
// and a 78 rpm seam thump is nearly subsonic), then normalize with fades long
// enough that a bed can be looped without a seam of its own.

import { SR, Lfsr, midi, noteName, noteOfHz, renderTone, finish, dcBlock } from '../dsp.js';

const MIN_N = Math.round(0.5 * SR);
const MAX_N = Math.round(3.0 * SR);

/** Seconds to samples, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

/** One decimal place, for tag values that read better rounded. */
function r1(x) {
  return Math.round(x * 10) / 10;
}

/** One-pole coefficient to its approximate -3 dB corner, for tag values. */
function poleHz(a) {
  const c = Math.min(Math.max(a, 1e-4), 0.999);
  return Math.round((-Math.log(1 - c) * SR) / (2 * Math.PI));
}

/** Peak-normalize in place. */
function norm(buf, target = 1.0) {
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
}

/** Hand-rolled one-pole lowpass, in place. */
function lowpass(buf, alpha) {
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += alpha * (buf[i] - p);
    buf[i] = p;
  }
  return buf;
}

/** Add `src` into `dst` at a sample offset without growing it. */
function addInto(dst, src, off, g = 1.0) {
  const n = dst.length;
  const o = Math.round(off);
  for (let i = 0; i < src.length; i++) {
    const j = o + i;
    if (j >= 0 && j < n) dst[j] += src[i] * g;
  }
  return dst;
}

/** A surface pop's grain, from the LFSR hold period. */
function grainName(p) {
  return p <= 1 ? 'crisp' : p === 2 ? 'dusty' : 'coarse';
}

/** Name the air band a one-pole pair leaves behind. */
function airName(hz) {
  if (hz < 500) return 'muffled';
  if (hz < 1400) return 'warm';
  if (hz < 3200) return 'bright';
  return 'thin';
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'crackle', 'needle', 'hiss', 'wow', 'static', 'dust', 'hum', 'rewind', 'skip', 'stop',
  ]);

  // Band-shaped LFSR: a one-pole lowpass with a slower pole subtracted back out,
  // both corners free to move with time. This is the category's only noise source.
  const noiseBed = (n, period, lpAFn, hpFrac, ampFn) => {
    const lf = new Lfsr(rng, period);
    const out = new Array(n);
    let lp = 0.0;
    let hp = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const a = lpAFn(t);
      lp += a * (lf.next() - lp);
      hp += a * hpFrac * (lp - hp);
      out[i] = (lp - hp) * ampFn(t);
    }
    return out;
  };

  // One surface click: the same band-shaped noise, but milliseconds long.
  const click = (lf, len, rate, lpA, hpFrac) => {
    const out = new Array(len);
    let lp = 0.0;
    let hp = 0.0;
    for (let k = 0; k < len; k++) {
      lp += lpA * (lf.next() - lp);
      hp += lpA * hpFrac * (lp - hp);
      out[k] = (lp - hp) * Math.exp((-rate * k) / SR);
    }
    return out;
  };

  // A low tuned thud: the platter, the seam, the stylus landing.
  const thud = (dur, f, rate, bendTau) =>
    renderTone(
      secs(dur),
      (t) => f * (1.0 + 0.45 * Math.exp(-t / bendTau)),
      0.5,
      (t) => Math.min(1.0, t / 0.0025) * Math.exp(-rate * t),
      'tri'
    );

  // Scatter pops across a window; `skew` > 1 crowds them toward the start.
  const scatter = (dst, lf, count, t0, t1, skew, aLo, aHi, lpLo, lpHi) => {
    for (let p = 0; p < count; p++) {
      const u = Math.pow(rng.random(), skew);
      const at = (t0 + (t1 - t0) * u) * SR;
      const amp = rng.uniform(aLo, aHi);
      const len = secs(rng.uniform(0.0006, 0.0038));
      const rate = rng.uniform(900.0, 4200.0);
      addInto(dst, click(lf, len, rate, rng.uniform(lpLo, lpHi), 0.35), at, amp);
    }
  };

  const PENT = [0, 3, 5, 7, 10, 12];

  let out;
  let tags;
  let fadeIn = 4.0;
  let fadeOut = 30.0;

  if (style === 'crackle') {
    // a bed: dark surface noise, scattered pops, and the once-per-revolution seam
    const dur = rng.uniform(1.2, 3.0);
    const n = secs(dur);
    const rpm = rng.choice([33, 45, 78]);
    const revHz = rpm / 60.0;
    const bedA = rng.uniform(0.03, 0.28);
    const hpFrac = rng.uniform(0.08, 0.55);
    // the bed has to clear the 16-level crush or the surface disappears between
    // pops, so it sits within a couple of steps of the pops themselves
    const bedG = rng.uniform(0.18, 0.44);
    const density = rng.uniform(12.0, 95.0);
    const grain = rng.randint(1, 3);
    const wobPh = rng.uniform(0.0, 6.283);
    out = noiseBed(
      n,
      rng.randint(1, 2),
      () => bedA,
      hpFrac,
      (t) => 1.0 + 0.3 * Math.sin(6.283185 * revHz * t + wobPh)
    );
    norm(out, bedG);
    const lf = new Lfsr(rng, grain);
    const pops = Math.max(6, Math.min(300, Math.round(density * dur)));
    scatter(out, lf, pops, 0.0, dur, 1.0, 0.12, 0.5, 0.55, 0.95);
    const bigs = rng.randint(1, 5);
    for (let p = 0; p < bigs; p++) {
      addInto(
        out,
        click(lf, secs(rng.uniform(0.004, 0.015)), rng.uniform(180.0, 700.0), rng.uniform(0.35, 0.8), 0.25),
        rng.uniform(0.02, Math.max(0.05, dur - 0.06)) * SR,
        rng.uniform(0.45, 0.8)
      );
    }
    const thumpHz = rng.uniform(46.0, 105.0);
    const seamG = rng.uniform(0.0, 0.6);
    const seam = seamG > 0.22;
    const first = rng.uniform(0.04, Math.min(dur * 0.7, 1.0 / revHz));
    if (seam) {
      const bump = thud(0.15, thumpHz, rng.uniform(13.0, 26.0), 0.02);
      for (let t0 = first; t0 < dur; t0 += 1.0 / revHz) addInto(out, bump, t0 * SR, seamG);
    }
    tags = {
      style: 'crackle',
      rpm,
      grit: grainName(grain),
      surface: bedG > 0.24 ? 'worn surface' : 'quiet surface',
      seam: seam ? `${Math.round(thumpHz)} Hz seam` : 'no seam',
      pops,
    };
    fadeIn = 22.0;
    fadeOut = 90.0;
  } else if (style === 'needle') {
    // the stylus: landing in the lead-in, lifting off the run-out, or skating
    const action = rng.choice(['drop', 'drop', 'lift', 'skate']);
    const dur = action === 'skate' ? rng.uniform(0.5, 1.4) : rng.uniform(0.8, 2.2);
    const n = secs(dur);
    const bedA = rng.uniform(0.05, 0.3);
    const bedG = rng.uniform(0.2, 0.46);
    const grain = rng.randint(1, 3);
    const thumpHz = rng.uniform(48.0, 132.0);
    const scrapeMs = rng.uniform(0.04, 0.17);
    const density = rng.uniform(30.0, 130.0);
    const lift = rng.uniform(0.55, 0.82) * dur;
    const sweepTop = rng.uniform(1300.0, 4200.0);
    const bedAmp =
      action === 'lift'
        ? (t) => (t < lift ? 1.0 : Math.exp(-14.0 * (t - lift)))
        : action === 'drop'
          ? (t) => Math.min(1.0, t / 0.02)
          : (t) => 0.5 + 0.5 * Math.sin(6.283185 * (t / dur) - 1.57);
    out = noiseBed(n, rng.randint(1, 2), () => bedA, rng.uniform(0.1, 0.5), bedAmp);
    norm(out, bedG);
    const lf = new Lfsr(rng, grain);
    const pops = Math.max(8, Math.min(300, Math.round(density * dur)));
    if (action === 'drop') scatter(out, lf, pops, 0.01, dur, 1.9, 0.12, 0.55, 0.5, 0.95);
    else if (action === 'lift') scatter(out, lf, pops, 0.0, lift, 0.6, 0.12, 0.55, 0.5, 0.95);
    else scatter(out, lf, pops, 0.0, dur, 1.0, 0.15, 0.6, 0.5, 0.95);
    // the scrape: a band sweeping while the stylus is moving across grooves
    const sm = secs(action === 'skate' ? dur : scrapeMs);
    const at = action === 'lift' ? lift : 0.0;
    const rise = action !== 'drop';
    const scr = noiseBed(
      sm,
      rng.randint(1, 3),
      (t) => {
        const u = Math.min(1.0, (t * SR) / sm);
        const a = 0.12 + 0.8 * (rise ? u : 1.0 - u);
        return Math.min(0.97, a);
      },
      rng.uniform(0.3, 0.7),
      (t) => {
        const u = Math.min(1.0, (t * SR) / sm);
        return Math.min(1.0, u * 40.0) * (action === 'skate' ? 0.6 + 0.4 * Math.sin(3.1416 * u) : 1.0 - 0.65 * u);
      }
    );
    norm(scr, rng.uniform(0.5, 0.95));
    addInto(out, scr, at * SR, 1.0);
    if (action === 'skate') {
      // the squeal a dragged stylus makes: a thin tone tracking the scrape
      const sq = renderTone(
        n,
        (t) => sweepTop * Math.pow(0.35, t / dur) * (1.0 + 0.02 * Math.sin(6.283185 * 7.0 * t)),
        0.25,
        (t) => Math.min(1.0, t / 0.01) * (1.0 - 0.5 * (t / dur)),
        'tri'
      );
      addInto(out, sq, 0, rng.uniform(0.12, 0.35));
    } else {
      const bump = thud(0.22, thumpHz, rng.uniform(9.0, 22.0), 0.025);
      addInto(out, bump, at * SR, rng.uniform(0.55, 1.0));
    }
    tags = {
      style: 'needle',
      action,
      grit: grainName(grain),
      groove: action === 'drop' ? 'lead-in groove' : action === 'lift' ? 'run-out groove' : 'across the grooves',
      hz: Math.round(action === 'skate' ? sweepTop : thumpHz),
      pops,
    };
    fadeIn = 2.0;
    fadeOut = action === 'lift' ? 60.0 : 40.0;
  } else if (style === 'hiss') {
    // tape air: two poles set the band, dropouts punch holes in it
    const dur = rng.uniform(1.0, 3.0);
    const n = secs(dur);
    const lpA = rng.uniform(0.05, 0.62);
    const hpFrac = rng.uniform(0.06, 0.5);
    const motion = rng.choice(['steady', 'swell', 'fade', 'breathing']);
    const breathe = rng.uniform(0.35, 1.6);
    const bph = rng.uniform(0.0, 6.283);
    const drops = rng.randint(0, 3);
    const dropTs = [];
    for (let d = 0; d < drops; d++) dropTs.push([rng.uniform(0.12, dur - 0.12), rng.uniform(0.02, 0.09), rng.uniform(0.08, 0.45)]);
    const ampFn = (t) => {
      const u = t / dur;
      let a =
        motion === 'swell' ? 0.35 + 0.65 * u
        : motion === 'fade' ? 1.0 - 0.6 * u
        : motion === 'breathing' ? 0.62 + 0.38 * Math.sin(6.283185 * breathe * t + bph)
        : 0.9 + 0.1 * Math.sin(6.283185 * 0.4 * t + bph);
      for (let d = 0; d < dropTs.length; d++) {
        const x = (t - dropTs[d][0]) / dropTs[d][1];
        a *= 1.0 - (1.0 - dropTs[d][2]) * Math.exp(-x * x);
      }
      return a;
    };
    out = noiseBed(n, rng.randint(1, 2), () => lpA, hpFrac, ampFn);
    norm(out, 0.85);
    // bias whistle: the faint tone a tape machine leaves in the top end
    const biasHz = rng.uniform(2400.0, 5600.0);
    const biasG = rng.uniform(0.02, 0.09);
    addInto(
      out,
      renderTone(n, (t) => biasHz * (1.0 + 0.004 * Math.sin(6.283185 * 3.0 * t)), 0.5, ampFn, 'tri'),
      0,
      biasG
    );
    const airHz = poleHz(lpA);
    tags = {
      style: 'hiss',
      motion: motion === 'breathing' ? 'breathing' : motion === 'swell' ? 'swelling' : motion === 'fade' ? 'fading' : 'steady',
      tone: airName(airHz),
      bias: biasG > 0.055 ? 'bias whistle' : 'no whistle',
      drops,
      air_hz: airHz,
    };
    fadeIn = 30.0;
    fadeOut = 110.0;
  } else if (style === 'wow') {
    // the pitched centerpiece: a chip voice bent by a slow wow and a fast flutter
    const m = rng.randint(40, 74); // E2..D5
    const f0 = midi(m);
    const dur = rng.uniform(1.0, 3.0);
    const n = secs(dur);
    const wowHz = rng.uniform(0.4, 2.3);
    const flutHz = rng.uniform(5.0, 13.0);
    const wowC = rng.uniform(6.0, 75.0);
    const flutC = rng.uniform(0.5, 16.0);
    const wph = rng.uniform(0.0, 6.283);
    const fph = rng.uniform(0.0, 6.283);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const atk = rng.uniform(0.01, 0.09);
    const rel = rng.uniform(0.08, 0.4);
    const stack = rng.choice([0, 7, 12, 12]);
    const stackG = rng.uniform(0.2, 0.6);
    const dull = rng.uniform(0.1, 0.7);
    const hissG = rng.uniform(0.05, 0.22);
    const bendFn = (mul, ph) => (t) =>
      f0 * mul * Math.pow(2.0, (wowC * Math.sin(6.283185 * wowHz * t + wph + ph) + flutC * Math.sin(6.283185 * flutHz * t + fph)) / 1200.0);
    const envFn = (t) =>
      Math.min(1.0, t / atk) *
      Math.min(1.0, Math.max(0.0, dur - t) / rel) *
      (0.86 + 0.14 * Math.sin(6.283185 * flutHz * t + fph));
    out = renderTone(n, bendFn(1.0, 0.0), duty, envFn, wave);
    if (stack > 0) {
      addInto(out, renderTone(n, bendFn(Math.pow(2.0, stack / 12.0), 0.7), duty, envFn, 'tri'), 0, stackG);
    }
    lowpass(out, dull);
    norm(out, 0.85);
    addInto(
      out,
      norm(noiseBed(n, rng.randint(1, 2), () => rng.uniform(0.2, 0.5), 0.3, envFn), 1.0),
      0,
      hissG
    );
    tags = {
      style: 'wow',
      note: noteName(m),
      voice: stack === 12 ? 'octave stack' : stack === 7 ? 'fifth stack' : wave === 'tri' ? 'lone triangle' : 'lone square',
      flutter: flutC > 7.0 ? 'fluttery' : 'smooth',
      tone: dull > 0.4 ? 'open' : 'blanketed',
      wow_hz: r1(wowHz),
      cents: Math.round(wowC),
    };
    fadeIn = 8.0;
    fadeOut = 50.0;
  } else if (style === 'static') {
    // tuning across a dial: the band sweeps, a heterodyne squeal tracks it,
    // and stations surface for a moment before the noise swallows them again
    const dur = rng.uniform(1.0, 3.0);
    const n = secs(dur);
    const sweep = rng.choice(['up', 'down', 'scan']);
    const scanHz = rng.uniform(0.4, 1.6);
    const aLo = rng.uniform(0.04, 0.16);
    const aHi = rng.uniform(0.35, 0.9);
    const hpFrac = rng.uniform(0.15, 0.6);
    const curve = (t) => {
      const u = t / dur;
      return sweep === 'up' ? u : sweep === 'down' ? 1.0 - u : 0.5 - 0.5 * Math.cos(6.283185 * scanHz * t);
    };
    const stations = rng.randint(0, 3);
    const st = [];
    for (let s = 0; s < stations; s++) st.push([rng.uniform(0.15, Math.max(0.2, dur - 0.25)), rng.uniform(0.09, 0.26)]);
    const stGain = (t) => {
      let g = 0.0;
      for (let s = 0; s < st.length; s++) {
        const x = (t - st[s][0]) / st[s][1];
        const v = Math.exp(-x * x);
        if (v > g) g = v;
      }
      return g;
    };
    out = noiseBed(
      n,
      rng.randint(1, 2),
      (t) => aLo + (aHi - aLo) * curve(t),
      hpFrac,
      (t) => 0.85 * (1.0 - 0.7 * stGain(t))
    );
    norm(out, 0.8);
    const sqLo = rng.uniform(220.0, 700.0);
    const sqHi = rng.uniform(1800.0, 5200.0);
    const sqG = rng.uniform(0.1, 0.4);
    addInto(
      out,
      renderTone(
        n,
        (t) => sqLo * Math.pow(sqHi / sqLo, curve(t)),
        0.5,
        (t) => 0.35 + 0.65 * stGain(t),
        'tri'
      ),
      0,
      sqG
    );
    // a station: a few pentatonic notes, lowpassed until they sound far away
    const root = rng.randint(60, 76);
    const notes = rng.randint(2, 4);
    const step = rng.uniform(0.07, 0.16);
    const stG = rng.uniform(0.2, 0.5);
    for (let s = 0; s < st.length; s++) {
      for (let k = 0; k < notes; k++) {
        const mm = root + rng.choice(PENT);
        const tone = renderTone(
          secs(step * 1.1),
          () => midi(mm),
          0.125,
          (t) => Math.min(1.0, t / 0.006) * Math.exp(-9.0 * t),
          null
        );
        lowpass(tone, rng.uniform(0.12, 0.4));
        norm(tone, stG);
        addInto(out, tone, (st[s][0] - st[s][1] * 0.5 + k * step) * SR, 1.0);
      }
    }
    tags = {
      style: 'static',
      sweep: sweep === 'scan' ? 'back-and-forth scan' : `${sweep}-dial sweep`,
      band: airName(poleHz(aHi)),
      squeal: sqG > 0.25 ? 'loud heterodyne' : 'faint heterodyne',
      stations,
      top_hz: Math.round(sqHi),
    };
    fadeIn = 18.0;
    fadeOut = 70.0;
  } else if (style === 'dust') {
    // the noise floor of a machine that has been in a garage: dark, decimated,
    // bit-crushed until the grain itself is the sound
    const dur = rng.uniform(1.0, 3.0);
    const n = secs(dur);
    const lpA = rng.uniform(0.012, 0.15);
    const hpFrac = rng.uniform(0.05, 0.4);
    const steps = rng.choice([3, 4, 5, 6, 8, 12]);
    const hold = rng.randint(2, 14);
    const swayHz = rng.uniform(0.15, 0.7);
    const sph = rng.uniform(0.0, 6.283);
    out = noiseBed(n, rng.randint(1, 3), () => lpA, hpFrac, (t) => 0.75 + 0.25 * Math.sin(6.283185 * swayHz * t + sph));
    norm(out, 0.95);
    // sample-and-hold rate reduction over a coarse amplitude crush
    const dry = out.slice();
    let held = 0.0;
    let pk = 0.0;
    for (let i = 0; i < n; i++) {
      if (i % hold === 0) held = out[i];
      const v = Math.round(held * steps) / steps;
      out[i] = v;
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
    }
    if (pk < 0.08) for (let i = 0; i < n; i++) out[i] = dry[i];
    norm(out, rng.uniform(0.45, 0.75));
    const ticks = rng.randint(2, 16);
    const lf = new Lfsr(rng, rng.randint(1, 3));
    scatter(out, lf, ticks, 0.02, dur, 1.0, 0.15, 0.6, 0.5, 0.95);
    const humHz = rng.choice([50.0, 60.0]);
    const humG = rng.uniform(0.0, 0.35);
    const hummed = humG > 0.12;
    if (hummed) {
      addInto(out, renderTone(n, () => humHz, 0.5, () => 1.0, 'tri'), 0, humG);
    }
    tags = {
      style: 'dust',
      tone: airName(poleHz(lpA)),
      hum: hummed ? `${Math.round(humHz)} Hz hum` : 'no hum',
      ticks,
      steps,
      hold_hz: Math.round(SR / hold),
    };
    fadeIn = 30.0;
    fadeOut = 110.0;
  } else if (style === 'hum') {
    // machinery: a harmonic stack over near-DC platter rumble, plus the thin
    // bearing whine you only hear between tracks
    const mains = rng.random() < 0.45;
    const m = rng.randint(26, 45); // D1..A2
    const humHz = mains ? rng.choice([50.0, 60.0]) : midi(m);
    const dur = rng.uniform(0.8, 2.6);
    const n = secs(dur);
    const harms = rng.randint(2, 4);
    const buzz = rng.random() < 0.5;
    const revHz = rng.uniform(0.5, 1.4);
    const rph = rng.uniform(0.0, 6.283);
    const flut = rng.uniform(0.02, 0.12);
    const atk = rng.uniform(0.03, 0.14);
    const ampFn = (t) =>
      Math.min(1.0, t / atk) * (1.0 - flut * 0.5 + flut * Math.sin(6.283185 * revHz * t + rph));
    out = renderTone(n, (t) => humHz * (1.0 + 0.003 * Math.sin(6.283185 * revHz * t)), 0.5, ampFn, 'tri');
    const hg = [0.0, 0.5, 0.3, 0.18];
    for (let k = 2; k <= harms; k++) {
      addInto(
        out,
        renderTone(n, () => humHz * k, 0.5, ampFn, buzz ? null : 'tri'),
        0,
        hg[k - 1] * rng.uniform(0.6, 1.2)
      );
    }
    norm(out, 0.8);
    const rumA = rng.uniform(0.004, 0.022);
    const rumG = rng.uniform(0.2, 0.7);
    addInto(out, norm(noiseBed(n, rng.randint(1, 4), () => rumA, 0.1, ampFn), 1.0), 0, rumG);
    const whineHz = rng.uniform(320.0, 1900.0);
    const whineG = rng.uniform(0.0, 0.16);
    const whined = whineG > 0.05;
    if (whined) {
      addInto(
        out,
        renderTone(n, (t) => whineHz * (1.0 + 0.01 * Math.sin(6.283185 * 5.5 * t)), 0.25, ampFn, 'tri'),
        0,
        whineG
      );
    }
    tags = {
      style: 'hum',
      note: noteOfHz(humHz),
      source: mains ? 'mains buzz' : 'motor tone',
      whine: whined ? `${Math.round(whineHz)} Hz bearing whine` : 'no whine',
      rumble: rumG > 0.45 ? 'deep rumble' : 'light rumble',
      harms,
      hum_hz: r1(humHz),
    };
    fadeIn = 26.0;
    fadeOut = 90.0;
  } else if (style === 'rewind') {
    // spooling: a swept squeal over a swept band, with reel ticks that speed up
    const mode = rng.choice(['rewind', 'rewind', 'fast-forward', 'spool-down']);
    const dur = rng.uniform(0.6, 1.8);
    const n = secs(dur);
    const up = mode !== 'spool-down';
    const sqLo = rng.uniform(400.0, 1100.0);
    const sqTop = rng.uniform(2200.0, 6000.0);
    const wob = rng.uniform(4.0, 16.0);
    const curve = (t) => {
      const u = t / dur;
      return up ? u : 1.0 - u;
    };
    out = noiseBed(
      n,
      rng.randint(1, 2),
      (t) => 0.1 + 0.75 * curve(t),
      rng.uniform(0.25, 0.7),
      (t) => Math.min(1.0, t / 0.02) * Math.min(1.0, (dur - t) / 0.04)
    );
    norm(out, rng.uniform(0.5, 0.8));
    const sqG = rng.uniform(0.25, 0.7);
    addInto(
      out,
      renderTone(
        n,
        (t) => sqLo * Math.pow(sqTop / sqLo, curve(t)) * (1.0 + 0.03 * Math.sin(6.283185 * wob * t)),
        0.25,
        (t) => Math.min(1.0, t / 0.015) * Math.min(1.0, (dur - t) / 0.03) * (0.55 + 0.45 * curve(t)),
        'tri'
      ),
      0,
      sqG
    );
    const ticks = rng.randint(6, 40);
    const skew = rng.uniform(0.55, 1.7);
    const lf = new Lfsr(rng, rng.randint(1, 2));
    const tickG = rng.uniform(0.15, 0.5);
    for (let k = 0; k < ticks; k++) {
      const u = ticks > 1 ? k / (ticks - 1) : 0.0;
      const at = dur * (up ? Math.pow(u, skew) : 1.0 - Math.pow(1.0 - u, skew));
      addInto(
        out,
        click(lf, secs(rng.uniform(0.0015, 0.005)), rng.uniform(500.0, 1800.0), rng.uniform(0.6, 0.95), 0.4),
        at * SR,
        tickG * (0.7 + 0.3 * u)
      );
    }
    tags = {
      style: 'rewind',
      mode: mode === 'fast-forward' ? 'fast-forward' : mode === 'spool-down' ? 'spool-down' : 'rewind scrape',
      pace: skew < 0.85 ? 'accelerating reel' : skew > 1.25 ? 'slowing reel' : 'even reel',
      squeal: sqG > 0.45 ? 'shrill' : 'muted',
      ticks,
      top_hz: Math.round(sqTop),
    };
    fadeIn = 6.0;
    fadeOut = 30.0;
  } else if (style === 'skip') {
    // a locked groove: one cell — pop, thump, clipped note — on a strict grid
    const period = rng.uniform(0.12, 0.42);
    const maxRep = Math.max(4, Math.min(12, Math.floor(2.7 / period)));
    const repeats = rng.randint(4, maxRep);
    const bpm = Math.round(60.0 / period);
    const m = rng.randint(45, 72); // A2..C5
    const cellDur = Math.min(period * 0.92, rng.uniform(0.06, 0.16));
    const cn = secs(cellDur);
    const wave = rng.choice(['tri', null]);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const toneG = rng.uniform(0.3, 0.8);
    const thumpHz = rng.uniform(52.0, 120.0);
    const thumpG = rng.uniform(0.3, 0.9);
    const grain = rng.randint(1, 3);
    const slowing = rng.random() < 0.4;
    const bedA = rng.uniform(0.06, 0.3);
    const bedG = rng.uniform(0.14, 0.36);
    const n = Math.min(MAX_N, secs(repeats * period + cellDur + 0.06));
    out = noiseBed(n, rng.randint(1, 2), () => bedA, rng.uniform(0.1, 0.5), () => 1.0);
    norm(out, bedG);
    const lf = new Lfsr(rng, grain);
    // the cell, built once and stamped on the grid
    const cell = renderTone(
      cn,
      () => midi(m),
      duty,
      (t) => Math.min(1.0, t / 0.004) * Math.min(1.0, Math.max(0.0, cellDur - t) / 0.002) * Math.exp(-4.0 * t),
      wave
    );
    norm(cell, toneG);
    addInto(cell, thud(Math.min(cellDur, 0.1), thumpHz, rng.uniform(18.0, 40.0), 0.015), 0, thumpG);
    addInto(cell, click(lf, secs(0.004), rng.uniform(400.0, 1200.0), rng.uniform(0.6, 0.95), 0.3), 0, rng.uniform(0.3, 0.8));
    for (let k = 0; k < repeats; k++) {
      const g = (1.0 - 0.06 * k) * (k % 2 === 0 ? 1.0 : rng.uniform(0.72, 0.98));
      const drift = slowing ? 1.0 + 0.02 * k : 1.0;
      addInto(out, cell, k * period * drift * SR, Math.max(0.25, g));
    }
    scatter(out, lf, Math.max(8, Math.round(rng.uniform(20.0, 70.0) * (n / SR))), 0.0, n / SR, 1.0, 0.1, 0.4, 0.5, 0.95);
    tags = {
      style: 'skip',
      note: noteName(m),
      groove: slowing ? 'dragging groove' : 'locked groove',
      stub: wave === 'tri' ? 'triangle stub' : 'square stub',
      repeats,
      bpm,
    };
    fadeIn = 3.0;
    fadeOut = 35.0;
  } else {
    // the power-down (or spin-up): pitch, surface and brightness slow together
    const motion = rng.choice(['power-down', 'power-down', 'spin-up']);
    const m = rng.randint(38, 66); // D2..F#4
    const f0 = midi(m);
    const dur = rng.uniform(0.7, 2.2);
    const n = secs(dur);
    const oct = rng.uniform(2.0, 5.0);
    const shape = rng.uniform(0.7, 1.7);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    const stack = rng.choice([0, 7, 12]);
    const stackG = rng.uniform(0.25, 0.65);
    const bedA = rng.uniform(0.08, 0.35);
    const bedG = rng.uniform(0.1, 0.35);
    const density = rng.uniform(20.0, 80.0);
    const grain = rng.randint(1, 3);
    const down = motion === 'power-down';
    // 1 at full speed, 0 at rest
    const speed = (t) => {
      const u = Math.min(1.0, t / dur);
      return down ? Math.pow(1.0 - u, shape) : Math.pow(u, shape);
    };
    const envFn = (t) => {
      const s = speed(t);
      const edge = down ? Math.min(1.0, t / 0.006) : Math.min(1.0, Math.max(0.0, dur - t) / 0.05);
      return edge * (0.25 + 0.75 * s);
    };
    const voice = (mul) => renderTone(n, (t) => f0 * mul * Math.pow(2.0, -oct * (1.0 - speed(t))), duty, envFn, wave);
    out = voice(1.0);
    if (stack > 0) addInto(out, voice(Math.pow(2.0, stack / 12.0)), 0, stackG);
    norm(out, 0.85);
    const bed = noiseBed(n, rng.randint(1, 2), (t) => bedA * (0.15 + 0.85 * speed(t)), rng.uniform(0.1, 0.5), (t) => 0.3 + 0.7 * speed(t));
    norm(bed, bedG);
    addInto(out, bed, 0, 1.0);
    const lf = new Lfsr(rng, grain);
    const pops = Math.max(6, Math.min(200, Math.round(density * dur)));
    scatter(out, lf, pops, 0.0, dur, down ? 0.55 : 1.8, 0.1, 0.4, 0.5, 0.95);
    tags = {
      style: 'stop',
      motion,
      note: noteName(m),
      voice: stack === 12 ? 'octave stack' : stack === 7 ? 'fifth stack' : wave === 'tri' ? 'lone triangle' : 'lone square',
      bend: shape > 1.2 ? 'long tail' : shape < 0.9 ? 'sudden drop' : 'even glide',
      semis: Math.round(oct * 12.0),
    };
    fadeIn = down ? 3.0 : 25.0;
    fadeOut = down ? 60.0 : 20.0;
  }

  rng.tags = tags;

  // Hold the category's 0.5 - 3.0 s window, block the DC the pop scatter and the
  // near-subsonic thumps carry, then normalize last.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  while (out.length < MIN_N) out.push(0.0);
  dcBlock(out, 0.999);
  return finish(out, 0.9, fadeIn, fadeOut);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const int = (v) => Math.trunc(num(v));
  const note = t.note || 'C3';
  switch (t.style) {
    case 'crackle':
      return `vinyl crackle bed — ${int(t.rpm)} rpm ${t.grit || 'dusty'} ${t.surface || 'quiet surface'}, ${int(t.pops)} pops, ${t.seam || 'no seam'}`;
    case 'needle':
      return t.action === 'skate'
        ? `needle skate — ${int(t.hz)} Hz squeal ${t.groove || 'across the grooves'}, ${int(t.pops)} ${t.grit || 'dusty'} pops`
        : `needle ${t.action || 'drop'} — ${int(t.hz)} Hz thump ${t.action === 'lift' ? 'off' : 'into'} the ${t.groove || 'lead-in groove'}, ${int(t.pops)} ${t.grit || 'dusty'} pops`;
    case 'hiss':
      return `tape hiss bed — ${t.motion || 'steady'} ${t.tone || 'warm'} air near ${int(t.air_hz)} Hz, ${int(t.drops)} dropouts, ${t.bias || 'no whistle'}`;
    case 'wow':
      return `wow-and-flutter drift on ${note} — ${num(t.wow_hz).toFixed(1)} Hz wow, ${int(t.cents)} cent ${t.flutter || 'smooth'} ${t.voice || 'lone triangle'}`;
    case 'static':
      return `radio static tuning — ${t.sweep || 'up-dial sweep'}, ${int(t.stations)} stations, ${t.squeal || 'faint heterodyne'} to ${int(t.top_hz)} Hz`;
    case 'dust':
      return `dusty noise floor — ${int(t.steps)}-step crush held at ${int(t.hold_hz)} Hz, ${int(t.ticks)} ticks, ${t.hum || 'no hum'}`;
    case 'hum':
      return `motor hum on ${note} — ${num(t.hum_hz).toFixed(1)} Hz ${t.source || 'motor tone'}, ${t.rumble || 'light rumble'}, ${t.whine || 'no whine'}`;
    case 'rewind':
      return `tape ${t.mode || 'rewind scrape'} — ${int(t.ticks)} ticks on an ${t.pace || 'even reel'}, ${t.squeal || 'muted'} squeal to ${int(t.top_hz)} Hz`;
    case 'skip':
      return `${t.groove || 'locked groove'} skip on ${note} — ${int(t.repeats)} stutters at ${int(t.bpm)} bpm, ${t.stub || 'square stub'}`;
    case 'stop':
      return `turntable ${t.motion || 'power-down'} at ${note} — ${int(t.semis)} semitone ${t.bend || 'even glide'}, ${t.voice || 'lone triangle'}`;
    default:
      return `lo-fi vinyl texture — ${t.style || 'crackle'} bed with surface noise`;
  }
}

/** Short phrase for the README category table. */
export const character = 'crackle beds, needle drops, tape hiss, wow/flutter, static, motor hum';
