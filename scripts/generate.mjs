#!/usr/bin/env node
// Optional WAV export + the catalog build.
//
// The library synthesizes on demand, so these files are a convenience, not a
// dependency: `sfx/*.wav` is git-ignored and exists only if you ask for it.
// `sfx/manifest.json` IS committed and shipped — it is the catalog the testing
// page and consumers browse without synthesizing 8888 sounds.
//
//   node scripts/generate.mjs                 # catalog + every wav
//   node scripts/generate.mjs --catalog-only  # just sfx/manifest.json
//   node scripts/generate.mjs --only kick_003 rpg_levelup
//   node scripts/generate.mjs --out /tmp/x    # write somewhere else

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SR, renderWav, describe, describeFull, effectNames, CATEGORIES, categoryCharacter } from '../src/index.js';
import { resolve as resolveName, GENERATED_COUNTS } from '../src/registry.js';
import { PORTED_NAMES } from '../src/ported.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { out: join(ROOT, 'sfx'), only: null, catalogOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--catalog-only') opts.catalogOnly = true;
    else if (argv[i] === '--only') {
      opts.only = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.only.push(argv[++i]);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        'usage: generate.mjs [--out DIR] [--catalog-only] [--only NAME ...]\n' +
          '  (no args)       write sfx/manifest.json and every effect as a .wav\n' +
          '  --catalog-only  write only sfx/manifest.json (what the repo commits)\n' +
          '  --only NAME...  render just these effects; skips the catalog'
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.only) {
    for (const name of opts.only) {
      const { category } = resolveName(name); // throws on unknown names
      const dir = join(opts.out, category);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name}.wav`), renderWav(name));
      console.log(`${name}  ${describe(name)}`);
    }
    return;
  }

  const names = effectNames();
  const effects = [];
  let written = 0;
  let bytes = 0;

  for (const category of CATEGORIES) {
    const dir = join(opts.out, category);
    if (!opts.catalogOnly) await mkdir(dir, { recursive: true });
    const inCategory = names.filter((n) => resolveName(n).category === category);

    for (const name of inCategory) {
      // describeFull synthesizes once and returns both the metadata and the
      // description, so the catalog build is a single pass over the library.
      const { name: _drop, ...entry } = describeFull(name);
      effects.push(entry);

      if (!opts.catalogOnly) {
        const wav = renderWav(name);
        await writeFile(join(dir, `${name}.wav`), wav);
        written++;
        bytes += wav.length;
      }
    }
    const extra = category === 'rpg' ? ` (${GENERATED_COUNTS.rpg} generated + ${PORTED_NAMES.length} ported)` : '';
    console.log(`  ${category.padEnd(10)} ${String(inCategory.length).padStart(4)}${extra}`);
  }

  const { version } = JSON.parse(
    await (await import('node:fs/promises')).readFile(join(ROOT, 'package.json'), 'utf8')
  );
  await mkdir(opts.out, { recursive: true });
  await writeFile(
    join(opts.out, 'manifest.json'),
    JSON.stringify(
      {
        name: '8bit-sfx',
        version,
        count: effects.length,
        categories: CATEGORIES.length,
        sample_rate: SR,
        format: '8-bit unsigned PCM mono WAV',
        generator: 'synthesized on demand by src/ — these files are an optional export',
        character: Object.fromEntries(CATEGORIES.map((c) => [c, categoryCharacter(c)])),
        effects,
      },
      null,
      1
    ) + '\n'
  );

  console.log(`\nwrote manifest.json (${effects.length} effects, ${CATEGORIES.length} categories)`);
  if (written) console.log(`wrote ${written} wav files (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  else console.log('catalog only — run without --catalog-only to export wav files');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
