# SSH 插件 0.0.38 定向修复交付报告

- 项目：`@jie2gg/dsh-plugin-ssh`
- 基线：0.0.37（commit `555685a`，其代码 commit 为 `db4244b`）
- 本轮：0.0.38，定向修复 K-6、K-4 并做完整回归与交付闭环
- 任务性质：先确认问题、再最小修复、最后以可复核证据交付；不是重构
- 本轮提交（正式源码目录 `/data/deepseek-harness-plugins/ssh`，分支 `main`）：
  - `202624b` ssh: a digest that matches no longer waives the byte count it has to agree with（K-6）
  - `e5348a2` ssh: a mover is cleaned up by its identity, and an unverifiable number is left alone（K-4）
  - `336a2c0` ssh: 0.0.38 — the delivery docs say what the two guards now enforce（文档与版本）
  - `a1816c6` ssh: a mover that leaves while the cleanup reads it is gone, not unverifiable（K-4 verdict 精确化，稳定性轮次中抓到）
  - 其后：0.0.38 交付报告与本 patch 的归档 commit
- 完整差异：[SSH-PLUGIN-0.0.38-DIFF.patch](SSH-PLUGIN-0.0.38-DIFF.patch)（`git diff 555685a..HEAD -- ssh/`，109,748 字节，13 个文件）

本报告只陈述**本轮亲自执行**的验证；引用 0.0.37 及更早结论之处都标明为历史记录。

---

## 一、本轮改了什么（源码清单）

| 文件 | 改动 |
|---|---|
| `ssh/src/edit.ts` | `verifyEditBody`：字节数与摘要拆成各自独立的必要条件（K-6） |
| `ssh/src/transfer.ts` | mover marker 增加内核启动时间；清理脚本改为 身份对 → SIGSTOP → 复核 → SIGKILL；`killed-unverified` 退役、新增 `unverifiable`；僵尸态归入 `gone`（K-4） |
| `ssh/tests/edit.test.mjs` | 新增 K-6 专项回归（摘要正确、声明长度错误必拒） |
| `ssh/tests/edit-shell.test.mjs` | 新增真机 shell 下的 marker 篡改用例 |
| `ssh/tests/ops.test.mjs` | 把 0.0.37 钉住“摘要凌驾计数”的用例反转为钉住新规则；mover 命令形状断言同步 |
| `ssh/tests/transfer.test.mjs` | 新 marker/新脚本前缀/新 verdict 词汇同步；新增端到端 `unverifiable` 场景 |
| `ssh/tests/transfer-shell.test.mjs` | **新增文件**：18 个用例，真 `/proc` 下的 PID 生命周期、A/B、哨兵、竞态 |
| `ssh/scripts/live-check.mjs` | reap case 增加「活 mover 配错时间→foreign」「无时间→unverifiable」；framing case 增加 K-6 篡改声明长度断言 |
| `README.md`、`docs/DETAIL.md`、`docs/DETAIL.zh.md`、`CHANGELOG.md`、`package.json` | 文档同步与 0.0.38 版本号 |

未触碰：连接池、审批体系、edit 协议其余部分、传输架构、UI、既有测试的删除或降级（唯一被反转的 `ops.test.mjs` 用例是 K-6 要求推翻的旧语义本身）。

---

## 二、K-6：编辑协议的双重校验（P0，已修复）

### 2.1 0.0.37 的实际缺陷（本轮亲测复现）

0.0.37 的 `verifyEditBody`（`src/edit.ts`）在标明了摘要时直接以摘要一票决定：

```ts
if (digest !== undefined) {
  if (digestHex(body) === digest) return { ok: true, evidence: 'digest' }
  ...
}
if (count !== undefined) { ... }   // 只有没有摘要时才走到这里
```

本轮对 0.0.37 已构建产物直接复现（命令与输出）：

```
$ node --input-type=module -e "… verifyEditBody('alpha\nbeta\n', {bytes: 999, digest: <正确值>})"
digest-correct, declared-length-wrong => {"ok":true,"evidence":"digest"}
```

即：**正文 11 字节、marker 声明 999、摘要正确 → 0.0.37 判成功**。摘要匹配完全跳过了长度核验。
这与 0.0.37 交付文档「逐一比对，不一致就拒」的描述不符（文档声称的行为要到 0.0.38 才成立）。

没有证据表明它已造成正文丢失（两 marker 由服务器同一条命令先后生成，正常读取不会互相矛盾）；
本轮把它定性为协议校验不完整，修复并加反例钉死。

### 2.2 现在的机制（0.0.38）

- 声明的字节长度**无条件核验**（服务器声明了就必须与正文实际字节数一致）；
- 声明存在且相符 → 再核验摘要；摘要不符 → 拒绝（保留原有精确诊断，`not-the-same-bytes`
  的 message 仍同时陈述两数的关系，hint 仍指向「非 UTF-8 / 读中被改」的正确诊断方向）；
- 摘要相符但声明长度不符 → 新拒绝：`body-short` / `body-long`，message 明确说明
  「字节确实摘要相符——这正是读取自相矛盾之处」；
- 任一失败都在匹配、dryRun 预览、复制、截断**之前**返回失败，服务器文件不动；
- 失败不会被降级为成功，也没有任何新增 fallback。

两项是独立必要条件，摘要不再豁免字节数；同时原先被摘要证明成立的正文（两数一致）照旧通过，
原先被摘要否决的正文（非 UTF-8、读中被改）仍由摘要否决——收紧只发生在「两 claims 互相矛盾」
这一类，0.0.37 曾把这类放行。

### 2.3 K-6 测试覆盖（对照任务书 3.3 矩阵）

本轮新增：

| 场景 | 用例（测试名） | 结果 |
|---|---|---|
| 摘要正确、声明长度偏大 | `a matching digest does not waive the byte count the same read stated (K-6)`（`edit.test.mjs`） | 拒绝 `body-short` ✅（修复前该用例失败，已在旧 lib 复现） |
| 摘要正确、声明长度偏小 | 同上 | 拒绝 `body-long` ✅ |
| 正文为空、声明 3、摘要为空文件的正确值 | 同上 | 拒绝 `body-short` ✅ |
| 真机读取 + 篡改声明长度（digest 保持正确） | `a tampered byte marker is refused even though the digest still matches (K-6)`（`edit-shell.test.mjs`，真 `/bin/sh` + `sha256sum`） | 两方向均拒，文件未动 ✅ |
| 两 claims 一致 | 上述两测试的对照断言 | `{ok:true, evidence:'digest'}` ✅ |
| ops 层端到端（读取→校验→拒写） | `a matching digest no longer outranks a disagreeing byte count — K-6 closes the waiver (0.0.38)`（`ops.test.mjs`，反转自 0.0.37 的钉桩用例） | 写前拒绝、无备份、无截断、dryRun 同样拒 ✅ |
| transfer 层真实服务器读取 | `scripts/live-check.mjs --case=framing` 三条新 check（proxy 与 nas 各跑） | `body-short` / `body-long` / 一致仍过 ✅ |

矩阵其余行（正文含 marker 前缀、空行、CRLF、多字节 UTF-8、非 UTF-8、大文件、非法 marker 格式、
字段顺序）为 0.0.37 既有覆盖，本轮逐条随全量套件重跑通过，未改动其语义。

### 2.4 edit 恢复路径（任务书 3.4 的连带检查）

本轮未修改写入/备份/恢复命令构造（`buildEditWrite` / `buildEditRestore` / `parseWriteReport` /
`parseRepairReport` 原样），逐项静态核对并跑过其测试：

- 写前版本守卫（`stat -c '%i|%s|%y'` token 比对）——`edit.test.mjs`、`edit-shell.test.mjs` 通过；
- 备份先行、失败即 22 拒写——通过；原 inode 覆写（`cat >`）——真机 `edit` case 验证 inode/mode/hardlink/xattr 保持（proxy 通过；nas 的 hardlink check 为既有环境差异，见 §八）；
- 写后先核长度再核摘要（`ssh-plugin: ok digest|sizeonly`），`unknown/landed/mismatch` 判定不变；
- 恢复成功仍以摘要为证（`verdict: restored` + `sha256` 比对），不是仅凭文件大小——
  `edit-shell.test.mjs` 的 repair 序列与 `live-check --case=edit` 的中断恢复场景（restored 时
  磁盘摘要 == 读到的原内容摘要）本轮真机通过（proxy）。

结论：K-6 修复没有触及恢复机制；恢复的完整性证据链保持原样并通过回归。

### 2.5 K-6 验收条件对照（任务书 3.5）

长度不再被摘要提前绕过 ✅；长度与摘要各有独立测试 ✅；含 marker 前缀正文不丢字节 ✅（既有用例重跑）；
UTF-8/非 UTF-8 行为符合协议 ✅；写失败恢复后内容完整 ✅；自动化全绿 ✅；真机记录 ✅（proxy+nas framing）。

---

## 三、K-4：远端进程清理的 PID 复用竞态（P0，已修复）

### 3.1 0.0.37 的残留问题（源码级确认）

保留的 0.0.37 机制（task tag、按 pid 点名、cmdline 逐参数比对、verdict 词汇）本轮全部保留。
残留的两个不安全点：

1. **校验与击杀之间的窗口**：`reapMoverCommand` 的顺序是 `kill -0` → 读 `cmdline` → 比对 → `kill -9`。
   比对通过后、`kill -9` 送达前，目标可以退出且号码被内核发放给新进程——击杀落到借号者头上。
2. **无 `/proc` 时凭裸号杀**：`/proc/<pid>/cmdline` 不可读即 `kill -9` 并报 `killed-unverified`。
   这正是身份完全未验证时的清理，与「不得在身份不明时直接 kill」相抵触。

### 3.2 现在的机制：身份对 + 冻结复核（`src/transfer.ts`）

**mover 侧**：marker 增带内核启动时间——
`dsh-mover <pid> <tag> <starttime>`。starttime 取 `/proc/<pid>/stat` 最后一个 `)` 之后的第 20 个字段
（进程名含空格或括号都不干扰；下载在 `exec` 前读 `$$`，`exec` 保号也保时间；上传落地那步读 `"$mp"`）。
服务器无 `/proc` 或非 Linux → 打印 `0`（诚实的「本平台除号码外说不出身份」）。启动时间由内核写入、
进程存活期不变，进程退出后接号的新进程时间必然不同——**退出后不能被冒用**。

**清理侧**（单条 POSIX 命令，只用 `kill -0/-STOP/-CONT/-9`、`cat/tr/sed`、shell 内建）：

```
kill -0 失败                        → gone
K=0 或 stat/cmdline 不可读：号还在 → unverifiable；号已不应答 → gone
stat 状态 = Z（已终止待回收）        → gone（cmdline 已空，不误判成 foreign）
探针读不到启动时间（_n=0）：号还在 → unverifiable；已消失 → gone
starttime ≠ K 或 argv ≠ (cat, --, 本次路径词) → foreign（不碰）
kill -STOP 失败：号还在 → refused；已消失 → gone
冻结后再读 starttime：≠ K（冻到了接号继承人）→ kill -CONT 放回 → foreign
冻结后状态 = Z                       → gone
kill -9 成功 → killed；失败 → CONT 放回 + refused
```
每轮探针先把 `_st/_n` 清零再读：读到一半目标退出时，绝不拿上一行的旧时间戳去匹配——
否则 SIGKILL 会瞄准恰好借走号码的新进程。这一条正是本轮 10 轮稳定性跑里抓出来的
偶发形态（目标在 `-r` 预检与读取之间退出曾被报成 `unverifiable`），修复后 10/10 轮无失败。

竞态是被**关闭**而不是被缩小的：SIGSTOP 送达后进程不可能退出，其号码不可能在校验与击杀之间
转手；因此「冻结后的 starttime 复核相符」在进程仍持有该号码期间是对同一事实的两次读数，
击杀对象与校验对象由内核语义保证为同一进程。重复读取 `cmdline`/`kill -0` 不用于替代这一保证。

任务身份仍是唯一 task tag（路径只做 argv 第三项的**核对**，从不作为身份）；无 `pkill`/`killall`。

### 3.3 词汇变化与如实描述

- `killed`：只有「命令行 + 启动时间双双确认、冻结、冻结态复核通过」后才可以说。
- **`killed-unverified` 退役**：不再有「执行过清理尝试但无法确认目标身份」的 kill。
- `unverifiable`：身份无法建立，**未发任何信号**，mover 保留为明说的残留。
- `foreign`：借号者/命令行不符/时间不符/冻结扑空；若曾短暂 STOP 到借号者，已 CONT 放回。
- `refused`：EPERM，无法冻结或击杀；不会把目标留在 stopped 态。
- `unanswered`：清理子命令本身没有可读的回答。
- `gone`：包含「已终止、等待父进程回收（Z）」——对信号而言与消失等价。

### 3.4 测试覆盖（对照任务书 4.4）

**新增 `tests/transfer-shell.test.mjs`（18 用例，真 `/proc`、真信号、真进程；`/bin/sh` 与
`/bin/dash` 各跑一遍核心生命周期）**：

| 组 | 场景 | 用例 | 结果 |
|---|---|---|---|
| A | 同路径并发 A/B：清理 A，B 存活且仍能整段交付 payload、自身通道干净收尾 | `two movers on one path…` | ✅（sh+dash） |
| B | 活 mover → `killed`，进程离开进程表 | `a parked mover is ended by its own cleanup…` | ✅ |
| B | mover 自行退出（EOF）后再清理 → `gone` | `a mover that finished on its own…` | ✅ |
| B | 活进程但记录时间错 1（复用形态）→ `foreign`，进程未死、未被留在 T 态 | `a wrong start time…` | ✅ |
| B | 记录时间为 0 → `unverifiable`，**未收到 STOP/CONT/KILL** | `a recorded start time of zero…` | ✅ |
| B | 同 pid 同 argv 的陌生人（时间错配）→ `foreign`；同进程但路径词不符 → `foreign` | `an unrelated mover-shaped process…` | ✅ |
| B | 重复清理 3 次恒 `gone`，从不虚报第二次击杀 | `repeated cleanups…idempotent` | ✅ |
| C 哨兵 | 无关 `cat -- <同路径>` 进程：在时间错配、无时间、路径错配三种瞄准下全部存活、状态不变、starttime 不变 | `an unrelated mover-shaped process…` | ✅ |
| C 哨兵 | 清理进行到一半 mover 自行退出：判决 ∈ {gone,killed,foreign}、无人被留在 stopped、旁边哨兵进程全程无感 | `a mover that exits mid-cleanup…` | ✅ |
| D | 上传落地（publish）后台 mover：marker 报的是 mover 自己的号+时间，端到端 `killed`，part 文件保留 | `a backgrounded publish mover…` | ✅ |
| D | comm 含 `)` 的脚本启动 mover：probe 字段计数不受影响 | `the probe survives a comm…` | ✅ |
| D | 含 shell/glob 元字符与重音字符的路径：一个引号词比对，非模式；哨兵同路径存活 | `a path full of shell and glob metacharacters…` | ✅ |

稳定性：本轮对该文件连续执行 **8 轮（修竞态后）+ 另 6 轮（修竞态前）**，最终 8 轮 18/18 无失败。
期间修掉的是**测试工装自身**的两处竞态（`exit` 早于 stdout 排空导致误读 `unanswered`；
R→S 自然调度被误当信号），修法是等 `close` 与放宽状态比较为「非 T」，不是放松被测代码的断言。

单元层（`tests/transfer.test.mjs`，fake transport）同步重钉：新 marker 形状、`P=…; K=…; p=…`
脚本前缀、脚本必须使用 `-STOP/-CONT` 且不再出现 `killed-unverified`、六 verdict 词汇、端到端
`unverifiable` note（「left … running / could not be proved / 从不声称 ended」）。

### 3.5 真实 SSH 记录（本轮亲跑）

**proxy（Debian 13，内核 6.12）`--case=reap`，2026-11-19 14:07，日志 `/tmp/live-proxy.log`：**

```
✓ two movers of one path are parked on it at once — pids 2892878 and 2892888, 2 movers
✓ the first copy ends its own mover … — dsh-reap killed
✓ the mover that belonged to the other copy is still parked — pid 2892888 alive
✓ a cleanup run twice says gone … — dsh-reap gone
✓ the surviving copy still delivers its payload whole after the other was reaped — "payload-for-B\n"
✓ a cleanup aimed with another copy's path word refuses to kill — dsh-reap foreign
✓ a living mover under a wrong recorded start time is left alone — dsh-reap foreign
✓ and refusing the wrong time costs the mover nothing — pid 2893057 alive
✓ a mover recorded without a start time is refused, never killed on the number alone — dsh-reap unverifiable
✓ and it is still parked after that refusal — pid 2893057 alive
✓ the same cleanup, aimed correctly, ends that mover — dsh-reap killed
✓ a recycled pid running something else is reported as foreign, not as cleaned（sleep 哨兵 + 其真实 starttime+1）
✓ and the unrelated process survives it / and the sentinel survives that refusal untouched
✓ copy stopped on its deadline (round 1..3): refused, and its mover accounted for — 0 mover(s)
✓ a locally cancelled copy … leaves no mover / a copy whose channel died is reported, not swallowed
✓ either the mover is gone, or the copy named the residual rather than hiding it — gone after 223 ms
```

**nas（DSM，内核 4.4）`--case=reap`，14:15，日志 `/tmp/live-nas.log`：** 上述 foreign / unverifiable /
killed-on-real-identity 三条同样 ✅（内核 4.4 起即有 stat starttime 字段）。

清理命令超时场景在 product path 出现并如实记录（proxy round 1：copy 报 `got no answer`（unanswered），
本 case 用自己的子进程再问一次 → `dsh-reap gone`；check 允许并留痕）。

**服务器能力勘察（本轮实测，非假设）**：proxy/nas 均为 Linux、`/proc/<pid>/stat`、`/proc/<pid>/cmdline`
可读、starttime 可提取（见 §三.2 片段在两机返回真实数值）；`setsid/awk/tr/sed` 存在，但清理脚本
不依赖 awk/setsid/pidfd。

### 3.6 K-4 验收条件对照（任务书 4.5）

同路径 A/B 保护不退化 ✅（shell + proxy + nas）；PID 复用误杀风险被机制性消除（冻结协议，不是更多
`kill -0`）✅；身份不可确认时 fail-closed ✅（`unverifiable`，无信号）；无 `/proc` 不再退化为未经验证
的 kill ✅；无关哨兵不受影响 ✅（存活 + 无 T 态 + starttime 不变）；状态词汇准确区分成功/拒绝/
未确认/连接失败 ✅；自动化 + 模拟 SSH（真 /proc 本地）+ 真实 SSH 全过 ✅。

---

## 四、P1：0.0.37 已通过模块的回归（本轮全部重跑）

| 模块 | 关键断言（测试名） | 本轮执行 | 结果 |
|---|---|---|---|
| K-1 无摘要工具 fail-closed | `bytes that decode to something other than what the server digested are refused`（含 odd digest 读作无摘要）；`edit-shell` noTool 序列；live `--case=capability`「masked checksum tools → NO digest」「not over-refused when capable」 | 离线 + proxy 真机 | ✅ |
| K-8 spill 账本 | `the same spill path is counted once…`；`a background file that grows is charged up to its newest size…`；`three jobs growing at once top up the same ledger…`；`the shipped spill budget is one gigabyte and sixty-four files…`；`the threshold is a stopping condition…`（1 GiB/64 文件与软阈值语义原样保留） | `spill.test.mjs` 12/12 + live `--case=spill` | ✅ |
| 后台 job 槽位 | `the job lane ceiling is capped to the slots a job may hold, and the cap is the reservation`；`a job ceiling a profile set above the reservation is still held to eight, and the reserved slots stay open`；`effectiveLaneCap clamps jobs only…`；live `--case=jobs` 第九个后台调用 0 ms 拒并点名 8 槽 | `bounds/transport/jobs` + proxy 真机 | ✅ |
| 探测超时 | `the probe deadline is one number, from the config to the page to the child`（`DEFAULTS.probeTimeoutMs == 30_000`、旧 Host 无 bounds 仍 30s）；`client-fallbacks.test.mjs` fallback=30s；Web 文案 fixed thirty seconds | `bounds` 11/11、`client-fallbacks` 3/3 | ✅ |
| 审批体系未回退 | `approval.test.mjs` 4/4 | 本轮 | ✅ |

（K-1 真机细节补充：capability case 同时验证「掩掉摘要工具后读取仍能按字节定界，拒写只与摘要有关」。）

---

## 五、完整验证矩阵（六层，逐项记录）

### 5.1 静态检查

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `npx tsc -p tsconfig.json --noEmit` | 0 错误 ✅ |
| 构建 | `pnpm run build`（clean-lib → tsc → finalize-client） | 成功 ✅（`/tmp/b38.log`） |
| 脚本语法 | `node --check scripts/live-check.mjs` | ✅ |

### 5.2 离线自动化（本轮实际执行）

| 执行 | 命令 | 结果 |
|---|---|---|
| **0.0.37 基线**（修复前对照） | `pnpm run build && node --test tests/*.test.mjs` | **317/317** ✅（`/tmp/baseline-test.log`） |
| K-6 复现（旧 lib + 新用例） | `node --test tests/edit.test.mjs`（修复前） | 新用例失败于旧实现 ✅（复现证明） |
| **0.0.38 全量**（修复后） | 同上 | **338/338**（+21 用例，0 skip，0 fail）✅ |
| 分文件 P1 复核 | `node --test tests/{spill,jobs,bounds,client-fallbacks,approval,transport,ops}.test.mjs` | 12+5+11+3+4+41+58 全过 ✅ |
| K-4 shell 生命周期稳定性 | `node --test --test-timeout=10000 tests/transfer-shell.test.mjs` × 8 轮（竞态修复前）+ × **10 轮**（修复后） | 修复前曾抓到 1 次偶发（见 §三.2 注），修复后 10/10 轮 18/18 ✅（`/tmp/rr1..10.log`） |
| **0.0.38 竞态修复后全量复跑** | `node --test --test-timeout=20000 tests/*.test.mjs` × 3 轮 | 3 轮 338/338 ✅（`/tmp/ff1..3.log`）；`tsc --noEmit` 0 错误 ✅ |

离线层的「模拟 SSH」= fake transport 单元层 + 真 /proc 本地 shell 层（`transfer-shell`），
两者都不冒充真实服务器。

### 5.3 真实 SSH（本轮亲自执行）

| 目标 | 命令 | 结果 | 日志 |
|---|---|---|---|
| proxy（Linux 6.12） | `node scripts/live-check.mjs --target=proxy`（17 case 全跑） | **174 通过 / 0 失败**，exit 0 | `/tmp/live-proxy.log` |
| proxy（**竞态修复后复跑**） | 同上，HEAD=`a1816c6` | **174 通过 / 0 失败**，exit 0；reap 各 verdict（killed/foreign/unverifiable/gone）与前次逐项一致复现 | `/tmp/live-proxy2.log` |
| nas（Linux 4.4） | `node scripts/live-check.mjs --target=nas` | 168 通过 / 5 失败（逐项为既有环境差异，见 §八），exit 1 | `/tmp/live-nas.log` |

nas 的 5 项失败**用 0.0.37 原始产物（官方 tgz 内已编译 lib + 0.0.37 的 live-check 脚本）在同一台 nas 上对照**：
`--case=tree` → 4 failed（同一组断言）、`--case=edit` → hardlink check 同样 failed
（`/tmp/x037-nas-tree.log`、`/tmp/x037-nas-edit.log`）。即：**与 0.0.38 改动无关，0.0.37 在该环境同样如此**。
K-4/K-6 新增的 reap/framing 断言在 nas 全部通过。

### 5.4 独立安装与加载（本轮执行）

`node scripts/independent-install-check.mjs --keep` → **18/18** ✅（`/tmp/indep.log`，安装留在
`/tmp/dsh-ssh-install-FmdIU5/project`）：解包安装、版本一致（0.0.38）、入口/导出解析、
50 个打包文件与当次构建逐 hash 相同（42 个 lib 文件双向核对，无陈旧模块）、bundle patch 单一 Host 行、
配置 schema、工具注册（`ssh_client`，7 actions）、经真实 DSH subprocess provider 的 `ops.list()`
与真机 `probe`（384 ms 可达）、一条远端命令返回成功。不依赖开发 worktree、不依赖已删目录。

### 5.5 打包

`npm pack` → `artifacts/jie2gg-dsh-plugin-ssh-0.0.38.tgz`（271,636 字节，50 个条目：`lib/`、
`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`docs/`；不含 tests/scripts/临时产物）。
`sha256 = ab548f74415999748d584a77f20e3610b713388e712269493f1f3b7d7b192ff0`（与 /tmp 原件一致）。

---

## 六、位置与运行状态（任务书第七章要求的四件事）

- **正式源码目录**：`/data/deepseek-harness-plugins/ssh`（分支 `main`，HEAD `336a2c0`；构建产物 `lib/` 已同步重建，0.0.38）。
- **安装产物**：`/data/deepseek-harness-plugins/artifacts/jie2gg-dsh-plugin-ssh-0.0.38.tgz`（sha256 见上）。
- **生产 profile 指向**：`/data/dsh-home/profiles/web/package.json` 声明
  `link:/data/deepseek-harness-plugins/ssh`，`node_modules/@jie2gg/dsh-plugin-ssh` 符号链接已解析到该目录，
  磁盘上 `package.json` 版本 = **0.0.38**。链接自 0.0.37 轮次起就指向正式源码目录（本轮只改了内容，没有改 link，
  独立安装检查不依赖它）。
- **运行中的 Host 实际加载**：pid **3254605**，`node --import tsx/esm apps/cli/src/bin.ts web --host 10.100.1.3 --port 3080`，
  启动于 **2026-11-17 23:26:35**，未重启（etime 核对）。0.0.37 的代码提交发生在 2026-11-19 11:39 之后，
  0.0.38 更晚——**该进程内存中持有的是 11-17 时点已构建的插件字节码（0.0.36/0.0.35 时代），
  既不含 0.0.37 也不含 0.0.38**。profile 链接更新 ≠ 运行中 Host 已加载新版本，二者在本报告中分开陈述。
- **是否重启过 Host**：否（未经授权，未重启）。0.0.38 在下一次 Host 启动时生效。
- **是否推送远端仓库**：否。是否发布 npm 包：**否**（包本身 `"private": true`，发布按仓库流程另行决定）。

---

## 七、已知限制与剩余风险（如实清单）

1. **冻结协议对"借号者"仍可能有一次可逆信号**：若目标恰在「身份校验之后、SIGSTOP 送达之前」退出且
   号码随即被复用，SIGSTOP 会短暂停住新进程，随即 `kill -CONT` 放回并报 `foreign`。代价是毫秒级冻结，
   **没有任何终止性信号**打到无关进程；哨兵用例断言了存活、无 T 残留、starttime 不变。
2. **支持范围限定为「可读 `/proc` 的 Linux」**：无 `/proc`、`hidepid`、或非 Linux 服务器上，清理策略是
   拒绝击杀并报 `unverifiable`，滞留 mover 依赖服务器自身的会话回收（0.0.37 用盲杀换来的"自动干净"
   在此让位于"绝不误杀"）。本轮两台真实服务器均为 Linux，该路径靠 starttime=0/不可读分支与本地 shell
   测试覆盖，未在真实 hidepid 机器上实测（见 §八）。
3. **理论三重巧合**：PID 复用、同 jiffy tick 启动、且前三项 argv 完全相同的陌生人——冻结复核无法区分
   （同 tick 时间戳相同）。概率极低（需要复用恰好落在毫秒级窗口内且 argv 逐字相同），后果是击杀了一个
   与 mover 同 argv 的无关 `cat`。本地 A/B 用例中两个背靠背 mover 出现过同 tick 相同 starttime，
   已按「身份是 pid+时间的配对，而非时间本身」的语义处理。
4. **edit 协议的自洽边界（0.0.37 已存在，非本轮引入）**：若 marker 的声明长度与摘要**彼此一致地**撒谎
   （两者都描述截断后的 body），单次读取内部无从发现；防线是写后服务器摘要门与版本 token。本轮修复的是
   「两 claims 相互矛盾必拒」。
5. **清理子命令本身超时** → `unanswered`（proxy product path 出现过一次并由 case 自主复检为 gone）。
   这不是击杀风险，而是残留风险的如实报告。
6. **EPERM 无法真机实测**：本轮两个目标均为普通属主会话，`refused` 分支由脚本逻辑与本地 root/普通进程
   场景间接覆盖（STOP/KILL 失败路径都有 CONT 放回 + 明说），未在真实权限受限账号上演练。
7. **nas 环境差异（对照 0.0.37 确认为既有）**：`scp -r` 目录下载（tree case 4 项）与 `edit` 的 hardlink
   读取 check 在 0.0.37 同机复现相同失败；proxy 全部通过。本轮未修（不在本次范围），已记录。
8. **生产 Host 尚未加载 0.0.38**（见 §六）：生效需重启，本轮按授权边界未执行。

---

## 八、验收结论

**READY WITH KNOWN LIMITATIONS。**

对照任务书九章：

- READY 条件全部满足：K-6 双重校验已修复且专项测试全过（含真机）；K-4 的 PID 复用误杀被冻结协议
  消除、身份不明时安全拒绝；A/B 并发保护通过；哨兵保护通过；真实 SSH（proxy 174/0）回归通过；
  P1 模块回归通过；独立安装与加载验证 18/18；构建打包通过；无未披露的 P0。
- 定为「带已知限制」而非「READY」的原因都是限制而非缺陷，且均不造成未授权写入、正文损坏或误杀：
  限制 2（非 Linux/无 /proc 拒绝自动清理——明确适用条件与安全降级）、限制 3（三重巧合的理论残余）、
  限制 8（运行中的 Host 需重启才加载 0.0.38——流程性事实，非代码状态）、限制 7（nas 既有环境差异）。
- NOT READY 触发项逐条核对：无一项命中（长度不可能再被豁免；无可疑击杀；A/B 通过；正文完整性与恢复
  通过；真实 SSH 验证在场；源码与安装可复现；本报告对执行/历史/静态的区分逐处标明）。

—— 报告完 ——
