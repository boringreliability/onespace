/**
 * Targeting rules — pure, so `Tab`, the chart and the bracket can be tested
 * without a camera, a bus or a universe.
 *
 * Shared contract with every other module: there is ONE current target. Its id
 * is `body:<spec.name>` for a planet or moon and the blueprint id for a vessel,
 * and it travels on the existing `target:changed` bus event.
 */

/** Plain 3-vector; `three`'s Vector3 satisfies it. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface TargetCandidate {
  readonly id: string;
  readonly name: string;
  /** Target position minus ship position, km. */
  readonly rel: Vec3Like;
}

/** A body as far as id resolution cares. */
export interface NamedBody {
  readonly id: string;
  readonly name: string;
}

const BODY_PREFIX = 'body:';

/**
 * Below this an ETA is noise: a co-orbiting body drifting at a few cm/s would
 * otherwise quote "ETA 41 days" and tick wildly as the sign flips. 1 m/s.
 */
export const ETA_MIN_CLOSING_KMS = 1e-3;

export function bodyTargetId(name: string): string {
  return BODY_PREFIX + name;
}

/**
 * Bring any id that might arrive on the bus into canonical form. The local
 * chart historically emitted the raw spec id; accepting it here means a stale
 * emitter still selects the right thing instead of silently selecting nothing.
 */
export function canonicalTargetId(raw: string | null, bodies: readonly NamedBody[]): string | null {
  if (raw === null) return null;
  if (raw.startsWith(BODY_PREFIX)) return raw;
  for (let i = 0; i < bodies.length; i++) {
    if (bodies[i]!.id === raw) return bodyTargetId(bodies[i]!.name);
  }
  return raw;
}

/** Angle between `rel` and the nose, radians; π for a zero-range candidate. */
function noseAngle(rel: Vec3Like, nose: Vec3Like): number {
  const len = Math.hypot(rel.x, rel.y, rel.z);
  if (len < 1e-9) return Math.PI;
  const nl = Math.hypot(nose.x, nose.y, nose.z) || 1;
  const c = (rel.x * nose.x + rel.y * nose.y + rel.z * nose.z) / (len * nl);
  return Math.acos(c < -1 ? -1 : c > 1 ? 1 : c);
}

/**
 * Candidates sorted by angle from the nose, nearest first; ties go to the
 * nearer candidate so the order never depends on input order. Returns a new
 * array — only ever called on a key press, never per frame.
 */
export function orderByNoseAngle<T extends TargetCandidate>(cands: readonly T[], nose: Vec3Like): T[] {
  const keyed = cands.map((c) => ({
    c,
    a: noseAngle(c.rel, nose),
    d: Math.hypot(c.rel.x, c.rel.y, c.rel.z),
  }));
  keyed.sort((p, q) => {
    // A zero-range candidate has no direction; it goes last whatever its angle.
    const pz = p.d < 1e-9 ? 1 : 0;
    const qz = q.d < 1e-9 ? 1 : 0;
    if (pz !== qz) return pz - qz;
    // Angles closer than ~0.06° are the same angle for a pilot.
    if (Math.abs(p.a - q.a) > 1e-3) return p.a - q.a;
    if (p.d !== q.d) return p.d - q.d;
    return p.c.id < q.c.id ? -1 : p.c.id > q.c.id ? 1 : 0;
  });
  return keyed.map((k) => k.c);
}

/** What `Tab` selects given the nose-ordered ids and the current target. */
export function nextTargetId(ordered: readonly string[], current: string | null): string | null {
  if (ordered.length === 0) return null;
  const i = current === null ? -1 : ordered.indexOf(current);
  if (i < 0) return ordered[0]!;
  return ordered[(i + 1) % ordered.length]!;
}

export function resolveTarget<T extends { readonly id: string }>(
  id: string | null,
  cands: readonly T[],
): T | null {
  if (id === null) return null;
  for (let i = 0; i < cands.length; i++) if (cands[i]!.id === id) return cands[i]!;
  return null;
}

/**
 * The single current target. `apply` and `validate` report whether the id
 * actually changed, so the module only announces real changes — which is also
 * what keeps it from answering its own `target:changed` echo forever.
 */
export class TargetSelection {
  private current: string | null = null;

  get id(): string | null {
    return this.current;
  }

  apply(raw: string | null, bodies: readonly NamedBody[]): boolean {
    const next = canonicalTargetId(raw, bodies);
    if (next === this.current) return false;
    this.current = next;
    return true;
  }

  /** Clear the target if it no longer exists among `liveIds`. */
  validate(liveIds: readonly string[]): boolean {
    if (this.current === null) return false;
    if (liveIds.indexOf(this.current) >= 0) return false;
    this.current = null;
    return true;
  }
}

/**
 * Rate at which the gap shrinks, km/s; positive = closing. `rel` is target −
 * ship and `relVel` its time derivative, so a shrinking gap has them opposed.
 */
export function closingSpeed(rel: Vec3Like, relVel: Vec3Like): number {
  const d = Math.hypot(rel.x, rel.y, rel.z);
  if (d < 1e-9) return 0;
  return -(rel.x * relVel.x + rel.y * relVel.y + rel.z * relVel.z) / d;
}

/** Straight-line ETA at the current closing speed, or null when not closing. */
export function etaSeconds(rangeKm: number, closingKmS: number): number | null {
  if (closingKmS < ETA_MIN_CLOSING_KMS) return null;
  return Math.max(0, rangeKm) / closingKmS;
}

/**
 * The target box's ETA (review-v3b): the straight-line one in sublight
 * flight; none under cruise, whose speed is not constant — the drive's own
 * readout (game/cruiseReadout.ts) owns the arrival time then.
 */
export function targetEtaSeconds(rangeKm: number, closingKmS: number, cruising: boolean): number | null {
  return cruising ? null : etaSeconds(rangeKm, closingKmS);
}

/** Range to a body's surface (radius > 0) or a vessel's centre (radius 0). */
export function targetRangeKm(centreKm: number, radiusKm: number): number {
  return Math.max(0, centreKm - radiusKm);
}
