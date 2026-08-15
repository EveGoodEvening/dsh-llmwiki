# dsh-llmwiki

面向 DeepSeek Harness（dsh）的本地优先 Markdown 知识库插件，灵感来自 Andrej Karpathy 的 [`llm-wiki`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 构想。保存不可变原始证据，生成带引用的 Wiki 页面，并提供确定性的检索与检查；无需数据库、向量服务或网络连接。

## 核心能力

- **证据留存**：原始内容按 SHA-256 ID 不可变保存并自动去重。
- **可追溯页面**：Markdown 页面必须引用已保存的 source ID。
- **本地检索**：按章节建立可重建的确定性索引。
- **一致性检查**：检查页面格式、引用、路径和索引状态。
- **dsh 集成**：同时提供模型工具、`/wiki` 命令和 system prompt 指引。

## 要求

- Node.js `^22.19.0` 或 `>=24`
- pnpm `11.7.0`
- 兼容版本的 DeepSeek Harness / Cordis 运行环境

## 使用

将 `dsh-llmwiki` 安装到 dsh profile，并启用包内的 `cordis.patch.yml` bundle。默认数据目录为当前工作目录下的 `.llmwiki`。

直接配置 Cordis Loader 时：

```yaml
- id: llmwiki
  name: dsh-llmwiki
  inject: [tools, commands, systemPrompt]
  config:
    root: .llmwiki
    maxSourceBytes: 2097152
    maxPageBytes: 524288
    maxResults: 20
    maxSnippetBytes: 1200
    commandDiagnosticLimit: 20
```

> profile 覆盖会替换整个 `config`，不是深度合并；覆盖时请保留所需字段。

本地命令：

```text
/wiki status
/wiki lint
/wiki reindex
```

模型工具：`llmwiki_status`、`llmwiki_add_source`、`llmwiki_read_source`、`llmwiki_search`、`llmwiki_read_page`、`llmwiki_upsert_page`、`llmwiki_lint`。

完整可运行示例见 [`examples/README.md`](examples/README.md)。

## 数据结构

```text
.llmwiki/
├── schema.md       # Wiki 编写规则
├── sources/        # 不可变原始证据
├── pages/          # 带 source ID 引用的 Markdown 页面
└── .index/         # 可删除、可重建的派生索引
```

## 开发

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
pnpm run smoke
```

## License

[MIT](LICENSE)
