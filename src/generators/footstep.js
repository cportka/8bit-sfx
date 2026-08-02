// footstep — one step, seven surfaces: a grass swish, a gravel crunch, a stone
// clack, a wood-plank knock, a snow crunch, a mud squelch and a puddle splash.
// Almost everything is built from `lpBurst`: one-pole lowpassed LFSR noise under
// a linear attack into an exponential decay. The surface is mostly in the filter
// coefficient and the decay rate — dark and slow for mud, bright and fast for
// stone — with a pitched layer (triangle knock, rising bloop) mixed on top where
// the material rings.
//
// Ported 1:1 from `gen_footstep` / `describe_footstep` in scripts/generate_sfx.py.
// The rng draw order below is the effect's identity — nothing may be added,
// removed, or reordered, or `footstep_042` stops being `footstep_042`. The traps
// here: `lpBurst` draws its Lfsr seed *after* every argument passed to it, and
// arguments written inline are drawn left to right at that position — so wood's
// heel-toe offset is drawn *after* that burst's own parameters and seed, and
// snow's `Lfsr(rng, rng.randint(5, 9))` draws the period before the seed. The
// tail post-processing — clamp, a *random* normalization target, and a fade-out
// only (no fade-in, no DC blocker) — is the Python's own, not `finish()`.

import { SR, Lfsr, midi, renderTone, decay, mixAt } from '../dsp.js';

/** Python's round(): half-to-even on the exact value, returning an integer. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Python's round(x, 1). `toFixed` is exact and only breaks *ties* differently,
 * and a one-decimal tie (k + 0.05 = (2k+1)/20) is never a binary fraction — so
 * no tie can occur and this equals CPython's correctly-rounded result.
 */
function round1(x) {
  return Number(x.toFixed(1));
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice(['grass', 'gravel', 'stone', 'wood', 'snow', 'mud', 'puddle']);

  // one-pole lowpassed LFSR noise shaped by an attack/decay envelope
  const lpBurst = (n, period, alpha, atk, rate, gain) => {
    const noise = new Lfsr(rng, period);
    const out = [];
    let prev = 0.0;
    const invAtk = 1.0 / Math.max(atk, 1e-4);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      prev += alpha * (noise.next() - prev);
      const env = Math.min(1.0, t * invAtk) * Math.exp(-rate * t);
      out.push(prev * env * gain);
    }
    return out;
  };

  let out;
  let tags;

  if (style === 'grass') {
    // soft swish: dark filtered hiss, sometimes a fainter toe-drag behind it
    const dur = rng.uniform(0.08, 0.18);
    const n = Math.trunc(dur * SR);
    const period = rng.randint(1, 2);
    const alpha = rng.uniform(0.22, 0.4);
    const atk = rng.uniform(0.004, 0.012);
    const rate = rng.uniform(25.0, 45.0);
    out = lpBurst(n, period, alpha, atk, rate, 1.0);
    const hasDrag = rng.random() < 0.5;
    if (hasDrag) {
      const off = Math.trunc(rng.uniform(0.35, 0.6) * n);
      mixAt(
        out,
        lpBurst(n - off, 2, rng.uniform(0.15, 0.3), 0.006, rng.uniform(35.0, 60.0), rng.uniform(0.3, 0.55)),
        off
      );
    }
    tags = {
      style: 'grass',
      texture: alpha > 0.31 ? 'rustling' : 'hushed',
      drag: hasDrag ? 'toe-drag behind' : 'clean single swish',
      attack_ms: pyRound(atk * 1000),
    };
  } else if (style === 'gravel') {
    // a low thud plus a scatter of tiny crunchy ticks
    const dur = rng.uniform(0.1, 0.24);
    const n = Math.trunc(dur * SR);
    out = new Array(n).fill(0.0);
    const thudAlpha = rng.uniform(0.06, 0.12);
    const thudRate = rng.uniform(30.0, 50.0);
    const thudGain = rng.uniform(0.5, 0.8);
    mixAt(out, lpBurst(Math.trunc(0.6 * n), 3, thudAlpha, 0.002, thudRate, thudGain), 0);
    const nTicks = rng.randint(4, 9);
    for (let k = 0; k < nTicks; k++) {
      const off = k === 0 ? 0 : Math.trunc(rng.uniform(0.0, 0.75) * n);
      const ln = Math.trunc(SR * rng.uniform(0.006, 0.018));
      mixAt(
        out,
        lpBurst(ln, rng.randint(2, 6), rng.uniform(0.5, 0.85), 0.0005, rng.uniform(150.0, 350.0), rng.uniform(0.5, 1.0)),
        off
      );
    }
    tags = {
      style: 'gravel',
      thud: thudGain > 0.65 ? 'heavy' : 'light',
      body: thudRate > 40.0 ? 'tight' : 'boomy',
      ticks: nTicks,
    };
  } else if (style === 'stone') {
    // hard bright clack with a short tonal tick on impact
    const dur = rng.uniform(0.05, 0.11);
    const n = Math.trunc(dur * SR);
    const period = rng.randint(1, 2);
    const alpha = rng.uniform(0.55, 0.85);
    const rate = rng.uniform(70.0, 130.0);
    out = lpBurst(n, period, alpha, 0.0005, rate, 1.0);
    const f = midi(rng.randint(70, 84));
    const g = rng.uniform(0.3, 0.5);
    const tick = renderTone(
      Math.min(n, Math.trunc(0.03 * SR)),
      () => f,
      rng.choice([0.125, 0.25]),
      decay(rng.uniform(120.0, 220.0))
    );
    mixAt(out, tick, 0, g);
    tags = {
      style: 'stone',
      clack: alpha > 0.7 ? 'glassy' : 'bright',
      tick: g > 0.4 ? 'clear' : 'faint',
      tick_hz: pyRound(f),
    };
  } else if (style === 'wood') {
    // plank knock: pitched triangle resonance under a bright tap, heel-toe clack
    const dur = rng.uniform(0.14, 0.3);
    const n = Math.trunc(dur * SR);
    const f0 = midi(rng.randint(43, 57));
    const drift = rng.uniform(0.05, 0.2);
    out = renderTone(n, (t) => f0 * (1.0 - (drift * t) / dur), 0.5, decay(rng.uniform(16.0, 30.0)), 'tri');
    const ratio = rng.uniform(2.7, 3.4);
    const g = rng.uniform(0.25, 0.45);
    const ovt = renderTone(
      n,
      (t) => f0 * ratio * (1.0 - (drift * t) / dur),
      rng.choice([0.125, 0.25]),
      decay(rng.uniform(50.0, 90.0))
    );
    mixAt(out, ovt, 0, g);
    mixAt(
      out,
      lpBurst(Math.trunc(0.012 * SR), 1, rng.uniform(0.5, 0.8), 0.0003, rng.uniform(200.0, 320.0), rng.uniform(0.4, 0.6)),
      0
    );
    const heelToe = rng.random() < 0.6;
    if (heelToe) {
      mixAt(
        out,
        lpBurst(Math.trunc(0.01 * SR), 1, rng.uniform(0.5, 0.8), 0.0003, 300.0, rng.uniform(0.25, 0.45)),
        Math.trunc(rng.uniform(0.3, 0.55) * n)
      );
    }
    tags = {
      style: 'wood',
      register: f0 < 147.0 ? 'low' : 'mid',
      overtone: g > 0.35 ? 'ringing' : 'subtle',
      taps: heelToe ? 'heel-toe double tap' : 'single tap',
      knock_hz: pyRound(f0),
    };
  } else if (style === 'snow') {
    // crunch: crunchy LFSR gated into crackle clusters by a slower LFSR
    const dur = rng.uniform(0.12, 0.28);
    const n = Math.trunc(dur * SR);
    const crunch = new Lfsr(rng, rng.randint(5, 9));
    const gatePeriod = rng.randint(60, 140);
    const gate = new Lfsr(rng, gatePeriod);
    const alpha = rng.uniform(0.35, 0.6);
    const atk = rng.uniform(0.015, 0.045);
    const rate = rng.uniform(11.0, 20.0);
    const floor = rng.uniform(0.15, 0.35);
    out = [];
    let prev = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      prev += alpha * (crunch.next() - prev);
      const g = gate.next() > 0.0 ? 1.0 : floor;
      out.push(prev * g * Math.min(1.0, t / atk) * Math.exp(-rate * t));
    }
    tags = {
      style: 'snow',
      texture: alpha > 0.47 ? 'brittle' : 'packed',
      contrast: floor < 0.25 ? 'stark' : 'soft',
      crackle_hz: pyRound(SR / gatePeriod),
    };
  } else if (style === 'mud') {
    // squish: very dark noise plus a wobbling low triangle sinking in pitch
    const dur = rng.uniform(0.16, 0.3);
    const n = Math.trunc(dur * SR);
    out = lpBurst(n, rng.randint(2, 4), rng.uniform(0.06, 0.13), rng.uniform(0.02, 0.045), rng.uniform(9.0, 16.0), 1.0);
    const f0 = rng.uniform(midi(38), midi(46));
    const wob = rng.uniform(40.0, 90.0);
    const depth = rng.uniform(0.1, 0.25);
    const rate = rng.uniform(8.0, 14.0);
    const g = rng.uniform(0.4, 0.7);
    const sw = renderTone(
      n,
      (t) => f0 * (1.0 - (0.4 * t) / dur) * (1.0 + depth * Math.sin(wob * t)),
      0.5,
      (t) => Math.min(1.0, t / 0.03) * Math.exp(-rate * t),
      'tri'
    );
    mixAt(out, sw, 0, g);
    tags = {
      style: 'mud',
      wobble: depth > 0.175 ? 'queasy' : 'gentle',
      weight: g > 0.55 ? 'thick' : 'watery',
      tone_hz: pyRound(f0),
    };
  } else {
    // splash: bright wet noise plus a small rising triangle bloop
    const dur = rng.uniform(0.1, 0.2);
    const n = Math.trunc(dur * SR);
    const period = rng.randint(1, 2);
    const alpha = rng.uniform(0.45, 0.75);
    const atk = rng.uniform(0.001, 0.004);
    const rate = rng.uniform(25.0, 45.0);
    out = lpBurst(n, period, alpha, atk, rate, 1.0);
    const f0 = midi(rng.randint(55, 65));
    const riseoct = rng.uniform(0.6, 1.2);
    const blDur = rng.uniform(0.04, 0.08);
    const bn = Math.trunc(blDur * SR);
    const g = rng.uniform(0.45, 0.75);
    const blip = renderTone(
      bn,
      (t) => f0 * Math.pow(2.0, (riseoct * t) / blDur),
      0.5,
      decay(rng.uniform(30.0, 55.0)),
      'tri'
    );
    const off = Math.min(Math.trunc(rng.uniform(0.01, 0.05) * SR), Math.max(0, n - bn));
    mixAt(out, blip, off, g);
    tags = {
      style: 'puddle',
      splash: alpha > 0.6 ? 'fizzy' : 'wet',
      bloop: g > 0.6 ? 'plopping' : 'soft',
      bloop_hz: pyRound(f0),
      rise_oct: round1(riseoct),
    };
  }

  rng.tags = tags;

  // normalize to a healthy chip level, clamp, and fade the tail to zero
  let peak = 0.0;
  for (const s of out) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const scale = peak > 1e-6 ? rng.uniform(0.8, 0.95) / peak : 1.0;
  const total = out.length;
  const fade = Math.max(1, Math.min(Math.floor(total / 8), Math.trunc(0.004 * SR)));
  for (let i = 0; i < total; i++) {
    let s = out[i] * scale;
    if (s > 1.0) s = 1.0;
    else if (s < -1.0) s = -1.0;
    const rem = total - i;
    if (rem <= fade) s *= rem / fade;
    out[i] = s;
  }
  return out;
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const style = t.style;
  if (style === 'grass') {
    return `grass-swish step — ${t.texture || 'hushed'} hiss, ${t.drag || 'clean single swish'}, ${t.attack_ms | 0} ms attack`;
  }
  if (style === 'gravel') {
    return `gravel-crunch step — ${t.thud || 'light'} thud, ${t.body || 'tight'} body, ${t.ticks | 0} scattered ticks`;
  }
  if (style === 'stone') {
    return `stone-clack step — ${t.clack || 'bright'} attack, ${t.tick || 'faint'} ${t.tick_hz | 0} Hz impact tick`;
  }
  if (style === 'wood') {
    return `wood-plank step — ${t.register || 'mid'} ${t.knock_hz | 0} Hz knock, ${t.overtone || 'subtle'} overtone, ${t.taps || 'single tap'}`;
  }
  if (style === 'snow') {
    return `snow-crunch step — ${t.texture || 'packed'} grain, ${t.contrast || 'soft'} crackle clusters near ${t.crackle_hz | 0} Hz`;
  }
  if (style === 'mud') {
    return `mud-squish step — ${t.weight || 'watery'} squelch, ${t.wobble || 'gentle'} wobble on a sinking ${t.tone_hz | 0} Hz tone`;
  }
  return `puddle-splash step — ${t.splash || 'wet'} spray, ${t.bloop || 'soft'} ${t.bloop_hz | 0} Hz bloop rising ${Number(t.rise_oct || 0).toFixed(1)} oct`;
}

/** Short phrase for the README category table. */
export const character = 'steps on grass, gravel, stone, wood, snow, mud, puddles';
