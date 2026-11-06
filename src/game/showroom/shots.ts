/**
 * The 22 showroom review shots and their registration. Moved verbatim out of
 * `Showroom.ts`; the frames they produce are byte-identical to the
 * pre-split ones (PNG-diffed at the split).
 */

import { Vector3 } from 'three';

import { registerShot } from '@/game/Shots';
import type { Showroom, ShowroomSetup } from './Stage';
import { placeCamera, swingToFace, type CameraSpec } from './camera';
import {
  BURN,
  COLD,
  CRUISE,
  FACTION_FLEET,
  FAMILY_FLEET,
  HERO_SHIP,
  KEY_LIGHT,
  WRECK_SHIP,
} from './presets';

// ===========================================================================
// The review shots
//
// Every shot is deterministic: a pinned seed, a pinned faction and role where
// the comparison demands it, a camera expressed as a direction and a fraction
// of the frame rather than as a coordinate, and a fixed settle time.
//
// The descriptions are not documentation. They are the brief handed to the
// critic agents, and each one states WHAT TO LOOK AT and WHAT COUNTS AS A
// FAILURE, because a critic given only a picture will review the lighting.
// ===========================================================================

interface ShowroomShotDef {
  readonly name: string;
  readonly description: string;
  readonly setup: ShowroomSetup;
  readonly camera: CameraSpec;
  /** Seconds of simulated drive spool before the shutter. */
  readonly settle?: number;
}

const SHOT_DEFS: readonly ShowroomShotDef[] = [
  // -- silhouette ----------------------------------------------------------
  {
    name: 'ship-silhouette-side',
    description:
      'The hero hull dead abeam, every surface replaced with a flat matte and lit by a rim ' +
      'only. LOOK AT: the profile as a drawing. Does it have a distinguishable top and ' +
      'bottom? Are there two or three masses of clearly different size, or one mass with ' +
      'bumps? Does the load path read — does the eye follow structure from the engines to ' +
      'the nose? FAILS IF: the outline is a lozenge, a tube or a wedge; the profile is ' +
      'near-symmetric about its long axis; the only things breaking the line are small ' +
      'hardware; you cannot tell which end is the front.',
    setup: { ships: [HERO_SHIP], silhouette: true, drive: COLD, ...KEY_LIGHT, sunDirection: [0.62, 0.55, -0.56] },
    // Dead abeam means DEAD abeam: zero elevation, so no dorsal face is in
    // view at all, and a narrow lens so the profile approximates an
    // orthographic elevation rather than a perspective of one. The previous
    // 1.7 degrees of elevation put a lit band along the top of both hull
    // cylinders, which is a three-quarter read on the one frame whose whole
    // purpose is the profile as a drawing.
    //
    // The 9 degrees is DELIBERATE and stays, against two reviewers who asked
    // for 20-24 after round three. It was flagged because it was the one camera
    // value re-authored that round and the frame came back unusable, which is a
    // correlation; the measurement says otherwise. `placeCamera` solves 389.8 m
    // from these bounds at this lens and frames the hull at 57% width / 81%
    // height — exactly what fill 0.86 asks for. What filled the frame was a
    // 1 km nozzle bell drawn at its authored scale by the silhouette override,
    // 760 m in front of a correctly placed camera (see `setSilhouette`). Wide
    // the lens would have been inside the same bell. Widening it here would
    // have hidden the bug behind a lens change and cost the frame the near-
    // orthographic read it exists for.
    // 22 degrees, not 9. A 9-degree lens is 2.5x narrower than every other
    // hull-framed shot in this file, and at that focal length the fill solver
    // parks the camera on the plating: measured, empty frame fell from 96.2%
    // to 20.0% and the subject clipped all four edges. The silhouette shots
    // are the ones that must contain the WHOLE ship.
    camera: { dir: [1, 0, 0], fovDeg: 22, fill: 0.86, aimAt: 'hull' },
  },
  {
    name: 'ship-silhouette-front',
    description:
      'The hero hull head on, flat matte, rim only. LOOK AT: the cross-section. Is it a ' +
      'circle, or does it have a keel, a shoulder, a chine, a flat belly? Is the beam ' +
      'distribution deliberate — wide low and narrow high, or the reverse? Do outboard ' +
      'masses (radiators, nacelles, booms) read as a frontal shape rather than as ' +
      'clutter? FAILS IF: the frontal silhouette is a circle or a rounded rectangle; the ' +
      'ship is bilaterally identical AND vertically identical; nothing distinguishes this ' +
      'nose from any other nose in the fleet.',
    setup: { ships: [HERO_SHIP], silhouette: true, drive: COLD, ...KEY_LIGHT, sunDirection: [0.72, 0.42, -0.55] },
    camera: { dir: [0.06, 0.09, -1], fovDeg: 20, fill: 0.8, aimAt: 'hull' },
  },
  {
    name: 'ship-silhouette-three-quarter',
    description:
      'The hero hull from a high rear three-quarter, flat matte, rim only. LOOK AT: whether ' +
      'the form still reads when the side and front reads are combined — this is the angle ' +
      'that exposes a ship built as two unrelated drawings. Does the plan view have ' +
      'structure? Do masses overlap in a way that composes, or do they merge into one blob? ' +
      'FAILS IF: the three-quarter reads flatter than the side view; the hull becomes an ' +
      'undifferentiated mass; the engines are not legible as the aft termination of the ' +
      'structure.',
    setup: { ships: [HERO_SHIP], silhouette: true, drive: COLD, ...KEY_LIGHT, sunDirection: [-0.35, 0.68, 0.64] },
    camera: { dir: [0.72, 0.34, 0.6], fovDeg: 22, fill: 0.8, roll: 0.22, aimAt: 'hull' },
  },

  // -- surface -------------------------------------------------------------
  {
    // NOT called `ship-hero`. `src/ship/Ship.ts:2547` already registers a shot
    // under that exact name, and it photographs the hand-authored player ship —
    // a smooth cigar hull with a pointed nose and TWO nozzles. When the full
    // capture writes into the ships review directory, `ship-hero.png` is the
    // first file an art lead opens and it shows a vessel this generator did not
    // produce: the procedural hero is a boxy modular freighter with SIX bells
    // in two pods. Two review rounds have now been at risk of judging
    // proportion, engine count and surface off the wrong ship.
    //
    // Ship.ts is baseline and must not be degraded (BRIEF §2), so the name
    // collision is resolved from this side: the showroom's flagship frame is
    // registered under a name of its own, and the review set now contains a
    // whole-hull hero that is unambiguously generated. Fixing the COLLISION
    // still belongs to the integrator — `scripts/shoot.mjs` must keep Ship.ts's
    // `ship-hero` out of the ships set, or the round must be shot with
    // `scripts/ship-review.mjs`, which only ever runs `SHOWROOM_SHOTS`.
    name: 'ship-showroom-hero',
    description:
      'The generated hero hull WHOLE, rear three-quarter, drive at cruise, nothing cropped ' +
      'and nothing else in frame — the one image to judge the ship as a ship. LOOK AT: the ' +
      'overall proportion and the mass hierarchy first, then the engine architecture, then ' +
      'the surface. Count the engine bells and check that number against ship-hero-close, ' +
      'ship-high-quality and ship-lod0: all four are the same hull and must agree. FAILS IF: ' +
      'this is a different vessel from the other HERO_SHIP frames; the hull touches a frame ' +
      'edge; the silhouette reads as one undifferentiated mass.',
    setup: { ships: [HERO_SHIP], drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.66, 0.28, 0.7], fovDeg: 24, fill: 0.82, roll: 0.1, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-hero-close',
    description:
      'The frame the ship engine wants to be judged on: rear three-quarter, raking key, ' +
      'drive at cruise, composed on a diagonal. LOOK AT: whether it looks ENGINEERED. ' +
      'Panels sized to the hull rather than to a constant; wear concentrated on edges, ' +
      'around hatches and aft of thrusters rather than laid evenly; a hard terminator with ' +
      'hardware casting across plating; colour rationed to near-black steel plus one accent ' +
      'and the amber of the instruments. FAILS IF: noise is uniform over the whole hull; ' +
      'the plating reads as one projected texture across parts that should come from ' +
      'different yards; the hull is grey rather than near-black; there is more than one ' +
      'saturated hue competing.',
    setup: { ships: [HERO_SHIP], drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.714, 0.333, 0.616], fovDeg: 22, fill: 0.74, offsetX: 0.16, offsetY: 0.12, roll: 0.34, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-engine-close',
    description:
      'The drive cluster at full burn, filling the frame. LOOK AT: whether the propulsion ' +
      'is believable hardware. Bell or grid geometry appropriate to the drive technology; ' +
      'the throat visibly hotter than the outside of the bell; a plume that fades at its ' +
      'own silhouette rather than ending in a hard edge; soot on the plating aft of the ' +
      'nozzles and nowhere else; thrust structure that could actually carry the load. ' +
      'FAILS IF: the plume is a solid cone or a flat sprite; exhaust intersects the hull; ' +
      'the nozzles are bolted to nothing; the glow blooms into a shapeless white mass.',
    setup: { ships: [HERO_SHIP], drive: BURN, ...KEY_LIGHT, sunDirection: [0.55, 0.5, -0.67] },
    camera: { dir: [0.62, 0.36, 0.7], fovDeg: 34, fill: 0.72, offsetX: 0.1, aimAt: 'engine' },
    settle: 4,
  },
  {
    name: 'ship-greeble-close',
    description:
      'Crew hardware at arm\'s length — a frame roughly four decks across, so anything ' +
      'human-scale is unmissable. LOOK AT: whether the small forms are ASSEMBLIES rather than boxes and ' +
      'cylinders. Count distinct silhouettes: fewer than four and the scatter will read as ' +
      'tiling. Look for hatches with lips, brackets with gussets, pipes with flanges, ' +
      'handrails a person could hold. Check the contact shadow under each piece — detail ' +
      'that does not darken the plate beneath it reads as a decal. FAILS IF: two silhouettes ' +
      'repeat across the frame; nothing is at human scale; the detail floats.',
    setup: { ships: [HERO_SHIP], drive: CRUISE, ...KEY_LIGHT, sunDirection: [0.32, 0.62, -0.72] },
    // Filled hard: the cluster is only a few metres across and at fill 0.7 the
    // frame held eighteen metres of hull, which is a hull shot with a bracket
    // in it rather than the arm's-length frame the brief asks for.
    //
    // `faceAim` is what makes the fill mean anything. Framing tight on a point
    // the lens is looking at EDGE-ON just fills the frame with more plate, and
    // that is what round three returned: 93% one plate, three seams, not one
    // bracket. The camera now stands off the chosen cluster's own mounting
    // normal, tilted back towards the authored raking direction, so the
    // hardware is between the lens and the plating instead of beside it.
    camera: {
      dir: [0.66, 0.46, 0.6],
      fovDeg: 38,
      fill: 0.86,
      roll: 0.15,
      aimAt: 'hardware',
      faceAim: 0.7,
    },
    settle: 3,
  },

  // -- lighting ------------------------------------------------------------
  {
    name: 'ship-dark-side',
    description:
      'The hull against black space with the key behind it and almost no fill — the ' +
      'hardest frame in the game. LOOK AT: whether the shadow side stays READABLE without ' +
      'becoming either black mud or a flat grey wash. There should be a hard terminator, a ' +
      'grazing sheen along the upper edges, and the ship\'s own running lights and lit ' +
      'windows doing the separating. FAILS IF: the unlit half is a featureless silhouette; ' +
      'or the unlit half is lifted by an ambient term that does not exist in space; or the ' +
      'ship disappears entirely against the background.',
    setup: {
      ships: [HERO_SHIP],
      drive: CRUISE,
      sunDirection: [-0.62, 0.36, -0.7],
      sunColor: [1.0, 0.93, 0.82],
      sunIntensity: 3.0,
      fillColor: [0.004, 0.005, 0.008],
      fillDirection: [0, -1, 0],
    },
    camera: { dir: [0.78, 0.2, 0.59], fovDeg: 24, fill: 0.72, offsetX: -0.12, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-star-rimlight',
    description:
      'A TRUE BACK-KEY: the star behind the hull, high and off one shoulder, six times the ' +
      'hero intensity, no fill of any kind and the drive shut down, so the only light in ' +
      'frame is the star and the ship\'s own lamps. LOOK AT: the rim. A hard, thin ' +
      'highlight along the STAR-FACING side of the outline, broken where the form breaks, ' +
      'brightest on edges square to the light — and everything facing the lens near black ' +
      'beneath it. This is the test of whether the grazing sheen term exists and whether the ' +
      'silhouette survives contact with a bright background. FAILS IF: the rim is a soft ' +
      'even glow all the way round; the faces turned towards the camera are lifted by ' +
      'anything at all; the whole hull washes out; bloom eats the outline; or there is no ' +
      'rim and the ship is a black cut-out.',
    // WHY THE DRIVE IS COLD, AND IT IS THE FIX RATHER THAN A PREFERENCE.
    //
    // r5 came back with 61% of hull pixels above 0.30 saturation, all cool, no
    // terminator anywhere and a median hull luminance of 54 on a frame whose
    // subject is supposed to be unlit. That light is not ambient and it is not
    // the grade: `ShipMaterial` adds `uPlumeColor * wash * uThrottle * 6.0`,
    // and `uPlumeColor` is [0.16, 0.36, 1.0]. At CRUISE's 0.68 throttle the
    // drive was washing four units of BLUE over every surface facing the
    // nozzles, star or no star. A rig that runs the engines during a backlight
    // test has put a second light on the subject and called the result ambient.
    // Cold, the hull's only lit surfaces are the ones the star can reach, and
    // the windows and navigation lights — which are emissive and throttle-
    // independent — do the separating, exactly as `ship-dark-side` asks for.
    //
    // WHY THE STAR MOVED OFF THE VIEW AXIS.
    //
    // It was 172 degrees behind: as close to dead astern as makes no
    // difference. On a hull built of flat developable plate that leaves a
    // grazing band about eight degrees wide for a rim to live in, and a plate
    // either falls inside it or misses entirely — mostly it misses, which is
    // why there was no rim to find. At 148 degrees the band is 32 degrees wide,
    // so the plates that turn towards the star along one side of the silhouette
    // catch it and the ones facing the lens still sit at -0.85 and stay black.
    // The rim becomes a hard edge on ONE side, which is what a rim is; a
    // highlight that runs the whole way round is the failure this shot lists
    // first.
    //
    // The camera drops off dead astern to a low rear three-quarter for the same
    // reason: astern, the ship's outline is the engine bell cluster, and there
    // is no long silhouette for an edge to run along.
    setup: {
      ships: [HERO_SHIP],
      drive: COLD,
      sunDirection: [-0.84, 0.23, -0.49],
      sunColor: [1.0, 0.95, 0.88],
      sunIntensity: 6.0,
      // Zero, and meant literally. ARCHITECTURE §6 allows no ambient fill in
      // space, and this is the frame that proves the material obeys it; a
      // token 0.006 here is a number a reader has to argue about.
      fillColor: [0, 0, 0],
      fillDirection: [0, -1, 0.1],
    },
    camera: { dir: [0.58, 0.14, 0.8], fovDeg: 24, fill: 0.7, roll: -0.18, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-planetshine',
    description:
      'A weak star and a strong cool fill arriving from below, as it does over a lit ' +
      'world. LOOK AT: whether the belly fills from underneath and the upper flank stays ' +
      'properly dark — planetshine is a hemisphere from one side, not an ambient constant. ' +
      'The undersides of gear, pods and radiators should be the brightest thing in frame. ' +
      'FAILS IF: the fill lands equally on the top and the bottom of the hull; the shadows ' +
      'gain blue on top of the grade\'s own cool shadow tint and go cyan; the hull flattens ' +
      'into a single value.',
    setup: {
      ships: [HERO_SHIP],
      drive: CRUISE,
      sunDirection: [0.44, 0.66, -0.6],
      sunColor: [1.0, 0.93, 0.82],
      sunIntensity: 0.55,
      fillColor: [0.11, 0.14, 0.22],
      fillDirection: [0.05, -1, 0.12],
    },
    camera: { dir: [0.7, 0.12, 0.7], fovDeg: 24, fill: 0.72, offsetY: 0.14, aimAt: 'hull' },
    settle: 3,
  },

  // -- scale ---------------------------------------------------------------
  {
    name: 'ship-docking-scale',
    description:
      'A suited figure (1.8 m) and a standard freight container (12.2 m) standing off the ' +
      'hull\'s port flank, framed on THEM rather than on the ship, with plating filling the ' +
      'background. LOOK AT: whether the ship\'s own detail AGREES with the reference. ' +
      'Hatches should be about the figure\'s height, handrails about waist height, deck ' +
      'bands about 2.6 m apart, windows in rows that match those bands, hull plates a few ' +
      'figures across. FAILS IF: the hull behind the figure has no feature at all whose ' +
      'size can be checked; hatch, window or plate size contradicts the figure; the plating ' +
      'is so coarse or so fine that the hull could be any length; the reference objects are ' +
      'the only human-scale things in frame; or the hull behind the reference is unlit and ' +
      'the props are the only lit objects in the picture.',
    // THE KEY HAS TO FALL ON THE FLANK THE LENS IS LOOKING AT.
    //
    // This is the one shot in the set that stands on the ship's PORT side —
    // the reference props are placed off the port flank so they read against
    // plating rather than against space, and `aimAt: 'scale'` frames them.
    // Every other hull frame stands on the opposite side of the hull, and
    // `KEY_LIGHT` is authored for those: its sun is 116 degrees off THIS
    // camera's axis, so the flank in frame was the far side of the terminator. Measured on r5: 89% of ship
    // pixels below luminance 25, median 8 against a background of 3. The hull
    // was not dark, it was absent — and with nothing else in frame carrying any
    // light, PostFX's meter opened to its clamp and blew the container to 212,
    // which is how a neutral ruler became the brightest object in the picture.
    //
    // Mirrored onto the camera's own side: 60 degrees of incidence on a flank
    // whose normal is nearly the view axis, with the light 53 degrees up. That
    // is bright enough for the panel grid to read at the reference's own scale
    // and still raking enough that every hatch lip, rail and proud plate throws
    // a shadow down the plating — which is the whole point of putting a ruler
    // against it. Intensity stays at the standard 3.0: the ruler has to be
    // exposed like every other frame or it is not calibrating anything.
    setup: {
      ships: [HERO_SHIP],
      drive: COLD,
      scaleReference: true,
      ...KEY_LIGHT,
      sunDirection: [-0.5, 0.8, 0.31],
    },
    camera: { dir: [-0.88, 0.2, 0.43], fovDeg: 30, fill: 0.72, offsetX: -0.18, offsetY: 0.06, aimAt: 'scale' },
    settle: 2,
  },

  // -- fleets --------------------------------------------------------------
  {
    name: 'ship-fleet-family',
    description:
      'Five seeds from one yard (Kessler), size band pinned, and five DIFFERENT jobs — ' +
      'left to right, top row then bottom: freighter, tanker, miner, then tug and ' +
      'station-tender. THE DNA TEST, and it has two halves that pull against each other. ' +
      'LOOK AT: (1) do these five read as coming from the same builder — shared ' +
      'construction language, joint style, proportion habits, radiator architecture, nozzle ' +
      'family; and (2) is each one\'s JOB guessable from its form, or are they one hull with ' +
      'the parts moved. FAILS IF: you cannot name a single shared trait; or you can name the ' +
      'shared traits but the hulls differ only in where the bolt-ons landed; or you could not ' +
      'have guessed the roles in that order. All five hulls must be separately readable — ' +
      'if any two touch or overlap on screen, the plate is void, say so and stop.',
    // BROADSIDE, and that is the whole shot.
    //
    // Round three photographed this plate from [0.12, 0.5, 0.86] — thirty
    // degrees up and nearly dead astern. That is the one axis of view that
    // hides length, proportion and mass distribution, which are the three
    // things that distinguish one seed from another, so what the DNA test
    // actually compared was engine-bell clusters. Worse, `rows: 2` at that
    // elevation stacked the back row directly BEHIND the front one: five hulls
    // came out as three blobs, one of them two hulls fused into a single
    // column.
    //
    // Both are fixed by the same lever. Every hull is yawed a quarter turn so
    // its length runs along the layout's own X axis, and the camera drops to
    // ten degrees of elevation almost square to that axis. The hulls are then
    // broadside AND the row spreads across the frame, the rows separate
    // cleanly in Y because there is barely any elevation left to project them
    // into each other, and the block's 3 x 2 shape sits close to 16:9 instead
    // of the 4.4:1 ribbon that made a single row read at 90 px.
    //
    // `rows: 2` stays. The reason it was introduced — a five-wide row wastes
    // two thirds of the frame's height — is still true; it was the camera that
    // was wrong, not the layout. Five in a row would put each hull at roughly
    // 280 px of length and 45 px of height, which is under the size at which a
    // critic can read a joint.
    //
    // `spacing` is 0.45 of CLEAR AIR now, not 0.55 of an overlapping radius:
    // see the packing comment in `configure` for what the old unit did to this
    // plate. 0.45 rather than something tighter because perspective eats about
    // 40% of the world-space gap at the ends of the row — the hull nearest the
    // edge is seen from 25 degrees off and its own beam projects into the gap.
    // Solved against these five blueprints at this lens: the closest pair
    // clears 60 px of sky at 1920, every hull is 246-604 px long, and the whole
    // block lands at 0.90 of the frame. The old 0.55-of-a-radius produced five
    // overlapping pairs on the same five hulls.
    //
    // The key is re-aimed with it: `KEY_LIGHT` puts the sun behind a camera on
    // +Z, which would have left every broadside flank unlit.
    setup: {
      ships: FAMILY_FLEET,
      drive: COLD,
      spacing: 0.45,
      rows: 2,
      yaw: Math.PI / 2,
      requireDistinctRoles: true,
      ...KEY_LIGHT,
      sunDirection: [-0.48, 0.46, 0.75],
    },
    camera: { dir: [0.05, 0.17, 0.984], fovDeg: 32, fill: 0.9, aimAt: 'layout' },
    settle: 2,
  },
  {
    name: 'ship-fleet-factions',
    description:
      'One hull from each of the three factions, with EVERY other variable held constant: ' +
      'same seed, same role (freighter), same size class. Left to right: Kessler, Sillane, ' +
      'Ossuary. THE CONTRAST TEST — any difference you can see is faction DNA and nothing ' +
      'else. LOOK AT: whether the three are distinguishable at a glance as black shapes, ' +
      'and whether the differences are DOCTRINAL (welded plate versus cast monocoque versus ' +
      'salvage) rather than cosmetic. FAILS IF: the three differ only in paint; or one is ' +
      'obviously the same mesh with a different palette; or the differences are random ' +
      'rather than attributable to how that culture builds.',
    // Same broadside treatment as the family plate, for the same reason plus
    // one of its own: a contrast test in which the three subjects sit at
    // different DISTANCES is not a contrast test. The row runs along X, so the
    // 0.2 of X in the old direction telescoped it — the left hull came out
    // half again the size of the right, and the difference a critic is asked to
    // attribute to doctrine was partly just perspective. Square to the row,
    // all three are the same number of metres from the lens.
    // Spacing re-expressed in the new unit and nothing else changed here: r5's
    // 0.75-of-a-radius left 49 px and 67 px of sky between the three hulls,
    // which is about 0.23 of a half-length — this plate got away with the bad
    // unit because a freighter's sphere is a good deal larger than the length
    // it presents. 0.4 of clear air solves to 75 px between the closest pair
    // and costs the widest hull 3% of its length. This frame was not one of the
    // failures; it is touched only because the unit changed underneath it.
    setup: {
      ships: FACTION_FLEET,
      drive: COLD,
      spacing: 0.4,
      yaw: Math.PI / 2,
      ...KEY_LIGHT,
      sunDirection: [-0.48, 0.46, 0.75],
    },
    camera: { dir: [0.03, 0.15, 0.988], fovDeg: 30, fill: 0.88, aimAt: 'layout' },
    settle: 2,
  },

  // -- history -------------------------------------------------------------
  {
    name: 'ship-damage-history',
    description:
      'A sixty-year-old Ossuary breaker at eight per cent maintenance: heavy damage, heavy ' +
      'repair, several refits. LOOK AT: whether the history is legible AS GEOMETRY and as a ' +
      'TIMELINE. A patch plate should sit proud of the hull, in the wrong shade, with its ' +
      'own fastener ring. A torn-off module should leave mounting stubs. A bent strut should ' +
      'be bent. Fresh damage should be bright metal with sharp edges; old damage should be ' +
      'oxidised, dirt-filled and soft. FAILS IF: the damage is only a texture; every wound ' +
      'is the same age; wounds are radially uniform instead of directional; the repairs are ' +
      'as tidy as the hull.',
    setup: { ships: [WRECK_SHIP], drive: COLD, ...KEY_LIGHT, sunDirection: [0.5, 0.6, -0.62] },
    camera: { dir: [0.68, 0.3, 0.67], fovDeg: 26, fill: 0.8, offsetX: 0.1, roll: 0.14, aimAt: 'hull' },
    settle: 2,
  },

  // -- quality tiers -------------------------------------------------------
  {
    name: 'ship-low-quality',
    description:
      'The hero hull and the hero camera, rebuilt at the LOW quality tier. Compare directly ' +
      'against ship-medium-quality and ship-high-quality. LOOK AT: whether the ship is still ' +
      'the same ship. Silhouette, proportion, the two or three primary masses and the wear ' +
      'STORY must survive; only density of small detail is allowed to go. FAILS IF: the ' +
      'silhouette changes; the hull changes colour or value; wear becomes uniform; the ship ' +
      'becomes unrecognisable as the same vessel.',
    setup: { ships: [HERO_SHIP], quality: 'low', drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.714, 0.333, 0.616], fovDeg: 22, fill: 0.74, offsetX: 0.16, offsetY: 0.12, roll: 0.34, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-medium-quality',
    description:
      'The hero hull and the hero camera at the MEDIUM tier. The middle term of the ' +
      'three-way quality comparison. LOOK AT: that it sits genuinely between low and high ' +
      'rather than matching one of them — a tier that changes nothing is a tier that is not ' +
      'implemented. FAILS IF: indistinguishable from either neighbour; or the step from low ' +
      'is larger than the step to high.',
    setup: { ships: [HERO_SHIP], quality: 'medium', drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.714, 0.333, 0.616], fovDeg: 22, fill: 0.74, offsetX: 0.16, offsetY: 0.12, roll: 0.34, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-high-quality',
    description:
      'The hero hull and the hero camera at the HIGH tier — the reference frame for the ' +
      'quality comparison and the one the budgets in BRIEF §6 are stated against. LOOK AT: ' +
      'the draw-call and triangle counts in the manifest beside this frame (≤ 12 calls, ' +
      '≤ 120k triangles for a medium hull) and whether the picture justifies them. FAILS IF: ' +
      'the budgets are exceeded; or they are met and the frame looks no better than medium.',
    setup: { ships: [HERO_SHIP], quality: 'high', drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.714, 0.333, 0.616], fovDeg: 22, fill: 0.74, offsetX: 0.16, offsetY: 0.12, roll: 0.34, aimAt: 'hull' },
    settle: 3,
  },

  // -- level of detail -----------------------------------------------------
  {
    name: 'ship-lod0',
    description:
      'LOD0 forced, framed so the hull spans most of the frame — the distance band LOD0 ' +
      'actually serves. The control frame for the LOD comparison. LOOK AT: full detail, and ' +
      'note where the detail LIVES so you can tell what LOD1 and LOD2 remove. FAILS IF: ' +
      'detail is spread evenly rather than concentrated where the form needs it.',
    setup: { ships: [HERO_SHIP], lod: 0, drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.7, 0.3, 0.65], fovDeg: 24, fill: 0.8, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-lod1',
    description:
      'LOD1 forced, same camera as ship-lod0 so the two can be flipped between. LOOK AT: ' +
      'what was dropped. At this level the ship should span roughly 120–400 px in play, so ' +
      'sub-metre hardware may go, but the primary and secondary masses must be untouched. ' +
      'FAILS IF: the silhouette changes at all; a mass disappears; the value of the hull ' +
      'shifts; you can identify the transition from this frame alone.',
    setup: { ships: [HERO_SHIP], lod: 1, drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.7, 0.3, 0.65], fovDeg: 24, fill: 0.8, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-lod2',
    description:
      'LOD2 forced, same camera again. This is the ≤ 3k triangle level, shown far closer ' +
      'than it would ever be seen, deliberately: a defect invisible at thirty pixels is ' +
      'still a defect. LOOK AT: whether the SILHOUETTE is preserved — that is the only ' +
      'thing that matters at this level — and whether the surface still holds the hull\'s ' +
      'overall value so it does not flicker brighter or darker when it swaps in. FAILS IF: ' +
      'the outline visibly simplifies; the ship changes brightness; whole masses collapse.',
    setup: { ships: [HERO_SHIP], lod: 2, drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.7, 0.3, 0.65], fovDeg: 24, fill: 0.8, aimAt: 'hull' },
    settle: 3,
  },
  {
    name: 'ship-extreme-distance',
    description:
      'The hull at impostor range, framed so it spans about thirty pixels of a 1080-line ' +
      'frame — the distance at which the ship becomes one quad. LOOK AT: whether it still ' +
      'reads as a SHIP and not as a bright dot or a grey smear; whether its value is ' +
      'plausible against black space; whether the navigation lights and the drive are what ' +
      'carry the read at this size, as they would in reality. FAILS IF: the ship vanishes; ' +
      'it aliases into a shimmering speck; it is brighter than a nearby star; or it is still ' +
      'drawing full geometry, which the manifest\'s triangle count will show.',
    setup: { ships: [HERO_SHIP], lod: 3, drive: CRUISE, ...KEY_LIGHT },
    camera: { dir: [0.7, 0.26, 0.66], fovDeg: 24, targetPixels: 30, aimAt: 'hull' },
    settle: 3,
  },
];

/**
 * Name and critic brief for every showroom shot, as plain data.
 *
 * Exported so `scripts/ship-review.mjs` can build its manifest without booting
 * a browser, and so the strings live in exactly one place. If the two ever
 * disagree, a critic reviews one frame against another frame's brief.
 */
export const SHOWROOM_SHOTS: readonly { readonly name: string; readonly description: string }[] =
  SHOT_DEFS.map((s) => ({ name: s.name, description: s.description }));

/** Every showroom shot name, in capture order. */
export const SHOWROOM_SHOT_NAMES: readonly string[] = SHOT_DEFS.map((s) => s.name);

const _aimPoint = new Vector3();
const _corners: Vector3[] = [];
const _clearCorners: Vector3[] = [];
const _specDir = new Vector3();
const _authoredDir = new Vector3();

/**
 * Register every showroom shot.
 *
 * The showroom must already be added to the engine as a module — the shots
 * configure it and drive it, but they do not own it, because a shot that owned
 * a five-ship fleet would rebuild it every time the harness switched frames.
 */
export function registerShowroomShots(showroom: Showroom): void {
  for (const def of SHOT_DEFS) {
    registerShot({
      name: def.name,
      description: def.description,
      apply(ctx) {
        showroom.enter(ctx);
        showroom.configure(ctx, def.setup);
        const aimAt = def.camera.aimAt ?? 'hull';
        _authoredDir.set(def.camera.dir[0], def.camera.dir[1], def.camera.dir[2]).normalize();
        _specDir.copy(_authoredDir);
        let radius = showroom.aim(aimAt, _aimPoint, _specDir);

        // A close-up has a chicken-and-egg in it: the picker needs a view
        // direction to decide which cluster the camera can see, and the camera
        // needs a cluster to know where to stand. Round three shipped the first
        // half only — a fixed world direction picked the cluster and then kept
        // pointing the same way — so the lens ended up looking ALONG the
        // plating at hardware mounted on a face turned away from it, and
        // `ship-greeble-close` came back as one flat plate.
        //
        // One iteration closes the loop: the provisional pick's own mounting
        // normal is mixed into the authored direction, and the pick is re-run
        // from where the camera will actually be, so clearance and facing are
        // scored against the final view rather than the provisional one.
        //
        // The direction is then taken from the SECOND pick's normal, not the
        // first's. That order matters and the obvious one is wrong: re-picking
        // can return a different cluster from the one whose normal produced the
        // swing, and the camera would be pointed at hardware it did not choose.
        // Re-deriving from the final cluster guarantees the lens ends up on the
        // outboard side of whatever the shot actually framed.
        const face = def.camera.faceAim ?? 0;
        if (face > 0 && swingToFace(_specDir, showroom.aimNormal, face)) {
          radius = showroom.aim(aimAt, _aimPoint, _specDir);
          _specDir.copy(_authoredDir);
          swingToFace(_specDir, showroom.aimNormal, face);
        }

        const corners = showroom.aimCorners(aimAt, _corners);
        // Only whole-subject fits get the clearance guard; a detail crop is
        // meant to be closer than the hull's own extent.
        const clear = corners >= 2 ? showroom.clearanceCorners(_clearCorners) : 0;
        placeCamera(
          ctx,
          def.camera,
          _specDir,
          radius,
          _aimPoint,
          _corners,
          corners,
          _clearCorners,
          clear,
          def.name,
        );
        // The camera is placed; a comparison plate can now be checked against
        // the only thing that matters about it — what the lens will see.
        showroom.reportLayoutSeparation(ctx, def.name);
        // Spool before the shutter. Every damped value on a drive starts at
        // zero, so a shot captured cold photographs a powered-down hull no
        // matter which drive state it asked for.
        showroom.settle(ctx, def.settle ?? 1);
      },
      update(dt, ctx) {
        // Nothing else drives these hulls: the pilot has stood down for the
        // duration of the shot, so without this the throttle, the plume and
        // the RCS all stay at their constructor zero.
        showroom.update(dt, ctx);
      },
      teardown() {
        showroom.exit();
      },
    });
  }
}
