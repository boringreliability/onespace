/**
 * v4 sub-plan 5, Task 4 — the HUD's action block, as rows. Pure seam
 * (src/ui/actionRows.ts): `actionRow(kind, state)` turns what Mining.status
 * hands out into what one row prints: label, key, tone, text and bar fill.
 *
 * Rows may be new objects per call (it runs 3x a frame); identity is not tested.
 */

import { describe, expect, it } from 'vitest';

import { MINING_KEYS } from '@/core/Input';
import type { ActionState, MiningKind } from '@/game/Mining';
import { ACTION_HINT, REFUSAL_LOG, formatKg, type MiningRefusal } from '@/game/miningRules';
import { CARGO_CAPACITY_KG } from '@/ship/cargo';
import { actionRow, actionRows, speedTone, type ActionRow } from './actionRows';

type Blocked = Extract<ActionState, { kind: 'blocked' }>;
type BlockedReason = Blocked['reason'];

const KINDS: readonly MiningKind[] = ['mine', 'refine', 'repair'];

const ready: ActionState = { kind: 'ready', progress: 0, shownKg: 0, leftS: 0, resource: null };

function blocked(reason: BlockedReason): ActionState {
  return { kind: 'blocked', reason, progress: 0, shownKg: 0, leftS: 0, resource: null };
}

function mining(shownKg: number, resource: ActionState['resource'], progress = 0.5): ActionState {
  return { kind: 'running', progress, shownKg, leftS: 0, resource };
}

function timed(leftS: number, progress = 0.5): ActionState {
  return { kind: 'running', progress, shownKg: 0, leftS, resource: null };
}

/** The reasons whose row text differs from the log line. */
const ROW_TEXT: Readonly<Partial<Record<BlockedReason, string>>> = {
  range: 'OUT OF RANGE — L TO APPROACH',
  speed: 'MATCH SPEED — SPACE TO STOP',
  cruise: 'IN CRUISE',
  jump: 'IN JUMP',
  insufficient: 'NEED METAL · SILICATE',
};

const LOG_REASONS = Object.keys(REFUSAL_LOG) as MiningRefusal[];
const ALL_REASONS: readonly BlockedReason[] = [...LOG_REASONS, 'cruise', 'jump'];

describe('actionRow — label and key', () => {
  it('Given each kind, Then the label is MINE / REFINE / REPAIR', () => {
    expect(actionRow('mine', ready).label).toBe('MINE');
    expect(actionRow('refine', ready).label).toBe('REFINE');
    expect(actionRow('repair', ready).label).toBe('REPAIR');
  });

  it('Given each kind, Then the key is MINING_KEYS without the Key prefix (B, U, N)', () => {
    for (const k of KINDS) expect(actionRow(k, ready).key).toBe(MINING_KEYS[k].replace(/^Key/, ''));
    expect(actionRow('mine', ready).key).toBe('B');
    expect(actionRow('refine', ready).key).toBe('U');
    expect(actionRow('repair', ready).key).toBe('N');
  });

  it('Given any state, Then label and key do not change with it', () => {
    const states: ActionState[] = [ready, blocked('range'), mining(10, 'ice'), timed(3)];
    for (const k of KINDS) {
      const base = actionRow(k, ready);
      for (const s of states) {
        expect(actionRow(k, s).label).toBe(base.label);
        expect(actionRow(k, s).key).toBe(base.key);
      }
    }
  });
});

describe('actionRow — ready', () => {
  it('Given a ready action, Then "▸ READY", tone ready, no bar', () => {
    for (const k of KINDS) {
      const r = actionRow(k, ready);
      expect(r.text).toBe('▸ READY');
      expect(r.tone).toBe('ready');
      expect(r.fill).toBeNull();
    }
  });
});

describe('actionRow — blocked', () => {
  it('Given range, Then "OUT OF RANGE — L TO APPROACH", built from REFUSAL_LOG and ACTION_HINT', () => {
    const r = actionRow('mine', blocked('range'));
    expect(r.text).toBe('OUT OF RANGE — L TO APPROACH');
    expect(r.text).toBe(`${REFUSAL_LOG.range} — ${ACTION_HINT.range}`);
  });

  it('Given speed, Then "MATCH SPEED — SPACE TO STOP", built from REFUSAL_LOG and ACTION_HINT', () => {
    const r = actionRow('mine', blocked('speed'));
    expect(r.text).toBe('MATCH SPEED — SPACE TO STOP');
    expect(r.text).toBe(`${REFUSAL_LOG.speed} — ${ACTION_HINT.speed}`);
  });

  it('Given cruise, Then "IN CRUISE"', () => {
    expect(actionRow('refine', blocked('cruise')).text).toBe('IN CRUISE');
  });

  it('Given jump, Then "IN JUMP"', () => {
    expect(actionRow('refine', blocked('jump')).text).toBe('IN JUMP');
  });

  it('Given busy, Then "BUSY" (only another action running, not cruise or jump)', () => {
    expect(actionRow('mine', blocked('busy')).text).toBe('BUSY');
  });

  it('Given insufficient, Then the shortened "NEED METAL · SILICATE" (not the log line)', () => {
    const r = actionRow('repair', blocked('insufficient'));
    expect(r.text).toBe('NEED METAL · SILICATE');
    expect(r.text).not.toBe(REFUSAL_LOG.insufficient);
  });

  it('Given every other refusal in REFUSAL_LOG, Then exactly its log text', () => {
    for (const reason of LOG_REASONS) {
      if (ROW_TEXT[reason] !== undefined) continue;
      expect(actionRow('mine', blocked(reason)).text, reason).toBe(REFUSAL_LOG[reason]);
    }
  });

  it('Given every reason (REFUSAL_LOG keys, cruise, jump), Then tone blocked, no bar, and the text is the same for every kind', () => {
    for (const reason of ALL_REASONS) {
      const expected = ROW_TEXT[reason] ?? REFUSAL_LOG[reason as MiningRefusal];
      for (const k of KINDS) {
        const r = actionRow(k, blocked(reason));
        expect(r.tone, `${k}/${reason}`).toBe('blocked');
        expect(r.fill, `${k}/${reason}`).toBeNull();
        expect(r.text, `${k}/${reason}`).toBe(expected);
      }
    }
  });

  it('Given a reason with no hint, Then no " — " is appended', () => {
    for (const reason of LOG_REASONS) {
      if (ACTION_HINT[reason] !== undefined) continue;
      expect(actionRow('mine', blocked(reason)).text, reason).not.toContain(' — ');
    }
  });
});

describe('actionRow — running mine', () => {
  it('Given 1240 kg of ice, Then "ICE 1 240 KG", tone running, fill = progress', () => {
    const r = actionRow('mine', mining(1240, 'ice', 0.62));
    expect(r.text).toBe('ICE 1 240 KG');
    expect(r.tone).toBe('running');
    expect(r.fill).toBe(0.62);
  });

  it('Given each resource, Then its name in capitals leads the text', () => {
    expect(actionRow('mine', mining(300, 'rare')).text).toBe('RARE 300 KG');
    expect(actionRow('mine', mining(300, 'metal')).text).toBe('METAL 300 KG');
    expect(actionRow('mine', mining(300, 'silicate')).text).toBe('SILICATE 300 KG');
  });

  it('Given shownKg 0 (the first frame), Then "ICE 0 KG"', () => {
    expect(actionRow('mine', mining(0, 'ice')).text).toBe('ICE 0 KG');
  });

  it('Given a fractional shownKg, Then formatKg decides the rounding', () => {
    expect(actionRow('mine', mining(1240.6, 'ice')).text).toBe(`ICE ${formatKg(1240.6)} KG`);
    expect(actionRow('mine', mining(1240.6, 'ice')).text).toBe('ICE 1 241 KG');
    expect(actionRow('mine', mining(1240.4, 'ice')).text).toBe('ICE 1 240 KG');
  });
});

describe('actionRow — running refine and repair', () => {
  it('Given 4.2 s left, Then "5 S" (rounded up)', () => {
    expect(actionRow('refine', timed(4.2)).text).toBe('5 S');
    expect(actionRow('repair', timed(4.2)).text).toBe('5 S');
  });

  it('Given 0.01 s left, Then "1 S" (a running action never shows 0)', () => {
    expect(actionRow('refine', timed(0.01)).text).toBe('1 S');
  });

  it('Given exactly 8 s left, Then "8 S"', () => {
    expect(actionRow('refine', timed(8)).text).toBe('8 S');
  });

  it('Given 10 s left (a fresh repair), Then "10 S"', () => {
    expect(actionRow('repair', timed(10)).text).toBe('10 S');
  });

  it('Given 0 s left, Then "0 S"', () => {
    expect(actionRow('repair', timed(0)).text).toBe('0 S');
  });

  it('Given a running refine, Then tone running and fill = progress', () => {
    const r = actionRow('refine', timed(4.2, 0.475));
    expect(r.tone).toBe('running');
    expect(r.fill).toBe(0.475);
  });
});

describe('actionRow — fill is clamped to 0..1', () => {
  it('Given progress 1.2, Then 1', () => {
    expect(actionRow('mine', mining(10, 'ice', 1.2)).fill).toBe(1);
    expect(actionRow('refine', timed(1, 1.2)).fill).toBe(1);
  });

  it('Given progress -0.1, Then 0', () => {
    expect(actionRow('mine', mining(10, 'ice', -0.1)).fill).toBe(0);
    expect(actionRow('repair', timed(1, -0.1)).fill).toBe(0);
  });

  it('Given progress NaN, Then 0', () => {
    expect(actionRow('mine', mining(10, 'ice', Number.NaN)).fill).toBe(0);
    expect(actionRow('refine', timed(1, Number.NaN)).fill).toBe(0);
  });

  it('Given the edges 0 and 1, Then they pass through unchanged', () => {
    expect(actionRow('mine', mining(10, 'ice', 0)).fill).toBe(0);
    expect(actionRow('mine', mining(10, 'ice', 1)).fill).toBe(1);
  });
});

describe('actionRow — width', () => {
  it('Given every state above, Then the longest text is 28 characters (the block fits the panel at 700 px high)', () => {
    const texts: string[] = [];
    for (const k of KINDS) {
      for (const reason of ALL_REASONS) texts.push(actionRow(k, blocked(reason)).text);
      texts.push(actionRow(k, ready).text);
      for (const res of ['ice', 'rare', 'metal', 'silicate'] as const) {
        texts.push(actionRow(k, mining(CARGO_CAPACITY_KG, res)).text);
        texts.push(actionRow(k, mining(0, res)).text);
      }
      for (const left of [0, 0.01, 4.2, 8, 10]) texts.push(actionRow(k, timed(left)).text);
    }
    const longest = Math.max(...texts.map((t) => t.length));
    expect(longest).toBe(28);
    expect(texts.filter((t) => t.length === longest)).toEqual(['OUT OF RANGE — L TO APPROACH', 'OUT OF RANGE — L TO APPROACH', 'OUT OF RANGE — L TO APPROACH']);
  });
});

// The HUD's DOM has no unit tests (vitest runs in node, no DOM): what feeds it
// is kept pure and tested here; the look is checked on screenshots at 1280×700.
describe('actionRows — the three rows the HUD is handed each frame', () => {
  it('Given a status source, Then the rows are mine, refine, repair in that order, each built by actionRow', () => {
    const states: Record<MiningKind, ActionState> = { mine: mining(1240, 'ice', 0.4), refine: blocked('nothing-to-refine'), repair: ready };
    const asked: MiningKind[] = [];
    const rows = actionRows((k) => {
      asked.push(k);
      return states[k];
    }, 'ice');
    expect(asked).toEqual(['mine', 'refine', 'repair']);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.label)).toEqual(['MINE', 'REFINE', 'REPAIR']);
    for (let i = 0; i < 3; i++) expect(rows[i]).toEqual(actionRow(KINDS[i]!, states[KINDS[i]!]));
  });
});

describe('speedTone — VEL says when the ship is slow enough to mine', () => {
  it('Given a rock targeted and speed within the limit, Then "ok"', () => {
    expect(speedTone(true)).toBe('ok');
  });

  it('Given a rock targeted and too much speed, Then "normal"', () => {
    expect(speedTone(false)).toBe('normal');
  });

  it('Given no rock targeted (null), Then "normal"', () => {
    expect(speedTone(null)).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// v4 sub-plan 6, Task 2 (phase A) — the MINE row shows the beam's choice.
//
// DESIGN-6 §7.2: at rest the MINE row says `▸ READY · <RESOURCE>` (the choice
// is visible without opening the screen); blocked rows say their reason as
// today; 'not-here' says `NO <RESOURCE> HERE`. No row may get wider than the
// longest text the rows can show today.
// Assumed API (not there yet, read through a cast): actionRows(status, beam).
// ---------------------------------------------------------------------------

type Beam = 'ice' | 'rare' | 'metal' | 'silicate';
type RowsWithBeam = (status: (kind: MiningKind) => ActionState, beam: Beam) => readonly [ActionRow, ActionRow, ActionRow];
const rowsWithBeam = actionRows as unknown as RowsWithBeam;
const BEAMS: readonly Beam[] = ['ice', 'rare', 'metal', 'silicate'];
const BEAM_NAME: Readonly<Record<Beam, string>> = { ice: 'ICE', rare: 'RARE', metal: 'METAL', silicate: 'SILICATE' };

/** Every state ready. */
const allReady = (): ActionState => ready;
/** MINE blocked for `reason`, the others ready. */
const mineBlocked =
  (reason: string) =>
  (k: MiningKind): ActionState =>
    k === 'mine' ? blocked(reason as BlockedReason) : ready;

/** Today's reasons: REFUSAL_LOG's keys and cruise/jump, without the new one. */
const TODAY_REASONS: readonly BlockedReason[] = ALL_REASONS.filter((r) => (r as string) !== 'not-here');

describe('actionRows(status, beam) — the MINE row at rest shows the choice (plan 6 task 2)', () => {
  it('Given MINE ready and the beam on ice, Then the MINE row says "▸ READY · ICE", tone ready, no bar', () => {
    const [mine] = rowsWithBeam(allReady, 'ice');
    expect(mine.text).toBe('▸ READY · ICE');
    expect(mine.tone).toBe('ready');
    expect(mine.fill).toBeNull();
  });

  it('Given MINE ready and each beam, Then "▸ READY · <RESOURCE>" (rare → "▸ READY · RARE")', () => {
    for (const b of BEAMS) expect(rowsWithBeam(allReady, b)[0].text, b).toBe(`▸ READY · ${BEAM_NAME[b]}`);
    expect(rowsWithBeam(allReady, 'rare')[0].text).toBe('▸ READY · RARE');
  });

  it('Given REFINE and REPAIR ready, Then they still say "▸ READY" whatever the beam', () => {
    for (const b of BEAMS) {
      const rows = rowsWithBeam(allReady, b);
      expect(rows[1].text, b).toBe('▸ READY');
      expect(rows[2].text, b).toBe('▸ READY');
    }
  });

  it('Given the same ready status on two frames and the beam changed between them, Then the MINE row\'s text follows the beam (the reused row is rebuilt)', () => {
    expect(rowsWithBeam(allReady, 'ice')[0].text).toBe('▸ READY · ICE');
    expect(rowsWithBeam(allReady, 'metal')[0].text).toBe('▸ READY · METAL');
    expect(rowsWithBeam(allReady, 'metal')[0].text).toBe('▸ READY · METAL');
    expect(rowsWithBeam(allReady, 'ice')[0].text).toBe('▸ READY · ICE');
  });
});

describe('actionRows(status, beam) — not-here and the other blocked rows (plan 6 task 2)', () => {
  it('Given MINE blocked \'not-here\' and the beam on rare, Then "NO RARE HERE", tone blocked, no bar', () => {
    const [mine] = rowsWithBeam(mineBlocked('not-here'), 'rare');
    expect(mine.text).toBe('NO RARE HERE');
    expect(mine.tone).toBe('blocked');
    expect(mine.fill).toBeNull();
  });

  it('Given MINE blocked \'not-here\', Then the text names the beam\'s resource, and follows it when the beam changes', () => {
    for (const b of BEAMS) expect(rowsWithBeam(mineBlocked('not-here'), b)[0].text, b).toBe(`NO ${BEAM_NAME[b]} HERE`);
    expect(rowsWithBeam(mineBlocked('not-here'), 'ice')[0].text).toBe('NO ICE HERE');
    expect(rowsWithBeam(mineBlocked('not-here'), 'silicate')[0].text).toBe('NO SILICATE HERE');
  });

  it('Given every reason of today, Then the MINE row says exactly what actionRow says today, whatever the beam (blocked rows are unchanged)', () => {
    for (const reason of TODAY_REASONS) {
      const today = actionRow('mine', blocked(reason)).text;
      for (const b of BEAMS) expect(rowsWithBeam(mineBlocked(reason), b)[0].text, `${reason}/${b}`).toBe(today);
    }
  });

  it('Given an extraction of ice running and the beam moved to metal, Then the MINE row shows the running extraction ("ICE 1 240 KG"), not the choice', () => {
    const states = (k: MiningKind): ActionState => (k === 'mine' ? mining(1240, 'ice', 0.4) : ready);
    expect(rowsWithBeam(states, 'metal')[0].text).toBe('ICE 1 240 KG');
    expect(rowsWithBeam(states, 'metal')[0].tone).toBe('running');
  });
});

describe('actionRows(status, beam) — no row wider than today (plan 6 task 2, DESIGN-6 §7.2)', () => {
  /** The longest text the three rows can show today (as the width test above measures it). */
  function todayLongest(): string {
    const texts: string[] = [];
    for (const k of KINDS) {
      for (const reason of TODAY_REASONS) texts.push(actionRow(k, blocked(reason)).text);
      texts.push(actionRow(k, ready).text);
      for (const res of BEAMS) {
        texts.push(actionRow(k, mining(CARGO_CAPACITY_KG, res)).text);
        texts.push(actionRow(k, mining(0, res)).text);
      }
      for (const left of [0, 0.01, 4.2, 8, 10]) texts.push(actionRow(k, timed(left)).text);
    }
    return texts.reduce((a, b) => (b.length > a.length ? b : a), '');
  }

  it('Given today\'s rows, Then their longest text is a real one (the measure is not empty)', () => {
    expect(todayLongest().length).toBeGreaterThan(0);
  });

  it('Given each beam, Then "▸ READY · <RESOURCE>" and "NO <RESOURCE> HERE" are no longer, in characters, than today\'s longest row text', () => {
    const max = todayLongest().length;
    for (const b of BEAMS) {
      const readyText = rowsWithBeam(allReady, b)[0].text;
      const notHereText = rowsWithBeam(mineBlocked('not-here'), b)[0].text;
      expect(readyText, b).toBe(`▸ READY · ${BEAM_NAME[b]}`);
      expect(notHereText, b).toBe(`NO ${BEAM_NAME[b]} HERE`);
      expect(readyText.length, `${readyText} vs ${todayLongest()}`).toBeLessThanOrEqual(max);
      expect(notHereText.length, `${notHereText} vs ${todayLongest()}`).toBeLessThanOrEqual(max);
    }
  });

  it('Given every state with every beam, Then no row of the three is wider than today\'s longest', () => {
    const max = todayLongest().length;
    const states: Array<(k: MiningKind) => ActionState> = [allReady, mineBlocked('not-here')];
    for (const reason of TODAY_REASONS) states.push(() => blocked(reason));
    for (const res of BEAMS) states.push((k) => (k === 'mine' ? mining(CARGO_CAPACITY_KG, res) : timed(10)));
    for (const s of states) {
      for (const b of BEAMS) {
        for (const row of rowsWithBeam(s, b)) expect(row.text.length, row.text).toBeLessThanOrEqual(max);
      }
    }
  });
});
