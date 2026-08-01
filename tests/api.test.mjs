// node --test suite for the package's JS API (run-tests.sh discovers it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadManifest, soundUrl, SfxPlayer, SAMPLE_RATE } from '../src/index.js';

test('manifest loads and is internally consistent', async () => {
  const m = await loadManifest();
  const pkg = JSON.parse(
    await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')
  );
  assert.equal(m.version, pkg.version, 'manifest version stamp must match package.json');
  assert.equal(m.count, m.effects.length);
  assert.ok(m.count >= 1900, `expected ~2000 effects, got ${m.count}`);
  for (const e of m.effects) {
    assert.ok(e.file && e.category, `entry missing file/category: ${JSON.stringify(e)}`);
    assert.ok(e.duration_s > 0, `non-positive duration: ${e.file}`);
    assert.equal(e.sample_rate, SAMPLE_RATE);
    assert.ok(e.description?.length >= 15, `missing/thin description: ${e.file}`);
  }
  // Descriptions exist to differentiate effects — near-duplicates defeat them.
  const byCat = new Map();
  for (const e of m.effects) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category).push(e.description);
  }
  for (const [cat, descs] of byCat) {
    const unique = new Set(descs).size;
    assert.ok(unique >= 0.8 * descs.length,
      `${cat}: only ${unique}/${descs.length} unique descriptions`);
  }
});

test('soundUrl resolves short names and paths to real files', async () => {
  const m = await loadManifest();
  for (const e of m.effects.filter((_, i) => i % 199 === 0)) {
    const short = e.file.split('/').pop().replace(/\.wav$/, '');
    for (const ref of [e.file, short]) {
      const url = soundUrl(ref);
      assert.ok(existsSync(fileURLToPath(url)), `missing on disk: ${ref} -> ${url}`);
    }
  }
  assert.ok(existsSync(fileURLToPath(soundUrl('rpg_zombie'))), 'ported game set resolvable');
});

test('SfxPlayer is safe without an AudioContext', async () => {
  const p = new SfxPlayer();
  p.resume(); // no AudioContext in Node — must not throw
  await assert.rejects(() => p.load('coin_042'), /no AudioContext/);
  p.buffers.set('coin_042', {}); // seed the cache so the null return exercises the context guard
  assert.equal(p.play('coin_042'), null);
  assert.equal(p.muted, false);
});

test('soundUrl and loadManifest honor base overrides', async () => {
  const url = soundUrl('coin_042', { base: 'https://cdn.example/sfx/' });
  assert.equal(url.href, 'https://cdn.example/sfx/coin/coin_042.wav');
  const m = await loadManifest({ base: new URL('../sfx/', import.meta.url) });
  assert.ok(m.count > 0);
});
