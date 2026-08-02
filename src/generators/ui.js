// ui — the interface layer: clicks, hovers, toggles, dings, error buzzes,
// success chimes, keyboard ticks and scroll staircases. Eight sub-styles that
// share one budget: be recognizable in under a tenth of a second and never step
// on the music. These are the sounds a player hears ten thousand times, so the
// port has to keep every one of them sounding exactly as it always has.
//
// Ported 1:1 from `gen_ui` / `describe_ui` in scripts/generate_sfx.py. Two
// warm-up `random()` draws precede the style pick — they decorrelate the style
// across adjacent seeds, and dropping them would reshuffle the whole category.
// The draw order after that IS each effect's identity: `ui_042` stays `ui_042`.

import { SR, Lfsr, square, triangle, midi, noteName, noteOfHz } from '../dsp.js';

/** Python's round(): half-to-even, unlike JS's half-up Math.round. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's round(x, 1) — the beat rate is reported to a tenth of a Hz. */
function pyRound1(x) {
  return pyRound(x * 10) / 10;
}

/** Mirror of the Python `duty_word` lookup: pulse width as a timbre word. */
function dutyWord(d) {
  if (d === 0.125) return 'reedy';
  if (d === 0.25) return 'nasal';
  if (d === 0.5) return 'hollow';
  return String(d);
}

/** Python's list.extend — avoids blowing the stack that `push(...src)` would. */
function pushAll(dst, src) {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
  return dst;
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  rng.random();
  rng.random(); // warm-up draws: decorrelates style pick across nearby seeds
  const style = rng.choice(['click', 'hover', 'toggle', 'ding', 'error', 'success', 'type', 'scroll']);
  let out = [];

  // Square/triangle tone, exponential pitch glide f0 -> f1, exp decay envelope.
  // The pulse wave is DC-corrected inline so thin duties stay centered.
  function tone(n, f0, f1, duty, rate, wav = 'sq') {
    const buf = new Array(n);
    let ph = 0.0;
    const dc = 2.0 * duty - 1.0;
    const ratio = f1 / f0;
    const den = Math.max(1, n - 1);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const u = i / den;
      ph += (f0 * Math.pow(ratio, u)) / SR;
      const s = wav === 'tri' ? triangle(ph) : square(ph, duty) - dc;
      buf[i] = s * Math.exp(-rate * t);
    }
    return buf;
  }

  if (style === 'click') {
    // mouse click: fast falling square chirp, optional 1.5 ms noise transient
    const n = Math.floor(SR * rng.uniform(0.032, 0.055));
    const f0 = rng.uniform(1100.0, 3200.0);
    const fall = rng.uniform(0.3, 0.65);
    const duty = rng.choice([0.125, 0.25, 0.5]);
    const rate = rng.uniform(70.0, 130.0);
    out = tone(n, f0, f0 * fall, duty, rate);
    const noisy = rng.random() < 0.5;
    rng.tags = {
      style: 'click',
      pitch_hz: pyRound(f0),
      tone: dutyWord(duty),
      attack: noisy ? 'noisy' : 'clean',
      note: noteOfHz(f0), // derived from a pitch already drawn — costs no draw
    };
    if (noisy) {
      const lf = new Lfsr(rng, 1);
      const m = Math.min(n, Math.floor(SR * 0.0015));
      for (let i = 0; i < m; i++) out[i] += 0.5 * lf.next() * (1.0 - i / m);
    }
  } else if (style === 'hover') {
    // soft hover blip: triangle, slight upward glide, gentle decay
    const n = Math.floor(SR * rng.uniform(0.04, 0.08));
    const f0 = rng.uniform(550.0, 1400.0);
    const rise = rng.uniform(1.05, 1.35);
    const rate = rng.uniform(35.0, 60.0);
    out = tone(n, f0, f0 * rise, 0.5, rate, 'tri');
    rng.tags = {
      style: 'hover',
      pitch_hz: pyRound(f0),
      glide: rise > 1.2 ? 'wide' : 'slight',
      fade: rate < 47.5 ? 'lingering' : 'quick',
      note: noteOfHz(f0),
    };
  } else if (style === 'toggle') {
    // switch on/off: two short notes, up = on, down = off, tiny gap between
    const m = rng.randint(72, 86);
    const step = rng.choice([3, 4, 5, 7]);
    const up = rng.random() < 0.5;
    const seq = up ? [m, m + step] : [m + step, m];
    const ndur = rng.uniform(0.028, 0.045);
    const duty = rng.choice([0.25, 0.5]);
    const wav = rng.choice(['sq', 'sq', 'tri']);
    const rate = rng.uniform(45.0, 80.0);
    rng.tags = {
      style: 'toggle',
      direction: up ? 'up' : 'down',
      interval: step,
      note_hz: pyRound(midi(m)),
      timbre: wav === 'tri' ? 'triangle' : dutyWord(duty) + ' pulse',
      note: noteName(m), // the midi number gen() already drew — no extra draw
    };
    for (let k = 0; k < seq.length; k++) {
      const f = midi(seq[k]);
      pushAll(out, tone(Math.floor(SR * ndur), f, f, duty, rate, wav));
      if (k === 0) {
        const gap = Math.floor(SR * rng.uniform(0.004, 0.01));
        for (let i = 0; i < gap; i++) out.push(0.0);
      }
    }
  } else if (style === 'ding') {
    // notification ding: two detuned voices beating, optional octave sparkle
    const n = Math.floor(SR * rng.uniform(0.16, 0.28));
    const note = rng.randint(86, 98);
    const f = midi(note);
    const det = rng.uniform(0.5, 3.5);
    const rate = rng.uniform(9.0, 16.0);
    const wav = rng.choice(['tri', 'sq', 'sq']);
    const duty = rng.choice([0.25, 0.5]);
    const dc = 2.0 * duty - 1.0;
    const sparkle = rng.random() < 0.5;
    rng.tags = {
      style: 'ding',
      pitch_hz: pyRound(f),
      beat_hz: pyRound1(det),
      timbre: wav === 'tri' ? 'triangle' : dutyWord(duty) + ' pulse',
      finish: sparkle ? 'octave-sparkle' : 'pure',
      note: noteName(note),
    };
    let ph1 = 0.0;
    let ph2 = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph1 += f / SR;
      ph2 += (f + det) / SR;
      let s;
      if (wav === 'tri') {
        s = 0.5 * (triangle(ph1) + triangle(ph2));
      } else {
        s = 0.5 * (square(ph1, duty) + square(ph2, duty)) - dc;
      }
      if (sparkle && t < 0.03) s += 0.5 * square(ph1 * 2.0, 0.5) * (1.0 - t / 0.03);
      out.push(s * Math.exp(-rate * t));
    }
  } else if (style === 'error') {
    // error buzz: low thin-duty square, hard amplitude gating, pitch droop
    const dur = rng.uniform(0.14, 0.26);
    const f = rng.uniform(85.0, 190.0);
    const duty = rng.choice([0.125, 0.25, 0.5]);
    const dc = 2.0 * duty - 1.0;
    const gate = rng.uniform(18.0, 45.0);
    const nb = rng.choice([1, 1, 2]);
    const rate = rng.uniform(4.0, 9.0);
    const drop = rng.uniform(0.75, 1.0);
    rng.tags = {
      style: 'error',
      buzz_hz: pyRound(f),
      bursts: nb,
      tone: dutyWord(duty),
      droop: drop < 0.875 ? 'sagging' : 'steady',
      note: noteOfHz(f),
    };
    for (let b = 0; b < nb; b++) {
      const n = Math.floor(SR * (dur / nb) * (nb === 2 ? 0.8 : 1.0));
      const den = Math.max(1, n - 1);
      let ph = 0.0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const u = i / den;
        ph += (f * (1.0 - (1.0 - drop) * u)) / SR;
        const g8 = (t * gate) % 1.0 < 0.6 ? 1.0 : 0.25;
        const s = square(ph, duty) - dc;
        out.push(s * g8 * Math.exp(-rate * t));
      }
      if (nb === 2 && b === 0) {
        const gap = Math.floor(SR * 0.03);
        for (let i = 0; i < gap; i++) out.push(0.0);
      }
    }
  } else if (style === 'success') {
    // success chime: rising arpeggio, last note rings out longer
    const m = rng.randint(72, 84);
    const pat = rng.choice([[0, 4, 7], [0, 4, 7, 12], [0, 3, 7, 12], [0, 5, 9], [0, 7, 12]]);
    // the uniform draw happens even when the 0.25/len cap wins — keep it first
    const ndur = Math.min(rng.uniform(0.045, 0.07), 0.25 / pat.length);
    const duty = rng.choice([0.125, 0.25, 0.5]);
    const wav = rng.choice(['sq', 'sq', 'tri']);
    const flavor = { 4: 'major', 3: 'minor', 5: 'quartal', 7: 'open-fifth' }[pat[1]];
    rng.tags = {
      style: 'success',
      flavor,
      notes: pat.length,
      root_hz: pyRound(midi(m)),
      timbre: wav === 'tri' ? 'triangle' : dutyWord(duty) + ' pulse',
      note: noteName(m),
    };
    for (let k = 0; k < pat.length; k++) {
      const f = midi(m + pat[k]);
      const last = k === pat.length - 1;
      const nn = Math.floor(SR * ndur * (last ? 1.6 : 1.0));
      const rate = last ? rng.uniform(10.0, 18.0) : rng.uniform(20.0, 35.0);
      pushAll(out, tone(nn, f, f, duty, rate, wav));
    }
  } else if (style === 'type') {
    // keyboard tick: bright LFSR burst with a fast decay, optional low thock
    const n = Math.floor(SR * rng.uniform(0.032, 0.05));
    const period = rng.choice([1, 1, 2, 3]);
    const lf = new Lfsr(rng, period);
    const rate = rng.uniform(120.0, 260.0);
    const thock = rng.random() < 0.6;
    const ft = rng.uniform(250.0, 700.0); // drawn either way, so the order holds
    const tags = {
      style: 'type',
      texture: { 1: 'bright', 2: 'gritty', 3: 'metallic' }[period],
      body: thock ? 'thocky' : 'dry',
      decay_rate: pyRound(rate),
    };
    if (thock) {
      tags.thock_hz = pyRound(ft);
      tags.note = noteOfHz(ft); // only the thock body carries a pitch
    }
    rng.tags = tags;
    let ph = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let s = lf.next() * Math.exp(-rate * t);
      if (thock) {
        ph += ft / SR;
        s += 0.7 * triangle(ph) * Math.exp(-rate * 1.6 * t);
      }
      out.push(s);
    }
  } else {
    // scroll blip: sample-and-hold pitch staircase, up or down
    const n = Math.floor(SR * rng.uniform(0.032, 0.06));
    let cf = rng.uniform(900.0, 2200.0);
    const start = cf;
    let ratio = rng.uniform(1.1, 1.35);
    const falling = rng.random() < 0.5;
    if (falling) ratio = 1.0 / ratio;
    const steplen = Math.max(1, Math.floor(SR * rng.uniform(0.004, 0.008)));
    const duty = rng.choice([0.25, 0.5]);
    const dc = 2.0 * duty - 1.0;
    const rate = rng.uniform(40.0, 80.0);
    rng.tags = {
      style: 'scroll',
      direction: falling ? 'falling' : 'rising',
      start_hz: pyRound(start),
      steps: Math.floor(n / steplen), // Python's // on positive ints
      tone: dutyWord(duty),
      note: noteOfHz(start),
    };
    let ph = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      if (i > 0 && i % steplen === 0) cf *= ratio;
      ph += cf / SR;
      out.push((square(ph, duty) - dc) * Math.exp(-rate * t));
    }
  }

  // de-click edges: ~0.4 ms fade-in, 2 ms fade-out to exactly zero
  const n = out.length;
  const fi = Math.min(n, 8);
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  const fo = Math.min(n, Math.floor(SR * 0.002));
  for (let i = 0; i < fo; i++) out[n - 1 - i] *= i / fo;

  // normalize so the quantizer downstream always gets a healthy signal
  let peak = 0.0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  if (peak > 1e-9) {
    const g = 0.85 / peak;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  return out;
}

/** Python's `%d`: truncate toward zero, and never throw on a stray tag. */
function d(v) {
  const x = Math.trunc(Number(v));
  return Number.isFinite(x) ? x : 0;
}

/** Python's `%.1f`. */
function f1(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x.toFixed(1) : String(v);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const style = t.style === undefined ? 'ui' : t.style;

  if (style === 'click') {
    return `mouse click — ${t.tone} pulse chirp falling from ${d(t.pitch_hz)} Hz, ${t.attack} attack`;
  }
  if (style === 'hover') {
    return `soft hover blip — triangle at ${d(t.pitch_hz)} Hz, ${t.glide} upward glide, ${t.fade} fade`;
  }
  if (style === 'toggle') {
    return `toggle switch — ${t.direction} ${d(t.interval)}-semitone flick at ${d(t.note_hz)} Hz, ${t.timbre} voice`;
  }
  if (style === 'ding') {
    return `notification ding — ${t.timbre} pair at ${d(t.pitch_hz)} Hz beating ${f1(t.beat_hz)} Hz, ${t.finish} tail`;
  }
  if (style === 'error') {
    const burst = t.bursts === 2 ? 'double burst' : 'single burst';
    return `error buzz — ${t.tone} pulse at ${d(t.buzz_hz)} Hz, ${burst}, ${t.droop} pitch`;
  }
  if (style === 'success') {
    return `success chime — ${t.flavor} arpeggio, ${d(t.notes)} rising notes from ${d(t.root_hz)} Hz, ${t.timbre} voice`;
  }
  if (style === 'type') {
    if ('thock_hz' in t) {
      return `keyboard tick — ${t.texture} noise snap at ${d(t.decay_rate)}/s with a ${d(t.thock_hz)} Hz thock`;
    }
    return `keyboard tick — ${t.texture} noise snap at ${d(t.decay_rate)}/s, dry body`;
  }
  if (style === 'scroll') {
    return `scroll blip — ${t.direction} ${d(t.steps)}-step pitch staircase from ${d(t.start_hz)} Hz, ${t.tone} pulse`;
  }

  // unknown style: still deterministic, never raises
  const extras = Object.keys(t)
    .filter((k) => k !== 'style')
    .sort()
    .map((k) => String(t[k]))
    .join(', ');
  const text = extras ? `${style} ui cue — ${extras}` : `${style} ui cue`;
  return text.length < 30 ? (text + ' (chip ui one-shot)').slice(0, 95) : text.slice(0, 95);
}

/** Short phrase for the README category table. */
export const character = 'menu clicks, hovers, toggles, dings, error buzzes, key ticks';
