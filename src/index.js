// 8bit-sfx — a tiny, dependency-free API over the WAV library.
//
// Works in Node and in browsers when the package is served as-is (from
// node_modules or any static copy): asset paths resolve relative to this
// module via import.meta.url. Bundlers rewrite import.meta.url in ways that
// don't carry the sfx/ assets along — bundler users should copy sfx/ into
// their static assets and pass its URL via the `base` / `baseUrl` options.

const PKG_ROOT = new URL('..', import.meta.url);

export const SAMPLE_RATE = 22050;

const IS_NODE = typeof process !== 'undefined' && !!process.versions?.node;

/** Resolve an effect to its wav URL. Accepts a short name ("coin_042",
 *  "pixelrpg_zombie") or a manifest-relative path ("coin/coin_042.wav").
 *  Pass { base } (URL or string, the directory containing the wav tree)
 *  when the package's own location isn't servable, e.g. under a bundler. */
export function soundUrl(name, { base } = {}) {
  const rel = name.includes('/') ? name : `${name.split('_', 1)[0]}/${name}.wav`;
  return base ? new URL(rel, base) : new URL(`sfx/${rel}`, PKG_ROOT);
}

/** Load sfx/manifest.json: every effect with its category, duration, format,
 *  and (for the pixelrpg set) the source game's intended relative gain.
 *  In Node this reads from disk; in browsers it fetches. */
export async function loadManifest({ base } = {}) {
  const url = base ? new URL('manifest.json', base) : new URL('sfx/manifest.json', PKG_ROOT);
  if (IS_NODE && url.protocol === 'file:') {
    const { readFile } = await import(/* webpackIgnore: true */ 'node:fs/promises');
    const { fileURLToPath } = await import(/* webpackIgnore: true */ 'node:url');
    return JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`8bit-sfx: manifest fetch failed (${res.status})`);
  return res.json();
}

/** Web Audio playback with a decoded-buffer cache. Browser-only; in
 *  environments without AudioContext, play() is a safe no-op. Call resume()
 *  from a user gesture (browsers gate audio on one), load() what you need,
 *  then play() by name. */
export class SfxPlayer {
  /** @param {{context?: AudioContext, volume?: number, baseUrl?: string|URL}} [opts] */
  constructor({ context, volume = 1, baseUrl } = {}) {
    this.context = context ?? null;
    this.volume = volume;
    this.baseUrl = baseUrl;
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

  /** Fetch + decode the named effect(s) into the cache. */
  async load(...names) {
    this.resume();
    if (!this.context) throw new Error('8bit-sfx: no AudioContext available');
    await Promise.all(
      names.flat().map(async (name) => {
        if (this.buffers.has(name)) return;
        const res = await fetch(soundUrl(name, { base: this.baseUrl }));
        if (!res.ok) throw new Error(`8bit-sfx: ${name} fetch failed (${res.status})`);
        const buf = await this.context.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(name, buf);
      })
    );
  }

  /** Play a loaded effect. Returns the source node, or null when muted,
   *  unloaded, or without an AudioContext. */
  play(name, { volume = 1, rate = 1 } = {}) {
    const buffer = this.buffers.get(name);
    if (!buffer || this.muted || !this.context) return null;
    const src = this.context.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = this.context.createGain();
    gain.gain.value = this.volume * volume;
    src.connect(gain);
    gain.connect(this.context.destination);
    src.start();
    return src;
  }
}
