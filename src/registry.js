// The catalog's shape: which categories exist, how many effects each holds,
// and how an effect name resolves to the function that synthesizes it.

import { PORTED_NAMES } from './ported.js';

import * as jump from './generators/jump.js';
import * as coin from './generators/coin.js';
import * as laser from './generators/laser.js';
import * as explosion from './generators/explosion.js';
import * as powerup from './generators/powerup.js';
import * as hit from './generators/hit.js';
import * as blip from './generators/blip.js';
import * as alarm from './generators/alarm.js';
import * as drone from './generators/drone.js';
import * as jingle from './generators/jingle.js';
import * as ambient from './generators/ambient.js';
import * as ui from './generators/ui.js';
import * as voice from './generators/voice.js';
import * as dog from './generators/dog.js';
import * as zombie from './generators/zombie.js';
import * as monster from './generators/monster.js';
import * as water from './generators/water.js';
import * as fire from './generators/fire.js';
import * as footstep from './generators/footstep.js';
import * as mech from './generators/mech.js';
import * as person from './generators/person.js';
import * as rpg from './generators/rpg.js';

import * as kick from './generators/kick.js';
import * as snare from './generators/snare.js';
import * as hihat from './generators/hihat.js';
import * as tom from './generators/tom.js';
import * as cymbal from './generators/cymbal.js';
import * as perc from './generators/perc.js';
import * as bass from './generators/bass.js';
import * as sub from './generators/sub.js';
import * as lead from './generators/lead.js';
import * as pluck from './generators/pluck.js';
import * as arp from './generators/arp.js';
import * as chord from './generators/chord.js';
import * as bell from './generators/bell.js';
import * as organ from './generators/organ.js';
import * as string from './generators/string.js';
import * as brass from './generators/brass.js';
import * as reed from './generators/reed.js';
import * as pad from './generators/pad.js';
import * as riser from './generators/riser.js';
import * as impact from './generators/impact.js';
import * as glitch from './generators/glitch.js';
import * as vinyl from './generators/vinyl.js';

/** Effects per category. 44 x 202 = 8888. */
export const VARIATIONS = 202;

/** Game-sound categories, in catalog order. */
export const GAME_CATEGORIES = [
  'jump', 'coin', 'laser', 'explosion', 'powerup', 'hit', 'blip', 'alarm', 'drone', 'jingle',
  'ambient', 'ui', 'voice', 'dog', 'zombie', 'monster', 'water', 'fire', 'footstep', 'mech',
  'person', 'rpg',
];

/** Musical sound-design categories, in catalog order. */
export const MUSIC_CATEGORIES = [
  'kick', 'snare', 'hihat', 'tom', 'cymbal', 'perc', 'bass', 'sub', 'lead', 'pluck', 'arp',
  'chord', 'bell', 'organ', 'string', 'brass', 'reed', 'pad', 'riser', 'impact', 'glitch', 'vinyl',
];

export const GENERATORS = {
  jump, coin, laser, explosion, powerup, hit, blip, alarm, drone, jingle,
  ambient, ui, voice, dog, zombie, monster, water, fire, footstep, mech, person, rpg,
  kick, snare, hihat, tom, cymbal, perc, bass, sub, lead, pluck, arp,
  chord, bell, organ, string, brass, reed, pad, riser, impact, glitch, vinyl,
};

export const CATEGORIES = [...GAME_CATEGORIES, ...MUSIC_CATEGORIES];

/**
 * Per-category count of *procedurally generated* effects. Only rpg differs: it
 * reserves slots for the ported game sounds so the category still totals VARIATIONS.
 */
export const GENERATED_COUNTS = Object.fromEntries(
  CATEGORIES.map((c) => [c, c === 'rpg' ? VARIATIONS - PORTED_NAMES.length : VARIATIONS])
);

/** Zero-padded index used in effect names: 7 -> "007". */
export function padIndex(i) {
  return String(i).padStart(3, '0');
}

/** Every effect name in catalog order — 8888 of them. Cheap: no synthesis. */
export function effectNames() {
  const names = [];
  for (const c of CATEGORIES) {
    for (let i = 0; i < GENERATED_COUNTS[c]; i++) names.push(`${c}_${padIndex(i)}`);
    if (c === 'rpg') for (const label of PORTED_NAMES) names.push(`rpg_${label}`);
  }
  return names;
}

/**
 * Resolve an effect name to what produces it.
 * @returns {{category: string, index: number|null, label: string|null}}
 */
export function resolve(name) {
  const cut = name.lastIndexOf('_');
  if (cut < 0) throw new Error(`8bit-sfx: malformed effect name "${name}"`);
  const category = name.slice(0, cut);
  const suffix = name.slice(cut + 1);
  // hasOwn, not `in`: `'toString' in GENERATORS` is true and would sail past
  // this guard, only to die later with a confusing TypeError.
  if (!Object.hasOwn(GENERATORS, category)) {
    throw new Error(`8bit-sfx: unknown category "${category}"`);
  }

  if (/^\d+$/.test(suffix)) {
    const index = Number(suffix);
    if (index >= GENERATED_COUNTS[category]) {
      throw new Error(`8bit-sfx: "${name}" is out of range (${category} has ${GENERATED_COUNTS[category]})`);
    }
    return { category, index, label: null };
  }
  if (category === 'rpg' && PORTED_NAMES.includes(suffix)) {
    return { category, index: null, label: suffix };
  }
  throw new Error(`8bit-sfx: unknown effect "${name}"`);
}
