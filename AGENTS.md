# AGENTS.md

Jie2GG 的 DeepSeek Harness（DSH）插件集合仓库：**一个顶层目录 = 一个独立插件**。
新增或修改插件前先读 [CONTRIBUTING.md](CONTRIBUTING.md)——它是插件结构、必需字段与
展示元信息的唯一出处；本文件只承载导航与常设规则。

## 仓库地图

- [README.md](README.md) 的「插件索引」是全仓权威地图：每个插件必须登记
  （目录 | 包名 | 简介 | 状态），新增、改名、弃用都在同一 commit 同步本表；
  状态枚举定义见 [CONTRIBUTING.md](CONTRIBUTING.md#插件状态取值)。
- `<短名>/`——插件目录，内部结构与展示资源规范见 CONTRIBUTING.md 对应小节。
- `.agents/worktrees/`——harness 管理的 Git 工作树，不属于插件内容。

## 常设规则

- 插件之间不共享 workspace、不互相依赖：每个目录可独立安装、发版、删除。
- 验收走 `plugin_manager` → `install_bundle`：以插件目录绝对路径安装，无 manifest
  诊断、中英文文案均正常才算可用（细节见 CONTRIBUTING.md「版本与安装验证」）。
- commit 前缀：插件目录改动用 `<短名>: <摘要>`，仓库级改动用 `chore:`（规则见
  CONTRIBUTING.md「新增插件流程」）。
- 交付产物（版本报告、diff 导出、pack 的 tgz）放 `<短名>/artifacts/<版本>/`，已被 git
  忽略；不散放插件目录或仓库根（细节见 CONTRIBUTING.md「交付产物与目录卫生」）。
- 版本号三段语义：大版本 / 用户认可版本 / Agent 自动迭代版本；agent 日常提交只
  递增第三段，第二段须用户认可才动（细则见 CONTRIBUTING.md「版本号三段语义」）。
- `CLAUDE.md` 是本文件的符号链接：只编辑 AGENTS.md。
- 保持本文件简短：细节长大就搬到权威处，这里只留一行链接。
