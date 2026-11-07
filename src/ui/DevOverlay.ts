/**
 * Dev overlay — `?dev` in the URL, or backquote to toggle.
 *
 * Two lines, top-left: wall-clock fps/ms (what the player gets), CPU ms (what
 * v1 wrongly reported as the frame time), governor scale, draw calls,
 * triangles, linked programs; then mode, tier and how many modules tick.
 * A tier switch reloads with `?tier=` — honest: renderers size their buffers
 * at construction, so switching live would be a lie that half-applies.
 */

import type { Engine, GameModule } from '@/core/Engine';
import { config } from '@/core/Config';
import { modes } from '@/core/Modes';
import { formatDevLines } from './devFormat';

export class DevOverlay implements GameModule {
  readonly name = 'dev-overlay';

  private root: HTMLDivElement | null = null;
  private lines: [HTMLDivElement, HTMLDivElement] | null = null;
  private visible: boolean;
  private acc = 0;

  constructor(
    private readonly engine: Engine,
    startVisible: boolean,
  ) {
    this.visible = startVisible;
  }

  init(): void {
    const host = document.getElementById('ui-root') ?? document.body;
    const root = document.createElement('div');
    root.className = 'os-dev';
    const a = document.createElement('div');
    const b = document.createElement('div');
    const tier = document.createElement('select');
    for (const t of ['low', 'medium', 'high', 'ultra']) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      if (t === config.quality.tier) o.selected = true;
      tier.appendChild(o);
    }
    tier.addEventListener('change', () => {
      const u = new URL(window.location.href);
      u.searchParams.set('tier', tier.value);
      u.searchParams.set('dev', '');
      window.location.href = u.toString();
    });
    root.append(a, b, tier);
    host.appendChild(root);
    this.root = root;
    this.lines = [a, b];
    root.style.display = this.visible ? 'block' : 'none';
    window.addEventListener('keydown', this.onKey);
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Backquote' || e.repeat) return;
    this.visible = !this.visible;
    if (this.root) this.root.style.display = this.visible ? 'block' : 'none';
  };

  update(dt: number): void {
    if (!this.visible || !this.lines) return;
    // Four times a second: a DOM write per frame is its own perf problem.
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    const counts = this.engine.moduleCounts();
    const [a, b] = formatDevLines(this.engine.stats(), {
      mode: modes.current,
      tier: config.quality.tier,
      ticking: counts.ticking,
      modules: counts.total,
    });
    if (this.lines[0].textContent !== a) this.lines[0].textContent = a;
    if (this.lines[1].textContent !== b) this.lines[1].textContent = b;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.root?.remove();
  }
}

const CSS = /* css */ `
.os-dev {
  position: absolute; left: 10px; top: 10px; z-index: 50;
  font: 10px/1.5 ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.06em;
  color: #a8bac6; background: rgba(3, 6, 8, 0.55); padding: 4px 8px;
  border-left: 1px solid rgba(255, 180, 84, 0.34);
}
.os-dev select {
  margin-top: 2px; font: inherit; color: #ffb454; background: transparent;
  border: 1px solid rgba(255, 180, 84, 0.34);
}
`;
