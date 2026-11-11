/**
 * Browser half of the GitHub plugin: one settings page that manages the local
 * `gh` binary and its accounts. It is authored as a module-loader script, so this
 * file must contain no runtime import or export statement — the emitted
 * `lib/client.js` is executed as a classic script by the web module table, and
 * React comes from that table through `require`.
 */

import type { AuthAccountView, AuthHostView, AuthStatusView, JobView, StatusView } from './types.ts'

window.__ModuleLoader__.load({
  id: '@jie2gg/dsh-plugin-github',
  factory(require: (specifier: string) => any) {
    const React = require('react')
    const h = React.createElement

    /** Route registered by the Host half of this bundle. */
    const ROUTE = '/api/github/rpc'

    /** Namespace the page's copy is registered under. */
    const NS = 'settings.github'

    /** A refusal the Host reports; thrown as-is so every action can show message plus hint. */
    interface Failure {
      code: string
      message: string
      hint?: string
    }

    /** Copy dictionaries, kept in the artifact because a plugin cannot load its own locale files in the browser. */
    const DICT: Record<string, Record<string, string>> = {
      en: {
        nav: 'GitHub CLI',
        title: 'GitHub CLI',
        intro: 'Manage the gh executable on this machine and the accounts it is signed in with. Every action runs on the Host that serves this page.',
        installation: 'Installation',
        accounts: 'Accounts',
        loading: 'Loading…',
        installed: 'Installed',
        notInstalled: 'Not installed',
        version: 'Version',
        latest: 'Latest',
        path: 'Executable',
        sourceConfig: 'chosen by this plugin',
        sourcePath: 'found on PATH',
        upToDate: 'Up to date',
        outdated: 'Update available',
        checkUpdate: 'Check for updates',
        checking: 'Checking…',
        checkFailed: 'The release check failed',
        retry: 'Retry',
        unknownVersion: 'unknown',
        managedCopy: 'Plugin-managed copy',
        managedNone: 'No managed copy yet.',
        managedDir: 'Managed directory',
        shadowed: 'Another gh is still active: {path}',
        notShadowed: 'This plugin is using the managed copy.',
        installLatest: 'Install latest release',
        installing: 'Installing…',
        removeManaged: 'Delete managed copy',
        confirmRemove: 'Confirm delete',
        cancel: 'Cancel',
        ghPath: 'gh executable for this plugin',
        ghPathHint: 'Absolute path (for example /usr/bin/gh) or a program name. Saving restarts the plugin.',
        save: 'Save',
        clear: 'Use gh from PATH',
        saved: 'Saved. Reloading status…',
        platformUnsupported: 'Automatic install is unavailable here: {hint}',
        extensions: 'Extensions',
        extensionsNone: 'None installed.',
        moreExtensions: '{count} more…',
        accountNone: 'gh is not signed in on any host.',
        active: 'active',
        scopes: 'scopes',
        tokenSource: 'stored in',
        gitProtocol: 'git protocol',
        setDefault: 'Make active',
        logout: 'Log out',
        confirmLogout: 'Confirm log out',
        copyToken: 'Copy token',
        copyCode: 'Copy code',
        copied: 'Copied',
        copyFailed: 'Copy failed; your browser blocked clipboard access.',
        loggedIn: 'Signed in',
        notSignedIn: 'Not signed in',
        signIn: 'Add an account',
        signInHost: 'Host',
        signInProtocol: 'Git protocol',
        signInScopes: 'Extra scopes',
        signInScopesHint: 'Optional, comma-separated. Leave empty for the gh defaults.',
        signInWeb: 'Sign in with the browser',
        signInToken: 'Sign in with a token',
        tokenPlaceholder: 'Paste a personal access token',
        deviceWaiting: 'Waiting for the browser sign-in to finish.',
        deviceCode: 'One-time code',
        deviceHelp: 'Open {url} on any device and enter the code. This machine keeps polling GitHub until you finish.',
        signedIn: 'Signed in.',
        signedOut: 'Logged out.',
        switched: 'Active account changed.',
        running: 'Running…',
        jobFailed: 'Failed',
        jobCancelled: 'Cancelled',
        jobUnknown: 'The plugin restarted while this was running; the result below is the current state.',
        tokenHint: 'The token never leaves the Host, and the page shows it only when you ask.',
        systemPackageManager: 'For apt, dnf, or Homebrew installs use the system package manager: this plugin never touches them.',
        close: 'Close settings',
      },
      zh: {
        nav: 'GitHub CLI',
        title: 'GitHub CLI',
        intro: '管理这台机器上的 gh 可执行文件，以及它登录的账号。每个动作都在提供本页面的 Host 上执行。',
        installation: '安装管理',
        accounts: '账号管理',
        loading: '加载中…',
        installed: '已安装',
        notInstalled: '未安装',
        version: '当前版本',
        latest: '最新版本',
        path: '可执行文件',
        sourceConfig: '由本插件指定',
        sourcePath: '来自 PATH',
        upToDate: '已是最新',
        outdated: '有可用更新',
        checkUpdate: '检查更新',
        checking: '正在检查…',
        checkFailed: '检查最新版失败',
        retry: '重试',
        unknownVersion: '未知',
        managedCopy: '插件托管副本',
        managedNone: '还没有托管副本。',
        managedDir: '托管目录',
        shadowed: '当前生效的仍是另一个 gh：{path}',
        notShadowed: '本插件正在使用托管副本。',
        installLatest: '安装最新版',
        installing: '正在安装…',
        removeManaged: '删除托管副本',
        confirmRemove: '确认删除',
        cancel: '取消',
        ghPath: '本插件使用的 gh 路径',
        ghPathHint: '绝对路径（例如 /usr/bin/gh）或程序名。保存会重启插件。',
        save: '保存',
        clear: '改用 PATH 上的 gh',
        saved: '已保存，正在刷新状态…',
        platformUnsupported: '当前平台不支持自动安装：{hint}',
        extensions: '扩展',
        extensionsNone: '未安装扩展。',
        moreExtensions: '另有 {count} 个…',
        accountNone: 'gh 在任何 host 上都未登录。',
        active: '当前',
        scopes: '权限范围',
        tokenSource: '存储方式',
        gitProtocol: 'git 协议',
        setDefault: '设为当前',
        logout: '登出',
        confirmLogout: '确认登出',
        copyToken: '复制令牌',
        copyCode: '复制代码',
        copied: '已复制',
        copyFailed: '复制失败，浏览器阻止了剪贴板访问。',
        loggedIn: '已登录',
        notSignedIn: '未登录',
        signIn: '添加账号',
        signInHost: '主机',
        signInProtocol: 'git 协议',
        signInScopes: '额外 scope',
        signInScopesHint: '可选，逗号分隔；留空使用 gh 默认值。',
        signInWeb: '用浏览器登录',
        signInToken: '用令牌登录',
        tokenPlaceholder: '粘贴访问令牌',
        deviceWaiting: '正在等待浏览器端登录完成。',
        deviceCode: '一次性代码',
        deviceHelp: '在任意设备打开 {url} 并输入该代码；这台机器会持续轮询 GitHub 直到你完成。',
        signedIn: '已登录。',
        signedOut: '已登出。',
        switched: '已切换当前账号。',
        running: '执行中…',
        jobFailed: '失败',
        jobCancelled: '已取消',
        jobUnknown: '执行期间插件已重启，下面的结果是重新读取的当前状态。',
        tokenHint: '令牌不会离开 Host；只有你主动请求时页面才会取用。',
        systemPackageManager: 'apt / dnf / Homebrew 安装的 gh 请继续用系统包管理器；本插件不会改动它们。',
        close: '关闭设置',
      },
    }

    /** English copy is the fallback for every language the active locale lacks a key in. */
    const FALLBACK: Record<string, string> = DICT.en ?? {}

    /**
     * Substitute `{name}` placeholders in one dictionary entry.
     * @param text - translated template.
     * @param params - replacement values.
     * @returns the finished sentence.
     */
    function format(text: string, params?: Record<string, unknown>): string {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/gu, (_match, key: string) => String(params[key] ?? ''))
    }

    /**
     * Format a byte count for the install card.
     * @param value - bytes, possibly unknown.
     * @returns a human-readable size.
     */
    function bytes(value: number | undefined): string {
      if (value === undefined || !Number.isFinite(value)) return '—'
      const mib = value / (1024 * 1024)
      if (mib >= 1) return `${mib.toFixed(1)} MiB`
      return `${Math.max(1, Math.round(value / 1024))} KiB`
    }

    /**
     * Render an epoch timestamp as a local date-time, or a dash when absent.
     * @param value - milliseconds since the epoch.
     * @returns display text.
     */
    function when(value: number | undefined): string {
      if (value === undefined || value === 0) return '—'
      return new Date(value).toLocaleString()
    }

    /**
     * Call one Host method over the plugin's route.
     * @param method - RPC method name.
     * @param params - method parameters.
     * @returns the method result.
     * @throws {Failure} the Host's refusal, with its hint.
     */
    async function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
      let response: Response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, ...(params === undefined ? {} : { params }) }),
        })
      } catch (error) {
        throw { code: 'network', message: `Cannot reach the GitHub plugin on this Host: ${String((error as Error)?.message ?? error)}` } satisfies Failure
      }
      let body: { ok?: boolean; result?: unknown; error?: Failure } | undefined
      try {
        body = (await response.json()) as typeof body
      } catch {
        body = undefined
      }
      if (body?.ok === true) return body.result
      throw body?.error ?? { code: 'internal', message: `HTTP ${String(response.status)}` }
    }

    /**
     * Write text to the browser clipboard.
     * @param value - text to copy.
     * @returns whether the clipboard accepted it.
     */
    async function copy(value: string): Promise<boolean> {
      try {
        await navigator?.clipboard?.writeText(value)
        return navigator?.clipboard !== undefined
      } catch {
        return false
      }
    }

    /** One inline notice: what just failed, and what the user can do. */
    function Notice(props: { failure?: Failure; text?: string; tone?: 'info' | 'success' | 'error' }) {
      const { failure, text, tone } = props
      if (failure === undefined && text === undefined) return null
      const kind = failure !== undefined ? 'error' : (tone ?? 'info')
      return h('div', { className: 'dshgh-notice', 'data-kind': kind },
        h('div', { className: 'dshgh-notice-main' }, failure !== undefined ? failure.message : text),
        failure?.hint === undefined ? null : h('div', { className: 'dshgh-hint' }, failure.hint))
    }

    /** One labelled value line. */
    function Field(props: { label: string; value: unknown; mono?: boolean; hint?: string }) {
      const value = props.value
      if (value === undefined || value === null || value === '') return null
      return h('div', { className: 'dshgh-row' },
        h('span', { className: 'dshgh-label' }, props.label),
        h('span', { className: props.mono === true ? 'dshgh-value dshgh-mono' : 'dshgh-value' }, String(value)),
        props.hint === undefined ? null : h('span', { className: 'dshgh-hint' }, props.hint))
    }

    /** One status pill. */
    function Badge(props: { tone: 'ok' | 'warn' | 'error' | 'idle'; text: string }) {
      return h('span', { className: 'dshgh-badge', 'data-tone': props.tone }, props.text)
    }

    /** One inline confirmation the page asks for instead of opening a modal. */
    type ConfirmTarget = { kind: 'logout'; host: string; user: string } | { kind: 'remove' }

    /** The settings page itself. */
    function GithubSection(props: any) {
      // React arrives untyped from the browser module table, so the hooks this page uses
      // are narrowed once here instead of at every call site.
      const useState = React.useState as <T>(initial: T) => [T, (value: T | ((previous: T) => T)) => void]
      const useRef = React.useRef as <T>(initial: T) => { current: T }
      const useEffect = React.useEffect as (effect: () => void | (() => void), dependencies?: readonly unknown[]) => void
      const useCallback = React.useCallback as <A extends readonly unknown[], R>(factory: (...args: A) => R, dependencies?: readonly unknown[]) => (...args: A) => R
      const t: (key: string) => string = typeof props?.t === 'function'
        ? props.t
        : (key: string): string => FALLBACK[key] ?? key
      /** Translate plus substitute, kept local so every call site stays short. */
      const tr = (key: string, params?: Record<string, unknown>): string => {
        const raw = t(key)
        return format(typeof raw === 'string' && raw !== '' ? raw : (FALLBACK[key] ?? key), params)
      }

      const [status, setStatus] = useState<StatusView | undefined>(undefined)
      const [auth, setAuth] = useState<AuthStatusView | undefined>(undefined)
      const [loading, setLoading] = useState(true)
      const [checking, setChecking] = useState(false)
      const [busy, setBusy] = useState<string | undefined>(undefined)
      const [failure, setFailure] = useState<Failure | undefined>(undefined)
      const [notice, setNotice] = useState<string | undefined>(undefined)
      const [job, setJob] = useState<JobView | undefined>(undefined)
      const [jobId, setJobId] = useState<string | undefined>(undefined)
      const [command, setCommand] = useState('')
      const [host, setHost] = useState('github.com')
      const [protocol, setProtocol] = useState('https')
      const [scopes, setScopes] = useState('')
      const [token, setToken] = useState('')
      const [copied, setCopied] = useState<string | undefined>(undefined)
      const [confirming, setConfirming] = useState<ConfirmTarget | undefined>(undefined)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      /**
       * Refresh the status and account cards.
       * @returns resolves once both reads have settled.
       */
      const reload = useCallback(async (): Promise<void> => {
        const [nextStatus, nextAuth] = await Promise.all([
          rpc('status').catch((): undefined => undefined),
          rpc('authStatus').catch((): undefined => undefined),
        ])
        if (!alive.current) return
        if (nextStatus !== undefined) setStatus(nextStatus as StatusView)
        if (nextAuth !== undefined) setAuth(nextAuth as AuthStatusView)
        setLoading(false)
      }, [])

      useEffect(() => {
        void reload()
      }, [reload])

      // Keep the path input aligned with the effective config until the user edits it.
      const commandTouched = useRef(false)
      useEffect(() => {
        if (commandTouched.current) return
        if (status !== undefined) setCommand(status.config.commandExplicit === true ? status.config.command : '')
      }, [status])

      /** Poll the running job once a second while one is active. */
      useEffect(() => {
        if (jobId === undefined) return
        let stopped = false
        const tick = async (): Promise<void> => {
          const answer = await rpc('jobPoll', { id: jobId }).catch((): undefined => undefined)
          if (stopped || !alive.current || answer === undefined) return
          if (answer.stale === true) {
            setJobId(undefined)
            setJob(undefined)
            setNotice(tr('jobUnknown'))
            void reload()
            return
          }
          const view = answer.job as JobView
          setJob(view)
          if (view.state !== 'running') {
            stopped = true
            setJobId(undefined)
            void reload()
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), 1000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [jobId, reload])

      /**
       * Run one action with its busy flag, failure surface, and status refresh.
       * @param key - action name disabling its own button.
       * @param run - the call to make.
       * @param done - optional success copy.
       * @returns resolves when the action has finished.
       */
      const act = async (key: string, run: () => Promise<unknown>, done?: string): Promise<void> => {
        setBusy(key)
        setFailure(undefined)
        setNotice(done === undefined ? undefined : done)
        try {
          await run()
        } catch (error) {
          if (alive.current) setFailure(error as Failure)
        } finally {
          if (alive.current) setBusy(undefined)
        }
      }

      /** Ask the Host for the newest release, bypassing its cache. */
      const checkUpdate = (): Promise<void> => act('check', async () => {
        setChecking(true)
        try {
          await rpc('releaseCheck')
        } finally {
          setChecking(false)
        }
        await reload()
      })

      /** Start the managed-copy download job. */
      const startInstall = (): Promise<void> => act('install', async () => {
        const result = await rpc('installStart')
        if (alive.current) setJobId(result.jobId as string)
      })

      /** Delete the managed copy, clearing the saved path when it pointed at it. */
      const removeManaged = (): Promise<void> => act('remove', async () => {
        await rpc('removeManaged')
        setConfirming(undefined)
        await reload()
      })

      /** Persist the typed gh path, which restarts the plugin. */
      const savePath = (): Promise<void> => act('save', async () => {
        await rpc('configUpdate', { command: command.trim() === '' ? null : command.trim() })
        setNotice(tr('saved'))
        commandTouched.current = false
        await reload()
      })

      /** Fall back to whatever gh is on PATH. */
      const clearPath = (): Promise<void> => act('clear', async () => {
        await rpc('configUpdate', { command: null })
        setCommand('')
        setNotice(tr('saved'))
        commandTouched.current = false
        await reload()
      })

      /** Start the device-code flow and let the job publish its code. */
      const startWebLogin = (): Promise<void> => act('login-web', async () => {
        const result = await rpc('authLoginWeb', { host, gitProtocol: protocol, ...(scopes.trim() === '' ? {} : { scopes: scopes.trim() }) })
        if (alive.current) setJobId(result.jobId as string)
      })

      /** Sign in with a pasted token, then wipe it from the page state. */
      const loginWithToken = (): Promise<void> => act('login-token', async () => {
        const result = await rpc('authLoginToken', { token, host, gitProtocol: protocol, ...(scopes.trim() === '' ? {} : { scopes: scopes.trim() }) })
        setToken('')
        setNotice(String(result.message ?? tr('signedIn')))
        await reload()
      })

      /** Make one account the active credentials of its host. */
      const switchAccount = (accountHost: string, user: string): Promise<void> => act(`switch-${user}`, async () => {
        setNotice(await rpc('authSwitch', { host: accountHost, user }).then((value: { message?: string }) => String(value.message ?? tr('switched'))))
        await reload()
      })

      /** Drop one account's credentials after the inline confirmation. */
      const logout = (accountHost: string, user: string | undefined): Promise<void> => act('logout', async () => {
        await rpc('authLogout', { host: accountHost, ...(user === undefined ? {} : { user }) })
        setConfirming(undefined)
        setNotice(tr('signedOut'))
        await reload()
      })

      /**
       * Copy one value to the clipboard, reporting a refusal instead of hiding it.
       * @param key - which value was copied, so its button can show the result.
       * @param value - text to copy.
       */
      const doCopy = async (key: string, value: string): Promise<void> => {
        if (!alive.current) return
        if (await copy(value)) {
          setCopied(key)
          setFailure(undefined)
        } else {
          setFailure({ code: 'internal', message: tr('copyFailed') })
        }
      }

      /**
       * Ask the Host for one account's token and copy it. The secret crosses only on an
       * explicit action and is never rendered on the page.
       * @param accountHost - GitHub host holding the account.
       * @param user - account whose active token is copied.
       */
      const copyTokenFor = (accountHost: string, user: string): Promise<void> => act(`copy-${user}`, async () => {
        const value = await rpc('authToken', { host: accountHost, user })
        await doCopy(`token-${user}`, String(value?.token ?? ''))
      })

      const installation = status
      const platform = status?.platform
      const managed = status?.managed
      const running = jobId !== undefined
      const jobTerminalText = job === undefined ? undefined : job.state === 'succeeded' ? tr('signedIn') : job.state === 'failed' ? tr('jobFailed') : job.state === 'cancelled' ? tr('jobCancelled') : tr('running')

      return h('div', { className: 'dshgh-root' },
        h('style', null, `
          .dshgh-root { display: flex; flex-direction: column; gap: 18px; color: var(--dsw-alias-label-primary); }
          .dshgh-head h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
          .dshgh-head p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; }
          .dshgh-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
          .dshgh-card-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; margin: 0; }
          .dshgh-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 13px; }
          .dshgh-label { color: var(--dsw-alias-label-secondary); min-width: 96px; }
          .dshgh-value { word-break: break-all; }
          .dshgh-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
          .dshgh-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
          .dshgh-badge { padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid currentColor; }
          .dshgh-badge[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
          .dshgh-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
          .dshgh-badge[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
          .dshgh-badge[data-tone="idle"] { color: var(--dsw-alias-state-idle-primary); }
          .dshgh-actions { display: flex; flex-wrap: wrap; gap: 8px; }
          .dshgh-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 7px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
          .dshgh-btn:disabled { opacity: .45; cursor: default; }
          .dshgh-btn[data-kind="primary"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
          .dshgh-btn[data-kind="danger"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
          .dshgh-input, .dshgh-select { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 5px 8px; font-size: 12px; min-width: 0; }
          .dshgh-input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
          .dshgh-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
          .dshgh-notice { border: 1px solid var(--dsw-alias-border-l1); border-left: 3px solid var(--dsw-alias-brand-primary); border-radius: 7px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 1.5; }
          .dshgh-notice[data-kind="error"] { border-left-color: var(--dsw-alias-state-error-primary); }
          .dshgh-notice[data-kind="success"] { border-left-color: var(--dsw-alias-state-success-primary); }
          .dshgh-log { margin: 0; padding: 8px 10px; border-radius: 7px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-secondary); max-height: 160px; overflow: auto; white-space: pre-wrap; }
          .dshgh-code { font-size: 22px; letter-spacing: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-brand-primary); }
          .dshgh-host { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; }
          .dshgh-account { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 6px 0; }
          .dshgh-link { color: var(--dsw-alias-brand-primary); font-size: 12px; }
          .dshgh-sep { color: var(--dsw-alias-state-idle-primary); }
        `),

        h('header', { className: 'dshgh-head' },
          h('h2', null, tr('title')),
          h('p', null, tr('intro'))),

        h(Notice, { failure, text: notice, tone: 'success' }),

        // ---------------------------------------------------------------- installation
        h('section', { className: 'dshgh-card' },
          h('h3', { className: 'dshgh-card-title' }, tr('installation'),
            loading ? null : h(Badge, { tone: installation?.installed === true ? 'ok' : 'warn', text: installation?.installed === true ? tr('installed') : tr('notInstalled') }),
            installation?.version === undefined ? null : h('span', { className: 'dshgh-sep' }, `gh ${installation.version}`),
            status?.upToDate === true ? h(Badge, { tone: 'idle', text: tr('upToDate') }) : null,
            status?.upToDate === false ? h(Badge, { tone: 'warn', text: tr('outdated') }) : null),

          h(Field, { label: tr('path'), value: installation?.path, mono: true, hint: installation?.installed === true ? (installation.source === 'config' ? tr('sourceConfig') : tr('sourcePath')) : undefined }),
          h(Field, { label: tr('latest'), value: status?.latest === undefined ? undefined : `${status.latest.version}${status.latest.assetBytes === undefined ? '' : ` · ${bytes(status.latest.assetBytes)}`}`, hint: status?.latest?.publishedAt }),
          status?.latest?.url === undefined ? null : h('a', { className: 'dshgh-link', href: status.latest.url, target: '_blank', rel: 'noreferrer' }, status.latest.name ?? status.latest.tag),
          loading || checking ? h('span', { className: 'dshgh-hint' }, tr('checking')) : null,
          status?.checkError === undefined ? null : h('div', { className: 'dshgh-notice', 'data-kind': 'error' },
            h('div', null, `${tr('checkFailed')}: ${status.checkError.message}`),
            status.checkError.hint === undefined ? null : h('div', { className: 'dshgh-hint' }, status.checkError.hint)),

          h('div', { className: 'dshgh-row' },
            h('span', { className: 'dshgh-label' }, tr('managedCopy')),
            h('span', { className: 'dshgh-value dshgh-mono' }, managed?.path ?? status?.managedPath ?? '—'),
            managed === undefined ? h('span', { className: 'dshgh-hint' }, tr('managedNone')) : h('span', { className: 'dshgh-hint' }, `${managed.version ?? tr('unknownVersion')} · ${when(managed.installedAt)}`)),
          managed?.shadowed === true ? h('div', { className: 'dshgh-hint' }, tr('shadowed', { path: installation?.path ?? '—' })) : null,
          managed !== undefined && managed.shadowed === false ? h('div', { className: 'dshgh-hint' }, tr('notShadowed')) : null,
          platform?.supported === false ? h('div', { className: 'dshgh-hint' }, tr('platformUnsupported', { hint: platform.hint ?? platform.goos })) : null,

          h('div', { className: 'dshgh-actions' },
            h('button', { className: 'dshgh-btn', onClick: () => void checkUpdate(), disabled: loading || checking || running }, tr('checkUpdate')),
            h('button', { className: 'dshgh-btn', 'data-kind': 'primary', onClick: () => void startInstall(), disabled: loading || running || platform?.supported !== true }, running ? tr('installing') : tr('installLatest')),
            managed === undefined ? null : (confirming?.kind === 'remove'
              ? h(React.Fragment, null,
                h('button', { className: 'dshgh-btn', 'data-kind': 'danger', disabled: busy !== undefined, onClick: () => void removeManaged() }, tr('confirmRemove')),
                h('button', { className: 'dshgh-btn', onClick: () => setConfirming(undefined) }, tr('cancel')))
              : h('button', { className: 'dshgh-btn', onClick: () => setConfirming({ kind: 'remove' }) }, tr('removeManaged')))),

          h('div', { className: 'dshgh-row' },
            h('label', { className: 'dshgh-label', htmlFor: 'dshgh-command' }, tr('ghPath')),
            h('input', { id: 'dshgh-command', className: 'dshgh-input', value: command, placeholder: status?.config?.command ?? 'gh', onChange: (event: any) => { commandTouched.current = true; setCommand(event.target.value) }, disabled: running })),
          h('div', { className: 'dshgh-hint' }, tr('ghPathHint')),
          h('div', { className: 'dshgh-actions' },
            h('button', { className: 'dshgh-btn', onClick: () => void savePath(), disabled: running || busy !== undefined }, tr('save')),
            status?.config?.commandExplicit === true ? h('button', { className: 'dshgh-btn', onClick: () => void clearPath(), disabled: running || busy !== undefined }, tr('clear')) : null),

          h('div', { className: 'dshgh-hint' }, tr('systemPackageManager')),
          h('div', { className: 'dshgh-row' },
            h('span', { className: 'dshgh-label' }, tr('extensions')),
            h('span', { className: 'dshgh-value' }, status === undefined || status.extensions.length === 0 ? tr('extensionsNone') : status.extensions.slice(0, 6).join(', ') + (status.extensions.length > 6 ? ` ${tr('moreExtensions', { count: String(status.extensions.length - 6) })}` : ''))),

          job === undefined ? null : h('div', { className: 'dshgh-card' },
            h('h4', { className: 'dshgh-card-title' }, `${job.label} · ${jobTerminalText ?? ''}`),
            job.code === undefined && job.url === undefined ? null : h('div', { className: 'dshgh-row' },
              h('span', { className: 'dshgh-label' }, tr('deviceCode')),
              h('span', { className: 'dshgh-code' }, job.code ?? ''),
              h('button', { className: 'dshgh-btn', onClick: () => void doCopy('code', job.code ?? '') }, copied === 'code' ? tr('copied') : tr('copyCode')),
              job.url === undefined ? null : h('a', { className: 'dshgh-link', href: job.url, target: '_blank', rel: 'noreferrer' }, job.url)),
            job.url === undefined ? null : h('div', { className: 'dshgh-hint' }, tr('deviceHelp', { url: job.url })),
            job.state === 'running' && job.url !== undefined ? h('div', { className: 'dshgh-hint' }, tr('deviceWaiting')) : null,
            h('pre', { className: 'dshgh-log' }, job.log.join('\n')),
            job.state === 'running' ? h('div', { className: 'dshgh-actions' }, h('button', { className: 'dshgh-btn', onClick: () => void rpc('jobCancel', { id: job.id }).catch((): undefined => undefined) }, tr('cancel'))) : null,
            job.error === undefined ? null : h(Notice, { failure: job.error }))),

        // ---------------------------------------------------------------- accounts
        h('section', { className: 'dshgh-card' },
          h('h3', { className: 'dshgh-card-title' }, tr('accounts'),
            auth === undefined ? null : h(Badge, { tone: auth.loggedIn ? 'ok' : 'warn', text: auth.loggedIn ? tr('loggedIn') : tr('notSignedIn') })),
          auth?.note === undefined ? null : h('div', { className: 'dshgh-hint' }, `${auth.note}${auth.raw === undefined ? '' : `: ${auth.raw.slice(0, 200)}`}`),
          auth !== undefined && auth.hosts.length === 0 ? h('div', { className: 'dshgh-hint' }, tr('accountNone')) : null,
          ...(auth?.hosts ?? []).map(entry => h('div', { className: 'dshgh-host', key: entry.host },
            h('div', { className: 'dshgh-row' }, h('span', { className: 'dshgh-value dshgh-mono' }, entry.host)),
            ...entry.accounts.map(account => h('div', { className: 'dshgh-account', key: `${entry.host}/${account.login}` },
              h('span', { className: 'dshgh-value' }, account.login),
              account.active ? h(Badge, { tone: 'ok', text: tr('active') }) : null,
              h('span', { className: 'dshgh-hint' }, `${tr('scopes')}: ${account.scopes || '—'} · ${tr('tokenSource')}: ${account.tokenSource}${account.gitProtocol === '' ? '' : ` · ${tr('gitProtocol')}: ${account.gitProtocol}`}`),
              entry.accounts.length > 1 && !account.active
                ? h('button', { className: 'dshgh-btn', disabled: busy !== undefined, onClick: () => void switchAccount(entry.host, account.login) }, tr('setDefault'))
                : null,
              h('button', {
                className: 'dshgh-btn',
                disabled: busy !== undefined,
                onClick: () => void copyTokenFor(entry.host, account.login),
              }, copied === `token-${account.login}` ? tr('copied') : tr('copyToken')),
              confirming?.kind === 'logout' && confirming.host === entry.host && confirming.user === account.login
                ? h(React.Fragment, null,
                  h('button', { className: 'dshgh-btn', 'data-kind': 'danger', disabled: busy !== undefined, onClick: () => void logout(entry.host, account.active ? undefined : account.login) }, tr('confirmLogout')),
                  h('button', { className: 'dshgh-btn', onClick: () => setConfirming(undefined) }, tr('cancel')))
                : h('button', {
                  className: 'dshgh-btn',
                  disabled: busy !== undefined,
                  onClick: () => setConfirming({ kind: 'logout', host: entry.host, user: account.login }),
                }, tr('logout')))))),

          h('div', { className: 'dshgh-grid' },
            h('label', { className: 'dshgh-row' }, h('span', { className: 'dshgh-label' }, tr('signInHost')), h('input', { className: 'dshgh-input', value: host, onChange: (event: any) => setHost(event.target.value) })),
            h('label', { className: 'dshgh-row' }, h('span', { className: 'dshgh-label' }, tr('signInProtocol')),
              h('select', { className: 'dshgh-select', value: protocol, onChange: (event: any) => setProtocol(event.target.value) },
                h('option', { value: 'https' }, 'https'), h('option', { value: 'ssh' }, 'ssh'))),
            h('label', { className: 'dshgh-row' }, h('span', { className: 'dshgh-label' }, tr('signInScopes')), h('input', { className: 'dshgh-input', value: scopes, onChange: (event: any) => setScopes(event.target.value), placeholder: 'repo,gist' }))),
          h('div', { className: 'dshgh-hint' }, tr('signInScopesHint')),
          h('div', { className: 'dshgh-row' },
            h('label', { className: 'dshgh-label', htmlFor: 'dshgh-token' }, tr('signInToken')),
            h('input', { id: 'dshgh-token', className: 'dshgh-input', type: 'password', value: token, placeholder: tr('tokenPlaceholder'), onChange: (event: any) => setToken(event.target.value), disabled: busy !== undefined })),
          h('div', { className: 'dshgh-actions' },
            h('button', { className: 'dshgh-btn', 'data-kind': 'primary', disabled: running || busy !== undefined, onClick: () => void startWebLogin() }, tr('signInWeb')),
            h('button', { className: 'dshgh-btn', disabled: token.trim() === '' || busy !== undefined, onClick: () => void loginWithToken() }, tr('signInToken'))),
          h('div', { className: 'dshgh-hint' }, tr('tokenHint'))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx: any) {
        for (const language of Object.keys(DICT)) {
          ctx.effect(() => ctx.locale.register(NS, language, DICT[language]), `github: ${language} dictionaries`)
        }
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'github',
          order: 25,
          label: () => ctx.locale.bind(NS)('nav'),
          locale: NS,
        }, GithubSection)), 'github: settings section')
      },
    }
  },
})
