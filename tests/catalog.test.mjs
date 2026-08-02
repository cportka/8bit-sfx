// The catalog (sfx/manifest.json) is the one prebuilt artifact the package ships,
// so it must never drift from the engine that produces it. These tests read the
// committed catalog and re-derive a slice of it from live synthesis.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadManifest, describe, duration, effectNames, CATEGORIES, VARIATIONS } from '../src/index.js';

const manifest = await loadManifest();
const byName = new Map(
  manifest.effects.map((e) => [e.file.split('/').pop().replace(/\.wav$/, ''), e])
);

test('the catalog lists exactly what the engine can synthesize', () => {
  const names = effectNames();
  assert.equal(manifest.effects.length, names.length);
  assert.equal(manifest.count, manifest.effects.length, 'count field disagrees with its own entries');
  const missing = names.filter((n) => !byName.has(n));
  assert.deepEqual(missing.slice(0, 5), [], `catalog is missing effects (${missing.length} total)`);
});

test('every catalog entry is complete and well-formed', () => {
  for (const e of manifest.effects) {
    assert.ok(e.file && e.category, `entry missing file/category: ${JSON.stringify(e)}`);
    assert.ok(CATEGORIES.includes(e.category), `unknown category: ${e.category}`);
    assert.ok(e.duration_s > 0, `non-positive duration: ${e.file}`);
    assert.ok(e.duration_s < 5, `implausibly long (${e.duration_s}s): ${e.file}`);
    assert.equal(e.sample_rate, 22050);
    assert.ok(e.description?.length >= 15, `missing/thin description: ${e.file}`);
  }
});

test('descriptions distinguish effects within every category', () => {
  const byCategory = new Map(CATEGORIES.map((c) => [c, []]));
  for (const e of manifest.effects) byCategory.get(e.category).push(e.description);
  for (const [c, descs] of byCategory) {
    assert.equal(descs.length, VARIATIONS, `${c}: ${descs.length} effects, expected ${VARIATIONS}`);
    const unique = new Set(descs).size;
    assert.ok(unique >= 0.8 * descs.length, `${c}: only ${unique}/${descs.length} unique descriptions`);
  }
});

test('the catalog is not stale — a sample re-derives from live synthesis', () => {
  // Every 37th effect: ~240 spread across all 44 categories, which catches a
  // catalog built before a generator changed without re-synthesizing all 8888.
  const names = effectNames();
  for (let i = 0; i < names.length; i += 37) {
    const name = names[i];
    const entry = byName.get(name);
    assert.equal(entry.description, describe(name), `${name}: catalog description is stale`);
    const fresh = Math.round(duration(name) * 1000) / 1000;
    assert.ok(
      Math.abs(entry.duration_s - fresh) < 0.002,
      `${name}: catalog duration ${entry.duration_s}s vs synthesized ${fresh}s`
    );
  }
});

test('the ported game sounds carry their labels and relative gains', () => {
  const ported = manifest.effects.filter((e) => e.label);
  assert.equal(ported.length, 28, 'expected the 28 labeled pixel-rpg sounds');
  assert.ok(ported.every((e) => e.category === 'rpg'), 'ported sounds live in rpg');
  for (const e of ported) {
    assert.ok(e.gain > 0 && e.gain <= 1, `${e.label}: gain out of range (${e.gain})`);
  }
  assert.ok(ported.some((e) => e.gain === 1), 'the loudest ported sound should anchor gain at 1');
  const labels = new Set(ported.map((e) => e.label));
  for (const want of ['xp', 'levelup', 'door', 'clock', 'zombie', 'menu-open']) {
    assert.ok(labels.has(want), `missing ported sound: ${want}`);
  }
});
