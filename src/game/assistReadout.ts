/** Text for the flight-assist line under the throttle gauge. Pure. */

export type AssistReadoutState = 'off' | 'coast' | 'hold' | 'stop';

export function assistReadout(state: AssistReadoutState, setKmS: number): string {
  switch (state) {
    case 'off':
      return 'FA OFF';
    case 'coast':
      return 'FA · COAST';
    case 'stop':
      return 'FA · STOP';
    case 'hold': {
      if (!Number.isFinite(setKmS)) return 'FA · HOLD —';
      return setKmS >= 1
        ? `FA · HOLD ${setKmS.toFixed(2)} KM/S`
        : `FA · HOLD ${Math.round(setKmS * 1000)} M/S`;
    }
  }
}
