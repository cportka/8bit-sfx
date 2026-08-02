// water — chip-imitation liquid: cave drips, small and big splashes, steady
// pours, babbling streams, dive splashdowns and underwater blubs. Two shared
// primitives do all the work: `droplet`, a triangle "plip" that glides between
// two frequencies under a power-law decay, and `wash`, a one-pole lowpassed
// LFSR burst with an optional sample-and-hold "gurgle" that makes the bigger
// bodies churn instead of hiss.
//
// Ported 1:1 from `gen_water` / `describe_water` in scripts/generate_sfx.py.
// The rng draw order below is the effect's identity — nothing may be added,
// removed, or reordered, or `water_042` stops being `water_042`. Two traps in
// particular: `wash` always draws its Lfsr seed *and* its gurgle step size even
// when gurgle is off, and every parameter written as a call argument is drawn
// left to right at that position (the splash offset before the wash's own
// draws). The tail post-processing — DC blocker, edge fades, then a *random*
// normalization target — is likewise the Python's own, not `finish()`.

import { SR, Lfsr, square, triangle, mixAt } from '../dsp.js';

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
  const style = rng.choice(['drip', 'small_splash', 'big_splash', 'pour', 'stream', 'dive', 'blub']);

  const buf = [];

  const mix = (pos, samples, gain = 1.0) => mixAt(buf, samples, pos, gain);

  const padTo = (n) => {
    while (buf.length < n) buf.push(0.0);
  };

  // tri "plip": pitch glides f0 -> f1, fast attack, power-decay to zero
  const droplet = (dur, f0, f1, amp, wob = 0.0) => {
    const n = Math.max(8, Math.trunc(dur * SR));
    const out = new Array(n);
    let ph = 0.0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      let f = f0 * Math.pow(f1 / f0, u);
      if (wob) f *= 1.0 + wob * Math.sin((2.0 * Math.PI * 27.0 * i) / SR);
      ph += f / SR;
      const env = Math.min(1.0, i / (0.004 * SR)) * Math.pow(1.0 - u, 1.7);
      out[i] = triangle(ph) * env * amp;
    }
    return out;
  };

  // one-pole lowpassed LFSR burst with exp decay; optional s&h "gurgle"
  // level-wobble (smoothed by hand) so bigger washes churn instead of hiss
  const wash = (dur, period, lp, rate, amp, gurgle = 0.0) => {
    const n = Math.max(8, Math.trunc(dur * SR));
    const noise = new Lfsr(rng, period);
    const step = Math.max(1, Math.trunc(rng.uniform(0.02, 0.05) * SR));
    const out = new Array(n);
    let y = 0.0;
    let g = 1.0;
    let gt = 1.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      y += lp * (noise.next() - y);
      if (gurgle) {
        if (i % step === 0) gt = 1.0 - gurgle * rng.random();
        g += 0.002 * (gt - g);
      }
      const env = Math.min(1.0, i / (0.003 * SR)) * Math.exp(-rate * t);
      out[i] = y * env * amp * g;
    }
    return out;
  };

  let tags;

  if (style === 'drip') {
    // tiny noise tick + upward tri plip, sometimes with a fainter echo drip
    const f0 = rng.uniform(300.0, 700.0);
    const f1 = f0 * rng.uniform(1.9, 3.4);
    const d = rng.uniform(0.06, 0.11);
    mix(0, wash(rng.uniform(0.008, 0.02), 1, 0.6, 90.0, 0.5));
    mix(Math.trunc(0.004 * SR), droplet(d, f0, f1, 1.0));
    const echo = rng.random() < 0.55;
    if (echo) {
      const gap = rng.uniform(0.07, 0.16);
      mix(
        Math.trunc((0.004 + d + gap) * SR),
        droplet(
          d * rng.uniform(0.6, 0.9),
          f0 * rng.uniform(1.05, 1.3),
          f1 * rng.uniform(1.05, 1.3),
          rng.uniform(0.3, 0.55),
        ),
      );
    }
    padTo(Math.trunc(rng.uniform(0.18, 0.4) * SR));
    tags = {
      style: 'drip',
      plip_hz: pyRound(f0),
      rise: round1(f1 / f0),
      echo: echo ? 'echoing' : 'single',
    };
  } else if (style === 'small_splash') {
    // bright short wash + low thunk + a couple of spray droplets
    const d = rng.uniform(0.18, 0.32);
    const wper = rng.choice([1, 1, 2]);
    const wlp = rng.uniform(0.25, 0.45);
    const wrate = rng.uniform(14.0, 22.0);
    mix(0, wash(d, wper, wlp, wrate, 1.0));
    const td = rng.uniform(0.05, 0.09);
    const tf0 = rng.uniform(180.0, 320.0);
    const tf1 = rng.uniform(90.0, 150.0);
    mix(0, droplet(td, tf0, tf1, 0.7));
    const sprays = rng.randint(1, 3);
    for (let s = 0; s < sprays; s++) {
      const pos = Math.trunc(rng.uniform(0.35, 0.9) * d * SR);
      const fd = rng.uniform(500.0, 1100.0);
      mix(
        pos,
        droplet(rng.uniform(0.03, 0.06), fd, fd * rng.uniform(1.6, 2.6), rng.uniform(0.2, 0.45)),
      );
    }
    padTo(Math.trunc((d + 0.05) * SR));
    tags = {
      style: 'small_splash',
      thunk_hz: pyRound(tf0),
      sprays,
      texture: wlp > 0.35 ? 'bright' : 'soft',
    };
  } else if (style === 'big_splash') {
    // body thump + long churning wash + secondary slosh + rain-back drops
    const d = rng.uniform(0.55, 1.0);
    const td = rng.uniform(0.08, 0.14);
    const tf0 = rng.uniform(110.0, 200.0);
    const tf1 = rng.uniform(45.0, 75.0);
    mix(0, droplet(td, tf0, tf1, 0.9));
    mix(
      0,
      wash(d, rng.choice([1, 2, 3]), rng.uniform(0.12, 0.3), rng.uniform(4.5, 8.0), 1.0, 0.5),
    );
    const slosh = rng.random() < 0.7;
    if (slosh) {
      // the offset is a call argument too — it is drawn *before* the wash's own
      const pos = Math.trunc(rng.uniform(0.3, 0.5) * d * SR);
      mix(pos, wash(d * 0.5, rng.choice([1, 2]), rng.uniform(0.2, 0.4), rng.uniform(8.0, 14.0), 0.5));
    }
    const drops = rng.randint(2, 5);
    for (let s = 0; s < drops; s++) {
      const pos = Math.trunc(rng.uniform(0.25, 0.85) * d * SR);
      const fd = rng.uniform(400.0, 1000.0);
      mix(
        pos,
        droplet(rng.uniform(0.04, 0.08), fd, fd * rng.uniform(1.7, 2.8), rng.uniform(0.15, 0.4)),
      );
    }
    padTo(Math.trunc((d + 0.08) * SR));
    tags = {
      style: 'big_splash',
      thump_hz: pyRound(tf0),
      drops,
      slosh: slosh ? 'double slosh' : 'single hit',
    };
  } else if (style === 'pour') {
    // sustained gurgling noise column with glug-bubbles riding on top
    const d = rng.uniform(1.1, 1.9);
    const n = Math.trunc(d * SR);
    const noise = new Lfsr(rng, rng.choice([1, 1, 2]));
    const lp = rng.uniform(0.12, 0.25);
    const atk = rng.uniform(0.06, 0.15);
    const rel = rng.uniform(0.12, 0.3);
    const wobf = rng.uniform(4.0, 8.0);
    const step = Math.max(1, Math.trunc(rng.uniform(0.025, 0.06) * SR));
    let y = 0.0;
    let g = 1.0;
    let gt = 1.0;
    const body = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      y += lp * (noise.next() - y);
      if (i % step === 0) gt = rng.uniform(0.55, 1.0);
      g += 0.0015 * (gt - g);
      let env = Math.min(1.0, t / atk) * Math.min(1.0, (d - t) / rel);
      env *= 0.8 + 0.2 * Math.sin(2.0 * Math.PI * wobf * t);
      body[i] = y * env * g;
    }
    mix(0, body);
    let glugs = 0;
    let t = rng.uniform(0.1, 0.3);
    while (t < d - 0.15) {
      const fb = rng.uniform(350.0, 900.0);
      mix(
        Math.trunc(t * SR),
        droplet(rng.uniform(0.03, 0.07), fb, fb * rng.uniform(1.5, 2.4), rng.uniform(0.2, 0.5)),
      );
      glugs += 1;
      t += rng.uniform(0.06, 0.2);
    }
    tags = {
      style: 'pour',
      glugs,
      body: lp > 0.18 ? 'hissy' : 'muffled',
      wobble_hz: round1(wobf),
    };
  } else if (style === 'stream') {
    // soft crunchy noise bed under many little rising (or sinking) bloops
    const d = rng.uniform(1.2, 1.9);
    const n = Math.trunc(d * SR);
    const per = rng.choice([2, 3, 4]);
    const noise = new Lfsr(rng, per);
    const lp = rng.uniform(0.08, 0.16);
    const wobf = rng.uniform(0.7, 1.8);
    let y = 0.0;
    const bed = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      y += lp * (noise.next() - y);
      let env = Math.min(1.0, t / 0.2) * Math.min(1.0, (d - t) / 0.25);
      env *= 0.8 + 0.2 * Math.sin(2.0 * Math.PI * wobf * t + 1.0);
      bed[i] = y * env * 0.5;
    }
    mix(0, bed);
    const bloops = rng.randint(7, 14);
    for (let s = 0; s < bloops; s++) {
      const pos = rng.uniform(0.05, d - 0.15);
      const fb = rng.uniform(220.0, 850.0);
      const ratio = rng.random() < 0.75 ? rng.uniform(1.4, 2.6) : rng.uniform(0.45, 0.7);
      mix(
        Math.trunc(pos * SR),
        droplet(rng.uniform(0.04, 0.1), fb, fb * ratio, rng.uniform(0.3, 0.7), rng.uniform(0.0, 0.05)),
      );
    }
    tags = {
      style: 'stream',
      bloops,
      bed: { 2: 'fine', 3: 'grainy', 4: 'crunchy' }[per],
      sway_hz: round1(wobf),
    };
  } else if (style === 'dive') {
    // falling whistle (DC-compensated square) into a churning impact wash
    const fall = rng.uniform(0.2, 0.45);
    const f0 = rng.uniform(900.0, 1600.0);
    const f1 = rng.uniform(150.0, 300.0);
    const duty = rng.choice([0.5, 0.5, 0.25]);
    const dc = 2.0 * duty - 1.0;
    const nf = Math.trunc(fall * SR);
    const whis = new Array(nf);
    let ph = 0.0;
    for (let i = 0; i < nf; i++) {
      const u = i / nf;
      ph += (f0 * Math.pow(f1 / f0, u)) / SR;
      let env = Math.min(1.0, i / (0.01 * SR)) * (1.0 - 0.35 * u);
      env *= Math.min(1.0, (nf - 1 - i) / (0.02 * SR));
      whis[i] = (square(ph, duty) - dc) * env * 0.5;
    }
    mix(0, whis);
    const splashAt = Math.max(0, nf - Math.trunc(0.02 * SR));
    const sd = rng.uniform(0.35, 0.6);
    mix(
      splashAt,
      wash(sd, rng.choice([1, 2]), rng.uniform(0.15, 0.35), rng.uniform(6.0, 11.0), 1.0, 0.4),
    );
    mix(splashAt, droplet(rng.uniform(0.06, 0.1), rng.uniform(130.0, 220.0), rng.uniform(50.0, 80.0), 0.8));
    const drops = rng.randint(1, 3);
    for (let s = 0; s < drops; s++) {
      const pos = splashAt + Math.trunc(rng.uniform(0.2, 0.7) * sd * SR);
      const fd = rng.uniform(450.0, 1000.0);
      mix(
        pos,
        droplet(rng.uniform(0.04, 0.07), fd, fd * rng.uniform(1.6, 2.5), rng.uniform(0.2, 0.4)),
      );
    }
    padTo(buf.length + Math.trunc(0.04 * SR));
    tags = {
      style: 'dive',
      whistle_hz: pyRound(f0),
      duty: duty === 0.25 ? 'thin' : 'full',
      drops,
    };
  } else {
    // blub — slow wobbly low glubs, optionally over a muffled deep bed
    const nblubs = rng.randint(3, 6);
    const base = rng.uniform(70.0, 130.0);
    let t = 0.02;
    for (let s = 0; s < nblubs; s++) {
      const fb = base * rng.uniform(0.85, 1.2);
      const bd = rng.uniform(0.07, 0.13);
      mix(
        Math.trunc(t * SR),
        droplet(bd, fb, fb * rng.uniform(1.6, 2.3), rng.uniform(0.6, 1.0), rng.uniform(0.04, 0.12)),
      );
      t += bd + rng.uniform(0.06, 0.18);
    }
    const bedded = rng.random() < 0.6;
    if (bedded) {
      const bedD = t + 0.03;
      mix(0, wash(bedD, rng.randint(6, 10), 0.25, 1.5 / bedD, 0.18, 0.6));
    }
    padTo(Math.trunc((t + 0.05) * SR));
    tags = {
      style: 'blub',
      blubs: nblubs,
      base_hz: pyRound(base),
      bed: bedded ? 'bedded' : 'dry',
    };
  }

  rng.tags = tags;

  // --- post: hand-rolled DC blocker, edge fades, peak normalize ------------
  const n = buf.length;
  const out = new Array(n);
  let px = 0.0;
  let py = 0.0;
  for (let i = 0; i < n; i++) {
    const s = buf[i];
    py = s - px + 0.9985 * py;
    px = s;
    out[i] = py;
  }
  const hf = Math.max(1, Math.trunc(0.002 * SR));
  const tf = Math.max(1, Math.trunc(0.012 * SR));
  for (let i = 0; i < Math.min(hf, n); i++) out[i] *= i / hf;
  for (let i = 0; i < Math.min(tf, n); i++) out[n - 1 - i] *= i / tf;
  let peak = 0.0;
  for (let i = 0; i < n; i++) {
    const a = out[i] < 0.0 ? -out[i] : out[i];
    if (a > peak) peak = a;
  }
  const gain = peak > 1e-9 ? rng.uniform(0.7, 0.95) / peak : 0.0;
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  // Python printed these floats with str(); a one-decimal double always shows
  // its decimal, so 2.0 stays "2.0" rather than JS's bare "2".
  const num1 = (v) => (v === undefined ? '0' : Number(v).toFixed(1));
  const num = (v) => (v === undefined ? 0 : v);
  const plural = (n, word) => `${n} ${word}` + (n === 1 ? '' : 's');

  const style = t.style || '';
  if (style === 'drip') {
    const tail = t.echo === 'echoing' ? 'faint echoing double' : 'lone single drop';
    return `cave drip — ${num(t.plip_hz)} Hz plip rising ${num1(t.rise)}x, ${tail}`;
  }
  if (style === 'small_splash') {
    const spray = plural(num(t.sprays), 'spray droplet');
    return `small splash — ${t.texture || 'soft'} wash, ${num(t.thunk_hz)} Hz thunk, ${spray}`;
  }
  if (style === 'big_splash') {
    return (
      `big splash — ${num(t.thump_hz)} Hz body thump, ` +
      `${t.slosh || 'single hit'}, ${num(t.drops)} rain-back drops`
    );
  }
  if (style === 'pour') {
    const glug = plural(num(t.glugs), 'glug');
    return (
      `steady pour — ${t.body || 'muffled'} gurgling column, ` +
      `${num1(t.wobble_hz)} Hz sway, ${glug}`
    );
  }
  if (style === 'stream') {
    return (
      `babbling stream — ${t.bed || 'fine'} noise bed, ` +
      `${num1(t.sway_hz)} Hz sway, ${num(t.bloops)} bloops`
    );
  }
  if (style === 'dive') {
    const drop = plural(num(t.drops), 'after-drop');
    return (
      `dive splashdown — ${num(t.whistle_hz)} Hz falling whistle, ` +
      `${t.duty || 'full'} duty, ${drop}`
    );
  }
  if (style === 'blub') {
    const bed = t.bed === 'bedded' ? 'over a muffled deep bed' : 'with no bed underneath';
    return `underwater blubs — ${num(t.blubs)} wobbly glubs near ${num(t.base_hz)} Hz, ${bed}`;
  }
  return 'chip-tone water texture — unspecified splash variant';
}

/** Short phrase for the README category table. */
export const character = 'drips, splashes, pours, streams, underwater blubs';
