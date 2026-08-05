// THROWAWAY verification harness for src/render/Atmosphere.ts. Delete after use.
import {
  ACESFilmicToneMapping,
  Color,
  DepthTexture,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  SphereGeometry,
  UnsignedIntType,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { AtmosphereRenderer, registerAtmosphereShots } from '@/render/Atmosphere';
import { MutableViewState } from '@/render/ViewState';
import { config } from '@/core/Config';
import { setShot, shotNames } from '@/game/Shots';
import type { PlanetSpec } from '@/gen/types';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = new WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.setSize(960, 540, false);
const camera = new PerspectiveCamera(62, 960 / 540, 0.05, 1e12);
const scene = new Scene();

const planet: PlanetSpec = {
  id: 'chk', seed: 1234, name: 'CHECK', type: 'terran',
  radius: 6120, mass: 1, gravity: 9.4,
  orbit: { semiMajorAxis: 1.5e8, eccentricity: 0, inclination: 0, longitudeOfAscendingNode: 0, argumentOfPeriapsis: 0, meanAnomalyAtEpoch: 0, period: 3e7 },
  rotationPeriod: 86400, axialTilt: 0.4, temperature: 280,
  terrain: { frequency: 9, octaves: 10, lacunarity: 2, gain: 0.6, amplitude: 12, ridged: 0.5, warp: 0.4, craters: 0.1, sharpness: 1, seaLevel: 0.4 },
  palette: { low: [0.05, 0.06, 0.07], mid: [0.22, 0.19, 0.15], high: [0.3, 0.28, 0.26], peak: [0.8, 0.8, 0.82], cliff: [0.15, 0.14, 0.13], polar: [0.7, 0.75, 0.8], accent: [0.4, 0.3, 0.18] },
  atmosphere: { scaleHeight: 8.5, thickness: 110, rayleigh: [0.0058, 0.0135, 0.0331], mie: 0.0021, mieAnisotropy: 0.76, intensity: 1, pressure: 1 },
  clouds: null, ocean: null, rings: null, moons: [], bands: null,
  interest: 0.5, blurb: '', isMoon: false,
};

const t0 = performance.now();
const atmo = new AtmosphereRenderer(planet, config.quality);
const lutMs = performance.now() - t0;
scene.add(atmo.object3d);

// Stand-in ground so the extinction pass has something to multiply.
const ground = new Mesh(
  new SphereGeometry(planet.radius, 256, 128),
  new MeshBasicMaterial({ color: new Color(0.35, 0.28, 0.2) }),
);
scene.add(ground);

// A separate target with a depth texture so the depth path is exercised too.
const rt = new WebGLRenderTarget(960, 540);
rt.depthTexture = new DepthTexture(960, 540, UnsignedIntType);

registerAtmosphereShots(planet, atmo.object3d, new Vector3(1, 0.16, 0.34));

const view = new MutableViewState();
const sunDir = new Vector3(1, 0.16, 0.34).normalize();
const sunColor = new Color(1.0, 0.955, 0.9).multiplyScalar(2.3);
const camLocal = new Vector3();

const ctx = {
  renderer, scene, camera,
  input: null as unknown as never,
  origin: null as unknown as never,
  quality: config.quality,
  elapsed: 0, frame: 0, width: 960, height: 540,
};

let frame = 0;
let useDepth = true;
const errors: string[] = [];
function step(): void {
  frame++;
  camLocal.copy(camera.position);
  view.set(camLocal, sunDir, sunColor, frame / 60, (62 * Math.PI) / 180, 540);

  // Pass 1: depth prepass into rt so the depth texture is populated.
  atmo.setDepthTexture(null);
  atmo.object3d.visible = false;
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  atmo.object3d.visible = true;

  atmo.setDepthTexture(useDepth ? rt.depthTexture : null);
  atmo.update(1 / 60, ctx as never, view);
  renderer.render(scene, camera);

  const gl = renderer.getContext();
  const e = gl.getError();
  if (e !== 0 && errors.length < 8) errors.push(`glError 0x${e.toString(16)} at frame ${frame}`);
}

async function main(): Promise<void> {
  const names = shotNames();
  const report: Record<string, unknown> = { lutMs, shots: names };
  for (const n of names) {
    await setShot(n, ctx as never);
    for (let i = 0; i < 4; i++) step();
    // Read the centre pixel so we can tell "renders" from "renders black".
    const px = new Uint8Array(4);
    const gl = renderer.getContext();
    gl.readPixels(480, 270, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    report[n] = [px[0], px[1], px[2]];
  }
  // Camera high above, sun to the side — sanity for the outside/orbit path.
  camera.position.set(0, 0, planet.radius * 3);
  camera.lookAt(0, 0, 0);
  for (let i = 0; i < 4; i++) step();

  report.errors = errors;
  report.programs = renderer.info.programs?.length ?? -1;
  const w = window as unknown as Record<string, unknown>;
  w.__shot = async (n: string, showGround = true, depth = true): Promise<void> => {
    ground.visible = showGround;
    useDepth = depth;
    await setShot(n, ctx as never);
    for (let i = 0; i < 4; i++) step();
  };
  w.__atmo = report;
  w.__atmoDone = true;
}
void main();
