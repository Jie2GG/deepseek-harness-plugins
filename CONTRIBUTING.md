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
- `"engines": { "dsh": "<兼容版本范围>" }` —— DSH 版本不满足时安装与启用会被阻塞
- DSH 核心包（如 `@deepseek-ai/cordis`）声明为 `peerDependencies`
- `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（bundle 形态）
- `"icon": "./icon.svg"`，并把 `icon.svg`、`locale/*.json`、`docs`、`lib/**` 列入 `files`
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
- `meta.detail` 必须是包内子目录中的 `.md` 文件（包根目录下的文档会被拒绝）。

## 版本与安装验证

1. 每次改动更新 `version` 并附 CHANGELOG 条目（可选但推荐）。
2. 本地验证：DSH 中 `plugin_manager` → `install_bundle` 指定该目录 / 包名，
   确认无 manifest 诊断（标题、描述、图标、详情文档均正常显示），再到设置页
   切换中英文检查文案。

## 新增插件流程

1. 复制现有插件目录作起点，或按上文结构新建。
2. 更新根 `README.md` 的插件索引表。
3. 提 PR（或直接在 main 上提交），commit message 前缀用插件短名，
   例如 `session-peek: add rename watcher`。
