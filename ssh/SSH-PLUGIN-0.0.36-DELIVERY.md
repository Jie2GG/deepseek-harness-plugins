# 0.0.36 定向收尾交付报告 — `@jie2gg/dsh-plugin-ssh`

结论：**READY WITH KNOWN LIMITATIONS**（判据见第八节）

- 基线：`0.0.35`（worktree `.agents/worktrees/ssh-plugin-scaffold`，分支 `ssh-plugin-scaffold`，起点 HEAD `df1f103`）
- 本轮只处理四项遗留问题：K-6、K-8（阻断，优先）+ K-1、K-4
- 包版本：`ssh/package.json` = **0.0.36**，`private: true`，**未发布到任何外部 registry**
- 时间：2026-11-18 23:28 – 2026-11-19 01:35（Asia/Shanghai）
- 源码 patch：`SSH-PLUGIN-0.0.36-DIFF.patch`（1276 行，18 个受跟踪文件；`lib/` 为构建产物不入库）

本轮改动文件（`git diff --stat`，不含 `lib/`）：

```
ssh/CHANGELOG.md              |  58 ++
ssh/README.md                 |  38 ++--
ssh/docs/DETAIL.md            |  25 ++-
ssh/docs/DETAIL.zh.md         |  17 ++-
ssh/package.json              |   2 +-
ssh/scripts/live-check.mjs    |  74 ++--
ssh/src/edit.ts               | 152 ++++++----
ssh/src/ops.ts                |  31 ++
ssh/src/spill.ts              |  49 ++-
ssh/src/transfer.ts           |  98 ++-
ssh/src/transport.ts          |   4 +-    (仅注释：对齐 K-8 observe 语义)
ssh/tests/edit-shell.test.mjs |  54 ++
ssh/tests/edit.test.mjs       |  64 ++
ssh/tests/ops.test.mjs        |  33 ++-
ssh/tests/spill.test.mjs      |  30 ++-
ssh/tests/tool.test.mjs       |  32 ++-
ssh/tests/transfer.test.mjs   |  61 ++-
ssh/tests/transport.test.mjs  |  61 ++
```

---

## 一、四项问题修复说明

### K-6（阻断）— ssh_edit 协议标记与真实正文冲突，按字节定界消除歧义

**原缺陷**：`ssh/src/edit.ts` 的 `splitEditVersion` 按「前缀像不像 marker 的行」切分读结果。读命令
`buildEditRead` 会在正文前置 header 行；一旦某条 header 缺失（老协议、或 `printf` 在异常 shell 下未执行），
文件自己的首行若恰以 `ssh-plugin:` 开头，就会被当成 version header 剥掉，正文少一行。

**修法（`ssh/src/edit.ts`）**：
1. `buildEditRead` 在 digest header 之后**新增第三行 `ssh-plugin-bytes: <wc -c 字节数>`**，让 header 与正文
   的边界由服务器声明的**字节长度**定界（报告建议的「按字节切分」），不再依赖「猜哪几行像 marker」。
2. `splitEditVersion` 重写为**严格定位置 + 值形状**扫描：只从顶部最多消费 3 行 header，且每行必须同时满足
   前缀 + 值形状（version 必须为空或 `inode|size|mtime` 的 stat 形状 `^\d+\|\d+\|`；bytes 必须为空或十进制）。
   header 行**只有在被识别为 header 后才从正文中扣除**（`peekLine` 不预消耗）。任何正文行，哪怕恰以
   `ssh-plugin:` / `ssh-plugin-sha256:` / `ssh-plugin-bytes:` 开头，只要出现在第 4 行以后就永不被扫描、永不被剥。
3. 返回值新增 `bodyBytes`（服务器声明的正文字节数），供调用方证明正文完整。

**为什么无歧义**：现代协议下三条 header 恒由 `printf` 产出，扫描只碰第 1–3 行；正文从第 4 行起。文件里再
多「marker 样」的行都在第 4 行以后，落在定界之外。一个**非 stat 形状**的正文首行（如 `ssh-plugin: 一句话`）
因值形状不合格而**不被当作 header**，于是整段文本原样作为正文返回——这正修掉了旧的误剥。

**向后兼容**：自动降级识别 0/1/2/3 条 header（旧单 header、旧双 header、printf 全失败），既有 edit.test 的
18 项断言（含 `'aa'` 摘要、`7|5|t` legacy、空 version 三态）**一字未改即通过**。

### K-8（阻断）— 后台 spill 文件增长后账本继续计费

**原缺陷**：`ssh/src/spill.ts` 的 `observe` 用 `Set<string>` 按 path 去重：`if (this.#files.has(entry.path)) continue`。
后台 job 的 `streamSources`（`ssh/src/transport.ts:508`）随流向增长**反复**上报同一路径更大的 `nextOffset`，
但去重让第 2 次起被整条跳过 → 一个从 400 涨到 1500 字节的 spill 文件永远只计 400，账本站时低估实际落盘量。

**修法（`ssh/src/spill.ts`）**：`#files` 由 `Set` 改为 `Map<path, 已计费最大 offset>`。`observe` 对每个 path：
首次计其 offset；之后**只补记差额** `bytes - 已计`；相等或更小**不退款、不重复计**（磁盘文件不会变小）。
`files`/`used`/`summary`/`ask` 的 `#files.size` 语义不变。

**预算统计 ↔ 实际占用的关系**：改后 `used` = 各命名 path「provider 回报过的最大整流偏移」之和，即
**随文件增长逼近真正落盘字节**，而非冻结在首次值。`used` 只在 `>= max` 时停止后续授予——现在一条真在增长的
长流会把 `used` 推上去并正常触发阈值，账面与磁盘占用一致。

### K-1 — SHA-256 能力检查前置，无可靠摘要则拒写、远端文件不变

**原行为（0.0.35）**：无摘要工具时编辑**写入照常落地**，调用以 `ok:false / verdict:unknown / contentVerified:false`
结束、副本保留——文件已变，只是无法核验（对外可见的行为变更，属 K-1 已知限制）。

**改法（`ssh/src/ops.ts:editRemote`）**：把能力判定从「写后」搬到「写前」。读结果里 digest 行为空（K-6 已可靠
产出 `originalSha256`）= 该服务器无摘要能力；此时在 `dryRun` 分支之后、创建副本/`cp -p`/`cat >` **之前**直接返回：
`ok:false`、`status:'exit-nonzero'`（沿用既有「拒写」词表）、`contentVerified:false`、**不设 verdict**（本次从未
截断文件，与 `stale` 分支同理）、**不生成 `.dsh-bak`**，文件原封不动。`dryRun` 预览仍可用并追加一条 note 说明
「同一调用不带 dryRun 会被拒」。`buildEditWrite` 内 `exit 29` 的写后无摘要分支保留为 TOCTOU 兜底（读时有、
写时工具消失），不再是主路径。

**安全性**：校验不了的编辑现在**根本不会开始**，可安全重试；装上 `sha256sum`/`shasum`/`openssl` 后行为不变。
工具 schema 未扩字段（复用既有 edit 属性），无对外契约破坏。

### K-4 — 超时/取消/异常退出后的远端进程清理改善

**原缺陷**：本地 `ssh` child 被 terminate 只保证**本地**消失；服务器侧一条卡在 fifo 上的 `cat`
（下载读「无写者的 fifo」阻塞于 `open()/read()`，或发布写「无读者的 fifo」阻塞于 `write()`）**从不触碰通道**，
无 pty 的 sshd 不给它发信号 → 进程滞留（实测 0.0.35 曾在 proxy 见 6 个存活 8–11 小时的 reader）。

**改法（`ssh/src/transfer.ts`）**：`copyStream` 在**下载被打断**（over-limit / timeout / cancelled / error）与
**发布失败**分支，`abandon()` 之后追加一个 best-effort、有上限（`min(statTimeoutMs, 10s)`）、吞错的远端 reaper：
`pkill -f -- '[c]at -- <源路径>'`（下载）/ `pkill -f -- '[c]at <part 路径>'`（发布）。
- **精确**：按 mover 正在搬的那个参数点名；上传 part 路径每副本唯一 → 只杀本次；
- **不自杀**：`[c]at` 写法使正则匹配 `cat…` 却匹配不到运行它的 shell 自身（`sh -c` 的 cmdline 含字面 `[c]at`）；
- **不甩锅**：`pkill` 退出 1（没匹配）= 正常（mover 已随通道退出）→ 静默；退出 127/`not found` → 在 notes 里
  说明「服务器无 pkill，mover 可能仍在」而非改写复制结论；连接都开不了 → 吞掉。

---

## 二、新增回归测试及执行结果

**逐文件计数（本轮 `pnpm test` 实跑，`node --test tests/*.test.mjs`）**，与 0.0.35 基线对照：

| 文件 | 0.0.35 | 0.0.36 | Δ | 钉住的修复 |
| --- | ---: | ---: | ---: | --- |
| edit-shell.test.mjs | 13 | **15** | +2 | K-6「正文全是 marker 样行仍逐字节完整」（真实 /bin/sh）；K-1「读阶段检测无工具、读操作不改文件」 |
| edit.test.mjs | 18 | **21** | +3 | K-6 header 加字节行、正文含 marker 样行不被剥、version 非 stat 形状即不作 header |
| transport.test.mjs | 37 | **38** | +1 | K-8 后台 job 真实 pump 路径：400→900→1500 补记 |
| transfer.test.mjs | 26 | **28** | +2 | K-4 停止的下载发起 `[c]at` 清理并记 note；发布失败按 part 路径 reaper；无 pkill 的降级说明 |
| spill.test.mjs | 11 | 11 | 0* | K-8 增长补记、相等不重计、更小不退、阈值随增长触发（*改写旧「只计一次」用例为更强契约） |
| ops.test.mjs | 53 | 53 | 0* | K-1 无摘要→写前拒绝、0 写入子进程、`server.file` 不变；dryRun 警告（*改写旧 noSha 用例） |
| tool.test.mjs | 48 | 48 | 0* | K-1 产品 seam：拒写、`writes===0`、`backups===[]`、文件逐字节不变（*改写旧 noSha 用例） |
| 其余 9 文件 | 71 | 71 | 0 | 未触及 |

**聚合 285 tests / 285 pass / 0 fail / 0 skipped / 0 todo**；逐文件求和 = 285（口径互锁）。相对 0.0.35 终点
277 **净增 +8**（edit +3、edit-shell +2、transport +1、transfer +2），**未删除任何用例文件或用例条目**；
被「改写」的三条（spill/ops/tool）是把旧行为断言升级成**更强**的形式（K-8 补记而非只计一次；K-1 从「写后
unknown 且文件已变」升级为「写前拒绝、无 cp/cat 子进程、服务器字节逐字节不变」；transfer 202 从「末尾 lease
= 复制」改为「按 dropped 精确锁定复制 lease + 额外断言确有 reaper 子进程」），没有放宽任何断言、也没有跳过校验。

---

## 三、完整自动化与交付一致性

| 命令 | 结果 |
| --- | --- |
| `pnpm run check` | `tsc --noEmit` **无诊断** |
| `pnpm run build` | `tsc` + `finalize-client.mjs` ⇒ `lib/client.js finalized (101917 bytes)` |
| `pnpm test` | **285 / 285 pass，0 fail / 0 skipped / 0 todo**（聚合=逐文件求和，见第二节） |
| `pnpm pack` | `jie2gg-dsh-plugin-ssh-0.0.36.tgz`：**52 个条目**（文件集与 0.0.35 相同，未增减）；包内 `package.json` = 0.0.36 |

产物内含本轮逻辑（对 `*.tgz` 解压后逐文件 grep 核验）：
`lib/edit.js` 含 `ssh-plugin-bytes`(4 处命中) 与 `STAT_TOKEN`(2)；`lib/spill.js` 含 `this.#files.get/set` 的 delta 分支(3)；
`lib/ops.js` 含 K-1 拒写文案(1)；`lib/transfer.js` 含 `pkill -f --`(1)。产物记录后已删除，**未发布**。

---

## 四、真实 SSH 验证（`ssh/scripts/live-check.mjs`：真 DSH subprocess provider + 真 OpenSSH + 存储凭据，直驱 `lib/`）

本轮为真实验证**新增/升级**了两类检查（`capability` 新用例、`release` 由观测升为断言）。

### 4.1 对 `proxy`（root@10.100.1.205）：14 用例 **126 检查 / 0 失败**（0.0.35 同脚本 118 项）

| 用例 | checks | 关键实测 |
| --- | ---: | --- |
| **capability**（新，K-1/K-6） | 6/0 | 真服务器 `/bin/sh` 执行 plugin 自己的 `buildEditRead`：有工具→读出真摘要 `f3d60e59063a…` 且 `bodyBytes=23` 与正文逐字节一致；**用 `env PATH=<仅 cat/stat/wc/…>` 屏蔽 sha256sum/shasum/openssl 再跑同命令→digest 行变空**（K-1 据以拒写的真实信号），其余 header 与正文仍完整；**有摘要工具的服务器不被误拒**（edit landed、contentVerified） |
| **release**（升级，K-4） | 8/0 | 下载无写者 fifo 被 700ms 超时叫停后：`out2.notes` 含「**ended a leftover server-side mover of …/release-quiet.fifo**」；`untilGone` 由「观测」升为「断言」→ **gone after 213 ms**（无需人工 pkill）；本地无 ssh 残留、lane 归还、下一条复制放行 |
| edit | 26/0 | K-6 三 marker 读在真机透明：clean edit 三重摘要一致（tool==server `sha256sum`==送出摘要 `63f6b68cd7a6…`）、inode/mode/links/owner 全保、`.dsh-bak`==原文、同长度对手改写 5/6 被守卫拒且从不出现「未核验的成功」、400KB 载荷 250ms 被叫停仍是原 10 字节 |
| spill | 11/0 | `granted 1, refused on call 2, budget 1840 of 1500 bytes in 2 file(s)`；两条面共享授予；每 transport 一本账——**K-8 对前台一次性上报的语义未变**（distinct path 首计，与改前一致） |
| grow | 7/0 | in-flight 超限被拒并报「moved N bytes」；停止后服务器 reader 随通道关闭消失（reaper 亦兜底，见下）；lane 归零 |
| plain/overwrite/modes/tilde/lane/tree/jobs/temp/sink | 各全通过 | 递归、并发 lane、临时目录回收、sink 失败快速返回等无回归 |

### 4.2 对 `nas`（jiegg@10.100.1.1）：120 检查 / 5 失败——**5 项均为既有环境/夹具问题，与本轮无关**

失败项：`tree` 递归下载 4 项（synology 上 `scp -r` 布局/符号链接枚举差异，含一处 live-check 自身 `.trim()` 于 undefined）
+ `edit` 1 项（`ln -f` 在 nas `/tmp` 未生成第 2 个硬链接，`links=1→1`，`throughLink!==now`）。

**归因证明**：把本轮 4 个核心 `src/` 文件 `git stash` 回 0.0.35、重建后单跑 nas 的 `tree` 与 `edit` —— 同样 5 项
失败**完全复现**（`tree` 4、`edit` 1）。即 0.0.36 未给真实 SSH **引入任何新失败**。proxy 上这些用例全绿。
nas 的 `capability`(6) 与 `release`(8) 两条本轮相关用例均通过。

### 4.3 审批 fail-closed（`ssh/scripts/t10-approval-check.mjs`，隔离真 Host，`$DSH_TEST_HOME` 的 `sdk` profile 加载同一份 0.0.36 `lib/`）

本轮未触碰 `approval.ts`（离线 `approval.test.mjs` 4/4 已在 285 内）。t10 在 0.0.36 上复跑，`timeout 280s` 内在
**5/6 场景结论正确**：`ask-allow` 落盘；`ask-reject` / `no-approval-service` / `no-answerer` / `answerer-throws` 四种
「无人可批」全部 fail-closed，并经服务器侧 `ls` 权威确认 **write reported run: no**（四种都没落盘）。`policy-never`
（自动放行）为与本轮正交的最末场景，被脚本超时截断，但其代码路径（approval 策略解析）本轮零改动。

---

## 五、最终产品 Host 验收记录（生产 GUI `http://10.100.1.3:3080`）

**重挂载方式**：`plugin_manager set_bundle @jie2gg/dsh-plugin-ssh` → `enabled:false` → `enabled:true`，两次均返回
`application:"applied"`。**未重启 Host、未切换安装包、未发布 registry。** 生产 profile 以 pnpm `link:` 指向本 worktree，
故重挂载加载的正是本轮构建的 0.0.36 `lib/`（`get_connection` 的 ceilings 行正常显示，工具即时可用，本轮未触发 K-9 预热）。

在**运行中的产品 Host 内经 `ssh_client` 工具**执行（非直驱 lib）：

| # | 场景 | 操作 | 实际返回 | 独立反证 | 结论 |
| --- | --- | --- | --- | --- | --- |
| ① | K-6/K-1：正文含 marker 样首行的编辑 | `edit` nas `/tmp/dsh-acc-0036/marker.txt`（首行 `ssh-plugin:…`、第 3 行 `ssh-plugin-sha256:…`，共 169B），改中段 needle | `replaced 1 place, 169 → 168 bytes`，`verdict=landed`，`content verified … sha256 af5f3c728ca8…` | 编辑后 `cat`：**首行与第 3 行的 marker 样正文行逐字节完好，仅 needle 行变化**；服务器独立 `sha256sum` = `af5f3c728ca8bf9e…` **与工具 digest 一致**；`.dsh-bak` = 原 169B（`75a74058f474…`）。`bytesBefore=169`（整文件）本身即证明 header 分界没吞掉首行 | **PASS** |
| ② | K-4：下载被叫停后的远端进程清理 | `download` nas `idle.fifo`（无写者）→ 工作区，`timeoutMs:1500` | `status=failed · 1761 ms`，「ran out of its deadline」，notes 含「**the interrupted copy also ended a leftover server-side mover of …/idle.fifo**」 | 产品调用后立即 `ps`：本次 `idle.fifo` 的 `cat` 滞留者 **count 0**（reaper 已清）；工作区**无 `.dsh-part-`/下载件残留** | **PASS** |
| ③ | K-4 清理手段在真机正确 | `exec` nas `pkill -f '[c]at -- /tmp/dsh-accept-0035/idle.fifo'`（清掉上一轮 0.0.35 遗留的真实滞留 reader） | `old 0.0.35 stranded cat ended`；随后系统内 `idle.fifo` reader 归零 | 顺带证实 `[c]at` 技巧在真机既杀得到目标、又不杀运行它的 shell（脚本未自尽） | **PASS** |

K-8 的账本增长在 `get_connection` 的 `spill` 行按 Host 进程暴露（本轮产品会话未强制触发一条增长中的后台溢出流）；
其语义由 lib 层真实 pump 集成测试（§二 transport）+ 真机 `spill` 用例（§4.1）共同证明，不依赖产品会话复现。

---

## 六、剩余问题与风险

| # | 项 | 性质 | 说明 |
| --- | --- | --- | --- |
| R-1 | K-1 是**对外可见的行为变更**（0.0.35 及以前：无摘要工具→写入落地后报 unknown；0.0.36：写前拒绝、文件不变） | 行为变更，更安全 | 调用方须知道：同一编辑在无摘要服务器上从「可能已改文件」变为「确定未改文件」。已在 README/DETAIL（中英）/CHANGELOG 写明。若你的部署里存在无 coreutils/openssl 摘要工具的服务器，务必进发布说明 |
| R-2 | K-4 清理是 **best-effort**：依赖服务器有 `pkill` | 已知、可运维 | 无 `pkill` 的服务器仍会滞留 mover，但结果 notes 明确告知、不甩锅复制；两台产品服务器实测均有 pkill。残留：pkill 按路径匹配理论上可与并发同路径复制互扰（下载源路径非本副本唯一），已用 `idle.fifo` 实测精确 |
| R-3 | K-6 深度残留：仅当 `printf` 整体失败（非 POSIX shell）**且**文件首行恰为**完整 stat 形状** `ssh-plugin: d+\|d+\|…` 时，才可能误剥 1 行 | 概率极低 | 插件运行于 POSIX `/bin/sh`（`printf` 是必需内建），现代协议恒发 3 行 header；`bodyBytes` 定界进一步收口。已在测试与注释说明 |
| R-4 | K-8 未改「阈值非硬上限」语义（停止授予的阈值，默认可近 3 GiB） | 设计决定，未动 | 本轮只修「增长不再计费」的账面低估；预算数值、授予不切分、越界幅度、每 Host 进程一本账均保持 0.0.35 定样 |
| R-5 | nas 上 `tree`（scp -r 递归）与 `edit` 硬链接夹具的 5 项真实失败 | **既有环境问题，非本轮引入** | 已用 0.0.35 基线 stash 复现相同 5 项。若要清理属另一条工作项（递归落地在 synology 的枚举差异、`/tmp` 硬链接行为），与 K-1/4/6/8 无关 |
| R-6 | 产品 Host 只做了 disable→enable 重挂载，未验证重启后加载 | 运维 | 未获重启授权，不擅重启生产 Host；重挂载后产品会话内 K-1/K-4/K-6 三场景实跑 PASS |

---

## 七、口径一致性自检

- 本轮所有数字均**本轮实跑**并给出互锁两列：聚合 285 = 逐文件求和 285。
- 真实 SSH：proxy 126/0、nas 120/5（5 项经基线复现证明既有），逐项标注了模拟/真机/产品层级。
- 版本 / CHANGELOG / README / DETAIL（中英）/ 代码一致：`package.json` 0.0.36；CHANGELOG 新增 `## 0.0.36` 四条；
  三处行为变更（K-1 写前拒绝、K-4 reaper、K-8 增长补记、K-6 字节定界）在面向使用者的文档里同口径写明。
- **未删除原有测试；未跳过测试（skipped 0）；无隐藏失败（fail 0）**；三条改写用例均升级为更强断言。

---

## 八、发布建议

**READY WITH KNOWN LIMITATIONS**

判据对照：

1. **两项阻断问题（K-6、K-8）已真正解决且有证明**，非措辞搪塞：K-6 由「猜前缀」改为「按服务器声明的字节数定界
   + 值形状校验」，正文 marker 样行在产品 Host 内逐字节完好并被三重摘要独立反证；K-8 由「首次计一次即冻结」
   改为「按 path 记录最大偏移、只补记差额」，并有真实 pump 集成测试证明账面 400→900→1500 跟随实际占用。
2. **K-1、K-4 按要求改善并给真实 SSH 验证**：K-1 把能力检查前置到写之前，无可靠摘要即拒写、远端文件不变
   （真机 `capability` 用例 + 产品 Host 编辑反证）；K-4 让被打断的复制 best-effort 请服务器结束滞留 mover，
   live-check `release` 从观测升为断言（213 ms 内消失）并在产品 Host 内经工具实证。
3. **不存在未解决的内容完整性缺陷**：内容完整性仍由摘要链把守，`contentVerified:false ⇒ ok:false`，
   `sizeonly`/无证据一律降级为 `unknown`，`restored:true` 只在摘要确证时给。
4. **为什么不宣布 READY**：R-1（K-1 是对外可见的行为变更）与 R-2（K-4 清理依赖 `pkill`、best-effort）是两处
   会改变调用方决策的点，须作为已知限制被接受后再发；另有 U-级细节（无 pkill 服务器的滞留、极端非 POSIX shell
   下的 stat 形状正文首行）不构成安全性风险但应写进发布说明。
5. **为什么不是 NOT READY**：四项遗留问题全部有对应回归测试与真实/产品验证、离线 285 全绿 0 跳过、
   真实 SSH 无本轮新增失败、产品 Host 三场景 PASS。

发布前仍需用户决定（本轮未擅做）：
- 是否把 `0.0.36` 发布到 registry（仍 `private: true`，只跑了 `pnpm pack`）。
- 版本段是否认可：按三段语义本轮只推进第三段（0.0.35→0.0.36）；K-1 属对外可见的行为变更，若要落到
  「用户认可版本」段（0.1.0）需你明确认可后再动第二段。
