/**
 * The message contract between `shipGenClient` (main thread) and
 * `shipWorker` (the worker entry).
 *
 * Its own module so both sides import it without importing each other: the
 * client references the worker by URL, and a worker that imported the client
 * would pull that reference — and a second worker — into its own bundle.
 *
 * The blueprint crosses as a structured clone, not as JSON. Structured clone
 * keeps every number bit for bit, including -0, NaN and ±Infinity, which a
 * JSON round trip would rewrite; the golden guard hashes JSON and so could
 * not see such a rewrite, but a renderer reading the field would.
 */

import type { GeneratedShip, ShipParams } from './blueprint';

export interface ShipGenRequest {
  readonly id: number;
  readonly params: ShipParams;
}

export type ShipGenResponse =
  | { readonly id: number; readonly ok: true; readonly blueprint: GeneratedShip }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** What the worker does with one request. Pure, so node tests run the real thing. */
export function answerShipRequest(
  req: ShipGenRequest,
  generate: (p: ShipParams) => GeneratedShip,
): ShipGenResponse {
  try {
    return { id: req.id, ok: true, blueprint: generate(req.params) };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
