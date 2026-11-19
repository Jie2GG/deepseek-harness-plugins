/**
 * Empty the compiled output before a build, so `lib/` can only ever hold what the
 * `src/` beside it produced.
 *
 * `tsc` writes and overwrites, but it never forgets: a module that stopped existing
 * stays in `lib/` forever, and `package.json` ships `lib/` — so a stale artifact
 * rides into the tarball and into every install that follows, and "this lib was built
 * from this src" stops being a statement anyone can check. It had happened here:
 * `lib/ssh.js` and `lib/ssh.d.ts` were the last build of the pre-0.0.31 probe module,
 * imported by nothing in the package, and packed anyway.
 *
 * The directory is removed rather than pruned file by file, because the point is not
 * to delete a list someone remembered — it is to make every byte in `lib/` a byte the
 * current compiler put there. `tsc` recreates it as part of the same build.
 *
 * @module scripts/clean-lib
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const lib = join(here, '..', 'lib')

rmSync(lib, { recursive: true, force: true })
process.stdout.write(`ssh: lib/ cleared for a build from the current src/\n`)
