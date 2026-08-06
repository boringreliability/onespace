import { generateShip, generateFleet, shipSelfTest } from './blueprint';
import { physicsSelfTest } from './physics';
import { FACTIONS, ROLES } from './families';

export function run(): string[] {
  const out: string[] = [];
  out.push('=== generator self-test ===', ...shipSelfTest());
  out.push('', '=== physics self-test ===', ...physicsSelfTest());
  out.push('', '=== catalogue ===');
  out.push(`factions: ${FACTIONS.map((f) => f.id).join(', ')}`);
  out.push(`roles:    ${ROLES.map((r) => r.id).join(', ')}`);
  return out;
}
