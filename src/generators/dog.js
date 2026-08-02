// dog — the chip kennel: small and big barks, puppy yips, pleading whines,
// whimpers, throat growls, happy panting and moonlit howls. Everything leans on
// one shared trick: a DC-centered pulse (`square` minus its own mean) so the
// narrow duties that give a bark its nasal snap don't ride on a fat offset and
// smear the envelope.
//
// Ported 1:1 from `gen_dog` / `describe_dog` in scripts/generate_sfx.py.
// The rng draw order below is the effect's identity — nothing may be added,
// removed, or reordered, or `dog_042` stops being `dog_042`. In particular the
// per-syllable parameters are drawn *as call arguments*, left to right, and the
// `Lfsr` seed draw lands after them, inside the syllable helper.

import { SR, Lfsr, square, triangle, noteOfHz } from '../dsp.js';

/** Python's round(): half-to-even on the exact value, returning an int. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's round(x, 1): half-to-even, one decimal place. */
function pyRound1(x) {
  return pyRound(x * 10) / 10;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  // Taper the tail only — a dog sound starts on a hard attack by design, and
  // fading the front would file the teeth off every bark.
  const endfade = (buf, ms = 5.0) => {
    const n = buf.length;
    const k = Math.min(n, Math.max(8, Math.trunc((SR * ms) / 1000.0)));
    for (let i = 0; i < k; i++) buf[n - k + i] *= 1.0 - (i + 1.0) / k;
    return buf;
  };

  const norm = (buf, target) => {
    let peak = 0.0;
    for (const s of buf) {
      const a = s < 0.0 ? -s : s;
      if (a > peak) peak = a;
    }
    if (peak < 1e-9) return buf;
    const g = target / peak;
    return buf.map((s) => s * g);
  };

  // DC-centered pulse: narrow duties otherwise ride on a big offset.
  const pulse = (ph, duty) => square(ph, duty) - (2.0 * duty - 1.0);

  const push = (dst, src) => {
    for (let i = 0; i < src.length; i++) dst.push(src[i]);
  };

  const silence = (dst, secs) => {
    const k = Math.trunc(secs * SR);
    for (let i = 0; i < k; i++) dst.push(0.0);
  };

  // One "wuf": pitch snaps up then falls, gravel jitter, noisy attack.
  const barkSyll = (dur, f0, peakMult, duty, rough, noiseAmt, nper, drate) => {
    const n = Math.trunc(dur * SR);
    const out = new Array(n).fill(0.0);
    const lf = new Lfsr(rng, nper);
    let jit = 0.0;
    const hold = Math.max(12, Math.trunc(SR / (f0 * 2.0)));
    let ph = 0.0;
    for (let i = 0; i < n; i++) {
      const tn = i / n;
      let f;
      if (tn < 0.18) {
        f = f0 * (1.0 + (peakMult - 1.0) * (tn / 0.18));
      } else {
        const u = (tn - 0.18) / 0.82;
        f = f0 * (peakMult - (peakMult - 0.6) * u);
      }
      if (i % hold === 0) jit = rng.uniform(-rough, rough);
      ph += (f * (1.0 + jit)) / SR;
      const a = tn < 0.05 ? tn / 0.05 : Math.exp(-drate * (tn - 0.05) * 4.0);
      const nz = lf.next() * noiseAmt * Math.exp(-10.0 * tn);
      out[i] = (pulse(ph, duty) * 0.9 + nz) * a;
    }
    return endfade(out);
  };

  // Tiny chirp: fast up to fhi at tn=pk, then down past the start.
  const yipSyll = (dur, flo, fhi, duty, pk) => {
    const n = Math.trunc(dur * SR);
    const out = new Array(n).fill(0.0);
    let ph = 0.0;
    for (let i = 0; i < n; i++) {
      const tn = i / n;
      let f;
      if (tn < pk) {
        f = flo + (fhi - flo) * (tn / pk);
      } else {
        f = fhi - (fhi - flo * 0.8) * ((tn - pk) / (1.0 - pk));
      }
      ph += f / SR;
      const a = Math.min(1.0, tn / 0.03) * Math.exp(-6.0 * Math.max(0.0, tn - 0.03));
      out[i] = pulse(ph, duty) * a;
    }
    return endfade(out);
  };

  // Short sad falling triangle hump.
  const whimperSyll = (dur, fhi, flo) => {
    const n = Math.trunc(dur * SR);
    const out = new Array(n).fill(0.0);
    let ph = 0.0;
    for (let i = 0; i < n; i++) {
      const tn = i / n;
      ph += (fhi + (flo - fhi) * tn) / SR;
      out[i] = triangle(ph) * Math.sin(Math.PI * Math.min(1.0, tn * 1.02));
    }
    return out;
  };

  const style = rng.choice(['bark_small', 'bark_big', 'yip', 'whine', 'whimper', 'growl', 'pant', 'howl']);
  const target = rng.uniform(0.7, 0.95);
  let out = [];
  let tags;

  if (style === 'bark_small') {
    const cnt = rng.choice([1, 1, 2]);
    const f0 = rng.uniform(480, 820);
    const duty = rng.choice([0.25, 0.125]);
    for (let c = 0; c < cnt; c++) {
      push(
        out,
        barkSyll(
          rng.uniform(0.1, 0.16),
          f0 * rng.uniform(0.95, 1.05),
          rng.uniform(1.5, 2.0),
          duty,
          0.05,
          rng.uniform(0.2, 0.35),
          rng.randint(2, 3),
          rng.uniform(0.9, 1.3),
        ),
      );
      if (c < cnt - 1) silence(out, rng.uniform(0.06, 0.1));
    }
    tags = {
      style: 'bark_small',
      pitch_hz: pyRound(f0),
      barks: cnt,
      timbre: duty === 0.125 ? 'reedy' : 'nasal',
      note: noteOfHz(f0), // derived from a value already drawn; costs no draw
    };
  } else if (style === 'bark_big') {
    const cnt = rng.choice([1, 1, 1, 2]);
    const f0 = rng.uniform(130, 230);
    for (let c = 0; c < cnt; c++) {
      push(
        out,
        barkSyll(
          rng.uniform(0.16, 0.28),
          f0 * rng.uniform(0.94, 1.06),
          rng.uniform(1.4, 1.7),
          0.5,
          rng.uniform(0.08, 0.16),
          rng.uniform(0.3, 0.45),
          rng.randint(6, 11),
          rng.uniform(0.75, 1.05),
        ),
      );
      if (c < cnt - 1) silence(out, rng.uniform(0.08, 0.13));
    }
    tags = {
      style: 'bark_big',
      pitch_hz: pyRound(f0),
      barks: cnt,
      register: f0 < 180 ? 'cavernous' : 'gruff',
      note: noteOfHz(f0),
    };
  } else if (style === 'yip') {
    const cnt = rng.choice([1, 1, 2, 3]);
    const flo = rng.uniform(700, 950);
    const ratio = rng.uniform(1.4, 1.9);
    const duty = rng.choice([0.25, 0.125]);
    for (let c = 0; c < cnt; c++) {
      const fl = flo * rng.uniform(0.95, 1.08);
      push(out, yipSyll(rng.uniform(0.08, 0.12), fl, fl * ratio, duty, rng.uniform(0.25, 0.4)));
      if (c < cnt - 1) silence(out, rng.uniform(0.04, 0.07));
    }
    tags = {
      style: 'yip',
      pitch_hz: pyRound(flo),
      yips: cnt,
      sweep: ratio > 1.65 ? 'wide' : 'narrow',
      timbre: duty === 0.125 ? 'reedy' : 'nasal',
      note: noteOfHz(flo),
    };
  } else if (style === 'whine') {
    const dur = rng.uniform(0.35, 0.75);
    const f0 = rng.uniform(600, 1100);
    const bend = rng.uniform(0.15, 0.45);
    const vhz = rng.uniform(4.5, 7.5);
    const vd = rng.uniform(0.015, 0.05);
    const wav = rng.choice(['tri', 'tri', 'sq']);
    const n = Math.trunc(dur * SR);
    out = new Array(n).fill(0.0);
    let ph = 0.0;
    for (let i = 0; i < n; i++) {
      const tn = i / n;
      const t = i / SR;
      let f = f0 * (1.0 + bend * Math.sin(Math.PI * tn));
      f *= 1.0 + vd * Math.min(1.0, tn / 0.4) * Math.sin(2.0 * Math.PI * vhz * t);
      ph += f / SR;
      const a = Math.min(1.0, tn / 0.18) * Math.min(1.0, (1.0 - tn) / 0.35);
      out[i] = (wav === 'tri' ? triangle(ph) : pulse(ph, 0.25)) * a;
    }
    tags = {
      style: 'whine',
      pitch_hz: pyRound(f0),
      voice: wav === 'tri' ? 'smooth' : 'buzzy',
      arc: bend > 0.3 ? 'steep' : 'gentle',
      vibrato: vd > 0.03 ? 'fluttery' : 'subtle',
      note: noteOfHz(f0),
    };
  } else if (style === 'whimper') {
    const cnt = rng.randint(2, 4);
    const fhi = rng.uniform(650, 1000);
    const drop = rng.uniform(0.55, 0.75);
    for (let c = 0; c < cnt; c++) {
      const fh = fhi * rng.uniform(0.9, 1.05) * (1.0 - 0.06 * c);
      push(out, whimperSyll(rng.uniform(0.08, 0.13), fh, fh * drop));
      if (c < cnt - 1) silence(out, rng.uniform(0.03, 0.07));
    }
    tags = {
      style: 'whimper',
      pitch_hz: pyRound(fhi),
      sobs: cnt,
      fall: drop < 0.65 ? 'steep' : 'shallow',
      note: noteOfHz(fhi),
    };
  } else if (style === 'growl') {
    const dur = rng.uniform(0.4, 0.85);
    const f0 = rng.uniform(55, 110);
    const rough = rng.uniform(0.15, 0.35);
    const thz = rng.uniform(11.0, 22.0);
    const td = rng.uniform(0.35, 0.6);
    const namp = rng.uniform(0.15, 0.3);
    const duty = rng.choice([0.5, 0.5, 0.25]);
    const hold = rng.randint(30, 70);
    const lf = new Lfsr(rng, rng.randint(8, 14));
    const n = Math.trunc(dur * SR);
    out = new Array(n).fill(0.0);
    let ph = 0.0;
    let jit = 0.0;
    for (let i = 0; i < n; i++) {
      const tn = i / n;
      const t = i / SR;
      if (i % hold === 0) jit = rng.uniform(-rough, rough);
      ph += (f0 * (1.0 + jit)) / SR;
      const trem = 1.0 - td * (0.5 + 0.5 * Math.sin(2.0 * Math.PI * thz * t));
      const a = Math.min(1.0, tn / 0.12) * Math.min(1.0, (1.0 - tn) / 0.18);
      out[i] = (pulse(ph, duty) * 0.85 + lf.next() * namp) * trem * a;
    }
    tags = {
      style: 'growl',
      pitch_hz: pyRound(f0),
      texture: rough > 0.25 ? 'ragged' : 'coarse',
      tremolo: thz > 16.0 ? 'fast' : 'slow',
      note: noteOfHz(f0),
    };
  } else if (style === 'pant') {
    const nb = rng.randint(3, 5);
    const kIn = rng.uniform(0.2, 0.45);
    for (let b = 0; b < nb; b++) {
      const bn = Math.trunc(rng.uniform(0.05, 0.08) * SR);
      const lf = new Lfsr(rng, rng.choice([1, 1, 2]));
      const k = b % 2 === 0 ? kIn : kIn * 0.45; // out-breath duller
      const amp = b % 2 === 0 ? 1.0 : 0.75;
      let y = 0.0;
      for (let i = 0; i < bn; i++) {
        y += k * (lf.next() - y); // one-pole lowpass by hand
        out.push(y * amp * Math.sin((Math.PI * (i + 1.0)) / bn));
      }
      if (b < nb - 1) silence(out, rng.uniform(0.04, 0.07));
    }
    tags = {
      style: 'pant',
      breaths: nb,
      tone: kIn > 0.32 ? 'airy' : 'muffled',
    };
  } else {
    // howl
    const dur = rng.uniform(0.55, 0.88);
    const f0 = rng.uniform(220, 420);
    const ratio = rng.uniform(1.35, 1.8);
    const rise = rng.uniform(0.22, 0.4);
    const vhz = rng.uniform(4.5, 6.5);
    const vd = rng.uniform(0.02, 0.05);
    const wav = rng.choice(['tri', 'tri', 'sq']);
    const det = rng.choice([0.0, 1.0, 1.0]) * rng.uniform(0.004, 0.009);
    const n = Math.trunc(dur * SR);
    out = new Array(n).fill(0.0);
    let ph1 = 0.0;
    let ph2 = 0.0;
    for (let i = 0; i < n; i++) {
      const tn = i / n;
      const t = i / SR;
      let f;
      if (tn < rise) {
        f = f0 * Math.pow(ratio, tn / rise);
      } else {
        f = f0 * ratio;
        if (tn > 0.85) f *= 1.0 - (0.2 * (tn - 0.85)) / 0.15;
      }
      f *= 1.0 + vd * Math.min(1.0, tn / 0.5) * Math.sin(2.0 * Math.PI * vhz * t);
      ph1 += f / SR;
      ph2 += (f * (1.0 + det)) / SR;
      const a = Math.min(1.0, tn / 0.08) * Math.min(1.0, (1.0 - tn) / 0.15);
      const s =
        wav === 'tri'
          ? triangle(ph1) + (det ? triangle(ph2) * 0.6 : 0.0)
          : square(ph1, 0.5) + (det ? square(ph2, 0.5) * 0.6 : 0.0);
      out[i] = s * a * (det ? 0.62 : 1.0);
    }
    tags = {
      style: 'howl',
      start_hz: pyRound(f0),
      sweep_oct: pyRound1(Math.log2(ratio)),
      voice: wav === 'tri' ? 'mellow' : 'brassy',
      chorus: det ? 'detuned' : 'single',
      note: noteOfHz(f0),
    };
  }

  rng.tags = tags;
  return norm(endfade(out), target);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(t, k);
  const g = (k, dflt) => (has(k) ? t[k] : dflt);
  const cw = (n) => ({ 1: 'single', 2: 'double', 3: 'triple', 4: 'quadruple' })[n] || `${Math.trunc(n)}x`;

  const style = g('style', 'unknown');
  switch (style) {
    case 'bark_small':
      return `small-dog bark — ${g('timbre', 'nasal')} ${g('pitch_hz', 0)} Hz snap, ${cw(g('barks', 1))} wuf`;
    case 'bark_big':
      return `big-dog bark — ${g('register', 'gruff')} ${g('pitch_hz', 0)} Hz chest woof, ${cw(g('barks', 1))} blast`;
    case 'yip':
      return `puppy yip — ${g('timbre', 'nasal')} chirp from ${g('pitch_hz', 0)} Hz, ${g('sweep', 'narrow')} sweep, ${cw(g('yips', 1))} yap`;
    case 'whine':
      return `pleading whine — ${g('voice', 'smooth')} ${g('pitch_hz', 0)} Hz tone, ${g('arc', 'gentle')} pitch arc, ${g('vibrato', 'subtle')} vibrato`;
    case 'whimper':
      return `sad whimper — ${cw(g('sobs', 2))} falling sobs near ${g('pitch_hz', 0)} Hz, ${g('fall', 'shallow')} drop`;
    case 'growl':
      return `menacing growl — ${g('texture', 'coarse')} ${g('pitch_hz', 0)} Hz rumble, ${g('tremolo', 'slow')} throat tremolo`;
    case 'pant':
      return `happy pant — ${g('tone', 'airy')} huff-puff rhythm, ${g('breaths', 3)} breaths`;
    case 'howl':
      return `moonlit howl — ${g('voice', 'mellow')} rise of ${oct(g('sweep_oct', 0.5))} oct from ${g('start_hz', 0)} Hz, ${g('chorus', 'single')} voice`;
    default:
      return `${style} chip-dog vocalization, seed-varied 8-bit character`;
  }
}

/** Python's str(float) for the one-decimal octave figure: 1 -> "1.0". */
function oct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/** Short phrase for the README category table. */
export const character = 'chip barks big and small, yips, whines, whimpers, growls, pants, howls';
