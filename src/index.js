// 8bit-sfx — 8888 chip sound effects, synthesized on demand.
//
// Nothing here loads an audio file. Every effect is a deterministic function of
// its name, so `render('kick_003')` produces the same samples in a browser, in
// Node, today and in five years. WAV files are an optional export
// (`npm run generate`), not a dependency.

import { Rng, SR, quantize, encodeWav, pcmToFloat, QUANT_LEVELS } from './dsp.js';
import { renderPorted, PORTED_DESCRIPTIONS, PORTED_NAMES } from './ported.js';
import {
  GENERATORS, CATEGORIES, GAME_CATEGORIES, MUSIC_CATEGORIES,
  GENERATED_COUNTS, VARIATIONS, effectNames, resolve, padIndex,
} from './registry.js';

export {
  SR, CATEGORIES, GAME_CATEGORIES, MUSIC_CATEGORIES, VARIATIONS,
  GENERATED_COUNTS, effectNames, padIndex, PORTED_NAMES,
};
export const SAMPLE_RATE = SR;

// Resolved lazily, not at module scope: bundlers that emit non-ESM output
// (esbuild --format=iife/cjs) stub `import.meta` to `{}`, and `new URL('..',
// undefined)` would throw on import — making the whole library unloadable for
// consumers who never touch the two file-path helpers below.
const pkgRoot = () => new URL('..', import.meta.url);
const IS_NODE = typeof process !== 'undefined' && !!process.versions?.node;

/** Total number of effects in the library. */
export const COUNT = CATEGORIES.reduce(
  (n, c) => n + GENERATED_COUNTS[c] + (c === 'rpg' ? PORTED_NAMES.length : 0),
  0
);

/** The short phrase describing a category's character (README/UI copy). */
export function categoryCharacter(category) {
  if (!Object.hasOwn(GENERATORS, category)) {
    throw new Error(`8bit-sfx: unknown category "${category}"`);
  }
  return GENERATORS[category].character;
}

/**
 * Synthesize an effect to raw float samples in [-1, 1], before gain/quantization.
 * @param {string} name e.g. "kick_003", "rpg_levelup"
 */
function synth(name) {
  const { category, index, label } = resolve(name);
  if (label !== null) {
    const { samples, peak } = renderPorted(label);
    return { samples, ported: true, category, label, peak, description: PORTED_DESCRIPTIONS[label] };
  }
  const rng = new Rng(`${category}_${padIndex(index)}`);
  const samples = GENERATORS[category].gen(rng);
  return {
    samples,
    ported: false,
    category,
    label: null,
    peak: 1,
    description: GENERATORS[category].describe(rng.tags),
  };
}

/**
 * Render an effect to floats in [-1, 1) — post gain and 8-bit quantization, so
 * it sounds exactly like the exported WAV.
 * @returns {Float32Array}
 */
export function render(name) {
  return pcmToFloat(renderPcm(name));
}

/** Render an effect to raw 8-bit unsigned PCM (what a .wav's data chunk holds). */
export function renderPcm(name) {
  const { samples, ported } = synth(name);
  // Ported game sounds keep full 8-bit resolution; procedural effects get the
  // 16-level chip crush that gives the library its voice.
  return quantize(samples, ported ? 0 : QUANT_LEVELS);
}

/** Render an effect to a complete .wav file. */
export function renderWav(name) {
  return encodeWav(renderPcm(name), SR);
}

/** The catalog blurb for an effect — what makes it different from its neighbours. */
export function describe(name) {
  return synth(name).description;
}

/** Duration in seconds. Requires synthesis, so prefer the catalog for bulk listing. */
export function duration(name) {
  return renderPcm(name).length / SR;
}

/**
 * Full metadata for one effect. Synthesizes exactly once — the samples and the
 * description come from the same pass.
 * @returns {{name, file, category, description, duration_s, sample_rate, bits, channels, label?, gain?}}
 */
export function describeFull(name) {
  const { samples, ported, category, label, description } = synth(name);
  const pcm = quantize(samples, ported ? 0 : QUANT_LEVELS);
  const entry = {
    name,
    file: `${category}/${name}.wav`,
    category,
    description,
    duration_s: Math.round((pcm.length / SR) * 1000) / 1000,
    sample_rate: SR,
    bits: 8,
    channels: 1,
  };
  if (label !== null) {
    entry.label = label;
    // The catalog's `gain` — this sound's level relative to the loudest ported
    // one, preserving the source game's deliberately soft mix.
    entry.gain = portedGain(label);
  }
  return entry;
}

let portedPeaks = null;
/** Relative loudness of a ported sound, computed once for the whole set. */
function portedGain(label) {
  if (!portedPeaks) {
    const peaks = PORTED_NAMES.map((l) => [l, renderPorted(l).peak]);
    const loudest = Math.max(...peaks.map(([, p]) => p));
    portedPeaks = new Map(peaks.map(([l, p]) => [l, Math.round((p / loudest) * 1000) / 1000]));
  }
  return portedPeaks.get(label);
}

/**
 * Load the prebuilt catalog (`sfx/manifest.json`): every effect with its
 * description and duration, without synthesizing 8888 sounds. Built by
 * `npm run generate`; shipped with the package.
 */
export async function loadManifest({ base } = {}) {
  const url = base ? new URL('manifest.json', base) : new URL('sfx/manifest.json', pkgRoot());
  if (IS_NODE && url.protocol === 'file:') {
    const { readFile } = await import(/* webpackIgnore: true */ 'node:fs/promises');
    const { fileURLToPath } = await import(/* webpackIgnore: true */ 'node:url');
    return JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`8bit-sfx: manifest fetch failed (${res.status})`);
  return res.json();
}

/**
 * Where a WAV *would* live if exported. Kept for consumers that prefer files
 * (run `npm run generate` to create them); nothing in this module needs it.
 */
export function soundUrl(name, { base } = {}) {
  const rel = name.includes('/') ? name : `${resolve(name).category}/${name}.wav`;
  return base ? new URL(rel, base) : new URL(`sfx/${rel}`, pkgRoot());
}

/**
 * Web Audio playback. Synthesizes on demand — no fetching, no preloading, no
 * files. Call resume() from a user gesture (browsers gate audio on one), then
 * play() anything by name.
 */
export class SfxPlayer {
  /** @param {{context?: AudioContext, volume?: number}} [opts] */
  constructor({ context, volume = 1 } = {}) {
    this.context = context ?? null;
    this.volume = volume;
    this.muted = false;
    this.buffers = new Map();
  }

  /** Create (or wake) the AudioContext. Safe to call on every input event. */
  resume() {
    if (!this.context) {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) return;
      this.context = new Ctx();
    }
    if (this.context.state === 'suspended') this.context.resume();
  }

  /** Synthesize (and cache) an AudioBuffer. Optional — play() does it lazily. */
  prepare(name) {
    this.resume();
    if (!this.context) throw new Error('8bit-sfx: no AudioContext available');
    let buf = this.buffers.get(name);
    if (!buf) {
      const samples = render(name);
      // The library is 22050 Hz; the context resamples on playback.
      buf = this.context.createBuffer(1, samples.length, SR);
      buf.getChannelData(0).set(samples);
      this.buffers.set(name, buf);
    }
    return buf;
  }

  /** Kept for API familiarity — synthesis needs no I/O, so this just warms the cache. */
  async load(...names) {
    for (const name of names.flat()) this.prepare(name);
  }

  /**
   * Play an effect, synthesizing it on first use.
   * @returns {AudioBufferSourceNode|null} null when muted or without an AudioContext
   */
  play(name, { volume = 1, rate = 1, when = 0 } = {}) {
    if (this.muted) return null;
    this.resume();
    if (!this.context) return null;
    const src = this.context.createBufferSource();
    src.buffer = this.prepare(name);
    src.playbackRate.value = rate;
    const gain = this.context.createGain();
    gain.gain.value = this.volume * volume;
    src.connect(gain);
    gain.connect(this.context.destination);
    src.start(when ? this.context.currentTime + when : 0);
    return src;
  }
}
