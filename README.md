# DeepSeek Harness Plugins

Jie2GG 维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件集合。

本仓库遵循「**一个顶层目录 = 一个独立插件**」的约定：每个插件目录自带完整的
`package.json` 与全部元信息，可以单独安装、单独发版、单独删除；插件之间不共享
workspace，也不互相依赖。

## 插件索引

本表是全仓**权威插件地图**：每个插件都必须登记于此，新增、改名、弃用均须在同一
commit 同步本表。「状态」列仅限 `stable` / `experimental` / `deprecated` 三个取值，
定义见 [CONTRIBUTING.md](CONTRIBUTING.md#插件状态取值)。

| 插件目录 | 包名（`@jie2gg/dsh-plugin-*`） | 简介 | 状态 |
| --- | --- | --- | --- |
| `ssh/` | `@jie2gg/dsh-plugin-ssh` | 在设置页管理命名 SSH 目标与凭据（密钥 / 密码）；`ssh` 工具把别名清单交给模型按对话选择，可远程执行、读写文件、scp 上传下载 | experimental |

## 使用

插件可发布到 npm 后安装，也可从本仓库的对应目录直接安装（本地文件夹 / git）。
安装后在 DSH 的「插件」管理面板中启用或禁用。

## 开发

新增插件请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，其中定义了标准目录结构与必需字段；
AI agent 协作与仓库导航约定见 [AGENTS.md](AGENTS.md)（`CLAUDE.md` 为其符号链接）。

## 许可证

[Apache-2.0](LICENSE)
