/**
 * oneSpace — procedural naming.
 *
 * Names are the cheapest worldbuilding there is and the first thing a player
 * reads, so this module carries more tone than its line count suggests. Three
 * ideas do the work:
 *
 * 1. REGISTERS. A universe named entirely in one style reads as a random word
 *    generator. Real charts are a collision of paperwork, superstition and
 *    dead languages, so every name is drawn from one of four registers —
 *    catalogue designation, spoken/organic word, survey bureaucracy, epithet —
 *    with deliberately lumpy weights.
 *
 * 2. PHONOTACTICS. Organic names are built from onset/nucleus/coda tables
 *    grouped into DIALECTS. A dialect is phonotactically closed: every name
 *    drawn from it shares a consonant inventory, so names from one region
 *    rhyme with each other and clash with the next region over. This is the
 *    same trick natural languages play, and it is why "Kraghorn" and "Vessila"
 *    read as coming from different places rather than the same dice.
 *
 * 3. INHERITANCE. A planet's dialect is *inferred from its star's name* rather
 *    than re-rolled, so a system reads as one family. A moon is derived from
 *    its planet by numeral or diminutive, the way real satellites are.
 *
 * Purity: no Math.random, no I/O, no module-level mutable state. Every export
 * is a pure function of its arguments — call it twice, get the same string.
 * The dedupe guard is therefore *recomputed* from sibling indices rather than
 * cached, which keeps determinism intact at a cost of O(n^2) over ~12 siblings.
 */

import { Rng, hashSeed, rngFrom } from '@/math/rng';

// ---------------------------------------------------------------------------
// Phonotactics
// ---------------------------------------------------------------------------

interface Dialect {
  /** Debug label. Never shown to the player. */
  readonly id: string;
  readonly onsets: readonly string[];
  readonly nuclei: readonly string[];
  /** Word-medial codas — light, so syllables stay pronounceable. */
  readonly codas: readonly string[];
  /**
   * Word-final RHYMES — vowel *and* coda together, e.g. "-orn", "-ikt".
   * They replace the nucleus of the last syllable rather than following it;
   * appending them after a nucleus is what produces unpronounceable vowel
   * pileups like "Kruaghoak", so the final syllable is always onset + rhyme.
   */
  readonly finals: readonly string[];
  /**
   * Recurring morphemes. Repetition across a region is what sells a language.
   * Every entry must contain a vowel: affixes are welded onto a finished word,
   * and a vowel-less one ("-thk") lands on top of whatever coda is already
   * there and produces a pileup no reader can say.
   */
  readonly affixes: readonly string[];
  /** Probability a syllable boundary is marked with `link` instead of nothing. */
  readonly linkChance: number;
  readonly link: string;
  /**
   * Relative frequency of this dialect in `dialectFor`. Not normalised — the
   * six values are read as a ratio, so 22 against 8 means the first dialect is
   * drawn ~2.75x as often. Deliberately lumpy; see the table comment.
   */
  readonly weight: number;
}

/**
 * Six closed inventories. They were chosen to be maximally *unlike each other*
 * in place of articulation: velar/glottal, sibilant/liquid, nasal/dental,
 * labial/plosive, breathy fricative, and a cluster-heavy dialect with no
 * simple onsets at all. Nothing here uses the soft open syllables of generic
 * fantasy naming (no "-elia", no "-andor") — that is the whole point.
 */
const DIALECTS: readonly Dialect[] = [
  {
    // Velar and glottal. Hard, back-of-throat, bureaucratically unpronounceable.
    id: 'kesh',
    onsets: ['k', 'kh', 'kr', 'g', 'gr', 'q', 'x', 'thk', 'dr', 'gh'],
    nuclei: ['a', 'o', 'u', 'au', 'a', 'o', 'ua'],
    codas: ['k', 'r', 'g', 'sk', 'kt'],
    finals: ['ak', 'uk', 'orn', 'ekt', 'arg', 'okh', 'urn', 'ash', 'ogh', 'ak'],
    // '-thak' rather than a bare '-thk': the cluster is a legal kesh onset but
    // not a legal word, and welding it onto a coda gave "Grauthkekt-thk".
    affixes: ['-kar', '-gorn', '-thak'],
    linkChance: 0.12,
    link: "'",
    weight: 22,
  },
  {
    // Sibilant and liquid. The closest thing to pretty this universe allows.
    id: 'vessil',
    onsets: ['s', 'sh', 'v', 'l', 'r', 'sl', 'sv', 'zh', 'th', 'ss'],
    nuclei: ['e', 'i', 'ei', 'ia', 'e', 'i', 'y'],
    codas: ['s', 'l', 'ss', 'rr', 'n'],
    finals: ['is', 'el', 'ess', 'ir', 'in', 'ith', 'illa', 'esse', 'ys', 'il'],
    affixes: ['-sil', '-ress', '-va'],
    linkChance: 0.06,
    link: "'",
    weight: 20,
  },
  {
    // Nasal and dental. Flat, administrative, the language of forms.
    id: 'nauden',
    onsets: ['m', 'n', 'd', 't', 'nd', 'dh', 'tr', 'th', 'mn', 'n'],
    nuclei: ['a', 'e', 'u', 'au', 'o', 'e'],
    codas: ['n', 'nd', 'm', 't', 'th'],
    finals: ['an', 'end', 'um', 'ath', 'oth', 'ent', 'and', 'un', 'oden', 'im'],
    affixes: ['-dan', '-noth', '-tem'],
    linkChance: 0.04,
    link: '-',
    weight: 18,
  },
  {
    // Labial plosives. Blunt, industrial, sounds like cargo handling.
    id: 'brogul',
    onsets: ['b', 'p', 'g', 'br', 'pr', 'gr', 'bl', 'pl', 'd', 'b'],
    nuclei: ['o', 'u', 'ou', 'au', 'a', 'o'],
    codas: ['b', 'p', 'g', 'rg', 'l'],
    finals: ['ol', 'ub', 'org', 'ap', 'ug', 'ord', 'ogul', 'up', 'ab', 'urb'],
    affixes: ['-gul', '-bord', '-pak'],
    linkChance: 0.05,
    link: '-',
    weight: 14,
  },
  {
    // Breathy fricatives. Half a whisper; used for the emptier regions.
    id: 'fahessa',
    onsets: ['h', 'f', 'v', 'ph', 'fr', 'vh', 'hy', 's', 'f', 'h'],
    nuclei: ['ae', 'i', 'y', 'ea', 'a', 'e'],
    codas: ['f', 'h', 's', 'ph', 'ss'],
    finals: ['aeh', 'if', 'yss', 'eath', 'ah', 'assa', 'esh', 'iph', 'aem', 'oh'],
    affixes: ['-hae', '-fess', '-yth'],
    linkChance: 0.14,
    link: "'",
    weight: 11,
  },
  {
    // No simple onsets: every syllable opens on a cluster. Deliberately rare,
    // so encountering it feels like crossing a border.
    id: 'zvrikt',
    onsets: ['vr', 'zr', 'skr', 'tsh', 'kv', 'zv', 'str', 'shk', 'ts', 'zg'],
    nuclei: ['i', 'y', 'e', 'ie', 'u'],
    codas: ['zh', 'tsk', 'r', 'kt', 'sk'],
    finals: ['ikt', 'yzh', 'esk', 'irin', 'ust', 'itsk', 'ezh', 'ysk', 'irn', 'ukt'],
    // '-tsik' rather than '-tsk', for the same reason as kesh's '-thak', and
    // because a vowel-less '-tsk' on a '-itsk' final read as "Zvystritsk-tsk".
    affixes: ['-tsik', '-vrin', '-zho'],
    linkChance: 0.09,
    link: '-',
    weight: 8,
  },
];

const DIALECT_WEIGHTS: readonly number[] = DIALECTS.map((d) => d.weight);

/**
 * Substrings that identify a dialect when we only have a finished name to go
 * on. Single vowels are excluded — they carry no dialect information.
 */
const SIGNATURES: readonly (readonly string[])[] = DIALECTS.map((d) => {
  const set = new Set<string>();
  for (const s of [...d.onsets, ...d.codas, ...d.finals]) {
    if (s.length >= 2) set.add(s);
  }
  return [...set];
});

function dialectFor(seed: number): Dialect {
  return rngFrom(seed, 'dialect').weighted(DIALECTS, DIALECT_WEIGHTS);
}

/**
 * Recover the dialect of an existing name by scoring its letters against each
 * inventory. Longer matches score quadratically, so a three-letter cluster
 * like "skr" outvotes any amount of incidental agreement. This is what makes a
 * planet sound related to its star without either function sharing a seed.
 */
function inferDialect(text: string): Dialect {
  const t = text.toLowerCase().replace(/[^a-z]/g, '');
  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < DIALECTS.length; i++) {
    let score = 0;
    for (const frag of SIGNATURES[i]) {
      let from = 0;
      for (;;) {
        const at = t.indexOf(frag, from);
        if (at < 0) break;
        score += frag.length * frag.length;
        from = at + 1;
      }
    }
    // Normalise by inventory size so a dialect does not win merely by listing
    // more fragments than its neighbours.
    score /= SIGNATURES[i].length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  // Nothing scored: the name is pure designation ("DPH 52-3") with no letters
  // to go on. Hash the text to a dialect so the choice is at least stable for
  // that name — the constant is an arbitrary fixed salt, not a tuned value.
  if (bestIndex < 0) return DIALECTS[hashSeed(0x5eed1e, t) % DIALECTS.length];
  return DIALECTS[bestIndex];
}

/**
 * Syllable counts are not uniform: two dominates, one is punchy and common,
 * three is the exception that makes a chart look hand-drawn. Four never
 * happens because four-syllable invented words stop being readable.
 */
function syllableCount(rng: Rng): number {
  return rng.weighted([1, 2, 3], [26, 55, 19]);
}

/**
 * Every natural language uses its simple vowels far more than its diphthongs.
 * Drawing uniformly from the nucleus table produces "Goghauktgrau"; weighting
 * towards the monophthongs produces "Gokthaur", which a pilot could say aloud.
 */
function nucleus(rng: Rng, d: Dialect): string {
  const v = rng.pick(d.nuclei);
  if (v.length === 1 || rng.chance(0.3)) return v;
  return rng.pick(d.nuclei).slice(0, 1);
}

function word(rng: Rng, d: Dialect): string {
  const n = syllableCount(rng);
  let out = '';
  let prevOnset = '';
  /** Consonants currently hanging off the end of `out` as a medial coda. */
  let codaLen = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && rng.chance(d.linkChance)) {
      out += d.link;
      codaLen = 0; // the link is a break; nothing to collide across it
    }
    let onset = rng.pick(d.onsets);
    // One re-pick on a repeat. Consecutive identical onsets are the single
    // loudest tell of a generated name ("Goplopluorg") and cost nothing to fix.
    if (onset === prevOnset) onset = rng.pick(d.onsets);
    prevOnset = onset;
    // Sonority at the syllable seam. A cluster coda butted straight against a
    // cluster onset is what produced "Zvetskskrust" and "Zvytsktshyzrysk" —
    // both legal under the tables, neither sayable. Four consonants across one
    // boundary is the cut; past it the *coda* is dropped rather than the onset,
    // because the onset is the part carrying the dialect's identity. No Rng
    // value is consumed either way, so the stream shape is unaffected.
    if (codaLen > 0 && codaLen + onset.length >= 4) out = out.slice(0, -codaLen);
    codaLen = 0;
    out += onset;
    if (i === n - 1) {
      // The rhyme is what the ear remembers; skip it occasionally so a region
      // does not end every one of its names the same way.
      out += rng.chance(0.85) ? rng.pick(d.finals) : nucleus(rng, d) + rng.pick(d.codas);
    } else {
      out += nucleus(rng, d);
      // Roughly a quarter of medial syllables close. Much above this and every
      // word becomes a consonant sandwich; much below and the dialects stop
      // sounding different from each other, because the codas carry the
      // inventory that the shared vowels do not.
      if (rng.chance(0.28)) {
        const coda = rng.pick(d.codas);
        out += coda;
        codaLen = coda.length;
      }
    }
  }
  // One name in ten carries a morpheme, and only short ones — an affix on a
  // three-syllable word pushes it past what a chart label can hold.
  if (n <= 2 && rng.chance(0.1)) {
    const affix = rng.pick(d.affixes);
    // Draw first, attach second, so the number of Rng values consumed does not
    // depend on the word built so far. The seam is rejected when the affix
    // simply repeats the consonants already at the end of the word, which is
    // the difference between "Verrin-sil" and the stutter "Zvystritsk-tsik".
    const core = affix.replace(/^[^a-z]+/, '');
    const onset = core.replace(/[aeiouy].*$/, '');
    if (onset.length === 0 || !out.toLowerCase().endsWith(onset)) out += affix;
  }
  return finish(out, rng, d);
}

/**
 * Short accidental English. Consonant-cluster inventories rarely produce real
 * words, but "Pup" and "Bab" turned up in testing and a star map has no room
 * for either. Exact matches only — substring matching would eat legitimate
 * endings such as "-assa".
 */
const UNFORTUNATE = new Set<string>([
  'pup', 'bab', 'bob', 'gob', 'bum', 'poo', 'pee', 'ass', 'tit', 'fag', 'gag',
  'nob', 'wog', 'dud', 'pap', 'bog', 'gut', 'nut', 'cum', 'sex',
]);

/**
 * Substrings that must never appear anywhere in a generated name. Six
 * inventories crossed with three syllable counts eventually emits all of
 * these — "Shithesse" came out of the sibilant dialect on the second test run
 * — and a procedural generator that ships a slur is a generator nobody gets to
 * defend. Checked as substrings, unlike UNFORTUNATE, because the harm does not
 * care whether the word ends there.
 */
const BANNED: readonly string[] = [
  'shit', 'fuk', 'fuck', 'cunt', 'piss', 'rape', 'nigg', 'kike', 'spic',
  // 'whore' rather than 'whor' — the short form would mangle "Whorl", which is
  // a legitimate word in the galaxy vocabulary.
  'wank', 'twat', 'dick', 'cock', 'anus', 'arse', 'turd', 'slut', 'whore',
  'jizz', 'nazi', 'hitler', 'chink', 'dyke', 'coon',
];

/** Index of the first BANNED substring in `lower`, or -1. `lower` must already
 *  be lowercased — this is called from hot loops that have one to hand. */
function bannedAt(lower: string): readonly [number, number] {
  for (const bad of BANNED) {
    const at = lower.indexOf(bad);
    if (at >= 0) return [at, bad.length];
  }
  return [-1, 0];
}

/**
 * A monophthong from this dialect that is *not* `avoid`. Without the exclusion
 * the repair below can redraw the offending vowel and loop out of its guard —
 * that is how "Shithissis" survived sanitisation on the first attempt.
 */
function simpleVowel(rng: Rng, d: Dialect, avoid: string): string {
  // Eight draws: the sparsest nucleus table holds five entries of which at
  // least three are monophthongs, so P(eight consecutive misses) < 0.02, and
  // the deterministic scan below covers the remainder.
  for (let i = 0; i < 8; i++) {
    const v = rng.pick(d.nuclei);
    if (v.length === 1 && v !== avoid) return v;
  }
  for (const v of d.nuclei) if (v.length === 1 && v !== avoid) return v;
  return avoid === 'a' ? 'o' : 'a';
}

/**
 * Repair rather than reject. Rejection sampling would work but would make the
 * number of Rng draws depend on the content of the draw, which is a subtle way
 * to make a generator fragile; swapping one vowel keeps the word inside its
 * dialect and terminates in a bounded number of steps.
 */
function sanitise(s: string, rng: Rng, d: Dialect): string {
  let out = s;
  // Four passes. Each pass either returns or removes one hit, and no name in
  // the tables is long enough to carry more than two; the bound only exists so
  // a future vocabulary change cannot turn this into an infinite loop.
  for (let guard = 0; guard < 4; guard++) {
    const low = out.toLowerCase();
    if (out.length < 4 || UNFORTUNATE.has(low)) {
      // Three letters is not a name, it is an abbreviation.
      out += rng.pick(d.finals);
      continue;
    }
    const [hit, hitLen] = bannedAt(low);
    if (hit < 0) return out;
    let vowel = -1;
    for (let i = hit; i < hit + hitLen; i++) {
      if ('aeiouy'.includes(low[i])) {
        vowel = i;
        break;
      }
    }
    if (vowel < 0) return out.slice(0, hit) + rng.pick(d.finals) + out.slice(hit + hitLen);
    out = out.slice(0, vowel) + simpleVowel(rng, d, low[vowel]) + out.slice(vowel + 1);
  }
  return out;
}

/** Every generated word leaves through here. */
function finish(raw: string, rng: Rng, d: Dialect): string {
  return capitalise(collapse(sanitise(raw, rng, d)));
}

/**
 * Squash accidental triples ("sss", "kkk") that concatenating a coda onto a
 * matching onset can produce. Doubles are kept — "ss", "rr" and "ll" are load
 * bearing in the sibilant dialect and removing them would flatten it.
 */
function collapse(s: string): string {
  let out = '';
  let run = 0;
  let prev = '';
  for (const ch of s) {
    if (ch === prev) run++;
    else run = 0;
    prev = ch;
    if (run < 2) out += ch;
  }
  return out;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** The first closed syllable — onset, vowel run, and the consonants after it. */
const FIRST_SYLLABLE = /^[^aeiouy]*[aeiouy]+[^aeiouy]*/;

/**
 * Reshape an existing stem into a sibling word: keep its first closed syllable
 * — the part the ear actually uses to recognise a name — and replace the tail
 * with a rhyme from the family dialect. "Verrin" -> "Verresk", "Kraghorn" ->
 * "Kraghuk". This is the mechanism behind planetary family resemblance.
 */
function morph(stem: string, rng: Rng, d: Dialect): string {
  const s = stem.toLowerCase().replace(/[^a-z']/g, '');
  const m = FIRST_SYLLABLE.exec(s);
  const head = m !== null && m[0].length >= 2 ? m[0] : s.slice(0, 3);
  return finish(head + rng.pick(d.finals), rng, d);
}

// ---------------------------------------------------------------------------
// Register vocabularies
// ---------------------------------------------------------------------------

/** Noir adjectives: understatement, money, weather, fatigue. Never grandeur. */
const ADJ: readonly string[] = [
  'Quiet', 'Cold', 'Long', 'Last', 'Thin', 'Slow', 'Low', 'Blind', 'Dry',
  'Late', 'Still', 'Bitter', 'Hollow', 'Patient', 'Honest', 'Cheap', 'Borrowed',
  'Unlit', 'Unpaid', 'Spare', 'Narrow', 'Brief', 'Sour', 'Weary', 'Crooked',
  'Silent', 'Grey', 'Wet', 'Reluctant', 'Second', 'Idle', 'Bad', 'Small',
  'Charitable', 'Modest', 'Off', 'Bare', 'Flat', 'Faithful', 'Empty',
];

/** Nouns with a price attached, or a body part, or a piece of weather. */
const NOUN: readonly string[] = [
  'Mile', 'Salt', 'Hour', 'Room', 'Wire', 'Door', 'Coat', 'Hand', 'Lamp',
  'Tide', 'Dust', 'Ledger', 'Ash', 'Glass', 'Throat', 'Promise', 'Mercy',
  'Verdict', 'Appetite', 'Angle', 'Cut', 'Alibi', 'Tab', 'Fare', 'Watch',
  'Silence', 'Bell', 'Harbour', 'Crossing', 'Remainder', 'Interval', 'Custody',
  'Distance', 'Freight', 'Debt', 'Weather', 'Errand', 'Retainer', 'Nerve',
  'Margin', 'Favour', 'Shift', 'Wager', 'Answer', 'Landing', 'Deposit',
];

/** First halves of compound epithets — the Halfmourn/Coldsalt construction. */
const COMPOUND_HEAD: readonly string[] = [
  'Half', 'Cold', 'Dead', 'Low', 'Grey', 'Long', 'Salt', 'Black', 'Ash',
  'Gall', 'Dun', 'Wrack', 'Thin', 'Old', 'Under', 'Off', 'Slack', 'Rust',
  'Bone', 'Fog', 'Nine', 'Sun', 'Night', 'Winter', 'Hollow', 'Storm',
];

const COMPOUND_TAIL: readonly string[] = [
  'mourn', 'fall', 'wick', 'drift', 'hollow', 'reach', 'verge', 'gate',
  'cross', 'keep', 'holt', 'tide', 'march', 'cairn', 'glass', 'well', 'latch',
  'moor', 'span', 'run', 'ferry', 'wharf', 'spit', 'bar', 'scar', 'rest',
  'watch', 'shear', 'strand', 'lock',
];

/** Words a surveyor's office would actually use. Dry on purpose. */
const BUREAU: readonly string[] = [
  'Claim', 'Writ', 'Concession', 'Interdict', 'Levy', 'Escrow', 'Assay',
  'Quarantine', 'Bond', 'Lien', 'Tariff', 'Warrant', 'Docket', 'Cadastre',
  'Survey', 'Manifest', 'Injunction', 'Remit', 'Requisition', 'Forfeiture',
  'Probate', 'Attestation', 'Abatement', 'Holding', 'Reserve', 'Transit',
];

/** Geographic classifiers. Charts always name the shape of a thing. */
const FEATURE: readonly string[] = [
  'Reach', 'Deep', 'Drift', 'Waste', 'Chain', 'Verge', 'Sink', 'Shelf',
  'Cluster', 'Spur', 'Trace', 'Hollow', 'Terminus', 'Gate', 'Anchorage',
  'Roads', 'Narrows', 'Approach', 'Fault', 'Trough', 'Margin', 'Annex',
  'Ossuary', 'Cut', 'Grid', 'Bight', 'Passage', 'Bar', 'Sound', 'Shoal',
];

/**
 * Two- and three-letter catalogue prefixes. Consonants only; no words.
 *
 * The integer ranges paired with these throughout the module follow one rule:
 * DIGIT COUNT ENCODES SCALE, the way real catalogues do. Four to five digits
 * for stars (a survey of a hundred billion objects), three to four for
 * galaxies and nebulae, and one to two for the sequence number welded onto a
 * name that already exists ("KDR-12 Verrin" — the twelfth entry under that
 * heading, not the twelve-thousandth). Bureaucratic numbers start at 2 rather
 * than 1 because "Docket 1" reads as a placeholder and "Docket 47" reads as a
 * filing system with a history behind it.
 */
const CAT_PREFIX: readonly string[] = [
  'KV', 'HX', 'TQ', 'VD', 'ZR', 'NL', 'GX', 'PT', 'RK', 'SV', 'XM', 'QD',
  'BN', 'LH', 'TSK', 'VRN', 'KDR', 'MQ', 'JT', 'WX', 'CZ', 'DPH', 'SGR',
];

const GREEK: readonly string[] = [
  'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
  'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho',
  'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega',
];

/** Nouns for a thing made of gas and bad news. */
const NEBULA_NOUN: readonly string[] = [
  'Shroud', 'Veil', 'Wake', 'Pall', 'Bloom', 'Smear', 'Bruise', 'Curtain',
  'Lung', 'Mouth', 'Rag', 'Sheet', 'Cinder', 'Wound', 'Remnant', 'Haze',
  'Cataract', 'Cloudbank', 'Exhalation', 'Blindfold', 'Bandage', 'Spill',
  'Stain', 'Breath', 'Cough', 'Sleeve',
];

/** Nouns for a thing made of a hundred billion suns. */
const GALAXY_NOUN: readonly string[] = [
  'Whorl', 'Coil', 'Wheel', 'Sprawl', 'Loom', 'Drift', 'Cascade', 'Mill',
  'Foundry', 'Ossuary', 'Carousel', 'Furnace', 'Reliquary', 'Vault',
  'Spindle', 'Gyre', 'Concourse', 'Exchange', 'Yard', 'Works',
];

const SEPARATOR: readonly string[] = [' // ', ' / ', ' — ', ': '];

// ---------------------------------------------------------------------------
// Numerals
// ---------------------------------------------------------------------------

const ROMAN_TABLE: readonly (readonly [number, string])[] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function roman(n: number): string {
  let v = Math.max(1, Math.floor(n));
  let out = '';
  for (const [value, glyph] of ROMAN_TABLE) {
    while (v >= value) {
      out += glyph;
      v -= value;
    }
  }
  return out;
}

const ROMAN_RE = /^(?=[MDCLXVI]+$)M*(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

// ---------------------------------------------------------------------------
// Token surgery on finished names
// ---------------------------------------------------------------------------

/**
 * Every English word this module can emit. A token drawn from here is chart
 * furniture (a classifier, an office, an adjective) rather than the *name* of
 * anything, so it can never be the stem on its own.
 */
const ENGLISH = new Set<string>(
  [
    ...FEATURE, ...BUREAU, ...GREEK, ...ADJ, ...NOUN, ...NEBULA_NOUN, ...GALAXY_NOUN,
    'The', 'Sector', 'Hazard', 'Zone', 'Of', 'And',
  ].map((s) => s.toLowerCase()),
);

/**
 * Pull out the part of a finished name that a child body should be named
 * after. Three cases, in priority order:
 *
 *   "NL-73 Zheisshiin"      -> "Zheisshiin"     (an invented word exists)
 *   "The Patient Crossing"  -> "Patient Crossing" (epithet: keep it whole,
 *                              because "Crossing IV" throws away the name)
 *   "DPH 52-3"              -> "DPH 52-3"       (pure designation: keep the
 *                              number, the way HD 189733 b does)
 */
function coreToken(name: string): string {
  const tokens = name.split(/[^A-Za-z']+/).filter((t) => t.length > 0);
  let best = '';
  for (const t of tokens) {
    if (ENGLISH.has(t.toLowerCase())) continue;
    // A token with no vowel is an initialism, not a word — "DPH" alone reads
    // as a typo when a planet is hung off it.
    if (!/[aeiouy]/i.test(t)) continue;
    if (t.length <= 2) continue;
    if (t.length <= 4 && ROMAN_RE.test(t.toUpperCase())) continue;
    if (t.length > best.length) best = t;
  }
  if (best.length > 0) return capitalise(best);

  // No invented word: fall back to the whole designation minus the leading
  // article and any trailing sequence numeral already present.
  const whole = name
    .replace(/^The\s+/i, '')
    .replace(/\s+[MDCLXVI]+$/, '')
    .trim();
  // Unreachable for anything this module emits — every generator produces at
  // least one token. The literal is a valid vessil-dialect word rather than a
  // marker string so that a caller passing in a name from somewhere else gets
  // a usable planet name instead of "UNKNOWN I" on the chart.
  return whole.length > 0 ? whole : 'Vessil';
}

/** True when a name already ends in a sequence marker — "IV" or a bare "d". */
function endsInSequence(name: string): 'numeral' | 'letter' | null {
  const last = name.split(/\s+/).pop() ?? '';
  if (last.length === 1 && /[a-z]/.test(last)) return 'letter';
  if (last.length > 0 && ROMAN_RE.test(last.toUpperCase())) return 'numeral';
  return null;
}

/**
 * True when a stem is a single pronounceable word, and so safe to mutate or
 * suffix. "Verrin" is; "DPH 52-3" and "Patient Crossing" are not — those can
 * only ever be *appended to*.
 */
function isWordStem(s: string): boolean {
  return /^[A-Za-z']{3,}$/.test(s) && /[aeiouy]/i.test(s);
}

// ---------------------------------------------------------------------------
// Public: galaxy
// ---------------------------------------------------------------------------

/**
 * Galaxies get the grandest register mix — they are the only objects a whole
 * civilisation would have agreed on a name for, so possessives and definite
 * articles are allowed here that would be absurd on a rock.
 */
export function galaxyName(seed: number): string {
  const rng = rngFrom(seed, 'galaxy-name');
  const d = dialectFor(hashSeed(seed, 'galaxy-dialect'));
  const stem = word(rng, d);

  const register = rng.weighted(
    ['epithet', 'stem-noun', 'possessive', 'catalogue', 'bureau'] as const,
    [26, 30, 18, 16, 10],
  );

  switch (register) {
    case 'epithet':
      return `The ${epithet(rng)}`;
    case 'stem-noun':
      return rng.chance(0.25)
        ? `The ${stem} ${rng.pick(GALAXY_NOUN)}`
        : `${stem} ${rng.pick(GALAXY_NOUN)}`;
    case 'possessive':
      return `${stem}'s ${rng.pick(GALAXY_NOUN)}`;
    case 'catalogue':
      return `${rng.pick(CAT_PREFIX)} ${rng.int(101, 9899)}`;
    case 'bureau':
      return `${rng.pick(BUREAU)} ${rng.pick(GALAXY_NOUN)} ${rng.int(2, 19)}`;
  }
}

/**
 * Two epithet grammars: "Cold Salt" and the welded "Halfmourn". The 42/58 split
 * keeps the welded form the *texture* of the register rather than its whole
 * identity — at parity the two forms start reading as one interchangeable pool.
 */
function epithet(rng: Rng): string {
  if (rng.chance(0.42)) return weld(rng.pick(COMPOUND_HEAD), rng.pick(COMPOUND_TAIL));
  return `${rng.pick(ADJ)} ${rng.pick(NOUN)}`;
}

/**
 * Join a compound epithet, checking the *seam*.
 *
 * `sanitise` never sees these words: compounds are English vocabulary, not
 * generated syllables, so they bypass `finish` entirely. That matters because a
 * weld can spell something neither half contains — "Night"+"watch",
 * "Rust"+"watch" and "Salt"+"watch" all straddle a slur across the join, and
 * all three shipped before this check existed. The replacement walks the tail
 * table by index instead of drawing again, so the number of Rng values consumed
 * stays the same whichever pair comes up.
 */
function weld(head: string, tail: string): string {
  const start = COMPOUND_TAIL.indexOf(tail);
  for (let i = 0; i < COMPOUND_TAIL.length; i++) {
    const t = COMPOUND_TAIL[(start + i) % COMPOUND_TAIL.length];
    if (bannedAt((head + t).toLowerCase())[0] < 0) return head + t;
  }
  return head + tail;
}

// ---------------------------------------------------------------------------
// Public: star system
// ---------------------------------------------------------------------------

/**
 * Weights here are the single most audible design decision in the module.
 * Organic names dominate so a chart reads as inhabited language; catalogue
 * designations are common enough to feel institutional; bureaucratic and
 * epithet names are the rarities that make a star map worth reading.
 */
export function systemName(seed: number): string {
  const rng = rngFrom(seed, 'system-name');
  const d = dialectFor(seed);
  const stem = word(rng, d);

  const register = rng.weighted(
    ['organic', 'organic-feature', 'catalogue', 'catalogue-named', 'bureau', 'epithet'] as const,
    [30, 14, 12, 14, 14, 16],
  );

  switch (register) {
    case 'organic':
      return stem;
    case 'organic-feature':
      return rng.chance(0.3)
        ? `${stem} ${rng.pick(FEATURE)} ${roman(rng.int(2, 12))}`
        : `${stem} ${rng.pick(FEATURE)}`;
    case 'catalogue':
      // Bare designations: a place nobody bothered to name.
      return rng.chance(0.5)
        ? `${rng.pick(CAT_PREFIX)}-${rng.int(1000, 9999)}`
        : `${rng.pick(CAT_PREFIX)} ${rng.int(10, 99)}-${rng.int(1, 9)}`;
    case 'catalogue-named':
      // The common real-world case: a catalogue tag welded onto a local name.
      return `${rng.pick(CAT_PREFIX)}-${rng.int(1, 99)} ${stem}`;
    case 'bureau':
      return rng.chance(0.55)
        ? `${rng.pick(BUREAU)} ${rng.int(2, 99)}${rng.pick(SEPARATOR)}${stem}`
        : `Sector ${rng.pick(FEATURE)}`;
    case 'epithet':
      return rng.chance(0.6) ? `The ${epithet(rng)}` : epithet(rng);
  }
}

/**
 * A star as it appears in a galaxy-wide catalogue.
 *
 * Deliberately a different weighting to `systemName`: a catalogue covering a
 * hundred billion objects is overwhelmingly designations, with proper names
 * reserved for the handful bright enough to have been visible from somewhere
 * that mattered. That asymmetry is why a star map reads as *surveyed* rather
 * than as invented — most entries are numbers, and the named ones stand out.
 *
 * Bayer-style forms ("Beta Kraghorn") appear here and nowhere else; they are
 * the mark of a star catalogued from outside rather than lived in.
 */
export function starName(seed: number): string {
  const rng = rngFrom(seed, 'star-name');
  const d = dialectFor(seed);
  const stem = word(rng, d);

  const register = rng.weighted(
    ['designation', 'designation-named', 'bayer', 'organic', 'epithet', 'bureau'] as const,
    [34, 18, 12, 20, 9, 7],
  );

  switch (register) {
    case 'designation':
      return rng.chance(0.45)
        ? `${rng.pick(CAT_PREFIX)}-${rng.int(1000, 99999)}`
        : `${rng.pick(CAT_PREFIX)} ${rng.int(100, 999)}.${rng.int(1, 9)}`;
    case 'designation-named':
      return `${rng.pick(CAT_PREFIX)}-${rng.int(1, 99)} ${stem}`;
    case 'bayer':
      return `${rng.pick(GREEK)} ${stem}`;
    case 'organic':
      return rng.chance(0.24) ? `${stem} ${rng.pick(FEATURE)}` : stem;
    case 'epithet':
      return `The ${epithet(rng)}`;
    case 'bureau':
      return `${rng.pick(BUREAU)} ${rng.int(2, 99)}${rng.pick(SEPARATOR)}${stem}`;
  }
}

// ---------------------------------------------------------------------------
// Public: planets
// ---------------------------------------------------------------------------

/**
 * Planet names are inherited, not invented. The dialect comes from the star's
 * name, so every world in a system shares a consonant inventory even when the
 * registers differ — the same way Titan and Enceladus sound related and Kepler
 * -22b does not.
 *
 * `index` is the orbital index from the star outward, 0-based.
 */
export function planetName(seed: number, systemName: string, index: number): string {
  return dedupedSibling(index, systemName, (i, attempt) =>
    rawPlanetName(seed, systemName, i, attempt),
  );
}

function rawPlanetName(seed: number, sysName: string, index: number, attempt: number): string {
  const rng = rngFrom(hashSeed(seed, `planet:${index}:${attempt}`), sysName);
  const d = inferDialect(sysName);
  const stem = coreToken(sysName);

  // A system is not a naming free-for-all: most systems settle into ONE
  // convention for their planets (all numerals, or all Greek, or all local
  // words) and break it once. `house` is that convention, fixed per system.
  const houseRng = rngFrom(hashSeed(seed, 'house'), sysName);
  const house = houseRng.weighted(
    ['roman', 'greek', 'letter', 'organic'] as const,
    [40, 16, 14, 30],
  );
  const breaksRank = rng.chance(0.22);

  let register = breaksRank
    ? rng.weighted(['organic', 'epithet', 'bureau', 'roman'] as const, [30, 34, 20, 16])
    : house;
  // A designation-only star ("DPH 52-3") has no word to mutate, so the organic
  // register is unavailable to its planets and they fall back to numerals.
  if (register === 'organic' && !isWordStem(stem)) register = 'roman';

  switch (register) {
    case 'roman':
      // Numbered from the star outward, and real charts start at I, not 0.
      return `${stem} ${roman(index + 1)}`;
    case 'greek':
      return `${stem} ${GREEK[index % GREEK.length]}`;
    case 'letter':
      // Lowercase suffix: the exoplanet convention, where 'a' is the star, so
      // planets start at 'b' (char code 98) and wrap after 'z' — 25 letters.
      return `${stem} ${String.fromCharCode(98 + (index % 25))}`;
    case 'organic':
      // Either a fresh word in the family dialect or a mutation of the star's
      // own stem. The mutation is what produces the strongest resemblance.
      return rng.chance(0.45) ? morph(stem, rng, d) : word(rng, d);
    case 'epithet':
      return rng.chance(0.55) ? `The ${epithet(rng)}` : epithet(rng);
    case 'bureau':
      return `${rng.pick(BUREAU)} ${rng.int(2, 48)}${rng.pick(SEPARATOR)}${stem}`;
  }
}

// ---------------------------------------------------------------------------
// Public: moons
// ---------------------------------------------------------------------------

/**
 * Moons are always *of* something. Three real conventions are used: a Roman
 * numeral appended to the parent (Jupiter III), a lowercase survey letter, and
 * a diminutive of the parent word — the last is what makes a big moon feel
 * like it earned a name.
 */
export function moonName(seed: number, planetName: string, index: number): string {
  return dedupedSibling(index, planetName, (i, attempt) =>
    rawMoonName(seed, planetName, i, attempt),
  );
}

/** Diminutive endings. Small, clipped, slightly affectionate. */
const DIMINUTIVE: readonly string[] = [
  'et', 'ik', 'in', 'ka', 'el', 'ushk', 'ling', 'it', 'ek', 'a', 'ie', 'ok',
];

function rawMoonName(seed: number, parent: string, index: number, attempt: number): string {
  const rng = rngFrom(hashSeed(seed, `moon:${index}:${attempt}`), parent);
  const d = inferDialect(parent);
  const stem = coreToken(parent);

  // "Verrin IV III" and "Verrin d d" are both illegible. A survey alternates
  // marker types down the hierarchy, so whichever marker the parent already
  // carries is exactly the one the moon may not use.
  const seq = endsInSequence(parent);
  const fallback = seq === 'numeral' ? 'letter' : 'roman';
  let register = rng.weighted(
    ['roman', 'letter', 'diminutive', 'organic', 'epithet'] as const,
    seq === 'numeral' ? [0, 44, 30, 20, 6] : seq === 'letter' ? [46, 0, 30, 18, 6] : [34, 16, 28, 16, 6],
  );
  // Both the diminutive and the mutation need a single word to work on.
  if ((register === 'diminutive' || register === 'organic') && !isWordStem(stem)) {
    register = fallback;
  }

  switch (register) {
    case 'roman':
      // Jupiter III, Saturn VI — the moon is numbered, the planet is not.
      return `${parent} ${roman(index + 1)}`;
    case 'letter':
      // Moons start at 'a' (char code 97), not 'b': the exoplanet convention
      // reserves 'a' for the star, and a moon's parent is the planet, which
      // already carries its own name in the string. All 26 letters are usable.
      return `${parent} ${String.fromCharCode(97 + (index % 26))}`;
    case 'diminutive': {
      // Strip an existing vowel ending before suffixing so we do not stack
      // vowels: "Vessila" + "-et" would give "Vessilaet".
      const base = stem.replace(/[aeiouy]+$/i, '');
      return finish(base + rng.pick(DIMINUTIVE), rng, d);
    }
    case 'organic':
      return morph(stem, rng, d);
    case 'epithet':
      return `The ${epithet(rng)}`;
  }
}

// ---------------------------------------------------------------------------
// Public: nebulae
// ---------------------------------------------------------------------------

export function nebulaName(seed: number): string {
  const rng = rngFrom(seed, 'nebula-name');
  const d = dialectFor(hashSeed(seed, 'nebula-dialect'));
  const stem = word(rng, d);

  const register = rng.weighted(
    ['the-adj-noun', 'stem-noun', 'possessive', 'catalogue', 'compound', 'bureau'] as const,
    [24, 24, 16, 14, 14, 8],
  );

  switch (register) {
    case 'the-adj-noun':
      return `The ${rng.pick(ADJ)} ${rng.pick(NEBULA_NOUN)}`;
    case 'stem-noun':
      return `${stem} ${rng.pick(NEBULA_NOUN)}`;
    case 'possessive':
      return `${stem}'s ${rng.pick(NEBULA_NOUN)}`;
    case 'catalogue':
      return rng.chance(0.5)
        ? `${rng.pick(CAT_PREFIX)} ${rng.int(10, 99)}-${rng.int(1, 9)}`
        : `${rng.pick(CAT_PREFIX)}-${rng.int(100, 4999)}`;
    case 'compound':
      return `${weld(rng.pick(COMPOUND_HEAD), rng.pick(COMPOUND_TAIL))} ${rng.pick(NEBULA_NOUN)}`;
    case 'bureau':
      return `Hazard ${rng.pick(FEATURE)} ${rng.int(2, 40)}${rng.pick(SEPARATOR)}${stem}`;
  }
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/**
 * Deterministic sibling dedupe.
 *
 * A memo cache would be simpler but would make the function non-pure: the
 * second call with the same arguments could return a different string. Instead
 * we replay every earlier sibling and re-roll on collision with an incremented
 * `attempt` salt. n is the moon/planet count (~12 worst case), so the O(n^2)
 * replay costs nothing and the result is identical on every machine forever.
 *
 * `reserved` seeds the used-set so a planet can never share its star's name.
 */
function dedupedSibling(
  index: number,
  reserved: string,
  make: (i: number, attempt: number) => string,
): string {
  const used = new Set<string>([reserved.toLowerCase()]);
  let current = '';
  for (let i = 0; i <= index; i++) {
    let attempt = 0;
    current = make(i, attempt);
    // Eight re-rolls is far beyond what any real collision needs; the bound
    // exists only so a pathological vocabulary can never hang the generator.
    while (used.has(current.toLowerCase()) && attempt < 8) {
      attempt++;
      current = make(i, attempt);
    }
    if (used.has(current.toLowerCase())) current = `${current} ${roman(i + 1)}`;
    used.add(current.toLowerCase());
  }
  return current;
}

// ---------------------------------------------------------------------------
// Blurbs
// ---------------------------------------------------------------------------

type Facts = Record<string, string | number>;

function fnum(f: Facts, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = f[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (v.trim() !== '' && Number.isFinite(n)) return n;
    }
  }
  return null;
}

function fstr(f: Facts, ...keys: string[]): string {
  for (const k of keys) {
    const v = f[k];
    if (typeof v === 'string' && v.length > 0) return v.toLowerCase();
  }
  return '';
}

function fbool(f: Facts, ...keys: string[]): boolean {
  for (const k of keys) {
    const v = f[k];
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const s = v.toLowerCase();
      if (s === 'true' || s === 'yes' || s === 'y' || s === '1') return true;
      if (s === 'false' || s === 'no' || s === 'n' || s === '0' || s === '') return false;
      return true;
    }
  }
  return false;
}

/**
 * Clause banks. Every entry is a complete, lowercase-initial independent
 * clause with its own rhythm — that is the anti-mad-libs measure. Templates
 * join clauses; they never slot a bare noun into a fixed frame, so the failure
 * mode of "The [adj] [noun] is very [adj]" cannot occur.
 */
const TRAIT: Readonly<Record<string, readonly string[]>> = {
  hot: [
    'the dayside runs hot enough to soften hull plate',
    'shadow is the only real estate here worth owning',
    'the rock holds its heat long after the star has gone down',
    'every horizon shimmers like a bad alibi',
    'the ground temperature was read twice because nobody believed it the first time',
    'heat comes off the plains in sheets you can watch move',
  ],
  scorched: [
    'the surface glows faintly on the nightside, which is never good news',
    'metal runs before anything organic gets the chance to burn',
    'the star is close enough to be a working condition rather than a light source',
  ],
  cold: [
    'the cold here is patient and does not negotiate',
    'the atmosphere lies on the ground in drifts',
    'the ice has had a long time to think about the shape it wants',
    'exhaust plumes freeze before they clear the vents',
    'nothing has melted here since the star was young',
    'the frost line runs straight through the middle of the local economy',
  ],
  temperate: [
    'it is almost hospitable, which is usually how these things start',
    'the temperature is reasonable, and in this line of work that is suspicious',
    'you could stand outside on a good day, in the right coat',
    'the weather is mild, which out here counts as a character flaw',
  ],
  tidal: [
    'one face has never seen the star and never will',
    'the terminator is a permanent grey stripe where all the weather happens',
    'everything worth anything lives in the twilight band',
    'the day here does not end, it simply never began on the far side',
    'the shadow is a fixed address, and so is the glare',
  ],
  giant: [
    'the bands turn against each other at speeds that do not translate into anything useful',
    'there is no ground here to disappoint you',
    'storms outlive the crews that name them',
    'the pressure gradient will take a hull apart in layers, politely',
    'the only floor is the one your instruments invent',
  ],
  airless: [
    'no air, so no weather, so no excuses',
    'footprints will outlast the company that made the boots',
    'sound stops at the visor',
    'the sky is black at noon and stays that way',
    'the vacuum keeps everything exactly where it was left',
  ],
  crushing: [
    'the air is thick enough to lean on',
    'at datum the atmosphere sits on the hull like a verdict',
    'the pressure reading is a number most gauges round down out of politeness',
  ],
  thin: [
    'the atmosphere is a rumour, technically present',
    'there is just enough air to carry dust and not enough to carry sound',
    'the sky is the colour of a bruise going out',
  ],
  ocean: [
    'the sea goes all the way down and keeps its own records',
    'there is a tide, and something in it the sonar declines to explain',
    'the water is the wrong colour for water',
    'the horizon is unbroken in every direction, which gets to people',
  ],
  ringed: [
    'the rings throw a hard shadow across the equator twice a year',
    'the ring plane cuts the sky in half and keeps it that way',
    'ring shine makes the nightside bright enough to work in',
  ],
  moons: [
    'the moons cross each other all night, none of them in a hurry',
    'there is always something in the sky here, which some crews find comforting',
    'the tides answer to four different masters',
  ],
  heavy: [
    'gravity here charges rent',
    'everything falls faster than instinct expects, including people',
    'a full shift on the surface costs a week of standing up straight',
  ],
  light: [
    'you can jump higher here than is wise',
    'dust takes an hour to settle and never really commits',
    'nothing thrown ever quite lands where it was aimed',
  ],
  volcanic: [
    'the crust has not finished arguing with itself',
    'the vents keep a schedule nobody has managed to write down',
    'the ash falls warm and does not stop',
  ],
  toxic: [
    'the air reads as breathable to anyone in a hurry, and kills them',
    'the chemistry is interesting the way a loaded weapon is interesting',
    'the rain arrives with a pH the suits were not rated for',
  ],
  dead: [
    'if anything ever lived here it left no forwarding address',
    'the geology is the entire story and it is a short one',
    'nothing has happened here since the crust cooled, and nothing intends to',
    'the craters are the only paperwork this world has ever filed',
  ],
  living: [
    'it is green in places, which is rarer than it should be',
    'somebody could live here, which usually means somebody already tried',
    'there is chlorophyll in the spectrum and no explanation for it',
  ],
  desert: [
    'the dunes move faster than the charts do',
    'the wind has been sanding this place down for longer than there have been charts',
  ],
  ice: [
    'the whole crust is water that gave up',
    'there are fractures here wide enough to lose a convoy in',
  ],
};

const SYSTEM_TRAIT: Readonly<Record<string, readonly string[]>> = {
  binary: [
    'two stars share the sky and neither shares a schedule',
    'the shadows here have shadows, and both of them move',
    'noon happens twice and neither one is convincing',
  ],
  remnant: [
    'the primary burned out before anyone got here and is still bright enough to read by',
    'what is left of the star fits inside its own former atmosphere',
  ],
  pulsar: [
    'the pulsar keeps better time than anything aboard, and cares less',
    'the beam sweeps through every few seconds and takes the instruments with it',
  ],
  hole: [
    'the primary is a hole with a bill attached, and the approach lanes are advisory',
    'light arrives here and does not leave, which is the entire local industry',
  ],
  hot: [
    'the primary is blue, violent, and not long for this arrangement',
    'the star will not last long enough for anything here to evolve an opinion',
  ],
  cool: [
    'the red dwarf gives out light like it is being charged for it',
    'the star is small, old, and in no danger of doing anything interesting',
  ],
  belt: [
    'the belt is picked over, but not evenly',
    'the rubble between the third and fourth orbits has been mined by three separate optimists',
  ],
  crowded: [
    'too many bodies orbit here and none of them agree on a plane',
    'the ephemeris for this system runs to four pages and is wrong on two of them',
  ],
  sparse: [
    'one star, one rock, and a great deal of nothing between them',
    'the system is mostly distance with a few interruptions',
  ],
  settled: [
    'there is traffic here, and traffic means somebody is selling something',
    'the lanes are marked, which means somebody once cared enough to mark them',
    'you can buy fuel here, at a price arrived at by long negotiation with nobody',
  ],
  empty: [
    'no beacons, no lanes, no reason for anyone to have been here',
    'the transponder listens for company and gets weather',
  ],
};

const GALAXY_TRAIT: Readonly<Record<string, readonly string[]>> = {
  spiral: [
    'the arms wind tight and the dust lanes hide most of what matters',
    'the spiral pattern is a traffic jam that has been going on for a hundred million years',
  ],
  barred: [
    'a bar of old suns runs through the middle like a scar somebody is proud of',
    'the bar funnels gas to the core at a rate the core has never once refused',
  ],
  elliptical: [
    'no arms, no dust, nothing young, and a great deal of old light going nowhere',
    'every star here is a survivor of something the records no longer name',
  ],
  irregular: [
    'it never settled into a shape and has stopped trying',
    'something large passed close once and the geometry has been an argument ever since',
  ],
  ring: [
    'the core burned itself hollow and left a bright ring around the debt',
    'the centre is empty and the edge is on fire, which is a familiar arrangement',
  ],
  nebular: [
    'the emission clouds make navigation a matter of opinion',
    'there is more gas here than sky, and it is all lit from inside',
  ],
  vast: [
    'a signal crossing it would arrive as history rather than news',
    'the far rim has never been charted by anyone who came back to file it',
  ],
  small: [
    'it is small enough that the same three surveys keep meeting each other',
    'the whole disc would fit inside the halo of a serious galaxy',
  ],
};

/** Institutional voice — the chart talking about itself. */
const VERDICT: readonly string[] = [
  'the survey lists it as unremarkable',
  'no claim has been filed, which is its own kind of review',
  'the registry entry is three lines long and two of them are coordinates',
  'the catalogue gives it a number and no adjective',
  'it was charted once, by somebody in a hurry',
  'the assay came back inconclusive and nobody paid for a second one',
  'the tariff schedule has no column for whatever this is',
  'it has been surveyed twice and visited once',
  'the last filing on it was a request for an extension',
  'the bond on it lapsed forty years ago',
  'the classification was assigned by an office that has since been dissolved',
  'two agencies claim jurisdiction and neither has sent anyone',
  'the entry carries a hazard flag with no attached explanation',
  'it appears on the older charts under a different name and no one remembers why',
];

/** Human voice — evidence that people came and mostly left. */
const HUMAN: readonly string[] = [
  'two crews took the contract and one filed a report',
  'a prospector left a beacon here and never came back for it',
  'somebody painted a number on a rock face and then thought better of it',
  'there is a wreck in the northern basin with its lights still on',
  'the only structure is a relay mast, and it is transmitting',
  'an old refuelling rig sits in the shadow of the ridge, still under lease',
  'the last ship logged here filed an arrival and no departure',
  'a survey team wintered over once and did not renew',
  'there is graffiti on the landing pad older than the pad',
  'somebody is still paying the mooring fees',
];

/** Short closers. Written to sit after a comma, a dash or a semicolon. */
const KICKER: readonly string[] = [
  'make of that what you like',
  'the instruments do not have an opinion',
  'you will want the lamps on',
  'nobody writes songs about it',
  'it is not the worst place to be owed money',
  'that is the whole of it',
  'file it and move on',
  'the log has room for one line and this is it',
  'the scanner is confident, which proves nothing',
  'there is no second opinion available out here',
];

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * One sentence of codex flavour, conditioned on whatever facts the caller has.
 *
 * Recognised keys are matched leniently (several aliases each) so the system
 * and galaxy generators can pass their own vocabulary without coordination:
 *   planet : type, temperature, gravity, radius, pressure, tidallyLocked,
 *            moons, rings, ocean, interest
 *   system : stars, spectralClass, planets, civilisation, belt
 *   galaxy : shape, stars, nebulae, radiusLy
 *
 * With no facts at all it still returns a usable sentence from the generic
 * banks — a missing fact must never produce an empty codex entry.
 */
export function blurb(
  seed: number,
  kind: 'galaxy' | 'system' | 'planet',
  facts: Record<string, string | number>,
): string {
  const rng = rngFrom(seed, `blurb:${kind}`);
  const pools = traitPools(kind, facts);

  // Primary clause comes from a trait pool when we have one; otherwise the
  // institutional voice carries the sentence.
  const a = pools.length > 0 ? rng.pick(rng.pick(pools)) : rng.pick(VERDICT);

  // Second clause is drawn from a *different* voice than the first, which is
  // what stops two facts about temperature ending up in the same sentence.
  const secondary: readonly string[] =
    pools.length > 1 && rng.chance(0.42)
      ? pickOther(rng, pools, a)
      // Near-even split, tilted to VERDICT: the institutional voice is the
      // chart's own, so it can follow any clause, whereas a HUMAN clause
      // asserts that somebody came here and occasionally contradicts an
      // 'empty' or 'dead' trait sitting in the first half of the sentence.
      : rng.weighted([VERDICT, HUMAN], [55, 45]);
  let b = rng.pick(secondary);
  // Never the same clause twice, and never two relative clauses in one
  // sentence: several bank entries carry their own "which ..." tail, and
  // stacking two of them is the seam a reader notices first.
  if (b === a || (b.includes('which') && a.includes('which'))) b = rng.pick(VERDICT);

  const v = rng.pick(VERDICT);
  const k = rng.pick(KICKER);

  // Twelve structures, not twelve vocabularies. Structural variety is what
  // keeps a codex readable after the fortieth entry.
  let form = rng.int(0, 11);
  // Several clauses already carry their own relative clause; stacking the
  // "which the catalogue does not mention" tail onto one gives two `which`es
  // in a sentence, which is the exact seam a reader notices.
  if (form === 9 && a.includes('which')) form = 1;
  switch (form) {
    case 0:
      return `${cap(a)}, and ${b}.`;
    case 1:
      return `${cap(a)} — ${b}.`;
    case 2:
      return `${cap(a)}; ${b}.`;
    case 3:
      return `${cap(a)}, though ${b}.`;
    case 4:
      return `${cap(a)}, and ${k}.`;
    case 5:
      return `Officially, ${v} — unofficially, ${a}.`;
    case 6:
      return `Say this for it: ${a}.`;
    case 7:
      return `For the record, ${v}, and ${a}.`;
    case 8:
      return `Two things are true here: ${a}, and ${b}.`;
    case 9:
      return `${cap(a)}, which the catalogue does not mention.`;
    case 10:
      return `${cap(b)}, and ${a}.`;
    default:
      return `${cap(a)} — ${k}.`;
  }
}

/** Pick from a pool other than the one that produced `used`. */
function pickOther(rng: Rng, pools: readonly (readonly string[])[], used: string): readonly string[] {
  // At most four attempts. A body rarely qualifies for more than three or four
  // trait pools, so the odds of missing every time are small, and VERDICT is a
  // correct answer rather than a fallback — it is simply a different voice.
  for (let tries = 0; tries < 4; tries++) {
    const p = rng.pick(pools);
    if (!p.includes(used)) return p;
  }
  return VERDICT;
}

function traitPools(
  kind: 'galaxy' | 'system' | 'planet',
  f: Facts,
): readonly (readonly string[])[] {
  const out: (readonly string[])[] = [];
  const push = (bank: Readonly<Record<string, readonly string[]>>, key: string): void => {
    const p = bank[key];
    if (p !== undefined) out.push(p);
  };

  if (kind === 'planet') {
    const type = fstr(f, 'type', 'planetType', 'class', 'kind');
    const t = fnum(f, 'temperature', 'temp', 'tempK', 'meanTemperature');
    const g = fnum(f, 'gravity', 'g', 'surfaceGravity');
    const p = fnum(f, 'pressure', 'atmPressure', 'bar', 'surfacePressure');
    const moons = fnum(f, 'moons', 'moonCount', 'satellites');

    if (t !== null) {
      // Every threshold is a real transition, in kelvin:
      //   900  silicate rock begins to glow visibly (the 'scorched' clause
      //        talks about a nightside you can see, so it needs the glow point)
      //   400  above water's 373 K boiling point at 1 bar — no open water
      //   320  ~47 C, the top of what a person survives in a suit's margin
      //   250  ~-23 C, cold but inside the range where ice and liquid coexist
      //   180  below CO2's 195 K frost point: the atmosphere itself snows out,
      //        which is what the 'cold' clauses describe
      if (t > 900) push(TRAIT, 'scorched');
      if (t > 400) push(TRAIT, 'hot');
      else if (t < 180) push(TRAIT, 'cold');
      else if (t >= 250 && t <= 320) push(TRAIT, 'temperate');
    }
    if (fbool(f, 'tidallyLocked', 'tidalLock', 'locked', 'synchronous')) push(TRAIT, 'tidal');
    if (type === 'gas-giant' || type === 'ice-giant') push(TRAIT, 'giant');
    if (type === 'volcanic') push(TRAIT, 'volcanic');
    if (type === 'toxic') push(TRAIT, 'toxic');
    if (type === 'ice') push(TRAIT, 'ice');
    if (type === 'desert') push(TRAIT, 'desert');
    if (type === 'terran') push(TRAIT, 'living');
    if (type === 'barren' || type === 'rocky') push(TRAIT, 'dead');
    if (type === 'ocean' || fbool(f, 'ocean', 'hasOcean', 'water')) push(TRAIT, 'ocean');
    if (fbool(f, 'rings', 'hasRings', 'ringed')) push(TRAIT, 'ringed');
    // Three is where the sky stops having "a moon" and starts having traffic —
    // the clauses in this bank are all about several objects at once.
    if (moons !== null && moons >= 3) push(TRAIT, 'moons');
    if (p !== null) {
      // Bar, at datum. 1e-3 bar is roughly Mars' surface pressure, the point
      // below which there is no weather to describe; 0.3 bar is the Armstrong
      // limit region where a suit is mandatory rather than advisable; 5 bar is
      // where a pressure hull, not a pressure suit, becomes the requirement.
      if (p <= 0.001) push(TRAIT, 'airless');
      else if (p > 5) push(TRAIT, 'crushing');
      else if (p < 0.3) push(TRAIT, 'thin');
    }
    if (g !== null) {
      // 1 g = 9.81 m/s². Below ~4 the gait changes; above ~15 the spine does.
      if (g > 15) push(TRAIT, 'heavy');
      else if (g > 0 && g < 4) push(TRAIT, 'light');
    }
    return out;
  }

  if (kind === 'system') {
    const cls = fstr(f, 'spectralClass', 'class', 'primaryClass', 'starClass').toUpperCase();
    const stars = fnum(f, 'stars', 'starCount', 'companions');
    const planets = fnum(f, 'planets', 'planetCount', 'bodies');
    const civ = fnum(f, 'civilisation', 'civilization', 'civ', 'traffic');

    if (stars !== null && stars >= 2) push(SYSTEM_TRAIT, 'binary');
    if (cls === 'WD') push(SYSTEM_TRAIT, 'remnant');
    if (cls === 'NS') push(SYSTEM_TRAIT, 'pulsar');
    if (cls === 'BH') push(SYSTEM_TRAIT, 'hole');
    if (cls === 'O' || cls === 'B' || cls === 'A') push(SYSTEM_TRAIT, 'hot');
    if (cls === 'K' || cls === 'M') push(SYSTEM_TRAIT, 'cool');
    if (fbool(f, 'belt', 'hasAsteroidBelt', 'asteroids')) push(SYSTEM_TRAIT, 'belt');
    if (planets !== null) {
      // Sol has eight; seven is therefore "as busy as home or busier", and two
      // or fewer is a system whose ephemeris fits on one line.
      if (planets >= 7) push(SYSTEM_TRAIT, 'crowded');
      else if (planets <= 2) push(SYSTEM_TRAIT, 'sparse');
    }
    if (civ !== null) {
      // `civilisation` is 0..1 in StarSystemSpec. The cuts are set well away
      // from the middle on purpose: a system has to be clearly inhabited or
      // clearly abandoned before the codex commits to saying so, otherwise
      // every entry claims traffic and the word stops meaning anything.
      if (civ > 0.45) push(SYSTEM_TRAIT, 'settled');
      else if (civ < 0.08) push(SYSTEM_TRAIT, 'empty');
    }
    return out;
  }

  const shape = fstr(f, 'shape', 'type', 'morphology');
  const radius = fnum(f, 'radiusLy', 'radius', 'diameterLy');
  const nebulae = fnum(f, 'nebulae', 'nebulaCount');

  if (shape.includes('barred')) push(GALAXY_TRAIT, 'barred');
  else if (shape.includes('spiral')) push(GALAXY_TRAIT, 'spiral');
  if (shape.includes('elliptical')) push(GALAXY_TRAIT, 'elliptical');
  if (shape.includes('irregular')) push(GALAXY_TRAIT, 'irregular');
  if (shape.includes('ring')) push(GALAXY_TRAIT, 'ring');
  // Five is where the nebulae stop being landmarks and start being terrain —
  // the 'nebular' clauses are about navigation, which needs more than a few.
  if (nebulae !== null && nebulae >= 5) push(GALAXY_TRAIT, 'nebular');
  if (radius !== null) {
    // Light years. The Milky Way disc is ~50,000 ly in radius, so 60,000 is
    // "larger than the only galaxy anyone has a feel for". 15,000 is roughly
    // the Large Magellanic Cloud, the standard example of a satellite galaxy
    // small enough that its far side is not a separate world.
    if (radius > 60000) push(GALAXY_TRAIT, 'vast');
    else if (radius < 15000) push(GALAXY_TRAIT, 'small');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Self-test helper
// ---------------------------------------------------------------------------

/**
 * A representative slice of the naming space, used by the verification phase
 * to eyeball register spread and to assert that a seed reproduces exactly.
 * Cycles through every naming function so a regression in any one of them
 * shows up in the sample.
 */
export function sampleNames(seed: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const s = hashSeed(seed, `sample:${i}`);
    switch (i % 6) {
      case 0:
        out.push(galaxyName(s));
        break;
      case 1:
        out.push(systemName(s));
        break;
      case 2:
      case 3: {
        const sys = systemName(s);
        out.push(`${sys} > ${planetName(s, sys, i % 5)}`);
        break;
      }
      case 4: {
        const sys = systemName(s);
        const pl = planetName(s, sys, 2);
        out.push(`${pl} > ${moonName(s, pl, i % 3)}`);
        break;
      }
      default:
        out.push(nebulaName(s));
        break;
    }
  }
  return out;
}
