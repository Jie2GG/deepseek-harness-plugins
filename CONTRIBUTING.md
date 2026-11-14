# 插件开发规范

每个插件是一个顶层目录，目录名即插件短名（小写字母、数字、连字符，例如
`session-peek/`）。包名统一使用 `@jie2gg/dsh-plugin-<短名>`。

## 标准目录结构

```
<plugin-name>/
├── package.json       # 包元数据与 DSH 插件声明（见下）
├── cordis.patch.yml   # bundle 入口：声明该插件组装哪些 plugin 模块
├── src/
│   └── index.ts       # 插件实现（name / inject / apply / Config）
├── icon.svg           # 插件列表小图标（SVG/PNG/JPEG/WebP，≤ 256 KiB）
├── locale/
│   ├── en.json        # meta.title / meta.description / meta.detail
│   └── zh.json        # 中文元信息（UI 切中文时详情页用 zh 文档）
├── docs/
│   ├── DETAIL.md      # 插件详情页正文（英文）
│   └── DETAIL.zh.md   # 插件详情页正文（中文）
└── README.md          # 仓库内开发者说明（API、设计动机、限制）
```

## package.json 必需字段

- `"name": "@jie2gg/dsh-plugin-<短名>"`，`"version"`（语义化版本）、`"description"`
- `"type": "module"`，入口 `main` / `exports` 指向构建产物 `lib/`
- `exports` 必须暴露 `"./locale/*.json": "./locale/*.json"`——Plugin Manager 与设置页在**不激活
  插件**的情况下从导出的 locale JSON 读取 `meta.title` / `meta.description`
- `"engines": { "dsh": "<兼容版本范围>" }` —— DSH 版本不满足时安装与启用会被阻塞
- DSH 核心包（如 `@deepseek-ai/cordis`）声明为 `peerDependencies`
- `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（bundle 形态）
- `"icon": "./icon.svg"`——包根插件用 `package.json` 顶层 `icon` 字段声明；图标必须是声明格式下
  真实有效的图片，须留在包内（绝对路径、URL、越出包的符号链接会被拒绝）
- 把 `icon.svg`、`locale/*.json`、`docs`、`lib/**` 列入 `files`；UI 插件还需列入 client 构建产物，
  每次新增模块或资源后同步更新，发布前核对实际打包文件清单
- `"publishConfig": { "access": "public" }`（若计划发布到 npm）

## 展示元信息（locale/*.json）

```json
{
  "meta": {
    "title": "Human readable title",
    "description": "One or two sentences describing visible behavior.",
    "detail": "docs/DETAIL.md"
  }
}
```

- 英文 `title` / `description` 使用 sentence case（仅首词、专有名词大写）。
- `description` 面向产品用户描述可见行为，以句末标点结束。
- `meta.detail` 是相对包根的路径：以 `/` 分隔、不得越出包根（不允许绝对路径、URL 前缀、`.` / `..`
  段和反斜杠），以 `.md` 或 `.markdown` 结尾；放在 `docs/` 子目录是官方惯例而非硬性校验。
  `meta.detail` 格式错误或所指文件不存在时按 `invalid` 报错，**不会**回退到 README。

## Web UI 插件附加要求

在 Harness Web UI 中渲染的插件（如在会话区、侧栏挂载面板或装饰），除上述必需字段外还需：

- 源码增加 `src/client.ts`，构建产物经 `"./client"` 导出：

  ```json
  {
    "exports": {
      ".": "./lib/index.js",
      "./client": "./lib/client.js",
      "./locale/*.json": "./locale/*.json"
    }
  }
  ```

- `dsh` 字段在 `bundle` 之外增加 `client` 声明（`inject` 列表取决于挂载的 UI 包）：

  ```json
  {
    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },
      "client": {
        "platform": "web",
        "immediately": true,
        "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
      }
    }
  }
  ```

- `files` 同步列入 client 构建产物；slot 注册与展示资源细则见官方
  `cordis-plugin-development` skill 的 `references/ui-plugin.md` 与 decoration 模板。

## 版本号三段语义

每个插件的 `version` 使用三段式 `major.minor.patch`，三段各有固定语义，不得互相挪用：

| 段 | 语义 | 递增时机 |
| --- | --- | --- |
| `major` | 大版本 | 破坏性变更（数据格式、API、安装方式）；由用户拍板 |
| `minor` | 用户认可版本 | 用户对 agent 当前累积的工作**明确表示认可**时 +1，`patch` 同时归零 |
| `patch` | Agent 自动迭代版本 | agent 每完成一轮改动（功能、修复、文档）+1，不等认可 |

- agent 日常提交只动 `patch`：**未经用户认可不得递增 `minor`**，也不得把未认可的
  工作伪装成新的用户线。
- 每次版本变动附对应 CHANGELOG 条目。
- 存量插件同步本规则时不改写历史条目：未被用户认可过的插件把历史迭代数折算进
  `patch` 段（`minor` 记 0），旧编号在历史条目与正文中保留原样，仅在 CHANGELOG
  顶部记一条折算对照；此后的新版本一律按新语义编号。

## 版本与安装验证

1. 每次改动按上文「版本号三段语义」递增 `version`，并附对应 CHANGELOG 条目。
2. 本地验证：DSH 中 `plugin_manager` → `install_bundle` 指定该目录 / 包名，
   确认无 manifest 诊断（标题、描述、图标、详情文档均正常显示），再到设置页
   切换中英文检查文案。

## 插件状态取值

根 `README.md` 插件索引表「状态」列只允许以下三个取值：

| 状态 | 含义 |
| --- | --- |
| `stable` | 已发布到 npm，面向用户使用并正常维护 |
| `experimental` | 可用，但 API / 行为仍在评估，默认不发布到 npm |
| `deprecated` | 不再推荐；在索引中标注弃用、保留一个发版周期后删除 |

## 新增插件流程

1. 复制现有插件目录作起点，或按上文结构新建。
2. 更新根 `README.md` 的插件索引表（该表是全仓权威地图）；改名与弃用同样在
   同一 commit 同步该表。
3. 提 PR（或直接在 main 上提交），commit message 前缀：插件目录改动用插件短名
   （如 `session-peek: add rename watcher`），仓库级改动用 `chore:`。
