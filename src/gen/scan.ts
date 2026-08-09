/**
 * The planet scanner readout.
 *
 * The ship scanner already existed for hulls (`shipScan` in ships/physics.ts);
 * worlds had none, which is why `scan:complete` was only ever emitted by a
 * showroom shot. This is the missing half.
 *
 * Everything here is derived from the spec the generator already produced.
 * Nothing is invented and nothing is random: the scanner is an instrument, and
 * an instrument that made things up would be the one place the player could
 * catch the universe lying. Where a label has to be chosen rather than
 * measured — "thin nitrogen haze" for a 0.3 bar envelope — the choice is a
 * deterministic function of the numbers, so two scans of the same world always
 * agree and a scan never contradicts what the atmosphere shader renders.
 */

import type { PlanetSpec, ScanResult } from './types';

/** The HUD allocates this many fixed rows. Every scan must fill all of them. */
export const SCAN_ROWS = 10;

/** Where the dot leader ends and the value begins. */
const VALUE_COLUMN = 17;

/**
 * Value width, in characters.
 *
 * Set by the instrument, not by taste: the HUD's scanner panel is 330px of
 * 9px monospace with 0.1em tracking, which is about 48 characters. At 46 the
 * rows ran to 63 and the readout clipped mid-word against the panel edge —
 * "NO AIR, SO NO WEATHER, SO NO EXCU". 30 keeps every row inside 47.
 */
const MAX_VALUE = 30;

/**
 * The label is lower case; the value is passed through untouched.
 *
 * An earlier version lower-cased the whole row, which is how the readout came
 * to say "266 k mean". Lower-case k is the kilo prefix; kelvin is K. The same
 * blanket call turned N2/O2 into n2/o2 and CH4 into ch4. Case is not styling
 * in a unit or a formula — it is the difference between one quantity and
 * another, and an instrument that gets it wrong is not being terse, it is
 * being wrong.
 */
function row(label: string, value: string): string {
  const dots = Math.max(1, VALUE_COLUMN - 2 - label.length);
  return `${label.toLowerCase()} ${'.'.repeat(dots)} ${fit(value)}`;
}

/**
 * Trim to the readout width at a word boundary.
 *
 * Cutting on the character count alone produced "under a differ…", which reads
 * as a broken widget rather than as an instrument that ran out of line. A
 * scanner is allowed to be terse; it is not allowed to look faulty.
 */
function fit(value: string): string {
  if (value.length <= MAX_VALUE) return value;
  const head = value.slice(0, MAX_VALUE - 1);
  const space = head.lastIndexOf(' ');
  // Only honour the word boundary if it is not so early that the row goes
  // nearly empty; a single very long token still gets a hard cut.
  const cut = space > MAX_VALUE * 0.6 ? head.slice(0, space) : head;
  return `${cut.replace(/[,;:\s]+$/, '')}…`;
}

/** 41820 → "41 820". A thin space, because a comma reads as a decimal point. */
function grouped(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function duration(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 60) return `${s.toFixed(0)} s`;
  if (s < 7200) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h > 0 ? `${h} h ${m} m` : `${m} m`;
  }
  const d = s / 86400;
  if (d < 2) return `${(s / 3600).toFixed(1)} h`;
  return `${d.toFixed(d < 100 ? 1 : 0)} d`;
}

const TYPE_NAME: Record<PlanetSpec['type'], string> = {
  rocky: 'rocky',
  ocean: 'ocean world',
  desert: 'desert',
  ice: 'ice',
  volcanic: 'volcanic',
  toxic: 'toxic',
  barren: 'barren',
  terran: 'terran',
  'gas-giant': 'gas giant',
  'ice-giant': 'ice giant',
};

/**
 * The composition label.
 *
 * Chosen from temperature and pressure rather than stored, because the
 * generator never decided a composition — it decided a scale height and a
 * Rayleigh coefficient, which is the same physics seen from the other side.
 * Molecular mass is what sets scale height, so reading the label back off
 * temperature and pressure keeps the two consistent by construction.
 */
function composition(p: PlanetSpec): string {
  const a = p.atmosphere;
  if (!a) return 'vacuum';
  if (p.type === 'gas-giant' || p.type === 'ice-giant') {
    return p.temperature < 120 ? 'H2 / He, CH4 traces' : 'H2 / He';
  }
  if (p.type === 'toxic') return 'CO2 / SO2, corrosive';
  if (p.type === 'volcanic') return 'SO2 / CO2, ash laden';
  if (p.type === 'terran' || p.type === 'ocean') return 'N2 / O2, water vapour';
  if (a.pressure < 0.05) return 'trace, unbreathable';
  if (p.temperature < 90) return 'N2 / CH4, condensing';
  return 'CO2 / N2, inert';
}

/**
 * The anomaly row.
 *
 * `interest` is the generator's own 0..1 judgement of whether this world is
 * worth landing on. Turning it into a sentence is the only place the scanner
 * editorialises, and it says nothing the descriptor did not already claim.
 */
function anomaly(p: PlanetSpec): string {
  if (p.interest > 0.85) return 'strong return, unresolved';
  if (p.interest > 0.65) return 'periodic, non-thermal';
  if (p.interest > 0.45) return 'albedo irregular';
  if (p.interest > 0.25) return 'magnetic field skewed';
  return 'nothing the array can hold';
}

/**
 * Every qualifier here is deliberately terse.
 *
 * The class row is a measurement, and a measurement must never be the thing
 * that gets truncated — "barren, satellite, tidally…" loses a fact, where a
 * clipped note only loses a clause. Four qualifiers at full length ran past
 * the panel, so the vocabulary is short rather than the sentence.
 */
function classLine(p: PlanetSpec): string {
  const parts = [TYPE_NAME[p.type]];
  if (p.isMoon) parts.push('moon');
  if (p.rings) parts.push('ringed');
  if (p.ocean) parts.push(p.ocean.emissive ? 'molten' : 'seas');
  if (Math.abs(p.rotationPeriod - p.orbit.period) < 1) parts.push('locked');
  return parts.join(', ');
}

/**
 * Ten rows about a world, in the instrument's voice.
 *
 * Pure: same spec in, same strings out, no clock and no RNG. That is what lets
 * the log store the result and redisplay it a hundred hours later without
 * having to keep the planet alive in memory.
 */
export function planetScan(p: PlanetSpec): ScanResult {
  const a = p.atmosphere;
  const lines: string[] = [
    row('class', classLine(p)),
    row('radius', `${grouped(p.radius)} km`),
    row('gravity', `${p.gravity.toFixed(1)} m/s²`),
    row('atmosphere', composition(p)),
    row(
      'pressure',
      a ? `${a.pressure < 0.01 ? a.pressure.toFixed(3) : a.pressure.toFixed(2)} bar at datum` : 'none',
    ),
    row('temperature', `${Math.round(p.temperature)} K mean`),
    row(
      'rotation',
      `${duration(p.rotationPeriod)}${p.rotationPeriod < 0 ? ' retrograde' : ''}`,
    ),
    row('moons', p.moons.length > 0 ? `${p.moons.length} catalogued` : 'none'),
    row('anomaly', anomaly(p)),
    // The one row that is prose rather than measurement. Lower-cased here
    // rather than in `row`, so the units and formulae above keep their case.
    row('note', p.blurb.toLowerCase()),
  ];
  return { targetId: p.id, name: p.name, lines, kind: 'world' };
}
