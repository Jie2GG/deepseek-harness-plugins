# @jie2gg/dsh-plugin-ssh

在 Harness 设置面板里管理本机能连上的 SSH 目标：一份只靠单个地址字段写成的具名清单、两种认证模式（密钥或密码）且其机密住在凭据库中，再加上使用它们的连通性探测与客户端设置。同样的操作通过一个 agent 工具 `ssh_client` 进入会话，该工具在下文所述的政策闸门下运行。面向用户的文案见 [docs/DETAIL.md](docs/DETAIL.md)（中文见 [docs/DETAIL.zh.md](docs/DETAIL.zh.md)）。

## 目录结构

```
ssh/
├── package.json              # bundle 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml          # 插入一行 Host plugin：id 为 `ssh`
├── tsconfig.json             # NodeNext ESM，src/ → lib/，client 只做类型导入
├── icon.svg                  # 原创图形（提示符光标 + 虚线链路 + 服务器机架）
├── scripts/finalize-client.mjs  # 剥掉 TS 的 `export {};` 并证明其脚本形态
├── scripts/live-check.mjs      # 用真实 provider 对活服务器复测同样的那些边界
├── docs/DETAIL.md            # 插件详情页，英文
├── docs/DETAIL.zh.md         # 插件详情页，中文
├── locale/en.json            # meta.title / meta.description / meta.detail
├── locale/zh.json            # 同上，中文；其 meta.detail 指向 DETAIL.zh.md
├── tests/                    # 离线测试套件：针对 lib/ 的纯 node:test —— 先构建
│   ├── helpers.mjs           # 假的 transport、store、secrets；payload 模式校验器
│   ├── tool.test.mjs         # 闸门、求解、参数、措辞，每个 payload 都对照模式校验
│   ├── ops.test.mjs          # 每个操作都在其 transport 接缝处，含标记协议
│   ├── storage.test.mjs      # zod 边界与严格记录
│   ├── transport.test.mjs    # 引号处理、程序名提取、指纹表、共享开关
│   ├── pool.test.mjs         # 主台账：socket 由什么命名、谁被驱逐、什么被关闭
│   ├── jobs.test.mjs         # 后台作业的生命周期及其结果分类
│   ├── edit.test.mjs         # 精确匹配规则、按出现次数拒绝、受保护的写入
│   ├── spill.test.mjs        # spill 预算：给出什么、拒绝什么、计入什么
│   ├── tmpgc.test.mjs        # 临时目录里谁可被回收，以及什么绝不可被回收
│   ├── local-path.test.mjs   # 传输必须遵守的工作区边界
│   └── rpc.test.mjs          # 方法白名单，以及失败 code 到 HTTP status 的映射
└── src/
    ├── index.ts              # Host 入口：name、inject、apply（打开 domain + 注册路由）
    ├── types.ts              # 路由路径、方法清单、失败 code（对 client 仅为类型）
    ├── storage.ts            # `ssh_targets` domain：zod 模式、边界、限制
    ├── store.ts              # 在已打开的 domain 上做带类型的读写
    ├── transport.ts          # SshTransport：一套开关、一个子进程、run + probe、一份租约
    ├── pool.ts               # MuxPool：按目标共享的连接，以及它们的台账
    ├── secrets.ts            # 凭据库里的密码与口令记录
    ├── askpass.ts            # 应答 ssh 提示的那个私有辅助程序
    ├── tool.ts               # 面向 agent 的 `ssh_client` 工具及其政策闸门
    ├── transfer.ts           # 单个文件走一条被计数的通道，一棵树走 scp -r，落点两侧都受保护
    ├── spill.ts              # 一个 Host 进程会让 provider 代为保留多少 spill
    ├── tmpgc.ts              # 哪些临时目录归我们回收，依据什么证据
    ├── local-path.ts         # 本地传输路径必须遵守的工作区边界
    ├── edit.ts               # `edit` 背后的纯匹配与替换规则
    ├── jobs.ts               # 挂在 harness 作业台账上的一个后台化远程命令
    ├── ops.ts                # 把全部能力收进一个与 transport 无关的对象；页面与工具共用它
    ├── rpc.ts                # Request → Response，失败 code → HTTP status
    ├── client.ts             # 浏览器那一半：页面的三个区域与它的图标
    └── client-globals.d.ts   # 环境声明 window/navigator；永不产出到 lib/
```

## 构建与安装

`lib/` 被 git 忽略，所以从本目录安装之前要先构建。DSH 从它自己的安装里解析 `@deepseek-ai/*` 那些 peer；`zod` 与 `@deepseek-ai/dsh-storage-domain` 作为真实依赖随包发布，因为 Host 那一半在运行时会 import 它们。

```sh
cd ssh
pnpm install        # 依赖 + 仅类型的 peer
pnpm run check      # tsc --noEmit
pnpm run build      # tsc，然后把 lib/client.js 收尾为传统脚本
pnpm test           # 先构建，再 node --test tests/*.test.mjs（离线套件）
# 当 harness checkout 就在附近时，用它自带的 oxlint 做 lint；这是成本最低的一遍，
# 专抓类型检查漏下来的死代码：
#   /data/deepseek-harness/node_modules/.bin/oxlint src tests scripts
```

收尾（finalize）这一步不是装饰：web 模块表会把 `lib/client.js` 当脚本来跑，所以它必须恰好带一个 `window.__ModuleLoader__.load(` 调用，且没有顶层的 `import`/`export`。这两半任何一半不对，`pnpm run build` 就会失败。

然后在运行中的 Harness 里：`plugin_manager` → `install_bundle`，填入本目录的绝对路径。按仓库规则的验收标准：无 manifest 诊断，标题、描述、图标与详情文档在英文和中文下都能正常渲染；设置导航里出现一条带图标的 **Remote connections** / 「远程连接」行，页面自上而下是 **SSH 目标**、**客户端参数**，以及默认折叠的 **运行状态与高级信息**。一个新装 bundle 的 client 产物需要页面来（重）加载它：打开着的页面会沿 Host 模块图走 HMR，所以已安装那一行的 bundle 重新构建之后，通常无需手动刷新就会被换进来——但被**替换**的包（而不是被重新构建的）需要重启，才能加载全新的一代模块。

## API

### Host 侧（`src/index.ts`）

| 导出项 | 形态 | 说明 |
| --- | --- | --- |
| `name` | `'ssh'` | 供 loader 诊断使用的 Cordis 插件名。 |
| `inject` | `['connection', 'subprocess', 'storageDomain', 'credentials']` | 硬性要求：缺了它们，该行会保持 inactive，而不是抛异常。 |
| `apply(ctx, config)` | `(ctx: Context, config: SshConfig) => void` | 先打开 domain，然后在 `ctx.effect` 之内注册 `/api/ssh/rpc`；卸载时两个 disposer 都会运行。 |

插件为它的各项上限声明了一个 `Config`（`src/config.ts`）：每个上限配一个默认值加一个天花板，且全部 `.volatile()`，因此编辑该行的 `config:` 就会改变下一次调用所对照求解的依据，既不必重启，也不碰存储 domain。页面所编辑的东西留在 domain 里（目标清单、覆盖项、会话选择），凭据留在凭据库里——所以从页面保存时，依然不会重写 profile 的 patch 文件，也不会重启插件。

### 路由（`/api/ssh/rpc` 上的 `POST` 与 `GET`）

请求体 `{ method, params? }`，结果为 `{ ok: true, result }` 或 `{ ok: false, error: { code, message, field?, hint? } }`。code 是一个封闭集合：`bad-input` 400、`not-found` 404、`busy` 409、`storage-error` 500、`secret-error` 500、`internal` 500。

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `list` | – | `{ connections, settings, limits, askpass, askpassFailure?, probing }` |
| `save` | `{ connection, secrets? }`（不带 `id` 即新建） | `{ connection, connections }` |
| `remove` | `{ id }` | `{ removed, orphanSecrets, connections }` |
| `probe` | `{ id }` 或 `{ draft, secrets? }` | `{ connection?, probe?, connections }` |
| `resolve` | `{ target?, sessionId? }` | `{ action: 'resolve', ok, target, resolved, stored, differs, text? }` |
| `probeAll` | – | `{ connections, probed, skipped, failures }` |
| `configUpdate` | `{ settings }` | `{ settings }` |

这份白名单是页面的界面，不是操作的界面：`runCommand`、`upload`、`download` 以及会话目标的设置器，都住在同一个 `ops` 对象上，而 agent 工具直接驱动它；并且自 0.0.32 起，那五个永远不会被控制面调用的条目，会和任何未知名字一样在闸门处被拒（`ops` 上的方法本身仍然保留）。

`GET` 只抵达 `list`；这条路由搭乘的是共享的 `/api` 通道，所以只有被服务页面的 owner peer 会被准入，其它任何 principal 一律被拒。

一条连接记录是 `{ id, label, host, user?, port?, identityFile?, proxyJump?, extraArgs?, note?, createdAt, updatedAt, lastProbe?, auth }`，再加上 `secrets: { password, passphrase, root }`。`auth` 在写入时取 `key` 或 `password`；`key+password` 仍然可读（它只在 0.4.0 提供过），并按其一贯的方式探测。`secrets` 只表达存在与否——没有任何响应会带出已存储的值——而一次 `secrets` 补丁会写入一个字符串、用 `null` 表示遗忘、对缺席的键则原样不动。`limits` 带上固定边界，包含被接受的取值范围，好让设置页直接陈述它们，而不必在浏览器代码里再复刻一份。失败 code 现在包含 `secret-error`（500）。

### 存储

只有一个 domain，`ssh_targets`（`version: 4`，借助 `compatibleVersions` 读取 `version: 1` 到 `3` 的记录），落在 profile 为它路由的后端上——`json` 后端每个 unit 写一个文档，位于 `$DSH_HOME/storages/ssh_targets.json`：

- 表 `connections`：`{ id, label, host, user?, port?, identityFile?, proxyJump?, extraArgs?, note?, createdAt, updatedAt, lastProbe?, auth, agentAccess, allowedCommands, remoteTimeoutMs?, maxOutputBytes? }`，每次读与写都经 zod 校验，因此手工编辑的文件没法把一条坏记录混进页面（它会改以 `storage-error` 现形）。
- 表 `sessions`：`{ sessionId, targetId, setAt }`——某个会话挑中的那个目标，于是一次远程调用可以省略 `target`。`remove` 会清掉指向被删目标的行。
- 全局槽位：`{ maxOutputBytes, remoteTimeoutMs, maxTransferBytes }`。在 0.0.18 之前写入的槽位还会带 `command` 和 `probeTimeoutMs`；模式接受并忽略它们，而下一次保存就把它们丢掉。

格式沿革：1 = 只有 targets，2 = 加了 `auth`，3 = 加了 agent 相关字段与 `sessions` 表，4 = 全局槽位收缩为三个上限。每个新增字段都是可选的，其默认值正好复刻旧版本的含义；每个退役字段都被接受并被忽略，所以已有文件仍然能打开——而 `json` 后端会给该 unit 打上它最后一次写入的版本号。

该文件的形状，由一次针对已发布 json 后端的集成运行所断言：

```json
{ "unit": { "name": "ssh_targets", "version": 6 },
  "global": { "maxOutputBytes": 65536, "remoteTimeoutMs": 30000, "maxTransferBytes": 33554432 },
  "tables": { "connections": { "ssh-0123456789": { "id": "…", "label": "…", "host": "…", "auth": "password", "agentAccess": "on", "pool": "on", "allowedCommands": ["git"], "extraArgs": ["-4"], "createdAt": "…", "updatedAt": "…", "lastProbe": { "status": "auth-failed" } } }, "sessions": { "session-77": { "sessionId": "session-77", "targetId": "ssh-0123456789", "setAt": "…" } } }
```

自 0.0.24 起边界一分为二。结构性的那些仍然住在 `src/storage.ts`：64 个目标、由探测与命令共用的 16 个并发远程操作槽、8 台各可持有一条共享连接的服务器（`MAX_LIVE_MASTERS`），超出就把最久安静的那条 idle 退役；一个 master 的 5 分钟 idle 超时（`CONTROL_PERSIST_SECONDS`）、每轮 `probeAll` 最多 12 个、喂给命令 stdin 的文本封顶 1,000,000 字符、远程命令行 8,192，以及最多 32 个各 64 字符的白名单程序名。自 0.0.26 起，后台化的命令没有自己的截止时间——`BACKGROUND_DEADLINE_MS` 已被移除——作业活到它落定、被杀、失去 owner，或 Host 退出为止，其间一直占着那 16 个操作槽之一。这 16 个里最多 `maxConcurrentTransfers`（默认 2）可被文件拷贝占据，于是两次大传输永远不会把所有命令饿死；一个被该天花板拒绝的拷贝会被告知它撞到的是哪个天花板，而且以该调用本来的应答形态告知。一次 `upload` 或 `download` 会以"拷贝过大"那种普通失败回来——`status: "failed"`，所涉通道写在 `message` 里，出路写在 `hint` 里，什么都没移动——因为那些动作的读者应当面对同一套词汇，无论那次拷贝是太大、太迟，还是在另外两个已经在动的时候压根不受欢迎。直接抵达 transport 的调用方，以及设置界面，仍然会拿到抛出的 `busy` 错误（rpc 上是 409）；而一个显式后台化、却拿不到作业槽的命令，会在它被问起的那个 frame 里就被拒。传输走自己的时钟——`transferTimeoutMs`（默认 5 分钟，封顶于 `maxTransferTimeoutMs`，即 30 分钟）——绝不用命令的那 30 秒，因为一次被允许的拷贝在慢速链路上合法地要跑上好几分钟，而 `scp` 本身并没有自己的大小限制。递归上传的文件数与累计大小天花板（`maxTransferFiles`、`maxTransferTotalBytes`）是走查（walk）时刻的前置检查。读者或一次调用能够改动的那些上限——命令超时、每流输出、传输大小、传输截止时间——外加探测与前置检查的截止时间、spill 上限、kill 宽限期、每类通道的上限，以及一次超时的命令是否被升级（promote），如今都住在 `src/config.ts` 里，各自成一对"默认值 + 天花板"（或一个带界的纯默认值），并且全部 `.volatile()`。

### 边界求解（`src/config.ts`、`src/bounds.ts`）

这个插件过去带的是双边区间（`1 s – 300 s`、`1 KiB – 4 MiB`、`1 KiB – 512 MiB`），并**拒绝**落在区间外的值。而 harness 在任何地方都没有这样的形状，那正是改变它的论据：

- `bash-local` 把 `timeoutMs`（默认 120 s）和 `maxTimeoutMs`（600 s）声明为 **volatile config**，而它的 `resolve()` 对覆盖值是*钳制*（clamp），不是拒绝（`packages/shell/bash-local/src/index.ts:100-107,122-127`）。
- 一个 shell 请求所强制的唯一规则是"正数且有限"：`clampTimeout(requested, def, max, name)` 只在这一条上抛异常，其余情况返回 `min(requested ?? def, max)`（`packages/util/timeout/src/index.ts:45-55`）。
- shell 的结果会**回显生效的超时**——`ShellRunResult.timeoutMs`，注释写着 "after defaulting/capping"（`packages/shell/shell/src/types.ts:159-160`）。
- `tool-jobs` 以同样的方式钳制 wait，并且当某个上限被配置到低于它的默认值时，在**加载时**就拒绝（`packages/jobs/tool-jobs/src/index.ts:241-253`）。

于是 `bounds.ts` 现在是唯一陈述这套分层的地方——**调用 → 目标 → profile 覆盖 → 配置默认值**，并由 `max*` 封顶——它返回生效值，外加每条修正各带一条说明，由 `stampCeilings` 附加到结果上（`timeoutMs`、`outputBytes`、`notes`；传输还会加上 `bytesLimit` 与 `limitMode`——当上限是对正在移动的那些字节施用时为 `in-flight`，当它是对某次走查或枚举所言先行施用时为 `pre-check`——并且回显它们自己的传输截止时间，而不是命令的那个；一次 edit 再加上 `stale`、`restored`、`versionChecked`、`contentVerified`、`verdict` 与 `sha256`，因为其中究竟哪一条为真，正是"一个字节被测量过的文件"、"一个只是长度恰好吻合的文件"、"一次撤销"与"一次拒绝"之间的分别）。一个越过天花板的值不再是错误；而一个压根无法表示截止时间的值（零、负数、非有限）仍然是，且 hint 会说明这条线如今落在何处。`readBounds` 每次调用都重新读取那些 volatile 值——从不快照——所以一次 profile 编辑会体现在下一次调用上；而一个被配置到低于其默认值的天花板会被抬高并附一条说明，而不是悄无声息地把默认值掐死。

有一处不对称是 harness 无法替我们吸收的：本插件声明了一个 `ToolDefinition.timeoutMs`（它此前没有），而 `guard/timeout-policy` 会读取那份声明，并在它自己的计时器胜出时**把工具返回的任何东西替换成** `Error: tool call timed out after <N>ms`（`packages/guard/timeout-policy/src/index.ts:57-79`）。把同一个数字既声明为预算、又设为内部上限——那正是 0.0.23 出厂的形态，两边都是 300 s——意味着这场竞速就是抛硬币。声明的预算现在是被推导出来的（`max(maxTimeoutMs, statTimeoutMs + maxTransferTimeoutMs) + graceMs + DRAIN_MS` 再加 5 s 余量——也就是一次调用可能要等待的两条时钟中较长的那条），并由一个测试把这个不等式钉住，于是在一次普通超时里，插件自己分类过的应答总是胜出。`bash` 通过根本不声明任何预算而回避了整个问题（`packages/shell/tool-bash/src/index.ts:368-534`）；而一次远程调用挂在那里、却无事可超时，正是本插件保留一个预算的理由。

`ssh -G`、`ssh -O` 以及探测的截止时间，是有意置于覆盖分层之外的：resolve 视图不拨任何号，而探测的预算是给页面定的一条规则，不是供某次调用去协商的一个数字。哪个程序负责拨号同样不是一个边界：`SSH_EXECUTABLE` 与 `SSH_FALLBACK_PATHS`（scp 也有同一对）就是那个自动探测的搜索序列。

记录格式是 `version: 6`，配 `compatibleVersions: [1, 2, 3, 4, 5]`。

共享的设置槽位只带页面仍在编辑的那三个天花板。自 0.0.18 起，ssh/scp 程序在运行时被找到——先试 `PATH` 上的裸名字，再到常见的安装位置，首次命中后缓存到卸载为止，未命中则重试——而且一次探测固定等待 30 秒，所以这两样都不再被存储或被编辑。一个仍然发送已退役字段的 `configUpdate` 会被当作 `bad-input` 拒绝，而不是被悄悄丢掉。

### 凭据

密码、密钥口令（passphrase）以及 root 账户自身的密码，不住在存储 domain 里。`secrets.ts` 把它们作为 `grant` 记录保存在凭据库中——`credentialKey('ssh', '<target-id>-password')`、`…-passphrase`，以及自 0.0.20 起的 `…-root`（`su` 提权用来应答的那个机密）——于是它们位于 `$DSH_HOME/.credentials.yaml` 的 `records:` 之下；用 `modifyRecord` 写入，用 `deleteRecord` 移除（删除一个目标就会忘记它的三个槽位），并且只在一次探测或一次提权调用需要一个值时才读回。此处要紧的几条接缝规则：每个 key 段必须匹配 `^[a-z][a-z0-9-]*$`（这就是目标 id 之所以是 `ssh-<10 hex>` 的原因），一个 mutate 回调返回一个 promise，空值是缺席而不是空白，并且存储文件不得带有属主之外的权限位。

`askpass.ts` 物化出那个让 `ssh` 在没有终端的情况下也能索要上述某个机密的辅助程序：`mkdtemp($TMPDIR/dsh-ssh-askpass-)`，模式 `0700`，其中一个是 `askpass.sh`，模式 `0700`，由插件的 disposer 移除。它读取 `ssh` 作为 `$1` 传入的提示文本，从 `DSH_SSH_ASKPASS_PASSPHRASE` 或 `DSH_SSH_ASKPASS_PASSWORD` 作答，并回落到那两个当中被填上的任一个。

### 连接池（`src/pool.ts`）

`MuxPool` 按目标租用一条共享的 OpenSSH 连接，于是多次调用共乘一个已认证的会话，而不必各自付一次握手与登录的代价。它决定了什么，以及为什么：

- **命名。** `<muxdir>/<target id>-<10 hex>.sock`，其中的摘要覆盖 authority、端口、跳转主机、identity 文件、额外开关、认证模式，以及本次调用实际持有的那个机密的哈希。两条规则就从这一行里落出来：一个被编辑过的目标，不能继承它的前任留下的那条仍开着的 master（名字变了，而旧 master 会自己 idle 掉）；一个用第二个密码探测的 draft，也不能挤上一条用第一个密码完成认证的 master，然后把错误的机密报成好的。机密本身从不出现在名字里。
- **默认值是反着跑的。** 除非调用方先租到一个 socket，`sshOptions` 会给一次调用配上 `ControlPath=none`。Host 账户自己的 `~/.ssh/config` 可能声明了一个 `ControlPath`，而一个继承了它的子进程就会去共享一条这里没人计数的 master，用的还是没人挑选过的凭据。单靠 `ControlMaster=no` 还不够：它仍然会加入一条已在监听的 master。
- **热路径上不探测。** 台账持有的是一个*信念*。没有任何调用之前会跑 `ssh -O check`，因为 `ControlMaster=auto` 在 master 已死时会回落成一条全新的直连——先问一句，等于每次调用都花掉一整个进程，去打探一件子进程免费就能学到的事。
- **一次租约如何落定。** 抵达了会话的那次调用，会把 master 标记为存活。一次超时的调用，或打出 `SESSION_SETUP_PATTERNS` 之一（`session setup failed`、`too many sessions`、`channel open failed`、`ControlSocket … already exists`）的调用，会把它丢掉，好让下一次调用自己拨号。一次被拒的凭据，或一个被拒的 host key，两边都不落定：释放路径本来就会丢弃一条从未自证过的 master。
- **两个天花板，对应两种不同的代价。** `MAX_CONCURRENT_OPS`（16）计的是本地 `ssh` 子进程，那才是这台机器实际付出的东西。`MAX_LIVE_MASTERS`（8）计的是持有一条共享连接的服务器；当第九个到来时，最久安静的那条 idle 条目会用 `ssh -O exit` 退役，而当八条全在忙，后来者就独自拨号，而不是在某台服务器上开一场计划外的会话。拆除（teardown）子进程不占操作槽：关闭一个 socket 是一场本地对话，而且它在每个槽都满的时候也必须仍然可能。
- **服务器有自己的天花板。** `sshd` 的 `MaxSessions`（默认 10）为一条 master 可承载的通道数封顶，而一台配置得更低的主机是真实情形。这就是每目标 `pool: 'off'` 开关的用场：页面在 **Advanced options** 之下编辑它，模型把它看成一枚 `pool off` 徽标，而记录以 `pool` 承载它——这正是 domain 走到 version 5 的原因；version 6 则让全局槽位的那三个天花板变成"配置默认值的可选覆盖"。
- **`ssh -G` 什么都不租。** resolve 视图回答的是一个 alias 指向何处；在里面点名一条 control socket，等于描述一次该调用从未建立的连接。
- **一次页面探测会预热连接池。** 设置测试的拨号走的是 agent 调用所取的同一份租约，所以按下 `Test` 会留下下一条命令要乘的那一条连接——这也是探测会在一条租到的连接上要求 `-N` 的原因：它是回答"这份凭据能不能登录"最快、也最省的方式。
- **生命周期。** socket 目录是系统临时目录之下一棵 `mkdtemp` 的 0700 树，在激活时建立、在卸载时移除，与 askpass 辅助程序完全一样。一个 master 是 OpenSSH 丢在后台的一个进程，而不是这个 Host 仍在看管的一个子进程，所以一个被直接杀掉的 Host，会把每个 master 留在它各自的服务器上，直到 `CONTROL_PERSIST_SECONDS`（300）耗尽。

### 升级：一个属于应答本身的截止时间

`ops.runPromoted` 是一次前台 `exec` 的 0.0.26 形态，而它照搬 harness 自己的答案，并不另造一套：命令经由后台调用所用的那条同路的、不计时且具备作业能力的路径启动，随后插件**等待**它 `settings.remoteTimeoutMs` 那么久（`packages/shell/tool-bash/src/index.ts:508` 正是出于这个理由以 `onExpiry: 'none'` resolve，而 `:297-353` 会把台账等到底）。

- 在窗口之内落定 → 照常分类，一如以往。
- 到截止时间仍在运行 → `startRemoteJob` 接上那个活的子进程，调用以 `status: 'promoted'` 作答，带上 `jobId`、部分输出，以及一条点名 `job_output` 的 hint。`ok` 为真：这次调用在"移交"上是成功的，而把它读成一次失败的模型，会重启一个仍在进行中的构建。
- 被台账拒绝（每 owner 的作业上限）→ 子进程被杀掉，结果会说明移交被拒以及原因，而不是假装超时就是全部的故事。

有两个细节是承重的。provider 的偏移读取器是**不消费**的，所以随移交而来的那次部分读取，不会从作业那里偷走字节——已实测验证：移交预览带上了 `first-line`，此后的 `job_output` 同样带上了 `first-line`、`second-line` 以及 `exit=0 · 3377 ms`。因此一个 promoted 结果也**不**设置 `truncated` 旗：那个词意味着某道天花板裁剪了一条已经结束的流，而在这里流仍在被写入——0.0.26 的说法相反，于是渲染器继续报告一个从来就不需要的 spill 文件。而 `startRun` 增加了 `stdin`，因为一个提权命令的密码是在 spawn 时注入的：一个 promoted 调用已经答完了它的提示，所以把它移交是安全的，而以后台方式*启动*一次调用则永远不安全（`background: true` 配 `as`/`su` 仍然被拒）。

config 中的 `promoteOnTimeout: false`，或者一个没有作业台账的 profile，会保留那个普通的有界等待——也就是本插件出厂时自带的行为，仍是一条代码路径，而不是一个特例。

### 工具（`src/tool.ts`）

只有一个工具，`ssh_client`，经 `ctx.tools.register(defineTool(…))` 在 `ctx.effect` 之内注册——一个第三方 bundle 不需要 preset 条目：台账会自己把它的 schema 喂进系统提示的拼装（已安装的 `dsh-github-flow` bundle 就是这件事的活证）。

| 字段 | 形态 |
| --- | --- |
| `action` | `get_connection` \| `exec` \| `read` \| `write` \| `edit` \| `upload` \| `download`——`exec` 还接受 `background: true`——`read` 会根据该路径究竟是什么，返回目录清单、一个文件的文本，或一次拒绝——`edit` 还接受 `dryRun: true`，用于预览这次改动及其 diff，既不写入也不做任何备份 |
| `localPath`、`recursive` | 传输的本地一侧；相对路径在会话工作区之内解析 |
| `target` | id、显示名（任意大小写）、`host`，或 `user@host`；不填即指本会话所选的目标，其次是一个已保存的唯一目标 |
| `command` / `path` / `content` | 远程命令行、一个绝对远端路径，以及要写入的确切文本 |
| `background` | 用于 `exec`：让命令继续运行并返回它的 job id；用 `job_output` 轮询，用 `job_kill` 停止 |
| `tty` / `input` | 用于 `exec`：在 `ssh -tt` 之下运行（给一个会检查自己输出的程序），以及喂给它 stdin 的文本 |
| `as` / `su` | 用于 `exec`：提权——`as: "<account>"` 会加上 sudo 前缀（强制 `tty`，并把存储的登录密码注入作为应答；若未存储密码则用 `sudo -n`），`su: true` 会把命令放进 `su root -c` 之内运行，并用存储的 root 密码应答；一个显式的 `input` 会覆盖其中任何一种注入，而这两者都从不出现在结果或记录文本里 |
| `localPath` / `recursive` | 用于 `upload` 与 `download`：工作区一侧的路径，以及一个目录是否整体移动 |
| `oldText` / `newText` | 用于 `edit`：要查找的确切文本（从一次读取里复制而来）及其替换；空的 `newText` 表示删除 |
| `all` / `replaceFirst` / `backup` | 用于 `edit`：替换每一处匹配 / 只替换第一处 / 跳过 `<path>.dsh-bak` 那份副本 |
| `overwrite` / `append` / `mkdir` | 写入行为；`mkdir` 默认为 true |
| `timeoutMs` / `maxBytes` | 对共享天花板的逐次调用覆盖 |
| `output` | 按 action 各一个 `oneOf`，且每个都 `additionalProperties: false`；`execute` 返回规范值，而 `output.render` 写出记录文本。台账会拿那个值对照投影出的 schema 校验，所以一个漏掉了生产方所发出字段的分支，会让整次调用被拒——因此这些测试套件会用 `validateJsonSchemaValue` 校验每个 action 的 payload，而不只是校验其内容 |

关于那张字段表有两条说明，都由 `tests/tool.test.mjs` 钉住：

- 用一个显式的 `target` 参数点名一个目标，会把它记录为本次会话的选择（`rememberSessionTarget` 只为一次成功、且有意点名了服务器的调用写 `sessions` 行），于是下一次调用可以把 `target` 省掉。
- `parameters` schema 现在声明了 body 所读取的全部二十三个字段；直到 0.0.16，`edit` 与应答提示的那类调用所使用的那七个（`oldText`、`newText`、`all`、`replaceFirst`、`backup`、`tty`、`input`）都是未声明的，只靠一个防御性读取器才活下来；0.0.20 在旁边加了 `as`/`su`；0.0.32 为 `edit` 预览加了 `dryRun`；而 0.0.34 一个参数都没有改——移动的是其中两个字段所承诺的东西：`maxBytes` 现在说明它既是传输上限也是输出上限（并且单个文件是就着正在移动的那些字节而受限于它的），而 `timeoutMs` 说明一次拷贝的值还要覆盖它的前置检查与发布（publish）两步。
- 工具只为两个读取动作声明 `isConcurrencySafe`——`get_connection` 与 `read`——于是 harness 可以在同一个并行批次里运行若干个这样的。每一个会改动事物的动作都保持独占：transport *能够*并发运行变更，但这里没有任何远程文件系统能让 read-modify-write 成为事务；那份声明讲的是什么是可安全交错的，而不是这套管道能承受什么。

政策是在 `tools/pre-execute` 里决定的，不在工具内部，这正是工具编写文档针对部署政策所给出的处方：

| 调用 | 判定 |
| --- | --- |
| `get_connection`、`read`（一次目录清单或一个文件的文本）、`download` | allow |
| 携带 `as` 或 `su` 的 `exec` | **ask，永远如此**——sudo 是一把万能钥匙，而对内层程序的白名单命中从未同意过换用另一个账户；提示会点名那个账户，以及它将花掉哪一份已存储的机密 |
| `exec`，它那一个光杆的前导程序位于一个**非空**的 `allowedCommands` 之上 | allow——同一个判定也适用于一条后台化的命令 |
| `exec`，其它任何命令：一个未被列出的程序、一份**空白**名单（一个全新目标的默认，于是每条命令都要问），或者一条流水线 / 重定向 / 替换（没有单一前导程序） | **ask** |
| 任何 `ask`，发生在一个批准政策为 `never`（完全访问模式）的会话里 | **allow**——core 会按政策拒绝无人应答的 ask，所以在那里发问等于自我否决；这是部署有意陈述过的同意 |
| 任何 `ask`，其批准界面无法抵达——没有挂载 `approval` 服务，或没有可供路由的会话（`unavailable`） | **ask**，并由 core 以其 fail-closed 的否决作答——它会引述这道闸门交给它的那个理由，并且不追加任何东西，所以自 0.0.34 起那个理由会说明缺的是哪一块（"… refused because this conversation cannot be asked: this Host mounts no approval service, or the session has no route to one. Nothing was run…"）。一次实机的独立 Host 显示，较早的那个形态读起来恰恰像是出自人手的一次否决，那句话就是这样挣到了它的位置。自 0.0.30 起 `unavailable` 不再与 `never` 合并：没有谁能够同意，这件事本身并不是同意；于是一个没有批准界面的 profile 里的远程写入会被拒绝，而不是被悄悄执行 |
| `write`、`edit`、`upload` | **ask** |
| `download` | allow（它读服务器，并写进会话工作区之内，而后者已由文件管道掌管） |
| 一个 `agentAccess: off` 的目标上的任何动作 | deny，并点名设置页面 |
| 在闸门时刻存储不可读 | deny——在一台远程主机上盲跑更糟 |

这张表陈述的是 `decideAccess` 今天如何运行，而自 0.0.17 起，面向模型的字符串也陈述同一件事：`describeRemote` 告诉模型，一条命令只有在它的光杆前导程序被一份非空白名单点名时才会免问运行，而 `get_connection` 的渲染行会打印 `allowlist=none(ask every command)`——两者都由 `tests/tool.test.mjs` 钉住，它会断言描述与闸门对同一次调用的说法是一致的。（`0.10.0` 的本意就是这样；字符串在 3786005 处漂移了，而闸门从未动过。）

这两个开关自 0.0.31 起都在目标表单里编辑：一个 **agent access** 复选框（关闭时在行上显示一枚 `agent access off` 徽标），以及一个**免批准程序**字段。该字段是一份免批准清单，既不是沙箱也不是限制：它只决定哪些单程序命令可以跳过询问，它不限制一个被列出的程序可以收到什么参数，也无法让一次写入变得安全。页面自己的 hint 陈述的是同样的内容。

一次 `ask` 由 harness 的批准界面解决（`ctx.approval`，通过标准的工具批准界面作答），其中 `displayReason` 会同时以英文和中文给出，而一个缺失的 approval 服务会把一次 `ask` 变成一次否决，而不是一次崩溃。`never` 模式是部署有意陈述的同意，而"没有人能够同意"这种缺席本身并不是同意。工具主体只复查那道硬停止（`agentAccess`），因为它无从知道闸门是否已经取得了同意。

`ssh_client` 这个名字是一个共享的扩展点：先用 `ctx.tools.get` 试探台账，一个已被占用的名字会带着警告回落到 `ssh_remote`，而不是让 fiber 失败；试探与注册之间的竞态会重试一次。一个无关的注册故障仍然会向上传播。

### 客户端（`src/client.ts`）

只有一个容器组件持有这个页面：`SshSection` 拿着状态、`list` 读取以及全部操作，而三个区域是只接收「要渲染什么」的展示组件——`TargetRowView`（一行目标）与 `TargetFormView`（新建 / 编辑表单）属于 **SSH 目标**，`ClientParamsCardView` 是 **客户端参数**，`RuntimeCardView` 是默认折叠的 **运行状态与高级信息**。`apply` 先注册 `settings.ssh` 词典（两份基线 locale），然后注册两个座位，各自位于它自己的 `ctx.effect` 之内：

| 座位 | 注册 | 渲染 |
| --- | --- | --- |
| `settings.section` | `{ id: 'ssh', order: 25, label: () => ctx.locale.bind(NS)('nav'), locale: NS }` | 整个页面，含它的三个区域 |
| `settings.section.icon` | `{ id: 'ssh' }` | 光标 + 虚线链路 + 服务器机架，与 `icon.svg` 一致 |

设置外壳对插件 section 没有分组机制——一个 section 就是一条导航行——所以三个区域排在同一条滚动里，并按读者用得上的顺序：目标在前，参数其次，系统限制收在 `<details>` 后面（它默认不合上就没有成本：数据在挂载时读一次，展开时再读一次，折叠从不冻结任何计数）。曾经那两条标签页由此退场，vendoring 进来的宿主 `SegmentedControl` 如今只剩一个用途——登录方式那个 radiogroup；那段代码连它承载的 `role`、键盘走动与 token 契约一起留着（复制而非 import 的理由与细节见 `CHANGELOG.md` 里 0.5.1 之前的 vendoring 条目）。

卡片、行、字段与描边一律取设置外壳自己的 token：`--dsw-alias-settings-card-fill` / `-stroke` 是卡片，`settings-form` 的字段节奏（label 13/500、hint 12/tertiary、0.5px 分隔线、34px 输入框）是参数区，行与行之间用细线而非各自一个方框——这是「减少重复卡片与不必要的边框」在代码里的具体形状。

**默认目标这件事没有控件。** 存储结构里没有「默认」字段，而本轮不许改动它，也不许改动 target 的解析规则，所以页面不假装有开关：它标出的是 Host 本来的规则（`tool.ts` 的 `findTarget`，`ops.pickTarget` 与之同构）——点名的目标优先，其次是该对话上一次选的目标，只有一台服务器时就是它。因此清单里只有一台时，那一行带着「默认」徽标；有多台时，页面上没有全局默认可设，规则写在折叠卡片的信息段里。

控件与它们的样式表都是插件本地的（`dshssh-*` class，只使用 `--dsw-alias-*` token，无需把任何 Harness client 包作为模块引入），而且样式表是作为组件内部的一个 `<style>` 元素渲染的，好让卸载时把它一并移除。

## 已验证的契约

以下事实是对照运行中的 DSH（`0.2.2-rc.1`，`web` profile）核查过的——写于 0.2.0 的时代，并一路复查到 0.5.1（本文出现的插件编号是新规之前的，见 `CHANGELOG.md`）——并且为 0.5.1 那次修复对着活服务器复现过，好让下一轮不必重新推导它们：

- `ssh -G <target>` 是一个**本地**操作：它打印解析后的配置然后退出，并不拨号，所以 Resolve 按钮不会挂起、不会泄露机密，并且能即时回答关于 alias 的那个问题。插件只传入它自己的 port / key / jump / 额外开关覆盖，因此它打印出来的，正是一次探测将要拨号的内容。
- 连接共享，是在写 0.0.22 时对着活服务器（OpenSSH 10.0p2 客户端，`jiegg@10.100.1.1`）复现过的，所以连接池里没有哪一部分是建立在读手册之上的：`-o ControlMaster=auto -o ControlPath=<literal path> -o ControlPersist=300` 会让 master **在第一个客户端退出之后仍在运行**——socket 文件还在，而 `ssh -O check` 答 `Master running (pid=…)`——第二次调用乘上它；而 `ssh -O exit` 会答 `Exit request sent.` *并把 socket 文件移除*。此后对那条路径的 `-O check` 会以 `Control socket connect(…): No such file or directory` 加 exit 255 失败，而同一条已死路径上的一次全新调用会重新认证成功并 exit 0。最后那一行，正是连接池从不在热路径上探活的全部理由：OpenSSH 会在需要它的那次调用之内，免费地改用直接拨号来自愈一条死掉的 master。一条由字面路径（不含 `%h`/`%C` token）命名的 control socket，对 `-O` 同样有效，这才是让驱逐变得可瞄准的东西。
- **subprocess provider 本就掌管输出的保留；插件只是需要开口去要。** 一次流收集是 `{ maxBytes, spill?: { maxBytes } }`，而"省略 `spill` 就只保留内存里的尾部"是被文档化的行为（`packages/subprocess/subprocess/src/types.ts:38-52`）：当 `spill` 存在时，provider 把**尾部**留在内存里，理由是"错误与最终结果聚在末尾"，并把**完整**的流写入它自己那棵 per-process `mkdtemp` 0700 目录之下一个 `0600` 的文件（`packages/subprocess/subprocess-local/src/output.ts:126-128,160-213`），并在读取时把该路径报告成 `spillPath`。本插件直到 0.0.25 都只传 `maxBytes`，这就是"truncated"过去意味着"其余部分没了"的原因；它现在也会把 spill 预算一并传过去，并把那个路径带进结果与记录文本，用的是 bash 工具那种整句形态（`packages/shell/tool-bash/src/render.ts:11-15`）。一条大于 spill 上限的流，其文件会被丢弃——插件并不假装相反：它点名缺席之物，而不是凭空编造一次恢复。
- **`ssh -N` 在会留下一条 master 的时候，自己就会结束**——写 0.0.23 时在同一台活服务器上测得的，而探测正是建立在这之上：有了 `-o ControlMaster=auto -o ControlPath=… -o ControlPersist=300`，一次 `-N` 调用会为一条首连在 **0.2 s** 内认证成功并退出，越过一条预热的 master 则只用 **0.1 s**，并留下 `Master running (pid=…)`。而没有那些开关时，同一个 `-N` 调用会**挂住**（一个无事可做的 idle 会话，只在它的截止时间被杀）——因此探测只在一条租来的连接上要求 `-N`，并独自运行 `true`。一次被拒的凭据在 `-N` 之下仍会被诚实地点名（`Permission denied (publickey,password).`），而同一个错误密码用 `true` 跑时打印的却是 `Connection closed by … port 22`，本会被分类成 `unreachable`：更早的那个形态会把一个机密问题怪罪到网络头上。`Authenticated to … using "password".` 这一行在这个客户端里是存在的，但它只在 `LogLevel=VERBOSE` 才打印，而在那里它会被密钥交换的记录淹没，所以探测读取的是退出状态，而不是去追那一行。
- `fs/write-intent` 是一个单槽的**决策**瀑布：一个监听者可以回答 `createIfAbsent` 或 `replaceIfVersion`，却从不查看你的那次写入，因此插件必须按那个回答来行事——对一个已存在文件的 create-only 守卫就是一次拒绝，而一个版本守卫无法由一次外部拷贝兑现，并照此上报。会话变更记录器是通过它在 `tools/pre-execute` 所见那个 actor 的**对象同一性**来挂靠那次编辑的，这正是插件把活的工具执行体交进瀑布、而不是交一个赝品进去的原因。
- 文件传输，在活服务器上测得：**单个文件乘一条被计数的 `ssh` 通道，一棵树乘 `scp -r`**。`scp` 是**被探测出来的**那个 ssh 可执行文件的同门兄弟（`/usr/bin/ssh` → `/usr/bin/scp`，否则走它自己的 `PATH`-再-位置 搜索）；它把端口取作 `-P`（不是 `-p`），接受同样的 `-o BatchMode` / `StrictHostKeyChecking=accept-new` / `-i` / `-J` / `PreferredAuthentications` 开关，并把远端读作一个 `host:path` 参数，所以不涉及任何本地 shell。单个文件不走它：载荷是 `ssh` 远端一侧的一个 `cat`，而字节计数是在这一端取的——这是唯一一个能够就着正在移动的那些字节（而不是 `stat` 在它们移动之前所引用的那个数字）来施用天花板的地方。provider 的 `collect` 模式承载不了那个（一个 400 MiB 的应答会变成 400 MiB 的 spill 文件），但它的 `stdout: 'pipe'` 与 `stdin: 'pipe'` 处置是调用方自有的裸流，而一次拷贝在任何一面都不要求 spill。一个读取者已经离开的 `cat` 会死于 `EPIPE`/`SIGPIPE`——已实测——所以停下本地子进程，也就停下了远端那一半。
  - **落地，两个方向。** 一次下载会写一个唯一的 `.dsh-part-<pid>-<entropy>` 兄弟文件，只在干净完成之后才把它改名到位；一次上传会*在服务器上*落进一个兄弟文件，然后再取走它的最终名字。替换一个已存在的文件是*穿过*它发生的（`cat -- part > dest`，以后台作业的方式运行，好让这个搬运者有一个属于它自己的 pid 可以上报）：在活服务器上测得，`scp` 做的是同一件事——inode、`mode 640`、owner，以及第二个 hardlink 全都熬过了那次覆盖写，而该 link 的另一名字看到了新的字节。一次 rename 本来会把这三者全部悄悄破坏掉。一个新名字会被改名，然后穿过服务器的 umask 带上源文件的权限位（`777` 在 `umask 0022` 之下到达时为 `755`，`640` 仍是 `640`）——而且这个 mode 必须用三次赋值来算，因为 `chmod "$(printf '%o' $(( … ) ))"` 在 `sh` 或 `dash` 下解析不了，而在 `bash` 下会递给 `chmod` 一个空参数、把文件落在 mode `000`。一次被停住的上传会移除它的临时件；一次失败的 publish 会把完整的字节留在原处并说明情况。
  - **递归是另一桩承诺，并且会说清是哪一个。** `scp -r` 的布局之所以被保留，是因为它正是调用方所期望的布局：一个缺席的目标*变成*那棵树，一个已存在的则持有 `dest/<basename>`，而 symlink 会被跟随（实测：一个被链接的目录到达为真实目录，一个被链接的文件则带着其目标的 mode）。它的天花板是前置检查——上传是那次防环的本地走查，下载是一次 `find -L … -printf '%s\n' | awk` 枚举，其后还藏着一个 `-maxdepth 0 -printf` 探测，好让一台没有 GNU `find` 的服务器不至于被读成一个空目录。一棵树从不*边移动边被计数*：那需要一个 archive，而一个 archive 会悄悄改变一个 symlink 的含义。
  - **`~/` 需要那个斜杠落在引号之外。** schema 一直都允许这种写法，而一个被完全引起来的 `'~/f.txt'` 对 shell 来说并不是同一个词：一个 tilde 前缀在第一个*未被引起来*的斜杠处结束，所以旧的那种形态到达服务器时是一个字面量，而 `cat` 回答 `No such file or directory`——在 `sh`、`dash` 和 `bash` 里，无论用于读取还是用于重定向，都已实测。`~/'f.txt'` 可用，`~'/f.txt'` 不可。
  - `rsync` 在这台机器上缺席，因此不被使用。
- 批准是两个互相独立的开关：文件沙箱（`read-only` / `workspace-write` / `danger-full-access`）掌管写入，而 `ApprovalPolicy = 'ask' | 'never'` 掌管到底是否要征询一个人。`'never'` 是在 `ApprovalService.decide` **之内**、在 `approval/request` 瀑布被派发**之前**决定的（`packages/interaction/user-approval`），所以一个插件监听者无法在那里救回一次 ask；生效的政策是 `overrideOf(session) ?? config.policy ?? 'ask'`，两者都可在公共的服务界面上抵达，而 `ctx.get('approval')` 无需 inject 就能读到它。
- 抢占一个 `tool.call.toolview` 的 key 会**彻底**替换掉那一通用行：owner 此后必须覆盖每一个阶段（`preparing` / `start` / `result`）与每一个动作，带上那个座位的 `useDisclosure`、`openFile`、`inspect`、`cwd` 与 `home`，并且参数在已密封时从 `argsRaw` 读、在流式进行期间从那个惰性的 partial-JSON 视图读（在渲染时读，从不按 block identity 键控着存进 state）。本插件试过那条路并放弃了它：拥有那层外壳，并没有买到渲染出的记录文本本身尚不曾说出的任何东西。
- 一个被 spawn 出来的子进程**没有终端**：stdin 被忽略，而 Host 进程也没有挂在任何一个终端上。这使得交互式的 host-key 提问无从回答，而这正是 0.5.1 那次修复的全部内容——`accept-new` 是记录而不是询问（OpenSSH 7.6+，而本机跑的是 10.0p2）。一个变了的 key 仍然会失败，它的 `Offending … key in` / `Remote Host Identification Has Changed` 输出会被分类为 `unknown-host`。
- 被收集的那些流，只有在 provider 终止了子进程并把它们排空之后才算完整，所以一次撞上截止时间的探测会先为 `waitForExit` 最多等 400 ms，然后再去读它们；少了那次排空，一个超时根本不带任何原因。
- 一个被打断的子进程，一个原因。`#settleAndDrain` 用来自 `@deepseek-ai/dsh-timeout` 的 `deadline(external, timeoutMs, SSH_TIMEOUT)` 构造它的等待，该函数经 `AbortSignal.any` 把调用方的信号与插件的计时器融在一处——第一个 aborter 的原因就是幸存下来的那一个，而 `timeoutOf(signal, SSH_TIMEOUT)` 只在计时器胜出时才读到我们自己的。手写的那一版是在计时器回调内部去解析 `external?.aborted`，于是一个在与它的截止时间同一瞬被杀的子进程，会被报成代码碰巧先测的那一个分支。一个 `timeout` 如今意味着服务器太慢，而一个 `cancelled` 意味着是读取者停了它——两者之间再不是抛硬币。`timeoutMs: 0` 意味着不上计时器，这正是一个后台化的、或被升级的作业熬过启动它的那个应答的方式。自 0.0.30 起，每一个远程动作都把该工具调用自己的 `exec.signal` 沿这条链向下转发——`exec`、`read`、`write`、`edit`、`upload`、`download` 都会在会话取消该调用时、或在所声明的调用预算到期时，了结它们的本地子进程；而这套管道早在有任何东西递给它一个信号之前，就已经存在于 transport 之中了。诚实的边界在于：那杀掉的是**本地**的 ssh/scp 进程。服务器侧的命令是否随其通道一起死去，那是服务器的选择，本插件不作相反的主张。
- 一次探测读的是那个账户的 `~/.ssh`，不是终端用户的。`list` 过去会报告 `runsAs`（`uid`、`user`、`home`），好让一张设置卡片能够点名那个账户；那张卡片在 0.0.21 被砍掉了——那个名字并不能敲定任何探测结果尚未敲定的事，而它的 `user` 取自 `process.env.USER`，是一个从启动该进程的人那里继承来的名字，而不是它的 uid 所能证明的那个。真正能敲定此事的事实，是那张卡片从未带上的那四个：解析出来的 `ssh` 路径、那个账户的 agent 是否持有任一 identity、被点名的 key 文件是否对它可读，以及那台主机是否已在该账户的 `known_hosts` 之中。

## 剩余工作面

旧的四项计划已经落地：agent 工具（0.6.0）、经由同一 transport 的文件传输（0.9.0），以及——穿过 0.15.0/0.16.0——一个伪终端、stdin 应答，还有 harness 作业台账上的后台作业；那些都是新规之前的编号，对应关系在 `CHANGELOG.md` 顶部的版本说明里。仍未闭合的是：

1. 一个可以实时敲入的终端：`tty` 加 `input` 能够回答一个提示，而 `background: true` 会把输出带外（out of band）流出，但并不存在一个交互式会话。
2. 可选项：把 `~/.ssh/config` 里的 alias 读成一份建议清单（`ctx.fs`）。
3. 试过并有意弃掉的：抢占 `tool.call.toolview` 座位，于是一次远程调用继续在 harness 的通用工具行里渲染——见 **已验证的契约** 之下那条说明。
4. 有意不做的几项，每一项都在 0.0.34 里对照已出厂的行为重新核查过，而不是假定它们已经陈旧：
   - **页面上没有每目标的 `remoteTimeoutMs` / `maxOutputBytes` 控件。** 求解层仍然会从存储的记录里兑现这两者（`bounds.ts` 先读 target，再 profile，最后才是默认值），因为存储的记录与页面自己的写入都可能携带它们，而丢掉那一层会在升级时改变一个原本可用的目标的天花板。*不在*那里的是一件控件：没有读者要求过按服务器逐个设置截止时间，而一张为单一共享表格显示 default / cap / in force 的卡片，就是 99% 那些问题的答案。一个每目标的值是由存储记录设定的，不是由 UI 设定的。
   - **页面上没有 `dryRun` 控件。** 预览是为模型存在的，由它读一个 diff 并决定是否应用。页面没有一个 diff 渲染器，也没有第二个确认步骤，而如果为了暴露一个复选框就同时发明这两样，造出来的会是一个比工具已经给出的那个更差的预览。
   - **`su` 保留。** 它是唯一的一种远程命令形态（`su root -c …`），由第三个机密槽位来应答；而替代方案——让一个 root 密码各不相同的用户去改用 `as`，并指望 `sudo` 存在——是拿一台受支持的服务器去换一个更小一点的文件。它不在待移除的清单上；它同样也不再生长。
5. 那些仍然只是前置检查的天花板，说破它们，好让没有人需要重新去发现：一次**递归**拷贝是在它移动之前被测量的（`limitMode: 'pre-check'`），因为 `scp -r` 无法被边移动边计数，而一个 archive 会悄悄改变一个 symlink 的含义；而一次受保护的 **edit** 只是收窄了并发写入者的窗口，并不是把它关上。spill 文件仍然是 subprocess provider 的——在此计数，从不在此回收。

## 0.0.34 的局限

- 设置页面只负责清单、探测、resolve 与天花板：跑命令、编辑文件与搬运字节，都是经由会话的 `ssh_client` 工具抵达服务器的——页面没有一个运行控制台、一个传输选择器，或一个作业列表。
- 一次探测读的是 **Host 账户**的 ssh 世界——它的 `~/.ssh/config`、keys、agent 与 `known_hosts`——不是终端用户的那个，所以在某个 shell 里可用的一个 alias，在这里仍可能解析出不同的结果。首次探测会记录一个未知的 host key，而不是询问。
- 关于这些修复，没有任何一处是生效的，直到运行中的 Host 载入新模块为止：一次就地的包替换会保留上一个，直到进程重启。
- 一次页面探测仍然只做认证并运行 `true`；真正的命令来自 agent 的 `exec` 动作。
- 一次前台调用会被等待到底。`tty: true` 会给命令一个伪终端（`ssh -tt`，代价是它的 stderr 会并入 stdout 以及 CRLF），而 `input` 会喂它的 stdin；`background: true` 会把命令交给 harness 的作业台账——调用以一个 job id 作答，输出经由 `job_output` 从 provider 自己的偏移处流出，`job_kill` 将它停止，而该作业直到落定都会占着那 16 个并发操作槽之一。显式后台化的作业被限制在那些槽中的 `maxRunningJobs`（默认 8）之内——那是现有 lane 计数器内部的一项预留，并不是第二个调度器——所以哪怕八个被弃置的长时命令，也无法把插件对前台工作 busy-lock 死。**这个天花板本身无法被抬到超出那份预留之上**（自 0.0.37 起）：配置 schema 的 maximum *就是* `16 − 8`，`bounds.ts` 会把任何仍带着更高数字的 settings 对象封顶，并在一条设置页面会显示的 note 里说明，而 transport 在它准入一个子进程的那一刻再以同样的方式钳一次——所以那八个被扣住的槽是代码的一项属性，而不是一条注释的产物，而一次拒绝所引用的数字，就是当时实际生效的那个数字。一次被该天花板拒绝的启动会点名它，并指向 `job_kill`；而自 0.0.34 起，这一拒绝是**就在提出请求的那个 frame 里**作答的——`status: 'refused'`，没有 id 可轮询——而不是先启动一个作业，再让那条 lane 过一个拍子把它变成一个失败的作业。一个作业不上自己的计时器：它在下列任一时刻结束——它落定、有人杀掉它、它的会话离去，或者 Host 退出——与 harness 自己的后台 shell 立的是同一桩约定。连接活在 Host 进程之中：停止该作业、结束该会话，或重启 Host，都会终结那条远程命令，而 `job_kill` 打断的是本地客户端——服务器侧的进程是否随会话一同死去，是服务器的选择。这里没有一个可以实时敲入的终端。提权（`as`/`su`）经由同一个 stdin 回答提示，所以它是一项仅前台的特性：一条带 `as`/`su` 的后台化命令会被带着 hint 拒绝；而如果服务器跑的是 NOPASSWD、并且命令自己写了 `sudo`，它依然可用。
- `edit` 会拒绝一个大于读取上限的文件，而不是去替换它从未见过的文本；并且自 0.0.34 起它**守卫自己要覆盖写的东西**：读取会在同一次往返里索取该文件的 inode、大小、纳秒级 mtime **以及 SHA-256**，写入则在那个执行截断的同一个 shell 里重新测量这两道守卫，而其间被察觉的任何改动都会以 `stale: true` 回来，什么都没写。在任何截断之前都会取一份安全副本——`backup: false` 时也一样，只是用一个私有的名字，并在写入通过验证后将其移除——写入既会对照它必须留下的字节数来检查，**也会对照它所发出的那些字节的摘要**来检查，因为一个长度并不是一份内容：13 个字节，可能是这次 edit 编成的那 13 个字节，也可能是别人写下的 13 个字节。随后一个修复（repair）子进程会在动手碰这个文件之前先看它一眼，并以"哪些结果是**真的**、以及**依据什么证据**"作答——一个 verdict（`landed`、`intact`、`restored`、`unrecoverable`），要么由一个摘要承载，要么仅由一个字节数承载。自 0.0.35 起，一个字节数换不来任何 verdict：在一台没有 `sha256sum`、`shasum` 或 `openssl` 的服务器上，0.0.35 会落地写入，并以 `ok: false`、`verdict: 'unknown'` 结束；**而自 0.0.36 起，这道检查被移到了写入之前**——读取会在产出那段文本的那次往返中就陈明 SHA-256，而当这台服务器没有工具可以陈明一个时，edit 会在复制或截断**之前**就拒绝：远端文件原封不动地保持被发现时的样子，没有 `.dsh-bak`，没有东西需要读回来再反复揣测，而一次 `dryRun` 仍然给出预览，同时说明与之匹配的那次真实 edit 会被拒绝。一次你无法验证的 edit，如今是一次你从未开始的 edit。`restored: true` 只有在某个摘要说明"本次调用所读到的内容已经回来"时才会置位。**它仍然是一个预览并确认的流程，而不是一个事务**：版本比较与截断之间的那道窗口，宽度是两个 shell 内建，而不是一次网络往返，而一个落在其中的写入者仍然会被覆盖掉。那次修复不可被调用方的 abort 取消——一个停下了 edit 的读取者，停下的是 edit，并不是这个文件"保持完整"的那项主张——它改为在自己的 30 秒预算下运行。`write` 与 `upload` 落下它们自己的字节；两者都不做版本管理，而这里也没有任何东西能在本插件背后把一台服务器回滚。自 0.0.32 起 `edit` 接受 `dryRun: true`：匹配会被计数，一个行 diff 会回来，而没有任何东西被写入、被备份，也没有任何拨号超出预览反正都需要的那次读取；在一台无法陈明版本的服务器上，预览会如实这么说，因为写入本来要执行的那道守卫，正是此刻缺席的那一道。
- 提权的提示与一个 `input` 正文共用那唯一的 stdin，而提示先读：带 input 的 `su` 会被事先拒绝，而只要存储了一份登录密码，带 input 的 `as` 同样会被事先拒绝。那唯一真实存在的共存——没有存储密码的 `as`，它运行 `sudo -n` 因而从不提示——继续可用：正文会在一台 NOPASSWD 主机上完好抵达，并在任何其它地方带着原因快速失败。
- 一个被点名的 `identityFile` 会随 `-o IdentitiesOnly=yes` 一起送达：少了它，一个持有多个 key 的 ssh-agent 会先把它们逐个递出去，而一台会计数尝试次数的主机，会在读取者点名的那一个 key 被尝试之前就先把它锁在门外。不点名任何 key 就什么都不加——客户端自己的默认值成立，agent 也包括在内——而目标额外参数里的 `-o IdentitiesOnly=no` 仍然会胜出，因为那些落在插件自己的开关之后。`ssh -G` 的 resolve 视图带上同样这一对，所以卡片显示的就是那些子进程实际在运行的东西。
- 一次传输的天花板对**单个文件**是硬性的，对**一棵树**是前置检查的，而每一个结果都带上 `limitMode` 来说明是哪一个在作答。一棵在枚举与改名之间长大了的树，会按实际落地的结果上报，并附一条说明；另一条路——把一个目录穿过 archive 带过去——会在途中改变一个 symlink 的含义，而 `scp -r` 的布局正是调用方已经在依赖的那个。一次递归下载还会在移动任何东西之前，拒绝落到一个非空的本地目录上：那次改名只可能失败，而在 0.0.34 之前，它是在拷贝完整棵树*之后*才失败、然后又将它删除的。
- 当一次拷贝被停下时，**本地**子进程已经不存在了：provider 会在整个 TERM→KILL 宽限期之间被等到结束，然后才给出应答，而 live check 证明没有任何属于我们的 `ssh` 还占着一个槽。自 0.0.36 起，插件还会尝试清理远端一侧：在一个搬运者开始之前，它会在 **stderr** 上为自己打印一行——`dsh-mover <pid> <tag> <starttime>`——而 stderr 正是那次拷贝已经在完整读取的那个通道；于是一次下载随后 `exec` 进入那个搬运者，使它先前报出的那个数字与实际持有该文件的进程成为同一个，而一次上传的 publish 会把它的搬运者作为一个后台作业来运行，于是 `$!` 点名的是搬运者，而不是那个在等它的 shell。自 **0.0.38** 起，那一行还带上内核自己为该 pid 记录的内核启动时间（读自 `/proc/<pid>/stat`，从最后一个 `)` 之后开始计数，好让一个进程名无法把它带偏）：一个 pid 是一个会被在不同进程之间转手的数字，而那个时间说的是究竟是哪个进程穿过它。一次拷贝被停下之后，有一条简短、有界、尽力而为的命令会请服务器结束**那一个身份**：它会检查 `kill -0`，从 `/proc/<pid>/stat` 读取启动时间，并把 `/proc/<pid>/cmdline` 一个参数一个参数地读出来，把这一对与本次拷贝所上报的内容相比较，把它的 argv 与本次拷贝所被给予的 argv 相比较，只有匹配才会付诸行动；一次匹配随后会被 SIGSTOP 冻结住——一个被停住的进程无法退出，所以在这个决策正在做出的期间，它的数字无法被回收——冻结状态下重新核查，然后才被杀掉。至于它为什么只能做到尽力而为，这是诚实测量出来的：一个阻塞在写管道上的远端 `cat`，会在通道关闭时立刻死掉，但一个停在 `open()` 上等待一个没有写入者的 fifo 的，从不触碰那条通道，所以一个不带 pty 的 sshd 会让它一直坐在那里（曾观察到它比自己的调用多活了几个小时）——关闭通道无法打断一个它并不身处其中的 syscall，于是这里改为请服务器向它发信号。0.0.37 改变的是*那一个究竟是哪个*进程：直到 0.0.36 为止，那次清理用的是 `pkill -f '[c]at -- <path>'`，而 path 恰恰是同一个文件的两份拷贝唯一共享的东西，所以打断一次拷贝，也就同时停掉了另一次的搬运者——而一个远端路径是允许包含 `[`、`*`、`?`、`+` 与 `.` 的，所有这些对 `pkill -f` 而言都是正则表达式语法。一个 pid 则不是。清理所得到的 verdict 是被如实上报，而不是被抹平：`gone` 什么都不主张（搬运者随通道离开了，或者已经结束而只是在等待被收割——一个 `Z` 状态应当读作 gone，而不是读作一个陌生人），`killed` 会点名那个 pid 并说明命令行**与启动时间**都在冻结与重查之前确认了它，`unverifiable` 则说明服务器没有为那个 pid 陈明一个可读的 `/proc`（或者那个搬运者没有记录时间），并且什么都没有被发信号——0.0.37 的 `killed-unverified`，也就是对着一个光杆数字的 SIGKILL，已经被退役，因为一个被回收的数字属于别人的工作——`foreign` 说明那个数字正在运行别的东西，因而被原样放过，`refused` 说明服务器不允许这个用户向它发信号，而 `unanswered` 说明清理没有得到任何回复，因而什么都不主张。一个*正在清理期间*退出的搬运者，会以它最终落到何处来作答：那个不再应答 `kill -0` 的数字读作 `gone`，而只有一个仍然立在那里、却读不出来的数字才读作 `unverifiable`。一份从未获得 pid 的拷贝什么都不杀，并说明那个残留是无名的。live check 会在同一条路径的两个搬运者之上把这一切都断言下来：在其中一次拷贝的清理之后，另一次的搬运者仍然被停在那里、仍然可以被交付，并且它的通道带着完整的载荷关闭（在 `proxy` 上测得，pid 2747830/2747840，2026-11-19 10:46）。0.0.38 在那次 live check 上补了两项拒绝：同一个搬运者，若以一个并非它自身的启动时间去瞄准，会答 `foreign` 并继续服务；而一个完全没有记录启动时间的，会在 `proxy` 与 `nas` 上都答 `unverifiable`——从来不会是 `killed`——（2026-11-19 14:10 测得，搬运者 pid 2893057 先被拒两次，随后才按它真实的身份被杀掉）。
- spill 文件——也就是当一条流越过其天花板时，由 subprocess provider 写下的完整输出恢复文件——仍然归**provider**所有。它拥有那个目录、负责关闭它们、把已完成的那些保留到进程之外的某个东西来清理它们，而这个 harness 里没有任何消费者会去 unlink 它们，所以本插件也不 unlink 其中任何一个。它所真正拥有的，是*询问*这一环：每个 Host 进程一份预算（总计 1 GiB、64 个文件），由 transport 持有，并被该进程所能抵达的每一个目标共享——不是每服务器一份，也不是每会话一份。授予从来不会被削减到剩余量（一个 provider 已经腾不出位置的 spill 文件会被*删除*，而那比根本没有文件更糟），所以这个数字是一个**停止条件，而不是一个硬性上限**：它约束的是询问何时停止，而不是那个目录最终长到多大。它对每个文件计入的，是 provider 就该文件所报告过的最大的整流偏移：一条后台流会随着文件的增长反复重读它自己的 spill，而自 0.0.36 起，每一次更大的报告都会按差额给台账补记——从不重复计入一个相等的，也从不退还一个更小的（磁盘上的一个文件不会缩小）——于是 `used` 会跟随实际写下的字节走，而不像直到 0.0.35 为止那样冻结在第一个数字上。能够越过它的是那个把预算掀过去的子进程，再加上当时正在途中的其它任何——一个子进程可以在它的两面都写，各自最多到 `maxSpillBytes`——所以在默认值之下，可达的天花板更接近 3 GiB 而非 1 GiB，而一个抬高 `maxSpillBytes` 的 profile 也会一并抬高它。当预算正是"没有文件"的原因时，应答会大声说出来。
- 插件自己的那些临时目录——askpass 辅助程序的，以及 control socket 的——都以造出它们的那个进程来命名，而一次启动时的清扫会回收一个已死的 id 留下的东西。一个早于该 id 的名字，则按三天的闲置来判断，而闲置是从*辅助程序自己的*时间戳读出来的；至于一条 master 仍能应答一次 connect 的 socket，则从不被碰。一个终究还是被从某个运行中的 Host 底下取走的辅助程序，会在下一次使用时被重建，而使用它会让它的时间戳保持年轻——这两点都是从某条规则的第一版那里学到的，那一版回收了一个活 Host 的辅助程序，只因为它的目录已经十三个小时大了。
- 一次传输的本地一侧是词汇层面的：`localPath` 按前缀对照会话的工作区目录匹配，且不解析 symlink——这是 `src/local-path.ts` 里公开写明的一项选择。因此一个种在工作区内部的 symlink，会把一次下载送到那个 link 所指向的任何地方；这道检查防住的是一个模型输入任意的绝对路径，它并不声称自己约束了 inode。
- 一次下载会在 `scp` 运行之前派发 `fs/write-intent`，并以该工具的执行体作为 actor，而这正是那次外部写入仍然能够进入会话变更摘要的方式（记录器从那个瀑布读取 before-image，并在回合结束时比对磁盘；它从不旁观那次写入本身）。插件随后并不发出 `fs/observed`——没有任何东西为那份变更列表需要它，而版本 token 属于执行那次写入的那一方。
- 插件主张工具名 `ssh_client`，在另一个 bundle 已经持有它时回落到 `ssh_remote`；而它压根不主张 `tool.call.toolview` 座位：一次调用会像其它任何工具一样，在 harness 的通用工具行里渲染。
- 凭据库对其它 OS 用户是私密的，但对 agent 并不是：工具进程是以那个同样能读 `.credentials.yaml` 的用户身份运行的。
- 删除 bundle 会把 `storages/ssh_targets.json`（目标、天花板，以及每会话的选择），以及插件在 `.credentials.yaml` 里的 `ssh/…` 记录，都原样留在那里，直到你亲手把它们移除。
- 在一次就地的包替换之后，运行中的 Host 会保留它此前的模块，直到重启为止。页面能够察觉这一点（`list` 报告没有 `askpass`），并把认证控件连同一段解释一起藏起来，而不是去发送一个旧模块会拒绝的字段。
- 打包发布已备好但未执行：`package.json` 去掉了 `private`，改带 `publishConfig.access: "public"`（CONTRIBUTING 对「计划发布到 npm」的要求）。实际打包清单已核对（`npm pack --dry-run`：50 个文件 / 285 kB，只有 `lib/`、`docs/`、`README.md`、`icon.svg`、`cordis.patch.yml`、`locale/*.json`，没有 `src/` 或 `tests/`），而 `npm publish` 回 `ENEEDAUTH`——这台机器上没有任何 npm 凭据。所以插件索引的状态仍是 `experimental`：`stable` 的定义是「已发布到 npm」，注册表里还不存在这个包时不能先写它。

## 许可

Apache-2.0——见仓库根的 [LICENSE](../LICENSE)。图标是本仓库维护者在同一许可之下创作的原创图形：一个终端光标由一条虚线连向一台服务器机架，不是任何第三方的标志。
