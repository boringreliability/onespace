import { isIPv4, isIPv6 } from 'node:net';

/** Expands a valid IPv6 literal (no zone, no brackets) into its 8 hextets as numbers. */
function hextets(ip: string): number[] {
  let s = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split('.').map(Number) as [number, number, number, number];
    s = s.slice(0, -v4[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((h) => parseInt(h, 16)));
  const [head, tail] = s.split('::') as [string, string | undefined];
  if (tail === undefined) return parse(head);
  const h = parse(head);
  const t = parse(tail);
  return [...h, ...new Array<number>(8 - h.length - t.length).fill(0), ...t];
}

/**
 * Rate-limit key for a client address: IPv4 as is, IPv4-mapped IPv6 as IPv4,
 * other IPv6 collapsed to its /64 (one subscriber can mint 2^64 addresses),
 * anything unparsable as 'unknown'.
 */
export function ipKey(ip: string): string {
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (isIPv4(s)) return s;
  if (!isIPv6(s)) return 'unknown';
  const g = hextets(s);
  if (g.length !== 8) return 'unknown';
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}
