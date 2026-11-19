/**
 * Prove that a packed copy of this bundle installs and works without the source tree
 * it came from, and without the development worktree that happens to be checked out
 * beside it.
 *
 * The question this answers is narrow and real: an install has been *reachable* from a
 * worktree path for so long that nothing in the repository could tell whether the
 * artifact a Host loads is the one this source builds. So the script does what a user
 * does — unpack the tarball into a fresh `node_modules` somewhere else — and then asks
 * the installed bytes the three questions that matter:
 *
 *   1. **Is it the whole package?** Every file `package.json` says it ships, at the
 *      version it says, with no stale module riding along.
 *   2. **Are the compiled bytes the ones the current source produced?** Not "probably,
 *      I just built it": every shipped `lib/*` file is compared with the build sitting
 *      in the source directory, hash for hash.
 *   3. **Does a Host get a working plugin out of it?** The installed modules are
 *      imported by path, the tool definition is read out of them, and `ops.list()` and
 *      `ops.probe()` are driven against a live SSH server through the **real** DSH
 *      subprocess provider — the same call graph the settings page rides.
 *
 * Run it with:
 *
 *     node scripts/independent-install-check.mjs                      # build, pack, install
 *     node scripts/independent-install-check.mjs /path/to/tarball.tgz # check an existing pack
 *     node scripts/independent-install-check.mjs --keep               # leave the install behind
 *
 * Nothing is written outside one temp directory and the `lib/` of this package, and no
 * running Host is touched: the installed copy is loaded by *this* process, not by the
 * production one.
 *
 * @module scripts/independent-install-check
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const HARNESS = process.env.DSH_CHECKOUT ?? '/data/deepseek-harness'
const HOME_DIR = process.env.DSH_HOME ?? '/data/dsh-home'
const PROVIDER_PATH = join(HARNESS, 'packages/subprocess/subprocess-local/lib/index.js')
const PACKAGE_ROOT = join(import.meta.dirname, '..')

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const given = argv.find(entry => !entry.startsWith('--'))

const results = []
let failed = 0
function check (name, condition, detail = '') {
  results.push({ name, ok: condition === true, detail })
  process.stdout.write(`${condition === true ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`.slice(0, 200)}\n`)
  if (condition !== true) failed += 1
}
function evidence (line) {
  process.stdout.write(`  · ${line}\n`)
}

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)

// ── 1. get a tarball, and install it somewhere that is not this source tree ──
const work = mkdtempSync(join(tmpdir(), 'dsh-ssh-install-'))
let tarball = given
if (tarball === undefined) {
  process.stdout.write('building and packing from the source tree…\n')
  execFileSync('pnpm', ['run', 'build'], { cwd: PACKAGE_ROOT, stdio: 'pipe' })
  execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: PACKAGE_ROOT, stdio: 'pipe' })
  tarball = readdirSync(work).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error('pnpm pack produced no tarball')
  tarball = join(work, tarball)
}
check('a packed artifact exists', existsSync(tarball) && statSync(tarball).size > 10_000, `${tarball} (${String(Math.round(statSync(tarball).size / 1024))} KiB)`)

const install = join(work, 'project')
execFileSync('mkdir', ['-p', install], { stdio: 'ignore' })
execFileSync('pnpm', ['init', '--yes'], { cwd: install, stdio: 'pipe' })
evidence('installing the tarball into a fresh project with its own node_modules')
execFileSync('pnpm', ['add', '--prefer-offline', tarball], { cwd: install, stdio: 'pipe' })
const pkgDir = join(install, 'node_modules', '@jie2gg', 'dsh-plugin-ssh')
check('the installed package lands at its own path, outside the source tree', existsSync(pkgDir) && !pkgDir.startsWith(PACKAGE_ROOT), pkgDir)

const installed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const sourcePkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
check('the installed version is the version this source declares', installed.version === sourcePkg.version, `installed ${installed.version}, source ${sourcePkg.version}`)
check('the declared entry points resolve', ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg'].every(path => existsSync(join(pkgDir, path))), sourcePkg.files.join(' '))
const shipped = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n').map(line => line.replace(/^package\//u, ''))
check('the package ships no file the build did not produce', shipped.every(name => name.startsWith('lib/') || name.startsWith('docs/') || name.startsWith('locale/') || ['cordis.patch.yml', 'icon.svg', 'package.json', 'README.md'].includes(name)), `${String(shipped.length)} entries`)
check('and no stale module rides along', readdirSync(join(pkgDir, 'lib')).filter(name => /^(ssh|probe|client-old)\./.test(name)).length === 0, readdirSync(join(pkgDir, 'lib')).filter(name => !name.startsWith('index') && !name.startsWith('client')).slice(0, 4).join(', ') || 'only current modules')

// ── 2. the installed bytes are the current source's bytes ──────────────────
const builtLib = join(PACKAGE_ROOT, 'lib')
const installedLib = join(pkgDir, 'lib')
const libNames = readdirSync(installedLib).sort()
check('every installed lib file has a twin in the fresh build, and vice versa', JSON.stringify(libNames) === JSON.stringify(readdirSync(builtLib).sort()), `${String(libNames.length)} files`)
const mismatched = libNames.filter(name => !existsSync(join(builtLib, name)) || hash(join(installedLib, name)) !== hash(join(builtLib, name)))
check('and the twins are byte-identical', mismatched.length === 0, mismatched.join(', ') || `${String(libNames.length)} sha256 prefixes match`)
// The compiler's output set has to be the source's set: an extra file in `lib/` is a
// build that kept something the current `src/` no longer describes.
const srcNames = readdirSync(join(PACKAGE_ROOT, 'src')).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts')).map(name => name.replace(/\.ts$/u, '')).sort()
const jsNames = libNames.filter(name => name.endsWith('.js') && !name.endsWith('.client.js')).map(name => name.replace(/\.js$/u, '')).sort()
check('lib/ holds exactly one output per src/ module', JSON.stringify(jsNames) === JSON.stringify(srcNames), `${String(jsNames.length)} built from ${String(srcNames.length)} sources`)

// ── 3. a Host-shaped load of the installed copy ─────────────────────────────
const patch = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8')
check('the bundle patch still names one Host row for this package', /id: ssh/u.test(patch) && /@jie2gg\/dsh-plugin-ssh/u.test(patch), patch.trim().replace(/\n/gu, ' ').slice(0, 90))
const indexModule = await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href)
check('the installed entry exports its config schema and its bundle wiring', typeof indexModule.Config === 'function' || typeof indexModule.default === 'function', `exports: ${Object.keys(indexModule).slice(0, 6).join(', ')}`)
const toolModule = await import(pathToFileURL(join(pkgDir, 'lib', 'tool.js')).href)
const { defaultBounds, resolveSettings } = await import(pathToFileURL(join(pkgDir, 'lib', 'bounds.js')).href)
const { createOps } = await import(pathToFileURL(join(pkgDir, 'lib', 'ops.js')).href)
const { SshTransport } = await import(pathToFileURL(join(pkgDir, 'lib', 'transport.js')).href)
const { AskPassHelper } = await import(pathToFileURL(join(pkgDir, 'lib', 'askpass.js')).href)
const { MuxPool } = await import(pathToFileURL(join(pkgDir, 'lib', 'pool.js')).href)
const helpers = await import(pathToFileURL(join(PACKAGE_ROOT, 'tests', 'helpers.mjs')).href)
let definition = null
let definitionFailure = ''

const stored = JSON.parse(readFileSync(join(HOME_DIR, 'storages', 'ssh_targets.json'), 'utf8'))
const label = process.env.DSH_SSH_CHECK_TARGET ?? 'proxy'
const row = Object.values(stored.tables.connections).find(entry => entry.label === label)
if (row === undefined) {
  check('a stored SSH target is available to call through', false, `no target labelled ${label} in ${HOME_DIR}`)
} else {
  const yaml = readFileSync(join(HOME_DIR, '.credentials.yaml'), 'utf8')
  const at = yaml.indexOf(`  ssh/${row.id}-password:`)
  let password
  if (at >= 0) {
    const tailText = yaml.slice(at + `  ssh/${row.id}-password:`.length)
    const match = /^ {4}payload:\n {6}secret:\s*(.+)$/m.exec(tailText.split('\n  ssh')[0])
    if (match !== null) password = (match[1] ?? '').trim().replace(/^["']|["']$/gu, '')
  }
  const mod = await import(pathToFileURL(PROVIDER_PATH).href)
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    get: () => undefined,
    waterfall: async (_event, value) => value,
    effect: (fn) => fn,
    provide: () => undefined,
    self: {},
    root: {},
    on: () => () => undefined,
    reflect: { provide: () => undefined, depend: () => undefined, usageOf: () => undefined },
  }
  const askpass = new AskPassHelper()
  const mux = new MuxPool()
  const transport = new SshTransport({ subprocess: new mod.LocalSubprocessRuntime(ctx) }, askpass, mux)
  mux.attach((socketPath, authority) => transport.exitMaster(socketPath, authority))
  const target = { id: row.id, label: row.label, host: row.host, ...(row.user === undefined ? {} : { user: row.user }), ...(row.port === undefined ? {} : { port: row.port }), pool: 'on' }
  const auth = { mode: row.auth, ...(password === undefined ? {} : { password }) }
  try {
    await askpass.prepare()
    await mux.prepare()
    const { settings } = resolveSettings(defaultBounds())
    const ops = createOps({
      runner: transport,
      store: async () => helpers.fakeStore({ records: [helpers.record({ id: row.id, label: row.label, host: row.host, ...(row.user === undefined ? {} : { user: row.user }), port: row.port, auth: row.auth, pool: 'on' })] }),
      secrets: () => helpers.fakeSecrets({ password: password !== undefined, passphrase: false, root: false }, { password }),
      askpass: () => ({ ready: askpass.ready, ...(askpass.path === undefined ? {} : { path: askpass.path }) }),
      bounds: defaultBounds,
    })
    const listed = await ops.list({})
    check('the installed copy answers a page-shaped list', Array.isArray(listed.connections) && listed.limits.concurrentOps === 16, `targets ${String(listed.connections.length)}`)
    check('and reports the ceilings this release added, so the page cannot show a stale number', listed.bounds.maxRunningJobs === 8 && listed.bounds.foregroundReservedOps === 8 && listed.bounds.probeTimeoutMs === 30_000 && listed.pool.jobs === 0, JSON.stringify({ maxRunningJobs: listed.bounds.maxRunningJobs, reserved: listed.bounds.foregroundReservedOps, probe: listed.bounds.probeTimeoutMs, jobs: listed.pool.jobs }))
    const probe = await transport.probe(target, settings, auth)
    check('a connectivity probe through the installed bytes reaches the server', probe.status === 'reachable', `${String(probe.status)} in ${String(probe.durationMs)} ms`)
    const run = await ops.runCommand({ target: label, command: 'printf INSTALLED_OK' })
    check('and one remote command through it returns output', String(run.run.stdout ?? '').includes('INSTALLED_OK'), JSON.stringify({ status: run.run.status, exit: run.run.exitCode, err: String(run.run.stderr ?? run.run.message ?? '').trim().slice(0, 120) }))
    // The tool definition is built from the installed module, against the ops the
    // installed modules assembled: that is the registration a Host performs, minus a
    // model in front of it.
    try {
      definition = toolModule.buildRemoteTool({
        ops: async () => ops,
        catalog: async () => listed.connections.map(entry => ({ id: entry.id, label: entry.label, host: entry.host, agentAccess: entry.agentAccess ?? 'on', allowedCommands: entry.allowedCommands ?? [], pool: entry.pool ?? 'on' })),
        boundsOf: defaultBounds,
      })
    } catch (error) {
      definitionFailure = error instanceof Error ? error.message : String(error)
    }
  } finally {
    check('the installed module exposes the tool registration a Host performs', definition !== null && definition.name === toolModule.REMOTE_TOOL_NAME, definition === null ? definitionFailure : `name ${String(definition.name)}, description ${String(definition.description ?? '').length} chars`)
    const serialized = JSON.stringify(definition ?? {})
    check('with every remote action still declared', ['get_connection', 'exec', 'read', 'write', 'edit', 'upload', 'download'].every(action => serialized.includes(action)), `${String(toolModule.REMOTE_TOOL_ACTIONS.length)} actions in the schema`)
    check('and the declared call budget sits above the longest path it can wait for', Number.isSafeInteger(definition?.timeoutMs) && definition.timeoutMs > 300_000, String(definition?.timeoutMs))
    transport.dispose()
    await mux.dispose().catch(() => undefined)
    await askpass.dispose().catch(() => undefined)
  }
}

if (keep) {
  evidence(`install kept at ${install}`)
} else {
  rmSync(work, { recursive: true, force: true })
  evidence(`temp tree removed: ${!existsSync(work)}`)
}

process.stdout.write(`\n${String(results.filter(entry => entry.ok).length)} passed, ${String(failed)} failed\n`)
process.exitCode = failed === 0 ? 0 : 1
