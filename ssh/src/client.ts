/**
 * SSH target manager — browser half, mounted as a Settings section.
 *
 * The web module table executes this file as a classic script, so everything
 * below the `window.__ModuleLoader__.load` call is the registered factory: the
 * only runtime import is `react`, taken from the page's baseline module table,
 * and the single top-level `import type` is erased by the compiler. Controls
 * and their stylesheet are local to this plugin, styled exclusively from
 * `--dsw-alias-*` and other host theme tokens, because a plugin must not require
 * another Harness client package as a module.
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
    /** Base of the tab ids this page owns: `<id>-<value>` and `<id>-<value>-panel`. */
    const TAB_BASE = 'dshssh-tabs'
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

    /** Browser-facing copy. Both baseline locales are required by the locale service. */
    const DICT: Record<string, Record<string, string>> = {
      en: {
        nav: 'Remote connections',
        title: 'Remote connections',
        intro: 'Named SSH targets this machine can reach, kept in this plugin\'s own storage so the page can edit them without touching the profile patch file. The plugin never reads or writes ~/.ssh/config and never adds a host key.',
        storedIn: 'Stored by the plugin in its own ssh_targets storage domain; passwords and passphrases live in the Harness credential store.',
        tabsLabel: 'Sections of this page',
        tabList: 'SSH targets',
        tabSettings: 'Client settings',
        settingsTitle: 'Client settings',
        settingsMaxOutput: 'Output ceiling (bytes)',
        settingsRemoteTimeout: 'Command timeout (ms)',
        settingsMaxTransfer: 'Transfer ceiling (bytes)',
        settingsSave: 'Save settings',
        settingsSaved: 'Saved.',
        boundsTitle: 'Fixed bounds',
        boundsTargets: 'Targets per profile',
        boundsOps: 'Remote operations at once',
        boundsMasters: 'Servers sharing a connection',
        boundsPersist: 'A shared connection idles out after',
        boundsPerRound: 'Targets per “Test all” round',
        boundsTimeout: 'Probe timeout is fixed at',
        boundsOutput: 'Output ceiling accepts',
        boundsRemoteTimeout: 'Command timeout accepts',
        boundsTransfer: 'Transfer ceiling accepts',
        poolOff: 'This Host could not prepare a private directory for control sockets, so every call dials its own connection: {reason}',
        listTitle: 'SSH targets',
        listCount: '{count} of {limit} saved',
        listAdd: 'New connection',
        listAddFull: 'Target limit reached',
        listProbeAll: 'Test all',
        listProbing: 'Testing…',
        listSkipped: 'Tested the first {probed}; {skipped} still untested.',
        listEmpty: 'No SSH targets yet',
        listEmptyHint: 'Add a host name or an existing OpenSSH host alias, then test it here.',
        listLoadFailed: 'The settings page could not reach the plugin on this Host.',
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
        hintTimeout: 'The probe ran out of time. Raise the probe timeout if this host is slow to answer.',
        hintBadInput: 'Check the highlighted field.',
        hintBusy: 'Too many probes are running. Wait for the current ones to finish.',
        hintStorage: 'The plugin could not read its stored connections. See the Host log for the storage failure.',
        hintSecret: 'The plugin could not reach the credential store for this secret.',
        hintInternal: 'The plugin reported an unexpected failure.',
      },
      zh: {
        nav: '远程连接',
        title: '远程连接',
        intro: '保存「本机能够连上的命名 SSH 目标」。清单存在插件自己的存储里，页面改它不会动 profile 的 patch 文件；插件从不读写 ~/.ssh/config，也不会替你写入主机密钥。',
        storedIn: '清单与参数存在插件自己的 ssh_targets 存储域；密码与口令存在 Harness 凭据库里。',
        tabsLabel: '本页面内的分区',
        tabList: 'SSH 目标清单',
        tabSettings: '客户端参数',
        settingsTitle: '客户端参数',
        settingsMaxOutput: '输出上限（字节）',
        settingsRemoteTimeout: '命令超时（毫秒）',
        settingsMaxTransfer: '传输上限（字节）',
        settingsSave: '保存参数',
        settingsSaved: '已保存。',
        boundsTitle: '固定边界',
        boundsTargets: '每个 profile 可存的目标数',
        boundsOps: '同时在跑的远程操作数',
        boundsMasters: '共用一条连接的目标数上限',
        boundsPersist: '共享连接空闲多久后断开',
        boundsPerRound: '「全部测试」单轮覆盖的目标数',
        boundsTimeout: '探测超时固定为',
        boundsOutput: '输出上限可填范围',
        boundsRemoteTimeout: '命令超时可填范围',
        boundsTransfer: '传输上限可填范围',
        poolOff: '这台 Host 没能准备好放控制套接字的私有目录，所以每次调用都自己拨号：{reason}',
        listTitle: 'SSH 目标清单',
        listCount: '已保存 {count} / {limit}',
        listAdd: '新建连接',
        listAddFull: '已达清单上限',
        listProbeAll: '全部测试',
        listProbing: '测试中…',
        listSkipped: '本轮测试了前 {probed} 条，{skipped} 条未测。',
        listEmpty: '还没有 SSH 目标',
        listEmptyHint: '先添加一个主机名或已有的 OpenSSH 别名，再在这里测试。',
        listLoadFailed: '设置页无法连到本机上的这个插件。',
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
        hintTimeout: '探测用时耗尽。若这台主机响应较慢，请调大探测超时。',
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

    const CSS = `
.dshssh-root{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}
.dshssh-title{font-size:15px;font-weight:600}
.dshssh-intro{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dshssh-card{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dshssh-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dshssh-card-title{font-size:13px;font-weight:600}
.dshssh-muted{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshssh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 12px}
.dshssh-field{display:flex;flex-direction:column;gap:4px}
.dshssh-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshssh-input,.dshssh-textarea{box-sizing:border-box;width:100%;padding:6px 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px}
.dshssh-textarea{min-height:64px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshssh-input:focus-visible,.dshssh-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshssh-input-inline{display:flex;align-items:stretch;gap:6px}
.dshssh-input-inline .dshssh-input{flex:1 1 auto}
.dshssh-eye{flex:0 0 auto;padding:0 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;cursor:pointer}
.dshssh-eye:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dshssh-eye:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshssh-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshssh-list{display:flex;flex-direction:column;gap:8px}
.dshssh-row{display:flex;align-items:flex-start;gap:10px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dshssh-row-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}
.dshssh-row-title{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.dshssh-row-meta{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshssh-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshssh-chip{display:inline-flex;align-items:center;padding:1px 7px;font-size:11.5px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.dshssh-chip[data-tone="secret"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dshssh-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;flex-wrap:wrap}
.dshssh-btn{padding:5px 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;cursor:pointer}
.dshssh-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dshssh-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshssh-btn:disabled{opacity:.5;cursor:default}
.dshssh-btn-primary{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-color:transparent}
.dshssh-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dshssh-badge{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;font-size:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-state-idle-primary)}
.dshssh-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.dshssh-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.dshssh-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dshssh-badge[data-tone="err"]{color:var(--dsw-alias-state-error-primary)}
.dshssh-notice{display:flex;flex-direction:column;gap:6px;padding:8px 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshssh-notice[data-tone="err"]{border-color:var(--dsw-alias-state-error-primary)}
.dshssh-notice[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary)}
.dshssh-notice[data-tone="ok"]{border-color:var(--dsw-alias-state-success-primary)}
.dshssh-detail{margin:0;padding:8px;max-height:180px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px}
.dshssh-form{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dshssh-foot{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.dshssh-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dshssh-disclose{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:10px}
.dshssh-disclose>summary{font-size:12px;font-weight:600;cursor:pointer;color:var(--dsw-alias-label-secondary);list-style:none}
.dshssh-disclose>summary::-webkit-details-marker{display:none}
.dshssh-disclose>summary::before{content:"▸ ";color:var(--dsw-alias-label-secondary)}
.dshssh-disclose[open]>summary::before{content:"▾ "}
.dshssh-disclose[open]>summary{color:var(--dsw-alias-label-primary)}
.dshssh-seg{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);justify-self:start}
.dshssh-seg-indicator{position:absolute;top:4px;left:4px;width:calc((100% - 8px - 2px * (var(--dshssh-segment-count) - 1)) / var(--dshssh-segment-count));height:calc(100% - 8px);border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);transform:translateX(calc(var(--dshssh-segment-index) * (100% + 2px)));transition:transform 160ms ease;pointer-events:none}
.dshssh-seg-item{box-sizing:border-box;position:relative;z-index:1;height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer;color:var(--dsw-alias-label-secondary);transition:color 120ms ease}
.dshssh-seg-item[aria-selected="true"],.dshssh-seg-item[aria-checked="true"]{color:var(--dsw-alias-label-primary)}
.dshssh-seg-item:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshssh-seg-item:disabled{cursor:default;opacity:.4}
.dshssh-seg-item:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dshssh-resolve{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}
.dshssh-hidden{display:none}
.dshssh-panel{display:flex;flex-direction:column;gap:16px}
.dshssh-panel:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshssh-bounds{display:flex;flex-direction:column;gap:7px;margin:0}
.dshssh-bound{display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:6px}
.dshssh-bound dt{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshssh-bound dd{margin:0;font-size:12px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
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
      }
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

    /** One state dot and its label. */
    function Badge(props: { tone: string; text: string }): any {
      return h('span', { class: 'dshssh-badge', 'data-tone': props.tone }, props.text)
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
        props.hint === undefined ? null : h('span', { class: 'dshssh-muted' }, props.hint),
        props.errorText === undefined ? null : h('span', { class: 'dshssh-error' }, props.errorText),
      )
    }

    /** A labelled multi-line input. */
    function TextAreaField(props: { label: string; value: string; onChange: (value: string) => void; hint?: string; disabled?: boolean }): any {
      return h('label', { class: 'dshssh-field' },
        h('span', { class: 'dshssh-label' }, props.label),
        h('textarea', {
          class: 'dshssh-textarea',
          value: props.value,
          rows: 3,
          spellcheck: 'false',
          disabled: props.disabled === true,
          onChange: (event: any) => { props.onChange(String(event.target.value ?? '')) },
        }),
        props.hint === undefined ? null : h('span', { class: 'dshssh-muted' }, props.hint),
      )
    }

    /** A status line the page announces politely. */
    function Notice(props: { tone: string; text: string; hint?: string }): any {
      return h('div', { class: 'dshssh-notice', 'data-tone': props.tone, role: 'status', 'aria-live': 'polite' },
        h('span', {}, props.text),
        props.hint === undefined ? null : h('span', { class: 'dshssh-muted' }, props.hint),
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
     * The page this plugin contributes.
     *
     * Two tabs share one page — the target list and the client settings — over
     * one state object and one `list` read, because the settings shell gives a
     * plugin exactly one navigation row per section.
     * @param props - seat props: the localized reader and the panel `close`.
     * @returns the rendered page.
     */
    function SshSection(props: any): any {
      const t = translator(props)
      const [tab, setTab] = React.useState('list')
      const [connections, setConnections] = React.useState([] as ConnectionView[])
      const [settings, setSettings] = React.useState(null as { maxOutputBytes: number; remoteTimeoutMs: number; maxTransferBytes: number } | null)
      const [limits, setLimits] = React.useState({ maxConnections: 64, concurrentOps: 16, maxLiveMasters: 8, controlPersistSeconds: 300, probeAllLimit: 12, probeTimeoutMs: 10000, remoteTimeoutMinMs: 1000, remoteTimeoutMaxMs: 300000, outputMinBytes: 1024, outputMaxBytes: 4194304, transferMinBytes: 1024, transferMaxBytes: 536870912 })
      const [askpass, setAskpass] = React.useState('ready')
      // Whether the loaded Host knows about connection sharing at all. A package
      // swapped in place keeps the previous Host module until the restart, and its
      // schema would refuse a `pool` field the new page is ready to send.
      const [pooling, setPooling] = React.useState(false)
      const [pool, setPool] = React.useState(null as { ready: boolean; liveMasters: number; failure?: string } | null)
      // Whether the loaded Host half knows about authentication modes at all:
      // an in-place package swap needs a Host restart, and the page keeps working
      // without the secret controls until then.
      const [modern, setModern] = React.useState(false)
      const [probing, setProbing] = React.useState(0)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(null as string | null)
      const [failure, setFailure] = React.useState(null as SshFailure | null)
      const [notice, setNotice] = React.useState(null as { tone: string; text: string } | null)
      const [draft, setDraft] = React.useState(null as any)
      const [draftProbe, setDraftProbe] = React.useState(null as ProbeOutcome | null)
      const [fieldError, setFieldError] = React.useState(null as string | null)
      const [confirmId, setConfirmId] = React.useState(null as string | null)
      // Resolved client configuration per target, kept by id so one row's answer
      // survives a re-render of the list.
      const [resolved, setResolved] = React.useState({} as Record<string, any>)
      const [settingsDraft, setSettingsDraft] = React.useState({ maxOutputBytes: '', remoteTimeoutMs: '', maxTransferBytes: '' })
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      /**
       * Re-read the whole page state from the Host.
       * @returns resolution once the state landed or the failure was recorded.
       */
      async function load(): Promise<void> {
        try {
          const result = await rpc('list')
          if (!alive.current) return
          setConnections(result.connections ?? [])
          setSettings(result.settings ?? null)
          setSettingsDraft({
            maxOutputBytes: String(result.settings?.maxOutputBytes ?? ''),
            remoteTimeoutMs: String(result.settings?.remoteTimeoutMs ?? ''),
            maxTransferBytes: String(result.settings?.maxTransferBytes ?? ''),
          })
          // Merge, not replace: a Host that predates the pool sends the old
          // `limits` shape, and the bounds rows would print blanks over it.
          if (result.limits !== undefined) setLimits((current: typeof limits) => ({ ...current, ...result.limits }))
          setAskpass(result.askpass ?? 'ready')
          setPooling(result.pool !== undefined)
          if (result.pool !== undefined) setPool(result.pool)
          setModern(result.askpass !== undefined)
          setProbing(result.probing ?? 0)
          setFailure(null)
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
       * Probe one stored target and fold the fresh result into the list.
       * @param record - the stored target.
       * @returns resolution once the row updated.
       */
      async function testOne(record: ConnectionView): Promise<void> {
        await act(`probe:${record.id}`, async () => {
          const result = await rpc('probe', { id: record.id })
          if (!alive.current) return
          setConnections(result.connections ?? [])
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

      /**
       * Persist the shared client settings.
       * @returns resolution once the new values landed.
       */
      async function saveSettings(): Promise<void> {
        const whole = (value: string): number | undefined => {
          const trimmed = (value ?? '').trim()
          return trimmed === '' ? undefined : Number(trimmed)
        }
        await act('settings', async () => {
          const output = whole(settingsDraft.maxOutputBytes)
          const remote = whole(settingsDraft.remoteTimeoutMs)
          const transfer = whole(settingsDraft.maxTransferBytes)
          const result = await rpc('configUpdate', {
            settings: {
              ...(output === undefined || Number.isNaN(output) ? {} : { maxOutputBytes: output }),
              ...(remote === undefined || Number.isNaN(remote) ? {} : { remoteTimeoutMs: remote }),
              ...(transfer === undefined || Number.isNaN(transfer) ? {} : { maxTransferBytes: transfer }),
            },
          })
          if (!alive.current) return
          setSettings(result.settings ?? null)
          if (result.settings !== undefined) {
            setSettingsDraft({
              maxOutputBytes: String(result.settings.maxOutputBytes ?? ''),
              remoteTimeoutMs: String(result.settings.remoteTimeoutMs ?? ''),
              maxTransferBytes: String(result.settings.maxTransferBytes ?? ''),
            })
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
       * Render one probe result: when it ran, how long it took, the fix-up hint
       * for its status, and the captured output tail.
       * @param outcome - the stored or freshly probed result.
       * @returns the result region, or `null` when nothing was probed yet.
       */
      function probeRegion(outcome: ProbeOutcome | null | undefined): any {
        if (outcome === null || outcome === undefined) return null
        const hintKey = STATUS_HINT_KEY[outcome.status]
        return h('div', { class: 'dshssh-field' },
          h('span', { class: 'dshssh-row-meta' },
            format(t('asOf'), { at: when(outcome.at) }),
            outcome.durationMs === undefined
              ? null
              : h('span', { class: 'dshssh-muted' }, ` · ${format(t('took'), { ms: String(outcome.durationMs) })}`),
          ),
          hintKey === undefined ? null : h('span', { class: 'dshssh-muted' }, t(hintKey)),
          outcome.detail === undefined ? null : h('pre', { class: 'dshssh-detail' }, outcome.detail),
        )
      }

      /**
       * Label-and-value rows for one resolved configuration, skipping what the
       * client did not report.
       * @param config - the parsed keys.
       * @param record - the saved row, for the fallback address line.
       * @returns the definition-list children.
       */
      function resolveRows(config: any, record: ConnectionView): any[] {
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

      /** One row of the stored list. */
      function rowOf(record: ConnectionView): any {
        const testing = busy === `probe:${record.id}`
        const removing = busy === `remove:${record.id}`
        const editing = draft?.id === record.id
        const chips: any[] = record.auth === undefined ? [] : [h('span', { class: 'dshssh-chip', key: 'auth' }, t(AUTH_LABEL[record.auth] ?? 'authKey'))]
        if (record.secrets?.passphrase === true) chips.push(h('span', { class: 'dshssh-chip', 'data-tone': 'secret', key: 'passphrase' }, t('passphraseSet')))
        if (record.secrets?.password === true) chips.push(h('span', { class: 'dshssh-chip', 'data-tone': 'secret', key: 'password' }, t('secretSet')))
        if (record.secrets?.root === true) chips.push(h('span', { class: 'dshssh-chip', 'data-tone': 'secret', key: 'root' }, t('rootSet')))
        if (record.proxyJump !== undefined) chips.push(h('span', { class: 'dshssh-chip', key: 'jump' }, `via ${record.proxyJump}`))
        return h('div', { class: 'dshssh-row', key: record.id },
          h('div', { class: 'dshssh-row-main' },
            h('div', { class: 'dshssh-row-title' }, record.label),
            h('div', { class: 'dshssh-row-meta' }, addressOf(record)),
            h('div', { class: 'dshssh-chips' }, ...chips),
            record.note === undefined ? null : h('div', { class: 'dshssh-muted' }, record.note),
            resolved[record.id] === undefined ? null : h('div', { class: 'dshssh-resolve' },
              h('span', { class: 'dshssh-row-title' }, t('resolveTitle')),
              h('div', { class: 'dshssh-chips' },
                h('span', {
                  class: 'dshssh-chip',
                  'data-tone': resolved[record.id].differs === true ? 'secret' : '',
                }, resolved[record.id].differs === true ? t('resolveDiffers') : t('resolveSame')),
              ),
              resolved[record.id].ok === false
                ? h('p', { class: 'dshssh-error' }, resolved[record.id].message ?? t('resolveFailed'))
                : h('dl', { class: 'dshssh-bounds' }, ...resolveRows(resolved[record.id].resolved ?? {}, record)),
              h('p', { class: 'dshssh-muted' }, t('resolveHint')),
              typeof resolved[record.id].text === 'string' ? h('details', {},
                h('summary', { class: 'dshssh-muted' }, t('resolveRaw')),
                h('pre', { class: 'dshssh-detail' }, String(resolved[record.id].text)),
              ) : null,
            ),
            testing
              ? h(Badge, { tone: 'idle', text: t('stRunning') })
              : h('div', { class: 'dshssh-field' },
                h(Badge, {
                  tone: record.lastProbe === undefined ? 'idle' : (STATUS_TONE[record.lastProbe.status] ?? 'idle'),
                  text: record.lastProbe === undefined ? t('stIdle') : t(STATUS_KEY[record.lastProbe.status] ?? 'stFailed'),
                }),
                probeRegion(record.lastProbe),
              ),
          ),
          h('div', { class: 'dshssh-actions' },
            h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled: busy !== null,
              onClick: () => { void testOne(record) },
            }, t('test')),
            h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled: busy !== null || editing,
              onClick: () => {
                setDraft(draftOf(record))
                setDraftProbe(record.lastProbe ?? null)
                setFieldError(null)
                setFailure(null)
              },
            }, t('edit')),
            confirmId === record.id
              ? h('span', { class: 'dshssh-actions' },
                h('button', {
                  class: 'dshssh-btn dshssh-btn-danger',
                  type: 'button',
                  disabled: removing,
                  onClick: () => { void remove(record) },
                }, removing ? t('saving') : t('confirmRemove')),
                h('button', {
                  class: 'dshssh-btn',
                  type: 'button',
                  disabled: removing,
                  onClick: () => { setConfirmId(null) },
                }, t('cancel')),
              )
              : h('button', {
                class: 'dshssh-btn dshssh-btn-danger',
                type: 'button',
                disabled: busy !== null,
                onClick: () => { setConfirmId(record.id) },
              }, t('remove')),
            h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled: busy !== null,
              onClick: () => { void resolveTarget(record) },
            }, t('resolve')),
            record.lastProbe === undefined ? null : h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled: busy !== null,
              onClick: () => { void copyDiagnostics(record) },
            }, t('copyDetail')),
          ),
        )
      }

      /**
       * One secret field with its stored-state affordances: the placeholder says
       * what is already kept, the checkbox forgets it, and the typed value is
       * what a probe or a save will write.
       */
      function secretField(props: {
        label: string
        value: string
        had: boolean
        cleared: boolean
        shown: boolean
        disabled: boolean
        errorText?: string
        onChange: (value: string) => void
        onToggleClear: (checked: boolean) => void
        onToggleShow: () => void
      }): any {
        return h('div', { class: 'dshssh-field' },
          h(TextField, {
            label: props.label,
            value: props.value,
            disabled: props.disabled,
            errorText: props.errorText,
            placeholder: props.had && !props.cleared ? t('secretStored') : '',
            reveal: {
              shown: props.shown,
              onToggle: props.onToggleShow,
              showLabel: t('showSecret'),
              hideLabel: t('hideSecret'),
            },
            onChange: props.onChange,
          }),
          props.had ? h('label', { class: 'dshssh-check' },
            h('input', {
              type: 'checkbox',
              checked: props.cleared,
              disabled: props.disabled,
              onChange: (event: any) => { props.onToggleClear(event.target.checked === true) },
            }),
            h('span', {}, t('secretClear')),
          ) : null,
        )
      }

      /** The new/edit form: one address, one mode choice, the secrets it needs. */
      function formRegion(): any {
        if (draft === null) return null
        const mode: AuthMode = draft.auth ?? 'key'
        const locked = busy !== null
        const atLimit = draft.id === undefined && connections.length >= limits.maxConnections
        const disabled = locked || atLimit
        const patch = (key: string) => (value: string): void => {
          setDraft((current: any) => ({ ...current, [key]: value }))
          if (fieldError === key) setFieldError(null)
        }
        const showAuth = modern
        const showKey = showAuth && mode === 'key'
        const showKeyPassphrase = showAuth && mode === 'key'
        const showPassword = showAuth && mode === 'password'
        const parsed = parseAddress(draft.address ?? '')
        const summary = parsed.host === '' ? '' : `${parsed.user === '' ? '' : `${parsed.user}@`}${parsed.host}${parsed.port === '' ? '' : `:${parsed.port}`}`
        return h('div', { class: 'dshssh-form' },
          h('div', { class: 'dshssh-card-title' }, draft.id === undefined ? t('newTitle') : t('editTitle')),
          h(TextField, {
            label: t('addrLabel'),
            value: draft.address ?? '',
            placeholder: t('addrPlaceholder'),
            hint: summary === '' ? t('addrHint') : `${t('addrHint')} → ${summary}`,
            disabled,
            errorText: fieldError === 'address' || fieldError === 'host' ? t('addrBad') : undefined,
            onChange: (value: string) => {
              setDraft((current: any) => ({ ...current, address: value }))
              if (fieldError === 'address' || fieldError === 'host') setFieldError(null)
            },
          }),
          showAuth ? null : h('p', { class: 'dshssh-muted' }, t('legacyHost')),
          h('div', { class: showAuth ? 'dshssh-field' : 'dshssh-hidden' },
            h(SshSegment, {
              id: AUTH_BASE,
              role: 'radio',
              value: mode,
              groupLabel: t('authTitle'),
              disabled,
              options: AUTH_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey), hint: t(option.hintKey), disabled })),
              onChange: (next: string) => { setDraft((current: any) => ({ ...current, auth: next })) },
            }),
            h('span', { class: 'dshssh-muted' }, t(AUTH_OPTIONS.find(option => option.value === mode)?.hintKey ?? 'authKeyHint')),
          ),
          showKey ? h('div', { class: 'dshssh-grid' },
            h(TextField, {
              label: `${t('keyFileLabel')} (${t('fOptional')})`,
              value: draft.identityFile ?? '',
              disabled,
              errorText: fieldError === 'identityFile' ? t('hintBadInput') : undefined,
              onChange: patch('identityFile'),
            }),
          ) : null,
          showKeyPassphrase ? h(secretField, {
            label: `${t('passphraseLabel')} (${t('fOptional')})`,
            value: draft.passphrase ?? '',
            had: draft.hadPassphrase === true,
            cleared: draft.clearPassphrase === true,
            shown: draft.showPassphrase === true,
            disabled,
            errorText: fieldError === 'passphrase' ? t('hintBadInput') : undefined,
            onChange: patch('passphrase'),
            onToggleClear: (checked: boolean) => { setDraft((current: any) => ({ ...current, clearPassphrase: checked })) },
            onToggleShow: () => { setDraft((current: any) => ({ ...current, showPassphrase: !(current.showPassphrase === true) })) },
          }) : null,
          showPassword ? h(secretField, {
            label: t('passwordLabel'),
            value: draft.password ?? '',
            had: draft.hadPassword === true,
            cleared: draft.clearPassword === true,
            shown: draft.showPassword === true,
            disabled,
            errorText: fieldError === 'password' ? t('hintBadInput') : undefined,
            onChange: patch('password'),
            onToggleClear: (checked: boolean) => { setDraft((current: any) => ({ ...current, clearPassword: checked })) },
            onToggleShow: () => { setDraft((current: any) => ({ ...current, showPassword: !(current.showPassword === true) })) },
          }) : null,
          showAuth ? h(secretField, {
            label: `${t('rootLabel')} (${t('fOptional')})`,
            value: draft.root ?? '',
            had: draft.hadRoot === true,
            cleared: draft.clearRoot === true,
            shown: draft.showRoot === true,
            disabled,
            errorText: fieldError === 'root' ? t('hintBadInput') : undefined,
            onChange: patch('root'),
            onToggleClear: (checked: boolean) => { setDraft((current: any) => ({ ...current, clearRoot: checked })) },
            onToggleShow: () => { setDraft((current: any) => ({ ...current, showRoot: !(current.showRoot === true) })) },
          }) : null,
          h(TextField, {
            label: `${t('labelField')} (${t('fOptional')})`,
            value: draft.label ?? '',
            placeholder: summary,
            hint: t('labelHint'),
            disabled,
            errorText: fieldError === 'label' ? t('hintBadInput') : undefined,
            onChange: patch('label'),
          }),
          h('details', { class: 'dshssh-disclose' },
            h('summary', {}, t('advanced')),
            h('p', { class: 'dshssh-muted' }, t('advancedHint')),
            h('div', { class: 'dshssh-grid' },
              h(TextField, {
                label: `${t('fProxy')} (${t('fOptional')})`,
                value: draft.proxyJump ?? '',
                disabled,
                errorText: fieldError === 'proxyJump' ? t('hintBadInput') : undefined,
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
            pooling ? h('div', { class: 'dshssh-field' },
              h('label', { class: 'dshssh-check' },
                h('input', {
                  type: 'checkbox',
                  checked: draft.pool !== 'off',
                  disabled,
                  onChange: (event: any) => { setDraft((current: any) => ({ ...current, pool: event.target.checked === true ? 'on' : 'off' })) },
                }),
                h('span', {}, t('fPool')),
              ),
              h('p', { class: 'dshssh-muted' }, t('fPoolHint')),
            ) : null,
          ),
          atLimit ? h('span', { class: 'dshssh-error' }, format(t('listCount'), { count: String(connections.length), limit: String(limits.maxConnections) })) : null,
          draftProbe === null ? null : h('div', { class: 'dshssh-field' },
            h(Badge, {
              tone: STATUS_TONE[draftProbe.status] ?? 'idle',
              text: t(STATUS_KEY[draftProbe.status] ?? 'stFailed'),
            }),
            probeRegion(draftProbe),
          ),
          h('div', { class: 'dshssh-foot' },
            h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled,
              onClick: () => { void testDraft() },
            }, t('testDraft')),
            h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled,
              onClick: () => {
                setDraft(null)
                setDraftProbe(null)
                setFieldError(null)
              },
            }, t('cancel')),
            h('button', {
              class: 'dshssh-btn dshssh-btn-primary',
              type: 'button',
              disabled: disabled || atLimit,
              onClick: () => { void saveDraft() },
            }, busy === 'new' || busy === draft.id ? t('saving') : t('save')),
          ),
        )
      }

      const storageFailure = failure !== null && failure.code === 'storage-error'

      const header = h('div', { class: 'dshssh-field' },
        h('h2', { class: 'dshssh-title' }, t('title')),
        h('p', { class: 'dshssh-intro' }, t('intro')),
        h('p', { class: 'dshssh-muted' }, t('storedIn')),
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

      const settingsCard = h('section', { class: 'dshssh-card' },
        h('div', { class: 'dshssh-card-head' },
          h('h3', { class: 'dshssh-card-title' }, t('settingsTitle')),
          h('button', {
            class: 'dshssh-btn',
            type: 'button',
            disabled: busy !== null || settings === null || storageFailure,
            onClick: () => { void saveSettings() },
          }, busy === 'settings' ? t('saving') : t('settingsSave')),
        ),
        h('div', { class: 'dshssh-grid' },
          h(TextField, { label: t('settingsMaxOutput'), value: settingsDraft.maxOutputBytes, type: 'number', disabled: busy !== null || settings === null, onChange: (value: string) => { setSettingsDraft((c: any) => ({ ...c, maxOutputBytes: value })) } }),
          h(TextField, { label: t('settingsRemoteTimeout'), value: settingsDraft.remoteTimeoutMs, type: 'number', disabled: busy !== null || settings === null, onChange: (value: string) => { setSettingsDraft((c: any) => ({ ...c, remoteTimeoutMs: value })) } }),
          h(TextField, { label: t('settingsMaxTransfer'), value: settingsDraft.maxTransferBytes, type: 'number', disabled: busy !== null || settings === null, onChange: (value: string) => { setSettingsDraft((c: any) => ({ ...c, maxTransferBytes: value })) } }),
        ),
        settings === null ? h('span', { class: 'dshssh-muted' }, loading ? t('listProbing') : t('listLoadFailed')) : null,
      )

      /** What the plugin fixes in code, so a value is never a surprise. */
      const boundsCard = h('section', { class: 'dshssh-card' },
        h('h3', { class: 'dshssh-card-title' }, t('boundsTitle')),
        h('dl', { class: 'dshssh-bounds' },
          h('div', { class: 'dshssh-bound', key: 'targets' }, h('dt', {}, t('boundsTargets')), h('dd', {}, String(limits.maxConnections))),
          h('div', { class: 'dshssh-bound', key: 'lanes' }, h('dt', {}, t('boundsOps')), h('dd', {}, String(limits.concurrentOps))),
          h('div', { class: 'dshssh-bound', key: 'masters' }, h('dt', {}, t('boundsMasters')), h('dd', {}, String(limits.maxLiveMasters))),
          h('div', { class: 'dshssh-bound', key: 'persist' }, h('dt', {}, t('boundsPersist')), h('dd', {}, idleFor(limits.controlPersistSeconds))),
          h('div', { class: 'dshssh-bound', key: 'round' }, h('dt', {}, t('boundsPerRound')), h('dd', {}, String(limits.probeAllLimit))),
          h('div', { class: 'dshssh-bound', key: 'timeout' }, h('dt', {}, t('boundsTimeout')), h('dd', {}, measure(limits.probeTimeoutMs, 'ms'))),
          h('div', { class: 'dshssh-bound', key: 'remote' }, h('dt', {}, t('boundsRemoteTimeout')), h('dd', {}, `${measure(limits.remoteTimeoutMinMs, 'ms')} – ${measure(limits.remoteTimeoutMaxMs, 'ms')}`)),
          h('div', { class: 'dshssh-bound', key: 'output' }, h('dt', {}, t('boundsOutput')), h('dd', {}, `${measure(limits.outputMinBytes, 'bytes')} – ${measure(limits.outputMaxBytes, 'bytes')}`)),
          h('div', { class: 'dshssh-bound', key: 'transfer' }, h('dt', {}, t('boundsTransfer')), h('dd', {}, `${measure(limits.transferMinBytes, 'bytes')} – ${measure(limits.transferMaxBytes, 'bytes')}`)),
        ),
        // A fact about this machine, not a bound: the pool only exists if the Host
        // could make a private directory for its sockets, and when it could not,
        // every number above still holds while sharing simply does not happen.
        pool !== null && pool.ready === false
          ? h('p', { class: 'dshssh-muted' }, format(t('poolOff'), { reason: pool.failure ?? '—' }))
          : null,
      )

      const listCard = h('section', { class: 'dshssh-card' },
        h('div', { class: 'dshssh-card-head' },
          h('div', { class: 'dshssh-field' },
            h('h3', { class: 'dshssh-card-title' }, t('listTitle')),
            h('span', { class: 'dshssh-muted' }, format(t('listCount'), { count: String(connections.length), limit: String(limits.maxConnections) })),
          ),
          h('div', { class: 'dshssh-actions' },
            probing > 0 ? h(Badge, { tone: 'idle', text: t('stRunning') }) : null,
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
              onClick: () => {
                setDraft(draftOf(null))
                setDraftProbe(null)
                setFieldError(null)
                setFailure(null)
              },
            }, connections.length >= limits.maxConnections ? t('listAddFull') : t('listAdd')),
          ),
        ),
        connections.length === 0 && !loading
          ? h('div', { class: 'dshssh-field' },
            h('p', { class: 'dshssh-card-title' }, t('listEmpty')),
            h('p', { class: 'dshssh-muted' }, t('listEmptyHint')),
          )
          : h('div', { class: 'dshssh-list' }, connections.map(rowOf)),
        formRegion(),
      )

      const tabs = h(SshSegment, {
        id: TAB_BASE,
        role: 'tab',
        value: tab,
        groupLabel: t('tabsLabel'),
        options: [
          { value: 'list', label: t('tabList') },
          { value: 'settings', label: t('tabSettings') },
        ],
        onChange: (next: string) => { setTab(next) },
      })

      const panel = h('div', {
        id: `${TAB_BASE}-${tab}-panel`,
        role: 'tabpanel',
        'aria-labelledby': `${TAB_BASE}-${tab}`,
        tabIndex: 0,
        class: 'dshssh-panel',
      }, tab === 'list' ? listCard : h('div', { class: 'dshssh-panel' }, settingsCard, boundsCard))

      return h('div', { class: 'dshssh-root' },
        h('style', {}, CSS),
        header,
        noticeRegion,
        askpassNotice,
        tabs,
        panel,
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
