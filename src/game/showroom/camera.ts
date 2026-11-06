/**
 * The showroom's camera solver: a direction and a fraction of the frame in,
 * a placed camera out. Moved verbatim out of `Showroom.ts`; `swingToFace`
 * now takes the direction it swings as an argument instead of reaching for a
 * module-level scratch vector that lived beside the shot table.
 */

import { Vector3 } from 'three';

import type { EngineContext } from '@/core/Engine';
import type { ShowroomAim, Triple } from './Stage';

export interface CameraSpec {
  /** Direction from the subject to the camera, in world space. */
  readonly dir: Triple;
  readonly fovDeg: number;
  /** Fraction of the frame's shorter half-extent the subject fills. */
  readonly fill?: number;
  /** Instead of `fill`: put the subject at this many pixels across. */
  readonly targetPixels?: number;
  /** Where the ship's centre lands in NDC. Dead centre is a turntable render. */
  readonly offsetX?: number;
  readonly offsetY?: number;
  /** Roll about the view axis. Buys a diagonal without moving the camera. */
  readonly roll?: number;
  readonly aimAt?: ShowroomAim;
  /**
   * 0..1 — how far to swing the camera onto the outward normal of whatever the
   * aim picked, instead of trusting `dir` alone.
   *
   * Only meaningful for `aimAt: 'hardware'`, the one aim that chooses a point
   * on a SURFACE whose orientation is not known when the shot is authored. At 0
   * the authored direction stands (every hull and fleet frame). At 1 the camera
   * would look straight down the mounting normal, which kills the terminator;
   * the useful band is around 0.7, which lands roughly forty degrees off the
   * plate and keeps the raking key.
   */
  readonly faceAim?: number;
}

const _camDir = new Vector3();
const _target = new Vector3();
const _axisX = new Vector3();
const _axisY = new Vector3();
const _axisZ = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _rel = new Vector3();
const _worldUp = new Vector3(0, 1, 0);
const _noCorners: readonly Vector3[] = [];
const _faceDir = new Vector3();

/**
 * Swing `dir` (in place) from the shot's authored direction towards a surface's
 * outward normal, and report whether there was a normal to swing towards.
 *
 * `dir` must already hold the AUTHORED direction on the way in — the mix
 * is against that and never against a previously swung result, so calling this
 * twice does not compound.
 *
 * `amount` 0 leaves the authored direction alone; 1 would look straight down
 * the normal and flatten the terminator the shot was composed for. The
 * tangential half of the authored direction is kept at `1 - amount * 0.5` so
 * that even at the top of the range the lens still rakes.
 */
export function swingToFace(dir: Vector3, normal: Vector3, amount: number): boolean {
  if (normal.lengthSq() < 1e-9) return false;
  _faceDir.copy(normal).normalize().multiplyScalar(amount).addScaledVector(dir, 1 - amount * 0.5);
  if (_faceDir.lengthSq() < 1e-9) return false;
  dir.copy(_faceDir).normalize();
  return true;
}

/**
 * Place the camera from a direction and a fraction of the frame.
 *
 * Expressed this way rather than as a coordinate so that every shot is
 * scale-invariant: the same spec frames a 30 m courier and a 4 km capital
 * identically, which is exactly what ANALYSIS §6.7 says the hero rig in
 * `Ship.ts` failed to do.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIT IS A PROJECTED BOX AND NOT A BOUNDING SPHERE
 *
 * A sphere fit is a fit on the LONGEST axis, whichever way the camera is
 * looking. A ship is not a sphere: it is five to ten times longer than it is
 * wide, so the sphere the generator publishes is set by the hull's length, and
 * every view that is not broadside frames that length instead of the shape
 * actually on screen. The head-on silhouette — the frame BRIEF §8 asks the
 * critic to judge the cross-section from — came out 191 px wide in a 1920 px
 * frame at a declared fill of 0.8, because the fit was solving for a 131 m
 * sphere around a 14 m frontal shape. The three fleet frames were worse again:
 * the layout's radius was fitted against `min(halfV, halfH)`, so a wide
 * horizontal row of hulls was fitted to the frame's HEIGHT and lost the whole
 * aspect ratio, leaving 90 px hulls in a shot whose brief calls it the DNA
 * test.
 *
 * So the subject's box corners are projected into the camera's own screen
 * axes (after roll), the box is centred on screen, and the distance is solved
 * per corner — `d >= lateral / (fill * halfExtent) + depth` — with the largest
 * answer winning. The depth term is what makes it exact rather than
 * approximate: the near end of a hull pointed at the lens subtends more than
 * the far end, and a fit that ignores that clips the nose.
 *
 * `fill` therefore means: the subject spans `fill` of the half-extent of
 * WHICHEVER axis binds. Detail crops (`engine`, `hardware`, `scale`) have no
 * meaningful box and keep the sphere fit, which is correct for them — they are
 * framed on a radius around a point, not on a shape.
 */
export function placeCamera(
  ctx: EngineContext,
  spec: CameraSpec,
  /**
   * The direction from the subject to the camera, already normalised. Passed in
   * rather than read from `spec.dir` because a `faceAim` shot resolves its own
   * direction from the cluster the picker chose — and a solver that re-read the
   * authored direction here would silently discard that and frame the shot from
   * the provisional angle again.
   */
  viewDir: Vector3,
  radiusKm: number,
  aimPoint: Vector3,
  corners: readonly Vector3[],
  cornerCount: number,
  clearCorners: readonly Vector3[] = _noCorners,
  clearCount = 0,
  shotName = '',
): void {
  ctx.camera.fov = spec.fovDeg;
  ctx.camera.updateProjectionMatrix();
  // A shot is the last word on the camera's roll. `Rings`, `Clouds`,
  // `Atmosphere` and `Planet` all set `camera.up` to a plane normal or a
  // banked vector for their own frames, and the whole shot list runs in ONE
  // page load — so without this the showroom inherits whatever ran
  // immediately before it in the capture order. That is why a spec asking for
  // a dead-abeam profile (`dir` [1, 0, 0], no roll) produced a hull lying
  // several degrees off horizontal: `rings-grazing` had left the up-vector on
  // the ring plane.
  ctx.camera.up.set(0, 1, 0);

  const halfV = Math.tan((spec.fovDeg * Math.PI) / 360);
  const halfH = halfV * Math.max(ctx.camera.aspect, 1e-3);
  const fill = Math.max(spec.fill ?? 0.8, 1e-3);

  _camDir.copy(viewDir).normalize();

  // The screen basis is known before the distance is: only the camera's
  // POSITION along `_camDir` depends on it.
  _axisZ.copy(_camDir);
  _axisX.crossVectors(_worldUp, _axisZ);
  if (_axisX.lengthSq() < 1e-12) _axisX.set(1, 0, 0);
  _axisX.normalize();
  _axisY.crossVectors(_axisZ, _axisX).normalize();
  const roll = spec.roll ?? 0;
  if (roll !== 0) {
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    _right.copy(_axisX).multiplyScalar(cr).addScaledVector(_axisY, sr);
    _up.copy(_axisX).multiplyScalar(-sr).addScaledVector(_axisY, cr);
  } else {
    _right.copy(_axisX);
    _up.copy(_axisY);
  }

  // Projected half-extents about the box's own screen centre.
  let halfEx = 0;
  let halfEy = 0;
  if (cornerCount >= 2) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < cornerCount; i++) {
      _rel.copy(corners[i]!).sub(aimPoint);
      const x = _rel.dot(_right);
      const y = _rel.dot(_up);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // Recentre on the projected box, so `offsetX`/`offsetY` displace the
    // SHAPE and not the blueprint's local origin — which on a hull whose
    // engines hang off the aft plate is nowhere near the middle of it.
    aimPoint.addScaledVector(_right, (minX + maxX) * 0.5).addScaledVector(_up, (minY + maxY) * 0.5);
    halfEx = (maxX - minX) * 0.5;
    halfEy = (maxY - minY) * 0.5;
  }

  let distance: number;
  let solved = 0;
  let maxDepth = 0;
  let reach = 0;
  let guard = 0;
  if (spec.targetPixels !== undefined) {
    // A lateral offset e at distance d covers e * height / (d * halfV) pixels
    // on either screen axis — the aspect ratio cancels — so one scale serves.
    const e = cornerCount >= 2 ? Math.max(halfEx, halfEy) : radiusKm;
    distance = (e * ctx.height) / (halfV * Math.max(spec.targetPixels, 1));
  } else if (cornerCount >= 2) {
    maxDepth = -Infinity;
    for (let i = 0; i < cornerCount; i++) {
      _rel.copy(corners[i]!).sub(aimPoint);
      const ex = Math.abs(_rel.dot(_right));
      const ey = Math.abs(_rel.dot(_up));
      const ez = _rel.dot(_camDir);
      solved = Math.max(solved, ex / (fill * halfH) + ez, ey / (fill * halfV) + ez);
      if (ez > maxDepth) maxDepth = ez;
      reach = Math.max(reach, _rel.length());
    }
    // Never inside the hull, whatever the fill asks for.
    distance = Math.max(solved, maxDepth + reach * 0.25, 1e-6);

    // ...and never inside anything that is actually DRAWN.
    //
    // The clamp above is computed from the BLUEPRINT box, so it can only
    // protect against the fill: if the thing on screen is bigger than the thing
    // the generator declared, that arithmetic is confidently wrong and the
    // shutter fires from inside the ship, which is exactly what happened to all
    // three silhouette frames in round three. `clearCorners` is the box the
    // scene graph will actually draw, so this term is the one that cannot be
    // fooled by a disagreement between the two.
    //
    // Whole-subject fits only. A detail crop (`engine`, `hardware`, `scale`)
    // legitimately stands closer than the hull's own extent and reaches this
    // function through the sphere branch below, where it is untouched.
    if (clearCount > 0) {
      let front = -Infinity;
      let clearReach = 0;
      for (let i = 0; i < clearCount; i++) {
        _rel.copy(clearCorners[i]!).sub(aimPoint);
        front = Math.max(front, _rel.dot(_camDir));
        clearReach = Math.max(clearReach, _rel.length());
      }
      // 15% of the drawn box's own reach of air between the lens and the
      // nearest surface: enough that a hull whose mesh overshoots its declared
      // bounds still lands whole on black rather than swallowing the camera.
      guard = front + clearReach * 0.15;
      distance = Math.max(distance, guard);
    }
  } else {
    // A sphere is isotropic, so the tighter half-extent is the binding one.
    distance = radiusKm / Math.max(fill * Math.min(halfV, halfH), 1e-6);
  }

  // Findings 1, 5 and 9 of round two all asked for the same thing and could
  // not get it: the numbers this solver actually used. One line per shot, at
  // capture time rather than at authoring time, so the next round can diff a
  // frame against the arithmetic that produced it instead of inferring the
  // camera from the picture.
  if (shotName !== '') {
    console.info(
      `[showroom] ${shotName} fov=${spec.fovDeg} fill=${fill.toFixed(2)} aspect=${ctx.camera.aspect.toFixed(3)} ` +
        `corners=${cornerCount} halfEx=${halfEx.toFixed(4)} halfEy=${halfEy.toFixed(4)} ` +
        `radius=${radiusKm.toFixed(4)} solved=${solved.toFixed(4)} maxDepth=${maxDepth.toFixed(4)} ` +
        `reach=${reach.toFixed(4)} clear=${clearCount}/${guard.toFixed(4)} distance=${distance.toFixed(4)}`,
    );
  }

  ctx.camera.position.copy(aimPoint).addScaledVector(_camDir, distance);

  // Aim past the subject by the frame's half-extents at the subject's
  // distance, so the offsets read directly in NDC. Offsets are applied along
  // the ROLLED axes, so `offsetX` still means "to the right of frame" on a
  // shot composed on a diagonal.
  const hy = distance * halfV;
  const hx = hy * Math.max(ctx.camera.aspect, 1e-3);
  _target
    .copy(aimPoint)
    .addScaledVector(_right, -(spec.offsetX ?? 0) * hx)
    .addScaledVector(_up, -(spec.offsetY ?? 0) * hy);

  ctx.camera.lookAt(_target);
  // Roll about the camera's own view axis: pure screen-space rotation, so the
  // lighting on the hull is untouched and the ship runs on a diagonal.
  if (roll !== 0) ctx.camera.rotateZ(roll);
  ctx.camera.updateMatrixWorld(true);
}
