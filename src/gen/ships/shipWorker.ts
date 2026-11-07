/**
 * Worker entry for ship generation.
 *
 * `generateShip` is pure — no three, no DOM, no module state that outlives a
 * call — so it runs here unchanged and the blueprint it returns is the same
 * bytes the main thread would have built (proved against golden.json in
 * shipGenClient.test.ts). One request at a time: the client keeps each worker
 * to a single job so it always knows which jobs a crashed worker took with it.
 */

import { generateShip } from './blueprint';
import { answerShipRequest, type ShipGenRequest, type ShipGenResponse } from './shipGenProtocol';

/**
 * The slice of `DedicatedWorkerGlobalScope` used here. The project compiles
 * against the DOM lib, whose `self` is a Window; pulling in the webworker lib
 * for one file would conflict with it for every other file.
 */
interface WorkerScope {
  onmessage: ((ev: MessageEvent<ShipGenRequest>) => void) | null;
  postMessage(msg: ShipGenResponse): void;
}

const scope = self as unknown as WorkerScope;
scope.onmessage = (ev) => {
  scope.postMessage(answerShipRequest(ev.data, generateShip));
};
