// ambient — environmental beds: wind, crickets, cave drips, thunder, rain, shimmer.
//
// Ported 1:1 from `gen_ambient` / `describe_ambient` in scripts/generate_sfx.py.
// Six sub-styles share one rng, so the draw order *is* the effect's identity:
// the style pick, every parameter, and the trailing normalize gain must be drawn
// in exactly the Python order or `ambient_042` stops being `ambient_042`.
//
// Two draw-order traps carried over verbatim:
//   * `Lfsr(rng, rng.choice([...]))` — Python evaluates the argument (choice)
//     before the constructor's `randint`, so choice comes first.
//   * `for e in range(rng.randint(2, 4) + 1)` — the bound is drawn once, but the
//     per-echo `e_amp *= rng.uniform(...)` fires on every pass, last one included.

import { SR, Lfsr, square, triangle, midi } from '../dsp.js';

/** Python's round(): half-to-even, matching `int(round(x))` on the source side. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice(['wind', 'crickets', 'drips', 'thunder', 'rain', 'shimmer']);

  // Raised-cosine edges, applied *before* normalization exactly as Python does.
  const edgeFade = (buf, msIn, msOut) => {
    const n = buf.length;
    const fi = Math.min(Math.floor(n / 2), Math.floor((SR * msIn) / 1000.0));
    const fo = Math.min(Math.floor(n / 2), Math.floor((SR * msOut) / 1000.0));
    for (let i = 0; i < fi; i++) buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
    for (let i = 0; i < fo; i++) buf[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
    return buf;
  };

  // Local finish (NOT dsp's): fade, then peak-normalize to a *drawn* target.
  // That uniform is the final rng draw of every sub-style — keep it.
  const normalize = (buf, msIn, msOut) => {
    edgeFade(buf, msIn, msOut);
    let peak = 0.0;
    for (const v of buf) {
      const a = v >= 0.0 ? v : -v;
      if (a > peak) peak = a;
    }
    if (peak < 1e-9) return buf;
    const g = rng.uniform(0.6, 0.85) / peak;
    for (let i = 0; i < buf.length; i++) buf[i] = Math.max(-1.0, Math.min(1.0, buf[i] * g));
    return buf;
  };

  if (style === 'wind') {
    // gusting wind: white LFSR through a one-pole lowpass whose cutoff and
    // gain both ride a slow gust envelope (sum of gaussian swells)
    const dur = rng.uniform(1.8, 3.0);
    const n = Math.floor(SR * dur);
    const noise = new Lfsr(rng, 1);
    const gusts = [];
    const nGusts = rng.randint(2, 4); // range() evaluates its bound once
    for (let i = 0; i < nGusts; i++) {
      gusts.push([rng.uniform(0.15, 0.85) * dur, rng.uniform(0.25, 0.6), rng.uniform(0.5, 1.0)]);
    }
    const base = rng.uniform(0.15, 0.3);
    let maxAmp = -Infinity;
    for (const g of gusts) if (g[2] > maxAmp) maxAmp = g[2];
    rng.tags = {
      style: 'wind',
      gusts: gusts.length,
      bed: base < 0.22 ? 'calm' : 'steady',
      swell: maxAmp >= 0.8 ? 'towering' : 'gentle',
    };
    let lp = 0.0;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let g = base;
      for (let j = 0; j < gusts.length; j++) {
        const d = (t - gusts[j][0]) / gusts[j][1];
        g += gusts[j][2] * Math.exp(-d * d);
      }
      if (g > 1.0) g = 1.0;
      const alpha = 0.02 + 0.12 * g; // stronger gust = brighter hiss
      lp += alpha * (noise.next() - lp);
      out[i] = lp * g;
    }
    return normalize(out, 120.0, 250.0);
  }

  if (style === 'crickets') {
    // 2-3 cricket voices: trains of short triangle pulses at a chirp rate,
    // grouped into chirps with silent gaps, each voice its own pitch/rhythm
    const dur = rng.uniform(2.0, 3.0);
    const n = Math.floor(SR * dur);
    const out = new Array(n).fill(0.0);
    const voices = rng.randint(2, 3);
    let leadHz = null;
    let leadRate = null;
    for (let v = 0; v < voices; v++) {
      const carrier = rng.uniform(2600.0, 4600.0);
      const prate = rng.uniform(22.0, 42.0);
      if (leadHz === null) {
        leadHz = carrier;
        leadRate = prate;
      }
      const amp = rng.uniform(0.5, 1.0);
      let t = rng.uniform(0.0, 0.5);
      while (t < dur) {
        const clen = rng.uniform(0.25, 0.7);
        let pt = t;
        let stop = t + clen;
        if (stop > dur) stop = dur;
        while (pt < stop) {
          const i0 = Math.floor(pt * SR);
          const m = Math.floor((0.55 / prate) * SR);
          let ph = 0.0;
          for (let k = 0; k < m; k++) {
            const idx = i0 + k;
            if (idx >= n) break;
            ph += carrier / SR;
            out[idx] += amp * Math.sin((Math.PI * k) / m) * triangle(ph) * 0.5;
          }
          pt += 1.0 / prate;
        }
        t += clen + rng.uniform(0.3, 0.9);
      }
    }
    rng.tags = {
      style: 'crickets',
      voices,
      lead_hz: pyRound(leadHz),
      chirp: leadRate >= 32.0 ? 'rapid' : 'lazy',
    };
    return normalize(out, 40.0, 120.0);
  }

  if (style === 'drips') {
    // cave: faint dark rumble bed + sparse falling-pitch triangle plinks,
    // each repeated as a decaying echo train at a fixed delay
    const dur = rng.uniform(2.0, 3.0);
    const n = Math.floor(SR * dur);
    const period = rng.choice([4, 6, 8]); // drawn before the Lfsr's own randint
    const rumble = new Lfsr(rng, period);
    let lp = 0.0;
    const bed = rng.uniform(0.12, 0.25);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      lp += 0.01 * (rumble.next() - lp);
      out[i] = lp * bed;
    }
    const delay = rng.uniform(0.16, 0.34);
    const drops = rng.randint(2, 4);
    for (let d = 0; d < drops; d++) {
      const t0 = rng.uniform(0.05, dur * 0.55);
      const f0 = rng.uniform(900.0, 2000.0);
      const f1 = f0 * rng.uniform(0.35, 0.6);
      const m = Math.floor(rng.uniform(0.04, 0.09) * SR);
      let eAmp = 1.0;
      const echoes = rng.randint(2, 4) + 1;
      for (let e = 0; e < echoes; e++) {
        const start = Math.floor((t0 + e * delay) * SR);
        let ph = 0.0;
        for (let k = 0; k < m; k++) {
          const idx = start + k;
          if (idx >= n) break;
          const u = k / m;
          ph += (f0 + (f1 - f0) * u) / SR;
          const env = Math.min(1.0, u * 12.0) * (1.0 - u) * Math.exp(-4.0 * u);
          out[idx] += eAmp * env * triangle(ph) * 0.8;
        }
        eAmp *= rng.uniform(0.45, 0.6); // drawn on every echo, last one included
      }
    }
    rng.tags = {
      style: 'drips',
      drops,
      echo_ms: pyRound(delay * 1000.0),
      bed: bed < 0.185 ? 'faint' : 'heavy',
    };
    return normalize(out, 30.0, 120.0);
  }

  if (style === 'thunder') {
    // distant thunder: crunchy low LFSR through two one-pole lowpasses,
    // swell-then-decay envelope undulated by two slow sines + a low throb
    const dur = rng.uniform(2.0, 3.0);
    const n = Math.floor(SR * dur);
    const per = rng.choice([3, 4, 6]);
    const noise = new Lfsr(rng, per);
    const atk = rng.uniform(0.15, 0.5);
    const u1f = rng.uniform(0.7, 2.0);
    const u1p = rng.uniform(0.0, 6.283);
    const u2f = rng.uniform(2.0, 5.0);
    const u2p = rng.uniform(0.0, 6.283);
    const subf = rng.uniform(28.0, 45.0);
    const subamp = rng.uniform(0.15, 0.35);
    rng.tags = {
      style: 'thunder',
      attack: atk < 0.3 ? 'sudden' : 'rolling',
      grain: per === 3 ? 'fine' : per === 4 ? 'crunchy' : 'coarse',
      throb_hz: pyRound(subf),
    };
    let lp = 0.0;
    let lp2 = 0.0;
    let ph = 0.0;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const a = Math.min(1.0, t / atk) * Math.exp((-2.5 * Math.max(0.0, t - atk)) / dur);
      const und =
        0.6 + 0.25 * Math.sin(6.283185 * u1f * t + u1p) + 0.15 * Math.sin(6.283185 * u2f * t + u2p);
      lp += 0.015 * (noise.next() - lp);
      lp2 += 0.03 * (lp - lp2);
      ph += subf / SR;
      out[i] = (lp2 * 8.0 + subamp * triangle(ph)) * und * a;
    }
    return normalize(out, 60.0, 300.0);
  }

  if (style === 'rain') {
    // rain patter: random micro-drops feed an energy accumulator with a
    // millisecond decay; white LFSR rings it, one-pole sets brightness
    const dur = rng.uniform(1.5, 3.0);
    const n = Math.floor(SR * dur);
    const noise = new Lfsr(rng, 1);
    const density = rng.uniform(0.004, 0.02);
    const dcoef = Math.exp(-1.0 / (SR * rng.uniform(0.002, 0.006)));
    const bright = rng.uniform(0.25, 0.7);
    const swf = rng.uniform(0.2, 0.7);
    const swp = rng.uniform(0.0, 6.283);
    rng.tags = {
      style: 'rain',
      patter: density >= 0.012 ? 'dense' : 'sparse',
      drops_sec: pyRound(density * SR),
      tone: bright > 0.45 ? 'bright' : 'muffled',
    };
    let e = 0.0;
    let lp = 0.0;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const sway = 0.75 + 0.25 * Math.sin(6.283185 * swf * t + swp);
      if (rng.random() < density * sway) e += rng.uniform(0.3, 1.0); // one draw per sample
      e *= dcoef;
      lp += bright * (noise.next() * e - lp);
      out[i] = lp;
    }
    return normalize(out, 80.0, 150.0);
  }

  // shimmer: two detuned triangles beating slowly under a tremolo LFO with
  // gentle vibrato, plus sparse high 12.5%-duty square sparkle blips
  const dur = rng.uniform(2.0, 3.0);
  const n = Math.floor(SR * dur);
  const root = midi(rng.randint(62, 74));
  const det = rng.uniform(0.3, 1.2);
  const tremF = rng.uniform(0.4, 1.6);
  const vibF = rng.uniform(3.0, 6.0);
  const vibD = rng.uniform(0.002, 0.008);
  let ph1 = 0.0;
  let ph2 = 0.0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph1 += (root * (1.0 + vibD * Math.sin(6.283185 * vibF * t))) / SR;
    ph2 += (root + det) / SR;
    const trem = 0.6 + 0.4 * Math.sin(6.283185 * tremF * t);
    out[i] = (triangle(ph1) + triangle(ph2)) * 0.4 * trem;
  }
  const steps = [0, 3, 5, 7, 10, 12, 15];
  const sparkles = rng.randint(3, 8);
  for (let s = 0; s < sparkles; s++) {
    const t0 = rng.uniform(0.1, dur - 0.3);
    const f = root * 4.0 * Math.pow(2.0, rng.choice(steps) / 12.0);
    const m = Math.floor(rng.uniform(0.06, 0.15) * SR);
    const i0 = Math.floor(t0 * SR);
    const a = rng.uniform(0.2, 0.45);
    let ph = 0.0;
    for (let k = 0; k < m; k++) {
      const idx = i0 + k;
      if (idx >= n) break;
      const u = k / m;
      ph += f / SR;
      out[idx] += a * Math.min(1.0, u * 10.0) * (1.0 - u) * square(ph, 0.125) * 0.5;
    }
  }
  rng.tags = {
    style: 'shimmer',
    root_hz: pyRound(root),
    beat: det < 0.7 ? 'slow' : 'quick',
    sparkles,
  };
  return normalize(out, 100.0, 200.0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const style = (tags && tags.style) || 'ambient';
  const get = (k, d) => (tags && tags[k] !== undefined ? tags[k] : d);
  if (style === 'wind') {
    return `gusting wind bed — ${get('gusts', 2)} ${get('swell', 'gentle')} swells over a ${get('bed', 'calm')} hiss`;
  }
  if (style === 'crickets') {
    return `night cricket chorus — ${get('voices', 2)} voices, ${get('chirp', 'lazy')} chirps, lead near ${get('lead_hz', 3000)} Hz`;
  }
  if (style === 'drips') {
    return `cave drip echoes — ${get('drops', 2)} plinks on a ${get('bed', 'faint')} rumble, ${get('echo_ms', 200)} ms echo tail`;
  }
  if (style === 'thunder') {
    return `distant thunder roll — ${get('attack', 'rolling')} attack, ${get('grain', 'crunchy')} rumble, ${get('throb_hz', 35)} Hz throb`;
  }
  if (style === 'rain') {
    return `steady rain patter — ${get('patter', 'sparse')} drops near ${get('drops_sec', 100)} per second, ${get('tone', 'muffled')} hiss`;
  }
  if (style === 'shimmer') {
    return `eerie shimmer pad — triangles beating at ${get('root_hz', 440)} Hz, ${get('beat', 'slow')} beat, ${get('sparkles', 4)} sparkle blips`;
  }
  return `ambient environmental bed — ${style} texture`;
}

/** Short phrase for the README category table. */
export const character = 'wind gusts, cricket chorus, cave drips, thunder, rain, shimmer pads';
