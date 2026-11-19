# SSH 插件 0.0.37 定向修复交付报告

- 包名：`@jie2gg/dsh-plugin-ssh`
- 基线：0.0.36（提交 `8e21eeb`）
- 本轮版本：0.0.37（提交 `db4244b` 源码改动 + `4689ed4` 独立安装校验脚本）
- 执行时间：2026-11-19 09:13 – 12:08（Asia/Shanghai，本报告内所有时间同区）
- 收尾复核：12:07:16 – 12:07:26 于正式目录重跑 check / build / 全量测试，结果见 8.3
- 执行环境：Debian 13 (trixie) 主机 `Harness.local`；node v24.22.2；pnpm 11.28.5；
  typescript 5.9.3；DSH 检出 `/data/deepseek-harness`；生产 Home `/data/dsh-home`；
  测试 Home `/data/dsh-home-test`
- 真实 SSH 目标（取自生产 profile 的存储，凭据只读不回显）：
  - `proxy` → `root@10.100.1.205`，登录 shell `dash`，GNU coreutils，`/proc` 可读，
    `pkill`/`pgrep` 均在，`mkfifo` 可用
  - `nas` → `jiegg@10.100.1.1`，登录 shell `bash 4.4.23`，`/proc` 可读，`pkill` 在、
    `pgrep` **不在**，`mkfifo` 可用，两个目标 `port` 字段为空（即 22）
- 发布结论：**READY WITH KNOWN LIMITATIONS**（见第十节）

本轮只做任务书列出的六件事，没有新增功能、没有架构重构、没有推倒 0.0.36。

---

## 一、本轮改了什么（源码清单）

25 个文件，`+2361 / -202`：`git diff 8e21eeb..HEAD -- ssh/` 已随包留档为
[SSH-PLUGIN-0.0.37-DIFF.patch](SSH-PLUGIN-0.0.37-DIFF.patch)（235,010 字节）。

| 文件 | 本轮改动 |
| --- | --- |
| `ssh/src/transfer.ts` | K-4：mover 自报身份、按 pid 清理、六种结论各自成句 |
| `ssh/src/transport.ts` | `streamFile` 无退出状态子进程不再算完成；`effectiveLaneCap` 在执行点夹 job 槽 |
| `ssh/src/edit.ts` | K-6：`verifyEditBody` 消费声明长度与声明摘要；摘要必须是 64 位十六进制 |
| `ssh/src/ops.ts` | 编辑前置完整性校验；K-1 的 dryRun 文案；`list()` 上报 job 通道与保留槽 |
| `ssh/src/storage.ts` | `FOREGROUND_RESERVED_OPS` / `MAX_JOB_LANES` 两个常量 |
| `ssh/src/config.ts` | job 通道 schema 封顶改为 `MAX_JOB_LANES`，注释与实现同值 |
| `ssh/src/bounds.ts` | 夹取越界 job 上限并写入 note；默认值与 schema 同源 |
| `ssh/src/client.ts` | 老 Host 兜底探测超时 10 s → 30 s；新增后台任务行；文案改写 |
| `ssh/src/tool.ts` | `get_connection` 增加 `jobs` 字段与槽位说明句 |
| `ssh/scripts/live-check.mjs` | 新增 `reap` / `jobcap` / `framing` 三个真机用例；修 `localProcesses` 的列宽缺陷；`release` 用例升级到新文案 |
| `ssh/scripts/clean-lib.mjs` | 新增：构建前清空 `lib/` |
| `ssh/scripts/independent-install-check.mjs` | 新增：打包→独立安装→哈希比对→真机调用 |
| `ssh/tests/*.test.mjs` | 离线用例 285 → 317，一条未删，断言普遍变严 |
| `ssh/{CHANGELOG,README,docs/DETAIL,docs/DETAIL.zh}.md` | 与代码同步，不留旧说法 |

---

## 二、K-4：远端进程清理隔离（P0，已修复）

### 2.1 0.0.36 的实际缺陷（本轮亲测反例）

0.0.36 用 `pkill -f -- '[c]at -- <远端路径>'` 清理滞留 mover。它确实匹配不到自己那条
清理命令的 shell，但两个并发任务搬同一个远端路径时，**路径正是它们唯一共享的信息**。
本轮在 `proxy` 真机上按插件的原始进程形态复现（2026-11-19 10:40 前后，脚本
`/tmp/k4reap-audit.sh`，逐行输出留档）：

```
[6] movers holding /tmp/k4live/f1 before old-style cleanup: 2
[6] old pkill exit=0; movers left: 0        ← 0.0.36 的写法把两个 mover 一起杀掉
```

同一对 mover 换成按 pid 清理：

```
[1] reap A -> dsh-reap killed
[1] A dead: OK ；[1] B alive: OK ；[1] movers left: 1
[2] reap A again -> dsh-reap gone
[4] B finished whole: OK
```

第二个反例是**清理时机之外的错杀**：一个被回收去跑 `sleep 30` 的 pid，用 0.0.37 的
身份核对返回 `dsh-reap foreign`，`sleep` 进程存活——按路径匹配则无法区分。

另外两条 0.0.36 的隐患本轮一并消除：`remotePathSchema`
（`ssh/src/storage.ts:46`）允许空格、`[ ] * ? + . # ~ '`，而这些字符对 `pkill -f` 的
ERE 全是语法；0.0.36 在没有 `pkill` 的服务器上完全无法清理（`nas` 上没有 `pgrep`，
说明这类残缺环境真实存在）。

### 2.2 现在的机制

1. **每次传输一个任务身份**：`entropy()` 从 pid + 3 字节随机数加宽为 pid + 4 字节
   （`[a-z0-9]-[a-f0-9]{8}`，同一 Host 进程内碰撞概率 1/4.3e9）。同一个 tag 既写进
   `.dsh-part-<tag>` 临时名，也写进 mover 的 marker，离线用例断言两者必须相等
   （`tests/transfer.test.mjs:778` 「the copy has one identity…」）。
2. **mover 自报进程号**（`ssh/src/transfer.ts:809` `downloadMoverCommand`）：
   `printf 'dsh-mover %s %s\n' "$$" '<tag>' >&2; exec cat -- <路径>`。
   `exec` 是关键：sshd 起的 shell 被 `cat` 原地替换，报出的号就是 mover 本身。
   真机直接验证过这一点（proxy/dash 与 nas/bash 各一次）：marker 里的 pid 与该进程
   `/proc/self/status` 的 `Pid:` 完全一致（`2694816/2694816`、`26221/26221`）。
   marker 走 **stderr**：stdout 是文件载荷本身，不能污染。
3. **发布落地那步同样报号**（`publishCommand`，`ssh/src/transfer.ts:1055`）：脚本在
   mover 之后还有 `rm -f` 要做，所以 shell 不能 `exec`，mover 必是子进程；改为
   `cat -- part > dest & mp=$!; printf marker "$mp"; wait $mp && rm -f part`。
   本地 dash / bash / sh 三种 shell 实测：成功场景 rc=0、目标内容正确、part 已删；
   失败场景（目标是目录）rc 非 0、part 保留、服务器自己的报错原样回到 `why`。
   `mv`（新建名）分支不带 marker——rename 不会滞留，缺号时明说「没杀任何进程」。
4. **清理只认这个 pid**（`reapMoverCommand`，`ssh/src/transfer.ts:846`）：
   `kill -0` 探活 → `/proc/<pid>/cmdline` 用 `tr '\0' '\n'` 逐参数读出 →
   `sed -n 1p/2p/3p` 与 `cat`、`--`、路径逐条**纯字符串比对**（路径先赋给变量 `p`，
   所以 `~/x` 在服务器端和 mover 得到同样的展开，也不受 glob 干扰）→ 匹配才 `kill -9`。
   只需要 `kill`/`tr`/`sed`，不再需要 `pkill`/`pgrep`。
5. **清理失败不再虚报**：`gone`（跟随通道自行退出，保持沉默）/ `killed`（已核对命令行）/
   `killed-unverified`（无 `/proc`，只凭号码）/ `foreign`（号码已属别的进程，没动手）/
   `refused`（服务器不许这个用户发信号）/ `unanswered`（清理子进程没答上来）——
   每种一句实话，`moverVerdictNote()` 单测逐条钉住。拿不到 pid 时也说一句实话，
   而不是当作已经打扫干净。清理预算仍是 `min(statTimeoutMs, 10s)`，原资源保护不变。
6. **顺带修掉的一个假成功**（真机测出，属 K-4 同一条红线）：本地 `ssh` 被信号打死时
   stdout 是**干净 EOF**、子进程**没有退出状态**，0.0.36 把这对读成「复制完成」，
   于是一次还在认证阶段就被取消的下载报成 `moved`、交付 0 字节、落地一个空文件、
   **并且跳过了本该执行的 mover 清理**。现在没有退出状态的子进程只有在我们自己
   动手拆的时候算中断，别人打死的情况也算 `error`，绝不算成功
   （`ssh/src/transport.ts:1389-1420`，用例 `tests/transport.test.mjs:948`）。

### 2.3 K-4 测试覆盖（按任务书清单逐条）

| 任务书要求 | 覆盖位置 | 类型 |
| --- | --- | --- |
| 同一路径并发两个下载 | `tests/transfer.test.mjs` 「two downloads of the same remote path…」 | 离线模拟 |
| A 超时、B 正常，清理 A 后 B 必须继续 | `scripts/live-check.mjs --case=reap` 第 1 段（pids 2785358/2785368：A killed、B 仍 parked、喂写者后 B **payload-for-B 完整交付**且 exit 0） | 真实 SSH |
| 同一路径多个并发任务 | `reap` 第 1、2 段（两个 mover 同一路径；重复 stop 三轮） | 真实 SSH |
| 不同路径并发 | `reap` 第 2 段（两条 fifo 各一个 mover，分别清理互不影响） | 真实 SSH |
| 空格、括号、方括号、美元符等特殊字符 | `reap` 第 2 段用 `/tmp/…/reap a b [x] * ? + .f`；单元用例「a path with shell and regex metacharacters…」；门禁用例把 `$()`、`;`、`` ` `` 归为**被门禁拒绝**的一侧 | 真实 SSH + 离线 |
| 本地取消 | `reap` 第 4 段（`AbortController`）；`release` 用例同样断言取消路径 | 真实 SSH |
| SSH 连接中断 | `reap` 第 5 段（对本地 `ssh` 子进程 pid 3553602 直接 SIGKILL，插件自身拆除完全不参与；回答即 2.4 摘录里的「无退出状态」句） | 真实 SSH |
| 远端清理失败 | `reap` 第 3 段（`foreign`）+ 离线用例（`refused`、`unanswered`、拿不到 pid） | 真实 SSH + 离线 |
| 重复超时后的残留进程检查 | `reap` 三轮 timeout/cancel 每轮计数 0；`[2] re-reap=gone` | 真实 SSH |

### 2.4 真实 SSH 记录（proxy，2026-11-19 11:33:35 – 11:35:16，日志 `/tmp/live-proxy-37d.log`）

`reap` 用例 23 项检查全部通过，逐字摘录（pid 即该次运行的真实进程号）：

```
✓ two movers of one path are parked on it at once — pids 2785358 and 2785368, 2 movers
✓ the first copy ends its own mover, confirmed from that mover's command line — dsh-reap killed
✓ the mover that belonged to the other copy is still parked — pid 2785368 alive
✓ and exactly one mover is left on the shared path — 1 left
✓ a cleanup run twice says gone, and never claims a second kill — dsh-reap gone
✓ the surviving copy still delivers its payload whole after the other was reaped — "payload-for-B\n"
✓ and its own channel closes cleanly, not as a killed transfer — exit 0 signal null
✓ a mover is parked on each of two paths — pids 2785425 / 2785477
✓ each is ended by its own cleanup, on a path whose name contains shell metacharacters — dsh-reap kil | dsh-reap kil
✓ the odd path holds no mover afterwards — 0
✓ a cleanup aimed with another copy's path word refuses to kill — dsh-reap foreign
✓ and refusing costs the mover nothing — pid 2785535 still alive
✓ the same cleanup, aimed correctly, ends that mover — dsh-reap killed
✓ copy stopped on its deadline (round 1/2/3): refused, and its mover accounted for — failed, 0 mover(s)
✓ a locally cancelled copy is refused as a cancellation and leaves no mover — failed, 0 mover(s)
  · the local ssh child 3553602 was SIGKILLed mid-copy, so the plugin's own teardown never ran for that channel
  · copy whose channel was cut: failed — The copy ended without an exit status: the local ssh died on
✓ and what it says about the mover matches what the server holds — 0 mover(s) left; claimed an ended mover: true
✓ either the mover is gone, or the copy named the residual rather than hiding it — gone after 223 ms
✓ and no note ever claims a path-wide kill
```

第 6 条修复（无退出状态不再算成功）也在同一次运行里被真机证据坐实：本地 `ssh` 被外力
SIGKILL 后，插件给出的正是
`The copy ended without an exit status: the local ssh died on a signal, so this plugin
cannot say how much of the file arrived.`，而它随后仍然按自报 pid 清掉了自己的 mover。

`framing` 用例（同一日志）逐字摘录：

```
✓ a read of bytes that are not UTF-8 notices on the server, not only in a parser — {"ok":false,"reason":"not-the-same-bytes","bytes":11,"declared":9,…}
✓ and the file it refused is the file that was there — cc9634cea7d1
✓ a 20 KB body of multi-byte text frames as itself — {"ok":true,"evidence":"digest"}
✓ the count the server stated is the file it stated — 22000 vs 22000
✓ a file that begins with the protocol's own words keeps its first line — "ssh-plugin: 1|2|3\nssh-pl"
✓ a body short of the stated count is refused by the count — {"ok":false,"reason":"body-short",…}
✓ and so is one the stream made longer — {"ok":false,"reason":"not-the-same-bytes",…}
```

同一用例在 `nas`（bash 登录 shell、无 `pgrep`）的机制层审计同样通过（10:36 – 10:37，
`/tmp/k4n.sh`）：`[1] reap A -> killed；B alive；left=2`（nas 上多一层 wrapper 进程，
计数含它），`[6] 0.0.36 pkill rc=0 left=1`（两个 mover 仍被一起杀掉）。

**验收判定**：清理目标唯一性已由「mover 自报 pid + `/proc` 命令行核对」证明；
无法证明时不动手并如实报告。K-4 通过。

---

## 三、K-6：edit 协议专项安全验收（P0，协议保留，消费端补上）

### 3.1 九项源码检查逐条结论

| # | 检查项 | 结论（0.0.36 实况 → 0.0.37 处理） |
| --- | --- | --- |
| 1 | marker 生成与解析 | 生成端 `buildEditRead`（`ssh/src/edit.ts:267`）三行 marker + 正文；解析端 `splitEditVersion` 按位置、最多三行、且必须**前缀 + 值形状**双条件。设计正确，保留。 |
| 2 | 正文长度是否真正用于字节级截取 | **缺陷**：`ssh-plugin-bytes:` 由服务器声明、解析器也返回了 `bodyBytes`，但调用方 `ops.editRemote` 只解构 `version/digest/content`，**把 bodyBytes 丢掉**（0.0.36 `ssh/src/ops.ts:1387`）。离线用例当时只断言「surfaced for a caller to verify」，没有任何 caller 去 verify。 |
| 3 | 长度是否基于 UTF-8 原始字节 | 声明值来自服务器 `wc -c`（原始字节，正确）。消费端此前不比对；本轮 `verifyEditBody` 用 `Buffer.byteLength(body,'utf8')`，即正文的 UTF-8 字节数——对合法 UTF-8 文件与磁盘字节相等，对不合法文件**必然不等**，正是它成了泄漏信号。 |
| 4 | 协议头是否只在规定位置识别 | 是：从头往下连续消费，识别到第一条非 header 即停止，第四行以后绝不再当 header。保留。 |
| 5 | 正文里的协议前缀是否会被误识别 | 不会：形状测试（`STAT_TOKEN` / `DECIMAL_OR_EMPTY`）挡住 `ssh-plugin: 一句普通话`；`tests/edit-shell.test.mjs:99` 用真实 `/bin/sh` 读一个每行都像 marker 的文件，正文逐字节返还。 |
| 6 | 旧协议兼容分支 | 两 marker（无 bytes）与零 marker 两种旧形状仍按原语义读取；本轮新增离线用例明确覆盖（`tests/ops.test.mjs` 「a read that states no framing still edits…」）。 |
| 7 | 长度不符 / 截断 / 多余数据是否拒绝 | **本轮修复**：此前一律不拒。现在 `body-short` / `body-long` / `not-the-same-bytes` 都在匹配之前、dryRun 之前拒绝，且不产生 `cp -p`、不产生 `cat >`。 |
| 8 | 摘要是否针对实际截取的正文计算 | 写后校验的 `expectedSha256` 本来就是「本次送出文本」的摘要——它证明的是通道，不是磁盘文件。**本轮补上写前**：`digestHex(正文)` 必须等于服务器对磁盘字节算出的摘要，才算这份正文就是那个文件。 |
| 9 | 失败恢复是否恢复原始内容 | 0.0.36 已实现且保留：修复子进程按 `landed/intact/restored/partial/unrecoverable` 五种结论 + `digest/sizeonly/none` 三种证据回答，只有摘要证据才允许说 restored。`tests/edit-shell.test.mjs:126/146` 真机回归通过。 |

结论：**没有推翻协议**（marker 一行未增删、顺序未改），只把「协议已经声明、调用方
没有兑现」这一半补上。这正是任务书要求的处理方式。

### 3.2 内容丢失反例（本轮亲自复现，属发布阻断级）

对真实 `/bin/sh` + 真实文件（不是 mock），文件起始字节 `FF 41 0A`，正文里另有 ASCII 词
`TARGET`，替换这一个词：

```
declared bytes: 9   actual body bytes: 11
digest stated: cc9634cea7d1   digest of body: 24d599173f97
0.0.36 would write: "\ufffdA\nKEPT"  ok: true
write exit: 0  evidence: digest  -> 0.0.36 calls this contentVerified: true
first byte before/after: 0xff -> 0xef      file identical: false
```

也就是说：一个非 UTF-8 文件被编辑后，磁盘上 `FF` 变成 `EF BF BD`，而 0.0.36 手里每一项
检查都通过（它比的长度是自己送出的长度，它验的摘要也是同一串替换字节的摘要），还对外
宣称 `contentVerified: true`。这就是「可能造成用户正文丢失」的实例。
0.0.37 在写入之前以 `not-the-same-bytes` 拒绝，文件原封不动。

同类被挡住的还有：正文被截短（`body-short`）、载荷之后多出服务器塞进来的行
（`body-long`）、marker 行被误当正文首行（长度核对兜住）。

### 3.3 K-6 测试覆盖（按任务书清单逐条）

| 任务书要求 | 覆盖位置 | 类型 |
| --- | --- | --- |
| 正文首行含 `ssh-plugin:` / 第二行含 `ssh-plugin-sha256:` / 含 `ssh-plugin-bytes:` / 含全部前缀 | `tests/edit.test.mjs` 「a file that speaks the plugin's own header vocabulary keeps its first line」；`tests/edit-shell.test.mjs:99`；`scripts/live-check.mjs --case=framing` 真机一条 | 离线 + 真机 |
| 正文首尾为空行 | `tests/edit-shell.test.mjs` 「leading and trailing blank lines」 | 真实 shell |
| 中文、多字节 UTF-8、emoji | 同上（CJK + 🎉 + tab/CRLF + NUL）；`live-check --case=framing` 用 20 KB 多字节远端文件 | 真实 shell + 真实 SSH |
| 特殊字符和换行 | 同上（NUL、CR LF、无末尾换行） | 真实 shell |
| 空文件 | 空文件摘要 `e3b0c442…` 视为**有摘要**，不当作「没有摘要」；两个用例分别钉住 | 离线 |
| 大文件 | `framing` 用远端 20 KB；`edit-shell` 用本地 200 KB 多字节文件；离线另有 read-ceiling 截断拒绝回归 | 真实 SSH + 真实 shell |
| 声明长度大于 / 小于实际正文 | `tests/edit.test.mjs` 「a declared byte count catches…」；`tests/ops.test.mjs` 两条端到端拒绝；`framing` 真机一条 | 三类齐 |
| 正文被截断 / 正文后多余字节 | `live-check --case=framing`：「a body short of the stated count…」与「and so is one the stream made longer」；`tests/ops.test.mjs` 「…the stream carried more than the file」 | 真实 SSH + 离线 |
| 摘要不匹配 | `tests/edit.test.mjs`（digest 分支）、`tests/ops.test.mjs`（拒绝且只有一个 read 子进程）、`tests/edit-shell.test.mjs`（非 UTF-8）、`live-check --case=framing`（远端 latin-1） | 三类齐 |
| 编辑失败后的恢复完整性 | 保留 0.0.36 用例并新增：每条拒绝路径都断言 `server.file` 未变、无 `cp -p`、无 `cat >` | 离线 + 真实 shell |

**验收判定**：真实缺陷（消费端未兑现协议 + 非 UTF-8 正文静默改写）已修复并有反例、
原因、代码与回归；协议本身保留。K-6 通过。

---

## 四、后台 job 槽位与前台保留（P1，已修复）

### 4.1 规则（现在三处同源）

- `ssh/src/storage.ts:66`：`MAX_CONCURRENT_OPS = 16`、新增
  `FOREGROUND_RESERVED_OPS = 8`、`MAX_JOB_LANES = 16 - 8 = 8`。
- `ssh/src/config.ts`：job 通道专用 schema `jobLanes = natural().min(1).max(MAX_JOB_LANES)`，
  `DEFAULTS.maxRunningJobs = MAX_JOB_LANES`。配置里写 12 直接报错：
  `$.maxRunningJobs expected number <= 8 but got 12`（本轮亲测）。
- `ssh/src/bounds.ts:126`：`readBounds` 再夹一次，并把纠正写进 `notes`
  （「…the configured 16 is outside the range 1 to 8, and this plugin runs it as 8 —
  8 of the 16 operation slots stay held back for foreground calls」），note 随
  `list()` 回到设置页。
- `ssh/src/transport.ts:170` `effectiveLaneCap()`：在 `laneRoom` 与 `#takeLane`
  **同一个函数**取上限，所以「先问」和「真领」不可能给出两个数；拒绝文案引用夹后的值。
- 文案一致性：job 通道的 hint 不再建议「去配置里调高」，改说清这是结构性保留。

### 4.2 测试与真机记录

离线（`tests/transport.test.mjs:381` 起）：`maxRunningJobs = 16` 的设置对象下，
8 个 job 全部准入、第 9 个被拒且引用 `At most 8 background jobs`、随后 8 个前台
子进程仍可填满 16 槽、第 17 个被 `At most 16 remote operations` 拒绝、全部结束后
`inFlight` 与 job 计数归零；`effectiveLaneCap` 逐一断言（job 16→8、9→8、8→8、1→1，
传输 16 不夹）；`MAX_CONCURRENT_OPS - MAX_JOB_LANES == 8`。
`tests/bounds.test.mjs` 另加：默认值 == schema 上限 == `MAX_JOB_LANES`、
配置写 `MAX_JOB_LANES + 1` 抛错、夹取产生 note 且 `resolveSettings` 把同一 note
带回调用侧、`maxRunningJobs = 1` 时 `notes` 为空（少要槽位是选择不是错误）、
0 会被抬到 1。

真实 SSH（`scripts/live-check.mjs --case=jobcap`，proxy，2026-11-19 10:55:47，9/9 通过）：

```
✓ eight background jobs are admitted, whatever the ceiling asked for — lane 8, table 8
✓ the ninth is refused at the cap that is in force, not at 16 — At most 8 background jobs may run at once…
✓ and the refusal says the ceiling cannot simply be raised — … 8 is as high as this ceiling goes…
✓ a foreground command runs with the job lane full — RESERVE_OK
✓ the reserved half of the table is open for calls that wait: 8 jobs plus 2 commands, 6 slots spare
✓ a lane configured to one job holds one job, and no more — At most 1 background jobs…
✓ the whole reservation returns after the smallest lane ends — in flight 0
```

（说明：真机没有把 16 条通道全打满，因为 `MaxSessions` 会成为被测对象；16/17 的边界由
离线用例用真实子进程驱动。）

### 4.3 设置页与运行行为一致（P1 第 5 条）

`list()` 新增 `bounds.maxRunningJobs`、`bounds.maxConcurrentTransfers`、
`bounds.concurrentOps`、`bounds.foregroundReservedOps` 与 `pool.jobs`；
`ssh/src/client.ts` 在共享连接卡片里多一行「同时在跑的后台任务数：上限 8，正在跑 0 ·
16 个操作槽位中为等待结果的调用保留 8 个」，并在 `ssh/src/tool.ts` 的
`get_connection` 摘要里加了同样一句，模型也能看见。

---

## 五、探测超时默认值统一（P1，已修复）

- 事实：Host 默认 `probeTimeoutMs = 30_000`（`ssh/src/config.ts:175`，自 0.0.23 起），
  Web 端老 Host 兜底是 `10000`（0.0.36 `ssh/src/client.ts:939`）。页面展示的探测时间
  比实际拨号预算少 20 秒。
- 修复：兜底改为 `30_000`，并把这一行的注释写清来历；文案由
  「Probe timeout is fixed at / 探测超时固定为」改为「Probe timeout in force /
  当前生效的探测超时」——它早已是可以改的配置，不该说成固定。
- 新回归 `ssh/tests/client-fallbacks.test.mjs`（3 个用例）：把页面兜底对象从
  `src/client.ts` 源码里解析出来，逐字段与**运行中的 Host 的 `list()` 负载**、
  `DEFAULTS`、`storage.ts` 常量比较；断言 `probeTimeoutMs == DEFAULTS.probeTimeoutMs
  == bounds.probeTimeoutMs == bounds.effective.probeTimeoutMs`、且不等于旧的 10 000；
  断言页面优先采用 Host 现值（源码里必须存在
  `bounds?.probeTimeoutMs ?? limits.probeTimeoutMs` 等三处）；断言老 Host（无
  `bounds`、无 `pool`）时相关行整体隐藏而不是套用本轮数字；并断言页面用到的每个字典
  key 在 en/zh 各有一份定义。
- 覆盖矩阵：新 Host 返回 bounds（`tests/ops.test.mjs:48` 断言 `bounds.probeTimeoutMs
  == 30_000`）；老 Host 不返回 bounds（client-fallbacks 兜底比对）；bounds 缺
  `probeTimeoutMs`（`resolveSettings` 一律带出该字段，且兜底路径存在）；页面展示值与
  实际预算一致（同一用例的 `effective` 比对）。

---

## 六、正式源码归档与独立安装（P1，已解决）

1. **归档位置**：`main` 原本既没有 `ssh/` 目录，README 插件索引也写着「暂无」；全部
   开发都在 `.agents/worktrees/ssh-plugin-scaffold/ssh/`。经用户确认，本轮把
   `ssh-plugin-scaffold` 分支**快进合并进 `main`**（`main` 是它的祖先，58 个文件全部是
   `ssh/` 与仓库级 AGENTS/CONTRIBUTING/README，无无关改动），正式源码路径为
   **`/data/deepseek-harness-plugins/ssh/`**（提交 `db4244b`、`4689ed4`）。
   README 插件索引随合并登记了 `ssh/`（`experimental`）。
2. **不依赖开发 worktree**：在正式目录里独立执行 `pnpm install --prefer-offline` →
   `pnpm run build` → `pnpm run check` → 全量测试 → `pnpm pack`，全部成功
   （2026-11-19 11:43:33 – 11:44:10），构建过程不涉及 worktree 路径。
3. **lib 与 src 对应**：新增 `scripts/clean-lib.mjs` 在每次 `build` 前清空 `lib/`；
   已确认 `lib/ssh.js` / `lib/ssh.d.ts` 是 0.0.31 拆分前探测模块的旧编译产物，
   全包（`src`、`lib`、`tests`、`scripts`）零引用；删除后不再重生成的证据是：
   清理后 `lib/` 内 **每个 `.js` 都恰好对应一个同名 `src/*.ts`**（21 : 21），
   脚本会断言这一点。
4. **打包产物**：`/tmp/ssh-pack-final/jie2gg-dsh-plugin-ssh-0.0.37.tgz`，
   266,756 字节，50 个条目，
   `sha256 = c1006ab490ae30f9149bc87285f5d59605c9d8a03b7c149b2f6ade97ed283f75`。
   0.0.36 报告记录为 52 条目，差的正是那两个陈旧文件。
5. **独立目录安装验证**：`scripts/independent-install-check.mjs`（本轮新增，2026-11-19
   11:52:09 – 11:53 执行，**18 项检查 0 失败**）把 tarball 装进一个全新项目的
   `node_modules`，然后证明：安装版本 == 源码声明版本；声明的入口文件都在；
   包里没有构建未产出的文件；没有陈旧模块混入；安装出的 42 个 `lib` 文件与刚构建的
   输出 **逐一 sha256 相同**；`lib/` 与 `src/` 一一对应；bundle patch 与
   `lib/index.js` 导出完好；用安装副本装配的 `ops` 回答 `list()` 并给出
   `{maxRunningJobs: 8, reserved: 8, probe: 30000, jobs: 0}`；用**真实**子进程提供者
   对 `proxy` 探活 `reachable in 385 ms`、执行一条远端命令 `succeeded`；
   由安装副本构造出 `ssh_client` 工具定义（7 个 action 齐全，声明预算
   1,957,000 ms > 最长路径）。
6. **生产 Host 的安装指向**：`/data/dsh-home/profiles/web` 的 `package.json`、
   `pnpm-lock.yaml` 与 `node_modules/@jie2gg/dsh-plugin-ssh` 符号链接已从 worktree
   改指 `/data/deepseek-harness-plugins/ssh`（改前有
   `package.json.bak-0.0.37-repoint` / `pnpm-lock.yaml.bak-0.0.37-repoint` 备份）。
   验证：`readlink -f` 得到正式目录；从 profile 路径 `import` 该包的
   `lib/index.js` 成功求值（导出 `Config, apply, inject, name`），11 个依赖与 peer
   全部可解析。插件清单侧 `plugin_manager list_bundles` 显示
   `@jie2gg/dsh-plugin-ssh` `version 0.0.37`、`enabled: true`、行 `include:ssh`。
   **没有重启、没有切换运行实例**；`install_bundle` 因同名已安装返回
   `already-installed`，其 `nextStep` 要求先 `remove_bundle`——那会改动在线 profile，
   因此没有执行，改用链接重指（用户已授权）。
7. **删除临时 worktree 的影响**：正式目录已自带 `node_modules` 与 `lib/`，生产 profile
   的链接已不再指向它，因此删掉 `.agents/worktrees/ssh-plugin-scaffold` 不再影响正式
   安装产物。worktree 本轮**保留未删**（它仍是 0.0.36 历史与 0.0.37 提交的可追溯现场）。

---

## 七、K-1 与 K-8：保留并回归

### K-1（写前摘要能力检查）

- 0.0.36 的 fail-closed 逻辑原样保留：无可用摘要时在 `dryRun` 分支之后、
  `cp -p`/`cat >` 之前直接返回，不落备份、不截断。
- 本轮只改不准确的地方（任务书第七节）：
  1. 有摘要能力时 dryRun 的 `hint` 仍是那句「不带 dryRun 就会应用这次改动」——保留；
     新增离线用例断言这一句只在有摘要时出现，且此时不带 `notes` 警告
     （`tests/ops.test.mjs:448` 起）。
  2. 无摘要能力时 hint 改为「这台服务器给不出可用 SHA-256，同一调用不带 dryRun 会被
     拒绝；关掉这个开关并不会让编辑生效」，`notes` 同步说明「在复制和写入之前就拒」。
  3. 无摘要时无论 dryRun 与否都不写：用例断言 `cp -p` 与 `cat >` 子进程数为 0、
     服务端文件字节不变（`tests/ops.test.mjs:435` 段），真机由
     `live-check --case=capability` 复现（本轮 proxy 通过）。
  4. 额外收紧：服务器报出的 SHA-256 若不是 64 位十六进制，现在一律按「没有摘要」
     处理（`splitEditVersion` 的 `DIGEST_HEX` 形状判断），走同一条 fail-closed 路径，
     而不是拿一句关于文件的话去比对。这条改动顺带保证了 K-6 的摘要比对有意义。

### K-8（spill 增量计费）

- 核心修复保持 0.0.36 形态（`Map<path, 已计费最大 offset>`，只补差额），本轮**未重写**。
- 新增一条回归用例（`tests/spill.test.mjs:186`）：三个 job 交错上报同一批 spill 路径时，
  账本按每个文件的最新大小补差、文件数按 3 而不是 9 次上报、预算耗尽后
  `ask()` 授予 0 并给出「1400 of 1000 bytes already written」这句实话、
  已授予但被拒的调用不产生计费、已结束的任务不退款（`used` 不会倒退）。
- 软阈值描述仍然准确：`ssh/src/spill.ts` 头部与 README 都写明这是
  **stopping condition, not a hard cap**；默认最坏情况仍表述为「接近 3 GiB」
  （1 GiB 预算 +  tipping 时已在途的子进程两脸 × 64 MiB）。本轮没有改动这段边界，
  也没有把它说成硬上限；`tests/spill.test.mjs:104/119` 仍钉着常量与「允许越过一次、
  下一次被拒」的行为。

---

## 八、完整自动化测试报告

按任务书要求分四类，执行者均为本轮，不把历史报告数字当作本轮结果。

### 8.1 静态检查

- `pnpm run check`（`tsc -p tsconfig.json --noEmit`，strict +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）：
  2026-11-19 11:43:33 于正式目录执行，**无诊断**。
- `node --check scripts/live-check.mjs`、`node --check scripts/independent-install-check.mjs`：
  通过（每次改动后均跑）。
- 仓库里没有配置 eslint/oxlint 到本插件（沿用 0.0.36 的口径：类型检查即静态检查）。

### 8.2 构建与打包

- `pnpm run build`：`clean-lib` → `tsc` → `finalize-client`，
  `lib/client.js` 以 classic script 产出 103,687 字节、1 个 module entry；
  2026-11-19 11:43:36 与 11:57:45 两次执行均成功，产物不含 `lib/ssh.js`。
- `pnpm pack`：50 条目 / 266,756 字节 / sha256 `c1006ab4…ed283f75`。

### 8.3 离线自动化（模拟层）

| 时间 | 命令 | 结果 |
| --- | --- | --- |
| 2026-11-19 09:22:44（基线，改动前） | `pnpm run build && node --test tests/*.test.mjs` | 285 tests / **285 pass** / 0 fail / 0 skipped |
| 2026-11-19 11:15:12 | 同上（worktree） | 317 / 317 pass / 0 fail |
| 2026-11-19 11:43:40 | 同上（**正式目录**） | **317 tests / 317 pass / 0 fail / 0 skipped**，耗时约 1.5 s |
| 2026-11-19 12:07:16 – 12:07:26（**提交后收尾复核**） | `pnpm run check` → `pnpm run build` → `node --test tests/*.test.mjs`（正式目录，全部已提交状态） | 类型检查无诊断；构建清空 `lib/` 后重建，`lib/client.js` 103,687 字节；**317 / 317 pass / 0 fail / 0 skipped**；`lib/ssh.js` 确认不存在 |

分文件计数（本轮在正式目录逐个文件运行统计，2026-11-19 12:02，合计 317）：
`ops` 58、`tool` 48、`transport` 41、`transfer` 37、`edit` 26、`edit-shell` 18、
`pool` 15、`tmpgc` 14、`spill` 12、`bounds` 11、`storage` 11、`client-fallbacks` 3（新文件）、
`jobs` 5、`local-path` 5、`rpc` 5、`approval` 4、`askpass` 4。
差异统计：`git diff 8e21eeb..HEAD -- ssh/tests` 共新增 33 条 `test(...)` 声明、
删除 1 条——那一条是 0.0.36 的「no-pkill server」用例被改名重写为更强的
「cleanup child could not be asked」版本（旧断言只覆盖 `exit 127` 一种残留说法，
新断言覆盖 `unanswered`、`foreign`、`refused`、无 pid、以及「绝不声称杀过路径」），
**没有任何测试主题被删掉**；净增 32 条与被改严的既有断言（job 上限必须引用夹后的值、
编辑夹具的字节数与摘要必须与正文自洽、下载必须携带同一 tag）同时生效。

### 8.4 真实 SSH（`scripts/live-check.mjs`）

| 目标 | 时间 | 结果 | 日志 |
| --- | --- | --- | --- |
| `proxy`（root@10.100.1.205） | 11:33:35 – 11:35:16 | **167 检查 / 0 失败**（exit 0），覆盖 17 个用例（含新增 `reap` 23 项、`jobcap` 9 项、`framing` 6 项） | `/tmp/live-proxy-37d.log` |
| `nas`（jiegg@10.100.1.1） | 11:35:16 – 11:36:57，复跑 11:38:43 – 11:40:24 | 161 / **5 失败**，两次运行失败集合完全相同（不是抖动） | `/tmp/live-nas-37b.log`、`/tmp/live-nas-37c.log` |

`nas` 的 5 项已归因为环境差异，且**在 0.0.36 基线上同样复现**（基线检出
`git archive 8e21eeb` → `/tmp/ssh-036/ssh`，独立构建后执行）：

- 4 项属 `tree` 用例（递归下载枚举与随后一次 `remote()` 取不到 stdout）：
  11:33:32 基线 `--case=tree --target=nas` 复现同样的 4 项与同一条异常栈。
- 1 项属 `edit` 用例的硬链接计数（`links=1 → links=1`，那台机器上 `ln` 未生成第二名字）：
  11:42:23 基线 `--case=edit --target=nas` 复现同一失败文本（25 passed, 1 failed）。
- 补充探测：`find -L … -printf`、`stat -c '%a %s'`、`umask` 在 nas 上单条都能跑通
  （11:45 用 0.0.37 库 + 真实 provider 直测），说明是并发/会话层面的环境差异，
  不是本轮改动引入的判断错误。

### 8.4.1 本轮顺手修掉的两个**测试工装**缺陷（会影响以往结论的可信度）

1. `localProcesses()` 用固定 6 列宽切 `ps` 输出，而这台机器已有 7 位 pid——列宽一变
   就永远匹配不到本地 `ssh`/`scp` 子进程，0.0.36 记录里
   「no local ssh child of ours is left behind」实际是**空集上的通过**。现在按列切分，
   该检查与 `reap` 第 5 段（对本地子进程 SIGKILL）才真正工作（11:33 运行留下
   `the local ssh child 3553602 was SIGKILLed mid-copy` 这条证据）。
2. 真机计数 mover 时必须用**未加引号**的 argv 形态（`cat -- /tmp/…`）：加了引号只会
   匹配到还没 exec 完的 sshd 会话行，于是「清理后仍有 1 个 mover」是计数错形而非
   产品残留。两条都在 `scripts/live-check.mjs` 注释里写明，避免下一轮再被同一处绊倒。

（这说明 0.0.36 报告中「清理在 213 ms 内见效」这类结论虽然方向正确，但其**并发**含义
当时并没有被任何自动化检查覆盖；本轮把它变成了 `reap` 用例的显式断言。）

### 8.5 产品 Host 验证

- 插件发现：`plugin_manager list_bundles` 列出
  `@jie2gg/dsh-plugin-ssh` `version 0.0.37`、`enabled: true`、行 `include:ssh`
  （2026-11-19 11:51 读取；此时 `source` 仍是 worktree 的 `link:`）。
- 安装来源（重指后，2026-11-19 11:54 – 11:55 逐项在盘上核对）：
  `profiles/web/package.json` 的依赖说明符、`pnpm-lock.yaml` 的 `link:` 值、
  `node_modules/@jie2gg/dsh-plugin-ssh` 符号链接三者一致指向
  `/data/deepseek-harness-plugins/ssh`；`readlink -f` 落到该目录，
  从其 `package.json` 读出 `@jie2gg/dsh-plugin-ssh 0.0.37`。
  再从 profile 侧 `import('…/lib/index.js')` **求值成功**（导出
  `Config, apply, inject, name`），11 个 dependencies/peerDependencies 全部可解析。
  插件管理器没有独立状态文件（`.plugin-manager/` 只有安装日志），安装来源以
  profile 的 package.json 为准，因此这三处一致即为装配事实；清单里 `source` 文本
  的重扫发生在下一次 inventory 刷新，本轮没有把它当作已验证项。
- 运行实例调用：`ssh_client get_connection` 在 11:55 返回的边界句仍缺少本轮新增的
  「background jobs at once …」从句，证明**在线进程仍执行 0.0.36 的模块**（0.0.37 的
  字节已在链接目标位置，等待下一次自然重启加载）。本轮按要求未重启、未切换实例。
  顺带说明为什么不会出现「半新半旧」：插件的 `lib/index.js` 在激活时一次性把它用到的
  模块全部载入，运行期没有懒加载入口；就地替换 `lib/` 只影响下一次激活。
- 独立安装的功能验证（真实 provider + 真实服务器）见 6.5 的 18/18。
- 模型驱动的 SDK 会话（`scripts/t10-approval-check.mjs`，需要模型凭据与
  `/tmp/t10-patches/*`）本轮**没有重跑**；我试过用它的路子启动一个测试 Host
  （11:56，`profile: sdk`、`dshHome: /data/dsh-home-test`，start/close 成功返回），
  但那次启动没有写出新的 startup 日志，因此**不把它算作 Host 级激活证据**，
  只留下「测试 profile 已能解析正式目录」这一事实。

---

## 九、暂不处理事项与本轮的一致性补丁

任务书第九节列出的项（per-target 超时控件、sessions 生命周期治理、locale 拆分、
`configUpdate` 字段命名、设置页实时刷新、后台任务管理 UI、清单导入导出、连接复用重构、
gate 与执行层寻址合并）本轮一律未动。

其中唯一被要求补测的一条——**gate 与执行层寻址规则的一致性回归**——已加：
`tests/transfer.test.mjs` 新增两条用例，一条枚举 8 种「门禁放行」的路径形状（空格、
方括号、`*` `?` `+` `.` `#` `~`、单引号、制表符、`~/`），断言 mover 命令、清理命令里的
路径**三者是同一个 shell 词**，且清理命令里不出现 `pkill`/`pgrep`；另一条枚举 12 种
「门禁拒绝」的形状（`; | & < > $( ) ` 反引号、CR、LF、相对路径、空前缀）并断言
`~/x` 这类必须展开的形状仍按 `~/'x'` 的形式交给远端 shell。
真机侧由 `--case=reap` 用含空格与 glob 字符的路径、`--case=tilde` 用 `~/` 路径覆盖。

---

## 十、剩余问题与风险

| 编号 | 事实 | 影响 | 本轮处理 |
| --- | --- | --- | --- |
| L-1 | `proxy` 真机上偶发一次清理子进程「问不到答案」（11:19 运行中 3 轮里 2 轮）。原因是超时中断的复制会**顺带停用共享 master**，紧接着的清理子进程要重新拨号 | 该场景下插件不会谎报清理成功，而是给出 `unanswered` 句；残留数为 0，实测无害 | 已作为 `unanswered` 路径的证据保留在日志；不改共享 master 停用策略（属连接复用重构，任务书第九节明确排除） |
| L-2 | `killed-unverified` 只在非 Linux 或 `/proc` 被 `hidepid` 遮蔽时出现，此时只凭记录的号码动手 | 理论上存在「pid 已回收」的极小错杀窗口 | 文案明确说明没有命令行核对；真机 proxy/nas 都走 `killed` |
| L-3 | 后台任务被 `job_kill` 时，杀的是本地 `ssh` 子进程；远端**用户命令**若卡在不动的 syscall 里仍可能滞留（0.0.36 即如此） | 与 K-4 同类的资源残留，但对象是用户命令而非搬运进程，插件无从知道该命令的形状 | 未扩大范围处理，已在 README/DETAIL 的清理章节说明边界；后续轮可考虑为 job 也加 marker 身份 |
| L-4 | `nas` 真机 5 项失败（tree 枚举、硬链接计数） | 与 0.0.36 基线完全一致，属该环境差异；已在第八节给出基线复现证据 | 不视为本轮回归；留作 nas 环境待查项 |
| L-5 | 复制时限会连带压缩连接预算：`ConnectTimeout = max(1, min(10, timeoutMs/3000))`。当一次复制**没有**共享 master 可乘（目标 `pool: off`）时，1.5 s 的时限只给到 1 s 拨号预算，对需要密码 askpass 的 `proxy` 不够，表现为 `The copy exited with 255` | 只影响刻意把时限设到几秒以内、且关掉连接复用的调用；默认 300 s 传输时限对应 10 s 拨号预算，实测正常 | 未改算法（它属于任务书第九节排除的 per-target 超时一组）；真机 `reap` 用例因此改用「等到槽位被占用后再动手」与共享连接的组合，并在注释里写清这个边界。另外一处曾被我误判：`independent-install-check` 第一次报 `connect … port 22022: Connection refused` 是**测试夹具自己的默认端口**（`tests/helpers.mjs` 的 `record()` 缺省 22022，而存储里两个目标都没有 `port` 字段），不是产品行为，已按 live-check 的写法修正 |
| L-6 | `main` 现在领先 `origin/main` 73 个提交、`ssh-plugin-scaffold` 领先 origin 同名分支 17 个提交；registry 未发布（0.0.37 未 `npm publish`，`private: true` 仍在） | 版本可追溯性依赖本机；协作者看不到远端 | 本轮**没有推送、没有发布**（任务书禁止事项），需要用户另行决定 |
| L-7 | 生产 Host 的在线模块仍是 0.0.36，直到下次重启 | 新语义（job 上限、清理身份、字节完整性校验）在正在运行的实例里尚未生效 | 已按授权重指安装来源并验证可解析/可求值；未重启实例 |
| L-8 | 编辑正文必须是「能通过 UTF-8 往返」的文本，否则本轮改为拒绝（K-6 的 `not-the-same-bytes`） | 对二进制/混合编码文件，`edit` 现在不可用，需用 `read`/`download`/`write` | 属安全侧收紧，文案给出三条出路；未新增字节级编辑能力（不在本轮范围） |

---

## 十一、发布结论

**READY WITH KNOWN LIMITATIONS。**

- 三项发布阻断项全部通过并有真机证据：
  **K-4** 并发误杀已消除（清理目标 = 本次任务自报 pid + 命令行核对；无法证明即不动手）；
  **K-6** 正文完整性已由协议自身声明的字节数与摘要在执行端兑现（反例已复现、已拒绝）；
  **正式源码与安装来源可复现**（`main` 上的 `ssh/`、独立构建、独立安装 18/18、
  产物哈希留档）。
- 「已知限制」指第十节 L-1 … L-8：均为边界说明、环境差异或未纳入本轮的策略，
  其中 L-6（未推送、未发布）与 L-7（在线进程仍是 0.0.36，等待自然重启）需要用户决定
  下一步动作。
