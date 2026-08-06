# oneSpace — Ship Technique Catalogue

**Audience:** every agent on the Procedural Spaceship Engine.
**Purpose:** so you do not have to read 2,634 lines of `src/ship/Ship.ts`.
**Status:** analysis only. This document creates no code and changes no file.

Everything below is measured against the code as it stands. Line numbers are `src/ship/Ship.ts` unless another file is named.

---

## 0. The one thing to read if you read nothing else

> **`src/ship/Ship.ts` exports exactly four symbols:** `ShipState` (:50), `SHIP_LENGTH_KM` (:65), `class Ship` (:1298), `registerShipShots()` (:2535).
>
> `HullShape`, `HullBuilder`, `addBox`, `addCylinder`, `place()`, the five greeble builders, `PANEL_GLSL`, `HULL_VERT` and `HULL_FRAG` are **all module private**. You may not modify `Ship.ts` to export them. Every technique in section 2 must therefore be **re-implemented or copied** into `src/render/ships/*`. Budget for that. Nothing is an import.

Second thing: **the hull material in `Ship.ts` is the only material in the project that tone-maps itself.** It is a bug you must not inherit. See §4.2.

Third thing: **the analytic occluder scheme is already at 27 of its 28 slots on a 30 m hull with 17 bolt-ons.** It does not scale by any amount at all. See §2.5 and §3.1.

---

## 1. How the existing ship is built

### 1.1 Pipeline, in execution order

Everything happens in `Ship`'s constructor (:1356–1650). Nothing is generated at runtime; `update()` (:2392) only pushes uniforms and damps values.

| # | Stage | Where | What it contributes |
|---|---|---|---|
| 0 | `registerShaderChunks()` | :1357 | Makes `<onespace_noise>` / `<onespace_color>` available. Idempotent. |
| 1 | Tier lookup | :1359–1363 | `ringCount` 16/18/22/24, `radial` 20/24/28/32, `greebleBudget` 80/150/240/340 for low/medium/high/ultra. **This is the entire LOD story.** |
| 2 | `new Rng(hashSeed(seed,'ship'))` | :1365 | Root stream. Everything below forks off it, never `Math.random()`. |
| 3 | `new HullShape(rng.fork('hull'), ringCount)` | :1366, class at :437 | The swept superellipse: a table of `HullRing{z,cx,cy,rx,ry,n}` plus 2–3 radial `cos` chines. Pure maths, no geometry yet. |
| 4 | `buildFuselage(hb, shape, rings, radial)` | :1372, :1656 | Samples the shape into a `rings × (radial+1)` vertex grid, quads it, then fans a flat nose cap and tail cap. Returns the hull vertex count so stage 6 knows where the fuselage ends. All part id 0. |
| 5 | `buildParts(hb, shape, rng.fork('parts'), occ, sh)` | :1373, :1755 | 17 hand-authored bolt-ons welded into the **same** buffer: dorsal spine + 3 cable runs, 2 radiator fins, cargo pannier + secondary + 3 straps, cockpit blister, 2 pylons, 2 nacelles + 6 girth bands + 6 junction boxes + 2 conduits, 3 landing pods, intake scoop, sensor mast + dish, 2 whip antennae, tail stabiliser, 4–6 patch plates. Also fills the `Occluder[]` (contact AO) and `Shadower[]` (cast shadow) lists and records `enginePos`/`engineDir`. |
| 6 | `applyContactAO(hb, hullVerts, occ)` | :1374, :1951 | CPU AO bake. For each of the ~640 fuselage vertices, nearest-occluder-wins darkening into `aAO`. `O(verts × occluders)` = 640 × 13. |
| 7 | `hb.toGeometry(true)` | :1375, :215 | One indexed `BufferGeometry`. Normals accumulated from **un-normalised** face normals (:174–209) so shared vertices smooth and unshared vertices stay faceted — a box authored with 4 verts per face comes out hard-edged for free. |
| 8 | Palette | :1378–1391 | `hue = pick([0.58,0.55,0.11,0.09,0.33])`, `paint = HSL(hue, 0.22–0.45, 0.05–0.095)`, `paintAlt` a drifted second yard's batch. Lightness in the bottom tenth on purpose (linear space). |
| 9 | `hullUniforms` | :1394–1425 | One object, ~24 uniforms. Shared **by reference** with the greeble material. |
| 10 | Shadower sort + upload | :1427–1439 | `sort((a,b)=>b.r-a.r)` then the first `OCC_MAX=28` are packed into `Float32Array(28*4)` + `Float32Array(28)`. Sorted by radius because the list is capped and the biggest masses must not be evicted by a whip antenna. |
| 11 | Two `ShaderMaterial`s, one uniforms object | :1452–1465 | `hullMat` (non-instanced) and `greebleMat` (instanced). Identical source and defines ⇒ three compiles one program; two materials only avoid the per-draw cache-key flip between `USE_INSTANCING` on and off. |
| 12 | Hull mesh | :1467–1469 | `frustumCulled = false`. |
| 13 | 5 greeble scatters | :1477–1505, :1973 | `hatch .26 / bracket .20 / ribbed .20 / stack .16 / pipe (remainder)`. Each is an `InstancedMesh` sharing `greebleMat`. Rejection-sampled against a **shared** `seats` array so families do not land on each other. |
| 14 | `buildLights` | :1508, :2092 | 16 emissive quads (2 cockpit, 5 starboard, 3 port, 5 running/beacon, 1 floodlight). Fills up to `LAMP_MAX=6` entries of `uLamp` — 5 are used. Additive, `depthWrite:false`, `renderOrder 2`. |
| 15 | `buildNozzles` | :1523, :2212 | 3 rings × 16 seg per engine, `DoubleSide`; the frag branches on `gl_FrontFacing` for outside-vs-throat. |
| 16 | `buildPlume` | :1543, :2269 | 2 nested cone shells per engine, 13 rings × 16 seg. All vertices sit at the nozzle mouth; the **vertex shader** extrudes them from `aT`/`aLayer`/`aDir` + 3 uniforms, so length and width are free to animate. |
| 17 | RCS | :1568–1622, :2360 | 10 thrusters from a fixed `spots` table. One instanced quad each, `aLevel` is a `DynamicDrawUsage` `InstancedBufferAttribute` written every frame. Vertex shader billboards the jet as a real 3D segment projected to screen, not a screen-space quad. |
| 18 | `buildWake` | :1625, :2321 | 24 seg × 15 ring cone off the tail, hidden until `heating > 0.01`. |
| 19 | Engine anchors → uniforms | :1648–1649 | `uEngineA`/`uEngineB` feed the hull's fake plume lighting. Note `enginePos[1] ?? enginePos[0]` — **two engines are assumed**. |

### 1.2 What the frame loop does

`update(dt, ctx, state)` (:2392–2474), zero allocations:

1. `time += dt`; `vThrottle/vBoost/vHeat` damped at 3.0 / 2.2 / 1.5 e-foldings per second (:2397–2399). Nothing snaps.
2. Camera inverted into ship-local and written to `_camLocal`, which `uCameraLocal` **aliases** — no copy (:2405–2416).
3. Nozzle glow depth, plume length/width/heat-mix/intensity/shock-diamonds (:2422–2439).
4. RCS: for each thruster `align = -rcsDir · thrusterDir`, gate at 0.3, bang-bang duty cycle `sin(time*17 + phase*2π)`, attack rate 38 / decay 7.5 — the asymmetry *is* the puff (:2441–2467).
5. Wake length/width from heat (:2470–2473).

### 1.3 Measured cost at `high` tier

Counted from the source, not guessed.

| Mesh | Verts | Tris | Notes |
|---|---:|---:|---|
| Fuselage (22×29 grid + 2 caps) | 640 | 1,232 | |
| Bolt-ons: 31 boxes | 744 | 372 | `addBox` = 24 v / 12 t |
| Bolt-ons: 13 cylinders | 625 | 612 | `addCylinder(seg)` = 2·seg+1+seg v, 3·seg t |
| **Hull draw total** | **2,009** | **2,216** | one draw call |
| Greebles, 240 instances | — | 11,856 | hatch 62×36, bracket 48×36, ribbed 48×48, stack 38×36, pipe 44×96 |
| Lights (16 quads) | 64 | 32 | |
| Nozzles | 96 | 128 | |
| Plume | 832 | 1,536 | |
| Wake | 360 | 672 | hidden unless heating |
| RCS | 40 | 20 | hidden unless firing |
| **Frame total, cruising** | | **≈ 15.8 k** | 13 % of the 120 k LOD0 budget |

**Draw calls: 11**, not the 10 the file header claims (:17) — the header predates the fifth greeble family. 9 are drawn coasting (wake + RCS hidden). Budget is ≤ 12, so the reference ship is at 92 % of it with one hull.

**Materials: 7** (`hull, greeble, light, nozzle, plume, wake, rcs`). The brief's budget is ≤ 3 per ship. The reference ship does not meet its own successor's budget; see §3.7.

**Occluder slots: 27 of 28 used** (counted from the eleven `this.cast(...)` call sites at :1773, :1795, :1810, :1823, :1832, :1852, :1890, :1895, :1913, :1914, :1926). **Contact-AO occluders: 13.** **Lamps: 5 of 6.**

---

## 2. Techniques worth reusing

Each entry: what it is, why, the exact symbol, its limit, and an honest verdict on whether it survives at 4 km.

### 2.1 The swept superellipse hull — `class HullShape` (:437–530)

**What.** A table of cross-sections `HullRing{z, cx, cy, rx, ry, n}` (:422–430) interpolated linearly along `t`. `sample(t, theta, out)` (:492) evaluates the superellipse `|x|^n + |y|^n = 1` via `sign(c)·|c|^(2/n)`, with `n` running 2.5 → 4.8 nose to tail (:471) so the section morphs from rounded to boxy. `normal(t, theta, out)` (:519) is a central-difference cross product, construction-time only.

**Why this and not a lathe.** The section can drift off the centreline (`cx`, `cy`), change aspect (`hRatio` :463), and change *shape family* (`n`) along the length. That is what stops a lofted tube reading as a missile. Three additional mechanisms carry the character:

- **Envelope bulges** (:445–449, applied :459–462): three Gaussian lumps at random `t` with amplitude ±0.2 and width 0.05–0.16, multiplied into the radius.
- **Chines** (:476–480, applied :483–489): 2–3 terms of `amp·cos(freq·theta + phase)` with `amp ∈ [0.03, 0.085]`, `freq ∈ [3,7]`, **constant along the length**. Constant-along-length is the point — it produces a continuous chine line, not a lumpy tube.
- **Flat belly** (:511): `if (sy < 0) sy *= 0.82`. Freighters land on them.

**Copy:** class body :437–530, plus `clamp01`/`smoothstep` (:89–96).

**Limits.** It is exactly one topological cylinder from nose to tail. It cannot express a truss, a catamaran, a rotating ring, a stack of drums, or anything with a hole in it.

**Scaling verdict: SCALES, and it is nearly free.** Silhouette smoothness is a *screen-space* property, so the segment counts do not grow with the ship. A cylinder of radius `r` with `s` segments has sagitta `≈ r·π²/(2s²)`; at hero framing (ship spans 1080 px) with `r/L ≈ 0.14` the radius spans ~151 px, so `s ≥ 28` — precisely the `radial = 28` at high tier, and the same 28 whether the ship is 30 m or 4 km. Only the **longitudinal** ring count needs to track aspect ratio: at 21 spans over a 4 km hull the ring pitch is 190 m and a 500 m radius of curvature gives a 9 m sagitta = 2.4 px. Rule of thumb: `rings ≈ 5 × (L/beam)`, so 22 at 4:1, 50–64 at a 10:1 capital. That is 4 k triangles for a 4 km hull. **The hull is not the problem. Nothing below this line is as cheap.**

### 2.2 Greebles as assemblies — `greebleHatch/Bracket/Ribbed/Stack/Pipe` (:374–416)

**What.** Five tiny multi-primitive builds, each authored in a **unit footprint** — `x, z ∈ [-0.5, 0.5]`, `y` from 0 (mounting face) to ~1 — so one per-instance `Matrix4` scale drives all five families:

- `hatch` (:374) plate + raised lip + latch block, 3 boxes, 36 t
- `bracket` (:382) foot + upright web + gusset, 3 boxes, 36 t
- `ribbed` (:391) rail + 3 fins, 4 boxes, 48 t
- `stack` (:400) two crates + a strapped-on third, deliberately off-square, 36 t
- `pipe` (:410) flange + stack + collar, 3 cylinders, 96 t

**Why.** The comment at :364–365 and :1472–1476 is the whole argument: a bare box and a bare cylinder gave 200+ instances exactly **two** silhouettes. That reads as visible tiling. Five assemblies with distinct aspect envelopes cost three extra draw calls and fix it.

**The other half is the per-family envelope** in `scatterGreebles` (:1985–1994). Each `kind` has `{w, lo, hi, h, hlo, hhi}`: a pipe is square in plan and stands up (`lo=hi=1.0`, `h=0.16`), a ribbed strip is long and low (`hi=3.4`, `h=0.06`). Widening those ranges is stated to be "half of what stops the scatter reading as one repeated silhouette".

**Copy:** :374–416 and the `env` table at :1985–1994.

**Limits.** Absolute sizes come out at 0.2–1.9 m wide and 0.03–0.31 m tall (`MAX_R × env.w × rng.power(0.3,1.0,-1.6) × ratio`). They are hand-tuned to a 30 m hull's proportions and are hardware-scale, not module-scale.

**Scaling verdict: the *authoring* idea scales, the *density* does not.** See §3.2 for the numbers. On a 4 km ship the greeble tier is the *fourth* level of form, not the third, and it exists only inside a camera-proximity band.

### 2.3 One merged indexed buffer — `class HullBuilder` (:146–228)

**What.** Five parallel arrays (`pos, wear, part, ao, idx`), `vertex()`/`tri()`/`quad()` accumulators, `computeNormals()` (:174) and `toGeometry(perVertexWear)` (:215). Fuselage and all 17 bolt-ons go into one buffer ⇒ one draw call for the entire structural hull.

**Why `computeNormals` is written the way it is.** Face normals are accumulated **un-normalised**, so each face is area-weighted for free (:188), and vertices are only smoothed where they are *shared*. `addBox` (:260) pushes four fresh vertices per face — so boxes are faceted with no flag, no `flatShading`, no second geometry. That single decision is why the ship reads as welded plate.

**`toGeometry(false)`** omits `aWear`/`aPart` so the same builder produces instanced base geometry, where those two channels arrive per-instance instead (:220–223, used by every greeble builder).

**Copy:** :146–228, plus `pushLocal` (:237), `mountAO` (:252), `addBox` (:260), `addCylinder` (:324).

**Limits.** `number[]` accumulation then `new Float32Array(...)` — one full copy of every attribute at the end. Five separate attribute buffers, not interleaved: 36 bytes/vertex over 5 VBO bindings.

**Scaling verdict: SCALES with two fixes.** (a) Pre-size the arrays or build into typed arrays directly — at 120 k triangles the `number[]` boxing is the dominant generation cost. (b) Above 65,535 vertices `setIndex(number[])` silently promotes to `Uint32Array`; that is fine but doubles index memory, so at capital scale split into per-module buffers anyway (you want per-module culling and per-module LOD, which a single merged buffer forbids).

### 2.4 Per-vertex `aAO` / `aWear` / `aPart` (:577–579, :219–222)

**What.** Three float channels declared **once** in `HULL_VERT` as plain `attribute float`. On the hull mesh they are per-vertex `BufferAttribute`s; on the greeble meshes they are per-instance `InstancedBufferAttribute`s (:2082–2083). three binds whichever the geometry supplies — same declaration, same shader, no permutation. That trick is worth more than it looks.

- **`aAO`** — baked contact darkening (§2.5a). Consumed at :759 and multiplied into every lighting term.
- **`aWear`** — a wear *multiplier*, not a wear value: gates the curvature term at :736 as `(0.4 + 0.8·vWear)`. Nose and tail plating is authored newer than the flanks nobody can reach (:1668).
- **`aPart`** — an integer part id that drives **three** independent things: panel plate scale (:676), panel projection offset (:678), paint batch (:709), and self-shadow rejection (:808). It is the single most load-bearing attribute in the shader.

**The `aPart` namespace is hand-allocated and collision-prone:** fuselage + nose cap + tail cap = 0, bolt-ons 2–15, patch plates `16+i` (up to 21), nacelle hardware 33/34, greebles `40 + rng.int(0,11)` (40–51). The comment at :2059–2062 records a real collision that had to be fixed by hand. See §6.

**Also note the nose cap deliberately shares part id 0** (:1682–1684): a different id would interpolate across every cap triangle, because `vPart` is a *varying* and gets smoothly blended between vertices with different ids. **Any part boundary that shares vertices smears.** That is a hard constraint on how you assign part ids in merged geometry.

**Copy:** the attribute declarations and the four consumption sites.

**Scaling verdict: SCALES, but `aPart` must become a real allocation.** A `float` varying carries about 24 bits of integer exactly; a capital ship with 2,000 parts fits comfortably. Replace the hand-allocated namespace with a monotonic counter handed out by the builder, and put the per-part data (plate scale, paint batch, material family) in a small uniform array or a data texture indexed by part id rather than re-hashing `vPart` in the shader.

### 2.5 Analytic occlusion — two lists, two mechanisms

Read the comment at :117–123: these are **deliberately different lists**.

**(a) Contact AO — `Occluder{x,y,z,r}` (:110), `mark()` (:1728), `applyContactAO()` (:1951).** One fat sphere per bolt-on, centred where it meets the plating. Baked on the CPU into `aAO`. Nearest-occluder-wins (`if (k < ao) ao = k`), never accumulated — multiplying overlapping spheres "punches black craters into the plating" (:1956). Falloff: full 0.55 darkening inside `0.55r`, linear to 1.0 at `2.2r`. 13 occluders on the reference ship. **Zero runtime cost.**

**(b) Cast shadows — `Shadower{x,y,z,r,part}` (:124), `cast()` (:1738), shader loop (:790–812).** A *chain* of tight spheres laid along the part's own +Z, lifted off the mounting face — because "a fin's shadow is a stripe", not a blob (:1735–1737). Uploaded as `uOcc[28]` (`vec4`) + `uOccPart[28]` (`float`).

The shader loop is worth quoting in full because every line of it is load-bearing:

```glsl
for (int i = 0; i < SHIP_OCC_MAX; i++) {
  vec4 o = uOcc[i];
  vec3 od = o.xyz - P;
  float ot = dot(od, uSunDir);
  float perp = sqrt(max(dot(od, od) - ot * ot, 0.0));
  // penumbra opens with the throw: a star is a disc, not a point
  float soft = o.w * (0.20 + 0.85 * clamp(ot / max(o.w * 7.0, 1e-9), 0.0, 1.0));
  float s = smoothstep(-soft, soft, perp - o.w);
  // empty slot | caster behind the fragment | caster IS this part
  s = mix(1.0, s, step(1e-7, o.w) * step(1e-7, ot)
                  * step(0.5, abs(vPart - uOccPart[i])));
  sunVis = min(sunVis, s);   // nearest caster wins, never multiply
}
```

`uOccPart` exists solely so a fin does not shadow itself — without it every slab self-shadows into a black stripe down its own face.

**Why it matters at all:** the comment at :790–796 is the strongest claim in the file and it is correct. Nothing else on the model interrupts the key light, and without that the fins, mast, pylons and patch plates read as **decals** rather than hardware. There is no shadow map, no extra pass, no permutation.

**Copy:** :110–130, :1728–1752, :790–812.

#### The hard cap, quantified

**Uniform cost.** `uOcc` is 28 `vec4` = 28 uniform vectors. `uOccPart` is `float[28]`, and in the default (non-block) GLSL ES layout every array element occupies a full vec4 register on essentially all drivers — so **28 more**. Total **56 of the fragment shader's uniform vectors** for 28 spheres, i.e. **2 vectors per caster**. Add `uLamp[6]` (6), ~16 scalar/vec3 uniforms, and three's built-in matrices (~20) ⇒ ~98 vectors used.

`GL_MAX_FRAGMENT_UNIFORM_VECTORS` is guaranteed ≥ **224** in WebGL 2 (ES 3.0 minimum) and is 224–512 on the mobile-class GPUs `detectTier` routes to `low`. On a spec-minimum device the ceiling is therefore:

```
(224 − 42 non-occluder) / 2 vectors per caster  ≈  91 casters, absolute maximum
```

Packing four part-ids into one `vec4` and the radius into `uOcc.w` (already done) drops the cost to 1.25 vectors ⇒ ~145. That is the *entire* headroom available to this scheme, on any hardware, ever.

**ALU cost.** The loop body is ≈ 34 ALU ops. At `OCC_MAX = 28` that is **≈ 950 ops per fragment**, unconditionally — the loop has no early-out even though the array is radius-sorted and trailing slots are empty. For comparison the same shader runs 18 `os_snoise` evaluations (:693, 716, 721, 726, 735, 737) at ~200 ops each ≈ 3,600 ops. So the shadow loop is **~26 % of the fragment cost**, not the "rounding error" the comment at :132–135 claims. At 1080p with the hull covering 40 % of frame that is ~0.8 GFLOP/frame, ~48 GFLOP/s at 60 Hz. Fine at 28. Linear in `N`, and there is no spatial culling of any kind.

**The real cap is neither: it is 17 parts.** The reference hull has 17 bolt-ons and consumes **27 of 28 slots**. The eighteenth part silently loses its shadow (the sort at :1429 evicts the smallest radius). Adding a truss, a radiator bank and a docking arm to this ship today would break it.

**Scaling verdict: DOES NOT SCALE. At all.** See §3.1 for what to do instead.

### 2.6 Analytic window lamps — `uLamp[6]` (:641, :872–878, filled :2121–2128)

**What.** Up to six `(x, y, z, strength)` emitters in object space. Each pools warm light on the plating around it:

```glsl
float fall = lp.w * exp(-ldist * 760.0) * max(dot(N, ld / ldist), 0.0);
col += uAmber * albedo * fall * ao;
```

Lamps are placed **0.4 m proud** of the plating (:2122–2124) so the pool has a real solid angle; a source flush with the surface only ever grazes it.

**Why.** "An emitter that lights nothing is a sticker" (:869–871). Equally important: the pools rake *across* the seams and greebles beside them, giving the plating a **second light direction** that the single key cannot provide.

**Limits.** `exp(-ldist·760)` is an e-folding length of **1.32 m** — hard-tuned to a 30 m hull. `uAmber` is a single global colour: the cargo floodlight at :2199 is deliberately *not* registered as a lamp because it is cold and there is no second colour uniform (:2194–2198).

**Scaling verdict: PARTIALLY.** The mechanism is right and cheap (6 iterations, ~12 ops each). The **6-lamp cap and the 1.3 m falloff are 30 m constants.** A 4 km ship has hundreds of lit apertures. Fix: derive falloff from aperture size (`exp(-d / (2·apertureRadius))`), give each lamp a colour, and make the lamp set **per-module** rather than per-ship — bind the ~8 lamps nearest each module's bounding box, not a global list. Also: on a capital ship the lamp pools are the *only* thing that gives scale to a hull surface with no other reference, so this is the technique whose budget you should protect.

### 2.7 The panel GLSL — `PANEL_GLSL` (:543–569)

```glsl
vec3 shipPanels(vec2 q) {
  vec2 g0 = floor(q);  vec2 f0 = q - g0;
  float r = shipHash21(g0 + 11.3);
  vec2 sub = r < 0.36 ? vec2(2.0,1.0) : (r < 0.68 ? vec2(1.0,2.0) : vec2(2.0,2.0));
  vec2 q1 = f0 * sub;  vec2 g1 = floor(q1);  vec2 f1 = q1 - g1;
  vec2 d = min(f1, 1.0 - f1) / sub;
  float line = min(d.x, d.y);
  float id   = shipHash21(g0 * 3.71 + g1 * 1.13 + 5.0);
  float along = d.x < d.y ? q.y : q.x;
  return vec3(line, id, along);       // (dist to seam, panel id, coord along seam)
}
float shipSeam(float d, float w) {
  float e = fwidth(d) * 1.4 + 1e-7;
  return 1.0 - smoothstep(w - e, w + e, d);
}
```

**Why a jittered two-level grid and not worley.** Real hull plating is rectangular and irregular *in size*, not in shape (:539–541). One `floor`, one hash, one of three subdivision patterns. It is about 12 ALU ops.

**The three returned channels are all used:** `.x` seam distance → seam darkening (:754), cavity roughness (:755), bump (:773); `.y` panel id → paint batch (:713–714), rivet gating (:704), amber leak (:865); `.z` coordinate along the seam → rivet spacing (:700), leak breakup (:866).

**Three supporting decisions you must copy with it:**

1. **Triplanar blend is sharpened then normalised** (:666–669): `an = |N|; an = an³; an *= an;` — that is `|N|^6`, near-binary. Seams are *blended* across planes (:685–687) but the **panel id is taken from the dominant plane only** (:694) — "blending ids is mush".
2. **The plane hand-over is noise-warped** (:693): `anj = an + os_fbm(P*210, 2, 2.2, 0.5) * vec3(0.11,-0.07,0.09)`. A clean switch draws a visible lat/long lattice radiating off the nose, where the dominant plane flips fastest. Warping turns that into a ragged butt joint.
3. **Plate size is per-part** (:676–677): `ps = uPanelScale * (1.0 + 0.9 * step(0.5, vPart) * (hash(vPart) - 0.5))` — the fuselage is pinned at exactly `uPanelScale` so the ship keeps one reference plate size; bolt-ons swing ±45 % around it. One panel scale across fuselage, fin, pods and pannier "makes the plating read as one projected texture instead of as sheet metal cut by four yards".

**Absolute numbers.** `uPanelScale = 265` (:1414) ⇒ grid cell **1/265 km = 3.77 m**, subdivided into halves and quarters ⇒ plates of **1.9 × 3.8 m** or **1.9 × 1.9 m**. Seam half-width `0.008` cells = **3.0 cm**, matched to the `2.5e-5 km = 2.5 cm` bump depth at :773. Rivet frequency `rf = 5.0` ⇒ **0.75 m** pitch.

**Copy:** :543–569 verbatim, and :665–706 as the reference consumption. It is *not* in `src/shaders/chunks.ts` and `chunks.ts` is integrator-owned, so copy it into `src/render/ships/ShipMaterial.ts` and say so in your report.

**Scaling verdict: the FUNCTION scales, the SINGLE SCALE does not.** See §5.2 — this is the single biggest material problem at capital scale, and Planet.ts already contains the answer (§2.10).

### 2.8 Curvature-driven edge wear (:656–663, :732–739)

```glsl
float curv = (length(dFdx(N)) + length(dFdy(N)))
           / max(length(dFdx(P)) + length(dFdy(P)), 1e-12);
float edge = clamp(curv * uCurvScale, 0.0, 1.0);   // uCurvScale = 1/2600
```

`|dN/dP|` is a **view-independent** curvature estimate — it spikes on every geometric edge, which is exactly where paint wears through. `uCurvScale = 1/2600` per km means edges with radius of curvature below **0.38 m** qualify.

**The gate is the important part** (:733–736): the estimate saturates on anything small in screen space, so ungated it turns every greeble into bare steel. It is multiplied by `(0.25 + 1.05·wearNoise)` and by `(0.4 + 0.8·vWear)` before a `smoothstep(0.55, 0.95, ·)`.

**Scaling verdict: SCALES.** `curv` is in 1/km and genuinely scale-invariant: a 3 cm plate edge is a 3 cm plate edge on any hull. But the **gating noise frequency** (`os_fbm(P * 1400.0)` = 0.71 m features) is not — see §6.4. Also note this term is a `dFd*` derivative and therefore *screen-space*: at LOD2 and impostor range every edge saturates. Fade `uCurvScale` with the pixel footprint or disable the term below ~100 px of ship coverage.

### 2.9 Vertex-shader-driven volumetric shells (plume / wake / RCS)

**What.** `buildPlume` (:2269) pushes every vertex at the nozzle mouth and carries `aT` (axial 0..1), `aLayer` (0/1), `aDir` (thrust axis) as attributes. `PLUME_VERT` (:1069) does the extrusion:

```glsl
float prof = aT < 0.10 ? mix(0.45, 1.0, aT/0.10)
                       : pow(max(1.0 - (aT-0.10)/0.90, 0.0), 1.35);
vec3 p = position + aDir*(aT*len) + normal*(prof*wid*wob);
```

so length, width, wobble and taper are **three uniforms**, animated for free with zero CPU work and zero geometry rebuild.

**`PLUME_FRAG` (:1109) uses inverse Fresnel** — `shell = pow(abs(dot(N,V)), 1.6)` — so an open cone shell *fades at its silhouette*. That is what makes two triangles' worth of cone read as a volume of gas (:1129–1131).

**`RCS_VERT` (:1221) billboards correctly**: it transforms the real 3D segment `(c + dir·len·0.08) → (c + dir·len)` into view space and derives the screen axis from the projected endpoints (:1238–1251). Billboarding purely in screen space makes a thruster firing towards the camera collapse to nothing instead of to a disc.

**Scaling verdict: SCALES perfectly.** Screen-space effects, constant cost, independent of hull size. The only scale coupling is the uniform values (`SHIP_LENGTH_KM * (0.08 + th*0.62 + …)` at :2426) which are already expressed as fractions of ship length. **Copy this wholesale.** Propulsion agent: this is your template.

### 2.10 From `Planet.ts`: the scale-dependent detail cascade — **the technique the ships system most needs**

`Planet.ts:206–216`:

```glsl
#define OS_W0 420.0   // km
#define OS_W1 46.0
#define OS_W2 5.5
#define OS_W3 0.62
#define OS_W4 0.075
float os_detailFade(float wavelength, float pixelKm) {
  return smoothstep(1.5, 5.0, wavelength / max(pixelKm, 1e-8));
}
```

Five octaves spanning **five and a half decades** of wavelength, each faded in only when its wavelength exceeds ~1.5–5 pixels (`Planet.ts:352–363`). `pixelKm = vDist * uPixelAngle`, where `uPixelAngle = 2·tan(fovY/2) / viewportHeight` is set once per frame from `ViewState` (`Planet.ts:1920–1922`). One number carries the whole screen-space error metric.

The same file also demonstrates:

- **Vertex-side epsilon tracking the pixel footprint** (`Planet.ts:267`): `eps = clamp(dist * uPixelAngle * 1.5, r*3e-6, r*1.5e-3)` — fine normals under the nose, coarse on the limb; sampling finer than a pixel only buys shimmer.
- **A geometric normal kept separate from the micro-relief normal** (`Planet.ts:366–373`): "material is chosen by the *terrain's* slope, not by pebble-scale bumps… a mask driven by pebble-scale bumps is pepper, not geography." **Directly applicable:** a hull's material selection (paint batch, soot mask, heat staining) must read the part-level normal, not the bumped one.
- **An honest bump ceiling** (`Planet.ts:325–340`): past ~15° of shading-only slope that the silhouette does not back up, relief reads as dirt on the lens and self-shadows into salt-and-pepper. Same ceiling applies to `uBump`.
- **LOD from screen error with hysteresis** (`Planet.ts:1362–1365`): `splitPx = targetPatchPixels / (res-1)`, `mergePx = splitPx * 0.62`. Splitting and merging on the same threshold makes a patch flicker while the camera hovers on the boundary. **Any ship LOD must have this 0.62 factor or its equivalent.**
- **Amortised build queue** (`Planet.ts:1881–1903`): highest screen error first, `quality.patchBuildBudget` builds per frame, a missing patch is requested with `err * 1e3` because "a hole is worse than any refinement". **This is the pattern for "never blocking for capital ships"** in BRIEF §6.
- **Slot/node pooling** (`Planet.ts:1643–1686`) with `poolSize` derived from `(1920*1080)/target²`, and **one shared index buffer for every patch** (`Planet.ts:1463–1481`) — the topology is identical, only positions differ, saving ~50 kB of upload per patch.
- **Horizon culling** (`Planet.ts:1799–1814`): a point is behind the limb when `dot(P, V) < occ²`. A 4 km ship is its own occluder for its own far-side greebles; the same test with the hull's inscribed radius works.

---

## 3. Techniques that will not scale, and what to do instead

### 3.1 `uOcc[28]` / `uOccPart[28]` analytic shadows

**Fails at:** ~17 parts, i.e. **immediately**. Already 27/28 on the reference hull. Absolute hardware ceiling ~91 casters on a spec-minimum WebGL2 device (§2.5), and `O(N)` per fragment with no early-out.

**Areal-density arithmetic.** The 30 m hull is ~660 m² of skin (perimeter ≈ 22 m × length 30 m) carrying 27 casters ⇒ **one caster per 24 m²**. Holding that density:

| Ship | Linear × | Area | Casters at equal density |
|---|---:|---:|---:|
| 0.03 km | 1 | 660 m² | 27 |
| 0.15 km | 5 | 16.5 k m² | **690** |
| 1 km | 33 | 733 k m² | **31,000** |
| 4 km | 133 | 11.7 M m² | **500,000** |

**Do instead, in order of preference:**

1. **Bake it.** Extend the per-vertex channel from a scalar `aAO` to a **bent normal + cone aperture** (`vec4 aBent`: xyz = average unoccluded direction, w = cone half-angle). Evaluate `smoothstep` of `dot(aBent.xyz, uSunDir)` against the aperture in the fragment shader. Cost: **4 floats per vertex, ~6 ALU per fragment, independent of part count.** Bake it on the CPU at generation time with a spatial hash; this is the single highest-value change in the whole system. It captures both §2.5a and §2.5b in one channel.
2. **Localise what is left.** Only *large, silhouette-defining* masses need a moving analytic shadow (the ones whose stripe sweeps as the sun moves). Cap that at **8 per module**, selected per-module by bounding-box proximity, and bind them per draw call. `uOcc[8]` = 10 uniform vectors, ~270 ALU.
3. **For LOD0 on capital ships only**, a single 1024² cascaded shadow map from the key direction is cheaper than 400 analytic spheres and is already budgeted: `quality.shadowMapSize` is 0/1024/2048/4096 (`Config.ts:37`) and is currently unused by anything. Read it; do not hard-code.

**Do not** raise `OCC_MAX`. It buys nothing and costs uniform space on exactly the devices that cannot afford it.

### 3.2 Greeble scatter — both the density and the algorithm

**Density.** 240 greebles / 660 m² = **one per 2.75 m²**. At that density a 4 km ship needs **4.25 million instances**. Even restricted to a proximity band: at 1.16 km (the distance at which a 2 m greeble spans 2 px) the visible footprint of a 4 km hull is ~1 km × 1 km = 10⁶ m² ⇒ **364,000 instances still in frame.**

**Algorithm.** `scatterGreebles` (:1973–2085) is `O(attempts × |seats|)` against a single shared linear array (:2029–2037) with `attempts ≤ count × 40`. At 240 that is up to 9,600 × ~120 ≈ **1.15 M distance tests**, plus a nested loop over occluders (:2040–2046). That is already several milliseconds against a 25 ms generation budget. It is `O(n²)`. At 10⁴ instances it is 10⁸ tests.

**Do instead:**

1. **Spatial hash grid** for the rejection test — cell size `2 × maxRadius`, check 27 neighbours. `O(n)`. Non-negotiable above ~500 instances.
2. **Make greebles a per-module, per-LOD-band population.** Generate a *density field* + a deterministic per-cell hash in the blueprint (pure data), and materialise instances only for modules inside the LOD0 band. Same seed ⇒ same instances, but you never build 4 M matrices.
3. **Shift the form hierarchy with the ship.** On a 30 m hull the three form sizes are 30 m / 3 m / 0.3 m. On a 4 km hull they must be 4 km / 200 m / 20 m, with the sub-metre tier appearing **only** inside a proximity band. Greebles are the fourth tier, not the third. BRIEF §8 asks for "large, medium and small forms forming a clear hierarchy" — at 4 km, greebles are not the small form, they are invisible detail.

### 3.3 No LOD, no culling, no impostor

Every mesh sets `frustumCulled = false` (:1468, :1518, :1540, :1564, :1613, :1642, :2068). Correct for a 30 m object that is always the near subject; a fleet of capitals renders every hull in full every frame.

`quality.tier` changes **only** three construction-time integers (:1359–1363). There is no distance-based anything.

**Do instead.** Screen-coverage LOD from `ViewState.fovY` / `viewportHeight`. At `fovY = 50°`, `H = 1080`, a ship of length `L` km at distance `d` km spans

```
pixels ≈ 1157 · L / d
```

Suggested thresholds and the distances they imply:

| Coverage | LOD | 0.03 km | 0.15 km | 1 km | 4 km |
|---|---|---:|---:|---:|---:|
| > 400 px | LOD0 | < 0.087 km | < 0.43 km | < 2.9 km | < 11.6 km |
| 120–400 px | LOD1 | < 0.29 km | < 1.45 km | < 9.6 km | < 38.6 km |
| 30–120 px | LOD2 | < 1.16 km | < 5.8 km | < 38.6 km | < 154 km |
| < 30 px | impostor | beyond | beyond | beyond | beyond 154 km |

Apply the `mergePx = splitPx * 0.62` hysteresis from `Planet.ts:1365`.

**And note the consequence for capital ships:** at 11.6 km a 4 km ship spans 400 px but a 4 m greeble spans **0.4 px**. Whole-ship LOD is the wrong unit. LOD must be **per module**, keyed on each module's own screen coverage — which is another reason not to merge a capital hull into one buffer (§2.3).

### 3.4 Hand-authored `buildParts`

:1755–1945 is 190 lines of literal placement for exactly one ship: a dorsal spine at `t = 0.58`, fins at `0.66`, the pannier at `0.52`, the cockpit at `0.19`, pylons at `0.84`, gear at `0.72` and `0.26`, mast at `0.30`, stabiliser at `0.93`. Seed variation amounts to one coin flip for which side the pannier takes (:1767), a nacelle length ratio (:1828), and 4–6 patch plates.

The comment at :1754 defends this — "a silhouette is not a random walk" — and it is right *for a hero ship*. It is not a generator.

**Do instead.** The socket system in BRIEF §5. `buildParts` is the thing the blueprint replaces. Keep its *judgement* though: the placement constants encode real decisions (gear on the underside, cockpit forward with a view cone, mast off the pannier's side for balance) that BRIEF §5 restates as rules. Mine it for defaults, do not port it.

### 3.5 Object-space noise frequencies

Nine hard-coded cycles-per-kilometre constants authored against a 0.03 km hull. Full list in §6.4. On a 4 km ship every one is **133× too fine** and degenerates into uniform grain — precisely the failure BRIEF §7 says "will be rejected".

**Do instead.** Express every frequency as **cycles per hull length** and multiply by `1/L` at material build, then fade each band with `os_detailFade(wavelength, pixelKm)` (§2.10). And keep the *anisotropy* meaningful: the grime term at :720 uses `vec3(P.x*2400, P.y*2400, P.z*210)`, an 11.4:1 stretch along the flow axis giving ~6 streak periods over the ship's length. Six periods is the design intent; **210 cycles/km is the accident.** Derive it: `zFreq = 6/L`.

### 3.6 CPU AO bake `O(verts × occluders)`

:1951–1967, 640 × 13 = 8.3 k tests today. At 70 k vertices (a 120 k-triangle LOD0) × 2,000 occluders that is **1.4 × 10⁸** — a multi-second stall.

**Do instead.** Same spatial hash as §3.2, plus bake per-module in the blueprint stage so it is cached with the module and shared between ships of a family.

### 3.7 Seven materials per ship

Budget is ≤ 3 (BRIEF §6), shared across a family. Current: hull, greeble, light, nozzle, plume, wake, rcs.

**Do instead.** Three programs:
1. **Surface** — hull + greebles + modules (already one program; two material objects sharing one uniforms object is the correct trick, keep it).
2. **Additive emissive** — lights + plume + wake + RCS collapsed into one additive `ShaderMaterial` with a `float aKind` attribute branching in the fragment shader, exactly as `LIGHTS_FRAG` (:939) already does for running-light vs window.
3. **Nozzle interior** — the only one that genuinely needs `DoubleSide` + `gl_FrontFacing` branching.

Share all three across a family; per-ship variation rides in instance attributes and a small per-ship uniform group, not in new materials.

### 3.8 The `os_dither` at the end of the hull shader

:908, `gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy)` — adds ±1/510 to the output. Today it runs **after** tone mapping and colour space conversion, so it is ±0.002 in *display* space: harmless, and pointless, since the target is half-float.

**The trap:** when you correctly move to `toneMapped: false` and drop `<colorspace_fragment>` (§4.2), that same call becomes ±0.002 in **scene-linear** units against a hull whose base radiance is ~0.01 — a **±20 % noise floor.** Delete it. `FinalPass` (`PostFX.ts:1111`) dithers the frame at the end, which is the only place it belongs.

---

## 4. The material and lighting contract

### 4.1 What the hull shader expects (uniform inventory, :617–641)

| Uniform | Type | Meaning / value on the reference ship |
|---|---|---|
| `uSunDir` | `vec3` | Unit, **ship-local**. Hero shot `(0.40, 0.74, -0.54)`. |
| `uSunColor` | `vec3` | Linear RGB **pre-multiplied by intensity**. Hero: `(1.0,0.93,0.82) × 3.0`. |
| `uCameraLocal` | `vec3` | Camera in ship-local km. Aliases a live `Vector3` — never copied per frame (:2416). |
| `uFill` | `vec3` | Planetshine, **not ambient**. Default `(0.010,0.014,0.022)`; hero `(0.11,0.14,0.22)`. |
| `uPaint`, `uPaintAlt` | `vec3` | Linear. HSL lightness 0.05–0.095 / 0.035–0.13, saturation 0.22–0.45. |
| `uMetal` | `vec3` | `(0.20,0.21,0.235)` — dull oxidised steel, *close to the paint's value* or every worn edge reads as a highlight (:1401–1403). |
| `uAmber` | `vec3` | `(1.0,0.52,0.13)`. Drives seam leak **and** all lamp pools. |
| `uPlumeColor` | `vec3` | Lerped per frame `(0.16,0.36,1.0) → (1.0,0.88,0.75)` (:2437–2439). |
| `uEngineA/B` | `vec3` | Two engine mouths. Fake plume lighting. |
| `uFlowDir` | `vec3` | Re-entry flow, `(0,0,-1)`. |
| `uTime`, `uThrottle`, `uHeat` | `float` | |
| `uPanelScale` | `float` | **265** ⇒ 3.77 m cells. |
| `uCurvScale` | `float` | **1/2600** ⇒ edges below 0.38 m radius wear. |
| `uGrime` | `float` | 0.55–0.95, per ship. |
| `uBump` | `float` | 0.45. |
| `uOcc[28]`, `uOccPart[28]`, `uLamp[6]` | arrays | §2.5, §2.6. |

**Defines** (:1442–1450): `SHIP_GRIME_OCTAVES` 2 (low) / 4, `SHIP_OCC_MAX`, `SHIP_LAMP_MAX`, plus `SHIP_RIVETS` and `SHIP_BUMP` only above `low`.

**Lighting model** (:814–860), for reference — one key, no ambient:

- GGX `D`, Smith-Schlick `G` with `k = a/2`, Schlick `F`, `a = max(rough², 0.0025)`.
- `metalness = mix(0.16, 0.88, bare)` — **never 1.0**, because a fully metallic fragment has no diffuse and with no environment to reflect, every worn edge renders as a black fleck (:741–744).
- `rough = mix(mix(0.46, 0.30, bare), 0.86, dirt)` — undirtied paint stays under ~0.6 or the specular lobe is too wide to lift anything off the silhouette.
- **No `1/π` on diffuse** (:831–833): `uSunColor` is authored as irradiance with π already folded in. Match this or your ship will be π× darker than the hero.
- **Environment term is mandatory** (:836–847). The comment is worth heeding: its absence "is not a 'too dark' problem, it is a missing integral". Planetshine hemisphere + a `pow(dot(R, sunDir), 5)` glare halo, with a split-sum Fresnel that never falls below `F0`.
- **Planetshine arrives from below** (:849–851): `(0.25 + 0.75·(-N.y*0.5+0.5))`. It fills the belly and leaves the shadowed upper flank properly black.
- **Grazing sheen** (:853–860): `pow(1-NoV, 4)` gated by `smoothstep(-0.30, 0.30, N·sunDir)` and rationed by `(1 - 0.65·dirt)`. This is the silver lining, and it is the cheapest thing that stops a hull reading as unfired clay. Soot has no lining.

### 4.2 What the grade does downstream — and the two things you must change

The frame path is `PostFX.ts`: `RenderPass → SceneSpacePass → LuminancePass → BloomPass → GradePass → FinalPass`, with the scene rendered into a **HalfFloat, `RGBAFormat`, `NoColorSpace`** target (`PostFX.ts:1280–1288`).

**(1) `logdepthbuf` is mandatory.** `Engine.ts:97` sets `logarithmicDepthBuffer: true`. three implements it by writing `gl_FragDepth` from a varying set in `logdepthbuf_vertex`. A material that omits the chunks never writes `gl_FragDepth`, so the hardware keeps the interpolated `gl_Position.z/w` — a **linear** value compared against everybody else's **logarithmic** one. The comparison is meaningless and geometry sorts wrongly. `Planet.ts:218–224` records the exact symptom this cost: *"the far half of the ring does not go behind the planet."*

Required, all four:
```glsl
// vertex
#include <logdepthbuf_pars_vertex>
  … gl_Position = …;
  #include <logdepthbuf_vertex>
// fragment
#include <logdepthbuf_pars_fragment>
void main() { #include <logdepthbuf_fragment>  … }
```
`logdepthbuf_vertex` calls `isPerspectiveMatrix()` from `<common>`. `Ship.ts` pulls all of `<common>` (:572, :611) — which also supplies `PI`, used at :824. `Planet.ts:231` instead declares the one function by hand to avoid name collisions. Either is fine; pick deliberately.

Two consequences nobody has written down yet:
- Writing `gl_FragDepth` **disables early-Z** for that draw. A 4 km ship with heavy overdraw pays full fragment cost on hidden pixels. Order your draws front-to-back and keep the expensive hull shader off transparent passes.
- `SceneSpacePass` reconstructs view position as `exp2(d * uLogFar) - 1.0` (`PostFX.ts:213–215`). A material that writes linear depth also **corrupts SSAO and motion blur** for its own pixels.

**(2) `toneMapped: false`, and no in-material colour conversion.** This is the bug in `Ship.ts` and the most important line in this document.

`Engine.ts:107` sets `renderer.toneMapping = ACESFilmicToneMapping`. three computes the program's `TONE_MAPPING` define as `material.toneMapped ? renderer.toneMapping : NoToneMapping`. `ShaderMaterial` defaults `toneMapped` to **true**, and `Ship.ts` never overrides it, while every other renderer in the project does:

```
Planet.ts:1460,1546,1628   Atmosphere.ts:993,1012,1029   Clouds.ts:898,911,1346
Nebula.ts:1222,1279        Sky.ts:803,848,870,890        Rings.ts:883
```

So `Ship.ts`'s `#include <tonemapping_fragment>` (:906, :975, :1064, :1147, :1216, :1280) **is live**: the hull ACES-tone-maps itself, clamping output to ~1.0, and then `GradePass` ACES-tone-maps the result a second time (`PostFX.ts:1044`). Two consequences:

- **The hull can never exceed 1.0**, and `BloomPass.threshold = 1.0` (`PostFX.ts:585`), so **no part of the ship can ever bloom** — not the windows at `uIntensity = 5.0`, not the RCS at 5.5, not the plume. They are all clamped before post ever sees them.
- Double tone-mapping crushes the mid-tones the noir curve is authored against.

`<colorspace_fragment>` is currently a no-op because the render target is `NoColorSpace`, but it would sRGB-encode if the ship were ever drawn straight to the canvas. Drop it too.

> **New ship materials: `toneMapped: false`, no `<tonemapping_fragment>`, no `<colorspace_fragment>`, no `os_dither`. Output scene-linear HDR radiance.**

**(3) The numbers your radiance must land between.**

*Metering* (`LuminancePass`, `PostFX.ts:381–438`): geometric mean of log2 luminance, centre-weighted (`mix(0.25,1.0,·)` inside 0.1–0.55 of frame radius), clamped to `[3e-3, 24]`, and **subject-weighted**: `uSubject = (2.5e-3, 7.5e-3, 0.02)` — a tap below 2.5e-3 scene-linear counts as void and keeps only 2 % weight. The comment names the reference points: *a nebula filament sits around 0.02, a hull in planetshine around 0.01.* Adaptation τ = 1.1 s closing / 2.2 s opening.

*Iris* (`PostFX.ts:1035`): `ev = clamp(0.25 · 2^(-0.65 · logAvg), 0.15, 12)`. Only 65 % of the metered error is corrected, on purpose — auto-exposure is a correction on top of an authored key, not a replacement for one.

**⇒ A hull's lit plating should land in roughly `0.005 … 0.5` scene-linear.** Below 0.005 the meter calls it void and the grade crushes it; above ~1.0 it blooms and stops being plating.

Check against the reference: `albedo ≤ 0.13 × sunColor 3.0 × NoL 1.0 ≈ 0.4`. Correct — plating does not bloom. Emitters at `uIntensity 5.0–5.5` do.

*Bloom* (`PostFX.ts:580–600`): `threshold = 1.0` **scene-linear, pre-exposure** (a property of the surface, not the iris), `knee = 0.55`, 6 mips at high, upsample taper 0.72. Anamorphic streak only above **2.5**, off mip 1, 17 % of frame width, blue-shifted per channel. *"Set low and every warning light in the cockpit grows a flare and the frame turns to soup."*

*Grade* (`PostFX.ts:1044–1075`), in order: ACES → linear→sRGB → contrast **1.3** about pivot **0.36** → hyperbolic shoulder from **0.56** asymptoting to **0.95** → black lift `0.03·(1-c)³` (toe only) → saturation `mix(0.42, 0.95, smoothstep(0,0.55,luma))` → split tone, shadows **cool** `(0.84,0.97,1.14)`, highlights **warm** `(1.12,1.0,0.84)`, released to neutral white above luma 0.78 → elliptical vignette strength **0.62** from inner radius **0.26**, 1.22 vertical ellipse.

Four things that follow directly, and that your material must be authored around:

1. **Shadow saturation is 0.42.** Nearly half the chroma is stripped from anything dark. This is why `Ship.ts:1384–1386` warns that HSL saturation below ~0.2 comes out indistinguishable from grey. Over-saturate your paint.
2. **Shadows are tinted cool by the grade already.** Do not add blue in the material; you will double it.
3. **Highlights above luma 0.78 go neutral.** A specular on a hull reads white, not warm. Do not fight it.
4. **Vignette costs up to 62 % at the frame edge.** Composition matters: keep the ship's readable mass inside ~0.5 of frame radius.

*SSAO / motion blur* (`PostFX.ts:192–196`), and this is a genuinely useful discovery for the capital-ship work: `uAo = (0.05 km world radius, 0.04 bias, 0.9 intensity, 60 km fade)` and `uMotion.z = 0.25 km near cutoff`.

- A **50 m** AO radius is larger than the entire reference ship, so screen-space AO does nothing useful on a 30 m hull — which is exactly why `aAO` and `uOcc` had to exist.
- On a **1–4 km** hull a 50 m radius is a perfectly sensible structural-crevice scale. **Capital ships get real SSAO for free**, at `high` and `ultra` only (`quality.ambientOcclusion`). Budget your baked occlusion accordingly and do not double it.
- A 30 m ship at hero framing (87 m) sits inside the 250 m motion-blur cutoff and is never blurred; a 4 km ship at 11 km **is**. Fast capital-ship passes will smear — check it.

### 4.3 The renderer API contract (ARCHITECTURE §10)

`Ship` does **not** conform, and the new system must:

| ARCHITECTURE §10 | `Ship.ts` |
|---|---|
| `constructor(spec, quality)` | `constructor(seed: number, quality)` — takes a seed, generates internally |
| `update(dt, ctx, view: ViewState)` | `update(dt, ctx, state: ShipState)` — no `ViewState` at all |
| Light comes from `ViewState` | Public mutable fields `sunDirection`, `sunColor`, `fillColor` that the caller writes into (:1305–1309) |
| Never mutates its spec | n/a — has no spec |

`ViewState` (`src/render/ViewState.ts`) carries `cameraLocal`, `sunDirection`, `sunColor`, `distance`, `time`, **`fovY`** and **`viewportHeight`**. The last two are what every LOD decision in §3.3 needs; use them, do not read the camera.

`ShipState` (:50–62) is a genuinely good little contract — `throttle`, `boost`, `heating`, `rcs: Vector3` in ship-local — and should survive as a separate input alongside `ViewState`, not folded into it.

---

## 5. Scale analysis

Reference: `L = 0.03 km`, `MAX_R = 0.0042 km` (beam 8.4 m, `r/L = 0.14`), skin area ≈ 660 m².

Screen coverage at `fovY = 50°`, `H = 1080`: `pixels ≈ 1157 · L / d`.

### 5.1 Geometry — what does and does not grow

| | 0.03 km | 0.15 km | 1 km | 4 km |
|---|---:|---:|---:|---:|
| Linear × reference | 1 | 5 | 33 | 133 |
| Skin area | 660 m² | 16.5 k m² | 733 k m² | 11.7 M m² |
| **Radial segments** (silhouette < 1 px at hero framing) | 28 | 28 | 28 | 28 |
| **Longitudinal rings** (≈ 5 × aspect) | 22 | 24 | 40 | 50–64 |
| Lofted hull triangles | 1.2 k | 1.3 k | 2.2 k | 3.2–4.1 k |
| Structural modules (sockets) | 17 | 25–35 | 60–90 | 120–200 |
| Tris/module for a 120 k LOD0 budget | — | ~3 k | ~1.2 k | ~600 |
| **LOD0 triangles** | 16 k | 40 k | 100 k | 120 k (cap) |
| LOD1 (≤ 25 k) | 6 k | 12 k | 22 k | 25 k |
| LOD2 (≤ 3 k) | 1.5 k | 2 k | 3 k | 3 k |
| Draw calls LOD0 (≤ 12) | 11 | 12 | 12 | 12 |

**The headline:** cross-section resolution is scale-invariant, so the hull itself is essentially free at any size (4 k triangles for a 4 km ship). What grows is the **module count**, and the 120 k triangle ceiling divided by module count is what actually constrains a capital ship: **~600 triangles per module.** That is a box with a chamfer and a couple of fittings. Everything else must be shader.

**Draw calls do not have room to grow.** 12 at LOD0 for a 4 km ship with 200 modules means ~17 modules per draw call — modules must be batched by material into merged buffers *at the LOD level*, with instancing for repeated ones. The current single-merged-buffer approach (§2.3) gets you 1 draw call but forbids per-module culling; the right shape is **one merged buffer per LOD band**, ~6–8 of them, plus 3–4 instanced greeble/fitting families.

### 5.2 Panel density — the material's hard problem

`uPanelScale = 265` ⇒ 3.77 m cells ⇒ 1.9–3.8 m plates; seam half-width 3.0 cm.

**Holding 265 constant** (what the code does today), the screen size of a plate when the ship spans a 1920 px frame:

| `L` | plate | px/plate | px/seam (0.008 cells) |
|---|---:|---:|---:|
| 0.03 km | 3.8 m | **241** | 1.9 |
| 0.15 km | 3.8 m | **48** | 0.39 |
| 1 km | 3.8 m | **7.2** | 0.058 |
| 4 km | 3.8 m | **1.8** | 0.014 |

Below ~2 px/plate the grid is pure moiré; below ~1 px/seam the `fwidth` antialiasing in `shipSeam` is doing all the work and the seam is a grey wash. **A 4 km ship rendered with today's constant is a vibrating checkerboard.**

**Fix, part 1 — derive plate size from hull dimensions,** as BRIEF §7 demands. Real shipbuilding uses bigger plates on bigger hulls but sub-linearly; `≈ L^(1/3)` matches practice (12 m standard plate on a 300 m vessel):

```
plateMetres ≈ 3.8 · (L_metres / 30)^(1/3)
uPanelScale = 1000 / plateMetres      // cycles per km
```

| `L` | plate | `uPanelScale` | px/plate at full-frame |
|---|---:|---:|---:|
| 0.03 km | 3.8 m | 265 | 241 |
| 0.15 km | 6.5 m | 154 | 83 |
| 1 km | 12.2 m | 82 | 23 |
| 4 km | 19.4 m | 52 | 9.3 |

Better, still not enough at 4 km.

**Fix, part 2 — a cascade, not a scale.** Copy `Planet.ts`'s `OS_W0..OS_W4` + `os_detailFade` (§2.10). Three tiers of plating, each faded by pixel footprint:

| Tier | wavelength | 4 km ship at full frame | 30 m ship at full frame |
|---|---|---:|---:|
| **Hull sections** | `L/20` = 200 m | 96 px ✓ | 1.5 m, 96 px ✓ |
| **Structural bays** | `L/200` = 20 m | 9.6 px ✓ | 0.15 m — faded out |
| **Plates** | derived, 19.4 m / 3.8 m | 9.3 px / 241 px | ✓ |
| **Rivets / lips** | 0.75 m | 0.36 px — faded out | 48 px ✓ |

Feed `pixelKm = distance · uPixelAngle` where `uPixelAngle = 2·tan(view.fovY/2) / view.viewportHeight`, exactly as `Planet.ts:1920`. Each tier costs ~12 ALU and is skipped entirely by the `smoothstep(1.5, 5.0, ·)` gate when it cannot be seen. **This also solves LOD1/2 for free:** at 120 px coverage only the hull-section tier survives, which is what you want.

**Fix, part 3 — noise frequencies.** All nine constants in §6.4 become `cycles-per-hull-length ÷ L`, faded the same way. Specifically the grime anisotropy: today `(2400, 2400, 210)` gives 6 streak periods along a 30 m hull. Preserve the intent — `zFreq = 6/L`, `xyFreq = 70/L` — not the number.

### 5.3 Detail-element budgets

| | 0.03 km | 0.15 km | 1 km | 4 km |
|---|---:|---:|---:|---:|
| Skin area | 660 m² | 16.5 k m² | 733 k m² | 11.7 M m² |
| Greebles at reference density (1 / 2.75 m²) | 240 | 6 k | **266 k** | **4.25 M** |
| Greebles affordable at LOD0 (60 k tris ÷ 40 t) | 240 | 800 | 1.5 k | 1.5 k |
| ⇒ effective areal density | 1 / 2.75 m² | 1 / 21 m² | 1 / 490 m² | 1 / 7,800 m² |
| Cast-shadow casters at reference density | 27 | 690 | 31 k | 500 k |
| Casters affordable (§3.1 option 2, 8/module) | 27 | 280 | 720 | 1,600 |
| Lamps at reference density (5 / 660 m²) | 5 | 125 | 5.5 k | 89 k |
| Lamps affordable (8 per module, per-draw bound) | 6 | 280 | 720 | 1,600 |

**Read the third row.** Areal greeble density must fall by **3,000×** from a 30 m courier to a 4 km capital. That is the quantitative proof that greebles cannot be the detail strategy at capital scale — panel/normal/wear detail in the fragment shader must carry it, and geometric detail is reserved for module-scale forms (§3.2 point 3).

**Proximity band, for capital ships.** A 2 m greeble spans ≥ 2 px only within `d < 1157 × 0.002 / 2 = 1.16 km`. At that distance a 4 km hull's visible footprint is ~1 km × 1 km. So the correct rule is: **materialise sub-metre detail only for modules whose own screen coverage exceeds ~120 px**, cap it at ~2,000 instances per module, and stream it in through an amortised build queue (`quality.patchBuildBudget`, `Planet.ts:1881`) so a capital ship never blocks.

### 5.4 Generation time (BRIEF §6: ≤ 25 ms medium hull, never blocking for capitals)

| Stage | 0.03 km today | Complexity | 4 km if unchanged |
|---|---|---|---|
| `HullShape` + `buildFuselage` | < 0.5 ms | `O(rings × radial)` | < 1 ms ✓ |
| `buildParts` | < 0.5 ms | `O(parts)`, allocates a `Vector3`/`Matrix4` per call (:1712–1713, :1749) | ~10 ms at 200 modules, GC-heavy |
| `applyContactAO` | ~0.1 ms | **`O(V × occ)`** | 1.4 × 10⁸ ⇒ **seconds** |
| `scatterGreebles` | **3–6 ms** | **`O(attempts × seats)`** | 10¹³ ⇒ never finishes |
| `computeNormals` + `toGeometry` | ~1 ms | `O(tris)` + one full array copy | ~15 ms, plus `number[]` boxing |
| **Total** | **≈ 8–15 ms** | | unbounded |

At 30 m the reference already spends **a third to half** of the 25 ms budget, and almost all of it in one `O(n²)` loop. Fix `scatterGreebles` and `applyContactAO` with a spatial hash (§3.2, §3.6) before anything else; then amortise module building across frames for anything above ~0.5 km.

---

## 6. What the new system must not inherit

Everything here is a hard-coded assumption about a single 30 m hull.

### 6.1 Module-level constants that are read directly, not passed

`SHIP_LENGTH_KM = 0.03` (:65), `HALF = 0.015` (:67), `MAX_R = 0.0042` (:69). Read directly by `HullShape` (:466–470), `buildParts` (every line of :1755–1945), `buildLights` (:2156–2199), `buildNozzles` (:2219–2221), `buildWake` (:2329), `update()` (:2426–2472), and the hero shot. **Not one of them is a parameter.** Any port must thread hull dimensions through as constructor arguments.

### 6.2 The parts list is a ship, not a system

`buildParts` (:1755–1945): 190 lines of literal `t`/`theta`/size placement for one vessel (§3.4). `buildThrusters` (:2360) has a fixed 10-entry `spots` table. `buildLights` (:2092) has 16 hand-placed quads with absolute km sizes.

### 6.3 Exactly two engines

`uEngineA` / `uEngineB` (:1406–1407), filled as `enginePos[1] ?? enginePos[0]` (:1648–1649). A four-engine capital or a single-drive courier both break the hull's plume lighting.

### 6.4 Nine object-space noise frequencies in cycles-per-km

| Line | Expression | Feature size | Purpose |
|---|---|---:|---|
| :693 | `os_fbm(P * 210.0, 2, …)` | 4.76 m | triplanar hand-over warp |
| :716 | `os_fbm(P * 90.0, 3, …)` | 11.1 m | macro paint variation |
| :720 | `vec3(P.x*2400, P.y*2400, P.z*210)` | 0.42 m / 4.76 m | grime streaks (11.4:1 anisotropy, 6 periods over the hull) |
| :726 | `sp * vec3(3.1, 3.1, 1.7)` | 0.14 m | fibres inside the streaks |
| :735 | `os_fbm(P * 1400.0, 3, …)` | 0.71 m | wear gating noise |
| :737 | `os_fbm(P * 820.0, 3, …)` | 1.22 m | paint chips |
| :898 | `os_snoise(P * 600.0 + …)` | 1.67 m | re-entry flicker |
| :1029 | `os_fbm(vPos * 2400.0, 2, …)` | 0.42 m | nozzle rib phase wobble |
| :1038 | `os_fbm(vPos * 1600.0, 3, …)` | 0.63 m | nozzle soot |
| :1059 | `os_snoise(vPos * 900.0 + …)` | 1.11 m | throat turbulence |

All authored against `L = 0.03 km`. Every one is 133× too fine on a 4 km hull.

### 6.5 Distance constants in the lighting terms

`exp(-ldist * 760.0)` (:876) — lamp pool e-folding **1.32 m**. `exp(-da * 260.0)` / `exp(-db * 260.0)` (:889–890) — plume wash e-folding **3.85 m**. `2.5e-5` km bump height (:773) — 2.5 cm, physically right and probably the one constant that *should* stay absolute, but `uBump = 0.45` and the gradient clamp `1.8` (:784) are tuned against it.

### 6.6 The hand-allocated `aPart` id namespace

Fuselage/caps 0, bolt-ons 2–15, patches `16+i` → 21, nacelle hardware 33/34, greebles `40 + rng.int(0,11)` → 40–51. The comment at :2059–2062 documents a real collision fixed by hand. Since `vPart` picks **plate scale, panel offset, paint batch and shadow self-rejection**, an id collision is a visible bug, not a warning. Replace with a monotonic allocator.

**And the varying-interpolation constraint from §2.4:** `vPart` is a `varying`. Two parts that **share vertices** blend their ids across every triangle in between, smearing plate scale and paint. The nose cap at :1682–1684 is forced to part 0 for exactly this reason. Your builder must guarantee that a part boundary is also a vertex split.

### 6.7 Structural / architectural assumptions

- **`frustumCulled = false`** on all 7 mesh types (§3.3).
- **No LOD, no impostor, no dispose-on-distance.** `quality.tier` changes three integers at construction and nothing else.
- **`HullShape` is one topological cylinder.** No trusses, no holes, no catamarans, no rotating rings, no drum stacks.
- **`Ship` violates ARCHITECTURE §10** (§4.3): wrong `update()` signature, no `ViewState`, public mutable lighting fields.
- **Seven materials** (§3.7).
- **`toneMapped` left true + `<tonemapping_fragment>`** (§4.2) — the one thing in this file that is simply a defect. Do not copy it forward.
- **The `os_dither` call at :908** becomes a 20 % noise floor the moment you fix the above (§3.8).
- **`registerShipShots` hard-codes seed `0x5eed1701`** (:2555) and a full hero camera rig (`HERO_CAM_DIST = 0.078 km`, `fov = 22`, `HERO_ROLL = 0.34`, NDC offsets 0.16/0.12, :2505–2527). The composition *logic* is excellent and worth copying — camera placed in ship-local space then rotated into world; roll about the view axis to buy a diagonal for free; aim past the subject by half-extents so offsets read directly in NDC; spool the drive for 12 × 0.25 s before capture because every visible value is critically damped (:2620–2624). The *numbers* are 30 m numbers: express them as multiples of hull length.
- **The header comment at :17 is stale** — 11 draw calls, not 10; 9 coasting, not 8.

---

## 7. Quick reference — what to import, what to copy

**Import (real, exported, stable):**

```ts
import { Rng, hashSeed, hash3, rngFrom } from '@/math/rng';
import { registerShaderChunks } from '@/shaders/chunks';   // then #include <onespace_noise|color|atmosphere>
import type { QualitySettings, QualityTier } from '@/core/Config';
import type { ViewState } from '@/render/ViewState';
import { registerShot } from '@/game/Shots';
import type { EngineContext } from '@/core/Engine';
import type { Vec3, RGB } from '@/gen/types';   // units: km, seconds, linear RGB
```

**Copy (module-private in `Ship.ts`, cannot be imported):**

| Symbol | Lines | Goes to |
|---|---|---|
| `clamp01`, `smoothstep`, `damp` | 89–104 | wherever needed |
| `class HullBuilder` | 146–228 | `render/ships/volumes.ts` |
| `pushLocal`, `mountAO`, `addBox`, `addCylinder` | 237–357 | `render/ships/volumes.ts` |
| `greebleHatch/Bracket/Ribbed/Stack/Pipe` + `env` table | 374–416, 1985–1994 | `render/ships/greebles.ts` |
| `interface HullRing`, `class HullShape` | 422–530 | `render/ships/volumes.ts` |
| `place()` (mounting-frame construction) | 1704–1726 | `render/ships/volumes.ts` |
| `PANEL_GLSL` | 543–569 | `render/ships/ShipMaterial.ts` |
| `HULL_VERT` / `HULL_FRAG` (as a starting point, with §4.2 fixes) | 571–910 | `render/ships/ShipMaterial.ts` |
| `LIGHTS_*`, `NOZZLE_*`, `PLUME_*`, `WAKE_*`, `RCS_*` | 912–1283 | `render/ships/propulsion.ts` |
| `buildPlume`/`buildWake`/`buildNozzles`/RCS setup | 2212–2386 | `render/ships/propulsion.ts` |

**Copy from `Planet.ts` (also module-private):**

| Symbol | Lines | Why |
|---|---|---|
| `DETAIL_GLSL` / `os_detailFade` + the `OS_W*` cascade | 206–216, 352–363 | §5.2 — the answer to panel scale |
| `uPixelAngle` derivation | 1920–1922 | one number for every screen-space decision |
| `splitPx` / `mergePx` hysteresis | 1362–1365 | §3.3 |
| Amortised build queue (`request`/`processBuilds`) | 1816–1903 | "never blocking for capital ships" |
| Horizon culling test | 1799–1814 | a capital ship occludes its own far side |
| Shared index buffer across patches | 1463–1481 | modules of identical topology |

**Read but do not copy:** `buildParts` (:1755–1945) — mine it for placement judgement, then delete it. It is a ship, not a system.