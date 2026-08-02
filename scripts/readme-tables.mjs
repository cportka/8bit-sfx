#!/usr/bin/env node
// Rewrite the README's category tables from the generator modules, so the docs
// can't drift from the code. Run after adding or changing a category.
import { readFile, writeFile } from 'node:fs/promises';
import { GAME_CATEGORIES, MUSIC_CATEGORIES, GENERATED_COUNTS, categoryCharacter, VARIATIONS } from '../src/index.js';
import { PORTED_NAMES } from '../src/ported.js';

const table = (cats) =>
  ['| Category | Character |', '|---|---|']
    .concat(
      cats.map((c) => {
        const note = c === 'rpg'
          ? ` (${GENERATED_COUNTS.rpg} generated + ${PORTED_NAMES.length} ported)`
          : '';
        return `| \`${c}\` | ${categoryCharacter(c)}${note} |`;
      })
    )
    .join('\n');

const path = new URL('../README.md', import.meta.url);
let md = await readFile(path, 'utf8');
for (const [marker, cats] of [['GAME', GAME_CATEGORIES], ['MUSIC', MUSIC_CATEGORIES]]) {
  const re = new RegExp(`<!-- ${marker}-TABLE -->[\\s\\S]*?(?=\\n###|\\n\\nThe \`rpg\`|$)`);
  if (!re.test(md)) throw new Error(`README marker <!-- ${marker}-TABLE --> not found`);
  md = md.replace(re, `<!-- ${marker}-TABLE -->\n${table(cats)}\n`);
}
await writeFile(path, md);
console.log(`README tables rebuilt: ${GAME_CATEGORIES.length} game + ${MUSIC_CATEGORIES.length} music categories, ${VARIATIONS} each`);
