/** Installation management: release metadata and the plugin-managed `gh` copy. @module dsh-plugin-github/installer */

import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { GhFailure, ManagedCopyView, ReleaseView } from './types.ts'
import { GhError } from './types.ts'
import type { GhClient } from './gh.ts'
import { firstLine, parseGhVersion } from './gh.ts'
import type { JobApi } from './jobs.ts'
import { EXTRACT_TIMEOUT_MS } from './config.ts'

/** Release metadata cache lifetime before the page has to ask again. */
const RELEASE_TTL_MS = 15 * 60_000

/** Bytes of download progress between two log lines. */
const PROGRESS_STEP_BYTES = 2 * 1024 * 1024

/** API endpoint for the newest published GitHub CLI release. */
const LATEST_RELEASE_URL = 'https://api.github.com/repos/cli/cli/releases/latest'

/** Download timeout for the small checksums file and the release archive. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** One release plus the assets this platform would use. */
interface ReleaseAssets {
  view: ReleaseView
  archiveName: string
  archiveUrl?: string
  checksumsUrl?: string
}

/**
 * Map the running platform onto GitHub CLI release asset naming.
 * @param platform - Node platform name, defaulting to this process.
 * @param arch - Node architecture name, defaulting to this process.
 * @returns the target description, with `supported` false where no tarball path applies.
 */
export function platformTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): {
  goos: string
  goArch: string
  packaging: 'tar.gz' | 'zip' | 'msi'
  supported: boolean
  hint?: string
} {
  if (platform === 'linux') {
    const goArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : arch === 'ia32' ? '386' : arch === 'arm' ? 'armv6' : undefined
    if (goArch === undefined) {
      return {
        goos: 'linux',
        goArch: arch,
        packaging: 'tar.gz',
        supported: false,
        hint: `No GitHub CLI tarball exists for linux/${arch}; use your distribution's package instead.`,
      }
    }
    return { goos: 'linux', goArch, packaging: 'tar.gz', supported: true }
  }
  if (platform === 'darwin') {
    const goArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : arch
    return {
      goos: 'darwin',
      goArch,
      packaging: 'zip',
      supported: false,
      hint: 'macOS releases ship as .zip or .pkg; install with Homebrew (brew install gh) or the official installer.',
    }
  }
  return {
    goos: platform,
    goArch: arch,
    packaging: 'msi',
    supported: false,
    hint: 'Windows releases ship as .zip or .msi; install with winget install GitHub.cli.',
  }
}

/**
 * Directory and file this plugin manages its own `gh` copy in.
 * @param env - environment to read `XDG_DATA_HOME` and `OS` from, defaulting to this process.
 * @param home - home directory fallback, defaulting to the operating system's.
 * @returns the managed directory and the binary path inside it.
 */
export function managedPaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): { dir: string; path: string; work: string } {
  const base = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.trim() !== '' ? env.XDG_DATA_HOME : join(home, '.local', 'share')
  const root = join(base, 'dsh-plugin-github')
  const name = env.OS === 'Windows_NT' ? 'gh.exe' : 'gh'
  return { dir: join(root, 'bin'), path: join(root, 'bin', name), work: join(root, 'download') }
}

/** Outcome of one managed install. */
export interface InstallOutcome {
  path: string
  version: string
  bytes: number
  /** True when PATH still resolves a different `gh`, so pointing the plugin at this copy is the next step. */
  shadowed: boolean
}

/**
 * Turn one `gh_<version>_checksums.txt` body into a digest lookup.
 * @param text - the whole checksums file.
 * @returns lower-cased file name to hex digest.
 */
export function checksumsOf(text: string): Map<string, string> {
  const digests = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\S*?\/?([\w.+-]+)$/iu.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) digests.set(match[2].toLowerCase(), match[1].toLowerCase())
  }
  return digests
}

/** Reads api.github.com and manages the plugin's own `gh` copy on disk. */
export class GithubInstaller {
  private cache?: { assets?: ReleaseAssets; error?: GhFailure; checkedAt: number }

  constructor(
    private readonly gh: GhClient,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  /** Last cached release check, so `status` never blocks on the network. */
  get cached(): { latest?: ReleaseView; checkError?: GhFailure; checkedAt: number } {
    if (this.cache === undefined) return { checkedAt: 0 }
    const { assets, error, checkedAt } = this.cache
    return { ...assets === undefined ? {} : { latest: assets.view }, ...error === undefined ? {} : { checkError: error }, checkedAt }
  }

  /**
   * Read the newest release, reusing a cached answer while it is fresh.
   * @param force - bypass the cache, which is what the page's check and retry actions do.
   * @returns the release facts and when they were checked.
   * @throws {GhError} `network` when api.github.com cannot be read, or `bad-input` for an unreadable payload.
   */
  async release(force = false): Promise<{ latest: ReleaseView; checkedAt: number }> {
    const assets = await this.assets(force)
    return { latest: assets.view, checkedAt: this.cache?.checkedAt ?? Date.now() }
  }

  /**
   * Describe the plugin-managed copy by running it.
   * @param activePath - path the plugin currently resolves, used to detect shadowing.
   * @returns the managed copy facts, or `undefined` when no managed copy exists.
   */
  async managed(activePath?: string): Promise<ManagedCopyView | undefined> {
    const { dir, path } = managedPaths()
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
    } catch {
      return undefined
    }
    if (!info.isFile()) return undefined
    const direct = await this.gh.exec([path, '--version'], { timeoutMs: 10_000 }).catch((): undefined => undefined)
    const version = direct === undefined ? undefined : parseGhVersion(direct.stdout)
    return {
      dir,
      path,
      installedAt: info.mtimeMs,
      ...version === undefined ? {} : { version },
      shadowed: activePath === undefined ? true : activePath !== path,
    }
  }

  /**
   * Download, verify, unpack, and install the newest release into the managed directory.
   * @param api - job progress channel and cancellation signal.
   * @returns the installed path, version, size, and whether PATH still prefers another copy.
   * @throws {GhError} `unsupported-platform`, `network`, `checksum`, `extract`, `permission`, `timeout`, or `busy`.
   */
  async install(api: JobApi): Promise<InstallOutcome> {
    const target = platformTarget()
    if (!target.supported) {
      throw new GhError(
        'unsupported-platform',
        `Automatic install unpacks linux tarballs only; this host is ${target.goos}/${target.goArch}.`,
        target.hint ?? 'Install gh with this system’s package manager, then point the plugin at it.',
      )
    }
    const tar = await this.gh.helper('tar')
    if (tar === undefined) {
      throw new GhError('extract', 'No tar executable on this host, so the plugin cannot unpack a release.', 'Install tar, or use your package manager for gh.')
    }
    const assets = await this.assets(true)
    const { archiveName, archiveUrl, checksumsUrl } = assets
    const view = assets.view
    if (archiveUrl === undefined || checksumsUrl === undefined) {
      throw new GhError('network', `Release ${view.tag} lists no ${archiveName} archive or checksums file.`, 'Retry the release check, or install gh from your package manager.')
    }
    const { dir, path, work } = managedPaths()
    const staged = join(work, `stage-${view.version}`)
    const archivePath = join(work, archiveName)
    try {
      await mkdir(dir, { recursive: true })
      await mkdir(work, { recursive: true })
      await rm(staged, { recursive: true, force: true })
      await mkdir(staged, { recursive: true })
    } catch (error) {
      throw new GhError('permission', `Cannot prepare ${dir}: ${(error as Error).message}`, 'Check that your home directory is writable.', { cause: error })
    }
    api.log(`Installing gh ${view.version} for ${target.goos}/${target.goArch}.`)
    try {
      const expected = await this.readChecksums(api, checksumsUrl, archiveName)
      const digest = await this.download(api, archiveUrl, archivePath, expected)
      api.log(`sha256 ${digest.slice(0, 12)}… verified.`)
      api.log('Unpacking…')
      const unpacked = await this.gh.exec([tar, '-xzf', archivePath, '-C', staged], { timeoutMs: EXTRACT_TIMEOUT_MS, cwd: work })
      if (!unpacked.ok) throw new GhError('extract', `tar exited ${String(unpacked.exitCode)}.`, firstLine(unpacked.stderr))
      const binary = await this.findBinary(staged)
      await this.place(binary, path, api)
      const verify = await this.gh.exec([path, '--version'], { timeoutMs: 15_000 })
      const installed = parseGhVersion(verify.stdout)
      if (!verify.ok || installed === undefined) {
        throw new GhError('extract', `The installed ${path} did not report a version.`, firstLine(verify.stderr) ?? firstLine(verify.stdout))
      }
      const info = await stat(path)
      const active = await this.gh.executable()
      api.log(`Installed gh ${installed} at ${path}.`)
      return { path, version: installed, bytes: info.size, shadowed: active !== path }
    } finally {
      await rm(archivePath, { force: true }).catch(() => undefined)
      await rm(staged, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Delete the managed copy, keeping any directory the user put beside it.
   * @returns the removed path.
   * @throws {GhError} `permission` when the file cannot be removed.
   */
  async remove(): Promise<string> {
    const { path } = managedPaths()
    try {
      await rm(path, { force: true })
      await rm(`${path}.prev`, { force: true }).catch(() => undefined)
      await rm(`${path}.new`, { force: true }).catch(() => undefined)
    } catch (error) {
      throw new GhError('permission', `Could not remove ${path}: ${(error as Error).message}`, undefined, { cause: error })
    }
    return path
  }

  /**
   * Whether one path is inside this plugin's managed directory.
   * @param path - path to test.
   * @returns true when removing or pointing at it belongs to the managed copy.
   */
  static owns(path: string): boolean {
    const { dir } = managedPaths()
    return path.startsWith(`${dir}/`)
  }

  /** Fetch and cache the newest release with the assets this platform would use. */
  private async assets(force: boolean): Promise<ReleaseAssets> {
    const cached = this.cache?.assets
    if (!force && cached !== undefined && Date.now() - (this.cache?.checkedAt ?? 0) < RELEASE_TTL_MS) return cached
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-github' }
    // A token raises the limit from 60 to 5000 reads per hour; the secret never leaves the Host.
    const token = await this.gh.token().catch((): string | undefined => undefined)
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    let response: Response
    try {
      response = await this.fetchImpl(LATEST_RELEASE_URL, { headers, signal: AbortSignal.timeout(20_000) })
    } catch (error) {
      throw await this.fail(`Could not reach api.github.com: ${(error as Error).message}`, 'The host may sit behind a proxy; retry, or install gh with your package manager.', error)
    }
    if (!response.ok) {
      throw await this.fail(`api.github.com answered ${String(response.status)} for the latest release.`, 'GitHub may be rate-limiting this host; retry in a few minutes.')
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw await this.fail('The latest-release response was not JSON.', undefined, error)
    }
    const record = (body ?? {}) as { tag_name?: unknown; name?: unknown; html_url?: unknown; published_at?: unknown; assets?: unknown }
    const tag = typeof record.tag_name === 'string' ? record.tag_name : ''
    if (tag === '') throw await this.fail('The latest-release response carries no tag_name.', 'Retry the release check.')
    const target = platformTarget()
    const version = tag.replace(/^v/u, '')
    const archiveName = `gh_${version}_${target.goos}_${target.goArch}.tar.gz`
    const checksumsName = `gh_${version}_checksums.txt`
    const assets = Array.isArray(record.assets) ? (record.assets as Record<string, unknown>[]) : []
    const archive = assets.find(asset => asset.name === archiveName)
    const checksums = assets.find(asset => asset.name === checksumsName)
    const view: ReleaseView = {
      version,
      tag,
      name: typeof record.name === 'string' ? record.name : tag,
      url: typeof record.html_url === 'string' ? record.html_url : `https://github.com/cli/cli/releases/tag/${tag}`,
      publishedAt: typeof record.published_at === 'string' ? record.published_at : '',
      ...typeof archive?.size === 'number' ? { assetBytes: archive.size } : {},
      platformSupported: target.supported,
    }
    const result: ReleaseAssets = {
      view,
      archiveName,
      ...typeof archive?.browser_download_url === 'string' ? { archiveUrl: archive.browser_download_url } : {},
      ...typeof checksums?.browser_download_url === 'string' ? { checksumsUrl: checksums.browser_download_url } : {},
    }
    this.cache = { assets: result, checkedAt: Date.now() }
    return result
  }

  /** Cache one failed release read as a retryable network refusal, then throw it. */
  private async fail(message: string, hint: string | undefined, cause?: unknown): Promise<GhError> {
    const error = new GhError('network', message, hint, cause === undefined ? undefined : { cause })
    this.cache = { ...this.cache?.assets === undefined ? {} : { assets: this.cache.assets }, error: { code: error.code, message, ...hint === undefined ? {} : { hint } }, checkedAt: Date.now() }
    return error
  }

  /** Read the release checksums file and return the digest expected for one archive. */
  private async readChecksums(api: JobApi, url: string, archiveName: string): Promise<string> {
    api.log('Reading release checksums…')
    let response: Response
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'dsh-plugin-github' } })
    } catch (error) {
      throw new GhError('network', `Could not download the checksums file: ${(error as Error).message}`, 'Retry the install, or check this host’s network path to github.com.', { cause: error })
    }
    if (!response.ok) throw new GhError('network', `Checksums download answered ${String(response.status)}.`)
    const digests = checksumsOf(await response.text())
    const expected = digests.get(archiveName.toLowerCase())
    if (expected === undefined) throw new GhError('checksum', `The checksums file lists no ${archiveName}.`, 'The release may predate this plugin’s asset naming; install gh from your package manager.')
    return expected
  }

  /** Stream one asset to disk while hashing it, then compare the digest. */
  private async download(api: JobApi, url: string, target: string, expected: string): Promise<string> {
    let response: Response
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers: { 'user-agent': 'dsh-plugin-github' } })
    } catch (error) {
      throw new GhError('network', `Could not start the download: ${(error as Error).message}`, 'Retry the install; a proxy may block objects.githubusercontent.com.', { cause: error })
    }
    if (!response.ok) throw new GhError('network', `Download answered ${String(response.status)}.`)
    if (response.body === null) throw new GhError('network', 'Download returned an empty body.')
    const digest = createHash('sha256')
    let written = 0
    let nextLog = PROGRESS_STEP_BYTES
    const handle = await open(target, 'w')
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        if (api.signal.aborted) throw new GhError('timeout', 'Download cancelled.', undefined)
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer)
        digest.update(bytes)
        await handle.write(bytes)
        written += bytes.length
        if (written >= nextLog) {
          nextLog = written + PROGRESS_STEP_BYTES
          api.log(`Downloaded ${(written / (1024 * 1024)).toFixed(1)} MiB…`)
        }
      }
    } catch (error) {
      if (error instanceof GhError) throw error
      throw new GhError('network', `Download failed after ${written} bytes: ${(error as Error).message}`, 'Retry the install.', { cause: error })
    } finally {
      await handle.close().catch(() => undefined)
    }
    const actual = digest.digest('hex')
    if (actual !== expected) {
      await rm(target, { force: true }).catch(() => undefined)
      throw new GhError('checksum', `sha256 mismatch: expected ${expected}, got ${actual}.`, 'The download was corrupted in transit; retry the install.')
    }
    return actual
  }

  /** Locate the extracted `gh` binary under a staging directory. */
  private async findBinary(staged: string): Promise<string> {
    const top = await readdir(staged)
    const root = top[0]
    if (root === undefined) throw new GhError('extract', 'The release archive unpacked into an empty directory.')
    const candidate = join(staged, root, 'bin', 'gh')
    const info = await stat(candidate).catch((): undefined => undefined)
    if (info?.isFile() === true) return candidate
    throw new GhError('extract', `The unpacked release has no bin/gh under ${root}.`)
  }

  /** Move an unpacked binary into place, keeping the previous copy until the new one lands. */
  private async place(binary: string, target: string, api: JobApi): Promise<void> {
    try {
      await rename(binary, `${target}.new`)
    } catch (error) {
      throw new GhError('permission', `Cannot stage the new gh beside ${target}: ${(error as Error).message}`, 'Check that the managed directory is writable.', { cause: error })
    }
    try {
      if (await stat(target).then((): boolean => true, (): boolean => false)) await rename(target, `${target}.prev`)
    } catch (error) {
      api.log(`Could not set aside the previous copy: ${(error as Error).message}`)
    }
    try {
      await rename(`${target}.new`, target)
      await chmod(target, 0o755).catch(() => undefined)
    } catch (error) {
      throw new GhError('permission', `Cannot put the new gh in place: ${(error as Error).message}`, 'A running gh process may hold the file open; retry after it exits.', { cause: error })
    }
    await rm(`${target}.prev`, { force: true }).catch(() => undefined)
  }
}
