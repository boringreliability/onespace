/** Text for the dev overlay — pure, so the format is pinned by tests. */

export interface DevStats {
  readonly fps: number;
  readonly frameMs: number;
  readonly cpuMs: number;
  readonly scale: number;
  readonly calls: number;
  readonly tris: number;
  readonly programs: number;
}

export interface DevContext {
  readonly mode: string;
  readonly tier: string;
  readonly ticking: number;
  readonly modules: number;
}

function tris(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

function scale(s: number): string {
  // ".95" reads faster than "0.95"; 1 must still read as a number, not ".100".
  return s >= 1 ? s.toFixed(2) : s.toFixed(2).replace(/^0/, '');
}

export function formatDevLines(s: DevStats, c: DevContext): [string, string] {
  const fps = Number.isFinite(s.fps) ? String(Math.round(s.fps)) : '—';
  const a =
    `${fps} fps · ${s.frameMs.toFixed(1)} ms · cpu ${s.cpuMs.toFixed(1)} · scale ${scale(s.scale)}` +
    ` · calls ${s.calls} · tris ${tris(s.tris)} · progs ${s.programs}`;
  const b = `mode ${c.mode.toUpperCase()} · tier ${c.tier} · ticking ${c.ticking}/${c.modules}`;
  return [a, b];
}
