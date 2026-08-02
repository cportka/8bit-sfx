// Objects & mechanisms: creaks, slams, latches, levers, switches, rattles,
// ratchets, jangling keys. Chip-style: squares, tris, LFSR noise.
//
// A faithful port of the Python `gen_mech` that produced the published 0.4.1
// WAVs — the draw order is the spec, so nothing here may be reordered,
// "improved", or given extra processing.

import { SR, Lfsr, square, renderTone, decay, mixAt, dcBlock } from '../dsp.js';

/** Python's round(): half away from... no — half to EVEN. */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python `int(round(x))`. */
const iround = (x) => roundHalfEven(x);

/** Python `round(x, 1)` — keeps the sign of a negative zero, as CPython does. */
function round1(x) {
  return Number(x.toFixed(1));
}

/** Python's str() of a one-decimal float, including the "-0.0" case. */
function fmt1(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return Object.is(n, -0) ? '-0.0' : n.toFixed(1);
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const tags = {};

  function noiseBurst(n, period, rate, gain = 1.0) {
    const lf = new Lfsr(rng, period);
    const out = [];
    for (let i = 0; i < n; i++) out.push(lf.next() * Math.exp(-rate * (i / SR)) * gain);
    return out;
  }

  function creak() {
    // slow stick-slip hinge squeak: sample-and-hold pitch jitter on a square
    const dur = rng.uniform(0.45, 1.1);
    const n = Math.trunc(SR * dur);
    const base = rng.uniform(250.0, 750.0);
    const drift = rng.uniform(-0.4, 0.7); // octaves of overall pitch drift
    const duty = rng.choice([0.25, 0.5]);
    const stepLen = Math.max(1, Math.trunc(SR * rng.uniform(0.012, 0.035)));
    tags.pitch_hz = iround(base);
    tags.motion = drift >= 0.0 ? 'rising' : 'settling';
    tags.texture = duty === 0.25 ? 'reedy' : 'hollow';
    tags.drift_oct = round1(drift);
    const buf = [];
    let phase = 0.0;
    let f = base;
    let amp = 0.0;
    let targetAmp = 0.0;
    let seg = 0;
    for (let i = 0; i < n; i++) {
      if (seg <= 0) {
        seg = stepLen + rng.randint(0, stepLen);
        f = base * Math.pow(2.0, drift * (i / n)) * rng.uniform(0.82, 1.22);
        targetAmp = rng.random() < 0.18 ? 0.0 : rng.uniform(0.5, 1.0);
      }
      seg -= 1;
      amp += (targetAmp - amp) * 0.01; // one-pole smoothing by hand
      phase += f / SR;
      const t = i / n;
      const env = Math.min(1.0, t * 6.0) * Math.min(1.0, (1.0 - t) * 4.0);
      buf.push(square(phase, duty) * amp * env * 0.8);
    }
    return buf;
  }

  function slam() {
    // heavy door slam: falling triangle thud + crunchy noise, optional after-shake
    const dur = rng.uniform(0.18, 0.42);
    const n = Math.trunc(SR * dur);
    const f0 = rng.uniform(90.0, 160.0);
    const f1 = rng.uniform(30.0, 55.0);
    tags.thud_hz = iround(f0);
    tags.weight = f0 < 125.0 ? 'deep' : 'boxy';
    const sweepT = dur * 0.6;
    const buf = renderTone(
      n,
      (t) => f0 + (f1 - f0) * Math.min(1.0, t / sweepT),
      0.5,
      decay(rng.uniform(9.0, 16.0)),
      'tri',
    );
    const nb = noiseBurst(
      Math.trunc(n * rng.uniform(0.3, 0.6)),
      rng.randint(4, 9),
      rng.uniform(30.0, 60.0),
      rng.uniform(0.5, 0.9),
    );
    mixAt(buf, nb, 0);
    const shudder = rng.random() < 0.5; // the frame shudders
    tags.frame = shudder ? 'shuddering' : 'clean';
    if (shudder) {
      const reps = rng.randint(1, 3);
      for (let k = 0; k < reps; k++) {
        const off = Math.trunc(n * rng.uniform(0.35, 0.9));
        const nb2 = noiseBurst(Math.trunc(SR * 0.03), rng.randint(3, 6), 80.0, 0.3 * Math.pow(0.6, k));
        mixAt(buf, nb2, off);
      }
    }
    return buf;
  }

  function latch() {
    // chest opening: two metal clicks then a short hinge squeak with vibrato
    function click(gain, fr) {
      const out = noiseBurst(Math.trunc(SR * rng.uniform(0.008, 0.018)), rng.randint(1, 2), 250.0, gain);
      const blip = renderTone(Math.trunc(SR * 0.02), () => fr, 0.125, decay(180.0));
      mixAt(out, blip, 0, 0.6 * gain);
      return out;
    }
    const buf = [];
    mixAt(buf, click(0.9, rng.uniform(1400.0, 2600.0)), 0);
    const gap = Math.trunc(SR * rng.uniform(0.04, 0.12));
    mixAt(buf, click(0.7, rng.uniform(900.0, 1800.0)), gap);
    const sqOff = gap + Math.trunc(SR * rng.uniform(0.05, 0.1));
    const sdur = rng.uniform(0.12, 0.3);
    const sn = Math.trunc(SR * sdur);
    const fb = rng.uniform(400.0, 900.0);
    const sw = rng.uniform(0.1, 0.6); // octaves up over the squeak
    const vib = rng.uniform(18.0, 40.0);
    tags.squeak_hz = iround(fb);
    tags.gap_ms = iround((gap * 1000.0) / SR);
    tags.vibrato = vib >= 29.0 ? 'fast' : 'slow';
    tags.rise = sw >= 0.35 ? 'climbing' : 'gentle';
    const sq = renderTone(
      sn,
      (t) => fb * Math.pow(2.0, (sw * t) / sdur) * (1.0 + 0.05 * Math.sin(2.0 * Math.PI * vib * t)),
      0.5,
      (t) => Math.min(1.0, t * 40.0) * Math.exp(-4.0 * t),
    );
    mixAt(buf, sq, sqOff, 0.55);
    return buf;
  }

  function lever() {
    // lever throw: rising scrape into a heavy clunk
    const trav = rng.uniform(0.05, 0.15);
    const sc = noiseBurst(Math.trunc(SR * trav), rng.randint(2, 4), 6.0, 0.35);
    const m = sc.length;
    for (let i = 0; i < m; i++) sc[i] *= (i + 1) / m; // ramp the scrape in
    const buf = [];
    mixAt(buf, sc, 0);
    const off = m;
    const f0 = rng.uniform(70.0, 130.0);
    const cn = Math.trunc(SR * rng.uniform(0.12, 0.22));
    const crate = rng.uniform(18.0, 30.0);
    tags.clunk_hz = iround(f0);
    tags.throw = trav >= 0.1 ? 'long' : 'short';
    tags.stop = crate >= 24.0 ? 'damped' : 'ringing';
    const clunk = renderTone(cn, (t) => f0 * (1.0 - 0.4 * Math.min(1.0, t * 12.0)), 0.5, decay(crate));
    mixAt(buf, clunk, off, 1.0);
    const nb = noiseBurst(Math.trunc(SR * 0.03), rng.randint(5, 9), 90.0, 0.8);
    mixAt(buf, nb, off);
    return buf;
  }

  function toggle() {
    // tiny toggle click, sometimes a click-clack pair
    function tick(fr, gain) {
      const out = noiseBurst(Math.trunc(SR * rng.uniform(0.004, 0.009)), 1, 400.0, gain);
      const blip = renderTone(Math.trunc(SR * 0.015), () => fr, 0.125, decay(250.0));
      mixAt(out, blip, 0, 0.7 * gain);
      return out;
    }
    const buf = [];
    const fr = rng.uniform(1800.0, 3200.0);
    tags.click_hz = iround(fr);
    tags.brightness = fr >= 2500.0 ? 'piercing' : 'crisp';
    mixAt(buf, tick(fr, 1.0), 0);
    const pair = rng.random() < 0.6;
    tags.action = pair ? 'click-clack pair' : 'single click';
    if (pair) {
      // left-to-right argument evaluation: the tick's draws precede the offset's
      const clack = tick(fr * rng.uniform(1.1, 1.4), 0.8);
      mixAt(buf, clack, Math.trunc(SR * rng.uniform(0.03, 0.09)));
    }
    for (let i = 0; i < Math.trunc(SR * 0.03); i++) buf.push(0.0);
    return buf;
  }

  function rattle() {
    // gate shaken: irregular clatters, each a crunch + detuned metal ping pair
    const buf = [];
    const hits = rng.randint(4, 9);
    const spacing = rng.uniform(0.045, 0.09);
    const fr = rng.uniform(500.0, 1100.0);
    tags.hits = hits;
    tags.ping_hz = iround(fr);
    tags.pace = spacing < 0.065 ? 'frantic' : 'loose';
    tags.register = fr >= 800.0 ? 'bright' : 'mid';
    let t0 = 0.0;
    for (let k = 0; k < hits; k++) {
      const off = Math.trunc(SR * t0);
      const g = 0.9 * Math.pow(0.82, k) * rng.uniform(0.7, 1.0);
      const nb = noiseBurst(Math.trunc(SR * rng.uniform(0.015, 0.03)), rng.randint(2, 5), 120.0, g);
      mixAt(buf, nb, off);
      const pn = Math.trunc(SR * 0.04);
      const fh = fr * rng.uniform(0.9, 1.1);
      const fh2 = fh * 1.02;
      mixAt(buf, renderTone(pn, () => fh, 0.25, decay(70.0)), off, 0.5 * g);
      mixAt(buf, renderTone(pn, () => fh2, 0.25, decay(70.0)), off, 0.4 * g);
      t0 += spacing * rng.uniform(0.6, 1.4);
    }
    for (let i = 0; i < Math.trunc(SR * 0.02); i++) buf.push(0.0);
    return buf;
  }

  function ratchet() {
    // winch: evenly ticking pawl, slightly accelerating, faint strain drone
    const clicks = rng.randint(5, 12);
    let spacing = rng.uniform(0.05, 0.11);
    const accel = rng.uniform(0.94, 1.02);
    const fr = rng.uniform(180.0, 380.0);
    tags.clicks = clicks;
    tags.tick_hz = iround(fr);
    tags.motion = accel < 1.0 ? 'accelerating' : 'steady';
    const buf = [];
    let t0 = 0.02;
    for (let k = 0; k < clicks; k++) {
      const off = Math.trunc(SR * t0);
      mixAt(buf, noiseBurst(Math.trunc(SR * 0.012), rng.randint(3, 6), 200.0, 0.85), off);
      const blip = renderTone(Math.trunc(SR * 0.03), () => fr * 2.0, 0.5, decay(120.0));
      mixAt(buf, blip, off, 0.6);
      t0 += spacing;
      spacing *= accel;
    }
    const droned = rng.random() < 0.6;
    tags.undertone = droned ? 'droning' : 'dry';
    if (droned) {
      const n = buf.length;
      const fd = fr * 0.35;
      const drone = renderTone(n, () => fd, 0.5, () => 1.0, 'tri');
      for (let i = 0; i < n; i++) {
        const tt = i / n;
        drone[i] *= 0.25 * Math.min(1.0, tt * 8.0) * Math.min(1.0, (1.0 - tt) * 6.0);
      }
      mixAt(buf, drone, 0);
    }
    for (let i = 0; i < Math.trunc(SR * 0.02); i++) buf.push(0.0);
    return buf;
  }

  function keys() {
    // key ring jangle: scattered detuned high ping pairs with click transients
    const dur = rng.uniform(0.3, 0.8);
    const buf = new Array(Math.trunc(SR * (dur + 0.08))).fill(0.0);
    const jingles = rng.randint(6, 14);
    tags.pings = jingles;
    tags.density = jingles >= 10 ? 'busy' : 'sparse';
    tags.shake = dur >= 0.55 ? 'sustained' : 'quick';
    for (let k = 0; k < jingles; k++) {
      const off = Math.trunc(SR * rng.uniform(0.0, dur));
      const f = rng.uniform(1200.0, 3400.0);
      const f2 = f * rng.uniform(1.01, 1.06);
      const pn = Math.trunc(SR * rng.uniform(0.03, 0.08));
      const g = rng.uniform(0.35, 0.8);
      mixAt(buf, renderTone(pn, () => f, 0.125, decay(rng.uniform(40.0, 90.0))), off, g);
      mixAt(buf, renderTone(pn, () => f2, 0.125, decay(rng.uniform(40.0, 90.0))), off, g * 0.8);
      mixAt(buf, noiseBurst(Math.trunc(SR * 0.006), 1, 300.0, g * 0.7), off);
    }
    return buf;
  }

  const style = rng.choice(['creak', 'slam', 'latch', 'lever', 'switch', 'rattle', 'ratchet', 'keys']);
  tags.style = style;
  let buf;
  if (style === 'creak') buf = creak();
  else if (style === 'slam') buf = slam();
  else if (style === 'latch') buf = latch();
  else if (style === 'lever') buf = lever();
  else if (style === 'switch') buf = toggle();
  else if (style === 'rattle') buf = rattle();
  else if (style === 'ratchet') buf = ratchet();
  else buf = keys();

  rng.tags = tags;

  // clamp duration to 0.1 - 1.2 s
  const nMin = Math.trunc(SR * 0.1);
  const nMax = Math.trunc(SR * 1.2);
  if (buf.length < nMin) {
    while (buf.length < nMin) buf.push(0.0);
  } else if (buf.length > nMax) {
    buf.length = nMax;
  }

  // one-pole DC blocker (narrow-duty squares carry a DC bias)
  dcBlock(buf, 0.995);

  // de-click edges, then normalize so the peak clears the quantizer floor
  const k = Math.min(Math.trunc(SR * 0.004), Math.trunc(buf.length / 2));
  for (let i = 0; i < k; i++) {
    const g = i / k;
    buf[i] *= g;
    buf[buf.length - 1 - i] *= g;
  }
  let peak = 0.0;
  for (const v of buf) {
    const a = v < 0.0 ? -v : v;
    if (a > peak) peak = a;
  }
  if (peak > 1e-9) {
    const g = rng.uniform(0.75, 0.95) / peak;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  return buf;
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const get = (k, d) => (t[k] === undefined || t[k] === null ? d : t[k]);
  const style = get('style', 'mech');
  if (style === 'creak') {
    return (
      `hinge creak — ${get('motion', 'wavering')} squeal around ` +
      `${get('pitch_hz', 0)} Hz, ${get('texture', 'hollow')} tone, ` +
      `${fmt1(get('drift_oct', 0.0))} oct drift`
    );
  }
  if (style === 'slam') {
    return `door slam — ${get('weight', 'heavy')} ${get('thud_hz', 0)} Hz thud into crunch, ${get('frame', 'clean')} frame`;
  }
  if (style === 'latch') {
    return (
      `chest latch — double click ${get('gap_ms', 0)} ms apart, ` +
      `${get('rise', 'gentle')} ${get('squeak_hz', 0)} Hz squeak, ` +
      `${get('vibrato', 'slow')} vibrato`
    );
  }
  if (style === 'lever') {
    return `lever throw — ${get('throw', 'short')} scrape into ${get('stop', 'ringing')} ${get('clunk_hz', 0)} Hz clunk`;
  }
  if (style === 'switch') {
    return `toggle switch — ${get('action', 'single click')} at ${get('click_hz', 0)} Hz, ${get('brightness', 'crisp')} tick`;
  }
  if (style === 'rattle') {
    return (
      `gate rattle — ${get('hits', 0)} ${get('register', 'mid')} ` +
      `clatters near ${get('ping_hz', 0)} Hz, ` +
      `${get('pace', 'loose')} shaking`
    );
  }
  if (style === 'ratchet') {
    const tail = get('undertone', '') === 'droning' ? 'over a faint strain drone' : 'dry mechanism';
    return (
      `winch ratchet — ${get('clicks', 0)} ` +
      `${get('motion', 'steady')} pawl ticks at ` +
      `${get('tick_hz', 0)} Hz, ${tail}`
    );
  }
  if (style === 'keys') {
    return `key-ring jangle — ${get('pings', 0)} detuned pings in a ${get('density', 'sparse')} ${get('shake', 'quick')} shake`;
  }
  return `${style} mechanism — chip-style object sfx with mixed clicks and tones`;
}

/** Short phrase for the README category table. */
export const character = 'creaks, slams, latches, levers, switches, rattles, ratchets, key jangles';
