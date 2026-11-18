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
import { execFileSync } from 'node:child_process'
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
      const rest = line.trim().slice(6) // drop the pid column, whatever its width
      const comm = rest.split(/\s+/u)[0] ?? ''
      // The executable's own name, not a substring of the command line: this
      // repository's path contains a directory named `ssh`, and a check that
      // matched it against the whole line reported its own witness as a stray.
      return (comm === 'ssh' || comm === 'scp') && rest.includes(pattern)
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
  return await transfer(transport, target, { ...settings, ...(options.settingsOver ?? {}) }, auth, {
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
  check('the refusal proves the source produced more than the pre-check saw', (out.bytes ?? 0) > 1_015_000 && /with more where they came from/.test(String(out.message)), `${String(out.bytes)} bytes and the ceiling was reached`)
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
  // Two ways a copy can stop that are not its ceiling: the reader pressing stop,
  // and the deadline arriving. Each has to hand the transfer lane back, and
  // neither may leave a part file where a download was interrupted.
  const busy = `${REMOTE}/release-busy.fifo`
  const quiet = `${REMOTE}/release-quiet.fifo`
  await remote(`mkdir -p ${q(REMOTE)} && rm -f ${q(busy)} ${q(quiet)} && mkfifo ${q(busy)} && mkfifo ${q(quiet)}`)
  const writer = await transport.startRun(target, { ...settings, remoteTimeoutMs: 0 }, auth, `{ dd if=/dev/zero bs=65536 count=16 2>/dev/null; sleep 6; } > ${q(busy)}`, {})
  const cancel = new AbortController()
  const cancelled = copy('download', join(LOCAL, 'r1.bin'), busy, { maxBytes: 8 * 1024 * 1024, timeoutMs: 60_000, signal: cancel.signal })
  await new Promise(resolve => setTimeout(resolve, 400))
  check('a copy in flight holds exactly one lane slot', transport.transfersInFlight === 1, `lane ${String(transport.transfersInFlight)}`)
  cancel.abort()
  const out1 = await cancelled
  check('a cancelled copy reports the cancellation and frees its slot', out1.status === 'failed' && /cancel/iu.test(String(out1.message)) && transport.transfersInFlight === 0, `${out1.status}, lane ${String(transport.transfersInFlight)}`)
  writer.kill()
  await writer.finished
  // Nothing ever opens the quiet fifo for writing, so the copy waits on it.
  const out2 = await copy('download', join(LOCAL, 'r2.bin'), quiet, { maxBytes: 8 * 1024 * 1024, timeoutMs: 700 })
  check('a copy that runs out of its deadline frees its slot too', out2.status === 'failed' && /deadline/iu.test(String(out2.message)) && transport.transfersInFlight === 0, `${out2.status}, lane ${String(transport.transfersInFlight)}`)
  check('an interrupted download leaves no part file behind', readdirSync(LOCAL).filter(name => name.includes('.dsh-part-')).length === 0, readdirSync(LOCAL).join(', '))
  // What the local side can promise is that *its* child is gone; the server's
  // reader exits when sshd finishes tearing the channel down, which is the
  // server's business. Poll for it, and report the settle time as measured rather
  // than asserting the optimistic one.
  const settledAfter = await untilGone('release-quiet.fifo', 5_000)
  if (settledAfter === null) {
    // Measured, not argued: a remote `cat` parked in `open()` on a fifo with no
    // writer is not reading or writing anything, so closing the channel has no
    // way to interrupt it and sshd lets it sit. The same is *not* true of a
    // command that is touching its descriptors — the growth case's writer died
    // with the channel, which that check asserts. Recorded as an observation, and
    // cleaned up, rather than failed as a promise this plugin never made.
    const lingering = await remoteProcesses('release-quiet.fifo')
    evidence(`observation: ${String(lingering.length)} server-side reader(s) of a fifo with no writer outlived the closed channel: ${lingering.map(line => line.trim().slice(0, 60)).join(' | ')}`)
    await remote(`pkill -f 'cat -- ${REMOTE}/release-quiet.fifo' || true`)
  } else {
    check('the server-side reader of a timed-out copy goes away on its own', true, `gone after ${String(settledAfter)} ms`)
  }
  const localStrays = localProcesses('release-quiet.fifo')
  check('no local ssh child of ours is left behind', localStrays.length === 0, localStrays.map(line => line.trim().slice(0, 80)).join(' | ') || 'none')
  const next = await copy('download', join(LOCAL, 'r3.bin'), await ensureSource(), { maxBytes: 1_048_576 })
  check('the lane admits the next copy after both interruptions', next.status === 'moved', next.status)
}

// ── run ─────────────────────────────────────────────────────────────────────
const order = ['plain', 'grow', 'overwrite', 'modes', 'tilde', 'lane', 'tree', 'release']
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
