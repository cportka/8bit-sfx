// arp — the moving line. Where `chord` states a harmony all at once and `lead`
// sings over it, an arp spells the chord out one note at a time: the pattern a
// chip track runs underneath everything so three voices sound like six.
//
// Every note is an exact MIDI number derived from a root and a chord formula, so
// a run is in tune with the bass, the pads and the leads by construction — and
// both the root pitch and the chord quality are recorded in the tags, because
// that is how a musician picks one: "give me the C minor 7th run".
//
// Eleven sub-styles cover the arpeggiator vocabulary: straight ascending and
// descending chord-tone runs, up-down turns (inclusive or exclusive at the
// turnaround), octave-jumping patterns, fast sixteenth/thirty-second runs across
// two or three octaves, slow triplet rolls, random-order patterns, extended
// (7th/9th) chord arps, harp glissandi where the notes ring into each other,
// Alberti/pedal-tone alternations, and ratcheted bursts that stutter each step.
//
// The synthesis is pure chip: naive squares at three duty cycles, triangles and
// saws, LFSR noise for the pick click on an attack, hand-rolled one-pole
// lowpasses tracking each note's pitch, and a sample-and-hold level crush for
// grit. Post-processing is uniform — DC block (narrow-duty squares carry a big
// bias), de-click both edges, then normalize last so the peak is exact.

import { SR, Lfsr, midi, noteName, renderTone, finish, mixAt, dcBlock } from '../dsp.js';

const MIN_N = Math.round(0.3 * SR);
const MAX_N = Math.round(2.0 * SR);
const MAX_DUR = 1.95; // musical content stops here, so the hard trim never bites
const TOP_M = 96; // C7 — nothing in an arp needs to scream above this

/** Seconds to a sample count, never zero-length. */
function secs(s) {
  return Math.max(1, Math.round(s * SR));
}

/** "12.5% duty" / "25% duty" / "50% duty". */
function dutyLabel(d) {
  return `${d * 100}% duty`;
}

/** How a voice is described in the catalog. */
function toneLabel(wave, duty) {
  return wave === 'tri' ? 'triangle' : wave === 'saw' ? 'sawtooth' : dutyLabel(duty);
}

/** One-pole lowpass in place, cutoff in Hz. */
function lowpass(buf, cutoff) {
  const c = Math.max(40, Math.min(SR * 0.45, cutoff));
  const a = 1.0 - Math.exp((-2.0 * Math.PI * c) / SR);
  let p = 0.0;
  for (let i = 0; i < buf.length; i++) {
    p += a * (buf[i] - p);
    buf[i] = p;
  }
  return buf;
}

/** Sample-and-hold rate reduction plus a coarse level crush, in place. */
function crush(buf, steps, hold) {
  let held = 0.0;
  for (let i = 0; i < buf.length; i++) {
    if (i % hold === 0) held = buf[i];
    buf[i] = Math.round(held * steps) / steps;
  }
  return buf;
}

// The harmony an arp spells out. Triads and sixths first, then the extended
// chords the `seventh` style draws from — every one a set of semitone offsets.
const TRIADS = [
  { name: 'major', steps: [0, 4, 7] },
  { name: 'minor', steps: [0, 3, 7] },
  { name: 'sus4', steps: [0, 5, 7] },
  { name: 'sus2', steps: [0, 2, 7] },
  { name: 'diminished', steps: [0, 3, 6] },
  { name: 'augmented', steps: [0, 4, 8] },
  { name: 'major 6th', steps: [0, 4, 7, 9] },
  { name: 'minor 6th', steps: [0, 3, 7, 9] },
];

const SEVENTHS = [
  { name: 'major 7th', steps: [0, 4, 7, 11] },
  { name: 'minor 7th', steps: [0, 3, 7, 10] },
  { name: 'dominant 7th', steps: [0, 4, 7, 10] },
  { name: 'half-dim 7th', steps: [0, 3, 6, 10] },
  { name: 'dim 7th', steps: [0, 3, 6, 9] },
  { name: 'minor 9th', steps: [0, 3, 7, 10, 14] },
  { name: 'major add9', steps: [0, 4, 7, 14] },
  { name: 'minor add9', steps: [0, 3, 7, 14] },
];

const ALL_CHORDS = [...TRIADS, ...SEVENTHS];

// Rhythmic grids, so a run's tempo tag means what a sequencer means by it.
const DIVS = {
  sixteenth: { per: 4, word: 'sixteenths' },
  eighth: { per: 2, word: 'eighths' },
  triplet: { per: 3, word: 'triplets' },
  thirtysecond: { per: 8, word: '32nd notes' },
};

/** Chord tones stacked across `octaves` octaves, capped by the top root. */
function chordPool(root, steps, octaves) {
  const pool = [];
  for (let o = 0; o < octaves; o++) for (const s of steps) pool.push(root + s + 12 * o);
  pool.push(root + 12 * octaves);
  return pool;
}

/** Repeat a pattern out to `count` notes. */
function cycleTo(seq, count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = seq[i % seq.length];
  return out;
}

/** A root that keeps the whole run under C7. */
function pickRoot(rng, lo, hi, span) {
  return rng.randint(lo, Math.max(lo, Math.min(hi, TOP_M - span)));
}

/** Octave span of the notes actually played — what the catalog claims. */
function octSpan(seq) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of seq) {
    if (m < lo) lo = m;
    if (m > hi) hi = m;
  }
  return Math.max(1, Math.round((hi - lo) / 12));
}

/** Notes that fit: never more than `want`, never running past MAX_DUR. */
function fitCount(want, step, ring, min) {
  const room = MAX_DUR - ring;
  const can = room <= 0 ? min : Math.floor(room / step) + 1;
  return Math.max(min, Math.min(want, can));
}

/** Last-resort spacing squeeze, for the rare pattern too long even at `min`. */
function fitStep(step, lastAt, ring) {
  if (lastAt <= 0) return step;
  return Math.min(step, Math.max(0.008, (MAX_DUR - ring) / lastAt));
}

/** Beats per minute implied by a step on a given grid. */
function bpmOf(step, per) {
  return Math.round(60.0 / (step * per));
}

/** One variation. Returns Array<number> of samples in [-1,1]; sets rng.tags. */
export function gen(rng) {
  const style = rng.choice([
    'up', 'down', 'updown', 'octave', 'run', 'triplet', 'random', 'seventh', 'harp', 'pedal', 'ratchet',
  ]);

  // --- shared voice and sequencer -----------------------------------------

  /** Lowpassed LFSR blip — the pick click on a note attack. */
  const tickBuf = (n, period, alpha, rate) => {
    const noise = new Lfsr(rng, period);
    const b = new Array(n);
    let p = 0.0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      p += alpha * (noise.next() - p);
      b[i] = p * Math.min(1.0, t / 0.0004) * Math.exp(-rate * t);
    }
    return b;
  };

  /** One chip note: snap attack, decay toward a sustain floor, release ramp. */
  const voice = (m, len, o, relSec) => {
    const n = secs(len);
    const f = midi(m);
    const sus = o.sus || 0.0;
    const b = renderTone(
      n,
      o.vib ? (t) => f * Math.pow(2.0, (o.vib / 1200.0) * Math.sin(2 * Math.PI * o.vibHz * t)) : () => f,
      o.duty,
      (t) => Math.min(1.0, t / o.atk) * (sus + (1.0 - sus) * Math.exp(-o.rate * t)),
      o.wave
    );
    lowpass(b, f * o.cutMul);
    const rel = Math.max(8, Math.min(n >> 1, Math.round((relSec || o.rel) * SR)));
    for (let i = 0; i < rel; i++) b[n - 1 - i] *= i / rel;
    return b;
  };

  /** Render a note list into one buffer. Events: {m, at, len, g, rel}. */
  const play = (events, o) => {
    const out = [];
    const tk =
      o.tickG > 0
        ? tickBuf(secs(0.006), rng.randint(1, 3), rng.uniform(0.5, 0.95), rng.uniform(500, 1400))
        : null;
    for (const e of events) {
      const at = secs(e.at);
      mixAt(out, voice(e.m, e.len, o, e.rel), at, e.g);
      if (tk) mixAt(out, tk, at, o.tickG * e.g);
    }
    return out;
  };

  let out;
  let tags;

  if (style === 'up') {
    // the default arpeggiator setting: chord tones climbing, over and over
    const chord = rng.choice(ALL_CHORDS);
    const octaves = rng.randint(1, 3);
    const root = pickRoot(rng, 36, 70, 12 * octaves);
    const pool = chordPool(root, chord.steps, octaves);
    const divName = rng.choice(['sixteenth', 'sixteenth', 'eighth', 'triplet']);
    const div = DIVS[divName];
    let step = 60.0 / rng.randint(84, 180) / div.per;
    const gate = Math.max(0.035, Math.min(0.45, step * rng.uniform(0.7, 1.7)));
    const tail = rng.uniform(0.12, 0.42);
    const ring = gate + tail;
    const count = fitCount(pool.length * rng.randint(1, 2), step, ring, 3);
    step = fitStep(step, count - 1, ring);
    const seq = cycleTo(pool, count);
    const wave = rng.choice([null, null, null, 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const accent = rng.uniform(0.0, 0.4);
    const events = seq.map((m, k) => ({
      m,
      at: k * step,
      len: k === count - 1 ? ring : gate,
      g: k % pool.length === 0 ? 1.0 : 1.0 - accent,
      rel: k === count - 1 ? Math.min(tail, 0.2) : 0.008,
    }));
    out = play(events, {
      wave,
      duty,
      atk: rng.uniform(0.0008, 0.004),
      rate: rng.uniform(4.0, 18.0),
      sus: rng.uniform(0.0, 0.3),
      cutMul: rng.uniform(5.0, 16.0),
      rel: 0.008,
      tickG: 0,
    });
    // A root an octave under the run anchors it like a bass note would.
    const bassG = rng.uniform(0.0, 0.7);
    const anchored = bassG > 0.28;
    if (anchored) {
      mixAt(
        out,
        voice(root - 12, (count - 1) * step + ring, {
          wave: 'tri', duty: 0.5, atk: 0.003, rate: rng.uniform(1.2, 4.5), sus: 0.05, cutMul: 14.0, rel: 0.02,
        }),
        0,
        bassG
      );
    }
    tags = {
      style: 'up',
      chord: chord.name,
      tone: toneLabel(wave, duty),
      feel: div.word,
      bass: anchored ? 'anchored' : 'bare',
      octaves: octSpan(seq),
      bpm: bpmOf(step, div.per),
      note: noteName(root),
    };
  } else if (style === 'down') {
    // the same run inverted: falls from the top root back onto the tonic
    const chord = rng.choice(ALL_CHORDS);
    const octaves = rng.randint(1, 3);
    const root = pickRoot(rng, 38, 70, 12 * octaves);
    const pool = chordPool(root, chord.steps, octaves).slice().reverse();
    const divName = rng.choice(['sixteenth', 'sixteenth', 'eighth', 'triplet']);
    const div = DIVS[divName];
    let step = 60.0 / rng.randint(80, 170) / div.per;
    const gate = Math.max(0.04, Math.min(0.5, step * rng.uniform(0.8, 1.9)));
    const tail = rng.uniform(0.18, 0.55); // the landing note rings longer
    const ring = gate + tail;
    const count = fitCount(pool.length * rng.randint(1, 2), step, ring, 3);
    step = fitStep(step, count - 1, ring);
    const seq = cycleTo(pool, count);
    const wave = rng.choice([null, null, 'tri', 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    // Falling runs get darker as they descend — the filter closes with them.
    const cutTop = rng.uniform(7.0, 18.0);
    const cutEnd = cutTop * rng.uniform(0.3, 0.9);
    const opts = {
      wave, duty,
      atk: rng.uniform(0.001, 0.005),
      rate: rng.uniform(3.5, 14.0),
      sus: rng.uniform(0.0, 0.25),
      cutMul: cutTop,
      rel: 0.008,
      tickG: 0,
    };
    out = [];
    for (let k = 0; k < count; k++) {
      const last = k === count - 1;
      const frac = count > 1 ? k / (count - 1) : 0;
      const b = voice(
        seq[k],
        last ? ring : gate,
        { ...opts, cutMul: cutTop + (cutEnd - cutTop) * frac },
        last ? Math.min(tail, 0.22) : 0.008
      );
      mixAt(out, b, secs(k * step), k === 0 ? 1.0 : rng.uniform(0.72, 1.0));
    }
    tags = {
      style: 'down',
      chord: chord.name,
      tone: toneLabel(wave, duty),
      feel: div.word,
      shade: cutEnd < cutTop * 0.55 ? 'darkening' : 'even',
      octaves: octSpan(seq),
      bpm: bpmOf(step, div.per),
      note: noteName(root),
    };
  } else if (style === 'updown') {
    // the classic turn: up to the top, straight back down
    const chord = rng.choice(ALL_CHORDS);
    const octaves = rng.randint(1, 2);
    const root = pickRoot(rng, 40, 68, 12 * octaves);
    const pool = chordPool(root, chord.steps, octaves);
    const turn = rng.choice(['inclusive', 'exclusive']);
    const back = pool.slice().reverse();
    const pattern = turn === 'inclusive' ? pool.concat(back) : pool.concat(back.slice(1, -1));
    const divName = rng.choice(['sixteenth', 'sixteenth', 'sixteenth', 'triplet']);
    const div = DIVS[divName];
    let step = 60.0 / rng.randint(92, 184) / div.per;
    const gate = Math.max(0.035, Math.min(0.4, step * rng.uniform(0.7, 1.5)));
    const tail = rng.uniform(0.1, 0.35);
    const ring = gate + tail;
    const count = fitCount(pattern.length, step, ring, 4);
    step = fitStep(step, count - 1, ring);
    const seq = cycleTo(pattern, count);
    const wave = rng.choice([null, null, null, 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const swing = rng.uniform(0.0, 0.22); // every other note nudged late
    const events = seq.map((m, k) => ({
      m,
      at: k * step + (k % 2 === 1 ? swing * step : 0.0),
      len: k === count - 1 ? ring : gate,
      g: k === 0 ? 1.0 : 0.78 + 0.22 * (k % 2 === 0 ? 1 : 0),
      rel: k === count - 1 ? Math.min(tail, 0.18) : 0.008,
    }));
    out = play(events, {
      wave,
      duty,
      atk: rng.uniform(0.0008, 0.003),
      rate: rng.uniform(6.0, 22.0),
      sus: rng.uniform(0.0, 0.2),
      cutMul: rng.uniform(6.0, 20.0),
      rel: 0.008,
      tickG: rng.uniform(0.0, 0.5) > 0.3 ? rng.uniform(0.12, 0.3) : 0,
    });
    tags = {
      style: 'updown',
      chord: chord.name,
      turn,
      tone: toneLabel(wave, duty),
      groove: swing > 0.1 ? 'swung' : 'straight',
      notes: count,
      bpm: bpmOf(step, div.per),
      note: noteName(root),
    };
  } else if (style === 'octave') {
    // octave jumping: the pattern that turns one chord into a whole bassline
    const chord = rng.choice(ALL_CHORDS);
    const root = pickRoot(rng, 33, 62, 24);
    const shape = rng.choice(['root-and-octave', 'tone pairs', 'wide leaps']);
    const tones = chord.steps;
    const pattern = [];
    if (shape === 'root-and-octave') {
      pattern.push(root, root + 12, root + 7, root + 12);
    } else if (shape === 'tone pairs') {
      for (const s of tones) pattern.push(root + s, root + s + 12);
    } else {
      for (let i = 0; i < tones.length; i++) {
        pattern.push(root + tones[i]);
        pattern.push(root + tones[(i + 1) % tones.length] + (i % 2 === 0 ? 24 : 12));
      }
    }
    const divName = rng.choice(['sixteenth', 'sixteenth', 'eighth']);
    const div = DIVS[divName];
    let step = 60.0 / rng.randint(88, 172) / div.per;
    const gate = Math.max(0.03, Math.min(0.3, step * rng.uniform(0.55, 1.1))); // staccato
    const tail = rng.uniform(0.1, 0.32);
    const ring = gate + tail;
    const count = fitCount(pattern.length * rng.randint(1, 3), step, ring, 4);
    step = fitStep(step, count - 1, ring);
    const seq = cycleTo(pattern, count);
    const wave = rng.choice([null, null, null, 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const punch = rng.uniform(0.0, 0.45);
    const events = seq.map((m, k) => ({
      m,
      at: k * step,
      len: k === count - 1 ? ring : gate,
      g: k % 2 === 0 ? 1.0 : 1.0 - punch,
      rel: k === count - 1 ? Math.min(tail, 0.16) : 0.007,
    }));
    out = play(events, {
      wave,
      duty,
      atk: rng.uniform(0.0006, 0.0025),
      rate: rng.uniform(8.0, 26.0),
      sus: 0.0,
      cutMul: rng.uniform(6.0, 18.0),
      rel: 0.007,
      tickG: rng.uniform(0.0, 0.5) > 0.28 ? rng.uniform(0.15, 0.35) : 0,
    });
    const steps = rng.randint(3, 14);
    const crushed = steps < 8;
    if (crushed) crush(out, steps, rng.randint(1, 2));
    tags = {
      style: 'octave',
      chord: chord.name,
      shape,
      tone: toneLabel(wave, duty),
      grit: crushed ? 'crushed' : 'clean',
      octaves: octSpan(seq),
      bpm: bpmOf(step, div.per),
      note: noteName(root),
    };
  } else if (style === 'run') {
    // the fast one: sixteenths and thirty-seconds tearing across two or three
    // octaves, straight up, straight down, or zigzagging between the two
    const chord = rng.choice(ALL_CHORDS);
    const octaves = rng.randint(2, 3);
    const root = pickRoot(rng, 36, 64, 12 * octaves);
    const pool = chordPool(root, chord.steps, octaves);
    const dirn = rng.choice(['climbing', 'climbing', 'falling', 'zigzagging']);
    let pattern;
    if (dirn === 'climbing') pattern = pool;
    else if (dirn === 'falling') pattern = pool.slice().reverse();
    else {
      pattern = [];
      for (let i = 0; i < pool.length - 1; i++) pattern.push(pool[i], pool[i + 2 < pool.length ? i + 2 : pool.length - 1]);
    }
    const divName = rng.choice(['sixteenth', 'thirtysecond', 'thirtysecond']);
    const div = DIVS[divName];
    let step = 60.0 / rng.randint(96, 168) / div.per;
    const gate = Math.max(0.03, Math.min(0.22, step * rng.uniform(0.9, 2.2))); // notes bleed
    const tail = rng.uniform(0.12, 0.4);
    const ring = gate + tail;
    const count = fitCount(pattern.length * rng.randint(1, 2), step, ring, 6);
    step = fitStep(step, count - 1, ring);
    const seq = cycleTo(pattern, count);
    const wave = rng.choice([null, null, 'saw', 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const events = seq.map((m, k) => ({
      m,
      at: k * step,
      len: k === count - 1 ? ring : gate,
      g: 0.8 + 0.2 * Math.min(1.0, k / Math.max(1, count - 1)),
      rel: k === count - 1 ? Math.min(tail, 0.18) : 0.006,
    }));
    out = play(events, {
      wave,
      duty,
      atk: rng.uniform(0.0005, 0.002),
      rate: rng.uniform(10.0, 30.0),
      sus: rng.uniform(0.0, 0.15),
      cutMul: rng.uniform(7.0, 22.0),
      rel: 0.006,
      tickG: 0,
    });
    const steps = rng.randint(3, 15);
    const crushed = steps < 7;
    if (crushed) crush(out, steps, rng.randint(1, 3));
    tags = {
      style: 'run',
      chord: chord.name,
      dirn,
      tone: toneLabel(wave, duty),
      grit: crushed ? 'crushed' : 'clean',
      notes: count,
      bpm: bpmOf(step, div.per),
      note: noteName(root),
    };
  } else if (style === 'triplet') {
    // slow triplets: three notes to the beat, the first of each group leaned on
    const chord = rng.choice(ALL_CHORDS);
    const octaves = rng.randint(1, 2);
    const root = pickRoot(rng, 38, 66, 12 * octaves);
    const pool = chordPool(root, chord.steps, octaves);
    const div = DIVS.triplet;
    let step = 60.0 / rng.randint(62, 118) / div.per;
    const shuffle = rng.choice(['rolling', 'rolling', 'shuffled']); // shuffled drops beat 2
    const gate = Math.max(0.05, Math.min(0.6, step * rng.uniform(0.85, 1.8)));
    const tail = rng.uniform(0.2, 0.6);
    const ring = gate + tail;
    const groups = rng.randint(2, 5);
    const count = fitCount(groups * 3, step, ring, 3);
    step = fitStep(step, count - 1, ring);
    const seq = cycleTo(pool, count);
    const wave = rng.choice([null, 'tri', 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const lean = rng.uniform(0.15, 0.4);
    const events = [];
    for (let k = 0; k < count; k++) {
      if (shuffle === 'shuffled' && k % 3 === 1) continue; // the long-short lilt
      const last = k === count - 1;
      events.push({
        m: seq[k],
        at: k * step,
        len: last ? ring : gate,
        g: k % 3 === 0 ? 1.0 : 1.0 - lean,
        rel: last ? Math.min(tail, 0.24) : 0.01,
      });
    }
    out = play(events, {
      wave,
      duty,
      atk: rng.uniform(0.0015, 0.008),
      rate: rng.uniform(2.5, 9.0),
      sus: rng.uniform(0.0, 0.35),
      cutMul: rng.uniform(5.0, 14.0),
      rel: 0.01,
      tickG: 0,
    });
    tags = {
      style: 'triplet',
      chord: chord.name,
      lilt: shuffle,
      tone: toneLabel(wave, duty),
      touch: lean > 0.28 ? 'accented' : 'even',
      notes: events.length,
      bpm: bpmOf(step, div.per),
      note: noteName(root),
    };
  } else if (style === 'random') {
    // random order: the same chord, shuffled every step, with rests punched out
    const chord = rng.choice(ALL_CHORDS);
    const octaves = rng.randint(1, 3);
    const root = pickRoot(rng, 38, 68, 12 * octaves);
    const pool = chordPool(root, chord.steps, octaves);
    const divName = rng.choice(['sixteenth', 'sixteenth', 'triplet']);
    const div = DIVS[divName];
    let step = 60.0 / rng.randint(90, 176) / div.per;
    const gate = Math.max(0.035, Math.min(0.35, step * rng.uniform(0.6, 1.4)));
    const tail = rng.uniform(0.12, 0.4);
    const ring = gate + tail;
    const count = fitCount(rng.randint(6, 16), step, ring, 5);
    step = fitStep(step, count - 1, ring);
    const density = rng.uniform(0.62, 1.0); // below 1.0, steps drop out as rests
    const wave = rng.choice([null, null, 'tri', 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const events = [];
    const played = [];
    for (let k = 0; k < count; k++) {
      const last = k === count - 1;
      if (!last && rng.random() > density) continue;
      const m = rng.choice(pool);
      played.push(m);
      events.push({
        m,
        at: k * step,
        len: last ? ring : gate,
        g: rng.uniform(0.72, 1.0),
        rel: last ? Math.min(tail, 0.18) : 0.008,
      });
    }
    out = play(events, {
      wave,
      duty,
      atk: rng.uniform(0.0008, 0.0035),
      rate: rng.uniform(6.0, 24.0),
      sus: rng.uniform(0.0, 0.2),
      cutMul: rng.uniform(5.0, 20.0),
      rel: 0.008,
      tickG: rng.uniform(0.0, 0.5) > 0.32 ? rng.uniform(0.12, 0.3) : 0,
    });
    tags = {
      style: 'random',
      chord: chord.name,
      spacing: density < 0.85 ? 'gapped' : 'unbroken',
      tone: toneLabel(wave, duty),
      spread: octaves > 1 ? 'wide' : 'tight',
      notes: events.length,
      bpm: bpmOf(step, div.per),
      note: noteName(root),
    };
  } else if (style === 'seventh') {
    // extended harmony: 7ths and 9ths, spelled slowly enough to hear the colour
    const chord = rng.choice(SEVENTHS);
    const octaves = rng.randint(1, 2);
    const root = pickRoot(rng, 40, 66, 12 * octaves + 2);
    const pool = chordPool(root, chord.steps, octaves);
    const voicing = rng.choice(['straight', 'straight', 'inverted', 'rootless']);
    let pattern = pool;
    if (voicing === 'inverted') pattern = pool.slice(1).concat([pool[0] + 12 * octaves]);
    else if (voicing === 'rootless') pattern = pool.filter((m, i) => i !== 0);
    const divName = rng.choice(['eighth', 'sixteenth', 'triplet']);
    const div = DIVS[divName];
    let step = 60.0 / rng.randint(70, 140) / div.per;
    const gate = Math.max(0.06, Math.min(0.7, step * rng.uniform(1.0, 2.4))); // legato
    const tail = rng.uniform(0.2, 0.55);
    const ring = gate + tail;
    const count = fitCount(pattern.length * rng.randint(1, 2), step, ring, 3);
    step = fitStep(step, count - 1, ring);
    const seq = cycleTo(pattern, count);
    const wave = rng.choice([null, null, 'tri']);
    const duty = rng.choice([0.5, 0.25]);
    const sus = rng.uniform(0.15, 0.45);
    const events = seq.map((m, k) => ({
      m,
      at: k * step,
      len: k === count - 1 ? ring : gate,
      g: k === 0 ? 1.0 : rng.uniform(0.75, 0.98),
      rel: k === count - 1 ? Math.min(tail, 0.28) : 0.012,
    }));
    const opts = {
      wave,
      duty,
      atk: rng.uniform(0.002, 0.01),
      rate: rng.uniform(1.8, 7.0),
      sus,
      cutMul: rng.uniform(4.0, 12.0),
      rel: 0.012,
      tickG: 0,
      vib: rng.uniform(0.0, 22.0),
      vibHz: rng.uniform(4.0, 7.0),
    };
    out = play(events, opts);
    // A triangle an octave under each note is the chip way to say "rich".
    const layerG = rng.uniform(0.0, 0.6);
    const layered = layerG > 0.24;
    if (layered) {
      mixAt(
        out,
        play(events.map((e) => ({ ...e, m: e.m - 12 })), { ...opts, wave: 'tri', cutMul: 10.0, vib: 0 }),
        0,
        layerG
      );
    }
    tags = {
      style: 'seventh',
      chord: chord.name,
      voicing,
      tone: toneLabel(wave, duty),
      body: layered ? 'octave-doubled' : 'single voice',
      octaves: octSpan(seq),
      bpm: bpmOf(step, div.per),
      note: noteName(root),
    };
  } else if (style === 'harp') {
    // glissando: notes so close together they ring into one another, harp-style
    const chord = rng.choice(ALL_CHORDS);
    const octaves = rng.randint(2, 3);
    const root = pickRoot(rng, 36, 60, 12 * octaves);
    const pool = chordPool(root, chord.steps, octaves);
    const dirn = rng.choice(['rising', 'rising', 'falling']);
    const pattern = dirn === 'rising' ? pool : pool.slice().reverse();
    let step = rng.uniform(0.022, 0.06);
    const gate = rng.uniform(0.35, 0.95); // every note rings on under the next
    const tail = rng.uniform(0.1, 0.35);
    const ring = gate + tail;
    const count = fitCount(pattern.length * rng.randint(1, 2), step, ring, 5);
    step = fitStep(step, count - 1, ring);
    const seq = cycleTo(pattern, count);
    const wave = rng.choice(['tri', 'tri', null]);
    const duty = rng.choice([0.5, 0.25]);
    const events = seq.map((m, k) => ({
      m,
      at: k * step,
      len: k === count - 1 ? Math.min(ring, gate + tail) : gate,
      g: rng.uniform(0.6, 0.95),
      rel: Math.min(0.12, gate * 0.35),
    }));
    const opts = {
      wave,
      duty,
      atk: rng.uniform(0.001, 0.004),
      rate: rng.uniform(2.2, 6.5),
      sus: 0.0,
      cutMul: rng.uniform(4.0, 11.0),
      rel: 0.02,
      tickG: 0,
    };
    out = play(events, opts);
    // A second pass a few cents off makes the ring-out shimmer.
    const cents = rng.uniform(0.0, 16.0);
    const shimmer = cents > 5.0;
    if (shimmer) {
      mixAt(out, play(events.map((e) => ({ ...e, m: e.m + cents / 100.0 })), opts), 0, 0.6);
    }
    tags = {
      style: 'harp',
      chord: chord.name,
      dirn,
      tone: toneLabel(wave, duty),
      ring: shimmer ? 'shimmering' : 'pure',
      octaves: octSpan(seq),
      step_ms: Math.round(step * 1000),
      note: noteName(root),
    };
  } else if (style === 'pedal') {
    // Alberti figures and pedal tones: one note held as an axis, the chord
    // walking around it — the oldest arpeggio trick there is
    const chord = rng.choice(ALL_CHORDS);
    const root = pickRoot(rng, 40, 68, 14);
    const shape = rng.choice(['alberti', 'alberti', 'low pedal', 'top pedal']);
    const tones = chord.steps;
    const pattern = [];
    if (shape === 'alberti') {
      // root, fifth, third, fifth — chord tones by index, so any quality works
      const idx = [0, tones.length - 1, 1, tones.length - 1];
      for (const i of idx) pattern.push(root + tones[i % tones.length]);
    } else if (shape === 'low pedal') {
      for (const s of tones) pattern.push(root, root + s + 12);
    } else {
      const top = root + 12;
      for (const s of tones) pattern.push(top, root + s);
    }
    const divName = rng.choice(['sixteenth', 'sixteenth', 'eighth']);
    const div = DIVS[divName];
    let step = 60.0 / rng.randint(76, 156) / div.per;
    const gate = Math.max(0.04, Math.min(0.4, step * rng.uniform(0.8, 1.6)));
    const tail = rng.uniform(0.15, 0.45);
    const ring = gate + tail;
    const count = fitCount(pattern.length * rng.randint(1, 3), step, ring, 4);
    step = fitStep(step, count - 1, ring);
    const seq = cycleTo(pattern, count);
    const wave = rng.choice([null, null, 'tri']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const lift = rng.uniform(0.1, 0.35);
    const events = seq.map((m, k) => ({
      m,
      at: k * step,
      len: k === count - 1 ? ring : gate,
      g: k % 2 === 0 ? 1.0 : 1.0 - lift,
      rel: k === count - 1 ? Math.min(tail, 0.2) : 0.01,
    }));
    out = play(events, {
      wave,
      duty,
      atk: rng.uniform(0.001, 0.006),
      rate: rng.uniform(3.0, 12.0),
      sus: rng.uniform(0.05, 0.35),
      cutMul: rng.uniform(5.0, 15.0),
      rel: 0.01,
      tickG: 0,
    });
    tags = {
      style: 'pedal',
      chord: chord.name,
      shape,
      tone: toneLabel(wave, duty),
      touch: lift > 0.24 ? 'lilting' : 'level',
      notes: count,
      bpm: bpmOf(step, div.per),
      note: noteName(root),
    };
  } else {
    // ratchet: each step stutters into two, three or four hits — the modern
    // arpeggiator's trick, done with nothing but retriggered squares
    const chord = rng.choice(ALL_CHORDS);
    const octaves = rng.randint(1, 2);
    const root = pickRoot(rng, 40, 68, 12 * octaves);
    const pool = chordPool(root, chord.steps, octaves);
    const div = DIVS.eighth;
    let beat = 60.0 / rng.randint(90, 150) / div.per;
    const maxReps = rng.randint(2, 4);
    const mode = rng.choice(['even', 'even', 'building']);
    const gate = Math.max(0.022, Math.min(0.16, (beat / maxReps) * rng.uniform(0.7, 1.3)));
    const tail = rng.uniform(0.12, 0.38);
    const ring = gate + tail;
    const groups = fitCount(rng.randint(3, 6), beat, ring + beat, 2);
    beat = fitStep(beat, groups - 1 + 1, ring);
    const wave = rng.choice([null, null, null, 'saw']);
    const duty = rng.choice([0.5, 0.25, 0.125]);
    const events = [];
    for (let g = 0; g < groups; g++) {
      const reps = mode === 'building' ? Math.min(maxReps, g + 1) : maxReps;
      const m = pool[g % pool.length];
      for (let r = 0; r < reps; r++) {
        const last = g === groups - 1 && r === reps - 1;
        events.push({
          m,
          at: g * beat + (r * beat) / reps,
          len: last ? ring : gate,
          g: r === 0 ? 1.0 : 0.7 + 0.3 * (1 - r / reps),
          rel: last ? Math.min(tail, 0.18) : 0.006,
        });
      }
    }
    out = play(events, {
      wave,
      duty,
      atk: rng.uniform(0.0005, 0.002),
      rate: rng.uniform(12.0, 34.0),
      sus: 0.0,
      cutMul: rng.uniform(6.0, 20.0),
      rel: 0.006,
      tickG: rng.uniform(0.0, 0.5) > 0.25 ? rng.uniform(0.15, 0.4) : 0,
    });
    const steps = rng.randint(3, 14);
    const crushed = steps < 8;
    if (crushed) crush(out, steps, rng.randint(1, 2));
    tags = {
      style: 'ratchet',
      chord: chord.name,
      mode,
      tone: toneLabel(wave, duty),
      grit: crushed ? 'crushed' : 'clean',
      reps: maxReps,
      bpm: bpmOf(beat, div.per),
      note: noteName(root),
    };
  }

  rng.tags = tags;

  // Keep every arp inside 0.3 - 2.0 s, block the duty-cycle DC bias, then
  // de-click both edges before normalizing, so the peak lands exactly on target
  // even when the loudest sample sits inside the first note's attack.
  if (out.length > MAX_N) out = out.slice(0, MAX_N);
  dcBlock(out, 0.997);
  const fi = Math.min(out.length >> 2, 16);
  const fo = Math.min(out.length >> 1, Math.max(Math.round(0.006 * SR), Math.round(0.03 * out.length)));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  while (out.length < MIN_N) out.push(0.0);
  return finish(out, 0.9, 0, 0);
}

/** Catalog blurb from the tags gen() recorded. */
export function describe(tags) {
  const t = tags || {};
  const note = t.note || 'C3';
  const chord = t.chord || 'minor';
  const tone = t.tone || '50% duty';
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  const oct = (v) => `${num(v)} octave${num(v) === 1 ? '' : 's'}`;
  switch (t.style) {
    case 'down':
      return `down arpeggio — ${chord} falling ${oct(t.octaves)}, ${tone} ${t.feel || 'sixteenths'}, ${num(t.bpm)} BPM on ${note}`;
    case 'updown':
      return `up-down arpeggio — ${chord}, ${t.turn || 'inclusive'} turn, ${t.groove || 'straight'} ${tone} at ${num(t.bpm)} BPM on ${note}`;
    case 'octave':
      return `octave-jump arp — ${chord} ${t.shape || 'tone pairs'}, ${t.grit || 'clean'} ${tone}, ${num(t.bpm)} BPM on ${note}`;
    case 'run':
      return `arp run — ${chord} ${t.dirn || 'climbing'} in ${tone}, ${num(t.notes)} notes at ${num(t.bpm)} BPM from ${note}`;
    case 'triplet':
      return `triplet arpeggio — ${chord}, ${t.lilt || 'rolling'} and ${t.touch || 'even'}, ${tone} at ${num(t.bpm)} BPM on ${note}`;
    case 'random':
      return `random-order arp — ${chord} ${t.spacing || 'unbroken'}, ${tone}, ${num(t.notes)} notes at ${num(t.bpm)} BPM on ${note}`;
    case 'seventh':
      return `extended-chord arp — ${chord} ${t.voicing || 'straight'}, ${t.body || 'single voice'} ${tone}, ${num(t.bpm)} BPM on ${note}`;
    case 'harp':
      return `harp-gliss arp — ${chord} ${t.dirn || 'rising'} over ${oct(t.octaves)}, ${t.ring || 'pure'} ${tone}, ${num(t.step_ms)} ms steps on ${note}`;
    case 'pedal':
      return `pedal-tone arp — ${chord} ${t.shape || 'alberti'}, ${t.touch || 'level'} ${tone}, ${num(t.bpm)} BPM on ${note}`;
    case 'ratchet':
      return `ratcheted arp — ${chord} in ${num(t.reps)}-hit ${t.mode || 'even'} bursts, ${tone}, ${num(t.bpm)} BPM on ${note}`;
    default:
      return `up arpeggio — ${chord} over ${oct(t.octaves)}, ${t.bass || 'bare'} ${tone} ${t.feel || 'sixteenths'}, ${num(t.bpm)} BPM on ${note}`;
  }
}

/** Short phrase for the README category table. */
export const character = 'chord-tone arpeggio runs, octave jumps, glissandi, ratchets';
