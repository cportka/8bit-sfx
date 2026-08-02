// fire — chip-imitation combustion: campfire crackle beds, ignition whooshes,
// torch flutter, frying sizzle, explosive pops, glowing embers and flare-ups.
// Two shared primitives carry every sub-style: `flickerEnv`, a sample-and-hold
// random target smoothed by a one-pole so the flame breathes instead of
// stuttering, and `addPop`, a bright LFSR click that 60% of the time drags a
// pitch-dropping triangle thump along behind it.
//
// Ported 1:1 from `gen_fire` / `describe_fire` in scripts/generate_sfx.py.
// The rng draw order below is the effect's identity — nothing may be added,
// removed, or reordered, or `fire_042` stops being `fire_042`. The traps here:
// three warm-up `random()` draws precede the style pick; `addPop` draws its
// LFSR *period* before the Lfsr constructor draws its seed (Python evaluates
// call arguments left to right, and so does JS); the `for _ in range(rng.
// randint(...))` loops draw their count exactly once; and the tail is the
// Python's own edge fades plus a *random* normalization target with a hard
// clamp — deliberately not `finish()`, which would normalize to a fixed 0.9.
//
// The Python describer only had to separate 100 variations, so its tags were
// coarse (two-word buckets). `rng.tags` below carries the *measured* synthesis
// values as well — one-pole corner frequencies, LFSR clock rates, pop pitches
// and spacing — all derived from numbers the generator already drew. Recording
// them costs no rng draw and touches no sample: the audio is byte-identical.

import { SR, Lfsr, noteOfHz, square, triangle } from '../dsp.js';

/** Python's round(): half-to-even on the exact value, returning an integer. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Round to one decimal (catalog-friendly, and enough to separate variations). */
function round1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * -3 dB corner of the one-pole `y += a * (x - y)` smoother every style runs its
 * LFSR noise through: how dark the crackle bed reads, in Hz.
 */
function cornerHz(a) {
  return (-Math.log(1 - a) * SR) / (2 * Math.PI);
}

/** Sample-and-hold noise clock (`Lfsr` period in samples) as kHz of grain. */
function grainKhz(period) {
  return round1(SR / period / 1000);
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  // sample-and-hold random target, one-pole smoothed: slow fire flicker
  const flickerEnv = (n, holdLo, holdHi, lo, hi, smooth) => {
    const env = new Array(n);
    let y = rng.uniform(lo, hi);
    let target = y;
    let countdown = 0;
    for (let i = 0; i < n; i++) {
      if (countdown <= 0) {
        target = rng.uniform(lo, hi);
        countdown = rng.randint(holdLo, holdHi);
      }
      countdown -= 1;
      y += smooth * (target - y);
      env[i] = y;
    }
    return env;
  };

  // every pop this variation fires, for the describer: {t, amp, click, thump}.
  // Written after the draws that produce each value — pure metadata, no draws.
  const popLog = [];

  // bright noise click, sometimes with a low pitch-dropping thump
  const addPop = (buf, pos, amp) => {
    const nlen = Math.trunc(SR * rng.uniform(0.005, 0.022));
    const lf = new Lfsr(rng, rng.randint(1, 2));
    const rate = rng.uniform(250.0, 700.0);
    const log = { t: pos / SR, amp, click: rate, thump: null };
    popLog.push(log);
    for (let i = 0; i < nlen; i++) {
      const j = pos + i;
      if (j >= buf.length) break;
      buf[j] += amp * lf.next() * Math.exp((-rate * i) / SR);
    }
    if (rng.random() < 0.6) {
      const f0 = rng.uniform(110.0, 420.0);
      log.thump = f0;
      const plen = Math.trunc(SR * rng.uniform(0.012, 0.035));
      let ph = 0.0;
      for (let i = 0; i < plen; i++) {
        const j = pos + i;
        if (j >= buf.length) break;
        const t = i / SR;
        ph += (f0 * Math.exp(-16.0 * t)) / SR;
        buf[j] += 0.9 * amp * triangle(ph) * Math.exp(-90.0 * t);
      }
    }
  };

  // --- describer helpers over popLog: read-only, called after synthesis ---
  /** Pitch of the deepest thump any pop dragged along, or null if all dry. */
  const deepestThump = () => {
    const th = popLog.map((p) => p.thump).filter((f) => f !== null);
    return th.length ? Math.min(...th) : null;
  };
  /** How the pop hits sit in time: one gap, an even train, or clumped. */
  const popSpacing = () => {
    const ts = popLog.map((p) => p.t).sort((x, y) => x - y);
    if (ts.length < 3) return 'paired';
    const gaps = ts.slice(1).map((t, i) => t - ts[i]);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (mean <= 0) return 'stacked';
    return (Math.max(...gaps) - Math.min(...gaps)) / mean < 0.6 ? 'evenly spaced' : 'clustered';
  };

  // a few warm-up draws so poorly-mixed small seeds still spread the style pick
  for (let i = 0; i < 3; i++) rng.random();
  const style = rng.choice(['campfire', 'ignition', 'torch', 'sizzle', 'pops', 'ember', 'flare']);

  let buf;
  let tags;

  if (style === 'campfire') {
    // steady crackle bed, medium crunch, scattered small pops
    const dur = rng.uniform(1.3, 2.5);
    const n = Math.trunc(SR * dur);
    buf = new Array(n).fill(0.0);
    const per = rng.randint(3, 6);
    const lf = new Lfsr(rng, per);
    const a = rng.uniform(0.12, 0.3);
    const fl = flickerEnv(n, Math.trunc(0.03 * SR), Math.trunc(0.09 * SR), 0.2, 1.0, 0.002);
    let y = 0.0;
    for (let i = 0; i < n; i++) {
      y += a * (lf.next() - y);
      buf[i] = y * fl[i] * 0.9;
    }
    const npops = rng.randint(Math.trunc(dur * 3), Math.trunc(dur * 9));
    for (let p = 0; p < npops; p++) {
      const pos = rng.randint(0, n - Math.trunc(0.03 * SR) - 1);
      addPop(buf, pos, rng.uniform(0.35, 1.0));
    }
    tags = {
      style: 'campfire',
      texture: a < 0.21 ? 'muffled' : 'crisp',
      density: npops / dur < 6.0 ? 'scattered' : 'busy',
      pops: npops,
      pops_per_s: round1(npops / dur),
      bed_hz: pyRound(cornerHz(a)),
      grain_khz: grainKhz(per),
      thump_note: deepestThump() === null ? null : noteOfHz(deepestThump()),
    };
  } else if (style === 'ignition') {
    // whoosh: noise brightening as it swells, plus a rising triangle rumble
    const dur = rng.uniform(0.5, 1.2);
    const n = Math.trunc(SR * dur);
    buf = new Array(n).fill(0.0);
    const lf = new Lfsr(rng, 1);
    const rise = rng.uniform(0.15, 0.4) * dur;
    const drate = rng.uniform(2.5, 5.0) / dur;
    const a0 = 0.04;
    const a1 = rng.uniform(0.5, 0.9);
    let y = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const u = Math.min(1.0, t / rise);
      y += (a0 + (a1 - a0) * u * u) * (lf.next() - y);
      const env = t < rise ? u : Math.exp(-drate * (t - rise));
      buf[i] = y * env;
    }
    const f0 = rng.uniform(50.0, 110.0);
    const mult = rng.uniform(2.0, 5.0);
    const rumb = rng.uniform(0.25, 0.45);
    let ph = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (f0 * (1.0 + mult * Math.min(1.0, t / (dur * 0.7)))) / SR;
      const env = Math.min(1.0, t / rise) * Math.exp(-drate * Math.max(0.0, t - rise));
      buf[i] += rumb * triangle(ph) * env;
    }
    const lo = Math.trunc(n * 0.55);
    const hi = Math.max(lo + 1, n - Math.trunc(0.03 * SR) - 1);
    const npops = rng.randint(1, 4);
    for (let p = 0; p < npops; p++) {
      addPop(buf, rng.randint(lo, hi), rng.uniform(0.25, 0.6));
    }
    tags = {
      style: 'ignition',
      attack: rise / dur < 0.28 ? 'fast' : 'slow',
      rumble_hz: pyRound(f0),
      pops: npops,
      rumble_note: noteOfHz(f0),
      top_hz: pyRound(f0 * (1.0 + mult)),
      top_note: noteOfHz(f0 * (1.0 + mult)),
      bite: a1 < 0.7 ? 'soft' : 'searing',
    };
  } else if (style === 'torch') {
    // sustained flutter: noise pumped by an irregular 8-16 Hz wobble + soft drone
    const dur = rng.uniform(0.8, 2.0);
    const n = Math.trunc(SR * dur);
    buf = new Array(n).fill(0.0);
    const per = rng.randint(2, 4);
    const lf = new Lfsr(rng, per);
    const a = rng.uniform(0.2, 0.45);
    const rate = rng.uniform(8.0, 16.0);
    const depth = rng.uniform(0.3, 0.5);
    const jit = flickerEnv(n, Math.trunc(0.05 * SR), Math.trunc(0.15 * SR), -1.0, 1.0, 0.001);
    const f0 = rng.uniform(50.0, 90.0);
    const vib = rng.uniform(3.0, 6.0);
    let y = 0.0;
    let dph = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const flut = 1.0 - depth + depth * Math.sin(2.0 * Math.PI * rate * t + 2.0 * jit[i]);
      y += a * (lf.next() - y);
      dph += (f0 * (1.0 + 0.02 * Math.sin(2.0 * Math.PI * vib * t))) / SR;
      buf[i] = y * flut * 0.85 + 0.18 * triangle(dph) * flut;
    }
    const nticks = rng.randint(0, 3);
    for (let p = 0; p < nticks; p++) {
      const pos = rng.randint(0, n - Math.trunc(0.03 * SR) - 1);
      addPop(buf, pos, rng.uniform(0.15, 0.35));
    }
    tags = {
      style: 'torch',
      flutter_hz: round1(rate),
      wobble: depth < 0.4 ? 'gentle' : 'deep',
      drone_hz: pyRound(f0),
      drone_note: noteOfHz(f0),
      vibrato_hz: round1(vib),
      body: a < 0.32 ? 'airy' : 'thick',
      grain_khz: grainKhz(per),
      ticks: nticks,
    };
  } else if (style === 'sizzle') {
    // frying hiss: brightest noise chopped by dense random micro-gates
    const dur = rng.uniform(0.6, 1.7);
    const n = Math.trunc(SR * dur);
    buf = new Array(n).fill(0.0);
    const lf = new Lfsr(rng, 1);
    const drate = rng.uniform(0.5, 1.4);
    const dense = rng.uniform(0.45, 0.8);
    let gate = 0.0;
    let gtarget = 0.0;
    let hold = 0;
    for (let i = 0; i < n; i++) {
      if (hold <= 0) {
        hold = rng.randint(Math.trunc(0.002 * SR), Math.trunc(0.009 * SR));
        if (rng.random() < dense) {
          gtarget = rng.uniform(0.5, 1.0);
        } else {
          gtarget = rng.uniform(0.0, 0.12);
        }
      }
      hold -= 1;
      gate += 0.01 * (gtarget - gate);
      buf[i] = lf.next() * gate * Math.exp((-drate * i) / SR) * 0.9;
    }
    const npops = rng.randint(2, 6);
    for (let p = 0; p < npops; p++) {
      const pos = rng.randint(0, n - Math.trunc(0.03 * SR) - 1);
      addPop(buf, pos, rng.uniform(0.2, 0.5));
    }
    tags = {
      style: 'sizzle',
      gating: dense < 0.62 ? 'patchy' : 'relentless',
      heat: drate < 0.95 ? 'steady' : 'dying',
      pops: npops,
      open_pct: pyRound(dense * 100.0),
      fade_db_s: round1(drate * 8.685889638065035), // exp rate -> dB per second
      spit_note: deepestThump() === null ? null : noteOfHz(deepestThump()),
    };
  } else if (style === 'pops') {
    // sparse big explosive pops over a quiet, dark crackle bed
    const dur = rng.uniform(0.6, 1.5);
    const n = Math.trunc(SR * dur);
    buf = new Array(n).fill(0.0);
    const per = rng.randint(4, 7);
    const lf = new Lfsr(rng, per);
    const a = rng.uniform(0.1, 0.25);
    const fl = flickerEnv(n, Math.trunc(0.02 * SR), Math.trunc(0.07 * SR), 0.1, 0.5, 0.003);
    let y = 0.0;
    for (let i = 0; i < n; i++) {
      y += a * (lf.next() - y);
      buf[i] = y * fl[i];
    }
    const k = rng.randint(2, 5);
    for (let j = 0; j < k; j++) {
      const frac = (j + rng.uniform(0.05, 0.9)) / k;
      const pos = Math.min(n - Math.trunc(0.04 * SR) - 1, Math.trunc(n * frac));
      addPop(buf, Math.max(0, pos), rng.uniform(0.8, 1.4));
    }
    tags = {
      style: 'pops',
      bursts: k,
      bed: a < 0.175 ? 'faint' : 'grainy',
      bed_hz: pyRound(cornerHz(a)),
      grain_khz: grainKhz(per),
      spacing: popSpacing(),
      thump_note: deepestThump() === null ? null : noteOfHz(deepestThump()),
    };
  } else if (style === 'ember') {
    // glowing embers: very crunchy slow noise, gentle flicker, tiny ticks
    const dur = rng.uniform(1.0, 2.3);
    const n = Math.trunc(SR * dur);
    buf = new Array(n).fill(0.0);
    const per = rng.randint(6, 10);
    const lf = new Lfsr(rng, per);
    const a = rng.uniform(0.05, 0.12);
    const fl = flickerEnv(n, Math.trunc(0.06 * SR), Math.trunc(0.18 * SR), 0.3, 1.0, 0.0012);
    let y = 0.0;
    for (let i = 0; i < n; i++) {
      y += a * (lf.next() - y);
      buf[i] = y * fl[i];
    }
    const npops = rng.randint(2, 6);
    for (let p = 0; p < npops; p++) {
      const pos = rng.randint(0, n - Math.trunc(0.03 * SR) - 1);
      addPop(buf, pos, rng.uniform(0.15, 0.4));
    }
    tags = {
      style: 'ember',
      texture: per < 8 ? 'gritty' : 'coarse',
      glow: a < 0.085 ? 'dim' : 'lively',
      ticks: npops,
      grain_khz: grainKhz(per),
      glow_hz: pyRound(cornerHz(a)),
      tick_note: deepestThump() === null ? null : noteOfHz(deepestThump()),
    };
  } else {
    // flare: crackle swells to a burst with a down-swept square growl
    const dur = rng.uniform(0.8, 1.8);
    const n = Math.trunc(SR * dur);
    buf = new Array(n).fill(0.0);
    const per = rng.randint(2, 5);
    const lf = new Lfsr(rng, per);
    const a = rng.uniform(0.15, 0.35);
    const peakAt = rng.uniform(0.35, 0.6);
    const krel = rng.uniform(3.0, 6.0) / (1.0 - peakAt);
    const fl = flickerEnv(n, Math.trunc(0.02 * SR), Math.trunc(0.06 * SR), 0.4, 1.0, 0.003);
    let y = 0.0;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      let env;
      if (u < peakAt) {
        env = 0.2 + 0.8 * Math.pow(u / peakAt, 2);
      } else {
        env = Math.exp(-krel * (u - peakAt));
      }
      y += a * (lf.next() - y);
      buf[i] = y * fl[i] * env;
    }
    const ppos = Math.trunc(n * peakAt);
    addPop(buf, ppos, rng.uniform(0.9, 1.3));
    const f0 = rng.uniform(200.0, 500.0);
    const duty = rng.choice([0.125, 0.25]);
    const glen = Math.trunc(SR * rng.uniform(0.08, 0.2));
    let ph = 0.0;
    for (let i = 0; i < glen; i++) {
      const j = ppos + i;
      if (j >= n) break;
      const t = i / SR;
      ph += (f0 * Math.exp(-8.0 * t)) / SR;
      buf[j] += 0.6 * square(ph, duty) * Math.exp(-25.0 * t);
    }
    const hi = n - Math.trunc(0.03 * SR) - 1;
    const nlate = rng.randint(1, 3);
    for (let p = 0; p < nlate; p++) {
      addPop(buf, rng.randint(Math.min(ppos, hi - 1), hi), rng.uniform(0.3, 0.7));
    }
    tags = {
      style: 'flare',
      peak: peakAt < 0.48 ? 'early' : 'late',
      growl: duty === 0.125 ? 'reedy' : 'hollow',
      growl_hz: pyRound(f0),
      growl_note: noteOfHz(f0),
      peak_pct: pyRound(peakAt * 100.0),
      bed_hz: pyRound(cornerHz(a)),
      grain_khz: grainKhz(per),
      after_pops: nlate,
    };
  }

  rng.tags = tags;

  // master: short fade-in, click-free fade-out, then normalize and clamp
  const n = buf.length;
  const fin = Math.min(Math.trunc(0.004 * SR), Math.floor(n / 4));
  const fout = Math.min(Math.trunc(0.03 * SR), Math.floor(n / 4));
  for (let i = 0; i < fin; i++) buf[i] *= i / Math.max(1, fin);
  for (let i = 0; i < fout; i++) buf[n - 1 - i] *= i / Math.max(1, fout);
  let peak = 0.0;
  for (const v of buf) {
    const av = Math.abs(v);
    if (av > peak) peak = av;
  }
  if (peak < 1e-6) peak = 1.0;
  const g = rng.uniform(0.75, 0.92) / peak;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let v = buf[i] * g;
    if (v > 1.0) v = 1.0;
    else if (v < -1.0) v = -1.0;
    out[i] = v;
  }
  return out;
}

/**
 * Catalog blurb from the tags gen() recorded.
 *
 * Every clause is a property you can shop on — where the noise bed rolls off,
 * how fast the flame flutters, what pitch the thumps land on, how many hits
 * and how quickly they come — so two variations of the same sub-style read
 * differently. Duration is deliberately absent: the catalog carries it.
 */
export function describe(tags) {
  const t = tags || {};
  const get = (k, d) => (t[k] === undefined || t[k] === null ? d : t[k]);
  const cnt = (n, word) => (n === 1 ? `${n} ${word}` : `${n} ${word}s`);
  /** "no ticks" reads better than "0 ticks" in a shopping list. */
  const cntOr = (n, word, none) => (n === 0 ? none : cnt(n, word));

  const style = get('style', 'fire');
  if (style === 'campfire') {
    const pops = get('pops', 4);
    return (
      `campfire crackle — ${get('texture', 'crisp')} bed near ${get('bed_hz', 700)} Hz, ` +
      `${get('density', 'scattered')} ${cnt(pops, 'pop')} at ${get('pops_per_s', 5)}/s`
    );
  }
  if (style === 'ignition') {
    return (
      `ignition whoosh — ${get('attack', 'fast')} ${get('bite', 'searing')} swell, rumble ` +
      `${get('rumble_note', 'B1')}→${get('top_note', 'E3')} ` +
      `(${get('rumble_hz', 80)}→${get('top_hz', 240)} Hz), ${cnt(get('pops', 2), 'pop')}`
    );
  }
  if (style === 'torch') {
    return (
      `torch flutter — ${get('wobble', 'gentle')} ${get('flutter_hz', 12)} Hz flame over a ` +
      `${get('drone_note', 'C2')} drone at ${get('drone_hz', 70)} Hz, ` +
      `${cntOr(get('ticks', 1), 'tick', 'no ticks')}`
    );
  }
  if (style === 'sizzle') {
    return (
      `frying sizzle — micro-gates ${get('open_pct', 60)}% open, ` +
      `${get('heat', 'steady')} heat fading ${get('fade_db_s', 8)} dB/s, ` +
      `${cnt(get('pops', 3), 'oil spit')}`
    );
  }
  if (style === 'pops') {
    const thump = get('thump_note', null);
    return (
      `fire pops — ${get('bursts', 3)} ${get('spacing', 'evenly spaced')} bursts, ` +
      `${thump ? `${thump} thumps` : 'dry clicks'}, ` +
      `${get('bed', 'faint')} bed near ${get('bed_hz', 500)} Hz`
    );
  }
  if (style === 'ember') {
    return (
      `glowing embers — ${get('texture', 'gritty')} ${get('grain_khz', 3)} kHz grain, ` +
      `${get('glow', 'dim')} ${get('glow_hz', 250)} Hz glow, ` +
      `${cnt(get('ticks', 3), 'tick')}`
    );
  }
  if (style === 'flare') {
    return (
      `flare-up — peaks ${get('peak_pct', 50)}% in, ${get('growl', 'hollow')} growl from ` +
      `${get('growl_note', 'E4')} (${get('growl_hz', 300)} Hz), ` +
      `${cnt(get('after_pops', 1), 'after-pop')}`
    );
  }
  return `${style} fire effect — unclassified crackle-and-hiss variant`;
}

/** Short phrase for the README category table. */
export const character = 'crackling campfires, ignition whooshes, torch flutter, sizzles, ember pops';
