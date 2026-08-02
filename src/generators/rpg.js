// RPG mechanics staples: melee, ranged, magic, loot, and progress jingles.
// Complements the ported pixel-rpg event set (steps, dialog blips, menus,
// dice, damage/heal, fetch, story fanfares) that lives in ../ported.js.
//
// A faithful port of the Python `gen_rpg` that produced the published 0.4.1
// WAVs — the draw order is the spec, so nothing here may be reordered,
// "improved", or given extra processing.

import { SR, Lfsr, square, midi, renderTone, decay, mixAt, dcBlock } from '../dsp.js';

/** Python's round(): half to EVEN, not half up. */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python `int(round(x))`. */
const iround = (x) => roundHalfEven(x);

/** Python `round(x, 1)` — half-to-even, so 2.25 -> 2.2 and 2.75 -> 2.8. */
function round1(x) {
  const q = x * 4;
  if (Number.isInteger(q) && Math.abs(q % 2) === 1) {
    // exactly on a .x25/.x75 tie: the only ties a binary double can hit
    const f = Math.floor(x * 10);
    return (f % 2 === 0 ? f : f + 1) / 10;
  }
  return Number(x.toFixed(1));
}

/** Python's "%.1f". */
const fmt1 = (v) => Number(v).toFixed(1);

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  function noiseBurst(n, period, rate, gain = 1.0) {
    const lf = new Lfsr(rng, period);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = lf.next() * Math.exp(-rate * (i / SR)) * gain;
    return out;
  }

  // one-pole lowpassed LFSR noise; cutoff coefficient glides a0 -> a1
  function lpSweep(n, period, a0, a1, rate, gain = 1.0, atk = 0.0) {
    const lf = new Lfsr(rng, period);
    const out = [];
    let prev = 0.0;
    const inv = 1.0 / Math.max(atk, 1e-4);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      prev += (a0 + (a1 - a0) * (i / n)) * (lf.next() - prev);
      let a = t * inv;
      if (a > 1.0) a = 1.0;
      out.push(prev * a * Math.exp(-rate * t) * gain);
    }
    return out;
  }

  // ramp a buffer's last few ms to zero so a mid-effect voice can stop while
  // other voices keep sounding, without a step click
  function fadeTail(seq, ms = 25.0) {
    const r = Math.min(seq.length, Math.trunc(SR * ms * 0.001));
    for (let i = 0; i < r; i++) seq[seq.length - 1 - i] *= i / r;
    return seq;
  }

  const style = rng.choice([
    'sword_swing', 'metal_clash', 'bow_shot', 'spell_fire', 'spell_ice',
    'spell_zap', 'buff_shimmer', 'potion_glug', 'level_up', 'quest_done',
    'loot_jingle', 'chest_open', 'shield_block', 'trap_spring',
    'teleport', 'game_over', 'save_chime',
  ]);

  let buf;
  let tags;

  if (style === 'sword_swing') {
    // air-cutting whoosh: bright->dark filtered noise under a falling whistle
    const swipes = rng.random() < 0.3 ? 2 : 1;
    const dur = rng.uniform(0.14, 0.24);
    const fWh = rng.uniform(900.0, 2000.0);
    const drop = rng.uniform(1.0, 2.2);
    const rate = rng.uniform(13.0, 22.0);
    const n = Math.trunc(SR * dur);
    buf = [];
    let off = 0;
    for (let k = 0; k < swipes; k++) {
      const period = rng.randint(1, 2);
      const a0 = rng.uniform(0.5, 0.8);
      const a1 = rng.uniform(0.06, 0.16);
      const atk = rng.uniform(0.012, 0.035);
      const sw = fadeTail(lpSweep(n, period, a0, a1, rate, 1.0, atk));
      mixAt(buf, sw, off, Math.pow(0.8, k));
      const wh = fadeTail(renderTone(
        n, (t) => fWh * Math.pow(2.0, (-drop * t) / dur),
        0.5, (t) => Math.min(1.0, t / 0.02) * Math.exp(-rate * t),
        'tri'));
      mixAt(buf, wh, off, rng.uniform(0.3, 0.5));
      off += Math.trunc(n * rng.uniform(0.7, 0.9));
    }
    tags = {
      style: 'sword swing',
      arc: rate > 17.5 ? 'cutting' : 'broad',
      swipes,
      whistle_hz: iround(fWh),
    };
  } else if (style === 'metal_clash') {
    // blade on blade: three inharmonic square partials over a spark of noise
    const f = rng.uniform(420.0, 900.0);
    const dur = rng.uniform(0.28, 0.55);
    const n = Math.trunc(SR * dur);
    const ring = rng.uniform(8.0, 18.0);
    const ratios = [1.0, rng.uniform(1.48, 1.72), rng.uniform(2.28, 2.78)];
    const gains = [1.0, rng.uniform(0.5, 0.75), rng.uniform(0.3, 0.55)];
    buf = [];
    for (let j = 0; j < 3; j++) {
      const fr = f * ratios[j];
      const pt = renderTone(n, () => fr, j === 0 ? 0.5 : 0.25, decay(ring + 5.0 * j));
      mixAt(buf, pt, 0, gains[j]);
    }
    const spark = rng.uniform(0.5, 1.1);
    mixAt(buf, noiseBurst(Math.trunc(SR * 0.02), 1, 240.0), 0, spark);
    tags = {
      style: 'metal clash',
      clang_hz: iround(f),
      ring: ring < 12.0 ? 'long' : 'short',
      attack: spark > 0.8 ? 'sparking' : 'clean',
    };
  } else if (style === 'bow_shot') {
    // string twang settling sharp-to-true, then the arrow zips off
    const f0 = rng.uniform(140.0, 300.0);
    const vib = rng.uniform(40.0, 85.0);
    const twDur = rng.uniform(0.09, 0.16);
    const tn = Math.trunc(SR * twDur);
    buf = fadeTail(renderTone(
      tn,
      (t) => f0 * (1.0 + 0.22 * Math.exp(-34.0 * t))
        * (1.0 + 0.05 * Math.exp(-11.0 * t) * Math.sin(2.0 * Math.PI * vib * t)),
      0.25, decay(rng.uniform(20.0, 30.0))));
    const zn = Math.trunc(SR * rng.uniform(0.08, 0.16));
    const za0 = rng.uniform(0.15, 0.25);
    const za1 = rng.uniform(0.6, 0.85);
    const zrate = rng.uniform(11.0, 18.0);
    const zip = fadeTail(lpSweep(zn, 1, za0, za1, zrate, 1.0, 0.01));
    const zOff = Math.trunc(tn * rng.uniform(0.3, 0.55));
    mixAt(buf, zip, zOff, rng.uniform(0.35, 0.6));
    const hit = rng.random() < 0.5;
    if (hit) {
      const fk = rng.uniform(80.0, 130.0);
      const kn = Math.trunc(SR * rng.uniform(0.06, 0.1));
      const knock = renderTone(kn, () => fk, 0.5, decay(rng.uniform(35.0, 55.0)), 'tri');
      const hOff = zOff + zn;
      mixAt(buf, knock, hOff, rng.uniform(0.7, 1.0));
      mixAt(buf, noiseBurst(Math.trunc(SR * 0.012), 1, 300.0), hOff, 0.5);
    }
    tags = {
      style: 'bow shot',
      twang_hz: iround(f0),
      string: vib > 62.0 ? 'tight' : 'slack',
      arrow: hit ? 'thunk' : 'zip',
    };
  } else if (style === 'spell_fire') {
    // fire spell: a blooming dark-noise whoosh with crackles and a low roar
    const dur = rng.uniform(0.4, 0.8);
    const n = Math.trunc(SR * dur);
    const atk = rng.uniform(0.04, 0.14);
    const rate = rng.uniform(5.0, 9.0);
    const period = rng.randint(2, 4);
    const a0 = rng.uniform(0.08, 0.16);
    const a1 = rng.uniform(0.3, 0.5);
    buf = lpSweep(n, period, a0, a1, rate, 1.0, atk);
    const crackles = rng.randint(3, 8);
    for (let k = 0; k < crackles; k++) {
      const off = Math.trunc(n * rng.uniform(0.15, 0.85));
      const cn = Math.trunc(SR * rng.uniform(0.006, 0.014));
      const cp = rng.randint(1, 2);
      const crate = rng.uniform(180.0, 320.0);
      const cg = rng.uniform(0.4, 0.8);
      mixAt(buf, noiseBurst(cn, cp, crate, cg), off);
    }
    const fr = rng.uniform(55.0, 90.0);
    const roar = renderTone(
      n, (t) => fr * (1.0 + 0.12 * Math.sin(23.0 * t)), 0.5,
      (t) => Math.min(1.0, t / atk) * Math.exp(-rate * t), 'tri');
    const rg = rng.uniform(0.4, 0.7);
    mixAt(buf, roar, 0, rg);
    tags = {
      style: 'fire spell',
      crackles,
      roar_hz: iround(fr),
      body: rg > 0.55 ? 'throaty' : 'airy',
      surge: atk > 0.08 ? 'slow bloom' : 'fast burst',
    };
  } else if (style === 'spell_ice') {
    // ice spell: glassy narrow-duty shards scattered under a frosty hiss
    const shards = rng.randint(4, 8);
    const top = rng.uniform(1800.0, 3200.0);
    const span = rng.uniform(0.25, 0.5);
    buf = [];
    for (let k = 0; k < shards; k++) {
      const fs = top * Math.pow(2.0, -rng.uniform(0.0, 1.2));
      const ln = Math.trunc(SR * rng.uniform(0.03, 0.06));
      const off = Math.trunc(SR * ((span * k) / shards + rng.uniform(0.0, 0.02)));
      const sh = fadeTail(
        renderTone(ln, () => fs, 0.125, decay(rng.uniform(80.0, 130.0))), 10.0);
      mixAt(buf, sh, off, rng.uniform(0.5, 0.9));
    }
    const hissG = rng.uniform(0.1, 0.3);
    const hn = buf.length;
    const hrate = rng.uniform(6.0, 10.0);
    mixAt(buf, lpSweep(hn, 1, 0.8, 0.5, hrate, hissG, 0.03), 0);
    tags = {
      style: 'ice spell',
      shards,
      top_hz: iround(top),
      glint: hissG < 0.2 ? 'glassy' : 'frosty',
    };
  } else if (style === 'spell_zap') {
    // arcane zap: a diving square carrying a hard LFO buzz
    const f0 = rng.uniform(1100.0, 2000.0);
    const fall = rng.uniform(1.4, 2.6);
    const dur = rng.uniform(0.16, 0.3);
    const n = Math.trunc(SR * dur);
    const bz = rng.uniform(28.0, 70.0);
    const depth = rng.uniform(0.2, 0.45);
    const duty = rng.choice([0.125, 0.25]);
    const rr = rng.uniform(9.0, 14.0);
    buf = renderTone(
      n,
      (t) => f0 * Math.pow(2.0, (-fall * t) / dur) * (1.0 + depth * square(bz * t, 0.5)),
      duty,
      (t) => Math.exp(-rr * t) * Math.min(1.0, Math.max(0.0, (dur - t) / (0.15 * dur))));
    tags = {
      style: 'arcane zap',
      from_hz: iround(f0),
      fall_oct: round1(fall),
      buzz: bz < 48.0 ? 'coarse' : 'fine',
    };
  } else if (style === 'buff_shimmer') {
    // heal/buff shimmer: two detuned triangles gliding up under a tremolo
    const f0 = rng.uniform(midi(69), midi(81));
    const rise = rng.uniform(0.5, 1.0);
    const dur = rng.uniform(0.5, 0.9);
    const n = Math.trunc(SR * dur);
    const trem = rng.uniform(5.0, 10.0);
    const tdep = rng.uniform(0.25, 0.5);
    const det = rng.uniform(1.003, 1.009);

    const env = (t) => {
      const a = Math.min(1.0, t / 0.06);
      const rel = Math.min(1.0, Math.max(0.0, (dur - t) / (0.25 * dur)));
      return a * rel * (1.0 - tdep * 0.5 * (1.0 + Math.sin(2.0 * Math.PI * trem * t)));
    };

    buf = renderTone(n, (t) => f0 * Math.pow(2.0, (rise * t) / dur), 0.5, env, 'tri');
    const fHi = f0 * 2.0 * det;
    const hi = renderTone(n, (t) => fHi * Math.pow(2.0, (rise * t) / dur), 0.5, env, 'tri');
    mixAt(buf, hi, 0, rng.uniform(0.35, 0.55));
    tags = {
      style: 'buff shimmer',
      base_hz: iround(f0),
      rise_oct: round1(rise),
      tremolo: trem > 7.5 ? 'fluttery' : 'gentle',
    };
  } else if (style === 'potion_glug') {
    // bottle glugs: pitch-dipping triangle blubs stepping up as it empties
    const glugs = rng.randint(2, 4);
    const f0 = rng.uniform(160.0, 260.0);
    const step = rng.uniform(1.1, 1.25);
    const gl = rng.uniform(0.07, 0.11);
    buf = [];
    let off = 0;
    for (let k = 0; k < glugs; k++) {
      const fk = f0 * Math.pow(step, k);
      const gn = Math.trunc(SR * gl);
      const g = renderTone(
        gn,
        (t) => fk * (1.0 - 0.45 * Math.sin(Math.PI * Math.min(1.0, t / gl))),
        0.5, (t) => Math.pow(Math.sin(Math.PI * Math.min(1.0, t / gl)), 2), 'tri');
      mixAt(buf, g, off);
      const np = rng.randint(2, 3);
      const nrate = rng.uniform(120.0, 200.0);
      const nb = noiseBurst(Math.trunc(SR * 0.015), np, nrate);
      mixAt(buf, nb, off, rng.uniform(0.15, 0.3));
      off += gn + Math.trunc(SR * rng.uniform(0.02, 0.05));
    }
    tags = {
      style: 'potion glug',
      glugs,
      start_hz: iround(f0),
      pour: f0 < 205.0 ? 'thick' : 'thin',
    };
  } else if (style === 'level_up') {
    // level-up fanfare: a quick major climb into a held (maybe vibrato) top
    const root = rng.randint(55, 69);
    const pat = rng.choice([[0, 4, 7, 12], [0, 4, 7, 12, 16], [0, 7, 12, 16],
      [0, 5, 9, 12]]);
    const duty = rng.choice([0.25, 0.5]);
    const nl = rng.uniform(0.055, 0.085);
    buf = [];
    let off = 0;
    let vibOn = false;
    for (let k = 0; k < pat.length; k++) {
      const fq = midi(root + pat[k]);
      const last = k === pat.length - 1;
      let nt;
      if (last) {
        const dn = Math.trunc(SR * rng.uniform(0.28, 0.4));
        vibOn = rng.random() < 0.6;
        const vr = rng.uniform(5.5, 8.0);
        const on = vibOn;
        nt = renderTone(
          dn,
          (t) => fq * (1.0 + (on ? 0.012 * Math.sin(2.0 * Math.PI * vr * t) : 0.0)),
          duty, decay(rng.uniform(8.0, 11.0)));
      } else {
        nt = renderTone(Math.trunc(SR * nl), () => fq, duty, decay(14.0));
      }
      mixAt(buf, nt, off);
      off += Math.trunc(SR * nl);
    }
    tags = {
      style: 'level-up fanfare',
      notes: pat.length,
      root_hz: iround(midi(root)),
      finish: vibOn ? 'vibrato hold' : 'clean hold',
    };
  } else if (style === 'quest_done') {
    // quest-complete stinger: a pickup note into a rolled, hanging chord
    const root = rng.randint(58, 74);
    const duty = rng.choice([0.25, 0.5]);
    const pk = midi(root - 5);
    buf = fadeTail(renderTone(Math.trunc(SR * 0.07), () => pk, duty, decay(16.0)));
    const chord = [0, 4, 7, 12].slice(0, rng.choice([3, 4]));
    const off = Math.trunc(SR * rng.uniform(0.08, 0.11));
    const roll = Math.trunc(SR * rng.uniform(0.015, 0.03));
    const hold = rng.uniform(0.3, 0.45);
    for (let k = 0; k < chord.length; k++) {
      const fq = midi(root + chord[k]);
      const nt = renderTone(Math.trunc(SR * hold), () => fq, duty, decay(rng.uniform(7.0, 10.0)));
      mixAt(buf, nt, off + k * roll, 0.8 / (1.0 + 0.15 * k));
    }
    tags = {
      style: 'quest stinger',
      chord: chord.length,
      root_hz: iround(midi(root)),
      voice: duty === 0.25 ? 'bright' : 'warm',
    };
  } else if (style === 'loot_jingle') {
    // gold spill: a handful of tiny narrow-duty coin tinks
    const coins = rng.randint(3, 6);
    const top = rng.randint(91, 102);
    const span = rng.uniform(0.12, 0.3);
    buf = [];
    for (let k = 0; k < coins; k++) {
      const fq = midi(top - rng.randint(0, 7));
      const ln = Math.trunc(SR * rng.uniform(0.05, 0.08));
      const off = Math.trunc(SR * ((span * k) / coins + rng.uniform(0.0, 0.03)));
      const tw = fadeTail(renderTone(
        ln, (t) => fq * (1.0 + 0.03 * Math.exp(-90.0 * t)),
        0.125, decay(rng.uniform(60.0, 90.0))), 12.0);
      mixAt(buf, tw, off, rng.uniform(0.5, 0.9));
    }
    tags = {
      style: 'loot jingle',
      coins,
      top_hz: iround(midi(top)),
      spill: span < 0.2 ? 'tight' : 'scattered',
    };
  } else if (style === 'chest_open') {
    // unlock clicks with metal pings, then a rising reveal swell + sparkles
    const clicks = rng.randint(2, 3);
    buf = [];
    let off = 0;
    const ping = rng.uniform(1400.0, 2600.0);
    for (let k = 0; k < clicks; k++) {
      const cn = Math.trunc(SR * rng.uniform(0.008, 0.014));
      mixAt(buf, noiseBurst(cn, 1, 260.0), off, 0.9 - 0.15 * k);
      const pf = ping * Math.pow(0.85, k);
      const pg = renderTone(Math.trunc(SR * 0.02), () => pf, 0.125, decay(170.0));
      mixAt(buf, pg, off, 0.5);
      off += Math.trunc(SR * rng.uniform(0.05, 0.09));
    }
    const swDur = rng.uniform(0.2, 0.32);
    const sn = Math.trunc(SR * swDur);
    const f0 = midi(rng.randint(64, 72));
    const sw = renderTone(
      sn, (t) => f0 * Math.pow(2.0, t / swDur), 0.5,
      (t) => Math.min(1.0, t / 0.04)
        * Math.min(1.0, Math.max(0.0, (swDur - t) / (0.3 * swDur))), 'tri');
    mixAt(buf, sw, off, 0.7);
    const sparkles = rng.randint(2, 4);
    for (let k = 0; k < sparkles; k++) {
      const fq = midi(rng.randint(88, 97));
      const sp = fadeTail(
        renderTone(Math.trunc(SR * 0.05), () => fq, 0.125, decay(55.0)), 10.0);
      mixAt(buf, sp, off + Math.trunc(sn * rng.uniform(0.4, 1.0)), rng.uniform(0.4, 0.7));
    }
    tags = {
      style: 'chest open',
      clicks,
      ping_hz: iround(ping),
      sparkles,
      lock: ping < 1900.0 ? 'heavy' : 'bright',
    };
  } else if (style === 'shield_block') {
    // a hit taken on the shield: ringing parry ting or a dull flat block
    const parry = rng.random() < 0.5;
    let fq;
    let sustain;
    if (parry) {
      fq = rng.uniform(1600.0, 2600.0);
      const rr = rng.uniform(14.0, 20.0);
      const n = Math.trunc(SR * rng.uniform(0.18, 0.3));
      const f = fq;
      buf = renderTone(
        n, (t) => f * (1.0 + 0.04 * (1.0 - Math.exp(-25.0 * t))), 0.125, decay(rr));
      mixAt(buf, noiseBurst(Math.trunc(SR * 0.012), 1, 300.0), 0, 0.7);
      sustain = rr < 17.0 ? 'long ring' : 'quick mute';
    } else {
      fq = rng.uniform(220.0, 380.0);
      const rr = rng.uniform(20.0, 30.0);
      const n = Math.trunc(SR * rng.uniform(0.14, 0.22));
      const f = fq;
      buf = renderTone(n, () => f, 0.5, decay(rr), 'tri');
      const np = rng.randint(2, 4);
      const nb = noiseBurst(Math.trunc(SR * 0.025), np, 140.0);
      mixAt(buf, nb, 0, rng.uniform(0.6, 0.9));
      sustain = rr < 25.0 ? 'long ring' : 'quick mute';
    }
    tags = {
      style: 'shield block',
      response: parry ? 'parry ting' : 'flat block',
      hz: iround(fq),
      sustain,
    };
  } else if (style === 'trap_spring') {
    // the arming click, a beat of quiet, then the spring lets go
    const clickG = rng.uniform(0.6, 0.9);
    buf = noiseBurst(Math.trunc(SR * 0.01), 1, 280.0, clickG);
    const gap = Math.trunc(SR * rng.uniform(0.05, 0.12));
    const f0 = rng.uniform(260.0, 480.0);
    const wob = rng.uniform(20.0, 42.0);
    const bn = Math.trunc(SR * rng.uniform(0.25, 0.45));
    const boing = renderTone(
      bn,
      (t) => f0 * (1.0 + 0.35 * Math.exp(-6.0 * t) * Math.sin(2.0 * Math.PI * wob * t)),
      0.25, decay(rng.uniform(8.0, 12.0)));
    mixAt(buf, boing, gap);
    const snapG = rng.uniform(0.4, 0.9);
    const sp = rng.randint(1, 2);
    mixAt(buf, noiseBurst(Math.trunc(SR * 0.02), sp, 200.0), gap, snapG);
    tags = {
      style: 'trap spring',
      boing_hz: iround(f0),
      wobble_hz: iround(wob),
      snap: snapG > 0.65 ? 'sharp' : 'soft',
    };
  } else if (style === 'teleport') {
    // warp: a sample-and-hold stepped gliss with a shimmering amp wobble
    const up = rng.random() < 0.6;
    const f0 = up ? rng.uniform(300.0, 600.0) : rng.uniform(1400.0, 2400.0);
    const span = rng.uniform(1.6, 2.8);
    const dur = rng.uniform(0.35, 0.6);
    const n = Math.trunc(SR * dur);
    const st = rng.uniform(0.014, 0.025);
    const trem = rng.uniform(20.0, 45.0);
    const sgn = up ? span : -span;
    buf = renderTone(
      n,
      (t) => f0 * Math.pow(2.0, (sgn * (Math.floor(t / st) * st)) / dur),
      0.25,
      (t) => Math.min(1.0, t / 0.03) * Math.min(1.0, Math.max(0.0, (dur - t) / (0.2 * dur)))
        * (0.7 + 0.3 * Math.sin(2.0 * Math.PI * trem * t)));
    tags = {
      style: 'teleport warp',
      direction: up ? 'rising' : 'sinking',
      span_oct: round1(span),
      start_hz: iround(f0),
    };
  } else if (style === 'game_over') {
    // somber sting: a short fall of notes onto a low held tone
    const root = rng.randint(57, 64);
    const pat = rng.choice([[0, -1, -3, -8], [0, -3, -5, -12], [0, -2, -7],
      [0, -4, -7, -12], [0, -5, -11]]);
    const wave = rng.choice(['tri', 'sq']);
    const shape = wave === 'tri' ? 'tri' : null;
    const nl = rng.uniform(0.1, 0.16);
    buf = [];
    let off = 0;
    for (let k = 0; k < pat.length; k++) {
      const fq = midi(root + pat[k]);
      const last = k === pat.length - 1;
      let nt;
      if (last) {
        const dn = Math.trunc(SR * rng.uniform(0.3, 0.45));
        const vr = rng.uniform(4.0, 6.0);
        nt = renderTone(
          dn, (t) => fq * (1.0 + 0.015 * Math.sin(2.0 * Math.PI * vr * t)),
          0.5, decay(rng.uniform(7.0, 9.0)), shape);
      } else {
        nt = renderTone(Math.trunc(SR * nl), () => fq, 0.5, decay(9.0), shape);
      }
      mixAt(buf, nt, off);
      off += Math.trunc(SR * nl);
    }
    tags = {
      style: 'game-over sting',
      notes: pat.length,
      end_hz: iround(midi(root + pat[pat.length - 1])),
      wave: wave === 'tri' ? 'triangle' : 'square',
    };
  } else {
    // save_chime: gentle two-note triangle chime, sometimes with a soft echo
    const m = rng.randint(82, 93);
    const iv = rng.choice([5, 7]);
    const nl = rng.uniform(0.07, 0.1);
    const echo = rng.random() < 0.6;
    buf = [];

    const pair = (gain, off) => {
      const fa = midi(m);
      const a = renderTone(Math.trunc(SR * nl), () => fa, 0.5, decay(18.0), 'tri');
      const bn = Math.trunc(SR * rng.uniform(0.18, 0.26));
      const fb = midi(m + iv);
      const b = fadeTail(renderTone(bn, () => fb, 0.5, decay(rng.uniform(12.0, 18.0)), 'tri'));
      mixAt(buf, a, off, gain);
      mixAt(buf, b, off + Math.trunc(SR * nl), gain);
    };

    pair(1.0, 0);
    if (echo) {
      const g = rng.uniform(0.25, 0.45);
      const eOff = Math.trunc(SR * rng.uniform(0.16, 0.22));
      pair(g, eOff);
    }
    tags = {
      style: 'save chime',
      hz: iround(midi(m)),
      interval: iv === 7 ? 'fifth' : 'fourth',
      echo: echo ? 'soft echo' : 'dry',
    };
  }

  // clamp into the set's 0.1 - 1.5 s window
  const nMin = Math.trunc(SR * 0.1);
  const nMax = Math.trunc(SR * 1.5);
  if (buf.length < nMin) {
    while (buf.length < nMin) buf.push(0.0);
  } else if (buf.length > nMax) {
    buf.length = nMax;
  }

  // hand-rolled one-pole DC blocker (narrow duties and long sweeps drift)
  dcBlock(buf, 0.995);

  // de-click the head, fade the tail, normalize above the quantizer floor
  const hk = Math.min(Math.trunc(SR * 0.002), Math.floor(buf.length / 2));
  for (let i = 0; i < hk; i++) buf[i] *= i / hk;
  const tk = Math.min(Math.trunc(SR * 0.018), Math.floor(buf.length / 2));
  for (let i = 0; i < tk; i++) buf[buf.length - 1 - i] *= i / tk;
  let peak = 0.0;
  for (const v of buf) {
    const a = v < 0.0 ? -v : v;
    if (a > peak) peak = a;
  }
  if (peak > 1e-9) {
    const g = rng.uniform(0.75, 0.95) / peak;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  rng.tags = tags;
  return buf;
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const s = t.style ?? 'rpg effect';
  const g = (k, d) => (t[k] === undefined ? d : t[k]);
  if (s === 'sword swing') {
    const swipe = g('swipes', 1) === 2 ? 'double swipe' : 'single swipe';
    return `sword swing — ${g('arc', 'broad')} arc, ${swipe}, blade whistle off ${g('whistle_hz', 0)} Hz`;
  }
  if (s === 'metal clash') {
    return `metal clash — ${g('clang_hz', 0)} Hz clang, ${g('ring', 'short')} ring, ${g('attack', 'clean')} attack`;
  }
  if (s === 'bow shot') {
    const flight = g('arrow', 'zip') === 'thunk' ? 'thuds home' : 'zips past';
    return `bow shot — ${g('string', 'slack')} string twang at ${g('twang_hz', 0)} Hz, arrow ${flight}`;
  }
  if (s === 'fire spell') {
    return (
      `fire spell — ${g('body', 'airy')} ${g('surge', 'fast burst')}, ` +
      `${g('crackles', 0)} crackles, ${g('roar_hz', 0)} Hz roar under it`
    );
  }
  if (s === 'ice spell') {
    return `ice spell — ${g('shards', 0)} ${g('glint', 'glassy')} shards chiming down from ${g('top_hz', 0)} Hz`;
  }
  if (s === 'arcane zap') {
    return `arcane zap — ${g('buzz', 'fine')} buzz diving ${fmt1(g('fall_oct', 0))} octaves from ${g('from_hz', 0)} Hz`;
  }
  if (s === 'buff shimmer') {
    return (
      `buff shimmer — ${g('tremolo', 'gentle')} tremolo lifting ` +
      `${fmt1(g('rise_oct', 0))} octaves from ${g('base_hz', 0)} Hz`
    );
  }
  if (s === 'potion glug') {
    return `potion glug — ${g('glugs', 0)} ${g('pour', 'thin')} gulps stepping up from ${g('start_hz', 0)} Hz`;
  }
  if (s === 'level-up fanfare') {
    return (
      `level-up fanfare — ${g('notes', 0)}-note major climb from ` +
      `${g('root_hz', 0)} Hz, ${g('finish', 'clean hold')}`
    );
  }
  if (s === 'quest stinger') {
    return (
      `quest stinger — ${g('voice', 'warm')} pickup into a ` +
      `${g('chord', 0)}-note chord roll on ${g('root_hz', 0)} Hz`
    );
  }
  if (s === 'loot jingle') {
    return `loot jingle — ${g('coins', 0)} coins, ${g('spill', 'tight')} spill, tinkling up to ${g('top_hz', 0)} Hz`;
  }
  if (s === 'chest open') {
    return (
      `chest open — ${g('clicks', 0)}-click ${g('lock', 'bright')} unlock, ` +
      `${g('ping_hz', 0)} Hz ping, ${g('sparkles', 0)}-sparkle reveal`
    );
  }
  if (s === 'shield block') {
    return `shield block — ${g('response', 'flat block')} at ${g('hz', 0)} Hz, ${g('sustain', 'quick mute')}`;
  }
  if (s === 'trap spring') {
    return (
      `trap spring — ${g('snap', 'soft')} trigger click, ` +
      `${g('boing_hz', 0)} Hz boing wobbling at ${g('wobble_hz', 0)} Hz`
    );
  }
  if (s === 'teleport warp') {
    return (
      `teleport warp — ${g('direction', 'rising')} stepped gliss, ` +
      `${fmt1(g('span_oct', 0))} octaves from ${g('start_hz', 0)} Hz`
    );
  }
  if (s === 'game-over sting') {
    return `game-over sting — ${g('notes', 0)} ${g('wave', 'square')} notes sinking to ${g('end_hz', 0)} Hz`;
  }
  if (s === 'save chime') {
    return `save chime — ${g('interval', 'fifth')} up from ${g('hz', 0)} Hz, ${g('echo', 'dry')}`;
  }
  const extra = Object.keys(t)
    .filter((k) => k !== 'style')
    .sort()
    .map((k) => `${k} ${t[k]}`)
    .join(', ');
  return extra ? `${s} — ${extra}` : `${s} effect`;
}

/** Short phrase for the README category table. */
export const character = 'sword swings, spells, loot jingles, level-ups, warps, save chimes';
