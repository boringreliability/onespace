/**
 * Module registry — the single place that decides what the game is made of.
 *
 * Kept separate from `main.ts` so the boot sequence stays readable and so the
 * integration order is explicit and reviewable in one screen.
 *
 * NOTE: this file is rewritten as subsystems land. Until then it stands up a
 * minimal scene so the render pipeline, build and screenshot harness can be
 * verified end to end.
 */

import {
  BackSide,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  Points,
  PointsMaterial,
  ShaderMaterial,
  SphereGeometry,
} from 'three';

import type { Engine, EngineContext, GameModule } from '@/core/Engine';
import { Rng } from '@/math/rng';
import { registerShot, updateActiveShot } from '@/game/Shots';

export type ProgressFn = (progress: number, status: string) => void;

/**
 * Placeholder scene: a dithered gradient void plus a deterministic starfield.
 * Exists only to prove the pipeline; replaced by Sky/Nebula/Star modules.
 */
class BootstrapScene implements GameModule {
  readonly name = 'bootstrap-scene';
  private stars?: Points;
  private void?: Mesh;

  init(ctx: EngineContext): void {
    const rng = new Rng('onespace-bootstrap');
    const count = 12000;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = rng.onSphere();
      const r = 9e5;
      pos[i * 3] = x * r;
      pos[i * 3 + 1] = y * r;
      pos[i * 3 + 2] = z * r;
      const t = rng.power(0.15, 1, -2.2);
      const warm = rng.next();
      col[i * 3] = t * (0.7 + warm * 0.3);
      col[i * 3 + 1] = t * 0.8;
      col[i * 3 + 2] = t * (1.0 - warm * 0.2);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    // Screen-space sizing: at 9e5 km an attenuated point collapses below a
    // pixel. Stars are effectively at infinity, so a fixed pixel size is both
    // cheaper and more correct.
    this.stars = new Points(
      g,
      new PointsMaterial({
        size: 2.2,
        sizeAttenuation: false,
        vertexColors: true,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -900;
    ctx.scene.add(this.stars);

    // A large inverted sphere carrying a graded, dithered void colour.
    const mat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {},
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        #include <onespace_color>
        varying vec3 vDir;
        void main() {
          float h = vDir.y * 0.5 + 0.5;
          vec3 c = mix(vec3(0.004, 0.007, 0.012), vec3(0.012, 0.018, 0.030), h);
          gl_FragColor = vec4(os_dither(c, gl_FragCoord.xy), 1.0);
        }
      `,
    });
    this.void = new Mesh(new SphereGeometry(1e6, 32, 16), mat);
    this.void.frustumCulled = false;
    // Drawn before the stars so it acts as a backdrop rather than a lid.
    this.void.renderOrder = -1000;
    ctx.scene.add(this.void);
  }

  update(dt: number, ctx: EngineContext): void {
    // Slow drift so the placeholder is visibly alive.
    ctx.camera.rotation.y += dt * 0.02;
  }

  dispose(): void {
    this.stars?.geometry.dispose();
    (this.stars?.material as PointsMaterial | undefined)?.dispose();
    this.void?.geometry.dispose();
    (this.void?.material as ShaderMaterial | undefined)?.dispose();
  }
}

/** Drives whichever review shot is active. Always registered, costs nothing. */
class ShotDriver implements GameModule {
  readonly name = 'shot-driver';
  update(dt: number, ctx: EngineContext): void {
    updateActiveShot(dt, ctx);
  }
}

export async function registerModules(engine: Engine, progress: ProgressFn): Promise<void> {
  progress(0.2, 'seeding universe');
  await engine.add(new BootstrapScene());
  await engine.add(new ShotDriver());

  registerShot({
    name: 'bootstrap-void',
    description: 'Placeholder starfield — proves the render and capture pipeline.',
    apply(ctx) {
      ctx.camera.position.set(0, 0, 0);
      ctx.camera.rotation.set(0, 0, 0);
    },
  });

  progress(1, 'systems nominal');
}
