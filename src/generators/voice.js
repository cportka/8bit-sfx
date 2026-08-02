// voice — chip-imitated people sounds: babble blips, grunts, hums, laughs,
// gasps, sighs and "hey!" calls. Every sub-style is built from the same body:
// two detuned oscillators beating against each other, which is what turns a
// bare square into something that reads as a throat.
//
// Ported 1:1 from `gen_voice` / `describe_voice` in scripts/generate_sfx.py.
// The rng draw order below is the effect's identity — nothing may be added,
// removed, or reordered, or `voice_042` stops being `voice_042`.

import { SR, Lfsr, square, triangle, midi, noteOfHz, mixAt, dcBlock } from '../dsp.js';

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
  const out = [];

  // Formant-ish voice body: two chip oscillators a hair apart in pitch. Their
  // beating is the whole trick — it reads as vocal cords, not as a bleep.
  const twoTone = (n, freqFn, duty, envFn, det, wave, amp = 0.42) => {
    const buf = new Array(n);
    let p1 = 0.0;
    let p2 = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = freqFn(t);
      p1 += f / SR;
      p2 += (f * det) / SR;
      const s = wave === 'tri' ? triangle(p1) + triangle(p2) : square(p1, duty) + square(p2, duty);
      buf[i] = s * amp * envFn(t);
    }
    return buf;
  };

  const style = rng.choice(['babble', 'grunt', 'hum', 'laugh', 'gasp', 'sigh', 'hey']);

  if (style === 'babble') {
    // Animalese-style dialog: a run of quick pitch-stepped syllable blips.
    const base = midi(rng.randint(60, 76));
    const det = rng.uniform(1.008, 1.02);
    const nSyll = rng.randint(3, 8);
    const gap = Math.floor(SR * rng.uniform(0.008, 0.02)); // Python int(): truncates
    let pos = 0;
    for (let k = 0; k < nSyll; k++) {
      const dur = rng.uniform(0.035, 0.075);
      const n = Math.floor(SR * dur);
      const f0 = base * Math.pow(2.0, rng.uniform(-4.0, 5.0) / 12.0);
      const glide = rng.uniform(-0.25, 0.35); // octaves across the syllable
      const duty = rng.choice([0.125, 0.25, 0.5]);
      const wave = rng.choice(['sq', 'sq', 'tri']);
      const fr = (t) => f0 * Math.pow(2.0, (glide * t) / dur);
      const env = (t) => Math.exp((-6.0 * t) / dur) * Math.min(1.0, t / 0.004);
      mixAt(out, twoTone(n, fr, duty, env, det, wave), pos);
      pos += n + gap;
    }
    rng.tags = {
      style: 'babble',
      register: base >= 380.0 ? 'high' : 'mid',
      pace: gap < 308 ? 'rapid' : 'measured',
      syllables: nSyll,
      pitch_hz: pyRound(base),
      note: noteOfHz(base), // derived from a value already drawn; costs no draw
    };
  } else if (style === 'grunt') {
    // Low pitch-drop with rough beating and a crunchy throat rasp.
    const f0 = midi(rng.randint(38, 50));
    const drop = rng.uniform(0.3, 0.55);
    const dur = rng.uniform(0.12, 0.26);
    const n = Math.floor(SR * dur);
    const det = rng.uniform(1.02, 1.05);
    const duty = rng.choice([0.25, 0.5]);
    const vib = rng.uniform(20.0, 45.0);
    const vdep = rng.uniform(0.01, 0.04);
    const fr = (t) =>
      f0 * (1.0 - (drop * t) / dur) * (1.0 + vdep * Math.sin(2 * Math.PI * vib * t));
    const env = (t) => Math.exp((-9.0 * t) / dur) * Math.min(1.0, t / 0.006);
    mixAt(out, twoTone(n, fr, duty, env, det, 'sq'), 0);
    // The period argument is drawn *before* the Lfsr constructor's own
    // randint(1, 32767) seed draw — same evaluation order as Python.
    const lf = new Lfsr(rng, rng.randint(6, 12));
    const rn = Math.floor(n * rng.uniform(0.3, 0.6));
    const rasp = new Array(rn);
    for (let i = 0; i < rn; i++) {
      const t = i / SR;
      rasp[i] = lf.next() * 0.18 * Math.exp((-14.0 * t) / dur);
    }
    mixAt(out, rasp, 0);
    rng.tags = {
      style: 'grunt',
      register: f0 < 104.0 ? 'deep' : 'low',
      texture: det >= 1.035 ? 'rough' : 'gravelly',
      pitch_hz: pyRound(f0),
      note: noteOfHz(f0),
    };
  } else if (style === 'hum') {
    // Soft melodic hum: 1-3 held notes on beating triangles with slow vibrato.
    const root = rng.randint(50, 62);
    const steps = [0, rng.choice([2, 3, 4]), rng.choice([5, 7, 9])];
    const nNotes = rng.randint(1, 3);
    const dur = rng.uniform(0.4, 0.85);
    const n = Math.floor(SR * dur);
    const det = rng.uniform(1.004, 1.012);
    const vib = rng.uniform(4.5, 7.0);
    const vdep = rng.uniform(0.006, 0.02);
    const seg = dur / nNotes;
    const notes = [];
    for (let k = 0; k < nNotes; k++) notes.push(midi(root + rng.choice(steps)));

    const fr = (t) => {
      const k = Math.min(nNotes - 1, Math.floor(t / seg));
      return notes[k] * (1.0 + vdep * Math.sin(2 * Math.PI * vib * t));
    };
    const atk = rng.uniform(0.03, 0.08);
    const env = (t) => Math.min(1.0, t / atk) * Math.min(1.0, Math.max(0.0, dur - t) / 0.09);
    mixAt(out, twoTone(n, fr, 0.5, env, det, 'tri', 0.5), 0);
    rng.tags = {
      style: 'hum',
      register: notes[0] < 196.0 ? 'low' : notes[0] < 311.0 ? 'mid' : 'high',
      vibrato: vdep < 0.012 ? 'subtle' : 'wavering',
      notes: nNotes,
      pitch_hz: pyRound(notes[0]),
      note: noteOfHz(notes[0]),
    };
  } else if (style === 'laugh') {
    // "Ha-ha-ha": a descending run of pitch-drooping bursts, each with a
    // breathy 'h' onset from the shared noise source.
    const base = midi(rng.randint(55, 70));
    const det = rng.uniform(1.01, 1.03);
    const nHa = rng.randint(3, 6);
    const duty = rng.choice([0.25, 0.5]);
    const step = rng.uniform(0.94, 0.985);
    const lf = new Lfsr(rng, rng.randint(2, 5));
    let pos = 0;
    let f = base;
    for (let k = 0; k < nHa; k++) {
      const dur = rng.uniform(0.06, 0.1);
      const n = Math.floor(SR * dur);
      const fk = f; // Python pins it with a default arg; a fresh const does the same
      const fr = (t) => fk * (1.0 - (0.12 * t) / dur);
      const env = (t) => Math.exp((-7.0 * t) / dur) * Math.min(1.0, t / 0.003);
      mixAt(out, twoTone(n, fr, duty, env, det, 'sq'), pos);
      const bn = Math.floor(SR * 0.012);
      const br = new Array(bn);
      for (let i = 0; i < bn; i++) br[i] = lf.next() * 0.22 * (1.0 - i / bn);
      mixAt(out, br, pos);
      pos += n + Math.floor(SR * rng.uniform(0.02, 0.05));
      f *= step;
    }
    rng.tags = {
      style: 'laugh',
      timbre: duty === 0.25 ? 'reedy' : 'round',
      descent: step < 0.962 ? 'tumbling' : 'even',
      bursts: nHa,
      pitch_hz: pyRound(base),
      note: noteOfHz(base),
    };
  } else if (style === 'gasp') {
    // Sharp inhale: noise whose sample-and-hold rate sweeps crunchy -> bright,
    // under a rising airy tone.
    const dur = rng.uniform(0.12, 0.3);
    const n = Math.floor(SR * dur);
    const lf = new Lfsr(rng, 1);
    let hold = 0;
    let val = 0.0;
    const noise = new Array(n);
    for (let i = 0; i < n; i++) {
      const frac = i / SR / dur;
      if (hold <= 0) {
        val = lf.next();
        hold = Math.max(1, Math.floor(9.0 - 8.0 * frac));
      }
      hold -= 1;
      noise[i] = val * 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1.0, frac)), 0.7);
    }
    mixAt(out, noise, 0);
    const f0 = midi(rng.randint(62, 74));
    const rise = rng.uniform(0.6, 1.2); // octaves swept upward
    const det = rng.uniform(1.01, 1.03);
    const fr = (t) => f0 * Math.pow(2.0, (rise * t) / dur);
    const env = (t) => 0.6 * Math.sin(Math.PI * Math.min(1.0, t / dur));
    mixAt(out, twoTone(n, fr, 0.5, env, det, 'tri', 0.35), 0);
    rng.tags = {
      style: 'gasp',
      attack: dur < 0.2 ? 'quick' : 'drawn',
      register: f0 >= 415.0 ? 'high' : 'mid',
      rise_oct: Number(rise.toFixed(1)), // Python: round(rise, 1)
      pitch_hz: pyRound(f0),
      note: noteOfHz(f0),
    };
  } else if (style === 'sigh') {
    // Long falling glide on beating triangles, with a breath layer over it.
    const dur = rng.uniform(0.45, 0.88);
    const n = Math.floor(SR * dur);
    const f0 = midi(rng.randint(57, 69));
    const fall = rng.uniform(0.5, 0.9); // octaves down
    const det = rng.uniform(1.005, 1.015);
    const vib = rng.uniform(4.0, 6.5);
    const vdep = rng.uniform(0.008, 0.02);
    const fr = (t) =>
      f0 * Math.pow(2.0, (-fall * t) / dur) * (1.0 + vdep * Math.sin(2 * Math.PI * vib * t));
    const atk = rng.uniform(0.04, 0.1);
    const env = (t) => Math.min(1.0, t / atk) * Math.pow(Math.max(0.0, 1.0 - t / dur), 1.3);
    mixAt(out, twoTone(n, fr, 0.5, env, det, 'tri', 0.5), 0);
    const lf = new Lfsr(rng, rng.randint(1, 3));
    const br = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      br[i] =
        lf.next() * 0.12 * Math.min(1.0, t / atk) * Math.pow(Math.max(0.0, 1.0 - t / dur), 2);
    }
    mixAt(out, br, 0);
    rng.tags = {
      style: 'sigh',
      register: f0 < 311.0 ? 'low' : 'high',
      vibrato: vdep < 0.013 ? 'steady' : 'quavering',
      fall_oct: Number(fall.toFixed(1)), // Python: round(fall, 1)
      pitch_hz: pyRound(f0),
      note: noteOfHz(f0),
    };
  } else {
    // "he-EY!": a fast pitch jump up, held with a droop, bright duty and
    // strong beating.
    const dur = rng.uniform(0.15, 0.35);
    const n = Math.floor(SR * dur);
    const f0 = midi(rng.randint(57, 70));
    const jump = Math.pow(2.0, rng.randint(3, 8) / 12.0);
    const det = rng.uniform(1.015, 1.035);
    const duty = rng.choice([0.125, 0.25]);
    const t1 = dur * rng.uniform(0.25, 0.4);

    const fr = (t) => {
      if (t < t1) return f0 * (1.0 + (jump - 1.0) * Math.pow(t / t1, 2));
      const u = (t - t1) / (dur - t1);
      return f0 * jump * (1.0 - 0.18 * u * u);
    };
    const env = (t) =>
      Math.min(1.0, t / 0.005) *
      (t < dur * 0.7 ? 1.0 : Math.max(0.0, 1.0 - (t - dur * 0.7) / (dur * 0.3)));
    mixAt(out, twoTone(n, fr, duty, env, det, 'sq', 0.45), 0);
    rng.tags = {
      style: 'hey',
      register: f0 < 311.0 ? 'low' : 'high',
      timbre: duty === 0.125 ? 'piercing' : 'brassy',
      jump_semi: pyRound(12.0 * Math.log2(jump)),
      pitch_hz: pyRound(f0),
      note: noteOfHz(f0),
    };
  }

  if (out.length === 0) for (let i = 0; i < Math.floor(SR * 0.1); i++) out.push(0.0);

  // Tail treatment, exactly as Python does it — and it is load-bearing, not
  // cosmetic. `finish()` is NOT a substitute: Python fades only the *tail*
  // (96 samples), and its normalize target is a **drawn** value,
  // rng.uniform(0.7, 0.9). Swapping in a fixed 0.9 target both changes every
  // sample's amplitude and skips a draw the seed sequence accounts for.
  dcBlock(out);
  const fade = Math.min(out.length, 96);
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  let peak = 0.0;
  for (const v of out) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  if (peak > 1e-9) {
    const g = rng.uniform(0.7, 0.9) / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}

const str = (v, fallback) => (typeof v === 'string' && v ? v : fallback);
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const oct = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toFixed(1);

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const hz = int(t.pitch_hz);
  switch (t.style) {
    case 'babble':
      return `chip-speech babble — ${str(t.register, 'mid')} ${hz} Hz voice, ${str(t.pace, 'rapid')} delivery, ${int(t.syllables)}-syllable run`;
    case 'grunt':
      return `throaty grunt — ${str(t.register, 'low')} ${hz} Hz pitch-drop, ${str(t.texture, 'gravelly')} beating rasp`;
    case 'hum':
      return `melodic hum — ${str(t.register, 'mid')} ${hz} Hz triangle drone, ${str(t.vibrato, 'subtle')} vibrato, ${int(t.notes)}-note phrase`;
    case 'laugh':
      return `chiptune laugh — ${int(t.bursts)}x ${str(t.timbre, 'round')} ha-bursts from ${hz} Hz in a ${str(t.descent, 'even')} descent`;
    case 'gasp':
      return `sharp gasp — ${str(t.attack, 'quick')} inhale with an airy ${str(t.register, 'mid')}-register rise of ${oct(t.rise_oct)} oct from ${hz} Hz`;
    case 'sigh':
      return `weary sigh — ${str(t.register, 'low')} ${hz} Hz glide falling ${oct(t.fall_oct)} oct, ${str(t.vibrato, 'steady')} vibrato and breath`;
    case 'hey':
      return `chip 'hey!' shout — ${str(t.timbre, 'brassy')} ${str(t.register, 'high')} register at ${hz} Hz, ${int(t.jump_semi)}-semitone leap`;
    default:
      return `chip voice effect — ${str(t.style, 'plain')} style around ${hz} Hz`;
  }
}

/** Short phrase for the README category table. */
export const character = 'chip-speech babble, grunts, hums, laughs, gasps, sighs, hey! calls';
