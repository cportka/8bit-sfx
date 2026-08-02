// The public API and the library's shape. Everything is synthesized, so these
// tests exercise the real engine rather than checking files on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  render, renderPcm, renderWav, describe, describeFull, duration, loadManifest, soundUrl,
  effectNames, categoryCharacter, SfxPlayer, COUNT, CATEGORIES, GAME_CATEGORIES,
  MUSIC_CATEGORIES, GENERATED_COUNTS, VARIATIONS, PORTED_NAMES, SAMPLE_RATE, SR,
} from '../src/index.js';
import { resolve } from '../src/registry.js';

const EXPECTED_TOTAL = 8888;
const EXPECTED_CATEGORIES = 44;

test('the library is 44 categories x 202 effects = 8888', () => {
  assert.equal(SR, 22050);
  assert.equal(SAMPLE_RATE, SR);
  assert.equal(VARIATIONS, 202);
  assert.equal(CATEGORIES.length, EXPECTED_CATEGORIES);
  assert.equal(GAME_CATEGORIES.length + MUSIC_CATEGORIES.length, EXPECTED_CATEGORIES);
  assert.equal(COUNT, EXPECTED_TOTAL);

  const names = effectNames();
  assert.equal(names.length, EXPECTED_TOTAL);
  assert.equal(new Set(names).size, EXPECTED_TOTAL, 'effect names must be unique');

  // uniform shape: every category holds exactly VARIATIONS effects
  const perCategory = new Map(CATEGORIES.map((c) => [c, 0]));
  for (const n of names) perCategory.set(resolve(n).category, perCategory.get(resolve(n).category) + 1);
  for (const [c, n] of perCategory) assert.equal(n, VARIATIONS, `${c} holds ${n}, expected ${VARIATIONS}`);

  // rpg is the one blend: generated staples + the ported game sounds
  assert.equal(GENERATED_COUNTS.rpg + PORTED_NAMES.length, VARIATIONS);
  assert.equal(PORTED_NAMES.length, 28);
  for (const want of ['xp', 'levelup', 'door', 'clock']) {
    assert.ok(PORTED_NAMES.includes(want), `ported game sound missing: ${want}`);
  }
});

test('every category exposes a character phrase', () => {
  for (const c of CATEGORIES) {
    const ch = categoryCharacter(c);
    assert.ok(typeof ch === 'string' && ch.length >= 10, `${c}: weak character phrase: ${ch}`);
  }
});

test('rendering produces well-formed audio', () => {
  const probes = ['jump_000', 'kick_003', 'pad_201', 'bass_120', 'rpg_levelup', 'rpg_173', 'vinyl_050'];
  for (const name of probes) {
    const pcm = renderPcm(name);
    assert.ok(pcm instanceof Uint8Array && pcm.length > 0, `${name}: empty`);
    assert.ok(Math.max(...pcm) - Math.min(...pcm) >= 8, `${name}: silent`);

    const floats = render(name);
    assert.equal(floats.length, pcm.length);
    assert.ok(floats.every((v) => v >= -1 && v < 1), `${name}: out of range`);

    const wav = renderWav(name);
    assert.equal(wav.length, pcm.length + 44, `${name}: wav header`);
    assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
    assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE');
    const view = new DataView(wav.buffer, wav.byteOffset);
    assert.equal(view.getUint16(22, true), 1, 'mono');
    assert.equal(view.getUint32(24, true), SR, 'sample rate');
    assert.equal(view.getUint16(34, true), 8, '8-bit');

    assert.ok(Math.abs(duration(name) - pcm.length / SR) < 1e-9);
  }
});

test('synthesis is deterministic', () => {
  for (const name of ['glitch_077', 'arp_101', 'rpg_zombie']) {
    assert.deepEqual(renderPcm(name), renderPcm(name), `${name} must render identically every time`);
  }
});

test('unknown and out-of-range names are rejected', () => {
  assert.throws(() => renderPcm('nope_000'), /unknown category/);
  assert.throws(() => renderPcm('kick_999'), /out of range/);
  assert.throws(() => renderPcm('rpg_notasound'), /unknown effect/);
  assert.throws(() => renderPcm('malformed'), /malformed/);
});

test('descriptions are substantive and distinguishing', () => {
  // Sampled across every category: full-library uniqueness is asserted from the
  // catalog in catalog.test.mjs, which covers all 8888 without re-synthesizing here.
  for (const c of CATEGORIES) {
    const seen = new Set();
    const step = 7;
    for (let i = 0; i < GENERATED_COUNTS[c]; i += step) {
      const name = `${c}_${String(i).padStart(3, '0')}`;
      const d = describe(name);
      assert.ok(typeof d === 'string', `${name}: no description`);
      assert.ok(d.length >= 15 && d.length <= 120, `${name}: bad length (${d.length}): ${d}`);
      seen.add(d);
    }
    const sampled = Math.ceil(GENERATED_COUNTS[c] / step);
    assert.ok(seen.size >= 0.8 * sampled, `${c}: only ${seen.size}/${sampled} unique descriptions`);
  }
  for (const label of PORTED_NAMES) {
    assert.ok(describe(`rpg_${label}`).length >= 15, `rpg_${label}: no description`);
  }
});

test('describeFull carries the metadata consumers read', () => {
  const e = describeFull('snare_012');
  assert.equal(e.name, 'snare_012');
  assert.equal(e.category, 'snare');
  assert.equal(e.file, 'snare/snare_012.wav');
  assert.equal(e.sample_rate, SR);
  assert.equal(e.bits, 8);
  assert.equal(e.channels, 1);
  assert.ok(e.duration_s > 0);
  assert.ok(e.description.length >= 15);
  assert.equal(describeFull('rpg_door').label, 'door');
});

test('soundUrl resolves export paths', () => {
  assert.ok(soundUrl('kick_003').href.endsWith('/sfx/kick/kick_003.wav'));
  assert.ok(soundUrl('rpg_levelup').href.endsWith('/sfx/rpg/rpg_levelup.wav'));
  assert.equal(
    soundUrl('kick_003', { base: 'https://cdn.example/sfx/' }).href,
    'https://cdn.example/sfx/kick/kick_003.wav'
  );
});

test('SfxPlayer is safe without an AudioContext', async () => {
  const p = new SfxPlayer();
  p.resume(); // no AudioContext in Node — must not throw
  assert.equal(p.play('kick_003'), null, 'play() is a no-op without Web Audio');
  await assert.rejects(() => p.load('kick_003'), /no AudioContext/);
  p.muted = true;
  assert.equal(p.play('kick_003'), null);
});

test('the manifest matches package.json and the engine', async () => {
  const m = await loadManifest();
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(m.version, pkg.version, 'manifest version stamp must match package.json');
  assert.equal(m.count, EXPECTED_TOTAL);
  assert.equal(m.categories, EXPECTED_CATEGORIES);
  assert.equal(m.sample_rate, SR);
});
