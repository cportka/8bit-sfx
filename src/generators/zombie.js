// zombie — the undead throat: sagging groans, arcing moans, dry hisses, wet
// gurgles, rattling breath, detuned groan duets and short aggressive snarls.
// Everything voiced leans on one trick: a DC-centered pulse (`square` minus its
// own duty mean) so a narrow pulse doesn't drag a fat offset through the
// envelope and smear the sag.
//
// Ported 1:1 from `gen_zombie` / `describe_zombie` in scripts/generate_sfx.py.
// The rng draw order below is the effect's identity — nothing may be added,
// removed, or reordered, or `zombie_042` stops being `zombie_042`. Two places
// are easy to get wrong: the `Lfsr` period is drawn *as a call argument*, so it
// lands before the constructor's own seed draw; and `groan`/`gurgle` draw from
// the rng *inside* their sample loops, so the loop count is part of the seed's
// consumption. The local `zfinish` fades first and normalizes second — the
// opposite of dsp's exported `finish()`, which is why this file doesn't use it.

import { SR, Lfsr, square, triangle, midi } from '../dsp.js';

const TWO_PI = 2.0 * Math.PI;

/** Python's round(): half-to-even on the exact value, returning an int. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  // Duty-corrected square: subtract the pulse's mean so no DC rides the envelope.
  const zsq = (ph, duty) => square(ph, duty) - (2.0 * duty - 1.0);

  // Fade both edges, *then* peak-normalize — the fades are inside the peak.
  const zfinish = (buf, target) => {
    const n = buf.length;
    const fi = Math.max(1, Math.trunc(0.004 * SR));
    const fo = Math.max(1, Math.trunc(0.02 * SR));
    for (let i = 0; i < Math.min(fi, n); i++) buf[i] *= i / fi;
    for (let i = 0; i < Math.min(fo, n); i++) buf[n - 1 - i] *= i / fo;
    let peak = 0.0;
    for (const v of buf) {
      const av = v < 0.0 ? -v : v;
      if (av > peak) peak = av;
    }
    const g = peak > 1e-6 ? target / peak : 0.0;
    return buf.map((v) => v * g);
  };

  const style = rng.choice(['groan', 'moan', 'hiss', 'gurgle', 'rattle', 'duet', 'snarl']);

  if (style === 'groan') {
    // Low sagging drone, slow vibrato, breathy noise on top.
    const dur = rng.uniform(0.7, 1.4);
    const n = Math.trunc(dur * SR);
    const base = midi(rng.randint(26, 34));
    const sag = rng.uniform(0.15, 0.4);
    const vibR = rng.uniform(3.5, 6.5);
    const vibD = rng.uniform(0.02, 0.06);
    const duty = rng.choice([0.25, 0.5, 0.5]);
    const tremR = rng.uniform(5.0, 9.0);
    const atk = rng.uniform(0.08, 0.2) * dur;
    const noise = new Lfsr(rng, 1);
    const ngain = rng.uniform(0.05, 0.12);
    let drift = 0.0;
    let driftT = 0.0;
    let ph = 0.0;
    let nz = 0.0;
    const buf = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const x = t / dur;
      if (i % 480 === 0) driftT = rng.uniform(-0.03, 0.03);
      drift += (driftT - drift) * 0.001;
      const f = base * (1.0 + sag * (1.0 - x) + vibD * Math.sin(TWO_PI * vibR * t) + drift);
      ph += f / SR;
      let env = t < atk ? t / atk : Math.exp((-2.2 * (t - atk)) / dur);
      env *= 1.0 - 0.25 * (0.5 + 0.5 * Math.sin(TWO_PI * tremR * t));
      nz += (noise.next() - nz) * 0.25;
      buf[i] = env * (zsq(ph, duty) + ngain * nz);
    }
    rng.tags = {
      style: 'groan',
      voice: duty === 0.25 ? 'nasal' : 'hollow',
      breathiness: ngain >= 0.085 ? 'breathy' : 'dry',
      pitch_hz: pyRound(base),
      sag_pct: pyRound(sag * 100),
    };
    return zfinish(buf, rng.uniform(0.55, 0.85));
  }

  if (style === 'moan') {
    // Pitch arcs up then back down; soft triangle voice with vibrato.
    const dur = rng.uniform(0.6, 1.3);
    const n = Math.trunc(dur * SR);
    const base = midi(rng.randint(33, 45));
    const arc = rng.uniform(0.3, 0.9);
    const bend = rng.uniform(0.6, 1.6);
    const vibR = rng.uniform(4.0, 7.5);
    const vibD = rng.uniform(0.015, 0.05);
    const useTri = rng.random() < 0.7;
    const duty = rng.choice([0.25, 0.5]);
    const noise = new Lfsr(rng, 1);
    const ngain = rng.uniform(0.03, 0.09);
    let ph = 0.0;
    let nz = 0.0;
    const buf = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const x = t / dur;
      const a = Math.sin(Math.PI * Math.pow(x, bend));
      const f = base * (1.0 + arc * a + vibD * Math.sin(TWO_PI * vibR * t));
      ph += f / SR;
      const env = Math.pow(a, 0.7);
      nz += (noise.next() - nz) * 0.3;
      const v = useTri ? triangle(ph) : zsq(ph, duty);
      buf[i] = env * (v + ngain * nz);
    }
    rng.tags = {
      style: 'moan',
      voice: useTri ? 'soft triangle' : 'buzzy pulse',
      rise: arc >= 0.6 ? 'wide' : 'gentle',
      vibrato: vibR >= 5.75 ? 'quick' : 'slow',
      pitch_hz: pyRound(base),
    };
    return zfinish(buf, rng.uniform(0.55, 0.85));
  }

  if (style === 'hiss') {
    // Dry throat hiss: bright LFSR through a hand-rolled lowpass, fluttering decay.
    const dur = rng.uniform(0.3, 0.8);
    const n = Math.trunc(dur * SR);
    const noise = new Lfsr(rng, rng.choice([1, 1, 2]));
    const lp = rng.uniform(0.35, 0.95);
    const flutR = rng.uniform(7.0, 16.0);
    const flutD = rng.uniform(0.2, 0.5);
    const dk = rng.uniform(2.5, 5.0);
    const atk = rng.uniform(0.01, 0.05);
    const puff2 = rng.random() < 0.5;
    const t2 = dur * rng.uniform(0.45, 0.65);
    let y = 0.0;
    const buf = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      y += (noise.next() - y) * lp;
      let env = t < atk ? t / atk : Math.exp(-dk * (t - atk));
      if (puff2 && t >= t2) {
        const e2 = Math.min((t - t2) / 0.02, 1.0) * Math.exp(-dk * (t - t2));
        if (e2 > env) env = e2;
      }
      env *= 1.0 - flutD * (0.5 + 0.5 * Math.sin(TWO_PI * flutR * t + 1.7));
      buf[i] = env * y;
    }
    rng.tags = {
      style: 'hiss',
      tone: lp >= 0.65 ? 'bright' : 'muffled',
      attack: atk < 0.03 ? 'sharp' : 'soft',
      puffs: puff2 ? 2 : 1,
      flutter_hz: pyRound(flutR),
    };
    return zfinish(buf, rng.uniform(0.5, 0.75));
  }

  if (style === 'gurgle') {
    // Wet throat: random down-chirping triangle bubbles over crunchy slow LFSR.
    const dur = rng.uniform(0.5, 1.2);
    const n = Math.trunc(dur * SR);
    const crunch = new Lfsr(rng, rng.randint(6, 12));
    const cgain = rng.uniform(0.25, 0.45);
    const wr = rng.uniform(3.0, 7.0);
    const gap = Math.trunc(SR * rng.uniform(0.04, 0.1));
    let timer = rng.randint(1, gap);
    const droneG = rng.uniform(0.0, 0.35);
    const droneF = rng.uniform(45.0, 75.0);
    let bf = 0.0;
    let blen = 1.0;
    let bage = 1.0;
    let bph = 0.0;
    let dph = 0.0;
    let y = 0.0;
    const buf = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const x = t / dur;
      timer -= 1;
      if (timer <= 0) {
        timer = Math.trunc(gap * rng.uniform(0.5, 1.6));
        bf = rng.uniform(90.0, 240.0);
        blen = SR * rng.uniform(0.03, 0.07);
        bage = 0.0;
        bph = 0.0;
      }
      let tone = 0.0;
      if (bage < blen) {
        const bx = bage / blen;
        bph += (bf * (1.0 - 0.5 * bx)) / SR;
        tone = triangle(bph) * (1.0 - bx) * (1.0 - bx);
        bage += 1.0;
      }
      y += (crunch.next() - y) * 0.5;
      dph += droneF / SR;
      const env = Math.pow(Math.sin(Math.PI * x), 0.6);
      const wob = 1.0 + 0.3 * Math.sin(TWO_PI * wr * t);
      buf[i] = env * (tone + cgain * y * wob + droneG * triangle(dph));
    }
    rng.tags = {
      style: 'gurgle',
      texture: cgain >= 0.35 ? 'thick' : 'light',
      underlay: droneG >= 0.15 ? 'droning' : 'dry',
      wobble_hz: pyRound(wr),
    };
    return zfinish(buf, rng.uniform(0.55, 0.8));
  }

  if (style === 'rattle') {
    // Rattling breath: crunchy noise chopped by a slow soft gate, inhale/exhale shape.
    const dur = rng.uniform(0.6, 1.4);
    const n = Math.trunc(dur * SR);
    const noise = new Lfsr(rng, rng.randint(3, 8));
    const rate0 = rng.uniform(11.0, 22.0);
    const rate1 = rate0 * rng.uniform(0.5, 1.1);
    const gduty = rng.uniform(0.25, 0.55);
    const breath = rng.uniform(0.35, 0.65);
    const toneG = rng.uniform(0.0, 0.25);
    const toneF = rng.uniform(50.0, 85.0);
    let gph = 0.0;
    let tph = 0.0;
    let y = 0.0;
    let g = 0.0;
    const buf = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const x = t / dur;
      const rate = rate0 + (rate1 - rate0) * x;
      gph += rate / SR;
      const gate = gph - Math.trunc(gph) < gduty ? 1.0 : 0.15;
      g += (gate - g) * 0.02;
      const env = x < breath ? Math.pow(x / breath, 1.5) : Math.exp(-3.5 * (x - breath));
      y += (noise.next() - y) * 0.6;
      tph += toneF / SR;
      buf[i] = env * g * (y + toneG * triangle(tph));
    }
    rng.tags = {
      style: 'rattle',
      gate: gduty < 0.4 ? 'choppy' : 'loose',
      pace: rate1 < rate0 ? 'slowing' : 'steady',
      undertone: toneG >= 0.12 ? 'humming' : 'plain',
      rattle_hz: pyRound(rate0),
    };
    return zfinish(buf, rng.uniform(0.5, 0.8));
  }

  if (style === 'duet') {
    // Two detuned pulse groans beating against each other.
    const dur = rng.uniform(0.7, 1.4);
    const n = Math.trunc(dur * SR);
    const base = midi(rng.randint(29, 38));
    const det = rng.uniform(1.008, 1.035);
    const glide = rng.uniform(0.05, 0.25);
    const duty1 = rng.choice([0.5, 0.25]);
    const duty2 = rng.choice([0.25, 0.125]);
    const tremR = rng.uniform(4.0, 8.0);
    const atk = rng.uniform(0.05, 0.15) * dur;
    let ph1 = 0.0;
    let ph2 = 0.0;
    const buf = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const x = t / dur;
      const f = base * (1.0 + glide * (1.0 - x));
      ph1 += f / SR;
      ph2 += (f * det) / SR;
      let env = t < atk ? t / atk : Math.exp((-1.8 * (t - atk)) / dur);
      env *= 1.0 - 0.2 * (0.5 + 0.5 * Math.sin(TWO_PI * tremR * t));
      buf[i] = env * (0.6 * zsq(ph1, duty1) + 0.5 * zsq(ph2, duty2));
    }
    rng.tags = {
      style: 'duet',
      timbre: duty2 === 0.125 ? 'thin' : 'full',
      glide: glide >= 0.15 ? 'sliding' : 'steady',
      detune_cents: pyRound(1200.0 * Math.log2(det)),
      pitch_hz: pyRound(base),
    };
    return zfinish(buf, rng.uniform(0.55, 0.85));
  }

  // snarl: short aggressive bark, fast throat-rate FM rasp plus noise, pitch drops.
  const dur = rng.uniform(0.3, 0.7);
  const n = Math.trunc(dur * SR);
  const base = rng.uniform(55.0, 110.0);
  const raspR = rng.uniform(22.0, 40.0);
  const raspD = rng.uniform(0.2, 0.45);
  const drop = rng.uniform(0.2, 0.5);
  const duty = rng.choice([0.25, 0.125, 0.5]);
  const noise = new Lfsr(rng, rng.choice([1, 2, 3]));
  const ngain = rng.uniform(0.15, 0.35);
  const atk = rng.uniform(0.008, 0.03);
  let ph = 0.0;
  let y = 0.0;
  const buf = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const x = t / dur;
    const f = base * (1.0 - drop * x * x) * (1.0 + raspD * Math.sin(TWO_PI * raspR * t));
    ph += f / SR;
    const env = t < atk ? t / atk : Math.exp((-3.0 * (t - atk)) / dur);
    y += (noise.next() - y) * 0.5;
    buf[i] = env * (zsq(ph, duty) + ngain * y * env);
  }
  rng.tags = {
    style: 'snarl',
    bite: ngain >= 0.25 ? 'gritty' : 'clean',
    drop: drop >= 0.35 ? 'plunging' : 'slight',
    rasp_hz: pyRound(raspR),
    pitch_hz: pyRound(base),
  };
  return zfinish(buf, rng.uniform(0.6, 0.85));
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const g = (k, dflt) => (Object.prototype.hasOwnProperty.call(t, k) ? t[k] : dflt);
  const style = g('style', 'snarl');

  if (style === 'groan') {
    return (
      `low zombie groan — ${g('voice', 'hollow')} pulse, ${g('breathiness', 'dry')}, ` +
      `${g('pitch_hz', 0)} Hz sagging ${g('sag_pct', 0)}%`
    );
  }
  if (style === 'moan') {
    return (
      `arcing zombie moan — ${g('voice', 'soft triangle')} voice, ${g('rise', 'gentle')} rise, ` +
      `${g('vibrato', 'slow')} vibrato, ${g('pitch_hz', 0)} Hz base`
    );
  }
  if (style === 'hiss') {
    const puffs = g('puffs', 1) === 2 ? 'double puff' : 'single puff';
    return (
      `dry throat hiss — ${g('tone', 'muffled')} noise, ${g('attack', 'soft')} attack, ` +
      `${puffs}, fluttering at ${g('flutter_hz', 0)} Hz`
    );
  }
  if (style === 'gurgle') {
    return (
      `wet throat gurgle — ${g('texture', 'light')} crunch, ${g('underlay', 'dry')} bed, ` +
      `wobbling at ${g('wobble_hz', 0)} Hz`
    );
  }
  if (style === 'rattle') {
    return (
      `rattling zombie breath — ${g('gate', 'loose')} ${g('pace', 'steady')} gate, ` +
      `${g('undertone', 'plain')} undertone, ${g('rattle_hz', 0)} Hz chop`
    );
  }
  if (style === 'duet') {
    return (
      `detuned groan duet — ${g('timbre', 'full')} pulses, ${g('glide', 'steady')} pitch, ` +
      `${g('detune_cents', 0)} cents apart at ${g('pitch_hz', 0)} Hz`
    );
  }
  return (
    `aggressive snarl bark — ${g('bite', 'clean')}, ${g('drop', 'slight')} pitch drop, ` +
    `${g('rasp_hz', 0)} Hz rasp on ${g('pitch_hz', 0)} Hz`
  );
}

/** Short phrase for the README category table. */
export const character = 'undead groans, moans, hisses, gurgles, rattling breath, snarls';
