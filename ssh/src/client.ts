/**
 * SSH target manager — browser half, mounted as a Settings section.
 *
 * The web module table executes this file as a classic script, so everything
 * below the `window.__ModuleLoader__.load` call is the registered factory: the
 * only runtime import is `react`, taken from the page's baseline module table,
 * and the single top-level `import type` is erased by the compiler. Controls
 * and their stylesheet are local to this plugin, styled exclusively from
 * `--dsw-alias-*` theme tokens, because a plugin must not require another
 * Harness client package as a module.
 *
 * Every operation goes to the plugin's own `/api/ssh/rpc` route, which reads
 * and writes the plugin's storage domain; nothing here touches the profile
 * patch file, and no secret is ever rendered.
 *
 * @module @jie2gg/dsh-plugin-ssh/client
 */

import type { ConnectionInput, ConnectionRecord, ProbeOutcome, SshFailure, SshSettings } from './types.ts'

window.__ModuleLoader__.load({
  id: '@jie2gg/dsh-plugin-ssh',
  factory(require: (specifier: string) => any) {
    const React = require('react')
    const h = React.createElement

    /** Namespace this page's copy is registered under. */
    const NS = 'settings.ssh'
    /** The plugin's own route on the shared `/api` channel. */
    const ROUTE = '/api/ssh/rpc'

    /** Browser-facing copy. Both baseline locales are required by the locale service. */
    const DICT: Record<string, Record<string, string>> = {
      en: {
        nav: 'Remote connections',
        title: 'Remote connections',
        intro: 'Named SSH targets this machine can reach, kept in this plugin\'s own storage so the page can edit them without touching the profile patch file. The plugin never reads or writes ~/.ssh/config and never adds a host key.',
        storedIn: 'Stored by the plugin in its own ssh_targets storage domain.',
        settingsTitle: 'Client settings',
        settingsCommand: 'ssh executable',
        settingsProbeTimeout: 'Probe timeout (ms)',
        settingsMaxOutput: 'Output ceiling (bytes)',
        settingsSave: 'Save settings',
        settingsSaved: 'Saved.',
        settingsHint: 'A probe always runs with BatchMode=yes, so it never waits for a passphrase.',
        listTitle: 'SSH targets',
        listCount: '{count} of {limit} saved',
        listAdd: 'New connection',
        listAddFull: 'Target limit reached',
        listProbeAll: 'Test all',
        listProbing: 'Testing…',
        listSkipped: 'Tested the first {probed}; {skipped} still untested (raise the limit with another round).',
        listEmpty: 'No SSH targets yet',
        listEmptyHint: 'Add a host name or an existing OpenSSH host alias, then test it here.',
        listLoadFailed: 'The settings page could not reach the plugin on this Host.',
        newTitle: 'New connection',
        editTitle: 'Edit connection',
        fLabel: 'Display name',
        fHost: 'Host or alias',
        fUser: 'User',
        fPort: 'Port',
        fIdentity: 'Identity file',
        fProxy: 'Jump host',
        fArgs: 'Extra ssh flags',
        fArgsHint: 'One ssh argv entry per line: -4 on its own, an option with its value glued into one token (-oServerAliveCountMax=3), or the option and its value on two lines.',
        fNote: 'Note',
        fOptional: 'optional',
        fRequired: 'Required.',
        test: 'Test',
        testDraft: 'Test before saving',
        edit: 'Edit',
        remove: 'Delete',
        confirmRemove: 'Confirm delete',
        cancel: 'Cancel',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved.',
        removed: 'Deleted.',
        copyDetail: 'Copy diagnostics',
        copied: 'Copied.',
        copyFailed: 'The browser refused the clipboard.',
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
        hintUnknownHost: 'OpenSSH has no trusted host key for this host yet. Connect once from a terminal (ssh <host>) to record it; this page never writes known_hosts.',
        hintSshMissing: 'The configured ssh executable could not be resolved. Install OpenSSH or set its path in Client settings.',
        hintAuthFailed: 'The connection reached the server but no credential was accepted. ssh-agent or a key without a passphrase is what a probe can use.',
        hintUnreachable: 'The host did not accept the session: check the address, the port, and any jump host.',
        hintTimeout: 'The probe ran out of time. Raise the probe timeout if this host is slow to answer.',
        hintBadInput: 'Check the highlighted field.',
        hintBusy: 'Too many probes are running. Wait for the current ones to finish.',
        hintStorage: 'The plugin could not read its stored connections. See the Host log for the storage failure.',
        hintInternal: 'The plugin reported an unexpected failure.',
      },
      zh: {
        nav: '远程连接',
        title: '远程连接',
        intro: '保存「本机能够连上的命名 SSH 目标」。清单存在插件自己的存储里，页面改它不会动 profile 的 patch 文件；插件从不读写 ~/.ssh/config，也不会替你写入主机密钥。',
        storedIn: '由插件存放在它自己的 ssh_targets 存储域中。',
        settingsTitle: '客户端参数',
        settingsCommand: 'ssh 可执行文件',
        settingsProbeTimeout: '探测超时（毫秒）',
        settingsMaxOutput: '输出上限（字节）',
        settingsSave: '保存参数',
        settingsSaved: '已保存。',
        settingsHint: '探测始终以 BatchMode=yes 运行，因此不会等待输入口令。',
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
        fLabel: '显示名称',
        fHost: '主机名或别名',
        fUser: '用户',
        fPort: '端口',
        fIdentity: '私钥文件',
        fProxy: '跳板主机',
        fArgs: '额外 ssh 参数',
        fArgsHint: '每行一个 ssh 参数：单独一个 -4；把选项和值写成一个参数（-oServerAliveCountMax=3）；或者选项一行、取值一行。',
        fNote: '备注',
        fOptional: '可选',
        fRequired: '此项必填。',
        test: '测试',
        testDraft: '保存前先测试',
        edit: '编辑',
        remove: '删除',
        confirmRemove: '确认删除',
        cancel: '取消',
        save: '保存',
        saving: '保存中…',
        saved: '已保存。',
        removed: '已删除。',
        copyDetail: '复制诊断',
        copied: '已复制。',
        copyFailed: '浏览器拒绝了剪贴板写入。',
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
        hintUnknownHost: 'OpenSSH 还没有这台主机被信任的主机密钥。请在终端先手动连接一次（ssh <主机>）记录下来；本页面从不写入 known_hosts。',
        hintSshMissing: '无法解析设置里的 ssh 可执行文件。请安装 OpenSSH，或在客户端参数里填写它的路径。',
        hintAuthFailed: '已经连上服务端，但没有凭据被接受。探测能用的是 ssh-agent 或无口令私钥。',
        hintUnreachable: '主机没有接受这次会话：请检查地址、端口以及跳板主机。',
        hintTimeout: '探测用时耗尽。若这台主机响应较慢，请调大探测超时。',
        hintBadInput: '请检查高亮的字段。',
        hintBusy: '同时在跑的探测太多，请等待当前探测结束。',
        hintStorage: '插件读不到自己保存的连接记录，具体存储错误见 Host 日志。',
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
.dshssh-list{display:flex;flex-direction:column;gap:8px}
.dshssh-row{display:flex;align-items:flex-start;gap:10px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dshssh-row-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}
.dshssh-row-title{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.dshssh-row-meta{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshssh-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}
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
.dshssh-form{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}
.dshssh-foot{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.dshssh-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dshssh-sep{color:var(--dsw-alias-border-l2)}
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
     * @param params - its parameters.
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
      const failure: SshFailure = body?.error ?? {
        code: 'internal',
        message: `HTTP ${String(response.status)}`,
      }
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
     * Split the extra-flags textarea into argv entries, one per line.
     * @param text - the raw textarea value.
     * @returns the flags, or `undefined` when none were given.
     */
    function flagsOf(text: string): string[] | undefined {
      const lines = text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
      return lines.length === 0 ? undefined : lines
    }

    /**
     * Read one stored record back into the form's draft shape.
     * @param record - the stored target.
     * @returns the draft the form edits.
     */
    function draftOf(record: ConnectionRecord | null, fallback?: any): any {
      if (record === null) {
        return {
          id: undefined,
          label: '',
          host: '',
          user: '',
          port: '',
          identityFile: '',
          proxyJump: '',
          extraArgsText: '',
          note: '',
        }
      }
      return {
        id: record.id,
        label: record.label,
        host: record.host,
        user: record.user ?? '',
        port: record.port === undefined ? '' : String(record.port),
        identityFile: record.identityFile ?? '',
        proxyJump: record.proxyJump ?? '',
        extraArgsText: (record.extraArgs ?? []).join('\n'),
        note: record.note ?? '',
      }
    }

    /**
     * Turn the edited draft into the payload the Host validates.
     * @param draft - the form state.
     * @returns a `save` connection payload, with blank fields dropped.
     */
    function payloadOf(draft: any): ConnectionInput {
      const optional = (value: string): string | undefined => {
        const trimmed = value.trim()
        return trimmed === '' ? undefined : trimmed
      }
      const port = optional(draft.port ?? '')
      const args = flagsOf(draft.extraArgsText ?? '')
      const user = optional(draft.user ?? '')
      const identityFile = optional(draft.identityFile ?? '')
      const proxyJump = optional(draft.proxyJump ?? '')
      const note = optional(draft.note ?? '')
      const host = optional(draft.host ?? '') ?? ''
      return {
        ...(draft.id === undefined || draft.id === '' ? {} : { id: draft.id }),
        label: optional(draft.label ?? '') ?? host,
        host,
        ...(user === undefined ? {} : { user }),
        ...(port === undefined ? {} : { port: Number(port) }),
        ...(identityFile === undefined ? {} : { identityFile }),
        ...(proxyJump === undefined ? {} : { proxyJump }),
        ...(args === undefined ? {} : { extraArgs: args }),
        ...(note === undefined ? {} : { note }),
      }
    }

    /**
     * The draft fields a probe can use before the record is saved.
     * @param draft - the form state.
     * @returns the probe draft payload, or `undefined` when no host is typed yet.
     */
    function probeDraftOf(draft: any): Record<string, unknown> | undefined {
      const host = (draft.host ?? '').trim()
      if (host === '') return undefined
      const port = (draft.port ?? '').trim()
      const user = (draft.user ?? '').trim()
      const identityFile = (draft.identityFile ?? '').trim()
      const proxyJump = (draft.proxyJump ?? '').trim()
      const args = flagsOf(draft.extraArgsText ?? '')
      return {
        host,
        ...(user === '' ? {} : { user }),
        ...(port === '' ? {} : { port: Number(port) }),
        ...(identityFile === '' ? {} : { identityFile }),
        ...(proxyJump === '' ? {} : { proxyJump }),
        ...(args === undefined ? {} : { extraArgs: args }),
      }
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

    /** One state dot and its label. */
    function Badge(props: { tone: string; text: string }): any {
      return h('span', { class: 'dshssh-badge', 'data-tone': props.tone }, props.text)
    }

    /** A labelled single-line input. */
    function TextField(props: {
      label: string
      value: string
      onChange: (value: string) => void
      placeholder?: string
      optionalText?: string
      type?: string
      disabled?: boolean
      errorText?: string
    }): any {
      return h('label', { class: 'dshssh-field' },
        h('span', { class: 'dshssh-label' },
          props.label,
          props.optionalText === undefined ? null : h('span', { class: 'dshssh-muted' }, ` (${props.optionalText})`),
        ),
        h('input', {
          class: 'dshssh-input',
          type: props.type ?? 'text',
          value: props.value,
          placeholder: props.placeholder ?? '',
          disabled: props.disabled === true,
          'aria-invalid': props.errorText === undefined ? 'false' : 'true',
          onChange: (event: any) => { props.onChange(String(event.target.value ?? '')) },
        }),
        props.errorText === undefined ? null : h('span', { class: 'dshssh-error' }, props.errorText),
      )
    }

    /** A labelled multi-line input. */
    function TextAreaField(props: {
      label: string
      value: string
      onChange: (value: string) => void
      hint?: string
      disabled?: boolean
    }): any {
      return h('label', { class: 'dshssh-field' },
        h('span', { class: 'dshssh-label' }, props.label),
        h('textarea', {
          class: 'dshssh-textarea',
          value: props.value,
          rows: 3,
          disabled: props.disabled === true,
          onChange: (event: any) => { props.onChange(String(event.target.value ?? '')) },
        }),
        props.hint === undefined ? null : h('span', { class: 'dshssh-muted' }, props.hint),
      )
    }

    /** A status line the page announces politely. */
    function Notice(props: { tone: string; text: string; hint?: string; children?: any }): any {
      return h('div', { class: 'dshssh-notice', 'data-tone': props.tone, role: 'status', 'aria-live': 'polite' },
        h('span', {}, props.text),
        props.hint === undefined ? null : h('span', { class: 'dshssh-muted' }, props.hint),
        props.children ?? null,
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
     * The section itself.
     * @param props - seat props: the localized reader and the panel `close`.
     * @returns the rendered page.
     */
    function SshSection(props: any): any {
      const t = translator(props)
      const [connections, setConnections] = React.useState([] as ConnectionRecord[])
      const [settings, setSettings] = React.useState(null as SshSettings | null)
      const [limits, setLimits] = React.useState({ maxConnections: 64, concurrentProbes: 4, probeAllLimit: 12 })
      const [probing, setProbing] = React.useState(0)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(null as string | null)
      const [failure, setFailure] = React.useState(null as SshFailure | null)
      const [notice, setNotice] = React.useState(null as { tone: string; text: string } | null)
      const [draft, setDraft] = React.useState(null as any)
      const [draftProbe, setDraftProbe] = React.useState(null as ProbeOutcome | null)
      const [fieldError, setFieldError] = React.useState(null as string | null)
      const [confirmId, setConfirmId] = React.useState(null as string | null)
      const [settingsDraft, setSettingsDraft] = React.useState({ command: '', probeTimeoutMs: '', maxOutputBytes: '' })
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
            command: result.settings?.command ?? '',
            probeTimeoutMs: String(result.settings?.probeTimeoutMs ?? ''),
            maxOutputBytes: String(result.settings?.maxOutputBytes ?? ''),
          })
          if (result.limits !== undefined) setLimits(result.limits)
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
       * Run one mutation with the shared busy, failure, and notice handling.
       * @param key - what is running, so the right control is disabled.
       * @param run - the mutation.
       * @param done - the success copy to announce.
       * @returns resolution once the mutation settled.
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
       * Save the edited draft as a new or updated target.
       * @returns resolution once it landed.
       */
      async function saveDraft(): Promise<void> {
        const payload = payloadOf(draft)
        if (payload.host.trim() === '') {
          setFieldError('host')
          setFailure({ code: 'bad-input', message: t('fRequired'), field: 'host' })
          return
        }
        await act(draft?.id ?? 'new', async () => {
          const result = await rpc('save', { connection: payload })
          if (!alive.current) return
          setConnections(result.connections ?? [])
          setDraft(null)
          setDraftProbe(null)
          setFieldError(null)
        }, t('saved'))
      }

      /**
       * Probe the draft before it is worth storing.
       * @returns resolution once the outcome landed.
       */
      async function testDraft(): Promise<void> {
        const probe = probeDraftOf(draft)
        if (probe === undefined) {
          setFieldError('host')
          setFailure({ code: 'bad-input', message: t('fRequired'), field: 'host' })
          return
        }
        await act('draftProbe', async () => {
          const result = await rpc('probe', { draft: probe })
          if (alive.current) setDraftProbe(result.probe ?? null)
        })
      }

      /**
       * Probe one stored target and fold the fresh result into the list.
       * @param record - the stored target.
       * @returns resolution once the row updated.
       */
      async function testOne(record: ConnectionRecord): Promise<void> {
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
       * Delete one stored target.
       * @param record - the stored target.
       * @returns resolution once the row disappeared.
       */
      async function remove(record: ConnectionRecord): Promise<void> {
        await act(`remove:${record.id}`, async () => {
          await rpc('remove', { id: record.id })
          if (!alive.current) return
          setConnections((current: ConnectionRecord[]) => current.filter(row => row.id !== record.id))
          setConfirmId(null)
          if (draft?.id === record.id) {
            setDraft(null)
            setDraftProbe(null)
          }
        }, t('removed'))
      }

      /**
       * Persist the shared client settings.
       * @returns resolution once the new values landed.
       */
      async function saveSettings(): Promise<void> {
        const whole = (value: string): number | undefined => {
          const trimmed = value.trim()
          return trimmed === '' ? undefined : Number(trimmed)
        }
        await act('settings', async () => {
          const command = settingsDraft.command.trim()
          const result = await rpc('configUpdate', {
            settings: {
              ...(command === '' ? {} : { command }),
              ...(() => { const value = whole(settingsDraft.probeTimeoutMs); return value === undefined || Number.isNaN(value) ? {} : { probeTimeoutMs: value } })(),
              ...(() => { const value = whole(settingsDraft.maxOutputBytes); return value === undefined || Number.isNaN(value) ? {} : { maxOutputBytes: value } })(),
            },
          })
          if (!alive.current) return
          setSettings(result.settings ?? null)
          if (result.settings !== undefined) {
            setSettingsDraft({
              command: result.settings.command ?? '',
              probeTimeoutMs: String(result.settings.probeTimeoutMs ?? ''),
              maxOutputBytes: String(result.settings.maxOutputBytes ?? ''),
            })
          }
        }, t('settingsSaved'))
      }

      /**
       * Copy one target's diagnostics to the clipboard.
       * @param record - the stored target.
       * @returns resolution once the browser accepted the write.
       */
      async function copyDiagnostics(record: ConnectionRecord): Promise<void> {
        const payload = JSON.stringify({
          id: record.id,
          label: record.label,
          host: record.host,
          ...(record.user === undefined ? {} : { user: record.user }),
          ...(record.port === undefined ? {} : { port: record.port }),
          ...(record.identityFile === undefined ? {} : { identityFile: record.identityFile }),
          ...(record.proxyJump === undefined ? {} : { proxyJump: record.proxyJump }),
          ...(record.extraArgs === undefined ? {} : { extraArgs: record.extraArgs }),
          ...(record.lastProbe === undefined ? {} : { lastProbe: record.lastProbe }),
        }, null, 2)
        const clipboard = (typeof navigator === 'object' && navigator !== undefined ? navigator.clipboard : undefined)
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
       * Render one probe result: when it ran, how long it took, the fix-up
       * hint for its status, and the captured output tail.
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

      /** One row of the stored list. */
      function rowOf(record: ConnectionRecord): any {
        const testing = busy === `probe:${record.id}`
        const removing = busy === `remove:${record.id}`
        const editing = draft?.id === record.id
        const address = `${record.user ?? ''}${record.user === undefined ? '' : '@'}${record.host}${record.port === undefined ? '' : `:${String(record.port)}`}`
        const meta = [
          address,
          record.proxyJump === undefined ? '' : `via ${record.proxyJump}`,
          record.identityFile === undefined ? '' : `-i ${record.identityFile}`,
        ].filter(value => value !== '')
        return h('div', { class: 'dshssh-row', key: record.id },
          h('div', { class: 'dshssh-row-main' },
            h('div', { class: 'dshssh-row-title' }, record.label),
            h('div', { class: 'dshssh-row-meta' }, meta.join(' ')),
            record.note === undefined ? null : h('div', { class: 'dshssh-muted' }, record.note),
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
            record.lastProbe === undefined ? null : h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled: busy !== null,
              onClick: () => { void copyDiagnostics(record) },
            }, t('copyDetail')),
          ),
        )
      }

      /** The new/edit form. */
      function formRegion(): any {
        if (draft === null) return null
        const patch = (key: string) => (value: string): void => {
          setDraft((current: any) => ({ ...current, [key]: value }))
          if (fieldError === key) setFieldError(null)
        }
        const atLimit = draft.id === undefined && connections.length >= limits.maxConnections
        return h('div', { class: 'dshssh-form' },
          h('div', { class: 'dshssh-card-title' }, draft.id === undefined ? t('newTitle') : t('editTitle')),
          h('div', { class: 'dshssh-grid' },
            h(TextField, {
              label: `${t('fLabel')} (${t('fOptional')})`,
              value: draft.label ?? '',
              onChange: patch('label'),
              errorText: fieldError === 'label' ? t('fRequired') : undefined,
              disabled: busy !== null || atLimit,
            }),
            h(TextField, {
              label: t('fHost'),
              value: draft.host ?? '',
              onChange: patch('host'),
              errorText: fieldError === 'host' ? t('fRequired') : undefined,
              disabled: busy !== null || atLimit,
            }),
            h(TextField, {
              label: `${t('fUser')} (${t('fOptional')})`,
              value: draft.user ?? '',
              onChange: patch('user'),
              errorText: fieldError === 'user' ? t('hintBadInput') : undefined,
              disabled: busy !== null || atLimit,
            }),
            h(TextField, {
              label: `${t('fPort')} (${t('fOptional')})`,
              value: draft.port ?? '',
              type: 'number',
              onChange: patch('port'),
              errorText: fieldError === 'port' ? t('hintBadInput') : undefined,
              disabled: busy !== null || atLimit,
            }),
            h(TextField, {
              label: `${t('fIdentity')} (${t('fOptional')})`,
              value: draft.identityFile ?? '',
              onChange: patch('identityFile'),
              errorText: fieldError === 'identityFile' ? t('hintBadInput') : undefined,
              disabled: busy !== null || atLimit,
            }),
            h(TextField, {
              label: `${t('fProxy')} (${t('fOptional')})`,
              value: draft.proxyJump ?? '',
              onChange: patch('proxyJump'),
              errorText: fieldError === 'proxyJump' ? t('hintBadInput') : undefined,
              disabled: busy !== null || atLimit,
            }),
          ),
          h(TextField, {
            label: `${t('fNote')} (${t('fOptional')})`,
            value: draft.note ?? '',
            onChange: patch('note'),
            disabled: busy !== null || atLimit,
          }),
          h(TextAreaField, {
            label: `${t('fArgs')} (${t('fOptional')})`,
            value: draft.extraArgsText ?? '',
            onChange: patch('extraArgsText'),
            hint: t('fArgsHint'),
            disabled: busy !== null || atLimit,
          }),
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
              disabled: busy !== null,
              onClick: () => { void testDraft() },
            }, t('testDraft')),
            h('button', {
              class: 'dshssh-btn',
              type: 'button',
              disabled: busy !== null,
              onClick: () => {
                setDraft(null)
                setDraftProbe(null)
                setFieldError(null)
              },
            }, t('cancel')),
            h('button', {
              class: 'dshssh-btn dshssh-btn-primary',
              type: 'button',
              disabled: busy !== null || atLimit,
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
        h('p', { class: 'dshssh-muted' }, t('settingsHint')),
        h('div', { class: 'dshssh-grid' },
          h(TextField, { label: t('settingsCommand'), value: settingsDraft.command, onChange: (value: string) => { setSettingsDraft((c: any) => ({ ...c, command: value })) }, disabled: busy !== null || settings === null }),
          h(TextField, { label: t('settingsProbeTimeout'), value: settingsDraft.probeTimeoutMs, type: 'number', onChange: (value: string) => { setSettingsDraft((c: any) => ({ ...c, probeTimeoutMs: value })) }, disabled: busy !== null || settings === null }),
          h(TextField, { label: t('settingsMaxOutput'), value: settingsDraft.maxOutputBytes, type: 'number', onChange: (value: string) => { setSettingsDraft((c: any) => ({ ...c, maxOutputBytes: value })) }, disabled: busy !== null || settings === null }),
        ),
        settings === null ? h('span', { class: 'dshssh-muted' }, loading ? t('listProbing') : t('listLoadFailed')) : null,
      )

      const listCard = h('section', { class: 'dshssh-card' },
        h('div', { class: 'dshssh-card-head' },
          h('div', { class: 'dshssh-field' },
            h('h3', { class: 'dshssh-card-title' }, t('listTitle')),
            h('span', { class: 'dshssh-muted' }, format(t('listCount'), { count: String(connections.length), limit: String(limits.maxConnections) })),
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

      return h('div', { class: 'dshssh-root' },
        h('style', {}, CSS),
        header,
        noticeRegion,
        settingsCard,
        listCard,
      )
    }

    return {
      /** The client services this module needs from the page. */
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries and the two settings-panel seats.
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
