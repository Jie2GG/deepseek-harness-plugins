/**
 * Finalize the emitted browser artifact of the SSH plugin.
 *
 * `src/client.ts` imports types, so TypeScript emits it as a module and appends an
 * `export {};` marker. The web module table executes `lib/client.js` as a classic
 * script, where that marker is a syntax error, so this step removes it and then
 * proves the file is still a script: exactly one `__ModuleLoader__.load(` call and
 * no top-level `import` or `export` statement.
 *
 * Run it after `tsc` through the package's `build` script.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const artifact = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

const original = await readFile(artifact, 'utf8')
const finalized = original.replace(/^export \{\};\s*$/gmu, '').trimEnd() + '\n'

/** Top-level ES module syntax the browser script form cannot carry. */
const MODULE_SYNTAX = /^(?:import|export)[ {=(]/gmu

const loads = finalized.match(/window\.__ModuleLoader__\.load\(/gu)?.length ?? 0
if (loads !== 1) {
  console.error(`ssh: lib/client.js registers ${String(loads)} module entries, expected exactly 1`)
  process.exit(1)
}
const leftover = finalized.match(MODULE_SYNTAX)
if (leftover !== null) {
  console.error(`ssh: lib/client.js keeps module syntax for the browser script form: ${leftover.join(', ')}`)
  console.error('ssh: author src/client.ts with type-only imports so no runtime import survives')
  process.exit(1)
}

if (finalized !== original) await writeFile(artifact, finalized, 'utf8')
console.log(`ssh: lib/client.js finalized as a classic script (${String(finalized.length)} bytes, 1 module entry)`)
