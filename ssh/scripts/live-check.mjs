/**
 * Real-environment check for the transfer boundaries this plugin promises.
 *
 * The offline suites fake the transport seam or the subprocess provider; this
 * script uses neither trick. It loads the built plugin modules, mounts the **real
 * DSH subprocess provider** from the harness checkout, and moves bytes to a live
 * server with the user's stored credentials. What it prints are facts about
 * processes, files, and inodes — the only kind of evidence a byte ceiling, an
 * overwrite that must survive being stopped, and a connection lane are worth.
 *
 * Run it with:
 *
 *     node scripts/live-check.mjs --target=proxy            # tasks 1 and 2
 *     node scripts/live-check.mjs --target=proxy --case=grow  # one case
 *
 * Every write lands in one fresh directory under `/tmp` on the server (and in a
 * matching scratch directory at home), which the script removes at the end. The
 * stored target record and its password are read, never written, and no secret
 * is ever printed.
 *
 * @module scripts/live-check
 */

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HARNESS = process.env.DSH_CHECKOUT ?? '/data/deepseek-harness'
const HOME_DIR = process.env.DSH_HOME ?? '/data/dsh-home'
const PROVIDER_PATH = join(HARNESS, 'packages/subprocess/subprocess-local/lib/index.js')

const { SshTransport } = await import('../lib/transport.js')
const { transfer, remoteParts } = await import('../lib/transfer.js')
const { AskPassHelper } = await import('../lib/askpass.js')
const { MuxPool } = await import('../lib/pool.js')
const { defaultBounds, resolveSettings } = await import('../lib/bounds.js')
const { buildEditRead, splitEditVersion } = await import('../lib/edit.js')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const found = argv.find(entry => entry.startsWith(`--${name}=`))
  return found === undefined ? fallback : found.slice(name.length + 3)
}
const only = flag('case', '') === '' ? null : flag('case', '')
const TARGET_LABEL = flag('target', 'proxy')

// ── the wiring the running Host normally provides ──────────────────────────
const log = []
const evidence = (line) => {
  log.push(line)
  process.stdout.write(`  · ${line}\n`)
}

/** The stored target and its secret, read the way the plugin reads them. */
function loadTarget (label) {
  const stored = JSON.parse(readFileSync(join(HOME_DIR, 'storages/ssh_targets.json'), 'utf8'))
  const row = Object.values(stored.tables.connections).find(entry => entry.label === label)
  if (row === undefined) throw new Error(`no stored SSH target labelled ${label}`)
  const yaml = readFileSync(join(HOME_DIR, '.credentials.yaml'), 'utf8')
  const wanted = `  ssh/${row.id}-password:`
  const at = yaml.indexOf(wanted)
  let password
  if (at >= 0) {
    const tail = yaml.slice(at + wanted.length)
    const match = /^ {4}payload:\n {6}secret:\s*(.+)$/m.exec(tail.split('\n  ssh/')[0])
    if (match !== null) password = (match[1] ?? '').trim().replace(/^["']|["']$/gu, '')
  }
  evidence(`target "${row.label}" → ${row.user ?? ''}@${row.host} (auth ${row.auth}, secret ${password === undefined ? 'not needed' : `read, ${String(password.length)} chars`})`)
  return {
    target: { id: row.id, label: row.label, host: row.host, ...(row.user === undefined ? {} : { user: row.user }), ...(row.port === undefined ? {} : { port: row.port }), pool: 'on' },
    auth: { mode: row.auth, ...(password === undefined ? {} : { password }) },
  }
}

/**
 * Mount the provider the running Host would use, so the child lifecycle under
 * test is the one the plugin actually gets in production: managed process ranges,
 * collected stderr, raw pipes, and the provider's own spill directory.
 */
async function mountProvider () {
  if (!existsSync(PROVIDER_PATH)) throw new Error(`no subprocess provider at ${PROVIDER_PATH} (set DSH_CHECKOUT)`)
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
  const runtime = new mod.LocalSubprocessRuntime(ctx)
  evidence(`provider: ${relative(HARNESS, PROVIDER_PATH)} (${mod.LocalSubprocessRuntime.name})`)
  return { subprocess: runtime, logger: ctx.logger }
}

const { createOps } = await import('../lib/ops.js')
const { fakeStore, fakeSecrets, record } = await import('../tests/helpers.mjs')

const bounds = defaultBounds()
const { settings } = resolveSettings(bounds)
const LOCAL = mkdtempSync(join(tmpdir(), 'dsh-ssh-live-local-'))
const REMOTE_ROOT = '/tmp/dsh-ssh-live'
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const REMOTE = `${REMOTE_ROOT}/${stamp}`

// ── tiny assertions ─────────────────────────────────────────────────────────
const results = []
let failed = 0
function check (name, condition, detail = '') {
  results.push({ name, ok: condition === true, detail })
  process.stdout.write(`${condition === true ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (condition !== true) failed += 1
}

const md5 = (buffer) => createHash('md5').update(buffer).digest('hex')
const localMd5 = (path) => md5(readFileSync(path))

// ── the harness the cases run against ──────────────────────────────────────
const { target, auth } = loadTarget(TARGET_LABEL)
const host = await mountProvider()
const askpass = new AskPassHelper()
const mux = new MuxPool()
const transport = new SshTransport(host, askpass, mux)
mux.attach((socketPath, authority) => transport.exitMaster(socketPath, authority))

// The page and the tool both reach the server through this one object, so the
// live check drives the same code path the model drives rather than a parallel
// hand-written one: the store and the secret are fakes, everything past `ops` is
// the real thing.
// A stand-in for the harness job registry with the same contract the plugin drives:
// `start` returns an id at once and returns the producer's hooks, so the quota and
// the release paths are exercised against real children while the registry's own
// polling and conversation plumbing stay out of the picture.
const registry = (() => {
  const live = new Map()
  let counter = 0
  return {
    start (spec) {
      counter += 1
      const id = `ssh-live-${String(counter)}`
      const hooks = spec.run({})
      live.set(id, hooks)
      hooks.done.then((outcome) => {
        void outcome
        live.delete(id)
        return undefined
      })
      return id
    },
    /** How many jobs the registry is holding, which is what the ceiling counts. */
    get running () { return live.size },
    kill (id) { live.get(id)?.cancel('stopped by the live check') },
    async settleAll () {
      for (const [id, hooks] of live) {
        hooks.cancel('the live check is finishing')
        await hooks.done
        live.delete(id)
      }
    }
  }
})()

const ops = createOps({
  runner: transport,
  jobs: registry,
  store: async () => fakeStore({ records: [record({ id: target.id, label: target.label, host: target.host, ...(target.user === undefined ? {} : { user: target.user }), ...(target.port === undefined ? {} : { port: target.port }), auth: auth.mode, pool: 'on', port: target.port, identityFile: target.identityFile, proxyJump: target.proxyJump })] }),
  secrets: () => fakeSecrets({ password: auth.password !== undefined, passphrase: false, root: false }, { password: auth.password }),
  askpass: () => ({ ready: askpass.ready, ...(askpass.path === undefined ? {} : { path: askpass.path }), ...(askpass.failure === undefined ? {} : { failure: askpass.failure }) }),
  bounds: () => bounds,
})

/** One remote command, with its output collected the way `exec` collects it. */
async function remote (command, options = {}) {
  return await transport.run(target, { ...settings, remoteTimeoutMs: options.timeoutMs ?? 30_000 }, auth, command, options)
}

/**
 * The same question, asked of this machine — and asked by program name.
 *
 * `pgrep -f` cannot be used here: this script's own command line contains every
 * path it is looking for, so the shell that launched it answers as a match and the
 * check would never be able to tell a leftover child from its own witness.
 * @param pattern - text only a child of ours would carry in its arguments.
 * @returns the `ps` lines of local `ssh` and `scp` processes matching it.
 */
function localProcesses (pattern) {
  const out = execFileSync('ps', ['-eo', 'pid=,comm=,args=', '--no-headers'], { encoding: 'utf8' })
  return out
    .split('\n')
    .filter((line) => {
      // `pid=` and `comm=` are padded to the width of the widest value on the
      // machine, which on a box with seven-digit pids is not the six columns a
      // fixed-offset slice assumes — and a fixed slice silently turned every
      // "no child of ours is left" check into one that had nothing to look at.
      // Splitting the columns is width-independent, and the executable's own name
      // is still what is compared: this repository's path contains a directory
      // named `ssh`, and a check that matched it against the whole line reported
      // its own witness as a stray.
      const columns = line.trim().split(/\s+/u)
      const comm = columns[1] ?? ''
      return (comm === 'ssh' || comm === 'scp') && line.includes(pattern)
    })
}

/**
 * Watch the server until the process named by `pattern` is gone.
 * @returns the milliseconds it took, or `null` when it never did.
 */
async function untilGone (pattern, budgetMs) {
  const started = Date.now()
  for (;;) {
    const strays = await remoteProcesses(pattern)
    if (strays.length === 0) return Date.now() - started
    if (Date.now() - started > budgetMs) return null
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** Ask the server, from its own point of view, what processes are alive. */
async function remoteProcesses (pattern) {
  const run = await remote(`ps -eo pid,args | grep -F -- '${pattern}' | grep -v -F -- 'grep -F' | sed "s/^ *//"`)
  const lines = (run.stdout ?? '').trim().split('\n').filter(line => line !== '')
  return lines
}

async function copy (direction, localPath, remotePath, options = {}) {
  // `noPool` addresses the same stored target over its own connection. The job lane
  // and the transfer lane are shared machinery; a case that wants two copies not to
  // know about each other says so here rather than discovering it through the pool's
  // own rule — a transfer that lost its channel stops trusting the shared master, and
  // every other channel riding it goes with it. That is 0.0.36 behaviour, unrelated to
  // K-4, and it is why the reap case dials its own connections.
  const addressed = options.noPool === true ? { ...target, pool: 'off' } : target
  return await transfer(transport, addressed, { ...settings, ...(options.settingsOver ?? {}) }, auth, {
    direction,
    localPath,
    remotePath,
    maxBytes: options.maxBytes ?? settings.maxTransferBytes,
    maxFiles: options.maxFiles ?? settings.maxTransferFiles,
    maxTotalBytes: options.maxTotalBytes ?? settings.maxTransferTotalBytes,
    overwrite: options.overwrite === true,
    ...(options.recursive === true ? { recursive: true } : {}),
    ...(options.destinationExists === true ? { destinationExists: true } : {}),
    timeoutMs: options.timeoutMs ?? settings.transferTimeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

const q = (path) => `'${path.replace(/'/gu, `'\\''`)}'`


/** A failure that stops the run rather than printing a confusing line later. */
function assertish (condition, what) {
  if (condition !== true) throw new Error(`cannot build the fixture for ${what}`)
}
/** One small file every later case may copy, created on demand. */
async function ensureSource () {
  await remote(`mkdir -p ${q(REMOTE)} && printf 'LIVE_%s\\n' '${stamp}' > ${q(`${REMOTE}/source.txt`)}`)
  return `${REMOTE}/source.txt`
}

// ── the cases ───────────────────────────────────────────────────────────────
const cases = {}

/**
 * A file whose contents the server keeps appending to while the copy is already
 * running. `cat` on a fifo hands the writer's pace to us, so the growth is not a
 * race the test hopes to win: the pre-check sees 0 bytes and the channel carries
 * 2.5 MiB, and the refusal has to be about the second number.
 */
cases.grow = async () => {
  const fifo = `${REMOTE}/feed.fifo`
  await remote(`mkdir -p ${q(REMOTE)} && rm -f ${q(fifo)} && mkfifo ${q(fifo)}`)
  // 10 × 256 KiB through the pipe, paced by the reader, from a writer that opens
  // the fifo only after the copy is already waiting on it.
  const writer = await transport.startRun(target, { ...settings, remoteTimeoutMs: 0 }, auth,
    `for i in 1 2 3 4 5 6 7 8 9 10; do printf 'C'; dd if=/dev/zero bs=262144 count=1 2>/dev/null; done > ${q(fifo)}`, {})
  const local = join(LOCAL, 'grown.bin')
  writeFileSync(local, 'the answer that was there before')
  const started = Date.now()
  const out = await copy('download', local, fifo, { maxBytes: 1_048_576 })
  writer.kill()
  await writer.finished
  evidence(`growth case: pre-check 0 bytes → outcome ${out.status} after ${String(Date.now() - started)} ms, ${String(out.bytes ?? 0)} bytes delivered against a 1048576 byte ceiling`)
  // The number that matters is the one the destination would have received: the
  // pre-check said 0 bytes, the server had 2.5 MiB to say, and the copy stopped
  // with the ceiling unbroken rather than carrying all of it.
  check('a file that grew after the pre-check is refused by what it moved', out.status === 'refused-size' && (out.bytes ?? 0) > 0 && (out.bytes ?? 0) <= 1_048_576, `${String(out.status)} at ${String(out.bytes)} bytes, ceiling 1048576`)
  // Where the ceiling was reached is a matter of chunk sizes, so the claim that is
  // actually being proven is the one in the message: bytes moved past what the
  // pre-check had seen, and the server still had more to send.
  check('the refusal proves the source produced more than the pre-check saw', (out.bytes ?? 0) > 1_015_000 - 65_536 && /with more where they came from/.test(String(out.message)), `${String(out.bytes)} bytes delivered and the ceiling was reached`)
  check('the refusal names the copy as in-flight, not as a stat', out.limitMode === 'in-flight', String(out.limitMode))
  check('the stopped copy leaves no half file beside the destination', readdirSync(LOCAL).filter(name => name.includes('.dsh-part-')).length === 0)
  check('the destination still holds what it held before', readFileSync(local, 'utf8') === 'the answer that was there before')
  const grew = await untilGone('feed.fifo', 5_000)
  check('the server-side cat is gone once the local channel closed', grew !== null, grew === null ? 'still running after 5 s' : `gone after ${String(grew)} ms`)
  check('the local lane is empty again', transport.transfersInFlight === 0 && transport.inFlight === 0, `transfers ${String(transport.transfersInFlight)}, children ${String(transport.inFlight)}`)
}

/** One ordinary copy, both directions, with content proven by a hash. */
cases.plain = async () => {
  const source = `${REMOTE}/source.txt`
  await remote(`mkdir -p ${q(REMOTE)} && printf 'LIVE_%s\\n' '${stamp}' | tee ${q(source)} >/dev/null && wc -c < ${q(source)}`)
  const local = join(LOCAL, 'source.txt')
  const down = await copy('download', local, source, { maxBytes: 1_048_576 })
  check('a single-file download moves and counts its own bytes', down.status === 'moved' && down.bytes === (await remote(`wc -c < ${q(source)}`)).stdout.trim() * 1, `${down.status} at ${String(down.bytes)} bytes`)
  check('a downloaded file is byte-identical', existsSync(local) && readFileSync(local, 'utf8') === `LIVE_${stamp}\n`)

  const up = `${REMOTE}/uploaded.txt`
  writeFileSync(join(LOCAL, 'upload.txt'), `UPLOAD_${stamp}\n`)
  const moved = await copy('upload', join(LOCAL, 'upload.txt'), up, { maxBytes: 1_048_576 })
  const remoteText = await remote(`cat -- ${q(up)}`)
  check('a single-file upload moves and reports the bytes it read', moved.status === 'moved' && moved.bytes === readFileSync(join(LOCAL, 'upload.txt')).length, `${moved.status} at ${String(moved.bytes)} bytes`)
  check('the uploaded bytes are the bytes that were sent', remoteText.stdout === `UPLOAD_${stamp}\n`, JSON.stringify(remoteText.stdout))
  const leftovers = await remote(`ls ${q(REMOTE)} | grep -c 'dsh-part-' || true`)
  check('a finished upload leaves no temp file on the server', leftovers.stdout.trim() === '0', `found ${leftovers.stdout.trim()}`)
}

/**
 * The overwrite question, answered with inodes rather than with words.
 *
 * `scp` replaced an existing remote file by writing *through* it, which kept the
 * inode, the mode, and every hardlink pointing at it. The streamed copy has to
 * keep that, or a uploaded config file silently becomes a different file — and a
 * hardlink that stopped sharing its inode is exactly the kind of change nobody
 * notices until a service reads the wrong one.
 */
cases.overwrite = async () => {
  const dest = `${REMOTE}/dest.txt`
  const link = `${REMOTE}/dest.link`
  await remote(`mkdir -p ${q(REMOTE)} && printf 'REMOTE_ORIGINAL\\n' > ${q(dest)} && chmod 640 ${q(dest)} && ln -f ${q(dest)} ${q(link)}`)
  const before = (await remote(`stat -c 'inode=%i mode=%a links=%h owner=%U size=%s' ${q(dest)}`)).stdout.trim()
  writeFileSync(join(LOCAL, 'dest.txt'), 'REPLACED_BY_LIVE_CHECK\n')
  const moved = await copy('upload', join(LOCAL, 'dest.txt'), dest, { maxBytes: 4096, overwrite: true })
  const after = (await remote(`stat -c 'inode=%i mode=%a links=%h owner=%U size=%s' ${q(dest)}`)).stdout.trim()
  const linked = (await remote(`cat -- ${q(link)}`)).stdout
  evidence(`overwrite before: ${before}`)
  evidence(`overwrite after:  ${after}`)
  check('an overwrite upload replaces the content', moved.status === 'moved' && (await remote(`cat -- ${q(dest)}`)).stdout === 'REPLACED_BY_LIVE_CHECK\n')
  const sameInode = /inode=(\d+)/.exec(before)?.[1] === /inode=(\d+)/.exec(after)?.[1]
  check('the destination keeps its inode', sameInode, `${/inode=(\d+)/.exec(before)?.[1]} → ${/inode=(\d+)/.exec(after)?.[1]}`)
  const sameMode = /mode=(\S+)/.exec(before)?.[1] === /mode=(\S+)/.exec(after)?.[1]
  check('the destination keeps its mode and owner', sameMode && /owner=(\S+)/.exec(before)?.[1] === /owner=(\S+)/.exec(after)?.[1], `/mode ${sameMode ? 'kept' : 'changed'}`)
  check('a hardlink to the destination sees the new content', linked === 'REPLACED_BY_LIVE_CHECK\n', JSON.stringify(linked.slice(0, 40)))
  check('the link count survived the copy', /links=(\d+)/.exec(after)?.[1] === '2', `links=${String(/links=(\d+)/.exec(after)?.[1])}`)

  // A stopped overwrite must not damage what was already there. The fifo trick
  // gives the same determinism as the growth case: the copy is in the publish
  // step's neighbour, mid-payload, when the ceiling trips.
  const dest2 = `${REMOTE}/dest2.txt`
  await remote(`mkdir -p ${q(REMOTE)} && printf 'ORIGINAL_INTACT\\n' > ${q(dest2)} && chmod 600 ${q(dest2)} && mkfifo ${q(dest2).replace(/\.txt$/, '.fifo')}`)
  const big = join(LOCAL, 'big.txt')
  writeFileSync(big, 'X'.repeat(3 * 1024 * 1024))
  const stopped = await copy('upload', big, dest2, { maxBytes: 1024 * 1024, overwrite: true })
  const intact = await remote(`stat -c 'content=%s mode=%a' ${q(dest2)} && cat -- ${q(dest2)}`)
  check('an upload refused by the ceiling leaves the existing file intact', stopped.status === 'refused-size' && intact.stdout.includes('ORIGINAL_INTACT'), `${stopped.status} / ${intact.stdout.trim().split('\n')[0]}`)
  const stray = await remote(`ls ${q(REMOTE)} | grep -c 'dsh-part-' || true`)
  check('a refused upload removes its own temp file', stray.stdout.trim() === '0', `found ${stray.stdout.trim()}`)
}

/** A fresh destination carries the source's permission bits, as `scp` left them. */
cases.modes = async () => {
  const { chmodSync, statSync } = require('node:fs')
  const umask = (await remote('umask')).stdout.trim()
  for (const [name, bits] of [['script.sh', 0o755], ['data.txt', 0o640]]) {
    const local = join(LOCAL, name)
    writeFileSync(local, name === 'script.sh' ? '#!/bin/sh\necho hi\n' : 'rows\n')
    chmodSync(local, bits)
    const sourceMode = statSync(local).mode & 0o7777
    const octal = Number(sourceMode.toString(8))
    const expected = (sourceMode & ~parseInt(umask, 8)) .toString(8)
    const dest = `${REMOTE}/${name}`
    const moved = await copy('upload', local, dest, { maxBytes: 4096 })
    const stated = await remote(`stat -c '%a %s' ${q(dest)}`)
    evidence(`fresh upload of a ${octal} source under server umask ${umask} landed as: ${stated.stdout.trim()} (local says ${(sourceMode).toString(8)})`)
    check(`a fresh upload carries the source mode (${octal}) through the server umask`, moved.status === 'moved' && stated.stdout.trim().split(' ')[0] === expected, `expected ${expected}, got ${stated.stdout.trim()}`)
  }
  // A chmod the arithmetic got wrong lands the file on mode 000, which is how this
  // case earned its keep: the nested substitution it replaced parsed differently
  // under `sh`/`dash`/`bash` and the live run caught what 191 unit tests could not.
  const unreadable = await remote(`test -r ${q(`${REMOTE}/script.sh`)} && echo readable || echo unreadable`)
  check('the uploaded file is still readable by the account that made it', unreadable.stdout.trim() === 'readable', unreadable.stdout.trim())
}

/** A path the caller wrote with a leading tilde has to reach the home directory. */
cases.tilde = async () => {
  const dest = '~/dsh-ssh-live-upload.txt'
  const local = join(LOCAL, 'tilde.txt')
  writeFileSync(local, `TILDE_${stamp}\n`)
  const moved = await copy('upload', local, dest, { maxBytes: 4096, overwrite: true })
  const stated = await remote(`printf '%s %s' "$(wc -c < ~/dsh-ssh-live-upload.txt)" "$(cat ~/dsh-ssh-live-upload.txt)"`)
  check('an upload to a ~/ path lands in the home directory', moved.status === 'moved' && stated.stdout.includes(`TILDE_${stamp}`), JSON.stringify(stated.stdout))
  const back = join(LOCAL, 'tilde-back.txt')
  const down = await copy('download', back, '~/dsh-ssh-live-upload.txt', { maxBytes: 4096, overwrite: true, destinationExists: false })
  check('a download from a ~/ path reads the home directory', down.status === 'moved' && readFileSync(back, 'utf8') === `TILDE_${stamp}\n`, `${down.status} ${String(down.bytes)}`)
  const miss = await copy('download', join(LOCAL, 'nothing.txt'), '~/dsh-ssh-live-missing-file.txt', { maxBytes: 4096 })
  check('a ~/ path with nothing behind it still reports missing', miss.status === 'missing', miss.status)
  await remote('rm -f ~/dsh-ssh-live-upload.txt')
}

/**
 * The transfer lane, measured instead of asserted.
 *
 * Three copies are started against three fifos the server only feeds when a
 * reader arrives, so all three are certainly inside the copy phase at the same
 * moment — the situation the 0.0.32 and 0.0.33 smoke rounds could not manufacture
 * through the tool surface and had to skip. The peak is read from the transport's
 * own counter, which is the number the settings page now shows.
 */
cases.lane = async () => {
  const paths = ['a', 'b', 'c'].map(name => `${REMOTE}/lane-${name}.fifo`)
  await remote(`mkdir -p ${q(REMOTE)} && ${paths.map(path => `rm -f ${q(path)} && mkfifo ${q(path)};`).join(' ')} true`)
  const writers = []
  // The `sleep` keeps each fifo's write end open, so all three copies are inside
  // their copy phase at the same moment: without it a 512 KiB fifo drains in a few
  // dozen milliseconds and a sampled peak would prove nothing.
  for (const path of paths) {
    writers.push(await transport.startRun(target, { ...settings, remoteTimeoutMs: 0 }, auth, `{ dd if=/dev/zero bs=65536 count=8 2>/dev/null; sleep 3; } > ${q(path)}`, {}))
  }
  const local = paths.map((_path, index) => join(LOCAL, `lane-${String(index)}.bin`))
  writeFileSync(join(LOCAL, 'lane-src.bin'), 'Y'.repeat(512 * 1024))
  const peaks = []
  const startedAt = []
  const samples = []
  const runs = paths.map((path, index) => copy('download', local[index], path, {
    maxBytes: 8 * 1024 * 1024,
    timeoutMs: 120_000,
  }).then(outcome => {
    startedAt.push(Date.now())
    samples.push(outcome.status)
    return outcome
  }))
  // Sample the lane while the copies are racing, so the maximum is observed
  // rather than reconstructed.
  const sampler = setInterval(() => { peaks.push(transport.transfersInFlight) }, 20)
  const outcomes = await Promise.all(runs)
  clearInterval(sampler)
  const peak = Math.max(0, ...peaks)
  const refused = outcomes.filter(outcome => outcome.status === 'failed' && /may run at once/iu.test(String(outcome.message)))
  for (const outcome of refused) evidence(`refused copy: ${String(outcome.message)} (hint: ${String(outcome.hint ?? 'none')})`)
  const moved = outcomes.filter(outcome => outcome.status === 'moved')
  evidence(`lane outcomes: ${outcomes.map(outcome => `${outcome.status}${outcome.status === 'moved' ? `(${String(outcome.bytes)}B)` : ''}`).join(' ')}`)
  evidence(`lane samples: min ${String(Math.min(...peaks))} max ${String(peak)} of ${String(peaks.length)} samples; statuses ${samples.join(', ')}`)
  for (const writer of writers) { writer.kill(); await writer.finished }
  check('never more than the configured copies run at once', peak <= settings.maxConcurrentTransfers, `peak ${String(peak)} of ${String(settings.maxConcurrentTransfers)}`)
  check('the ceiling admits as many as it promises', moved.length >= settings.maxConcurrentTransfers, `${String(moved.length)} moved`)
  check('the copy past the ceiling comes back refused, in words, not as a thrown error', refused.length === 1 && moved.length === 2, `${String(refused.length)} refused, ${String(moved.length)} moved`)
  check('the refusal tells the reader what to wait for', refused.every(outcome => /job_kill|ceiling|Wait for one/.test(String(outcome.hint ?? ''))), String(refused[0]?.hint ?? 'no hint'))
  check('every slot comes back when the copies end', transport.transfersInFlight === 0 && transport.inFlight === 0, `transfers ${String(transport.transfersInFlight)}, children ${String(transport.inFlight)}`)
  const after = await copy('download', join(LOCAL, 'lane-after.bin'), await ensureSource(), { maxBytes: 1_048_576 })
  check('a later copy is admitted once the lane is free', after.status === 'moved', after.status)
  const execWhileIdle = await remote('hostname')
  check('a plain command was never starved by the crowded lane', execWhileIdle.status === 'succeeded', execWhileIdle.status)
}

/** A tree: measured before it moves, and reported from what actually landed. */
cases.tree = async () => {
  const src = `${REMOTE}/tree`
  await remote(`mkdir -p ${q(src)}/sub && printf 'AAA\\n' > ${q(src)}/a.txt && printf 'BBB\\n' > ${q(src)}/sub/b.txt && ln -sf a.txt ${q(src)}/link.txt && ln -sf sub ${q(src)}/dirlink && ln -sf /etc/hostname ${q(src)}/outside.txt && chmod 640 ${q(src)}/a.txt && stat -c '%s %F' ${q(src)}/a.txt`)
  const local = join(LOCAL, 'tree')
  const down = await copy('download', local, src, { recursive: true, maxTotalBytes: 64 * 1024 * 1024, maxFiles: 50 })
  check('a recursive download enumerates the tree before it copies', down.status === 'moved' && typeof down.bytes === 'number' && typeof down.files === 'number', `${down.status} ${String(down.bytes)}B ${String(down.files)} files`)
  check('a recursive copy declares itself pre-checked, not in-flight', down.limitMode === 'pre-check', String(down.limitMode))
  check('the landed tree is walked for real, not guessed', down.files >= 3 && (down.bytes ?? 0) >= 8, `${String(down.files)} files / ${String(down.bytes)} bytes`)
  check('a symlinked directory arrives as a directory of bytes', existsSync(join(local, 'dirlink', 'b.txt')) || existsSync(join(local, 'sub', 'b.txt')))
  const tooBig = await copy('download', join(LOCAL, 'tree2'), src, { recursive: true, maxTotalBytes: 1 })
  check('a tree over the cumulative ceiling is refused before it moves', tooBig.status === 'refused-size', `${tooBig.status}: ${String(tooBig.message).slice(0, 60)}`)
  const tooMany = await copy('download', join(LOCAL, 'tree3'), src, { recursive: true, maxFiles: 1 })
  check('a tree over the file ceiling is refused before it moves', tooMany.status === 'refused-size', `${tooMany.status}: ${String(tooMany.message).slice(0, 60)}`)
  const missing = await copy('download', join(LOCAL, 'tree4'), `${REMOTE}/nope`, { recursive: true })
  check('a recursive download of a missing path says missing', missing.status === 'missing', missing.status)
  const occupied = join(LOCAL, 'occupied')
  const { mkdirSync, rmSync } = require('node:fs')
  mkdirSync(occupied, { recursive: true })
  writeFileSync(join(occupied, 'keep.txt'), 'mine')
  const clash = await copy('download', occupied, src, { recursive: true, overwrite: true, destinationExists: true })
  check('a tree is refused rather than copied-then-deleted onto a full directory', clash.status === 'refused-exists' && readFileSync(join(occupied, 'keep.txt'), 'utf8') === 'mine', `${clash.status}: ${String(clash.message).slice(0, 70)}`)
  rmSync(occupied, { recursive: true, force: true })

  // Layout parity: the two shapes `scp -r` produced when this plugin shipped.
  const fresh = `${REMOTE}/up-fresh`
  const upNew = await copy('upload', join(LOCAL, 'tree'), fresh, { recursive: true, maxBytes: 64 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 })
  const freshLayout = await remote(`test -f ${q(fresh)}/a.txt && echo contents-in-dest; test -f ${q(fresh)}/tree/a.txt && echo nested`)
  check('a recursive upload to an absent destination puts the contents there', upNew.status === 'moved' && freshLayout.stdout.includes('contents-in-dest'), freshLayout.stdout.trim().replace(/\n/gu, ' '))
  const existing = `${REMOTE}/up-exists`
  await remote(`mkdir -p ${q(existing)} && printf 'KEEP\\n' > ${q(existing)}/pre.txt`)
  const upOld = await copy('upload', join(LOCAL, 'tree'), existing, { recursive: true, overwrite: true, maxBytes: 64 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 })
  const oldLayout = await remote(`test -f ${q(existing)}/tree/a.txt && echo nested && test -f ${q(existing)}/pre.txt && echo kept`)
  check('a recursive upload onto an existing directory nests under its name', upOld.status === 'moved' && oldLayout.stdout.includes('nested') && oldLayout.stdout.includes('kept'), oldLayout.stdout.trim().replace(/\n/gu, ' '))
}

/** A stalled copy must give its slot back on the way out, by every exit. */
cases.release = async () => {
  // This block's writer holds the fifo open from its own ssh channel. A copy that
  // loses its channel stops trusting the shared master, and a dropped master takes
  // every other channel with it — which would end the writer, close the fifo, and let
  // the "cancelled" copy finish instead. Each connection here is therefore its own
  // (a target whose pool is off), so the cancellation being measured is the only thing
  // that can stop the copy.
  const own = { ...target, pool: 'off' }
  // Two ways a copy can stop that are not its ceiling: the reader pressing stop,
  // and the deadline arriving. Each has to hand the transfer lane back, and
  // neither may leave a part file where a download was interrupted.
  const busy = `${REMOTE}/release-busy.fifo`
  const quiet = `${REMOTE}/release-quiet.fifo`
  await remote(`mkdir -p ${q(REMOTE)} && rm -f ${q(busy)} ${q(quiet)} && mkfifo ${q(busy)} && mkfifo ${q(quiet)}`)
  const writer = await transport.startRun(own, { ...settings, remoteTimeoutMs: 0 }, auth, `{ dd if=/dev/zero bs=65536 count=16 2>/dev/null; sleep 6; } > ${q(busy)}`, {})
  const cancel = new AbortController()
  const cancelled = copy('download', join(LOCAL, 'r1.bin'), busy, { maxBytes: 8 * 1024 * 1024, timeoutMs: 60_000, signal: cancel.signal, noPool: true })
  // The lane is taken once the copy itself starts, which on a fresh dial (no shared
  // master to ride) is behind a pre-check round trip and an authentication. Waiting
  // for the lane to be held is what makes this an assertion about the lane rather
  // than about how long this machine takes to connect.
  let held = 0
  const laneWaited = Date.now()
  for (let wait = 0; wait < 80 && held === 0; wait += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    held = transport.transfersInFlight
  }
  check('a copy in flight holds exactly one lane slot', held === 1, `lane ${String(held)} after ${String(Date.now() - laneWaited)} ms`)
  const writerHolders = (await remoteProcesses('sleep 6')).length
  cancel.abort()
  const out1 = await cancelled
  evidence(`cancel: copy had held the lane for ${String(held)}; writer channels parked on 'sleep 6': ${String(writerHolders)}; copy delivered ${String(out1.bytes ?? 0)} bytes in ${String(out1.durationMs ?? 0)} ms → ${out1.status}`)
  check('a cancelled copy reports the cancellation and frees its slot', out1.status === 'failed' && /cancel/iu.test(String(out1.message)) && transport.transfersInFlight === 0, `${out1.status}, lane ${String(transport.transfersInFlight)}`)
  writer.kill()
  await writer.finished
  // Nothing ever opens the quiet fifo for writing, so the copy waits on it.
  const out2 = await copy('download', join(LOCAL, 'r2.bin'), quiet, { maxBytes: 8 * 1024 * 1024, timeoutMs: 700 })
  check('a copy that runs out of its deadline frees its slot too', out2.status === 'failed' && /deadline/iu.test(String(out2.message)) && transport.transfersInFlight === 0, `${out2.status}, lane ${String(transport.transfersInFlight)}`)
  check('an interrupted download leaves no part file behind', readdirSync(LOCAL).filter(name => name.includes('.dsh-part-')).length === 0, readdirSync(LOCAL).join(', '))
  // K-4: closing the local `ssh` child cannot wake a server-side `cat` parked in
  // open()/read() on a fifo with no writer — it never touches the channel, so sshd
  // without a pty lets it sit for hours. The transfer layer now asks the server to
  // end it after the teardown, so the poll below must find it gone on a server that
  // has pkill. If it lingers, that is a real regression unless the server has no
  // pkill to begin with, which the copy's own notes then say out loud.
  // Since 0.0.37 the cleanup names a pid rather than a path, so the sentence it owes
  // the reader is one of six verdicts. The rule the check holds is the honest one: a
  // copy either says which process it ended, says plainly that it cannot tell, or says
  // nothing about a mover at all — and it may never claim an ended mover while one is
  // still parked on the path.
  const quietNotes = (out2.notes ?? []).join(' | ')
  const endedMover = /ended its (own )?server-side mover/u.test(quietNotes)
  const saidItCannotTell = /got no answer|cannot say whether|now running something else|refused the signal|never reported a server-side mover pid|no readable \/proc/u.test(quietNotes)
  check('the interrupted download accounted for its own stranded mover by pid', endedMover || saidItCannotTell || /mover/u.test(quietNotes) === false, `notes: ${quietNotes.slice(0, 170) || 'none'}`)
  check('and the claim is about one process, never about everything matching a path', /pkill|leftover server-side mover of/u.test(quietNotes) === false, quietNotes.slice(0, 60))
  const settledAfter = await untilGone('release-quiet.fifo', 5_000)
  if (settledAfter === null) {
    check('the stranded server-side reader is gone after the cleanup', saidItCannotTell, saidItCannotTell
      ? 'the copy said plainly what it could not prove, and the reader is the residual it named (accepted)'
      : `the cleanup claimed to have ended its mover, yet a reader of release-quiet.fifo outlived it: ${String((await remoteProcesses('release-quiet.fifo')).length)} still running`)
    if (!saidItCannotTell) await remote(`pkill -f 'cat -- ${REMOTE}/release-quiet.fifo' || true`) // keep the fixture tidy
    else evidence(`observation: ${String((await remoteProcesses('release-quiet.fifo')).length)} reader(s) lingered, and the copy's own note said so`)
  } else {
    check('the server-side reader of a timed-out copy is gone once the cleanup ran', true, `gone after ${String(settledAfter)} ms`)
  }
  const localStrays = localProcesses('release-quiet.fifo')
  check('no local ssh child of ours is left behind', localStrays.length === 0, localStrays.map(line => line.trim().slice(0, 80)).join(' | ') || 'none')
  const next = await copy('download', join(LOCAL, 'r3.bin'), await ensureSource(), { maxBytes: 1_048_576 })
  check('the lane admits the next copy after both interruptions', next.status === 'moved', next.status)
}

/**
 * The guarded edit, against a file that has attributes worth keeping.
 *
 * The unit suite proves the *sequence* — guard, copy, replace, re-check, repair.
 * What only a real server can prove is what the replacement does to the file's
 * identity: that writing `cat >` through it leaves the inode, the mode, the
 * owner, and a second hardlink pointing at the same bytes, and that an edit cut
 * short in the middle of its body comes back at exactly the size it started at
 * rather than somewhere in between.
 */
cases.edit = async () => {
  const path = `${REMOTE}/edit.txt`
  const link = `${REMOTE}/edit.link`
  const original = 'worker_processes 1;\n# keep this line\n'
  await remote(`mkdir -p ${q(REMOTE)} && printf 'worker_processes 1;\\n# keep this line\\n' > ${q(path)} && chmod 640 ${q(path)} && chown root:root ${q(path)} && ln -f ${q(path)} ${q(link)}`)
  const canXattr = (await remote('command -v setfattr >/dev/null && echo yes || echo no')).stdout.trim() === 'yes'
  if (canXattr) await remote(`setfattr -n user.live-check -v 1 ${q(path)} 2>/dev/null || true`)
  const before = (await remote(`stat -c 'inode=%i mode=%a links=%h owner=%U:%G size=%s' ${q(path)}`)).stdout.trim()
  const edited = await ops.editRemote({ target: TARGET_LABEL, path, oldText: 'worker_processes 1;', newText: 'worker_processes auto;' })
  const after = (await remote(`stat -c 'inode=%i mode=%a links=%h owner=%U:%G size=%s' ${q(path)}`)).stdout.trim()
  const now = (await remote(`cat -- ${q(path)}`)).stdout
  const throughLink = (await remote(`cat -- ${q(link)}`)).stdout
  evidence(`edit before: ${before}`)
  evidence(`edit after:  ${after}`)
  evidence(`first edit payload: ${JSON.stringify({ ok: edited.ok, status: edited.status, message: edited.message, hint: edited.hint, exitCode: edited.exitCode, versionChecked: edited.versionChecked, backup: edited.backup, bytesBefore: edited.bytesBefore })}`)
  check('a real edit changes the bytes it was asked to change', edited.ok === true && now === 'worker_processes auto;\n# keep this line\n', JSON.stringify(now.slice(0, 40)))
  check('the guarded write kept the inode', before.split(' ')[0] === after.split(' ')[0], `${before.split(' ')[0]} → ${after.split(' ')[0]}`)
  check('the guarded write kept the mode and the owner', before.split(' ')[1] === after.split(' ')[1] && before.split(' ')[3] === after.split(' ')[3], `${before.split(' ')[1]} ${before.split(' ')[3]}`)
  check('the hardlink still points at the same file, and sees the new bytes', before.split(' ')[2] === after.split(' ')[2] && throughLink === now, `links ${before.split(' ')[2]} → ${after.split(' ')[2]}`)
  check('the edit stated a version guard, or said it could not', edited.versionChecked === true, `versionChecked ${String(edited.versionChecked)}`)
  check('the backup names where the previous content is', edited.backup === `${path}.dsh-bak` && (await remote(`cat -- ${q(`${path}.dsh-bak`)}`)).stdout === original, String(edited.backup))
  // The promise 0.0.35 added, checked where a fake cannot flatter it: the write is
  // confirmed by a digest the server itself computed over the bytes that landed, and
  // that digest has to agree with both the file on disk and the body this call sent.
  const canDigest = (await remote('command -v sha256sum >/dev/null 2>&1 && echo yes || echo no')).stdout.trim() === 'yes'
  if (canDigest) {
    const serverDigest = (await remote(`sha256sum ${q(path)} | cut -c1-64`)).stdout.trim()
    const sentDigest = createHash('sha256').update(now, 'utf8').digest('hex')
    check('a real edit reports its content as verified by digest', edited.contentVerified === true && edited.verdict === 'landed', `${String(edited.contentVerified)} / ${String(edited.verdict)}`)
    check('the digest the edit quotes is the one the server computes for the file', serverDigest !== '' && edited.sha256 === serverDigest, `${String(edited.sha256).slice(0, 12)}… vs server ${serverDigest.slice(0, 12)}…`)
    check('and it is the digest of the bytes this call meant to send', edited.sha256 === sentDigest, `${String(edited.sha256).slice(0, 12)}… vs sent ${sentDigest.slice(0, 12)}…`)
  } else {
    evidence('observation: this server states no sha256sum, so the digest cross-check could not run here')
  }
  if (canXattr) {
    const carried = (await remote(`getfattr -n user.live-check --only-values ${q(path)} 2>/dev/null`)).stdout.trim()
    check('an extended attribute survives the edit', carried === '1', `getfattr said ${JSON.stringify(carried)}`)
  } else {
    evidence('observation: this server has no setfattr, so extended attributes were not exercised here')
  }

  // The window the guard exists for: another writer landing between this call's
  // read and its write. Repeated, so the number says how open the window really
  // is on a live connection rather than only that the code path exists — the
  // deterministic per-branch coverage is the offline suite's job.
  let staleSeen = 0
  let wroteSeen = 0
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await remote(`printf 'worker_processes 1;\n# keep this line\n' > ${q(path)}`)
    const racing = ops.editRemote({ target: TARGET_LABEL, path, oldText: 'worker_processes 1;', newText: `MINE_${String(attempt)}` })
    await new Promise(resolve => setTimeout(resolve, 40 + attempt * 30))
    await remote(`printf '%s' ${q(`tampered ${String(attempt)}\n`)} >> ${q(path)}`)
    const raced = await racing
    if (raced.stale === true) staleSeen += 1
    else if (raced.ok === true) wroteSeen += 1
    const body = (await remote(`cat -- ${q(path)}`)).stdout ?? ''
    evidence(`race ${String(attempt)}: ${raced.ok === true ? 'wrote' : raced.stale === true ? 'guard refused' : `refused (${String(raced.status)})`}; body ${JSON.stringify(body.slice(0, 30))}`)
    // The invariant that holds whichever way the race fell: the file ends as one
    // whole body, never a splice of the edit and the rival.
    // Three outcomes are all whole files: the edit won, the guard refused it and
    // the rival's bytes stand, or the original stands with the rival appended to
    // it. A splice — part of the edit's body sitting inside someone else's file —
    // is the one shape that must never appear.
    const whole = /^(worker_processes|MINE_|tampered |$)/u.test(body)
    const spliced = body.includes('MINE_') && body.includes('worker_processes')
    check(`race ${String(attempt)}: the file ended as a whole body, not a splice`, whole && !spliced, JSON.stringify(body.slice(0, 30)))
  }
  evidence(`race outcomes: ${String(staleSeen)} refused by the version guard, ${String(wroteSeen)} wrote`)
  check('the version guard fired against a real concurrent writer at least once', staleSeen >= 1, `${String(staleSeen)} of 6 attempts refused`)

  // The shape a byte-count-only check cannot see coming: a rival body of exactly
  // the same length landing between this call's read and its write. Either the
  // guard refuses it, or the write is confirmed by digest — what must never happen
  // is an unverified “it worked”.
  const base = 'worker_processes 1;\n# keep this line\n'
  const rivalOf = (at) => {
    const i = at % 6
    const ch = base[i]
    return base.slice(0, i) + (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) + base.slice(i + 1)
  }
  check('the same-length rival really is the same length', Buffer.byteLength(rivalOf(0)) === Buffer.byteLength(base) && rivalOf(0) !== base, `${String(Buffer.byteLength(rivalOf(0)))} vs ${String(Buffer.byteLength(base))}`)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await remote(`printf '%s' ${q(base)} > ${q(path)}`)
    const racing = ops.editRemote({ target: TARGET_LABEL, path, oldText: 'worker_processes 1;', newText: `MINE_${String(attempt)}` })
    await new Promise(resolve => setTimeout(resolve, 40 + attempt * 30))
    await remote(`printf '%s' ${q(rivalOf(attempt))} > ${q(path)}`)
    const raced = await racing
    const body = (await remote(`cat -- ${q(path)}`)).stdout ?? ''
    const onDisk = canDigest ? (await remote(`sha256sum ${q(path)} | cut -c1-64`)).stdout.trim() : ''
    evidence(`same-length race ${String(attempt)}: ${raced.ok === true ? `wrote (verified ${String(raced.contentVerified)}, verdict ${String(raced.verdict)})` : raced.stale === true ? 'guard refused it as stale' : `refused (${String(raced.status)}, exit ${String(raced.exitCode ?? '—')})`} verdict ${String(raced.verdict ?? '—')}; body ${JSON.stringify(body.slice(0, 34))}; said ${JSON.stringify(String(raced.message ?? '').slice(0, 90))}`)
    // A success is only allowed to exist at all if the server digested the bytes
    // this call sent, and the digest the tool quotes is the one on disk.
    check(`same-length race ${String(attempt)}: no unverified success`, raced.ok !== true || (raced.contentVerified === true && raced.verdict === 'landed' && typeof raced.sha256 === 'string' && raced.sha256.length === 64 && (onDisk === '' || raced.sha256 === onDisk)), `ok ${String(raced.ok)} verified ${String(raced.contentVerified)} verdict ${String(raced.verdict)}`)
    // Which whole file is acceptable here is knowable in advance: the original, this
    // attempt's rival, or the edit's own body. Anything else — a splice of two — is a
    // write that half landed and was not put back.
    const allowed = new Set([base, rivalOf(attempt), base.replace('worker_processes 1;', `MINE_${String(attempt)}`)])
    check(`same-length race ${String(attempt)}: the file stayed one whole body`, allowed.has(body) && !(body.includes('MINE_') && body.includes('processes')), `${JSON.stringify(body.slice(0, 40))} vs allowed ${JSON.stringify([...allowed].map(value => value.slice(0, 18)))}`)
  }


  // An edit cut short in the middle of its body. The repair child runs on its own
  // clock — the reader stopped the *edit*, not the file's claim to be whole — and
  // this case is what proves that decision was not decoration.
  const cutPath = `${REMOTE}/cut-edit.txt`
  const small = 'HEAD line\n'
  await remote(`printf '%s' ${q(small)} > ${q(cutPath)}`)
  const controller = new AbortController()
  const interrupt = setTimeout(() => { controller.abort() }, 250)
  const cut = await ops.editRemote({
    target: TARGET_LABEL,
    path: cutPath,
    oldText: 'HEAD line',
    newText: `NEW_${stamp}_${'y'.repeat(400 * 1024)}`,
  }, controller.signal)
  clearTimeout(interrupt)
  const sizeNow = Number((((await remote(`wc -c < ${q(cutPath)} | tr -dc 0-9`)).stdout ?? '0').trim()) || '0')
  evidence(`interrupted edit: status ${String(cut.status)}, ok ${String(cut.ok)}, restored ${String(cut.restored)}, started at ${String(small.length)} bytes, file now ${String(sizeNow)} bytes, backup ${String(cut.backup ?? 'none')}`)
  check('an interrupted edit leaves a whole file, not a half-written one', sizeNow === small.length || sizeNow === (cut.bytesAfter ?? -1), `original ${String(small.length)}, intended ${String(cut.bytesAfter ?? -1)}, actual ${String(sizeNow)}`)
  check('a stopped edit does not report itself as a success', cut.ok !== true, `ok ${String(cut.ok)} / ${String(cut.status)}`)
  if (sizeNow === small.length && cut.status !== 'cancelled') {
    check('a repaired file is reported as repaired', cut.restored === true, `restored ${String(cut.restored)}`)
    if (canDigest) {
      // `restored: true` now means something stronger than the length matching: the
      // server digested the file as the exact content this call read before it
      // truncated anything, and the digest on disk agrees.
      const originalDigest = createHash('sha256').update(small, 'utf8').digest('hex')
      const onDisk = (await remote(`sha256sum ${q(cutPath)} | cut -c1-64`)).stdout.trim()
      check('a repaired file digests as the content this call read', cut.contentVerified === true && cut.verdict === 'restored' && cut.sha256 === originalDigest && onDisk === originalDigest, `verdict ${String(cut.verdict)} verified ${String(cut.contentVerified)} tool ${String(cut.sha256).slice(0, 12)}… disk ${onDisk.slice(0, 12)}… wanted ${originalDigest.slice(0, 12)}…`)
    }
  }
  const snaps = ((await remote(`ls ${q(REMOTE)} | grep -c 'dsh-snap-' || true`)).stdout ?? '0').trim()
  check('the edit left no stray snapshot behind', snaps === '0', `snapshots: ${snaps}`)
}


/**
 * The temp namespace, on a machine that actually has residue in it.
 *
 * The offline suite builds its own directory tree; this asks the question against
 * `/tmp` as it stands: does the sweep take the directories a killed generation
 * left, leave the one the running Host is using, leave the socket whose master is
 * still listening, and never touch a neighbour that merely has a similar name? The
 * fixtures are created here and removed here, so the answer is measured rather
 * than asserted from a fixture.
 */
cases.temp = async () => {
  const { sweep: sweepNamespace, socketLive: probeSocket } = await import('../lib/tmpgc.js')
  const { mkdirSync, writeFileSync: writeLocal, existsSync: exists, utimesSync, rmSync: rmLocal } = require('node:fs')
  const base = tmpdir()
  const dead = spawnSync('/bin/sh', ['-c', 'exit 0'])?.pid
  assertish(typeof dead === 'number' && dead > 0, 'a reaped pid to stand in for a dead generation')
  const tag = `live${stamp}`
  const gone = join(base, `dsh-ssh-askpass-p${String(dead)}-${tag}`)
  const aged = join(base, `dsh-ssh-askpass-${tag}old`)
  const fresh = join(base, `dsh-ssh-askpass-${tag}new`)
  const staleSocket = join(base, `dsh-ssh-mux-p${String(dead)}-${tag}`)
  const liveSocket = join(base, `dsh-ssh-mux-p${String(dead)}-${tag}live`)
  const neighbour = join(base, `dsh-ssh-notmynamespace-${tag}`)
  const provider = join(base, `dsh-subprocess-${tag}`)
  for (const path of [gone, aged, fresh, staleSocket, liveSocket, neighbour, provider]) mkdirSync(path, { recursive: true, mode: 0o700 })
  writeLocal(join(gone, 'askpass.sh'), '#!/bin/sh\n')
  writeLocal(join(aged, 'askpass.sh'), '#!/bin/sh\n')
  writeLocal(join(fresh, 'askpass.sh'), '#!/bin/sh\n')
  const old = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000))
  // Age the directory and the helper inside it: the idle rule reads whichever
  // timestamp is freshest, which is exactly the point of the fixture.
  utimesSync(aged, old, old)
  utimesSync(join(aged, 'askpass.sh'), old, old)
  const recent = new Date()
  utimesSync(fresh, recent, recent)
  // And one generation that has been running for days: old directory, helper used
  // this morning. A sweep that took it would be the incident this case exists to
  // keep from happening again.
  const working = join(base, `dsh-ssh-askpass-${tag}working`)
  mkdirSync(working, { recursive: true, mode: 0o700 })
  writeLocal(join(working, 'askpass.sh'), '#!/bin/sh\n')
  const daysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
  utimesSync(working, daysAgo, daysAgo)
  utimesSync(join(working, 'askpass.sh'), new Date(), new Date())
  writeLocal(join(staleSocket, 'ssh-nobody-0000000000.sock'), '')
  writeLocal(join(neighbour, 'keep.txt'), 'not ours')
  writeLocal(join(provider, 'dsh-subprocess-1-1-aa-stdout.log'), 'another provider whole output')
  // A real listening socket, so "somebody is using this path" is a fact about the
  // kernel rather than a guess about a file.
  const server = createServer(connection => { connection.end() })
  const livePath = join(liveSocket, 'ssh-nobody-1111111111.sock')
  await new Promise(resolve => { server.listen(livePath, resolve) })
  try {
    const seesLive = await probeSocket(livePath)
    assertish(seesLive === true, 'the socket probe to see the fixture it just opened')
    const result = await sweepNamespace({ root: base, uid: process.getuid?.() ?? 0, self: [askpass.directory ?? '', mux.directory ?? ''] })
    const removed = new Set(result.removed.map(entry => entry.path))
    const kept = new Map(result.kept.map(entry => [entry.path, entry.verdict.reason]))
    evidence(`sweep scanned ${String(result.scanned)} namespace entries: ${String(result.removed.length)} collected, ${String(result.kept.length)} kept`)
    check('a directory whose process id is gone is collected', removed.has(gone), gone)
    check('a legacy directory three days idle is collected', removed.has(aged), `kept because ${String(kept.get(aged))}`)
    check('a long-running Host that used its helper today keeps it', kept.get(working) === 'young' && exists(join(working, 'askpass.sh')), String(kept.get(working)))
    check('a legacy directory that may still be starting up is kept', kept.get(fresh) === 'young', String(kept.get(fresh)))
    check('a socket directory with nobody listening is collected', removed.has(staleSocket), String(kept.get(staleSocket)))
    check('a socket directory whose master is answering is kept', kept.get(liveSocket) === 'live-socket', String(kept.get(liveSocket)))
    check('the running Host keeps its own two directories', !removed.has(askpass.directory ?? '') && !removed.has(mux.directory ?? ''))
    check('a neighbour plugin directory is never even scanned', ![...removed].some(path => path.includes('notmynamespace')) && exists(join(neighbour, 'keep.txt')))
    check('the subprocess provider spill directory is left to its owner', exists(join(provider, 'dsh-subprocess-1-1-aa-stdout.log')))
    check('the collected directories are really gone', !exists(gone) && !exists(aged) && !exists(staleSocket))
  } finally {
    await new Promise(resolve => { server.close(resolve) })
    for (const path of [gone, aged, fresh, staleSocket, liveSocket, neighbour, provider, working]) rmLocal(path, { recursive: true, force: true })
  }
}

/**
 * K-1: the capability that gates an edit is a fact about the server, not about a
 * fake. This runs the plugin's own read command under the server's real /bin/sh and
 * shows the one signal the edit acts on — an empty `ssh-plugin-sha256:` line — is
 * produced by a real server whose checksum tools are masked, while the same command
 * states the true digest when the tools are present.
 */
cases.capability = async () => {
  const path = `${REMOTE}/capability.txt`
  const body = 'one line, then another\n'
  await remote(`mkdir -p ${q(REMOTE)} && printf '%s' ${q(body)} > ${q(path)}`)
  const cmd = buildEditRead(q(path))
  // With the tools present, the read states the digest this very server computes.
  const withTools = splitEditVersion((await remote(cmd)).stdout)
  const trueDigest = (await remote(`sha256sum ${q(path)} 2>/dev/null | cut -c1-64 || shasum -a 256 ${q(path)} 2>/dev/null | cut -c1-64 || openssl dgst -sha256 ${q(path)} 2>/dev/null | sed 's/.*= *//'`)).stdout.trim()
  check('the real server\'s read states the digest it computes for the file', trueDigest !== '' && withTools.digest === trueDigest, `read ${String(withTools.digest).slice(0, 12)}… vs ${trueDigest.slice(0, 12)}…`)
  check('the read frames the body by the byte count this server stated', withTools.bodyBytes === Buffer.byteLength(body), `stated ${String(withTools.bodyBytes)} of ${String(Buffer.byteLength(body))} bytes`)
  check('and hands the file back whole', withTools.content === body, JSON.stringify(withTools.content.slice(0, 30)))
  // Now mask only the checksum tools: build a PATH with symlinks to everything the
  // read still needs (cat, stat, wc, tr, head, sed, sh) but NOT sha256sum / shasum /
  // openssl. printf and [ are shell builtins. The same command, run under that PATH,
  // must yield an empty digest line — the exact fact K-1 turns into "refuse before
  // writing".
  const mask = `${REMOTE}/cap-bin-${stamp}`
  const keepers = ['cat', 'stat', 'wc', 'tr', 'head', 'sed', 'sh', 'cut']
  const linked = keepers.map(k => `ln -sf "$(command -v ${k} 2>/dev/null)" ${q(`${mask}/${k}`)} 2>/dev/null`).join(' ; ')
  await remote(`rm -rf ${q(mask)} ; mkdir -p ${q(mask)} ; ${linked} ; rm -f ${q(`${mask}/sha256sum`)} ${q(`${mask}/shasum`)} ${q(`${mask}/openssl`)}`)
  const maskedOut = (await remote(`env PATH=${q(mask)} sh ${q('-c')} ${q(cmd)}`)).stdout
  const masked = splitEditVersion(maskedOut)
  check('masking the checksum tools makes the same read state NO digest', masked.digest === undefined, `digest was ${JSON.stringify(String(masked.digest).slice(0, 16))}`)
  check('the masked read still frames the file (a refusal here is about the digest only)', masked.version !== undefined && masked.content === body, `version ${String(masked.version !== undefined)}, body ${JSON.stringify(masked.content.slice(0, 20))}`)
  // A digest-less read is precisely what ops.editRemote now refuses before writing:
  // run the real edit against a file whose digest the server cannot state. Since the
  // real target states its own PATH, we prove the gate by the masked signal above and
  // by the offline real-shell suites; here we confirm the plugin does NOT refuse a
  // capable server (the edit changed bytes and reported landed).
  await remote(`printf '%s' ${q('worker_processes 1;\n')} > ${q(path)}`)
  const realEdit = await ops.editRemote({ target: TARGET_LABEL, path, oldText: 'worker_processes 1;', newText: 'worker_processes auto;' })
  check('a checksum-capable server is NOT over-refused: the edit lands verified', realEdit.ok === true && realEdit.verdict === 'landed' && realEdit.contentVerified === true, `${String(realEdit.ok)} verdict ${String(realEdit.verdict)} verified ${String(realEdit.contentVerified)}`)
  await remote(`rm -rf ${q(mask)}`)
}

/**
 * The spill budget, against the provider that writes the files.
 *
 * Two claims are tested here. The first is the one every `exec` answer rests on:
 * that the `spillPath` handed to a reader really holds the whole stream. The
 * second is the new one: once the process budget cannot cover another file, the
 * child is told not to write one, and the answer says which of the two happened
 * rather than reporting a bare truncation.
 */
cases.spill = async () => {
  const { SpillBudget } = await import('../lib/spill.js')
  const { readFileSync: readLocal, existsSync: exists, statSync, rmSync: rmLocal } = require('node:fs')
  const budget = new SpillBudget(1500, 64)
  const counted = new SshTransport(host, askpass, mux, budget)
  const tight = { ...settings, maxOutputBytes: 64, maxSpillBytes: 4096, remoteTimeoutMs: 15_000 }
  const noisy = 'for i in $(seq 1 20); do printf \'LINE_%03d_abcdefghijklmnopqrstuvwxyz0123456789\\n\' \'$i\'; done'
  const first = await counted.run(target, tight, auth, noisy)
  const path = first.stdoutSpillPath
  const lines = typeof path === 'string' ? readLocal(path, 'utf8').split('\n').filter(line => line.startsWith('LINE_')).length : -1
  const onDisk = typeof path === 'string' ? statSync(path).size : -1
  evidence(`first spill: ${String(path)} — ${String(onDisk)} bytes on disk, ${String(lines)} of 20 lines, in-memory tail ${String((first.stdout ?? '').length)} bytes`)
  check('a clipped command reports where its whole output went', typeof path === 'string' && exists(path), String(path))
  check('the spill file the provider reports really holds the whole stream', lines === 20, `${String(lines)} lines in the file`)
  check('the answer still carries only its bounded tail inline', (first.stdout ?? '').length <= 64, `${String((first.stdout ?? '').length)} bytes inline`)
  // Drive the same command until the budget says no, and check each answer against
  // what the provider actually did: a granted child must have a file that holds
  // the whole stream, and the refused child must have no file and a note naming
  // the limit that answered. How many children fit is the budget's arithmetic, and
  // a face of the answer nobody predicted is not a reason to fail the run.
  const granted = [{ run: first, path }]
  let refused = null
  for (let call = 2; call <= 6 && refused === null; call += 1) {
    const next = await counted.run(target, tight, auth, noisy)
    if (Array.isArray(next.notes) && next.notes.some(note => String(note).includes('spill budget is spent'))) {
      refused = { call, run: next }
    } else {
      granted.push({ run: next, path: next.stdoutSpillPath })
    }
  }
  evidence(`granted ${String(granted.length)} spill(s), refused on call ${String(refused?.call ?? 'none')}, budget ${String(budget.used)} of ${String(budget.max)} bytes in ${String(budget.files)} file(s)`)
  check('every granted child reported a file, and every reported file is on disk', granted.every(entry => typeof entry.path === 'string' && exists(entry.path)), `${String(granted.length)} granted`)
  check('a granted stream keeps no note about the budget', granted.every(entry => entry.run.spillNote === undefined))
  check('the refusal arrived once the budget was spent', refused !== null && budget.used >= budget.max, refused === null ? 'never refused' : `used ${String(budget.used)} of ${String(budget.max)}`)
  check('the refused child is told there will be no file, and gets none', refused !== null && refused.run.stdoutSpillPath === undefined && refused.run.truncated === true, refused === null ? 'no refusal to inspect' : `path ${String(refused.run.stdoutSpillPath)} truncated ${String(refused.run.truncated)}`)
  check('the overshoot is bounded by the stream that was in flight', budget.used - budget.max <= 4096, `${String(budget.used)} against ${String(budget.max)}`)
  const untouched = new SshTransport(host, askpass, mux)
  const normal = await untouched.run(target, tight, auth, noisy)
  check('the budget belongs to the process that spent it, not to the plugin', normal.truncated === true && typeof normal.stdoutSpillPath === 'string' && normal.spillNote === undefined, String(normal.stdoutSpillPath))
  const own = untouched.spill
  check('each transport reports its own spill accounting, for the settings card', own.files >= 1 && own.used > 0 && own.refusals === 0 && own.max > 1_000_000_000, JSON.stringify(own))
  check('the counted transport reports the refusals it made', counted.spill.refusals === 1 && counted.spill.max === 1500, JSON.stringify(counted.spill))
  for (const stray of [path, normal.stdoutSpillPath, ...granted.map(entry => entry.path)]) {
    if (typeof stray === 'string') rmLocal(stray, { force: true })
  }
}

/**
 * The job ceiling, measured where the 0.0.32 and 0.0.33 rounds could only report
 * it: a ninth background command has to be turned away **in the frame that asked**,
 * with the ceiling in its words, rather than starting and then arriving as a failed
 * job the reader never saw running.
 */
cases.jobs = async () => {
  const cap = settings.maxRunningJobs
  const ids = []
  for (let i = 0; i < cap; i += 1) {
    const started = await ops.execBackground({ target: TARGET_LABEL, command: `sleep 25 && printf 'JOB_%d\\n' ${String(i)}` })
    check(`background job ${String(i)} starts`, started.ok === true && typeof started.jobId === 'string', `${String(started.status)} ${String(started.jobId)}`)
    if (typeof started.jobId === 'string') ids.push(started.jobId)
  }
  check('the registry holds exactly the ceiling', registry.running === cap, `${String(registry.running)} of ${String(cap)}`)
  check('the transport lane counts the same jobs', transport.laneUsage('background jobs') === cap, String(transport.laneUsage('background jobs')))
  const over = Date.now()
  const ninth = await ops.execBackground({ target: TARGET_LABEL, command: 'sleep 25 && echo NINTH' })
  const tookMs = Date.now() - over
  evidence(`ninth call answered in ${String(tookMs)} ms: ${String(ninth.status)} / ok ${String(ninth.ok)} / jobId ${String(ninth.jobId ?? 'none')}`)
  check('the call past the ceiling is refused in its own frame', ninth.ok === false && ninth.status === 'refused' && ninth.jobId === undefined, `${String(ninth.status)} ${String(ninth.jobId ?? 'no id')}`)
  check('the refusal names the ceiling it hit', /At most \d+ background jobs may run at once/.test(String(ninth.message)), String(ninth.message).slice(0, 60))
  check('the refusal says what would make room', /job_kill|wait for one to settle|raise the ceiling/iu.test(String(ninth.hint)), String(ninth.hint).slice(0, 60))
  // A foreground call is not stopped by a full job lane — the reservation exists so
  // abandoned background work can never busy-lock the plugin.
  const inline = await ops.runCommand({ target: TARGET_LABEL, command: 'hostname' })
  check('a foreground command still runs with the job ceiling full', inline.run.status === 'succeeded', String(inline.run.status))
  // Release one slot, and the next call is admitted: the count is not leaking.
  registry.kill(ids[0])
  const released = Date.now()
  while (registry.running > cap - 1 && Date.now() - released < 15_000) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  check('killing a job gives its slot back', registry.running === cap - 1, `${String(registry.running)} still held`)
  const tenth = await ops.execBackground({ target: TARGET_LABEL, command: 'sleep 25 && echo TENTH' })
  check('the next background call is admitted once a slot is free', tenth.ok === true && typeof tenth.jobId === 'string', `${String(tenth.status)}`)
  await registry.settleAll()
  check('every job slot comes back when the jobs end', transport.laneUsage('background jobs') === 0 && transport.transfersInFlight === 0, `jobs ${String(transport.laneUsage('background jobs'))}`)
}

/**
 * The two failures the running product found in 0.0.34's first hours, pinned where
 * they can be re-run: a copy that cannot write where it was told to write must say
 * so at once, and a copy whose caller set a deadline must stop at that deadline.
 * Before the fix, a download into a path whose parent directory was missing sat
 * out the entire five-minute transfer deadline and then blamed the server with
 * "ran out of its deadline".
 */
cases.sink = async () => {
  const file = await ensureSource()
  const { mkdirSync: makeLocal } = require('node:fs')
  const blocked = join(LOCAL, 'in-the-way')
  makeLocal(blocked, { recursive: true })
  // 1. a landing path the local filesystem refuses
  for (const [label, local] of [['missing parent directory', join(LOCAL, 'no-such-dir', 'f.bin')], ['a directory in the way', blocked]]) {
    const started = Date.now()
    const out = await copy('download', local, file, { maxBytes: 1024 * 1024, timeoutMs: 20_000 })
    const took = Date.now() - started
    evidence(`${label}: ${out.status} after ${String(took)} ms — ${String(out.message).slice(0, 110)}`)
    // Two honest answers, depending on which half of the path is wrong: the sink
    // refused the bytes (failed, with the filesystem's own sentence), or the copy
    // landed and found the destination is a directory it must not pretend to
    // replace (refused-exists). What must never happen is the copy sitting out its
    // deadline and blaming the server.
    const reason = `${String(out.message)} ${String(out.hint)}`
    check(`${label}: the copy is refused, not timed out`, (out.status === 'failed' || out.status === 'refused-exists') && took < 8_000 && /written|ENOENT|EISDIR|no such file|flush|destination|directory/i.test(reason), `${String(out.status)} in ${String(took)} ms: ${reason.slice(0, 90)}`)
    check(`${label}: no stray file or part is left behind`, readdirSync(LOCAL).filter(name => name.includes('dsh-part-')).length === 0)
  }
  // 2. a deadline the caller chose actually bounds the copy: a fifo nobody feeds
  const idle = `${REMOTE}/sink-idle.fifo`
  await remote(`mkdir -p ${q(REMOTE)} && rm -f ${q(idle)} && mkfifo ${q(idle)}`)
  const began = Date.now()
  const stalled = await copy('download', join(LOCAL, 'idle.bin'), idle, { maxBytes: 8 * 1024 * 1024, timeoutMs: 1_500 })
  const waited = Date.now() - began
  evidence(`idle fifo with a 1500 ms deadline: ${stalled.status} after ${String(waited)} ms`)
  check("a caller's shorter deadline is honoured by the copy", stalled.status === 'failed' && /deadline/iu.test(String(stalled.message)) && waited < 12_000 && waited >= 1_400, `${String(stalled.status)} after ${String(waited)} ms`)
  check('the stalled copy freed its lane slot', transport.transfersInFlight === 0, String(transport.transfersInFlight))
}

/**
 * K-4, measured where 0.0.36 could only argue: two copies of **one** remote path,
 * running at the same time, one of them stopped and cleaned up while the other is
 * still parked. `cat -- <path>` was 0.0.36's answer to a stranded mover, and the path
 * is the one thing these two copies share — so the copy that was interrupted took the
 * copy that was working down with it. Here each mover reports its own pid, and the
 * cleanup may only name that number.
 */
cases.reap = async () => {
  const { reapMoverCommand, downloadMoverCommand, moverPid } = await import('../lib/transfer.js')
  const own = { ...target, pool: 'off' }
  // The shape a parked mover's argv really has on the server: `cat -- <path>`, with no
  // quotes, because the remote shell took care of those. The sshd session that started
  // the command still carries the quoted form in its own command line, so the unquoted
  // pattern is the one that counts *movers* rather than shells.
  const parked = (path) => `cat -- ${path}`
  const countOn = async (path) => (await remoteProcesses(parked(path))).length
  const alive = async (pid) => /alive/u.test(String((await remote(`kill -0 ${String(pid)} 2>/dev/null && echo alive || echo dead`)).stdout))

  /**
   * Start one parked mover, in exactly the shape a download starts it, and hand back
   * the pid it reported plus the handle that owns its channel.
   *
   * The mover is this plugin's command line — `downloadMoverCommand` — and it parks
   * in `open()` on a fifo nobody has written, which is the state a stopped copy leaves
   * behind on a real server. Driving it from here rather than from two concurrent
   * `copy()` calls is what makes the checks deterministic: a copy's own teardown can
   * end the ssh session, and an ended session takes its child with it, which would let
   * a *passing* count prove nothing about the cleanup.
   */
  async function parkMover (path, tag) {
    const handle = await transport.startRun(own, { ...settings, remoteTimeoutMs: 120_000 }, auth, downloadMoverCommand(q(path), tag), {})
    let marker = ''
    let pid
    for (let wait = 0; wait < 60 && pid === undefined; wait += 1) {
      await new Promise(resolve => setTimeout(resolve, 250))
      const stderrSource = handle?.sources?.find(source => source.channel === 'stderr')
      marker = String(stderrSource?.read(0).text ?? '')
      pid = moverPid(marker, tag)
    }
    return { handle, marker, pid }
  }

  await remote(`mkdir -p ${q(REMOTE)}`)
  const one = `${REMOTE}/reap-one.fifo`
  const two = `${REMOTE}/reap-two.fifo`
  const odd = `${REMOTE}/reap a b [x] * ? + .f`
  await remote(`rm -f ${q(one)} ${q(two)} ${q(odd)} && mkfifo ${q(one)} && mkfifo ${q(two)} && mkfifo ${q(odd)}`)

  // ── 1. the misfire case, on one server, one path, two live movers ─────────
  const stampTag = (name) => `${name}${stamp}`
  const aTag = stampTag('a'), bTag = stampTag('b')
  const moverA = await parkMover(one, aTag)
  const moverB = await parkMover(one, bTag)
  check('two movers of one path are parked on it at once', typeof moverA.pid === 'number' && typeof moverB.pid === 'number' && moverA.pid !== moverB.pid && (await countOn(one)) === 2, `pids ${String(moverA.pid)} and ${String(moverB.pid)}, ${String(await countOn(one))} movers`)
  const reapA = await remote(reapMoverCommand(moverA.pid ?? -1, q(one)))
  check('the first copy ends its own mover, confirmed from that mover\u2019s command line', /dsh-reap killed/u.test(String(reapA.stdout)), String(reapA.stdout).trim().slice(0, 24))
  await new Promise(resolve => setTimeout(resolve, 300))
  check('the mover that belonged to the other copy is still parked', await alive(moverB.pid), `pid ${String(moverB.pid)} alive`)
  check('and exactly one mover is left on the shared path', (await countOn(one)) === 1, `${String(await countOn(one))} left`)
  const reapAgain = await remote(reapMoverCommand(moverA.pid ?? -1, q(one)))
  check('a cleanup run twice says gone, and never claims a second kill', /dsh-reap gone/u.test(String(reapAgain.stdout)), String(reapAgain.stdout).trim().slice(0, 24))
  // The survivor is not merely a process that still exists: fed, it carries the
  // payload through the channel its own copy owns.
  const fed = await transport.startRun(own, { ...settings, remoteTimeoutMs: 20_000 }, auth, `printf 'payload-for-B\\n' > ${q(one)}`, {})
  let delivered = ''
  for (let wait = 0; wait < 40 && !delivered.includes('payload-for-B'); wait += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    const out = moverB.handle?.sources?.find(source => source.channel === 'stdout')
    delivered = String(out?.read(0).text ?? '')
  }
  fed.kill()
  await fed.finished
  check('the surviving copy still delivers its payload whole after the other was reaped', delivered.includes('payload-for-B\n'), JSON.stringify(delivered.slice(0, 20)))
  const survivorDone = await moverB.handle?.finished
  check('and its own channel closes cleanly, not as a killed transfer', survivorDone?.exitCode === 0, `exit ${String(survivorDone?.exitCode)} signal ${String(survivorDone?.signal)}`)
  moverA.handle?.kill()
  await moverA.handle?.finished

  // 2. two movers on **different** paths: neither cleanup can reach the other.
  const cTag = stampTag('c'), dTag = stampTag('d')
  const moverC = await parkMover(two, cTag)
  const moverD = await parkMover(odd, dTag)
  check('a mover is parked on each of two paths', typeof moverC.pid === 'number' && typeof moverD.pid === 'number', `pids ${String(moverC.pid)} / ${String(moverD.pid)}`)
  const reapC = await remote(reapMoverCommand(moverC.pid ?? -1, q(two)))
  const reapD = await remote(reapMoverCommand(moverD.pid ?? -1, q(odd)))
  check('each is ended by its own cleanup, on a path whose name contains shell metacharacters', /dsh-reap killed/u.test(String(reapC.stdout)) && /dsh-reap killed/u.test(String(reapD.stdout)), `${String(reapC.stdout).trim().slice(0, 12)} | ${String(reapD.stdout).trim().slice(0, 12)}`)
  check('the odd path holds no mover afterwards', await countOn(odd) === 0, String(await countOn(odd)))
  moverC.handle?.kill(); await moverC.handle?.finished
  moverD.handle?.kill(); await moverD.handle?.finished

  // ── 3. the identity rule: a pid that is not this copy's mover is left alone ──
  const held = await parkMover(one, stampTag('e'))
  if (typeof held.pid === 'number') {
    const wrong = await remote(reapMoverCommand(held.pid, q(`${REMOTE}/some-other-copy`)))
    check('a cleanup aimed with another copy\u2019s path word refuses to kill', /dsh-reap foreign/u.test(String(wrong.stdout)), String(wrong.stdout).trim().slice(0, 20))
    check('and refusing costs the mover nothing', await alive(held.pid), `pid ${String(held.pid)} still alive`)
    // A pid that has already been recycled to an unrelated process is the other half
    // of the same rule: the mover is gone, and the number is not theirs to kill.
    const sleeper = await transport.startRun(own, { ...settings, remoteTimeoutMs: 30_000 }, auth, 'sleep 30', {})
    const sleeperLines = await remoteProcesses('sleep 30')
    const sleeperPid = Number((sleeperLines[0] ?? '').trim().split(/\s+/u)[0])
    if (Number.isSafeInteger(sleeperPid) && sleeperPid > 0) {
      const recycled = await remote(reapMoverCommand(sleeperPid, q(one)))
      check('a recycled pid running something else is reported as foreign, not as cleaned', /dsh-reap foreign/u.test(String(recycled.stdout)), String(recycled.stdout).trim().slice(0, 20))
      check('and the unrelated process survives it', await alive(sleeperPid), `pid ${String(sleeperPid)} alive`)
    }
    sleeper.kill(); await sleeper.finished
    const right = await remote(reapMoverCommand(held.pid, q(one)))
    check('the same cleanup, aimed correctly, ends that mover', /dsh-reap killed/u.test(String(right.stdout)), String(right.stdout).trim().slice(0, 20))
    held.handle?.kill(); await held.handle?.finished
  }
  check('the shared path is empty of movers once this case is done', (await untilGone(parked(one), 5_000)) !== null, String(await countOn(one)))

  // ── 4. the product path: a copy this plugin stopped, end to end ────────────
  // A real download, real deadline, real teardown: the note has to name the mover it
  // ended by pid, and the path must be left holding nothing.
  const prod = `${REMOTE}/reap-prod.fifo`
  await remote(`rm -f ${q(prod)} && mkfifo ${q(prod)}`)
  for (let round = 1; round <= 3; round += 1) {
    const out = await copy('download', join(LOCAL, `reap-prod-${String(round)}.bin`), prod, { timeoutMs: 1_500 })
    const note = String((out.notes ?? []).join(' | ').replace('The copy had moved 0 bytes when the deadline took it down. | ', ''))
    const parkedNow = await countOn(prod)
    // Either the copy names the mover it ended, or it says nothing about a mover at
    // all (the mover left with the channel, which the cleanup reported as `gone`), or it
    // states a verdict that could not be proved. What may never happen is a claim of an
    // ended mover while one is still parked, or a claim about "everything matching a
    // path", which is the 0.0.36 form this release replaced.
    evidence(`round ${String(round)} mover accounting: ${note === '' ? 'silent (gone with the channel)' : note.slice(0, 150)}`)
    if (/got no answer/u.test(note)) {
      // The copy said plainly that it could not prove the outcome. Ask the same
      // question from a child this case owns, and record what the server answers:
      // "the cleanup child never got through" and "the mover was already gone" are
      // different facts, and only the second one is a pass for the server. A transfer
      // that lost its channel also stops trusting the shared master, so the next child
      // has to dial again — which is when this can happen at all.
      const pid = Number(/pid (\d+)/u.exec(note)?.[1])
      const direct = await remote(reapMoverCommand(Number.isSafeInteger(pid) ? pid : -1, q(prod)))
      evidence(`  re-ask for pid ${String(pid)}: status ${String(direct.status)}, exit ${String(direct.exitCode)}, said ${JSON.stringify(String(direct.stdout ?? '').trim()).slice(0, 34)}, stderr ${JSON.stringify(String(direct.stderr ?? '').trim()).slice(0, 70)}`)
    }
    check(`copy stopped on its deadline (round ${String(round)}): refused, and its mover accounted for`, out.status === 'failed' && /ran out of its deadline/u.test(String(out.message)) && parkedNow === 0 && (/ended its own server-side mover/u.test(note) || /mover/u.test(note) === false || /got no answer|now running something else|refused the signal|no readable \/proc/u.test(note)), `${String(out.status)}, ${String(parkedNow)} mover(s)`)
  }
  const cancelled = new AbortController()
  const running = copy('download', join(LOCAL, 'reap-cancel.bin'), prod, { timeoutMs: 30_000, signal: cancelled.signal })
  await new Promise(resolve => setTimeout(resolve, 1_500))
  cancelled.abort()
  const outCancel = await running
  const cancelNote = String((outCancel.notes ?? []).join('\n'))
  await new Promise(resolve => setTimeout(resolve, 500))
  check('a locally cancelled copy is refused as a cancellation and leaves no mover', outCancel.status === 'failed' && /cancelled/u.test(String(outCancel.message)) && (await countOn(prod)) === 0, `${String(outCancel.status)}, ${String(await countOn(prod))} mover(s), note ${cancelNote === '' ? 'none (nothing was left to end)' : cancelNote.replace(/^.*server-side|^the interrupted/u, m => m.slice(0, 30)).slice(0, 60)}`)
  const dying = copy('download', join(LOCAL, 'reap-dying.bin'), prod, { timeoutMs: 30_000 })
  let killedChild = false
  for (let wait = 0; wait < 40 && !killedChild; wait += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    const lines = localProcesses(parked(q(prod)))
    const pid = Number((lines[0] ?? '').trim().split(/\s+/u)[0])
    if (Number.isSafeInteger(pid) && pid > 0) {
      process.kill(pid, 'SIGKILL')
      killedChild = true
      evidence(`the local ssh child ${String(pid)} was SIGKILLed mid-copy, so the plugin's own teardown never ran for that channel`)
    }
  }
  const died = await dying
  const diedNote = String((died.notes ?? []).join(' | '))
  evidence(`copy whose channel was cut: ${String(died.status)} — ${String(died.message).slice(0, 60)}`)
  evidence(`its own account of the mover: ${diedNote === '' ? 'nothing claimed' : diedNote.slice(0, 150)}`)
  check('a copy whose channel died is reported, not swallowed', died.status === 'failed', String(died.status))
  // The honest-report rule, in the one case where the plugin's own teardown never
  // ran: this child was stopped by force, from outside the plugin. A mover may still
  // be parked, and that is a pass **only** if the copy said so instead of claiming it
  // had ended one.
  const leftAfterCut = await countOn(prod)
  const claimedAnEnd = /ended its (own )?server-side mover/u.test(diedNote)
  check('and what it says about the mover matches what the server holds', leftAfterCut === 0 || claimedAnEnd === false, `${String(leftAfterCut)} mover(s) left; claimed an ended mover: ${String(claimedAnEnd)}`)
  const afterDeath = await untilGone(parked(prod), 4_000)
  check('either the mover is gone, or the copy named the residual rather than hiding it', afterDeath !== null || /never reported a server-side mover pid|got no answer|cannot say whether/u.test(diedNote), afterDeath === null ? `still parked: ${String(await countOn(prod))}, note ${diedNote.slice(0, 90) || 'none'}` : `gone after ${String(afterDeath)} ms`)
  if (afterDeath === null) {
    const strays = await remoteProcesses(parked(prod))
    for (const line of strays) {
      const pid = Number(String(line).trim().split(/\s+/u)[0])
      if (Number.isSafeInteger(pid) && pid > 0) await remote(`kill -9 ${String(pid)} 2>/dev/null || true`)
    }
    evidence(`the case ended its own leftover mover(s) so the run leaves nothing parked: ${strays.map(line => String(line).trim().split(/\s+/u)[0]).join(', ')}`)
  }
  check('a stopped copy leaves no half file beside the destination', readdirSync(LOCAL).filter(name => name.includes('.dsh-part-')).length === 0)
  evidence(`honest-report check: the notes a stopped copy may print are only ${JSON.stringify(['ended its own server-side mover (confirmed)', 'gone (silent)', 'foreign (nothing killed)', 'unanswered (cannot tell)']).slice(0, 120)}`)
  check('and no note ever claims a path-wide kill', /pkill/u.test([diedNote, cancelNote].join(' ')) === false)
  await remote(`rm -f ${q(one)} ${q(two)} ${q(odd)} ${q(prod)}`)
}

/**
 * The reservation behind the job ceiling, measured with real children: 0.0.36's
 * configuration let a profile hand **all 16** operation slots to background jobs,
 * while its comment promised eight would always stay open for calls that wait. The
 * cap is now a number the schema refuses above, a number `bounds.ts` corrects, and a
 * number the transport clamps again where the slot is taken — this case is the last
 * of those three, run against a server.
 */
cases.jobcap = async () => {
  const asked = { ...settings, maxRunningJobs: 16 }
  const held = []
  for (let i = 0; i < 8; i += 1) {
    const job = await transport.startRun(target, asked, auth, `sleep 25 && printf 'C%d\\n' ${String(i)}`, { job: true })
    if (job !== undefined) held.push(job)
  }
  check('eight background jobs are admitted, whatever the ceiling asked for', held.length === 8 && transport.laneUsage('background jobs') === 8, `lane ${String(transport.laneUsage('background jobs'))}, table ${String(transport.inFlight)}`)
  let ninth
  try {
    await transport.startRun(target, asked, auth, 'sleep 25', { job: true })
  } catch (error) { ninth = error }
  check('the ninth is refused at the cap that is in force, not at 16', /At most 8 background jobs/u.test(String(ninth?.message)), String(ninth?.message ?? 'admitted').slice(0, 90))
  check('and the refusal says the ceiling cannot simply be raised', /held back for calls a reader is waiting on/u.test(String(ninth?.hint)), String(ninth?.hint ?? '').slice(0, 90))
  const inline = await ops.runCommand({ target: TARGET_LABEL, command: 'printf RESERVE_OK' })
  check('a foreground command runs with the job lane full', String(inline.run.stdout ?? '').includes('RESERVE_OK'), String(inline.run.stdout ?? '').trim().slice(0, 40))
  // Two more foreground children, and the table still has room: the job lane stopped
  // at 8 while 8 slots of the reservation went unused. Filling all 16 channels here
  // would test the server's own `MaxSessions` rather than this plugin's arithmetic,
  // which `tests/transport.test.mjs` already drives to 16 and past it with real
  // children and no network in the way.
  const alsoRunning = []
  for (let i = 0; i < 2; i += 1) {
    const job = await transport.startRun(target, asked, auth, 'sleep 20', {})
    if (job !== undefined) alsoRunning.push(job)
  }
  check('the reserved half of the table is open for calls that wait: 8 jobs plus 2 commands, 6 slots spare', transport.inFlight === 10 && alsoRunning.length === 2, `in flight ${String(transport.inFlight)}, commands ${String(alsoRunning.length)}`)
  for (const handle of [...held, ...alsoRunning]) {
    handle.kill()
    await handle.finished
  }
  check('every slot came back when the children ended', transport.inFlight === 0 && transport.laneUsage('background jobs') === 0, `in flight ${String(transport.inFlight)}`)
  const one = { ...settings, maxRunningJobs: 1 }
  const first = await transport.startRun(target, one, auth, 'sleep 20', { job: true })
  let second
  try {
    await transport.startRun(target, one, auth, 'sleep 20', { job: true })
  } catch (error) { second = error }
  check('a lane configured to one job holds one job, and no more', first !== undefined && /At most 1 background jobs/u.test(String(second?.message)), String(second?.message ?? 'admitted').slice(0, 60))
  const free = await ops.runCommand({ target: TARGET_LABEL, command: 'printf ONE_OK' })
  check('and a single-slot job lane still leaves the table open', String(free.run.stdout ?? '').includes('ONE_OK'), String(free.run.status))
  if (first !== undefined) {
    first.kill()
    await first.finished
  }
  check('the whole reservation returns after the smallest lane ends', transport.inFlight === 0 && transport.laneUsage('background jobs') === 0, `in flight ${String(transport.inFlight)}`)
}

/**
 * K-6, on a server rather than in a parser: the read states a byte count and a digest,
 * and the caller has to honour both. The case that matters is the one no length check
 * can see — a file whose bytes are not valid UTF-8 comes back as text, and an edit
 * that trusted the text would write replacement characters into the file and call the
 * result verified, because the bytes it sent are the bytes that landed.
 */
cases.framing = async () => {
  const { verifyEditBody } = await import('../lib/edit.js')
  const latin = `${REMOTE}/framing-latin1`
  const big = `${REMOTE}/framing-big`
  const markers = `${REMOTE}/framing-markers`
  await remote(`mkdir -p ${q(REMOTE)} && printf '\\377A\\nTARGET' > ${q(latin)} && printf 'ssh-plugin: 1|2|3\\nssh-plugin-sha256: zz\\nssh-plugin-bytes: 7\\nrest\\n' > ${q(markers)} && for i in $(seq 1 2000); do printf '\\344\\270\\255\\346\\226\\207 abc\\n'; done > ${q(big)}`)
  const frame = async (path) => {
    const read = await remote(buildEditRead(q(path)))
    const parsed = splitEditVersion(read.stdout ?? '')
    return { parsed, check: verifyEditBody(parsed.content, { ...(parsed.bodyBytes === undefined ? {} : { bytes: parsed.bodyBytes }), ...(parsed.digest === undefined ? {} : { digest: parsed.digest }) }) }
  }
  const latinFrame = await frame(latin)
  evidence(`latin-1 read: declared ${String(latinFrame.parsed.bodyBytes)} bytes, body ${String(Buffer.byteLength(latinFrame.parsed.content))} bytes, digest stated: ${latinFrame.parsed.digest === undefined ? 'no' : 'yes'}`)
  check('a read of bytes that are not UTF-8 notices on the server, not only in a parser', latinFrame.check.ok === false && latinFrame.check.reason === 'not-the-same-bytes', JSON.stringify(latinFrame.check).slice(0, 90))
  const latinHash = await remote(`sha256sum -- ${q(latin)} 2>/dev/null | cut -c1-12 || true`)
  check('and the file it refused is the file that was there', /7f|80|ff|[0-9a-f]{12}/u.test(String(latinHash.stdout).trim()), String(latinHash.stdout).trim().slice(0, 20))
  const bigFrame = await frame(big)
  check('a 20 KB body of multi-byte text frames as itself', bigFrame.check.ok === true && bigFrame.check.evidence === 'digest', JSON.stringify(bigFrame.check).slice(0, 60))
  check('the count the server stated is the file it stated', bigFrame.parsed.bodyBytes === Buffer.byteLength(bigFrame.parsed.content), `${String(bigFrame.parsed.bodyBytes)} vs ${String(Buffer.byteLength(bigFrame.parsed.content))}`)
  const markerFrame = await frame(markers)
  check('a file that begins with the protocol’s own words keeps its first line', markerFrame.parsed.content.startsWith('ssh-plugin: 1|2|3'), JSON.stringify(String(markerFrame.parsed.content).slice(0, 24)))
  check('and its framing is still proved, by digest and by count', markerFrame.check.ok === true && markerFrame.check.evidence === 'digest', JSON.stringify(markerFrame.check).slice(0, 60))
  // A body the stream clipped is a refusal, not a short edit: cut the tail off the
  // bytes the split produced and the count has to answer for it.
  const clipped = verifyEditBody(bigFrame.parsed.content.slice(0, -8), { bytes: bigFrame.parsed.bodyBytes })
  check('a body short of the stated count is refused by the count', clipped.ok === false && clipped.reason === 'body-short', JSON.stringify(clipped).slice(0, 70))
  const extended = verifyEditBody(`${bigFrame.parsed.content}a line the file never had\n`, { bytes: bigFrame.parsed.bodyBytes, digest: bigFrame.parsed.digest })
  check('and so is one the stream made longer', extended.ok === false && extended.reason === 'not-the-same-bytes', JSON.stringify(extended).slice(0, 70))
}

const order = ['plain', 'grow', 'overwrite', 'modes', 'tilde', 'lane', 'tree', 'edit', 'capability', 'spill', 'jobs', 'temp', 'sink', 'reap', 'jobcap', 'framing', 'release']
process.stdout.write(`\n@jie2gg/dsh-plugin-ssh live check against "${TARGET_LABEL}"\nscratch: ${LOCAL} ⇄ ${REMOTE}\n\n`)

let failure = null
try {
  await askpass.prepare()
  await mux.prepare()
  const run = only === null ? order : [only]
  for (const name of run) {
    const fn = cases[name]
    if (fn === undefined) throw new Error(`no such case: ${name}`)
    process.stdout.write(`── ${name} ──\n`)
    try {
      await fn()
    } catch (error) {
      failure = error
      check(`${name}: threw`, false, error instanceof Error ? error.message : String(error))
    }
    process.stdout.write('\n')
  }
} finally {
  try { await remote(`rm -rf ${q(REMOTE_ROOT)}`) } catch { /* the server keeps what it keeps */ }
  await registry.settleAll().catch(() => undefined)
  transport.dispose()
  await mux.dispose()
  await askpass.dispose()
  const ours = readdirSync(tmpdir()).filter(name => name.startsWith('dsh-ssh-'))
  evidence(`temp namespace left behind for this uid: ${ours.length === 0 ? 'nothing' : ours.join(', ')}`)
  if (flag('keep', '') !== '') {
    evidence(`local scratch kept at ${LOCAL}`)
  } else {
    const { rmSync } = require('node:fs')
    rmSync(LOCAL, { recursive: true, force: true })
  }
}

process.stdout.write(`\n${String(results.filter(result => result.ok).length)} passed, ${String(failed)} failed\n`)
if (failure !== null) process.stdout.write(`uncaught: ${failure instanceof Error ? failure.stack : String(failure)}\n`)
process.exitCode = failed === 0 && failure === null ? 0 : 1
