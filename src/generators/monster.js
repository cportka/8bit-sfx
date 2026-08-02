// monster — creature foley and vocals: chest roars, piercing screeches, ragged
// snarls, insect chitter, footfall stomps, wing flaps and slime squelches.
// The voiced styles all ride a DC-centered pulse (`square` minus its own duty
// mean) so a narrow duty doesn't drag an offset through the envelope, and every
// style ends in the same tail: duration floor/cap, a 6 ms de-click on both
// edges, then peak-normalize to a drawn target.
//
// Ported 1:1 from `gen_monster` / `describe_monster` in scripts/generate_sfx.py.
// The rng draw order below is the effect's identity — nothing may be added,
// removed, or reordered, or `monster_042` stops being `monster_042`. The easy
// places to get it wrong: `Lfsr` periods are drawn *as a call argument*, so they
// land before the constructor's own seed draw; `snarl` draws inside its sample
// loop, so the loop count is part of the seed's consumption; `stomp` only draws
// its mix gain for the *second* hit and `chitter` draws its blip gain after the
// blip is rendered; and the final normalize only draws its target when the peak
// clears 1e-6. The tail fades *before* normalizing, the opposite of dsp's
// exported `finish()`, which is why this file doesn't use it.

import { SR, Lfsr, square, triangle, midi, mixAt } from '../dsp.js';

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
  const style = rng.choice(['roar', 'screech', 'snarl', 'chitter', 'stomp', 'flap', 'squelch']);

  // Python's `int(x * SR)` — truncation, not rounding.
  const sec = (x) => Math.trunc(x * SR);

  // square() minus its duty-cycle DC so narrow pulses stay zero-mean
  const pulse = (ph, duty) => square(ph, duty) - (2.0 * duty - 1.0);

  const buf = [];

  if (style === 'roar') {
    // deep chest roar: two beating detuned squares under slow vibrato, LFSR
    // growl-tremolo chewing the level, pitch sagging as the breath runs out
    const dur = rng.uniform(0.9, 1.7);
    const n = sec(dur);
    const base = midi(rng.randint(26, 38));
    const duty = rng.choice([0.25, 0.5]);
    const det = rng.uniform(1.006, 1.02);
    const vibHz = rng.uniform(4.5, 9.0);
    const vibAmt = rng.uniform(0.05, 0.14);
    const growlHz = rng.uniform(16.0, 34.0);
    const growlAmt = rng.uniform(0.25, 0.5);
    const sag = rng.uniform(0.2, 0.45);
    const breath = new Lfsr(rng, rng.randint(6, 12));
    const bamt = rng.uniform(0.15, 0.3);
    const atk = Math.max(1, sec(rng.uniform(0.03, 0.09)));
    const rel = Math.max(1, sec(rng.uniform(0.18, 0.35)));
    rng.tags = {
      style: 'roar',
      base_hz: pyRound(base),
      growl_hz: pyRound(growlHz),
      growl: growlAmt > 0.38 ? 'heavy' : 'light',
      sag: sag > 0.32 ? 'winded' : 'steady',
    };
    let p1 = 0.0;
    let p2 = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const u = i / n;
      const f = base * (1.0 - sag * u * u) * (1.0 + vibAmt * Math.sin(TWO_PI * vibHz * t));
      p1 += f / SR;
      p2 += (f * det) / SR;
      const v = 0.6 * pulse(p1, duty) + 0.4 * pulse(p2, duty) + bamt * breath.next();
      const trem = 1.0 - growlAmt * (0.5 + 0.5 * Math.sin(TWO_PI * growlHz * t));
      buf.push(v * trem * Math.min(1.0, i / atk, (n - i) / rel));
    }
  } else if (style === 'screech') {
    // piercing screech: thin square arcing up then down with a fast wobble,
    // sometimes breaking between two notes, bright hiss riding on top
    const dur = rng.uniform(0.45, 1.0);
    const n = sec(dur);
    const base = midi(rng.randint(76, 92));
    const duty = rng.choice([0.125, 0.25]);
    const arc = rng.uniform(0.2, 0.6);
    const wobHz = rng.uniform(14.0, 32.0);
    const wobAmt = rng.uniform(0.1, 0.28);
    const breaks = rng.random() < 0.5;
    const alt = midi(rng.randint(84, 99));
    const brkHz = rng.uniform(7.0, 15.0);
    const hiss = new Lfsr(rng, rng.randint(1, 2));
    const hamt = rng.uniform(0.08, 0.22);
    const atk = Math.max(1, sec(0.012));
    const rel = Math.max(1, sec(rng.uniform(0.08, 0.2)));
    rng.tags = {
      style: 'screech',
      base_hz: pyRound(base),
      wobble: wobAmt > 0.19 ? 'wild' : 'tight',
      contour: breaks ? 'breaking' : 'unbroken',
      ...(breaks ? { alt_hz: pyRound(alt) } : {}),
    };
    let ph = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const u = i / n;
      const f0 = breaks && Math.trunc(t * brkHz) % 2 ? alt : base;
      const f =
        f0 * (1.0 + arc * Math.sin(Math.PI * u)) * (1.0 + wobAmt * Math.sin(TWO_PI * wobHz * t));
      ph += f / SR;
      const v = pulse(ph, duty) + hamt * hiss.next();
      buf.push(v * Math.min(1.0, i / atk, (n - i) / rel));
    }
  } else if (style === 'snarl') {
    // low ragged snarl: sample-and-hold pitch flutter, level chewed by a slow
    // LFSR gate; about a third of them tense upward like a warning
    const dur = rng.uniform(0.45, 1.0);
    const n = sec(dur);
    const base = midi(rng.randint(31, 43));
    const duty = rng.choice([0.25, 0.5]);
    const step = Math.max(1, sec(rng.uniform(0.018, 0.045)));
    const spread = rng.uniform(0.12, 0.35);
    const chew = new Lfsr(rng, rng.randint(8, 20));
    const camt = rng.uniform(0.3, 0.55);
    const rise = rng.random() < 0.35 ? 0.5 : 0.0;
    const atk = Math.max(1, sec(rng.uniform(0.015, 0.05)));
    const rel = Math.max(1, sec(rng.uniform(0.08, 0.22)));
    rng.tags = {
      style: 'snarl',
      base_hz: pyRound(base),
      flutter: spread > 0.23 ? 'wide' : 'narrow',
      gate: camt > 0.42 ? 'heavy' : 'light',
      contour: rise ? 'rising' : 'flat',
    };
    let ph = 0.0;
    let f = base;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      if (i % step === 0) f = base * (1.0 + rise * u + rng.uniform(-spread, spread));
      ph += f / SR;
      const v = pulse(ph, duty) * (1.0 - camt + camt * (0.5 + 0.5 * chew.next()));
      buf.push(v * Math.min(1.0, i / atk, (n - i) / rel));
    }
  } else if (style === 'chitter') {
    // insectoid chitter: a run of tiny high blips, each with its own chirp
    // bend and level, the phrase drifting flat, down, or up
    const dur = rng.uniform(0.45, 1.1);
    const nb = rng.randint(6, 14);
    const period = dur / nb;
    const wv = rng.choice(['sq', 'tri']);
    const baseM = rng.randint(76, 95);
    const drift = rng.choice([-4, -2, 0, 0, 2]);
    rng.tags = {
      style: 'chitter',
      blips: nb,
      base_hz: pyRound(midi(baseM)),
      wave: wv === 'tri' ? 'triangle' : 'thin square',
      drift: { '-4': 'diving', '-2': 'sagging', 0: 'level', 2: 'rising' }[drift],
    };
    let pos = 0;
    for (let b = 0; b < nb; b++) {
      const bl = Math.max(8, Math.trunc(sec(period) * rng.uniform(0.3, 0.55)));
      const f0 = midi(baseM + (drift * b) / nb + rng.uniform(-2.0, 2.0));
      const bend = rng.uniform(-0.35, 0.5);
      let ph = 0.0;
      const blip = new Array(bl);
      for (let i = 0; i < bl; i++) {
        const uu = i / bl;
        ph += (f0 * (1.0 + bend * uu)) / SR;
        const v = wv === 'tri' ? triangle(ph) : pulse(ph, 0.125);
        blip[i] = v * Math.sin(Math.PI * uu);
      }
      mixAt(buf, blip, pos, rng.uniform(0.7, 1.0));
      pos += sec(period * rng.uniform(0.8, 1.2));
    }
    for (let i = sec(0.03); i > 0; i--) buf.push(0.0); // let the last blip breathe
  } else if (style === 'stomp') {
    // heavy footfall (sometimes two): triangle thud swept hard downward with
    // a fast-dying crunch of debris on the impact
    const double = rng.random() < 0.45;
    const gap = rng.uniform(0.18, 0.4);
    let pos = 0;
    for (let s = 0; s < (double ? 2 : 1); s++) {
      const d = double ? rng.uniform(0.3, 0.5) : rng.uniform(0.4, 0.7);
      const m = sec(d);
      const fHi = rng.uniform(85.0, 150.0);
      const fLo = rng.uniform(28.0, 48.0);
      const k = rng.uniform(6.0, 14.0);
      const body = rng.uniform(5.0, 10.0);
      const crunch = new Lfsr(rng, rng.randint(10, 22));
      const cramt = rng.uniform(0.3, 0.6);
      const cdec = rng.uniform(25.0, 60.0);
      if (s === 0) {
        rng.tags = {
          style: 'stomp',
          hits: double ? 2 : 1,
          from_hz: pyRound(fHi),
          to_hz: pyRound(fLo),
          debris: cramt > 0.45 ? 'gravelly' : 'dusty',
        };
      }
      let ph = 0.0;
      const st = new Array(m);
      for (let i = 0; i < m; i++) {
        const t = i / SR;
        ph += (fLo + (fHi - fLo) * Math.exp(-k * t)) / SR;
        const v =
          triangle(ph) * Math.exp(-body * t) + cramt * crunch.next() * Math.exp(-cdec * t);
        st[i] = v * Math.min(1.0, (m - i) / (0.02 * SR));
      }
      mixAt(buf, st, pos, s === 0 ? 1.0 : rng.uniform(0.6, 0.95));
      pos += sec(gap);
    }
  } else if (style === 'flap') {
    // wing beats: repeated noise whooshes that swell and die, a soft low
    // triangle undertone flapping along underneath
    let nf = rng.randint(2, 5);
    const rate = rng.uniform(0.16, 0.3);
    while (nf * rate < 0.45) nf += 1;
    const subAmt = rng.uniform(0.15, 0.35);
    const subF0 = rng.uniform(45.0, 75.0);
    rng.tags = {
      style: 'flap',
      beats: nf,
      pace: rate < 0.22 ? 'frantic' : 'lumbering',
      thrum_hz: pyRound(subF0),
      undertone: subAmt > 0.25 ? 'strong' : 'faint',
    };
    let pos = 0;
    for (let w = 0; w < nf; w++) {
      const flen = Math.max(1, sec(rate * rng.uniform(0.85, 1.08)));
      const whoosh = new Lfsr(rng, rng.randint(2, 6));
      const swell = rng.uniform(0.2, 0.4);
      const gain = rng.uniform(0.7, 1.0) * (w < nf - 1 ? 1.0 : 0.85);
      const sf = subF0 * rng.uniform(0.9, 1.15);
      let ph = 0.0;
      const st = new Array(flen);
      for (let i = 0; i < flen; i++) {
        const uu = i / flen;
        let e = uu < swell ? uu / swell : Math.max(0.0, 1.0 - (uu - swell) / (1.0 - swell));
        e *= e;
        ph += sf / SR;
        st[i] = (whoosh.next() + subAmt * triangle(ph)) * e * gain;
      }
      mixAt(buf, st, pos);
      pos += sec(rate);
    }
  } else {
    // squelch — slime: wobbling triangle glissando falling away, a wet splat up
    // front, hand-rolled one-pole gurgle underneath, and rising bubble blips
    const dur = rng.uniform(0.5, 1.1);
    const n = sec(dur);
    const base = rng.uniform(70.0, 150.0);
    const fall = rng.uniform(0.35, 0.6);
    const wobHz = rng.uniform(5.0, 12.0);
    const wobAmt = rng.uniform(0.2, 0.45);
    const goo = new Lfsr(rng, rng.randint(12, 24));
    const coef = rng.uniform(0.02, 0.08);
    const gamt = rng.uniform(0.5, 1.0);
    const splat = new Lfsr(rng, rng.randint(2, 4));
    const sdec = rng.uniform(35.0, 80.0);
    const samt = rng.uniform(0.4, 0.8);
    const atk = Math.max(1, sec(0.008));
    const rel = Math.max(1, sec(rng.uniform(0.1, 0.25)));
    let ph = 0.0;
    let low = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const u = i / n;
      const f =
        base * (1.0 - fall * u) * (1.0 + wobAmt * Math.sin(TWO_PI * wobHz * t + 3.0 * u));
      ph += f / SR;
      low += coef * (goo.next() - low);
      const v =
        triangle(ph) * (1.0 - 0.4 * u) + gamt * low + samt * splat.next() * Math.exp(-sdec * t);
      buf.push(v * Math.min(1.0, i / atk, (n - i) / rel));
    }
    const nbub = rng.randint(2, 5);
    rng.tags = {
      style: 'squelch',
      base_hz: pyRound(base),
      wobble: wobAmt > 0.32 ? 'seasick' : 'gentle',
      splat: samt > 0.6 ? 'wet' : 'soft',
      bubbles: nbub,
    };
    for (let b = 0; b < nbub; b++) {
      const bl = Math.max(8, sec(rng.uniform(0.03, 0.07)));
      const start = rng.randint(sec(0.05), Math.max(sec(0.05) + 1, n - bl - 1));
      const bf = rng.uniform(180.0, 480.0);
      const bend = rng.uniform(1.2, 2.5);
      let bph = 0.0;
      const blip = new Array(bl);
      for (let i = 0; i < bl; i++) {
        const uu = i / bl;
        bph += (bf * (1.0 + bend * uu)) / SR;
        blip[i] = triangle(bph) * Math.sin(Math.PI * uu) * 0.5;
      }
      mixAt(buf, blip, start);
    }
  }

  // duration guards, edge de-click, then normalize so the peak always clears
  // the 16-level quantizer downstream
  const floorN = sec(0.42);
  while (buf.length < floorN) buf.push(0.0);
  const capN = sec(1.78);
  if (buf.length > capN) buf.length = capN;
  const edge = Math.max(1, sec(0.006));
  for (let i = 0; i < Math.min(edge, buf.length); i++) {
    const w = i / edge;
    buf[i] *= w;
    buf[buf.length - 1 - i] *= w;
  }
  let peak = 0.0;
  for (const v of buf) {
    const a = v < 0.0 ? -v : v;
    if (a > peak) peak = a;
  }
  const g = peak > 1e-6 ? rng.uniform(0.78, 0.95) / peak : 0.0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] * g;
    buf[i] = v > 1.0 ? 1.0 : v < -1.0 ? -1.0 : v;
  }
  return buf;
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const g = (k, dflt) => (Object.prototype.hasOwnProperty.call(t, k) ? t[k] : dflt);
  const style = g('style', undefined);

  if (style === 'roar') {
    return (
      `deep chest roar — ${g('base_hz', 0)} Hz under ${g('growl_hz', 0)} Hz ` +
      `${g('growl', 'light')} growl, ${g('sag', 'steady')} pitch`
    );
  }
  if (style === 'screech') {
    if (g('contour', 'unbroken') === 'breaking') {
      return (
        `piercing screech — ${g('base_hz', 0)} Hz breaking against ${g('alt_hz', 0)} Hz, ` +
        `${g('wobble', 'tight')} wobble`
      );
    }
    return `piercing screech — unbroken ${g('base_hz', 0)} Hz arc, ${g('wobble', 'tight')} wobble`;
  }
  if (style === 'snarl') {
    return (
      `low ragged snarl — ${g('base_hz', 0)} Hz ${g('flutter', 'narrow')} flutter, ` +
      `${g('gate', 'light')} gate chew, ${g('contour', 'flat')} contour`
    );
  }
  if (style === 'chitter') {
    return (
      `insectoid chitter — ${g('blips', 0)} ${g('wave', 'thin square')} blips around ` +
      `${g('base_hz', 0)} Hz, ${g('drift', 'level')} phrase`
    );
  }
  if (style === 'stomp') {
    return (
      `heavy footfall — ${g('hits', 1) === 2 ? 'double' : 'single'} stomp, thud swept ` +
      `${g('from_hz', 0)} down to ${g('to_hz', 0)} Hz, ${g('debris', 'dusty')} debris`
    );
  }
  if (style === 'flap') {
    return (
      `wing-beat flapping — ${g('beats', 0)} ${g('pace', 'lumbering')} whooshes, ` +
      `${g('undertone', 'faint')} ${g('thrum_hz', 0)} Hz thrum underneath`
    );
  }
  // squelch
  return (
    `slime squelch — ${g('base_hz', 0)} Hz falling gliss, ${g('wobble', 'gentle')} wobble, ` +
    `${g('splat', 'soft')} splat, ${g('bubbles', 0)} bubbles`
  );
}

/** Short phrase for the README category table. */
export const character = 'creature roars, screeches, snarls, chitter, stomps, flaps, squelches';
