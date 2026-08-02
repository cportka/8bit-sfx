// The chip-synth primitives every generator is built from.
//
// This is the library's engine: deterministic, dependency-free, and identical
// in browsers and Node. A generator is a pure function of one Rng — seeded from
// the effect's name — so `kick_003` synthesizes to the same samples anywhere,
// forever, without shipping a single audio file.

export const SR = 22050;
export const MASTER_GAIN = 0.8;
export const QUANT_LEVELS = 15; // 16 amplitude steps, like a 4-bit chip DAC

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of a string's UTF-8 bytes — the seed hash (matches Python's zlib.crc32). */
export function crc32(str) {
  const bytes = new TextEncoder().encode(str);
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** xorshift32 — deterministic across engines and platforms. */
export class Rng {
  /** @param {string} name effect name, e.g. "kick_003" */
  constructor(name) {
    this.s = crc32(name) || 0x9e3779b9;
    this.tags = null; // generators record their synthesis decisions here
  }

  _u32() {
    let x = this.s;
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    this.s = x;
    return x;
  }

  random() {
    return this._u32() / 4294967296.0;
  }

  uniform(a, b) {
    return a + (b - a) * this.random();
  }

  /** Inclusive on both ends. */
  randint(a, b) {
    return a + (this._u32() % (b - a + 1));
  }

  choice(seq) {
    return seq[this._u32() % seq.length];
  }
}

/** NES-style 15-bit noise, sample-and-hold clocked every `period` samples. */
export class Lfsr {
  constructor(rng, period) {
    this.state = rng.randint(1, 32767);
    this.period = Math.max(1, period);
    this.count = 0;
    this.out = 1.0;
  }

  next() {
    if (this.count === 0) {
      const bit = (this.state ^ (this.state >> 1)) & 1;
      this.state = (this.state >> 1) | (bit << 14);
      this.out = this.state & 1 ? 1.0 : -1.0;
    }
    this.count = (this.count + 1) % this.period;
    return this.out;
  }
}

export function square(phase, duty) {
  return ((phase % 1.0) + 1.0) % 1.0 < duty ? 1.0 : -1.0;
}

export function triangle(phase) {
  return 4.0 * Math.abs((((phase % 1.0) + 1.0) % 1.0) - 0.5) - 1.0;
}

export function sawtooth(phase) {
  return 2.0 * ((((phase % 1.0) + 1.0) % 1.0)) - 1.0;
}

/** MIDI note number to Hz (69 = 440). */
export function midi(m) {
  return 440.0 * Math.pow(2.0, (m - 69) / 12.0);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note number to scientific pitch name (60 -> "C4"). */
export function noteName(m) {
  const n = Math.round(m);
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

/** Frequency to nearest scientific pitch name (440 -> "A4"). */
export function noteOfHz(f) {
  if (!(f > 0)) return '?';
  return noteName(69 + 12 * Math.log2(f / 440.0));
}

/** Exponential decay envelope: t => exp(-rate * t). */
export function decay(rate) {
  return (t) => Math.exp(-rate * t);
}

/**
 * Accumulate phase against a per-sample frequency and shape it with an envelope.
 * @param {number} n samples
 * @param {(t: number) => number} freqFn Hz at time t (seconds)
 * @param {number} duty square duty cycle (ignored for triangle)
 * @param {(t: number) => number} envFn amplitude at time t
 * @param {"tri"|"saw"|null} [waveFn] wave shape; default square
 */
export function renderTone(n, freqFn, duty, envFn, waveFn = null) {
  const out = new Array(n);
  let phase = 0.0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    phase += freqFn(t) / SR;
    const s = waveFn === 'tri' ? triangle(phase) : waveFn === 'saw' ? sawtooth(phase) : square(phase, duty);
    out[i] = s * envFn(t);
  }
  return out;
}

/**
 * Round half to EVEN — what Python's built-in `round()` does, and what the
 * generator script that produced the published WAVs therefore did.
 *
 * This is not a detail: after the 16-level crush every sample sits exactly on
 * `k / 7.5`, so the 8-bit mapping below always lands on a dead `.5` tie
 * (`17k + 127.5`). `Math.round` breaks those ties upward and would shift half
 * the bytes in every file by one step away from the published audio.
 */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Master gain, optional 16-level chip crush, and conversion to 8-bit unsigned.
 * @param {number[]|Float32Array} samples
 * @param {number} [levels] quantization steps - 1; 0 disables the crush
 */
export function quantize(samples, levels = QUANT_LEVELS) {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1.0, Math.min(1.0, samples[i] * MASTER_GAIN));
    if (levels) s = roundHalfEven(s * (levels / 2)) / (levels / 2);
    out[i] = Math.max(0, Math.min(255, roundHalfEven(((s + 1.0) / 2.0) * 255.0)));
  }
  return out;
}

/** Wrap 8-bit unsigned mono PCM in a RIFF/WAVE container. */
export function encodeWav(pcm, sampleRate = SR) {
  const buf = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(buf);
  const ascii = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate (8-bit mono)
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/**
 * 8-bit unsigned PCM back to floats in [-1, 1), for Web Audio / analysis.
 * Uses the standard WAV decode `(b - 128) / 128`, which maps the silence byte
 * 128 to exactly 0 — the algebraic inverse of quantize() would leave it at
 * +0.0039 and put a small DC offset under every effect.
 */
export function pcmToFloat(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] - 128) / 128;
  return out;
}

// --- helpers generators reach for often -----------------------------------

/** Peak-normalize in place to `target`, then fade both edges to kill clicks. */
export function finish(buf, target = 0.9, fadeInMs = 2, fadeOutMs = 6) {
  let peak = 0;
  for (const v of buf) {
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  if (peak > 1e-9) {
    const g = target / peak;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  const fi = Math.min(buf.length >> 1, Math.round((SR * fadeInMs) / 1000));
  const fo = Math.min(buf.length >> 1, Math.round((SR * fadeOutMs) / 1000));
  for (let i = 0; i < fi; i++) buf[i] *= i / fi;
  for (let i = 0; i < fo; i++) buf[buf.length - 1 - i] *= i / fo;
  return buf;
}

/** Mix `src` into `dst` at a sample offset, growing `dst` as needed. */
export function mixAt(dst, src, offset, gain = 1.0) {
  const need = offset + src.length;
  while (dst.length < need) dst.push(0.0);
  for (let i = 0; i < src.length; i++) dst[offset + i] += src[i] * gain;
  return dst;
}

/** One-pole DC blocker — narrow-duty squares carry a bias. */
export function dcBlock(buf, r = 0.995) {
  let px = 0.0;
  let py = 0.0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = x - px + r * py;
    px = x;
    py = y;
    buf[i] = y;
  }
  return buf;
}
