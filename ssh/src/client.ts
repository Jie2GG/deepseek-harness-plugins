/**
 * SSH target manager — browser half, mounted as a Settings section.
 *
 * The web module table executes this file as a classic script, so everything
 * below the `window.__ModuleLoader__.load` call is the registered factory: the
 * only runtime import is `react`, taken from the page's baseline module table,
 * and the single top-level `import type` is erased by the compiler. Controls
 * and their stylesheet are local to this plugin, styled exclusively from
 * `--dsw-alias-*` and other host theme tokens, because a plugin must not require
 * another Harness client package as a module. The card, row, field and stroke
 * values mirror the settings shell's own (`settings-card-fill`,
 * `settings-card-stroke`, the `settings-form` field rhythm) so a plugin page
 * reads as part of the window it is rendered into.
 *
 * The page is one scroll, not two tabs, and the scroll is ordered by what a
 * reader came here to do: SSH targets first, the three client parameters second,
 * and the resolved limits behind a collapsed `<details>` that is expanded only
 * by someone who wants them. One container owns the state and every call; the
 * regions are presentational components that receive what they render, so no
 * single component holds both the whole state and the whole page.
 *
 * The new-connection form is one address field, a segmented authentication
 * choice, the secret fields that choice needs, and a collapsed advanced section.
 * A typed secret travels to the Host once — either stored in the credential
 * store on save or used transiently by a draft probe — and no secret value ever
 * comes back to the browser.
 *
 * @module @jie2gg/dsh-plugin-ssh/client
 */

import type { AuthMode, ConnectionInput, ConnectionRecord, ConnectionView, ProbeOutcome, SshFailure } from './types.ts'

window.__ModuleLoader__.load({
  id: '@jie2gg/dsh-plugin-ssh',
  factory(require: (specifier: string) => any) {
    const React = require('react')
    const h = React.createElement

    /** Namespace this page's copy is registered under. */
    const NS = 'settings.ssh'
    /** The plugin's own route on the shared `/api` channel. */
    const ROUTE = '/api/ssh/rpc'
    /** Base of the authentication-mode radio ids. */
    const AUTH_BASE = 'dshssh-auth'
    /** The three authentication modes, in display order. */
    const AUTH_OPTIONS: readonly { value: AuthMode; labelKey: string; hintKey: string }[] = [
      { value: 'key', labelKey: 'authKey', hintKey: 'authKeyHint' },
      { value: 'password', labelKey: 'authPassword', hintKey: 'authPasswordHint' },
    ]
    /**
     * Dictionary key naming each mode for a list row. `key+password` was an
     * offered choice in 0.4.0 only; a stored row that carries it still shows a
     * label and still probes the way it always did.
     */
    const AUTH_LABEL: Record<string, string> = { key: 'authKey', 'key+password': 'authBoth', password: 'authPassword' }

    /**
     * Browser-facing copy. Both baseline locales are required by the locale
     * service, and a test compares every key the page asks for against these two
     * blocks, so a label added on one side only fails the suite rather than
     * painting its own name into a card.
     */
    const DICT: Record<string, Record<string, string>> = {
      en: {
        nav: 'Remote connections',
        title: 'Remote connections',
        intro: 'Manage SSH targets and the parameters remote calls run under.',
        storedIn: 'The target list and this profile’s overrides live in the plugin’s own ssh_targets storage domain; passwords and passphrases live in the Harness credential store.',
        storageConfigNote: 'The plugin never reads or writes ~/.ssh/config and never records a host key for you. A ceiling you leave empty follows the plugin’s configuration on this Host.',
        runtimeTitle: 'Runtime status and details',
        runtimeHint: 'Expand for the lanes that are busy, the limits this Host resolved, and what the plugin has left on disk. Nothing here is editable: it is what the plugin fixes in code and configuration.',
        runtimeStorageTitle: 'Storage and credentials',
        runtimeUsageFormat: 'Numbers read “current use / limit”: the first is what occupies the lane now, the second is the most it may ever hold.',
        runtimeBusy: '{count} running',
        listTitle: 'SSH targets',
        listTotal: '{count} saved',
        listCount: '{count} of {limit} saved',
        listAdd: 'New connection',
        listAddFull: 'Target limit reached',
        listProbeAll: 'Test all',
        listProbing: 'Testing…',
        listSkipped: 'Tested the first {probed}; {skipped} still untested.',
        listEmpty: 'No SSH targets yet',
        listEmptyHint: 'Add a host name or an existing OpenSSH host alias, then test it here.',
        listLoadFailed: 'The settings page could not reach the plugin on this Host.',
        defaultChip: 'default',
        defaultHint: 'With one saved target, a call that names no server uses it. With several, it uses the server that conversation chose last.',
        rowDetails: 'Details',
        rowDetailsHide: 'Hide',
        refresh: 'Refresh',
        settingsTitle: 'Client parameters',
        settingsMaxOutput: 'Output ceiling (bytes)',
        settingsRemoteTimeout: 'Command timeout (milliseconds)',
        settingsMaxTransfer: 'Transfer ceiling (bytes)',
        settingsSave: 'Save parameters',
        settingsSaved: 'Saved.',
        settingsOverrideHint: 'Empty means “follow the configured default”. Any positive whole number is accepted: one above the cap is capped, and the value that applied is shown back.',
        paramFollowDefault: 'follows the default',
        paramOverride: 'override',
        paramCapped: 'above the cap, so {value} is in force',
        paramBadNumber: 'Enter a positive whole number of {unit}s.',
        paramDirty: 'Unsaved changes.',
        paramReset: 'clear override',
        unitMs: 'millisecond',
        unitBytes: 'byte',
        boundsEffectiveOf: 'in force {value}',
        boundsDefaultOf: 'default {value}',
        boundsCapOf: 'cap {value}',
        boundsResolvedTitle: 'Runtime limits',
        boundsFromConfig: 'These numbers come from the plugin’s configuration on this Host — a default and a cap per ceiling. Editing the profile’s ssh row changes them, with no code release involved.',
        boundsTitle: 'Fixed bounds',
        boundsTargets: 'Targets per profile',
        boundsOps: 'Remote operations running',
        boundsCopies: 'File transfers running',
        boundsJobs: 'Background jobs',
        boundsSpill: 'Output temp files',
        spillBytes: 'Temp space on disk',
        spillFiles: '{files} file(s)',
        spillRefused: ', {refusals} answer(s) kept to the tail',
        tempCollected: 'Startup collected {removed} abandoned temp dir{plural} of {scanned} in its own namespace; {kept} left standing.',
        boundsRunning: '{running} of {ceiling}',
        boundsJobsReserved: '{reserved} of {total} operation slots held back for calls that wait',
        boundsMasters: 'Targets per shared connection',
        boundsPersist: 'A shared connection idles out after',
        boundsPerRound: 'Targets per “Test all” round',
        boundsTimeout: 'Connection-test deadline',
        boundsOutput: 'Output ceiling accepts',
        boundsRemoteTimeout: 'Command timeout accepts',
        boundsTransfer: 'Transfer ceiling accepts',
        poolOff: 'This Host could not prepare a private directory for control sockets, so every call dials its own connection: {reason}',
        chipAgentOff: 'agent access off',
        chipAllowlist: '{count} no-approval program(s)',
        newTitle: 'New connection',
        editTitle: 'Edit connection',
        addrLabel: 'Connection address',
        addrPlaceholder: 'jiegg@build.example:22022',
        addrHint: 'One field: [user@]host[:port], or an ssh:// URL. A bare name is read as an OpenSSH host alias.',
        addrBad: 'That address could not be read. Expected [user@]host[:port].',
        labelField: 'Display name',
        labelHint: 'Left empty, the address is used.',
        authTitle: 'Authentication',
        authKey: 'Key',
        authBoth: 'Key + password (0.4.0)',
        authPassword: 'Password',
        authKeyHint: 'Uses ssh-agent or a private key with no passphrase. The passphrase field below covers an encrypted key.',
        authPasswordHint: 'Password only: publickey offers are skipped.',
        keyFileLabel: 'Private key file',
        passphraseLabel: 'Key passphrase',
        passwordLabel: 'Login password',
        rootLabel: 'Root password (for su)',
        advanced: 'Advanced options',
        advancedHint: 'Jump host, extra ssh arguments, and a note.',
        fProxy: 'Jump host',
        fArgs: 'Extra ssh arguments',
        fArgsHint: 'One ssh argv entry per line: -4 on its own, an option with its value glued into one token (-oServerAliveCountMax=3), or the option and its value on two lines.',
        fNote: 'Note',
        fPool: 'Share this server’s connection',
        fPoolHint: 'Later calls to this server ride on the connection the first one opened, so a conversation stops paying for a fresh handshake and login on every command. Turn it off for a server that behaves differently once several commands share one connection.',
        fAgent: 'Let the agent use this target',
        fAgentHint: 'Turned off, every agent call against this target is refused — reads and writes alike, and the call says so in its result. The settings page and your own terminal keep working. This is an emergency stop, not a sandbox: leaving it on means the approval rules decide, not this switch.',
        fAllowlist: 'Programs that run without asking',
        fAllowlistHint: 'A no-approval list, not a sandbox and not a limit: a command only runs unasked when its one bare leading program is named here, and every other command — and every pipeline, redirect, or substitution — still asks you first. Listing `git` never restricts which arguments `git` gets.',
        fOptional: 'optional',
        fRequired: 'Required.',
        secretStored: 'Stored — leave empty to keep it',
        secretClear: 'Forget the stored value',
        showSecret: 'Show',
        hideSecret: 'Hide',
        secretSet: 'password stored',
        passphraseSet: 'passphrase stored',
        rootSet: 'root password stored',
        test: 'Test',
        testDraft: 'Test before saving',
        edit: 'Edit',
        remove: 'Delete',
        confirmRemove: 'Confirm delete',
        cancel: 'Cancel',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved.',
        removed: 'Deleted, and its stored secret was forgotten.',
        removedOrphan: 'Deleted, but its stored secret could not be removed.',
        copyDetail: 'Copy diagnostics',
        resolve: 'Resolve',
        resolveTitle: 'What the OpenSSH client resolves this target to',
        resolveHint: 'Resolved locally with `ssh -G`; a probe also adds its own BatchMode, timeout, and host-key options.',
        resolveDiffers: 'Differs from the saved address',
        resolveSame: 'Matches the saved address',
        resolveHostname: 'Dials',
        resolveUser: 'User',
        resolvePort: 'Port',
        resolveIdentity: 'Identity files',
        resolveJump: 'Jump host',
        resolveProxy: 'ProxyCommand',
        resolveRaw: 'Full resolved configuration',
        resolveFailed: 'The ssh client could not resolve this target.',
        copied: 'Copied.',
        copyFailed: 'The browser refused the clipboard.',
        askpassUnavailable: 'This Host cannot prepare the ssh askpass helper, so a stored password or passphrase cannot be used. Key-agent probes still work.',
        legacyHost: 'The running Host predates password support: it still needs to be restarted for the authentication choice and the secret fields to appear. Until then a target connects with ssh-agent or an unencrypted key.',
        stIdle: 'Not tested',
        stRunning: 'Testing…',
        stReachable: 'Reachable',
        stAuthFailed: 'Authentication failed',
        stUnreachable: 'Unreachable',
        stUnknownHost: 'Host key not trusted',
        stTimeout: 'Timed out',
        stSshMissing: 'ssh not found',
        stFailed: 'Failed',
        asOf: 'as of {at}',
        took: '{ms} ms',
        hintUnknownHost: 'OpenSSH refused this host key. A first contact is recorded automatically, so this usually means the key changed: confirm the fingerprint with whoever runs the server, then update the known_hosts file of the Host account.',
        hintSshMissing: 'No ssh program was found: the plugin tried ssh on PATH, then the usual install locations. Install OpenSSH, or put it where one of those searches can find it.',
        hintAuthFailed: 'The connection reached the server but no credential was accepted. For a password or an encrypted key, fill the secret field; for an agent key, check that the agent is running.',
        hintUnreachable: 'The host did not accept the session: check the address, the port, and any jump host.',
        hintTimeout: 'The probe used up its fixed thirty seconds. A host that answers slowly is not the same as a host that is down: test it again, or let the agent run a real command, whose timeout you can set yourself.',
        hintBadInput: 'Check the highlighted field.',
        hintBusy: 'Too many probes are running. Wait for the current ones to finish.',
        hintStorage: 'The plugin could not read its stored connections. See the Host log for the storage failure.',
        hintSecret: 'The plugin could not reach the credential store for this secret.',
        hintInternal: 'The plugin reported an unexpected failure.',
      },
      zh: {
        nav: '远程连接',
        title: '远程连接',
        intro: '管理 SSH 目标，以及远程调用所依据的参数。',
        storedIn: '目标清单与本 profile 的覆盖值存在插件自己的 ssh_targets 存储域；密码与口令存在 Harness 凭据库里。',
        storageConfigNote: '插件从不读写 ~/.ssh/config，也不会替你写入主机密钥。此处留空的上限，跟随这台 Host 上插件的配置。',
        runtimeTitle: '运行状态与高级信息',
        runtimeHint: '展开可查看正在占用的通道、这台 Host 解析出的限制，以及插件留在磁盘上的临时文件。这里没有可编辑项：它们由插件的代码与配置决定。',
        runtimeStorageTitle: '存储与凭据',
        runtimeUsageFormat: '数值写成「当前用量 / 上限」：前者是现在占用多少，后者是这条通道最多能占多少。',
        runtimeBusy: '{count} 项在跑',
        listTitle: 'SSH 目标',
        listTotal: '共 {count} 台',
        listCount: '已保存 {count} / {limit}',
        listAdd: '新建连接',
        listAddFull: '已达清单上限',
        listProbeAll: '全部测试',
        listProbing: '测试中…',
        listSkipped: '本轮测试了前 {probed} 条，{skipped} 条未测。',
        listEmpty: '还没有 SSH 目标',
        listEmptyHint: '先添加一个主机名或已有的 OpenSSH 别名，再在这里测试。',
        listLoadFailed: '设置页无法连到本机上的这个插件。',
        defaultChip: '默认',
        defaultHint: '只保存一台服务器时，未点名服务器的调用都落在它上面；有多台时，未点名的调用沿用该对话上一次使用的服务器。',
        rowDetails: '详情',
        rowDetailsHide: '收起',
        refresh: '刷新',
        settingsTitle: '客户端参数',
        settingsMaxOutput: '输出上限（字节）',
        settingsRemoteTimeout: '命令超时（毫秒）',
        settingsMaxTransfer: '传输上限（字节）',
        settingsSave: '保存参数',
        settingsSaved: '已保存。',
        settingsOverrideHint: '留空表示「跟随配置里的默认」。任何正整数都收：超过上限会被夹到上限，并回显真正生效的数。',
        paramFollowDefault: '跟随默认',
        paramOverride: '覆盖值',
        paramCapped: '超过上限，实际生效 {value}',
        paramBadNumber: '请输入正整数（单位：{unit}）。',
        paramDirty: '有未保存的修改。',
        paramReset: '清除覆盖',
        unitMs: '毫秒',
        unitBytes: '字节',
        boundsEffectiveOf: '生效 {value}',
        boundsDefaultOf: '默认 {value}',
        boundsCapOf: '上限 {value}',
        boundsResolvedTitle: '运行限制',
        boundsFromConfig: '这些数字来自这台 Host 上插件的配置——每个上限都有一个默认值和一个封顶值。改 profile 里 ssh 那一行就能调，不用改代码发版。',
        boundsTitle: '固定边界',
        boundsTargets: '每个 profile 可存的目标数',
        boundsOps: '正在执行的远程操作',
        boundsCopies: '正在进行的文件传输',
        boundsJobs: '后台任务',
        boundsSpill: '输出临时文件',
        spillBytes: '临时文件占用空间',
        spillFiles: '{files} 个文件',
        spillRefused: '，{refusals} 次回答只留尾部',
        tempCollected: '启动时在本插件命名空间内回收了 {scanned} 个残留中的 {removed} 个临时目录，保留 {kept} 个。',
        boundsRunning: '{running} / {ceiling}',
        boundsJobsReserved: '{total} 个操作槽位中为等待结果的调用保留 {reserved} 个',
        boundsMasters: '单连接目标上限',
        boundsPersist: '共享连接空闲多久后断开',
        boundsPerRound: '「全部测试」单轮覆盖的目标数',
        boundsTimeout: '连接测试的等待上限',
        boundsOutput: '输出上限可填范围',
        boundsRemoteTimeout: '命令超时可填范围',
        boundsTransfer: '传输上限可填范围',
        poolOff: '这台 Host 没能准备好放控制套接字的私有目录，所以每次调用都自己拨号：{reason}',
        chipAgentOff: 'agent 访问已关',
        chipAllowlist: '{count} 个免审批程序',
        newTitle: '新建连接',
        editTitle: '编辑连接',
        addrLabel: '连接地址',
        addrPlaceholder: 'jiegg@build.example:22022',
        addrHint: '一个框就够：[user@]host[:port]，也接受 ssh:// 开头的写法。只写名字时按 OpenSSH 别名理解。',
        addrBad: '读不出这个地址，期望写法是 [user@]host[:port]。',
        labelField: '显示名称',
        labelHint: '留空就用地址当名称。',
        authTitle: '登录方式',
        authKey: '密钥',
        authBoth: '密钥 + 密码（旧版）',
        authPassword: '密码',
        authKeyHint: '使用 ssh-agent 或无口令私钥；私钥带口令时填下面的口令框。',
        authPasswordHint: '只用密码：不再提供 publickey。',
        keyFileLabel: '私钥文件',
        passphraseLabel: '私钥口令',
        passwordLabel: '登录密码',
        rootLabel: 'root 密码（su 提权用）',
        advanced: '高级选项',
        advancedHint: '跳板主机、额外 ssh 参数、备注。',
        fProxy: '跳板主机',
        fArgs: '额外 ssh 参数',
        fArgsHint: '每行一个 ssh 参数：单独一个 -4；把选项和值写成一个参数（-oServerAliveCountMax=3）；或者选项一行、取值一行。',
        fNote: '备注',
        fPool: '复用这台服务器的连接',
        fPoolHint: '之后连这台服务器的调用会搭第一条命令开好的连接，对话里就不用每条命令重新握手、重新登录。有些服务器在多条命令共用一条连接时行为不一样，那种服务器把这里关掉。',
        fAgent: '允许 agent 使用这台目标',
        fAgentHint: '关掉后，agent 对这台目标的每次调用都会被拒绝——读写都算，调用结果里会写明原因。设置页和你自己的终端照常工作。这是急停开关，不是沙箱：开着它就意味着由审批规则来决定每条命令。',
        fAllowlist: '不经审批直接运行的程序',
        fAllowlistHint: '这是免审批名单，不是沙箱，也不是限制器：只有命令的第一个裸程序名在这里时才会不打扰你；其它命令、以及一切管道、重定向、替换都照样先问你。列出 `git` 并不限制 `git` 能拿到什么参数。',
        fOptional: '可选',
        fRequired: '此项必填。',
        secretStored: '已保存 · 留空表示不改',
        secretClear: '忘掉已保存的值',
        showSecret: '显示',
        hideSecret: '隐藏',
        secretSet: '已存密码',
        passphraseSet: '已存口令',
        rootSet: '已存 root 密码',
        test: '测试',
        testDraft: '保存前先测试',
        edit: '编辑',
        remove: '删除',
        confirmRemove: '确认删除',
        cancel: '取消',
        save: '保存',
        saving: '保存中…',
        saved: '已保存。',
        removed: '已删除，同时忘掉了它存的凭据。',
        removedOrphan: '已删除，但没能清掉它存的凭据。',
        copyDetail: '复制诊断',
        resolve: '解析',
        resolveTitle: 'OpenSSH 客户端把这个目标解析成什么',
        resolveHint: '用 `ssh -G` 在本机解析，不联网；真正探测时插件还会加上自己的 BatchMode、超时与主机密钥选项。',
        resolveDiffers: '与保存的地址不一致',
        resolveSame: '与保存的地址一致',
        resolveHostname: '实际连接',
        resolveUser: '用户',
        resolvePort: '端口',
        resolveIdentity: '身份文件',
        resolveJump: '跳板主机',
        resolveProxy: 'ProxyCommand',
        resolveRaw: '完整解析结果',
        resolveFailed: '本机 ssh 没能解析这个目标。',
        copied: '已复制。',
        copyFailed: '浏览器拒绝了剪贴板写入。',
        askpassUnavailable: '这台 Host 上准备不出 ssh 的 askpass 助手，已保存的密码或口令暂时用不了；ssh-agent 方式的探测不受影响。',
        legacyHost: '当前正在运行的 Host 还是重启前的旧版本，重启之后才会出现登录方式与凭据输入框。在此之前，目标只能用 ssh-agent 或无口令私钥连接。',
        stIdle: '未测试',
        stRunning: '测试中…',
        stReachable: '可连通',
        stAuthFailed: '认证失败',
        stUnreachable: '无法连接',
        stUnknownHost: '主机密钥未信任',
        stTimeout: '探测超时',
        stSshMissing: '找不到 ssh',
        stFailed: '失败',
        asOf: '截至 {at}',
        took: '{ms} 毫秒',
        hintUnknownHost: 'OpenSSH 拒绝了这台主机的密钥。首次联系会被自动记录，所以这通常表示主机密钥已变：请与服务器管理方确认 fingerprint，再更新探测所用账号的 known_hosts。',
        hintSshMissing: '没找到 ssh 程序：插件试过 PATH 上的 ssh 和常见安装位置。请安装 OpenSSH，或把它放到搜索得到的位置。',
        hintAuthFailed: '已经连上服务端，但没有凭据被接受。密码或带口令的私钥请填写对应的凭据输入框；用 agent 的密钥请确认 agent 在运行。',
        hintUnreachable: '主机没有接受这次会话：请检查地址、端口以及跳板主机。',
        hintTimeout: '探测用完了固定的三十秒。响应慢不等于连不上：可以再测一次，或者让 agent 直接跑一条真命令——命令的超时是你能自己设的。',
        hintBadInput: '请检查高亮的字段。',
        hintBusy: '同时在跑的探测太多，请等待当前探测结束。',
        hintStorage: '插件读不到自己保存的连接记录，具体存储错误见 Host 日志。',
        hintSecret: '插件没能访问这台主机对应的凭据库。',
        hintInternal: '插件报告了未预期的失败。',
      },
    }

    /** English copy is the fallback the component uses before the dictionary lands. */
    const FALLBACK = DICT['en'] ?? {}

    /** Status → badge tone, so a probe result reads the same in both languages. */
    const STATUS_TONE: Record<string, string> = {
      reachable: 'ok',
      'auth-failed': 'warn',
      'unknown-host': 'warn',
      timeout: 'warn',
      unreachable: 'err',
      'ssh-missing': 'err',
      failed: 'err',
    }

    /** Status → the dictionary key naming it. */
    const STATUS_KEY: Record<string, string> = {
      reachable: 'stReachable',
      'auth-failed': 'stAuthFailed',
      'unknown-host': 'stUnknownHost',
      timeout: 'stTimeout',
      unreachable: 'stUnreachable',
      'ssh-missing': 'stSshMissing',
      failed: 'stFailed',
    }

    /** Status → the dictionary key explaining how to fix it. */
    const STATUS_HINT_KEY: Record<string, string> = {
      'auth-failed': 'hintAuthFailed',
      'unknown-host': 'hintUnknownHost',
      timeout: 'hintTimeout',
      unreachable: 'hintUnreachable',
      'ssh-missing': 'hintSshMissing',
      failed: 'hintInternal',
    }

    /** Failure code → the dictionary key explaining what to do. */
    const FAILURE_HINT_KEY: Record<string, string> = {
      'bad-input': 'hintBadInput',
      busy: 'hintBusy',
      'storage-error': 'hintStorage',
      'secret-error': 'hintSecret',
      'not-found': 'hintInternal',
      internal: 'hintInternal',
    }

    /**
     * The page's own stylesheet. Every value is a host theme token, so light and
     * dark both read as the settings window the page is injected into: the cards
     * take the shell's own fill and stroke, rows are divided by hairlines rather
     * than boxed one at a time, and nothing declares a width the shell cannot
     * give it — the columns are `minmax(0, …)` and every control is
     * `box-sizing: border-box`, so a narrow window wraps instead of scrolling
     * sideways.
     */
    const CSS = `
.dshssh-root{display:flex;flex-direction:column;gap:12px;min-width:0;max-width:660px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}
.dshssh-title{margin:0;font-size:18px;font-weight:600;line-height:1.4}
.dshssh-intro{margin:0;color:var(--dsw-alias-label-tertiary)}
.dshssh-card{display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px 16px;box-sizing:border-box;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.dshssh-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dshssh-card-title{font-size:13px;font-weight:600}
.dshssh-card-headline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.dshssh-tertiary{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshssh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:10px 14px;min-width:0}
.dshssh-fields{display:flex;flex-direction:column;min-width:0}
.dshssh-field{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 0}
.dshssh-fields>.dshssh-field:first-child{padding-top:0}
.dshssh-fields>.dshssh-field+.dshssh-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dshssh-label{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshssh-input,.dshssh-textarea{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 12px;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md)}
.dshssh-textarea{height:auto;min-height:64px;padding:8px 12px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshssh-input:focus-visible,.dshssh-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dshssh-input:disabled,.dshssh-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dshssh-input[aria-invalid="true"],.dshssh-textarea[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}
.dshssh-input-inline{display:flex;align-items:stretch;gap:6px;min-width:0}
.dshssh-input-inline .dshssh-input{flex:1 1 auto;min-width:0}
.dshssh-eye{flex:0 0 auto;height:34px;padding:0 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);cursor:pointer}
.dshssh-eye:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dshssh-eye:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshssh-check{display:flex;align-items:flex-start;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshssh-check input{flex:0 0 auto;margin-top:3px}
.dshssh-list{display:flex;flex-direction:column;min-width:0}
.dshssh-row{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshssh-row:first-child{padding-top:2px;border-top:0}
.dshssh-row-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;min-width:0}
.dshssh-row-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 220px}
.dshssh-row-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dshssh-row-title{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.dshssh-row-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dshssh-row-body{display:flex;flex-direction:column;gap:8px;padding-top:2px}
.dshssh-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dshssh-chip{display:inline-flex;align-items:center;padding:1px 7px;font-size:11.5px;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3)}
.dshssh-chip[data-tone="default"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dshssh-chip[data-tone="secret"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dshssh-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;flex-wrap:wrap}
.dshssh-btn{height:28px;padding:0 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);cursor:pointer}
.dshssh-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dshssh-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshssh-btn:disabled{opacity:.5;cursor:default}
.dshssh-btn-primary{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-color:transparent}
.dshssh-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dshssh-btn-link{height:auto;padding:0;border:0;background:none;font:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshssh-btn-link:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshssh-btn-link:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshssh-btn-link:disabled{cursor:default;opacity:.5}
.dshssh-badge{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;font-size:12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-state-idle-primary)}
.dshssh-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.dshssh-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.dshssh-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dshssh-badge[data-tone="err"]{color:var(--dsw-alias-state-error-primary)}
.dshssh-notice{display:flex;flex-direction:column;gap:6px;padding:8px 12px;font-size:12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.dshssh-notice[data-tone="err"]{border-color:var(--dsw-alias-state-error-primary)}
.dshssh-notice[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary)}
.dshssh-notice[data-tone="ok"]{border-color:var(--dsw-alias-state-success-primary)}
.dshssh-detail{margin:0;padding:8px;max-width:100%;max-height:180px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dshssh-form{display:flex;flex-direction:column;gap:12px;min-width:0;padding:12px 14px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg)}
.dshssh-foot{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.dshssh-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dshssh-disclose{border:.5px dashed var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);padding:10px 12px;display:flex;flex-direction:column;gap:10px;min-width:0}
.dshssh-disclose>summary{font-size:12px;font-weight:600;cursor:pointer;list-style:none;color:var(--dsw-alias-label-secondary)}
.dshssh-disclose>summary::-webkit-details-marker{display:none}
.dshssh-disclose>summary::before{content:"▸ ";color:var(--dsw-alias-label-tertiary)}
.dshssh-disclose[open]>summary::before{content:"▾ "}
.dshssh-disclose[open]>summary{color:var(--dsw-alias-label-primary)}
.dshssh-seg{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);justify-self:start;max-width:100%}
.dshssh-seg-indicator{position:absolute;top:4px;left:4px;width:calc((100% - 8px - 2px * (var(--dshssh-segment-count) - 1)) / var(--dshssh-segment-count));height:calc(100% - 8px);border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);transform:translateX(calc(var(--dshssh-segment-index) * (100% + 2px)));transition:transform 160ms ease;pointer-events:none}
.dshssh-seg-item{box-sizing:border-box;position:relative;z-index:1;height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer;color:var(--dsw-alias-label-secondary);transition:color 120ms ease}
.dshssh-seg-item[aria-selected="true"],.dshssh-seg-item[aria-checked="true"]{color:var(--dsw-alias-label-primary)}
.dshssh-seg-item:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshssh-seg-item:disabled{cursor:default;opacity:.4}
.dshssh-seg-item:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dshssh-resolve{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:.5px dashed var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);min-width:0}
.dshssh-hidden{display:none}
.dshssh-runtime{min-width:0;max-width:none;box-sizing:border-box;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);padding:0 16px}
.dshssh-runtime>summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0;font-size:13px;font-weight:600;cursor:pointer;list-style:none;color:var(--dsw-alias-label-primary)}
.dshssh-runtime>summary::-webkit-details-marker{display:none}
.dshssh-runtime>summary::before{content:"▸";flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}
.dshssh-runtime[open]>summary::before{content:"▾"}
.dshssh-runtime[open]>summary{border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshssh-runtime>summary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshssh-runtime-body{display:flex;flex-direction:column;gap:10px;padding:12px 0 14px;min-width:0}
.dshssh-bounds{display:flex;flex-direction:column;gap:0;margin:0}
.dshssh-bound{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:7px 0}
.dshssh-bound:last-child{border-bottom:0}
.dshssh-bound dt{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
.dshssh-bound dd{margin:0;font-size:12px;overflow-wrap:anywhere;text-align:right;flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary)}
.dshssh-bound dd[data-live="busy"]{color:var(--dsw-alias-state-warn-primary)}
.dshssh-subhead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
@media (max-width:560px){.dshssh-card{padding:10px 12px}.dshssh-runtime{padding:0 12px}.dshssh-bound dd{text-align:left}}
@media (prefers-reduced-motion: reduce){.dshssh-seg-indicator,.dshssh-seg-item{transition:none}}
`

    /**
     * Substitute `{name}` placeholders without dropping a missing value.
     * @param text - the localized string.
     * @param params - the placeholder values.
     * @returns the finished sentence.
     */
    function format(text: string, params?: Record<string, string | number>): string {
      if (params === undefined) return text
      return text.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, key: string) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : `{${key}}`,
      )
    }

    /**
     * Build the translator this page renders through.
     * @param props - the seat props, whose `t` follows the active locale.
     * @returns a `t(key, params?)` reader with an English fallback.
     */
    function translator(props: any): (key: string, params?: Record<string, string | number>) => string {
      const raw: unknown = typeof props?.t === 'function' ? props.t : undefined
      return (key: string, params?: Record<string, string | number>): string => {
        const value = raw === undefined ? undefined : (raw as (name: string) => unknown)(key)
        const text = typeof value === 'string' && value !== '' ? value : (FALLBACK[key] ?? key)
        return params === undefined ? text : format(text, params)
      }
    }

    /**
     * Call one plugin operation over the shared `/api` channel.
     * @param method - an operation name the route allowlists.
     * @param params - its parameters, secrets included (never read back).
     * @returns the decoded result.
     */
    async function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
      let response: Response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params === undefined ? { method } : { method, params }),
        })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        throw { code: 'internal', message: `${ROUTE}: ${message}` } satisfies SshFailure
      }
      let body: any
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (body?.ok === true) return body.result
      const failure: SshFailure = body?.error ?? { code: 'internal', message: `HTTP ${String(response.status)}` }
      throw failure
    }

    /**
     * Normalize anything thrown by {@link rpc} into one failure shape.
     * @param error - the thrown value.
     * @returns the failure the page renders.
     */
    function toFailure(error: unknown): SshFailure {
      if (typeof error === 'object' && error !== null && 'code' in error) return error as SshFailure
      return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
    }

    /**
     * Split the one address field into its parts. Accepts `host`,
     * `[user@]host[:port]`, bracketed IPv6, and an `ssh://` prefix.
     * @param text - what the user typed.
     * @returns the parsed pieces; an empty host means the address was unusable.
     */
    function parseAddress(text: string): { user: string; host: string; port: string } {
      let value = (text ?? '').trim()
      if (value.startsWith('ssh://')) value = value.slice('ssh://'.length)
      const slash = value.indexOf('/')
      if (slash >= 0) value = value.slice(0, slash)
      let user = ''
      const at = value.lastIndexOf('@')
      if (at >= 0) {
        user = value.slice(0, at)
        value = value.slice(at + 1)
      }
      let port = ''
      if (value.startsWith('[')) {
        const close = value.indexOf(']')
        if (close > 0) {
          const tail = value.slice(close + 1)
          port = tail.startsWith(':') ? tail.slice(1) : ''
          value = value.slice(1, close)
        }
      } else {
        const colon = value.indexOf(':')
        if (colon >= 0) {
          port = value.slice(colon + 1)
          value = value.slice(0, colon)
        }
      }
      return { user: user.trim(), host: value.trim(), port: port.trim() }
    }

    /**
     * Compose the one field's text out of stored parts.
     * @param record - the stored target.
     * @returns the address the field shows.
     */
    function addressOf(record: ConnectionRecord): string {
      // A bare colon-bearing host (IPv6) needs brackets before a port is appended,
      // or the reader cannot tell the address from the port.
      const host = record.host.includes(':') && !record.host.startsWith('[') ? `[${record.host}]` : record.host
      const base = record.user === undefined || record.user === '' ? host : `${record.user}@${host}`
      return record.port === undefined ? base : `${base}:${String(record.port)}`
    }

    /**
     * Read one box of the parameters card. An empty box is a choice, not a no-op:
     * it asks the Host to drop this profile's override so the configured default
     * applies again. A box that cannot mean a byte count or a deadline is reported
     * rather than dropped, which is what the silent `undefined` this replaced used
     * to do — the save answered `Saved.` while the number in the box never left
     * the browser.
     * @param text - what the reader typed.
     * @returns `{ at: 'clear' }`, `{ at: 'set', value }`, or `{ at: 'bad' }`.
     */
    function readCeiling(text: string): { at: 'clear' } | { at: 'set'; value: number } | { at: 'bad' } {
      const trimmed = (text ?? '').trim()
      if (trimmed === '') return { at: 'clear' }
      const parsed = Number(trimmed)
      // The same line the Host draws: a positive whole number means something to
      // clamp, and anything else has no meaning at all. `Number('')` is 0 and
      // `Number(' ')` is 0 too, so the empty check above comes first on purpose.
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return { at: 'bad' }
      return { at: 'set', value: parsed }
    }

    /**
     * Split the extra-arguments textarea into argv entries, one per line.
     * @param text - the raw textarea value.
     * @returns the entries, or `undefined` when none were given.
     */
    function flagsOf(text: string): string[] | undefined {
      const lines = (text ?? '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
      return lines.length === 0 ? undefined : lines
    }

    /**
     * Read one stored target back into the form's draft shape.
     * @param record - the stored target, or `null` for a new one.
     * @returns the draft the form edits.
     */
    function draftOf(record: ConnectionView | null): any {
      if (record === null) {
        return {
          id: undefined,
          address: '',
          label: '',
          auth: 'key',
          identityFile: '',
          passphrase: '',
          password: '',
          root: '',
          clearPassphrase: false,
          clearPassword: false,
          clearRoot: false,
          showPassphrase: false,
          showPassword: false,
          showRoot: false,
          proxyJump: '',
          extraArgsText: '',
          note: '',
          pool: 'on',
          agentAccess: 'on',
          allowedCommandsText: '',
          hadPassphrase: false,
          hadPassword: false,
          hadRoot: false,
        }
      }
      return {
        id: record.id,
        address: addressOf(record),
        label: record.label === addressOf(record) ? '' : record.label,
        auth: record.auth ?? 'key',
        identityFile: record.identityFile ?? '',
        passphrase: '',
        password: '',
        root: '',
        clearPassphrase: false,
        clearPassword: false,
        clearRoot: false,
        showPassphrase: false,
        showPassword: false,
        showRoot: false,
        proxyJump: record.proxyJump ?? '',
        extraArgsText: (record.extraArgs ?? []).join('\n'),
        note: record.note ?? '',
        pool: record.pool ?? 'on',
        agentAccess: record.agentAccess ?? 'on',
        allowedCommandsText: (record.allowedCommands ?? []).join(', '),
        hadPassphrase: record.secrets?.passphrase === true,
        hadPassword: record.secrets?.password === true,
        hadRoot: record.secrets?.root === true,
      }
    }

    /**
     * Turn the edited draft into the payload the Host validates.
     * @param draft - the form state.
     * @param parsed - the parsed address field.
     * @param withAuth - whether the loaded Host understands authentication modes.
     * @param withPool - whether the loaded Host understands connection sharing; an
     *   older one would reject the field outright.
     * @returns a `save` connection payload, with blank fields dropped.
     */
    function payloadOf(draft: any, parsed: { user: string; host: string; port: string }, withAuth: boolean, withPool: boolean): ConnectionInput {
      const optional = (value: string): string | undefined => {
        const trimmed = (value ?? '').trim()
        return trimmed === '' ? undefined : trimmed
      }
      const args = flagsOf(draft.extraArgsText ?? '')
      const user = optional(draft.user ?? '') ?? (parsed.user === '' ? undefined : parsed.user)
      const identityFile = optional(draft.identityFile ?? '')
      const proxyJump = optional(draft.proxyJump ?? '')
      const note = optional(draft.note ?? '')
      const portText = parsed.port === '' ? optional(draft.port ?? '') : parsed.port
      return {
        ...(draft.id === undefined || draft.id === '' ? {} : { id: draft.id }),
        label: optional(draft.label ?? '') ?? parsed.host,
        host: parsed.host,
        ...(user === undefined || user === '' ? {} : { user }),
        ...(portText === undefined || portText === '' ? {} : { port: Number(portText) }),
        ...(identityFile === undefined ? {} : { identityFile }),
        ...(proxyJump === undefined ? {} : { proxyJump }),
        ...(args === undefined ? {} : { extraArgs: args }),
        ...(note === undefined ? {} : { note }),
        ...(withAuth ? { auth: draft.auth ?? 'key' } : {}),
        ...(withPool ? { pool: draft.pool === 'off' ? 'off' : 'on' } : {}),
        // The two policy fields every agent call reads. They predate the capability
        // gates — the stored schema has carried them since the version this page has
        // always spoken to — and both are sent explicitly, always: an edit that turns
        // access back on must write `on`, and an emptied allowlist must actually
        // empty the stored list instead of leaving the old names behind.
        agentAccess: draft.agentAccess === 'off' ? 'off' : 'on',
        allowedCommands: allowlistOf(draft.allowedCommandsText ?? ''),
      }
    }

    /**
     * The free-text allowlist field, cut into the bare names the schema validates.
     * Anything the server will refuse is left for the server to refuse, with its
     * field error landing on this input; the page only splits words.
     * @param text - what the reader typed, commas or spaces between names.
     * @returns the program names, in order, deduplicated.
     */
    function allowlistOf(text: string): string[] {
      const out: string[] = []
      for (const word of text.split(/[,;\s]+/u)) {
        const name = word.trim().toLowerCase()
        if (name !== '' && !out.includes(name)) out.push(name)
      }
      return out
    }

    /**
     * The secret intent of the edited form: typed values write, checked
     * clear-outs forget, and anything untouched is left alone.
     * @param draft - the form state.
     * @returns the secrets payload, or `undefined` when nothing changed.
     */
    function secretsOf(draft: any): Record<string, unknown> | undefined {
      const patch: Record<string, unknown> = {}
      if (draft.clearPassphrase) patch.passphrase = null
      else if ((draft.passphrase ?? '') !== '') patch.passphrase = draft.passphrase
      if (draft.clearPassword) patch.password = null
      else if ((draft.password ?? '') !== '') patch.password = draft.password
      if (draft.clearRoot) patch.root = null
      else if ((draft.root ?? '') !== '') patch.root = draft.root
      return Object.keys(patch).length === 0 ? undefined : patch
    }

    /**
     * Format one instant for readers who hover a timestamp.
     * @param iso - the stored UTC instant.
     * @returns a short local date and time.
     */
    function when(iso: string): string {
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
    }

    /**
     * Byte and millisecond counts the way a settings reader expects.
     * @param value - the number to state.
     * @param unit - `bytes` or `ms`.
     * @returns the human sentence.
     */
    function measure(value: number | undefined, unit: 'bytes' | 'ms'): string {
      if (value === undefined || !Number.isFinite(value)) return '—'
      if (unit === 'ms') return value % 1000 === 0 ? `${String(value / 1000)} s` : `${String(value)} ms`
      const mib = 1024 * 1024
      if (value >= mib && value % mib === 0) return `${String(value / mib)} MiB`
      if (value >= 1024 && value % 1024 === 0) return `${String(value / 1024)} KiB`
      return `${String(value)} B`
    }

    /**
     * An idle timeout stated the way a reader would say it out loud.
     * @param seconds - whole seconds one shared connection stays open.
     * @returns the human sentence.
     */
    function idleFor(seconds: number | undefined): string {
      if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '—'
      if (seconds % 60 === 0) return `${String(seconds / 60)} min`
      return `${String(seconds)} s`
    }

    /**
     * Decide whether a stored target is the one an unnamed call lands on, and say
     * so only when the inventory actually makes one. This is the Host's own rule
     * (`findTarget` in `tool.ts`, mirrored by `ops.pickTarget`): an explicit
     * reference wins, then the conversation's chosen target, then a lone target.
     * The page has no conversation to name, so the only default it can report
     * without inventing a stored field is the one every conversation shares.
     * @param connections - the stored list, already ordered by label.
     * @returns the id carrying the marker, or `undefined`.
     */
    function defaultTargetId(connections: readonly ConnectionView[]): string | undefined {
      return connections.length === 1 ? connections[0]?.id : undefined
    }

    /** One state dot and its label. */
    function Badge(props: { tone: string; text: string }): any {
      return h('span', { class: 'dshssh-badge', 'data-tone': props.tone }, props.text)
    }

    /** One small pill of fact beside a name: what is stored, what is switched. */
    function Chip(props: { text: string; tone?: string }): any {
      return h('span', { class: 'dshssh-chip', ...(props.tone === undefined ? {} : { 'data-tone': props.tone }) }, props.text)
    }

    /** A labelled single-line input, optionally with a reveal button for secrets. */
    function TextField(props: {
      label: string
      value: string
      onChange: (value: string) => void
      placeholder?: string
      hint?: string
      type?: string
      disabled?: boolean
      errorText?: string
      reveal?: { shown: boolean; onToggle: () => void; showLabel: string; hideLabel: string }
    }): any {
      const inputType = props.reveal === undefined ? (props.type ?? 'text') : (props.reveal.shown ? 'text' : 'password')
      return h('label', { class: 'dshssh-field' },
        h('span', { class: 'dshssh-label' }, props.label),
        h('span', { class: 'dshssh-input-inline' },
          h('input', {
            class: 'dshssh-input',
            type: inputType,
            value: props.value,
            placeholder: props.placeholder ?? '',
            disabled: props.disabled === true,
            autocomplete: props.reveal === undefined ? 'off' : 'new-password',
            spellcheck: 'false',
            'aria-invalid': props.errorText === undefined ? 'false' : 'true',
            onChange: (event: any) => { props.onChange(String(event.target.value ?? '')) },
          }),
          props.reveal === undefined ? null : h('button', {
            class: 'dshssh-eye',
            type: 'button',
            'aria-label': props.reveal.shown ? props.reveal.hideLabel : props.reveal.showLabel,
            'aria-pressed': props.reveal.shown,
            onClick: props.reveal.onToggle,
          }, props.reveal.shown ? props.reveal.hideLabel : props.reveal.showLabel),
        ),
        props.hint === undefined ? null : h('span', { class: 'dshssh-tertiary' }, props.hint),
        props.errorText === undefined ? null : h('span', { class: 'dshssh-error' }, props.errorText),
      )
    }

    /** A labelled multi-line input. */
    function TextAreaField(props: { label: string; value: string; onChange: (value: string) => void; hint?: string; disabled?: boolean; errorText?: string }): any {
      return h('label', { class: 'dshssh-field' },
        h('span', { class: 'dshssh-label' }, props.label),
        h('textarea', {
          class: 'dshssh-textarea',
          value: props.value,
          rows: 3,
          spellcheck: 'false',
          disabled: props.disabled === true,
          'aria-invalid': props.errorText === undefined ? 'false' : 'true',
          onChange: (event: any) => { props.onChange(String(event.target.value ?? '')) },
        }),
        props.hint === undefined ? null : h('span', { class: 'dshssh-tertiary' }, props.hint),
        props.errorText === undefined ? null : h('span', { class: 'dshssh-error' }, props.errorText),
      )
    }

    /** A status line the page announces politely. */
    function Notice(props: { tone: string; text: string; hint?: string }): any {
      return h('div', { class: 'dshssh-notice', 'data-tone': props.tone, role: 'status', 'aria-live': 'polite' },
        h('span', {}, props.text),
        props.hint === undefined ? null : h('span', { class: 'dshssh-tertiary' }, props.hint),
      )
    }

    /** The navigation glyph for this section, matching the package icon. */
    function SshIcon(props: any): any {
      const size: number = typeof props?.size === 'number' ? props.size : 16
      const active: boolean = props?.active === true
      return h('svg', {
        viewBox: '0 0 32 32',
        width: size,
        height: size,
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block', opacity: active ? 1 : 0.72, pointerEvents: 'none' },
      },
        h('path', { d: 'M4.6 10.6l4 5.4-4 5.4', fill: 'none', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M10.9 16h5.3', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeDasharray: '1.6 3.4' }),
        h('rect', { x: 17.6, y: 7.4, width: 9.8, height: 17.2, rx: 2.4, fill: 'none', stroke: 'currentColor', strokeWidth: 2.4 }),
        h('path', { d: 'M18.2 13.1h8.6M18.2 18.9h8.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
      )
    }

    /**
     * The enabled option one walk key lands on. Mirrors the host tablist:
     * arrows step to the nearest enabled neighbour and wrap, Home and End jump.
     * @param options - the segments in display order.
     * @param from - index of the selected segment.
     * @param key - the pressed key.
     * @returns the segment the key asks for, or `undefined` when none does.
     */
    function walkTo(options: readonly { value: string; disabled?: boolean }[], from: number, key: string): { value: string } | undefined {
      const enabled = options.filter(option => option.disabled !== true)
      if (enabled.length === 0) return undefined
      if (key === 'Home') return enabled[0]
      if (key === 'End') return enabled[enabled.length - 1]
      const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1
      const count = options.length
      for (let offset = 1; offset < count; offset += 1) {
        const candidate = options[((from + step * offset) % count + count) % count]
        if (candidate !== undefined && candidate.disabled !== true) return candidate
      }
      return undefined
    }

    /**
     * The host's segmented strip, vendored rather than imported: equal segments
     * under one sliding indicator, a roving tabindex, and the Arrow / Home / End
     * walk. `role: 'radio'` switches the markup to a radiogroup, which is what an
     * authentication choice is; the visual strip is identical.
     */
    function SshSegment(props: {
      id: string
      role: 'tab' | 'radio'
      value: string
      options: readonly { value: string; label: string; hint?: string; disabled?: boolean }[]
      groupLabel: string
      onChange: (next: string) => void
    }): any {
      const list = React.useRef(null)
      const selected = Math.max(0, props.options.findIndex(option => option.value === props.value))
      const isTab = props.role === 'tab'

      // A walk key reports the next value and the owner re-renders with it; the
      // keyboard follows the selection so the roving tabindex stays usable.
      React.useEffect(() => {
        const root = list.current
        if (root === null || root === undefined) return
        const doc = typeof document === 'object' && document !== undefined ? document : undefined
        if (doc === undefined || !root.contains(doc.activeElement)) return
        const active = root.querySelector(isTab ? '[role="tab"][aria-selected="true"]' : '[role="radio"][aria-checked="true"]')
        if (active !== null && active !== undefined) active.focus()
      }, [props.value])

      const onKeyDown = (event: any): void => {
        const key: string = event.key
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return
        event.preventDefault()
        const target = walkTo(props.options, selected, key)
        if (target !== undefined && target.value !== props.value) props.onChange(target.value)
      }

      return h('div', {
        ref: list,
        role: isTab ? 'tablist' : 'radiogroup',
        'aria-label': props.groupLabel,
        class: 'dshssh-seg',
        style: {
          '--dshssh-segment-count': String(props.options.length),
          '--dshssh-segment-index': String(selected),
        },
      },
        h('span', { 'aria-hidden': 'true', class: 'dshssh-seg-indicator' }),
        props.options.map(option => {
          const active = option.value === props.value
          return h('button', {
            key: option.value,
            id: `${props.id}-${option.value}`,
            type: 'button',
            role: props.role,
            ...(isTab
              ? { 'aria-selected': active, 'aria-controls': `${props.id}-${option.value}-panel` }
              : { 'aria-checked': active }),
            tabIndex: active ? 0 : -1,
            disabled: option.disabled === true,
            title: option.hint,
            class: 'dshssh-seg-item',
            onClick: () => { if (!active) props.onChange(option.value) },
            onKeyDown,
          }, option.label)
        }),
      )
    }

    /**
     * Render one probe result: when it ran, how long it took, the fix-up hint
     * for its status, and the captured output tail.
     * @param t - the reader's translator.
     * @param outcome - the stored or freshly probed result.
     * @param withTail - whether to include the captured output, which is what the
     *   expanded row shows and the collapsed one does not.
     * @returns the result region, or `null` when nothing was probed yet.
     */
    function probeRegion(t: (key: string, params?: Record<string, string | number>) => string, outcome: ProbeOutcome | null | undefined, withTail: boolean): any {
      if (outcome === null || outcome === undefined) return null
      const hintKey = STATUS_HINT_KEY[outcome.status]
      return h('div', { class: 'dshssh-field' },
        h('span', { class: 'dshssh-row-meta' },
          format(t('asOf'), { at: when(outcome.at) }),
          outcome.durationMs === undefined
            ? null
            : h('span', {}, ` · ${format(t('took'), { ms: String(outcome.durationMs) })}`),
        ),
        // A failure's advice is the actionable half of the answer, so it stays on
        // the surface; the timing line and the captured bytes are for a reader who
        // asked for details.
        hintKey === undefined || !withTail ? null : h('span', { class: 'dshssh-tertiary' }, t(hintKey)),
        outcome.detail === undefined || !withTail ? null : h('pre', { class: 'dshssh-detail' }, outcome.detail),
      )
    }

    /**
     * Label-and-value rows for one resolved configuration, skipping what the
     * client did not report.
     * @param t - the reader's translator.
     * @param config - the parsed keys.
     * @param record - the saved row, for the fallback address line.
     * @returns the definition-list children.
     */
    function resolveRows(t: (key: string, params?: Record<string, string | number>) => string, config: any, record: ConnectionView): any[] {
      const rows: any[] = []
      const push = (key: string, labelKey: string, value: unknown): void => {
        if (value === undefined || value === null || value === '') return
        rows.push(h('div', { class: 'dshssh-bound', key },
          h('dt', {}, t(labelKey)),
          h('dd', {}, Array.isArray(value) ? value.join(', ') : String(value)),
        ))
      }
      const port = config.port === undefined || config.port === 22 ? '' : `:${String(config.port)}`
      push('host', 'resolveHostname', `${config.user ?? record.user ?? ''}${config.user || record.user ? '@' : ''}${config.hostname ?? record.host}${port}`)
      push('user', 'resolveUser', config.user)
      push('port', 'resolvePort', config.port)
      push('identity', 'resolveIdentity', config.identityFiles)
      push('jump', 'resolveJump', config.proxyJump)
      push('proxy', 'resolveProxy', config.proxyCommand)
      return rows
    }

    /**
     * One stored target: name, address, how it authenticates, whether it answers,
     * and the three actions that matter. Everything a reader only consults when
     * something is wrong — the probe tail, the `ssh -G` view, the diagnostics to
     * paste at whoever runs the server — sits behind the row's own Details toggle,
     * which is what keeps a six-server list inside one screen.
     * @param props - the row's record, the page's busy/confirm state, and the
     *   callbacks that act on it.
     * @returns the row.
     */
    function TargetRowView(props: any): any {
      const t: (key: string, params?: Record<string, string | number>) => string = props.t
      const record: ConnectionView = props.record
      const testing = props.busy === `probe:${record.id}`
      const removing = props.busy === `remove:${record.id}`
      const editing = props.editing === true
      const confirming = props.confirming === true
      const expanded = props.expanded === true
      const answer = props.answer
      const chips: any[] = record.auth === undefined ? [] : [Chip({ text: t(AUTH_LABEL[record.auth] ?? 'authKey') })]
      if (record.secrets?.passphrase === true) chips.push(Chip({ text: t('passphraseSet'), tone: 'secret' }))
      if (record.secrets?.password === true) chips.push(Chip({ text: t('secretSet'), tone: 'secret' }))
      if (record.secrets?.root === true) chips.push(Chip({ text: t('rootSet'), tone: 'secret' }))
      if (record.proxyJump !== undefined) chips.push(Chip({ text: `via ${record.proxyJump}` }))
      if (record.agentAccess === 'off') chips.push(Chip({ text: t('chipAgentOff'), tone: 'secret' }))
      if (record.allowedCommands !== undefined && record.allowedCommands.length > 0) chips.push(Chip({ text: format(t('chipAllowlist'), { count: String(record.allowedCommands.length) }) }))
      const status = testing
        ? Badge({ tone: 'idle', text: t('stRunning') })
        : Badge({
          tone: record.lastProbe === undefined ? 'idle' : (STATUS_TONE[record.lastProbe.status] ?? 'idle'),
          text: record.lastProbe === undefined ? t('stIdle') : t(STATUS_KEY[record.lastProbe.status] ?? 'stFailed'),
        })
      return h('div', { class: 'dshssh-row', key: record.id },
        h('div', { class: 'dshssh-row-head' },
          h('div', { class: 'dshssh-row-main' },
            h('div', { class: 'dshssh-row-line' },
              h('span', { class: 'dshssh-row-title' }, record.label),
              props.isDefault === true ? Chip({ text: t('defaultChip'), tone: 'default' }) : null,
              status,
            ),
            h('div', { class: 'dshssh-row-meta' }, h('span', {}, addressOf(record)), ...chips),
          ),
          h('div', { class: 'dshssh-actions' },
            h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled: props.busy !== null,
              onClick: props.onTest,
            }, t('test')),
            h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled: props.busy !== null || editing,
              onClick: props.onEdit,
            }, t('edit')),
            confirming
              ? h('span', { class: 'dshssh-actions' },
                h('button', {
                  class: 'dshssh-btn dshssh-btn-danger',
                  type: 'button',
                  disabled: removing,
                  onClick: props.onRemove,
                }, removing ? t('saving') : t('confirmRemove')),
                h('button', {
                  class: 'dshssh-btn',
                  type: 'button',
                  disabled: removing,
                  onClick: props.onStopConfirm,
                }, t('cancel')),
              )
              : h('button', {
                class: 'dshssh-btn dshssh-btn-danger',
                type: 'button',
                disabled: props.busy !== null,
                onClick: props.onStartConfirm,
              }, t('remove')),
            h('button', {
              class: 'dshssh-btn-link',
              type: 'button',
              'aria-expanded': expanded,
              onClick: props.onToggleDetails,
            }, expanded ? t('rowDetailsHide') : t('rowDetails')),
          ),
        ),
        // The one thing a reader of a failure needs without asking for it.
        !testing && record.lastProbe !== undefined && STATUS_HINT_KEY[record.lastProbe.status] !== undefined
          ? h('span', { class: 'dshssh-tertiary' }, t(STATUS_HINT_KEY[record.lastProbe.status] ?? ''))
          : null,
        // The reader's own note stays on the surface: it is the one line of this row
        // that was written to be read without asking for it.
        record.note === undefined ? null : h('span', { class: 'dshssh-tertiary' }, record.note),
        expanded
          ? h('div', { class: 'dshssh-row-body' },
            probeRegion(t, record.lastProbe, true),
            h('div', { class: 'dshssh-actions' },
              h('button', {
                class: 'dshssh-btn',
                type: 'button',
                disabled: props.busy !== null,
                onClick: props.onResolve,
              }, t('resolve')),
              record.lastProbe === undefined ? null : h('button', {
                class: 'dshssh-btn',
                type: 'button',
                disabled: props.busy !== null,
                onClick: props.onCopy,
              }, t('copyDetail')),
            ),
            answer === undefined
              ? null
              : h('div', { class: 'dshssh-resolve' },
                h('span', { class: 'dshssh-row-title' }, t('resolveTitle')),
                h('div', { class: 'dshssh-chips' },
                  Chip({ text: answer.differs === true ? t('resolveDiffers') : t('resolveSame'), ...(answer.differs === true ? { tone: 'default' } : {}) }),
                ),
                answer.ok === false
                  ? h('p', { class: 'dshssh-error' }, answer.message ?? t('resolveFailed'))
                  : h('dl', { class: 'dshssh-bounds' }, ...resolveRows(t, answer.resolved ?? {}, record)),
                h('p', { class: 'dshssh-tertiary' }, t('resolveHint')),
                typeof answer.text === 'string' ? h('details', { class: 'dshssh-disclose' },
                  h('summary', {}, t('resolveRaw')),
                  h('pre', { class: 'dshssh-detail' }, String(answer.text)),
                ) : null,
              ),
          )
          : null,
      )
    }

    /**
     * The new/edit form: one address, one mode choice, the secrets it needs, and a
     * collapsed advanced section holding every other field the record carries.
     * @param props - the draft, what the loaded Host understands, and the callbacks.
     * @returns the form, or `null` when no target is being edited.
     */
    function TargetFormView(props: any): any {
      const t: (key: string, params?: Record<string, string | number>) => string = props.t
      const draft = props.draft
      if (draft === null || draft === undefined) return null
      const mode: AuthMode = draft.auth ?? 'key'
      const locked = props.busy !== null
      const atLimit = props.atLimit === true
      const disabled = locked || atLimit
      const modern = props.modern === true
      const showKey = modern && mode === 'key'
      const showPassword = modern && mode === 'password'
      const parsed = parseAddress(draft.address ?? '')
      const summary = parsed.host === '' ? '' : `${parsed.user === '' ? '' : `${parsed.user}@`}${parsed.host}${parsed.port === '' ? '' : `:${parsed.port}`}`
      const patch = (key: string) => (value: string): void => { props.onPatch(key, value) }

      /**
       * One secret field with its stored-state affordances: the placeholder says
       * what is already kept, the checkbox forgets it, and the typed value is what
       * a probe or a save will write.
       */
      const secretField = (field: {
        label: string
        value: string
        had: boolean
        cleared: boolean
        shown: boolean
        errorText?: string
        onChange: (value: string) => void
        onToggleClear: (checked: boolean) => void
        onToggleShow: () => void
      }): any => h('div', { class: 'dshssh-field' },
        h(TextField, {
          label: field.label,
          value: field.value,
          disabled,
          errorText: field.errorText,
          placeholder: field.had && !field.cleared ? t('secretStored') : '',
          reveal: {
            shown: field.shown,
            onToggle: field.onToggleShow,
            showLabel: t('showSecret'),
            hideLabel: t('hideSecret'),
          },
          onChange: field.onChange,
        }),
        field.had ? h('label', { class: 'dshssh-check' },
          h('input', {
            type: 'checkbox',
            checked: field.cleared,
            disabled,
            onChange: (event: any) => { field.onToggleClear(event.target.checked === true) },
          }),
          h('span', {}, t('secretClear')),
        ) : null,
      )

      return h('div', { class: 'dshssh-form' },
        h('div', { class: 'dshssh-card-title' }, draft.id === undefined ? t('newTitle') : t('editTitle')),
        h(TextField, {
          label: t('addrLabel'),
          value: draft.address ?? '',
          placeholder: t('addrPlaceholder'),
          hint: summary === '' ? t('addrHint') : `${t('addrHint')} → ${summary}`,
          disabled,
          errorText: props.fieldError === 'address' || props.fieldError === 'host' ? t('addrBad') : undefined,
          onChange: (value: string) => { props.onPatch('address', value) },
        }),
        modern ? null : h('p', { class: 'dshssh-tertiary' }, t('legacyHost')),
        h('div', { class: modern ? 'dshssh-field' : 'dshssh-hidden' },
          h(SshSegment, {
            id: AUTH_BASE,
            role: 'radio',
            value: mode,
            groupLabel: t('authTitle'),
            options: AUTH_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey), hint: t(option.hintKey), disabled })),
            onChange: (next: string) => { props.onPatch('auth', next) },
          }),
          h('span', { class: 'dshssh-tertiary' }, t(AUTH_OPTIONS.find(option => option.value === mode)?.hintKey ?? 'authKeyHint')),
        ),
        showKey ? h('div', { class: 'dshssh-grid' },
          h(TextField, {
            label: `${t('keyFileLabel')} (${t('fOptional')})`,
            value: draft.identityFile ?? '',
            disabled,
            errorText: props.fieldError === 'identityFile' ? t('hintBadInput') : undefined,
            onChange: patch('identityFile'),
          }),
        ) : null,
        showKey ? secretField({
          label: `${t('passphraseLabel')} (${t('fOptional')})`,
          value: draft.passphrase ?? '',
          had: draft.hadPassphrase === true,
          cleared: draft.clearPassphrase === true,
          shown: draft.showPassphrase === true,
          ...(props.fieldError === 'passphrase' ? { errorText: t('hintBadInput') } : {}),
          onChange: patch('passphrase'),
          onToggleClear: (checked: boolean) => { props.onPatch('clearPassphrase', checked) },
          onToggleShow: () => { props.onToggleSecret('showPassphrase') },
        }) : null,
        showPassword ? secretField({
          label: t('passwordLabel'),
          value: draft.password ?? '',
          had: draft.hadPassword === true,
          cleared: draft.clearPassword === true,
          shown: draft.showPassword === true,
          ...(props.fieldError === 'password' ? { errorText: t('hintBadInput') } : {}),
          onChange: patch('password'),
          onToggleClear: (checked: boolean) => { props.onPatch('clearPassword', checked) },
          onToggleShow: () => { props.onToggleSecret('showPassword') },
        }) : null,
        modern ? secretField({
          label: `${t('rootLabel')} (${t('fOptional')})`,
          value: draft.root ?? '',
          had: draft.hadRoot === true,
          cleared: draft.clearRoot === true,
          shown: draft.showRoot === true,
          ...(props.fieldError === 'root' ? { errorText: t('hintBadInput') } : {}),
          onChange: patch('root'),
          onToggleClear: (checked: boolean) => { props.onPatch('clearRoot', checked) },
          onToggleShow: () => { props.onToggleSecret('showRoot') },
        }) : null,
        h(TextField, {
          label: `${t('labelField')} (${t('fOptional')})`,
          value: draft.label ?? '',
          placeholder: summary,
          hint: t('labelHint'),
          disabled,
          errorText: props.fieldError === 'label' ? t('hintBadInput') : undefined,
          onChange: patch('label'),
        }),
        h('details', { class: 'dshssh-disclose' },
          h('summary', {}, t('advanced')),
          h('p', { class: 'dshssh-tertiary' }, t('advancedHint')),
          h('div', { class: 'dshssh-grid' },
            h(TextField, {
              label: `${t('fProxy')} (${t('fOptional')})`,
              value: draft.proxyJump ?? '',
              disabled,
              errorText: props.fieldError === 'proxyJump' ? t('hintBadInput') : undefined,
              onChange: patch('proxyJump'),
            }),
          ),
          h(TextAreaField, {
            label: `${t('fArgs')} (${t('fOptional')})`,
            value: draft.extraArgsText ?? '',
            hint: t('fArgsHint'),
            disabled,
            onChange: patch('extraArgsText'),
          }),
          h(TextField, {
            label: `${t('fNote')} (${t('fOptional')})`,
            value: draft.note ?? '',
            disabled,
            onChange: patch('note'),
          }),
          // Only a Host that was assembled with a pool may be handed the field:
          // an older one validates its input strictly and would reject the save.
          props.pooling ? h('div', { class: 'dshssh-field' },
            h('label', { class: 'dshssh-check' },
              h('input', {
                type: 'checkbox',
                checked: draft.pool !== 'off',
                disabled,
                onChange: (event: any) => { props.onPatch('pool', event.target.checked === true ? 'on' : 'off') },
              }),
              h('span', {}, t('fPool')),
            ),
            h('p', { class: 'dshssh-tertiary' }, t('fPoolHint')),
          ) : null,
          // The two switches the tool's own gate reads. No capability gate: the
          // stored schema has carried both since before this page existed.
          h('div', { class: 'dshssh-field' },
            h('label', { class: 'dshssh-check' },
              h('input', {
                type: 'checkbox',
                checked: draft.agentAccess !== 'off',
                disabled,
                onChange: (event: any) => { props.onPatch('agentAccess', event.target.checked === true ? 'on' : 'off') },
              }),
              h('span', {}, t('fAgent')),
            ),
            h('p', { class: 'dshssh-tertiary' }, t('fAgentHint')),
          ),
          h(TextField, {
            label: `${t('fAllowlist')} (${t('fOptional')})`,
            value: draft.allowedCommandsText ?? '',
            hint: t('fAllowlistHint'),
            disabled,
            errorText: props.fieldError === 'allowedCommands' ? t('hintBadInput') : undefined,
            onChange: patch('allowedCommandsText'),
          }),
        ),
        atLimit ? h('span', { class: 'dshssh-error' }, format(t('listCount'), { count: String(props.count), limit: String(props.limit) })) : null,
        props.draftProbe === null || props.draftProbe === undefined
          ? null
          : h('div', { class: 'dshssh-field' },
            Badge({
              tone: STATUS_TONE[props.draftProbe.status] ?? 'idle',
              text: t(STATUS_KEY[props.draftProbe.status] ?? 'stFailed'),
            }),
            probeRegion(t, props.draftProbe, true),
          ),
        h('div', { class: 'dshssh-foot' },
          h('button', {
            class: 'dshssh-btn',
            type: 'button',
            disabled,
            onClick: props.onTestDraft,
          }, t('testDraft')),
          h('button', {
            class: 'dshssh-btn',
            type: 'button',
            disabled: locked,
            onClick: props.onCancel,
          }, t('cancel')),
          h('button', {
            class: 'dshssh-btn dshssh-btn-primary',
            type: 'button',
            disabled: disabled || atLimit,
            onClick: props.onSave,
          }, busyLabel(props.busy, draft, t('save'), t('saving'))),
        ),
      )
    }

    /**
     * Name the form's save button: its ordinary word, or the in-progress word
     * while this draft's own write is running.
     * @param busy - what the page is doing, if anything.
     * @param draft - the edited target.
     * @param idle - the save copy.
     * @param running - the saving copy.
     * @returns the button label.
     */
    function busyLabel(busy: string | null, draft: any, idle: string, running: string): string {
      return busy === 'new' || busy === draft?.id ? running : idle
    }

    /**
     * The client parameters, one row each, with the default they follow, the cap
     * they are held to, and the value that is actually in force. Nothing here is
     * a system limit dressed up as an editable number: the ceilings the profile
     * cannot move sit in the runtime card instead.
     * @param props - the boxes' text, what the Host resolved, and the callbacks.
     * @returns the card.
     */
    function ClientParamsCardView(props: any): any {
      const t: (key: string, params?: Record<string, string | number>) => string = props.t
      const bounds = props.bounds
      const draft = props.draft
      const stored = props.stored
      const settings = props.settings
      const unavailable = settings === null
      const locked = props.busy !== null || unavailable || props.storageFailure === true
      const fields: readonly { key: string; labelKey: string; unitKey: string; unit: 'bytes' | 'ms'; defaultKey: string; capKey: string; effectiveKey: string }[] = [
        { key: 'remoteTimeoutMs', labelKey: 'settingsRemoteTimeout', unitKey: 'unitMs', unit: 'ms', defaultKey: 'timeoutMs', capKey: 'maxTimeoutMs', effectiveKey: 'remoteTimeoutMs' },
        { key: 'maxOutputBytes', labelKey: 'settingsMaxOutput', unitKey: 'unitBytes', unit: 'bytes', defaultKey: 'outputBytes', capKey: 'maxOutputBytes', effectiveKey: 'maxOutputBytes' },
        { key: 'maxTransferBytes', labelKey: 'settingsMaxTransfer', unitKey: 'unitBytes', unit: 'bytes', defaultKey: 'transferBytes', capKey: 'maxTransferBytes', effectiveKey: 'maxTransferBytes' },
      ]
      const rows = fields.map(field => {
        const text = String(draft[field.key] ?? '')
        const read = readCeiling(text)
        const storedValue = stored?.[field.key]
        const overridden = storedValue !== undefined && storedValue !== null
        const effective = bounds?.effective?.[field.effectiveKey]
        const defValue = bounds?.[field.defaultKey]
        const capValue = bounds?.[field.capKey]
        // The stored number and the number that ran are different facts, and only
        // the Host can say what the second one is: a cap that moved a saved value
        // has to be shown moving it, or the card is describing a call nobody made.
        const capped = overridden && effective !== undefined && Number(effective) !== Number(storedValue)
        return h('div', { class: 'dshssh-field', key: field.key },
          h('label', { class: 'dshssh-label' },
            h('span', {}, t(field.labelKey)),
            read.at === 'bad' ? null : Chip({ text: overridden ? t('paramOverride') : t('paramFollowDefault') }),
          ),
          h('div', { class: 'dshssh-input-inline' },
            h('input', {
              class: 'dshssh-input',
              type: 'number',
              inputMode: 'numeric',
              min: '1',
              step: '1',
              // The box keeps whatever was typed, so a refusal or a failed write
              // never costs a reader the number they were working from.
              value: text,
              disabled: locked,
              placeholder: defValue === undefined ? '' : String(defValue),
              'aria-invalid': read.at === 'bad' ? 'true' : 'false',
              onChange: (event: any) => { props.onPatch(field.key, String(event.target.value ?? '')) },
            }),
            overridden && !locked
              ? h('button', {
                class: 'dshssh-eye',
                type: 'button',
                onClick: () => { props.onPatch(field.key, '') },
              }, t('paramReset'))
              : null,
          ),
          h('span', { class: 'dshssh-tertiary' }, [
            format(t('boundsDefaultOf'), { value: measure(defValue, field.unit) }),
            format(t('boundsCapOf'), { value: measure(capValue, field.unit) }),
            effective === undefined ? null : format(t('boundsEffectiveOf'), { value: measure(Number(effective), field.unit) }),
          ].filter(Boolean).join(' · ')),
          read.at === 'bad' ? h('span', { class: 'dshssh-error' }, format(t('paramBadNumber'), { unit: t(field.unitKey) })) : null,
          capped ? h('span', { class: 'dshssh-error' }, format(t('paramCapped'), { value: measure(Number(effective), field.unit) })) : null,
        )
      })
      return h('section', { class: 'dshssh-card' },
        h('div', { class: 'dshssh-card-head' },
          h('div', { class: 'dshssh-card-headline' },
            h('h3', { class: 'dshssh-card-title' }, t('settingsTitle')),
            props.dirty === true ? h('span', { class: 'dshssh-tertiary' }, t('paramDirty')) : null,
          ),
          h('button', {
            class: 'dshssh-btn dshssh-btn-primary',
            type: 'button',
            disabled: locked || props.dirty !== true || props.invalid === true,
            onClick: props.onSave,
          }, props.busy === 'settings' ? t('saving') : t('settingsSave')),
        ),
        h('p', { class: 'dshssh-tertiary' }, t('settingsOverrideHint')),
        h('div', { class: 'dshssh-fields' }, ...rows),
        unavailable ? h('span', { class: 'dshssh-tertiary' }, props.loading === true ? t('listProbing') : t('listLoadFailed')) : null,
      )
    }

    /**
     * Every number this plugin fixes in code or configuration, in one collapsed
     * card a reader opens once. The rows are the Host's own answers: what a lane
     * holds and what is standing in it, what each ceiling resolved to, and what
     * this Host had to correct on the way there.
     * @param props - the live counts, the resolved bounds, and `onRefresh`.
     * @returns the card.
     */
    function RuntimeCardView(props: any): any {
      const t: (key: string, params?: Record<string, string | number>) => string = props.t
      const bounds = props.bounds
      const limits = props.limits
      const pool = props.pool
      const spill = props.spill
      const temp = props.temp
      const probing = props.probing
      const pooling = props.pooling

      /**
       * One metric row: the ordinary name, and the number(s) the Host reported. A
       * lane with work standing in it is drawn in the warn tone, since the row a
       * reader hunts for when a call was turned away is the row that says so.
       * @param key - the row's React key.
       * @param labelKey - the dictionary key naming the metric.
       * @param value - what to print, already stated in the reader's units.
       * @param running - how much of the lane is occupied now, when the row is a lane.
       * @returns the row.
       */
      const bound = (key: string, labelKey: string, value: any, running?: number): any => h('div', { class: 'dshssh-bound', key },
        h('dt', {}, t(labelKey)),
        h('dd', { ...(Number(running ?? 0) > 0 ? { 'data-live': 'busy' } : {}) }, value),
      )

      /** A lane stated as use over limit, with the limit named in the label. */
      const lane = (ceiling: any, running: number | undefined): string =>
        format(t('boundsRunning'), { ceiling: String(ceiling ?? '—'), running: String(running ?? 0) })

      // Every operation lane the Host counts in one number: `probing` is
      // `runner.inFlight`, which already holds the probes, the commands, the copies
      // and the jobs alike. A collapsed card says so only when there is a now to
      // report — a zero here is not a fact about this plugin, it is the absence of
      // one, and it is the reason the row is not shown at all.
      const active = Number(probing ?? 0)
      return h('details', { class: 'dshssh-runtime', onToggle: props.onToggle },
        h('summary', {},
          h('span', {}, t('runtimeTitle')),
          active > 0 ? Chip({ text: format(t('runtimeBusy'), { count: String(active) }) }) : null,
        ),
        h('div', { class: 'dshssh-runtime-body' },
          // Stated before any number: every figure below is one the plugin fixes in
          // code or in the profile's configuration, and a reader who takes one for a
          // knob on this card goes looking for a control that was never there.
          h('p', { class: 'dshssh-tertiary' }, t('runtimeHint')),
          h('div', { class: 'dshssh-subhead' },
            h('span', { class: 'dshssh-card-title' }, bounds === null ? t('boundsTitle') : t('boundsResolvedTitle')),
            h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled: props.busy !== null || props.refreshing === true,
              onClick: props.onRefresh,
            }, t('refresh')),
          ),
          h('p', { class: 'dshssh-tertiary' }, t('runtimeUsageFormat')),
          h('dl', { class: 'dshssh-bounds' },
            bound('targets', 'boundsTargets', String(limits.maxConnections)),
            // A ceiling a reader cannot see being used is a ceiling they only meet
            // as a refusal, so each lane row quotes what is standing in it now.
            // A Host that predates the pool sends no counts and no sharing rows:
            // printing this release's numbers for that process would put a surprise
            // on the very card whose job is to prevent one.
            bound('lanes', 'boundsOps', pooling ? lane(limits.concurrentOps, probing) : String(limits.concurrentOps), probing),
            ...(pooling ? [
              bound('masters', 'boundsMasters', lane(limits.maxLiveMasters, pool?.liveMasters), pool?.liveMasters),
              bound('copies', 'boundsCopies', lane(bounds?.effective?.maxConcurrentTransfers ?? '—', pool?.transfers ?? 0), pool?.transfers),
              // The job lane is the ceiling a reader can run into while nothing appears
              // to be happening — a backgrounded command holds its slot until it ends —
              // and it is the one number the profile cannot raise on its own, because
              // these slots are the ones held back for calls that wait. Both halves are
              // stated, because a row that only shows the ceiling invites someone to go
              // looking for a knob that was never there.
              bound('jobs', 'boundsJobs', `${lane(bounds?.maxRunningJobs ?? limits.maxRunningJobs, pool?.jobs ?? 0)} · ${format(t('boundsJobsReserved'), { reserved: String(bounds?.foregroundReservedOps ?? limits.foregroundReservedOps), total: String(bounds?.concurrentOps ?? limits.concurrentOps) })}`, pool?.jobs),
              // Spill is the one ceiling whose cost is a file on disk rather than a
              // line in the answer, so the card says what is sitting there now and
              // how many answers the budget already refused to write out.
              ...(spill === null || spill.max === 0 ? [] : [
                bound('spill', 'boundsSpill', `${format(t('spillFiles'), { files: String(spill.files) })}${spill.refusals > 0 ? format(t('spillRefused'), { refusals: String(spill.refusals) }) : ''}`),
                bound('spillbytes', 'spillBytes', `${measure(spill.used, 'bytes')} / ${measure(spill.max, 'bytes')}`),
              ]),
              bound('persist', 'boundsPersist', idleFor(limits.controlPersistSeconds)),
            ] : []),
            bound('round', 'boundsPerRound', String(limits.probeAllLimit)),
            bound('timeout', 'boundsTimeout', measure(bounds?.probeTimeoutMs ?? limits.probeTimeoutMs, 'ms')),
            // A Host that resolves its bounds from configuration states each ceiling as
            // default / cap / in force, which is what makes a capped call legible. An
            // older one only ever published a two-sided range, so its row keeps that
            // shape rather than inventing a "default" it never had.
            ...(bounds === null ? [
              h('div', { class: 'dshssh-bound', key: 'remote' }, h('dt', {}, t('boundsRemoteTimeout')), h('dd', {}, `${measure(limits.remoteTimeoutMinMs, 'ms')} – ${measure(limits.remoteTimeoutMaxMs, 'ms')}`)),
              h('div', { class: 'dshssh-bound', key: 'output' }, h('dt', {}, t('boundsOutput')), h('dd', {}, `${measure(limits.outputMinBytes, 'bytes')} – ${measure(limits.outputMaxBytes, 'bytes')}`)),
              h('div', { class: 'dshssh-bound', key: 'transfer' }, h('dt', {}, t('boundsTransfer')), h('dd', {}, `${measure(limits.transferMinBytes, 'bytes')} – ${measure(limits.transferMaxBytes, 'bytes')}`)),
            ] : [
              h('div', { class: 'dshssh-bound', key: 'remote' }, h('dt', {}, t('settingsRemoteTimeout')), h('dd', {}, ceilingText(t, bounds.timeoutMs, bounds.maxTimeoutMs, bounds.effective?.remoteTimeoutMs, 'ms'))),
              h('div', { class: 'dshssh-bound', key: 'output' }, h('dt', {}, t('settingsMaxOutput')), h('dd', {}, ceilingText(t, bounds.outputBytes, bounds.maxOutputBytes, bounds.effective?.maxOutputBytes, 'bytes'))),
              h('div', { class: 'dshssh-bound', key: 'transfer' }, h('dt', {}, t('settingsMaxTransfer')), h('dd', {}, ceilingText(t, bounds.transferBytes, bounds.maxTransferBytes, bounds.effective?.maxTransferBytes, 'bytes'))),
            ]),
          ),
          // Where a number came from, and what this Host had to correct on the way to
          // it: a configuration whose cap sat below its default is a mistake worth
          // naming out loud rather than one the reader discovers through a surprise.
          bounds === null ? null : h('p', { class: 'dshssh-tertiary' }, t('boundsFromConfig')),
          bounds?.notes?.length > 0
            ? h('p', { class: 'dshssh-tertiary' }, String((bounds.notes as unknown[]).join(' · ')))
            : null,
          // A fact about this machine, not a bound: the pool only exists if the Host
          // could make a private directory for its sockets, and when it could not,
          // every number above still holds while sharing simply does not happen.
          pool !== null && pool !== undefined && pool.ready === false
            ? h('p', { class: 'dshssh-tertiary' }, format(t('poolOff'), { reason: pool.failure ?? '—' }))
            : null,
          // A line that only exists when there is something to report: the sweep ran
          // at startup, and the only time its arithmetic matters to a reader is the
          // time it took something.
          temp !== null && temp !== undefined && temp.removed.length > 0
            ? h('p', { class: 'dshssh-tertiary' }, format(t('tempCollected'), { removed: String(temp.removed.length), scanned: String(temp.scanned), kept: String(temp.kept.length), plural: temp.removed.length === 1 ? '' : 's' }))
            : null,
          h('div', { class: 'dshssh-subhead' }, h('span', { class: 'dshssh-card-title' }, t('runtimeStorageTitle'))),
          h('p', { class: 'dshssh-tertiary' }, t('storedIn')),
          h('p', { class: 'dshssh-tertiary' }, t('storageConfigNote')),
          h('p', { class: 'dshssh-tertiary' }, t('defaultHint')),
          props.legacy === true ? h('p', { class: 'dshssh-tertiary' }, t('legacyHost')) : null,
        ),
      )
    }

    /**
     * One ceiling stated the way a reader of the limits card needs it: what is in
     * force right now, and the default and cap it was resolved from. The order is
     * deliberate — the number that actually applies goes first, because that is the
     * one a call is being measured against.
     * @param t - the reader's translator.
     * @param def - the configured default.
     * @param cap - the configured cap.
     * @param inForce - what a call with no override would run with.
     * @param unit - how to state the three.
     * @returns the one-line description.
     */
    function ceilingText(t: (key: string, params?: Record<string, string | number>) => string, def: number | undefined, cap: number | undefined, inForce: number | undefined, unit: 'ms' | 'bytes'): string {
      return [
        format(t('boundsEffectiveOf'), { value: measure(inForce, unit) }),
        format(t('boundsDefaultOf'), { value: measure(def, unit) }),
        format(t('boundsCapOf'), { value: measure(cap, unit) }),
      ].join(' · ')
    }

    /**
     * The page this plugin contributes.
     *
     * One container holds the state and every call the page can make, and hands
     * each region what it needs to render: the target list and its form, the three
     * client parameters, and the runtime card. The settings shell gives a plugin
     * exactly one navigation row per section, so the three regions share one
     * scroll in the order a reader uses them rather than one tab apiece.
     * @param props - seat props: the localized reader and the panel `close`.
     * @returns the rendered page.
     */
    function SshSection(props: any): any {
      const t = translator(props)
      const [connections, setConnections] = React.useState([] as ConnectionView[])
      const [settings, setSettings] = React.useState(null as { maxOutputBytes: number; remoteTimeoutMs: number; maxTransferBytes: number } | null)
      // The numbers a Host that predates the `bounds` payload still has to be shown
      // something for. They are this release's own defaults, and a test in
      // `client-fallbacks.test.mjs` compares each one against the config it is meant
      // to mirror — 0.0.36 carried a 10 s probe timeout here while the Host it
      // described had been dialing with 30 s since 0.0.23, which is how a settings
      // page comes to disagree with the call it is reporting on.
      const [limits, setLimits] = React.useState({ maxConnections: 64, concurrentOps: 16, maxLiveMasters: 8, controlPersistSeconds: 300, probeAllLimit: 12, probeTimeoutMs: 30_000, maxRunningJobs: 8, foregroundReservedOps: 8, remoteTimeoutMinMs: 1000, remoteTimeoutMaxMs: 300000, outputMinBytes: 1024, outputMaxBytes: 4194304, transferMinBytes: 1024, transferMaxBytes: 536870912 })
      const [askpass, setAskpass] = React.useState('ready')
      // Whether the loaded Host knows about connection sharing at all. A package
      // swapped in place keeps the previous Host module until the restart, and its
      // schema would refuse a `pool` field the new page is ready to send.
      const [pooling, setPooling] = React.useState(false)
      const [pool, setPool] = React.useState(null as { ready: boolean; liveMasters: number; transfers?: number; jobs?: number; failure?: string } | null)
      // What this Host process has asked the provider to keep on disk, and what its
      // startup collected from its own temp namespace.
      const [spill, setSpill] = React.useState(null as { used: number; files: number; refusals: number; max: number } | null)
      const [temp, setTemp] = React.useState(null as { scanned: number; removed: { path: string; reason: string }[]; kept: { path: string; reason: string }[]; errors: { path: string; message: string }[] } | null)
      // Whether the loaded Host half knows about authentication modes at all:
      // an in-place package swap needs a Host restart, and the page keeps working
      // without the secret controls until then.
      const [modern, setModern] = React.useState(false)
      const [probing, setProbing] = React.useState(0)
      const [loading, setLoading] = React.useState(true)
      const [refreshing, setRefreshing] = React.useState(false)
      const [busy, setBusy] = React.useState(null as string | null)
      const [failure, setFailure] = React.useState(null as SshFailure | null)
      const [notice, setNotice] = React.useState(null as { tone: string; text: string } | null)
      const [draft, setDraft] = React.useState(null as any)
      const [draftProbe, setDraftProbe] = React.useState(null as ProbeOutcome | null)
      const [fieldError, setFieldError] = React.useState(null as string | null)
      const [confirmId, setConfirmId] = React.useState(null as string | null)
      // Which rows are showing their probe tail and their `ssh -G` view.
      const [openRows, setOpenRows] = React.useState({} as Record<string, boolean>)
      // Resolved client configuration per target, kept by id so one row's answer
      // survives a re-render of the list.
      const [resolved, setResolved] = React.useState({} as Record<string, any>)
      const [settingsDraft, setSettingsDraft] = React.useState({ maxOutputBytes: '', remoteTimeoutMs: '', maxTransferBytes: '' })
      // The bounds as the running Host resolves them: a default and a cap per
      // ceiling, what is in force, and any correction its configuration needed.
      const [bounds, setBounds] = React.useState(null as Record<string, any> | null)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      /**
       * Fold one `list` answer into the page's state.
       * @param result - what the Host answered.
       * @param withDraft - whether to re-seed the parameter boxes, which only a
       *   first load or an explicit reload should do: the runtime refresh must not
       *   discard an override the reader is still typing.
       */
      function applyList(result: any, withDraft: boolean): void {
        setConnections(result.connections ?? [])
        setSettings(result.settings ?? null)
        if (withDraft) {
          setSettingsDraft({
            maxOutputBytes: String(result.settings?.maxOutputBytes ?? ''),
            remoteTimeoutMs: String(result.settings?.remoteTimeoutMs ?? ''),
            maxTransferBytes: String(result.settings?.maxTransferBytes ?? ''),
          })
        }
        // Merge, not replace: a Host that predates the pool sends the old
        // `limits` shape, and the limits rows would print blanks over it.
        if (result.limits !== undefined) setLimits((current: typeof limits) => ({ ...current, ...result.limits }))
        setAskpass(result.askpass ?? 'ready')
        if (result.bounds !== undefined) setBounds(result.bounds)
        setPooling(result.pool !== undefined)
        if (result.pool !== undefined) setPool(result.pool)
        setSpill(result.spill ?? null)
        setTemp(result.temp ?? null)
        setModern(result.askpass !== undefined)
        setProbing(result.probing ?? 0)
        setFailure(null)
      }

      /**
       * Re-read the whole page state from the Host.
       * @param withDraft - whether the parameter boxes follow the read too.
       * @returns resolution once the state landed or the failure was recorded.
       */
      async function load(withDraft: boolean = true): Promise<void> {
        try {
          const result = await rpc('list')
          if (!alive.current) return
          applyList(result, withDraft)
        } catch (error: unknown) {
          if (!alive.current) return
          setFailure(toFailure(error))
        } finally {
          if (alive.current) setLoading(false)
        }
      }

      React.useEffect(() => {
        void load()
        // One read on mount; every later refresh is driven by an explicit action.
      }, [])

      /**
       * Run one operation with the shared busy, failure, and notice handling.
       * @param key - what is running, so the right control is disabled.
       * @param run - the operation.
       * @param done - the success copy to announce.
       * @returns resolution once the operation settled.
       */
      async function act(key: string, run: () => Promise<void>, done?: string): Promise<void> {
        setBusy(key)
        setFailure(null)
        setNotice(null)
        try {
          await run()
          if (alive.current && done !== undefined) setNotice({ tone: 'ok', text: done })
        } catch (error: unknown) {
          if (!alive.current) return
          const next = toFailure(error)
          setFailure(next)
          setFieldError(typeof next.field === 'string' ? next.field : null)
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      /**
       * Re-read the live counts without touching what the reader is typing.
       * @returns resolution once the numbers landed.
       */
      async function refreshRuntime(): Promise<void> {
        setRefreshing(true)
        try {
          const result = await rpc('list')
          if (alive.current) applyList(result, false)
        } catch (error: unknown) {
          if (alive.current) setFailure(toFailure(error))
        } finally {
          if (alive.current) setRefreshing(false)
        }
      }

      /**
       * The parsed address of the edited draft, with a local complaint when it
       * cannot be read at all.
       * @returns the parsed parts, or `undefined` when the host is empty.
       */
      function parsedAddress(): { user: string; host: string; port: string } | undefined {
        const parsed = parseAddress(draft?.address ?? '')
        if (parsed.host === '' || /\s/u.test(parsed.host)) {
          setFieldError('address')
          return undefined
        }
        return parsed
      }

      /**
       * Edit one field of the draft, clearing a field error the reader is fixing.
       * @param key - the draft's field.
       * @param value - its new value; a checkbox writes a boolean.
       */
      function patchDraft(key: string, value: string | boolean): void {
        setDraft((current: any) => ({ ...current, [key]: value }))
        if (fieldError === key) setFieldError(null)
      }

      /**
       * Flip one secret field's reveal, read off the draft so the click cannot
       * race a keystroke.
       * @param key - the draft's `show…` field.
       */
      function toggleSecret(key: string): void {
        setDraft((current: any) => ({ ...current, [key]: !(current?.[key] === true) }))
      }

      /**
       * Save the edited draft as a new or updated target, storing any secret the
       * reader typed or cleared.
       * @returns resolution once it landed.
       */
      async function saveDraft(): Promise<void> {
        const parsed = parsedAddress()
        if (draft === null || parsed === undefined) return
        const payload = payloadOf(draft, parsed, modern, pooling)
        const secrets = modern ? secretsOf(draft) : undefined
        await act(draft.id ?? 'new', async () => {
          const result = await rpc('save', {
            connection: payload,
            ...(secrets === undefined ? {} : { secrets }),
          })
          if (!alive.current) return
          setConnections(result.connections ?? [])
          setDraft(null)
          setDraftProbe(null)
          setFieldError(null)
        }, t('saved'))
      }

      /**
       * Probe the draft before it is worth storing, using the typed secrets
       * transiently: a password that has not been saved still works here.
       * @returns resolution once the outcome landed.
       */
      async function testDraft(): Promise<void> {
        const parsed = parsedAddress()
        if (draft === null || parsed === undefined) return
        const payload = payloadOf(draft, parsed, modern, pooling)
        const secrets = modern ? secretsOf(draft) : undefined
        const draftBody = {
          host: payload.host,
          ...(payload.user === undefined ? {} : { user: payload.user }),
          ...(payload.port === undefined ? {} : { port: payload.port }),
          ...(payload.identityFile === undefined ? {} : { identityFile: payload.identityFile }),
          ...(payload.proxyJump === undefined ? {} : { proxyJump: payload.proxyJump }),
          ...(payload.extraArgs === undefined ? {} : { extraArgs: payload.extraArgs }),
          ...(modern ? { auth: payload.auth ?? 'key' } : {}),
          ...(payload.pool === undefined ? {} : { pool: payload.pool }),
        }
        const secretBody: Record<string, unknown> = {}
        if (typeof secrets?.passphrase === 'string') secretBody.passphrase = secrets.passphrase
        else if (draft.hadPassphrase && !draft.clearPassphrase) secretBody.passphrase = undefined
        if (typeof secrets?.password === 'string') secretBody.password = secrets.password
        else if (draft.hadPassword && !draft.clearPassword) secretBody.password = undefined
        // An unsaved form can only probe a secret it holds itself: a stored
        // secret belongs to a saved id, so the typed value is the only source.
        await act('draftProbe', async () => {
          const result = await rpc('probe', {
            draft: draftBody,
            ...(Object.keys(secretBody).length === 0 ? {} : { secrets: secretBody }),
          })
          if (alive.current) setDraftProbe(result.probe ?? null)
        })
      }

      /**
       * Probe one stored target and fold the fresh result into the list. The row
       * opens itself on a failure so the answer's own words arrive with the badge.
       * @param record - the stored target.
       * @returns resolution once the row updated.
       */
      async function testOne(record: ConnectionView): Promise<void> {
        await act(`probe:${record.id}`, async () => {
          const result = await rpc('probe', { id: record.id })
          if (!alive.current) return
          const fresh: ConnectionView[] = result.connections ?? []
          setConnections(fresh)
          const landed = fresh.find(row => row.id === record.id)
          if (landed?.lastProbe !== undefined && STATUS_TONE[landed.lastProbe.status] !== 'ok') {
            setOpenRows((current: Record<string, boolean>) => ({ ...current, [record.id]: true }))
          }
        })
      }

      /**
       * Probe the stored targets in one round.
       * @returns resolution once the round landed.
       */
      async function testAll(): Promise<void> {
        await act('probeAll', async () => {
          const result = await rpc('probeAll')
          if (!alive.current) return
          setConnections(result.connections ?? [])
          if (typeof result.skipped === 'number' && result.skipped > 0) {
            setNotice({ tone: 'warn', text: format(t('listSkipped'), { probed: String(result.probed ?? 0), skipped: String(result.skipped) }) })
          }
        })
      }

      /**
       * Delete one stored target and forget its secrets.
       * @param record - the stored target.
       * @returns resolution once the row disappeared.
       */
      async function remove(record: ConnectionView): Promise<void> {
        await act(`remove:${record.id}`, async () => {
          const result = await rpc('remove', { id: record.id })
          if (!alive.current) return
          setConnections(result.connections ?? [])
          setConfirmId(null)
          if (draft?.id === record.id) {
            setDraft(null)
            setDraftProbe(null)
          }
          setNotice({ tone: 'ok', text: result.orphanSecrets === true ? t('removedOrphan') : t('removed') })
        })
      }

      /** The three parameter boxes as the page last read them, for the dirty test. */
      const storedCeilings = {
        remoteTimeoutMs: String(settings?.remoteTimeoutMs ?? ''),
        maxOutputBytes: String(settings?.maxOutputBytes ?? ''),
        maxTransferBytes: String(settings?.maxTransferBytes ?? ''),
      }
      const dirty = settings !== null && (
        settingsDraft.remoteTimeoutMs !== storedCeilings.remoteTimeoutMs
        || settingsDraft.maxOutputBytes !== storedCeilings.maxOutputBytes
        || settingsDraft.maxTransferBytes !== storedCeilings.maxTransferBytes
      )
      // A box that cannot mean a ceiling is reported where it was typed, and keeps
      // the save button down until it is fixed or emptied. Sending it anyway is what
      // used to answer `Saved.` about a number the Host never saw.
      const badCeilings = ['remoteTimeoutMs', 'maxOutputBytes', 'maxTransferBytes']
        .filter(key => readCeiling(String((settingsDraft as any)[key] ?? '')).at === 'bad')

      /**
       * Persist the shared client settings.
       * @returns resolution once the new values landed.
       */
      async function saveSettings(): Promise<void> {
        if (badCeilings.length > 0) return
        // An empty box is a choice, not a no-op: it clears this profile's override so
        // the configured default applies again.
        const body: Record<string, number | null> = {}
        for (const key of Object.keys(storedCeilings)) {
          const read = readCeiling(String((settingsDraft as any)[key] ?? ''))
          if (read.at === 'clear') body[key] = null
          else if (read.at === 'set') body[key] = read.value
        }
        await act('settings', async () => {
          const result = await rpc('configUpdate', { settings: body })
          if (!alive.current) return
          setSettings(result.settings ?? null)
          if (result.settings !== undefined) {
            setSettingsDraft({
              maxOutputBytes: String(result.settings.maxOutputBytes ?? ''),
              remoteTimeoutMs: String(result.settings.remoteTimeoutMs ?? ''),
              maxTransferBytes: String(result.settings.maxTransferBytes ?? ''),
            })
          }
          // The resolved numbers move with the save: a value the cap pulled down has
          // to show up in the card, not just in what was typed. A Host that answers
          // with the pre-`bounds` shape only sends the effective set, so that half is
          // folded in rather than replacing the card.
          if (result.bounds !== undefined) setBounds(result.bounds)
          else if (result.effective !== undefined) {
            setBounds((current: any) => (current === null ? current : { ...current, effective: result.effective }))
          }
        }, t('settingsSaved'))
      }

      /**
       * Copy one target's diagnostics to the clipboard.
       * @param record - the stored target.
       * @returns resolution once the browser accepted the write.
       */
      async function copyDiagnostics(record: ConnectionView): Promise<void> {
        const payload = JSON.stringify({
          id: record.id,
          label: record.label,
          address: addressOf(record),
          auth: record.auth,
          ...(record.identityFile === undefined ? {} : { identityFile: record.identityFile }),
          ...(record.proxyJump === undefined ? {} : { proxyJump: record.proxyJump }),
          ...(record.extraArgs === undefined ? {} : { extraArgs: record.extraArgs }),
          ...(record.lastProbe === undefined ? {} : { lastProbe: record.lastProbe }),
          secrets: record.secrets,
        }, null, 2)
        const clipboard = typeof navigator === 'object' && navigator !== undefined ? navigator.clipboard : undefined
        if (clipboard === undefined) {
          setNotice({ tone: 'warn', text: t('copyFailed') })
          return
        }
        try {
          await clipboard.writeText(payload)
          if (alive.current) setNotice({ tone: 'ok', text: t('copied') })
        } catch {
          if (alive.current) setNotice({ tone: 'warn', text: t('copyFailed') })
        }
      }

      /**
       * Ask the Host what the OpenSSH client resolves this target to.
       * @param record - the stored target.
       * @returns resolution once the answer landed or the failure is stored.
       */
      async function resolveTarget(record: ConnectionView): Promise<void> {
        const key = record.id
        if (resolved[key] !== undefined) {
          setResolved((current: Record<string, any>) => {
            const next = { ...current }
            delete next[key]
            return next
          })
          return
        }
        try {
          const result = await rpc('resolve', { target: record.id })
          setResolved((current: Record<string, any>) => ({ ...current, [key]: result }))
        } catch (error: unknown) {
          setResolved((current: Record<string, any>) => ({ ...current, [key]: { ok: false, message: (error as any)?.message ?? t('resolveFailed') } }))
        }
      }

      const storageFailure = failure !== null && failure.code === 'storage-error'
      const defaultId = defaultTargetId(connections)

      const header = h('div', { class: 'dshssh-field' },
        h('h2', { class: 'dshssh-title' }, t('title')),
        h('p', { class: 'dshssh-intro' }, t('intro')),
      )

      const noticeRegion = failure === null
        ? (notice === null ? null : h(Notice, { tone: notice.tone, text: notice.text }))
        : h(Notice, {
          tone: failure.code === 'bad-input' ? 'warn' : 'err',
          text: failure.message,
          ...(FAILURE_HINT_KEY[failure.code] === undefined ? {} : { hint: t(FAILURE_HINT_KEY[failure.code] ?? '') }),
        })

      /** A standing warning when this Host cannot answer a prompt for a secret. */
      const askpassNotice = askpass === 'unavailable'
        ? h(Notice, { tone: 'warn', text: t('askpassUnavailable') })
        : null

      /**
       * Open the form for one target, or for a new one, with the state that goes
       * with a fresh edit: no stale probe under the draft and no stale field error.
       * @param record - the stored target, or `null` to add one.
       */
      function startEdit(record: ConnectionView | null): void {
        setDraft(draftOf(record))
        setDraftProbe(record === null ? null : (record.lastProbe ?? null))
        setFieldError(null)
        setFailure(null)
      }

      const targetsCard = h('section', { class: 'dshssh-card' },
        h('div', { class: 'dshssh-card-head' },
          h('div', { class: 'dshssh-card-headline' },
            h('h3', { class: 'dshssh-card-title' }, t('listTitle')),
            h('span', { class: 'dshssh-tertiary' }, format(t('listTotal'), { count: String(connections.length) })),
            probing > 0 ? Badge({ tone: 'idle', text: t('stRunning') }) : null,
          ),
          h('div', { class: 'dshssh-actions' },
            h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled: busy !== null || connections.length === 0 || storageFailure,
              onClick: () => { void testAll() },
            }, busy === 'probeAll' ? t('listProbing') : t('listProbeAll')),
            h('button', {
              class: 'dshssh-btn dshssh-btn-primary',
              type: 'button',
              disabled: busy !== null || draft !== null || storageFailure || connections.length >= limits.maxConnections,
              onClick: () => { startEdit(null) },
            }, connections.length >= limits.maxConnections ? t('listAddFull') : t('listAdd')),
          ),
        ),
        // The form opens above the list it belongs to: adding or editing is the
        // thing a reader came to do, and a form parked under a long list asks them
        // to scroll to the task they just pressed the button for.
        h(TargetFormView, {
          t,
          draft,
          busy,
          modern,
          pooling,
          fieldError,
          draftProbe,
          atLimit: draft !== null && draft.id === undefined && connections.length >= limits.maxConnections,
          count: connections.length,
          limit: limits.maxConnections,
          onPatch: patchDraft,
          onToggleSecret: toggleSecret,
          onSave: () => { void saveDraft() },
          onTestDraft: () => { void testDraft() },
          onCancel: () => {
            setDraft(null)
            setDraftProbe(null)
            setFieldError(null)
          },
        }),
        connections.length === 0 && !loading
          ? h('div', { class: 'dshssh-field' },
            h('p', { class: 'dshssh-card-title' }, t('listEmpty')),
            h('p', { class: 'dshssh-tertiary' }, t('listEmptyHint')),
          )
          : h('div', { class: 'dshssh-list' }, connections.map((record: ConnectionView) => h(TargetRowView, {
            key: record.id,
            t,
            record,
            busy,
            editing: draft?.id === record.id,
            confirming: confirmId === record.id,
            expanded: openRows[record.id] === true,
            isDefault: defaultId === record.id,
            answer: resolved[record.id],
            onTest: () => { void testOne(record) },
            onEdit: () => { startEdit(record) },
            onRemove: () => { void remove(record) },
            onStartConfirm: () => { setConfirmId(record.id) },
            onStopConfirm: () => { setConfirmId(null) },
            onToggleDetails: () => { setOpenRows((current: Record<string, boolean>) => ({ ...current, [record.id]: current[record.id] !== true })) },
            onResolve: () => { void resolveTarget(record) },
            onCopy: () => { void copyDiagnostics(record) },
          }))),
        loading && connections.length === 0 ? h('p', { class: 'dshssh-tertiary' }, t('listProbing')) : null,
      )

      const paramsCard = h(ClientParamsCardView, {
        t,
        bounds,
        settings,
        stored: settings ?? {},
        draft: settingsDraft,
        busy,
        loading,
        storageFailure,
        dirty,
        invalid: badCeilings.length > 0,
        onPatch: (key: string, value: string) => { setSettingsDraft((current: any) => ({ ...current, [key]: value })) },
        onSave: () => { void saveSettings() },
      })

      const runtimeCard = h(RuntimeCardView, {
        t,
        bounds,
        limits,
        pool,
        spill,
        temp,
        probing,
        pooling,
        busy,
        refreshing,
        legacy: !modern,
        onToggle: (event: any) => { if (event?.target?.open === true) void refreshRuntime() },
        onRefresh: () => { void refreshRuntime() },
      })

      return h('div', { class: 'dshssh-root' },
        h('style', {}, CSS),
        header,
        noticeRegion,
        askpassNotice,
        targetsCard,
        paramsCard,
        runtimeCard,
      )
    }

    return {
      /** The client services this module needs from the page. */
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries and the one page this plugin contributes, with
       * its navigation icon.
       * @param ctx - the browser plugin context.
       */
      apply(ctx: any): void {
        for (const language of Object.keys(DICT)) {
          ctx.effect(() => ctx.locale.register(NS, language, DICT[language]), `ssh: ${language} dictionary`)
        }
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'ssh',
          order: 25,
          label: () => ctx.locale.bind(NS)('nav'),
          locale: NS,
        }, SshSection)), 'ssh: settings section')
        ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'ssh',
        }, SshIcon)), 'ssh: settings section icon')
      },
    }
  },
})
