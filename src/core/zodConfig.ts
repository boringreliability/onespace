/**
 * Zod in the client: jitless (Ruling R63).
 *
 * Zod 4 compiles a fast parser for each object schema with `new Function`,
 * and first probes whether that is allowed (`new Function("")`). The page's
 * CSP (`script-src 'self'`) reports that probe as a violation on every boot,
 * even though Zod catches the throw. Jitless mode skips both the probe and the
 * compiled parser.
 *
 * The check runs when a schema is BUILT (at module evaluation), so this must
 * be the first import of src/main.ts, ahead of any module that declares one.
 */

import { z } from 'zod';

z.config({ jitless: true });
