# dsh-llmwiki

[English](README.md) | 简体中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的第三方 Markdown wiki 存储与检索插件，采用本地优先设计，关联原始来源，灵感来自 [Karpathy 的 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。

本项目由 EveGoodEvening 维护，并非 DeepSeek 或 DeepSeek Harness 官方项目。提及 DeepSeek Harness 和 Andrej Karpathy 仅用于说明兼容性与灵感来源，不代表任何隶属、赞助或背书关系。

- 按 SHA-256 保存不可变来源，并编写引用这些来源的 Markdown 页面。
- 使用确定性的词法索引搜索页面章节；索引过期时重建。
- 通过不调用模型的 lint 检查结构、链接和完整性。

插件不会调用模型，也不会发起网络请求。内容综合与语义审查由调用它的智能体负责；引用来源只能证明对应记录存在，不能证明其支持相关主张。

## 环境要求

| DSH（`@deepseek-ai/dsh`） | Cordis（`@deepseek-ai/cordis`） | 状态 |
| --- | --- | --- |
| **`0.2.0-rc.2`** | **`4.0.4`** | **推荐** |
| `0.1.7-rc.2` | `4.0.4` | 支持 |
| `0.1.1-rc.2` | `4.0.1` | 支持的旧版本 |
| `0.1.0-rc.6` | `4.0.1` | 支持的旧版本 |

- **Node.js：** `^22.19.0 || >=24`。
- **pnpm：** `11.7.0`，执行 `dsh plugin` 和开发时需确保其位于 `PATH` 中。
- 使用相互兼容的同一系列 DSH 服务，不要混用不同的候选发布版本。`0.1.0-rc.6` 宿主会将其五个 DSH 服务对等依赖解析为 `0.1.0-rc.8`；表中其他宿主使用与自身版本相同的服务。
- 直接通过 Cordis 加载时，还需要 DSH 的 `tools`、`commands` 和 `systemPrompt` 服务，以及一份共享的 `@deepseek-ai/schemastery@^3.18.1` 安装。参见[准确的对等依赖版本范围](package.json)和[独立加载示例](examples/README.md)。

[package.json](package.json) 中的插件版本独立于上表中的 DSH 和依赖版本。

## 安装

请使用 **`@evegoodevening/dsh-llmwiki`**。不带作用域的 `dsh-llmwiki` 包属于另一个项目。

在当前检出的仓库中打包并安装 `0.0.1`，同时确保受支持的 DSH 宿主位于 `PATH` 中（以下以 `web` profile 为例）：

```sh
pnpm install --frozen-lockfile
pnpm pack
dsh plugin --profile web add ./evegoodevening-dsh-llmwiki-0.0.1.tgz
```

当该包在 npm 上可用时，等效的仓库安装命令为 `dsh plugin --profile web add @evegoodevening/dsh-llmwiki@latest`。

安装后插件仍处于**禁用**状态。请通过由操作者维护的补丁启用，并显式指定可写的 wiki 根目录：

```sh
mkdir -p "$HOME/.config/dsh"
cat > "$HOME/.config/dsh/llmwiki-web.patch.yml" <<YAML
- insert:
    - id: llmwiki
      name: '@evegoodevening/dsh-llmwiki'
      config:
        root: '$HOME/.local/share/dsh/llmwiki/web'
YAML
dsh --profile web --patch "$HOME/.config/dsh/llmwiki-web.patch.yml" --dump-config
dsh --profile web --patch "$HOME/.config/dsh/llmwiki-web.patch.yml"
```

每次启动都要带上该补丁；修改后请重启正在运行的 profile。使用 `/wiki status` 检查仓库状态。更改已安装的包之前，先停止所有写入操作并备份根目录。保留同一个显式指定的根目录，即可复用已有 wiki 数据；启用前请检查下文的文件系统要求。

如需卸载插件但保留 wiki 数据：

```sh
dsh plugin --profile web remove @evegoodevening/dsh-llmwiki
```

本地 tarball 安装或独立 Cordis 加载方式，参见[可运行示例](examples/README.md)。

## 使用

### 命令

| 命令 | 用途 |
| --- | --- |
| `/wiki status` | 报告初始化状态、来源/页面数量及索引状态；也是 `/wiki` 的默认操作 |
| `/wiki lint` | 报告结构错误和警告，不进行任何修复 |
| `/wiki reindex` | 重建派生的搜索索引 |

### 智能体工具

| 工具 | 用途 |
| --- | --- |
| `llmwiki_status` | 检查存储并读取由人工维护的 schema |
| `llmwiki_add_source` | 原样保存 UTF-8 内容，返回来源 ID |
| `llmwiki_list_sources` | 分页浏览来源元数据 |
| `llmwiki_read_source` | 读取已保存的内容及来源信息 |
| `llmwiki_search` | 查找按相关性排序的页面章节匹配结果 |
| `llmwiki_list_pages` | 分页浏览页面元数据和哈希 |
| `llmwiki_read_page` | 按逻辑 ID 读取页面的原始 Markdown 及其 SHA-256 |
| `llmwiki_upsert_page` | 创建或有条件地更新引用已有来源 ID 的页面 |
| `llmwiki_lint` | 检查结构、完整性、链接及索引是否最新 |

先查看状态和 schema。仅在获得用户授权后保存来源并维护受影响的页面。即使没有写入，也要在**语义审查之前**运行结构 lint；发生任何更新后，再运行一次。语义层面的发现是智能体的判断，不是 lint 结果。完整工作流见[运行时提示词](src/prompt.ts)；参数见[工具 schema](src/tools.ts)。

搜索使用经 NFKC 规范化和小写转换后得到的确定性词元，并采用 BM25 字段加权；分数相同时，按页面 ID 和章节起始行排序。片段围绕最早出现、能完整容纳且参与评分的查询词元，展示规范化正文中的连续上下文；词元为完整的字母/数字串，或现有的 CJK 双码点 n-gram，同一位置的候选按词元的 UTF-16 字典序打破平局。片段大小不超过 `maxSnippetBytes`，不会截断 UTF-8 码点，也不添加省略标记。分散的查询词不一定全部出现在片段中。仅标题/章节标题匹配，或正文词元过大而超出上限时，改用受长度限制的正文前缀。

### 页面写入前置条件

每次写入页面都必须提供 `expectedSha256`：创建尚不存在的页面时使用 `null`；更新已有页面时，使用读取页面或目录列表返回的、对原始 Markdown 计算出的精确 `sha256`。遇到 `PAGE_CONFLICT` 时，先重新读取页面并整合差异，再重试；不要使用过期哈希覆盖页面，也不要盲目重试。

## 配置

所有配置项均为可选。数值必须为整数；未知配置项会被拒绝。

| 配置项 | 默认值 | 含义 / 限制 |
| --- | --- | --- |
| `root` | `.llmwiki` | 非空路径；基于宿主进程的 cwd 一次性解析 |
| `maxSourceBytes` | `2097152` | 来源内容上限：2 MiB；最小为 1 字节 |
| `maxPageBytes` | `524288` | 渲染后的页面正文上限：512 KiB；最小为 1 字节 |
| `maxResults` | `20` | 搜索和目录列表的每页条目数上限；`1..100` |
| `maxSnippetBytes` | `1200` | 搜索片段上限；`64..16384` 字节 |
| `commandDiagnosticLimit` | `20` | `/wiki lint` 输出的诊断条目数；`1..100` |

## 存储与安全

```text
<root>/
  schema.md                  # 由人工维护的指引；仅在不存在时创建
  sources/<sha256>/
    content                  # 不可变的 UTF-8 来源
    metadata.json            # 来源信息与采集元数据
  pages/<page-id>.md          # 包含标题、摘要和来源 ID 的 Markdown
  .index/{search,state}.json  # 派生的、可重建的搜索数据
```

- **宿主机存储，而非 DSH 沙箱。** 直接使用 Node 文件系统 I/O，会绕过 `ctx.fs`、DSH 权限模式、审批、编辑前读取要求，以及远程/工作区提供器。如果必须依赖这些控制机制，请勿启用本插件；应通过操作系统权限和进程隔离来实施边界约束。
- **每次激活使用固定的根目录。** 会话/工作区的 cwd 发生变化时，不会切换存储位置。通过不同根目录实现隔离；互不信任的租户不得共用根目录或同一次插件激活实例。不支持跨激活实例/进程并发写入。不要允许不受信任的进程修改根目录。
- **文件系统后端。** 以文件描述符约束路径访问的存储后端需要 Linux、数值形式的 nofollow/目录打开标志，以及已挂载且可用的 `/proc/self/fd`。所需能力不受支持或不可用时，会以 `UNSAFE_FILESYSTEM` 拒绝操作；不会回退到基于路径名的访问方式。不支持非 Linux 的文件描述符后端，也不声称已证明其安全性。每次操作都会固定根目录和子目录的描述符，打开最终文件时不跟随符号链接；已初始化根目录的设备号/inode 标识必须保持不变。
- **对抗保证的边界。** 固定描述符的路径遍历可防止符号链接替换将文件系统操作重定向到根目录外的符号链接目标。但这并非整棵目录树的事务，也不提供 compare-and-rename（比较后重命名）保证。已授权访问的目录被重命名到原有路径名所定义的根目录之外后，仍可能保持可访问。普通文件/硬链接注入、借助特权进行挂载或访问进程，以及恶意替换 procfs，均不在此保证范围内；仍须依赖操作系统隔离，并禁止不受信任的写入者。
- **部分读取操作可能写入。** 状态查询、目录列表和 lint 从不写入。读取来源/页面以及搜索可能初始化存储；搜索还可能重建索引。只读部署需要已初始化的仓库及最新索引。
- 插件从不编辑或删除来源。已有的 `schema.md` 会被保留；不提供编辑 schema 的 API。

### 来源写入中断

来源写入中断后，以相同内容重试 `llmwiki_add_source`（或 `ctx.llmwiki.addSource`）。恢复仅限于**尚未提交 `metadata.json`** 的最终来源目录；该目录必须为空，或仅包含内容匹配的已持久化 `content` 和/或可识别为写入器产生的临时文件（必须为普通文件）。匹配的持久化内容会被保留；元数据使用重试时提供的来源信息，并在最后提交。恢复操作返回的回执带有 `deduplicated: false`；下一次使用相同内容重试时会去重。

有效且完整的记录始终会去重，不会更改首次提交的元数据/来源信息字节。内容或元数据损坏、包含未知子项，或子项为符号链接/非普通文件的记录，都会被拒绝，且被拒绝的记录保持不变。读取、目录列表和 lint 不会修复部分写入的记录，也不会将其视为有效记录；如上所述，读取来源/页面仍可能初始化存储布局。这只是针对崩溃后重试的有限恢复机制，并非通用修复/隔离设施，也不是多页面事务。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:e2e
pnpm run check:determinism
pnpm run smoke
```

Linux 单元测试套件中的只读 tmpfs 测试需要 root 权限和挂载命名空间能力。E2E 会先构建，再在受支持的宿主版本矩阵中测试打包后的包；请与其他构建分开运行，因为它会临时隐藏共享的仓库检出路径。常规 smoke 使用固定的旧版开发依赖，而非推荐宿主。

- **上游兼容性：** `pnpm run check:compatibility` 分别检查使用原生依赖的最新版 DSH，以及强制使用最新版 Cordis 的情况。此检查需要联网，但不调用模型；检查结果不会自动扩展支持表。参见[定时工作流](.github/workflows/compatibility.yml)。
- **真实智能体 smoke：** 设置 `DEEPSEEK_API_KEY`、`LLMWIKI_AGENT_SMOKE_MODEL` 和 `LLMWIKI_AGENT_SMOKE_NETWORK=allow`，然后运行 `pnpm run smoke:agent`。这项独立且需要凭据的检查使用固定的 DSH `0.1.1-rc.2` 运行器；离线检查不能证明模型行为。
- **发布：** [发布工作流](.github/workflows/publish.yml)使用 npm Trusted Publishing，针对与 `package.json` 版本匹配的 `v*` 标签执行发布。

## 参考资料 / 致谢

设计与集成工作参考了以下来源：

- [Andrej Karpathy 的 LLM Wiki 构想文件](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)——主要概念灵感：不可变的原始来源、由 LLM 维护的持久化 Markdown wiki、schema 指引，以及导入/查询/lint 工作流。它描述的是一种模式，而非必须遵循的实现或 API。
- [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki)——其智能体技能中的 raw/wiki/schema 分离、证据要求，以及明确的导入/查询/lint 工作流。具体的分流处理与级联更新指引，其限定范围的归属说明及保留的 MIT 许可证见[第三方声明](THIRD_PARTY_NOTICES.md)。
- [ddsyasas/llm-wiki](https://github.com/ddsyasas/llm-wiki)——持久化来源/页面记录、索引优先导航，以及确定性 lint 与模型判断的分离。本项目未采用其 Next.js/SQLite/FTS 应用架构。
- [Praney Behl 的 llm-wiki-plugin](https://github.com/praneybehl/llm-wiki-plugin)——其搜索工具中的章节级词法检索与稳定的证据输出，以及导入工作流中的精准页面更新、引用和用户审查边界。本项目未采用其 Python/uv/FastEmbed/sqlite-vec 运行时。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/fa7e9f5a)——Cordis 插件与服务约定、生命周期归属、工具/命令/系统提示词注册，以及 profile bundle 集成。最初的集成研究使用修订版本 `fa7e9f5a`；受支持的运行时版本见上表。

这些致谢用于说明设计影响和集成参考，并不意味着相关作者或项目为本项目背书。本包的 MIT 许可证不会改变所引用作品的许可；这些作品仍受各自的版权和许可条款约束。

## 许可证

[MIT](LICENSE) © EveGoodEvening。

有关工作流指引的归属范围及保留的完整上游许可证，请参见[第三方声明](THIRD_PARTY_NOTICES.md)。本项目的 MIT 许可证不能替代该声明。
