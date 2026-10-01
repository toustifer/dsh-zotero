# M0 审计报告：llm-for-zotero → DSH 插件移植

> **谱系说明**：本报告审计的是第一个源头 yilewang/llm-for-zotero。
> 之后早期曾参考 [Fisfzy/dsh-zotero](https://github.com/Fisfzy/dsh-zotero) 这份 DSH 插件实现
> （它本身也是由 yilewang/llm-for-zotero 重构而来，`Initial commit` 为 `a4346e0`，2026-08-27）。
> 2026-09 中旬起本项目独立演进，两者代码已几乎不重合，现已拆分为独立仓库。完整来历见 `README.md`。

- 审计对象：https://github.com/yilewang/llm-for-zotero（浅克隆，`upstream/llm-for-zotero`）
- 上游版本：package.json `version 3.9.2`；commit `32ce6a02f5cf61574bf03655bdda21f32e029cd0`（2026-08-25）
- 规模：`src/` 下 495 个 TypeScript 文件；根目录含 `addon/`、`assets/`、`doc/`、`test*` 等
- 用途：Zotero 7/8/9 客户端插件（XPI），把 LLM 接入 Zotero reader 侧栏
- License：AGPL-3.0-or-later（移植时保留出处声明）

## 一、上游总体架构（理解后再断言）

上游是**运行在 Zotero 进程内**的插件，数据访问完全没有走外部 HTTP Local API：

```
┌─────────────── Zotero 进程 ───────────────┐
│  XUL/React contextPanel（PDF reader 侧栏） │
│  agent loop（agent/）                      │
│   ├─ tools/（read + write 两族，~40 个）    │
│   ├─ services/（zoteroGateway：直接调 Zotero 内部 API）
│   ├─ skills/（8 个 Markdown 技能/prompt）  │
│   ├─ mcp/（JSON-RPC over Zotero HTTP :23119）
│   └─ webchat/（relay 到 ChatGPT Web）      │
│  providers/（responses_api / openai_chat_compat /
│             anthropic_messages / gemini_native / codex / claudeCode）
│  utils/mineruClient（cloud v4 + local :8000 /file_parse）
└───────────────────────────────────────────┘
```

- 对外暴露两个内嵌服务：`/llm-for-zotero/mcp`（MCP JSON-RPC，供本地 Codex app-server 调）与 `/llm-for-zotero/webchat` relay。
- **没有任何代码对 Zotero Local API（`127.0.0.1:23119/api/...`）发起请求** → 我们的 DSH 插件（进程外）需要**新写 Local API 客户端**，上游此部分不可复用。
- 上游自带 LLM 客户端（`utils/llmClient.ts` 144KB）与端点配置（自建 provider/model 选择）→ 按方案**废弃**，改用 DSH 模型适配器。

## 二、功能清单（上游有/无 → 本方案 P0/P1/P2 映射）

| # | 功能 | 上游实现（参考文件） | 本方案 | 备注 |
|---|------|--------------------|--------|------|
| 1 | Chat with PDF（整篇上下文 + follow-up 聚焦检索） | `modules/contextPanel/pdfContext.ts`, `chat.ts` | **P0** | 核心资产：chunking 常量与检索服务 |
| 2 | 文献总结（overview/targeted/全文/图表） | `paperRead.ts`（mode: overview/targeted/full/figures/visual/capture） | **P0** | tools 语义直接可用 |
| 3 | 库检索/浏览（items/collections/tags/saved searches/library 树） | `queryLibrary.ts` + `services/libraryIndex/` | **P0** | `library_search` facade 描述与 guidance 可复用 |
| 4 | 阅读 PDF 附件（PDF/DOCX/MD/TXT 提取文本） | `readAttachment.ts`, `attachmentReadService.ts` | **P0** | 我们主走 MinerU；附件读文本兜底 |
| 5 | 跨文比较 / 多文上下文（`/` 斜杠引用、compare-papers skill） | `multiContextPlanner.ts` | **P0 延伸（M3 面板多选）** | 面板送入多篇即触发 |
| 6 | 文献翻译（整文/整段） | **上游无此功能**（"translate" 仅出现在引用规则：引文不得翻译） | **P1（新写）** | 用 DSH 模型适配器 + prompt 即可，无需上游资产 |
| 7 | 笔记写入 Zotero（create/append/edit，Markdown/HTML） | `writeNotesBatch.ts`, `note_write` facade | **P1** | Local API `POST /items`（childNote）+ `PATCH /items/{key}` |
| 8 | 文件式笔记（Obsidian/Logseq 本地 Markdown + 模板 + frontmatter 锁定） | `write-note.md` skill + `fileIO.ts` | **P1 可选** | 模板和 frontmatter 规则已在 skill 里，可整体搬 |
| 9 | RAG / 库级检索（evidence retrieval, embedding 可选, query plan LLM 改写） | `retrievalService.ts`, `retrievalQueryPlan.ts` | **P2** | 依赖"全文索引"，M4 daemon 预解析后做 |
| 10 | MinerU 解析（cloud v4 + local :8000；全自动 watch/批量/同步包装/标签） | `utils/mineruClient.ts`(53KB), `modules/mineru*` | **P2→实则前置** | M2 即接入 client，M4 加上批量预解析 |
| 11 | 全文检索（库内 fulltext search） | Zotero advanced search `fulltextContent`（libraryIndex/searchable） | **P0（经 Local API fulltext）** | fulltext 检索本地经 `qmode=everything`，无索引时按标题/摘要 |
| 12 | 图/表解读（MinerU images + figures mode） | `pdfFigureExtractionService.ts` | **P2 可选** | 依赖 MinERU 图片产物 |
| 13 | 引用/释义跳转（citation binder） | `quoteCitations.ts`, `paperAttribution.ts` | 面板联动时做 | 我们提供 sourceLabel + 页码，DSH 侧不做 Zotero reader 跳转 |
| 14 | Agent Mode（写操作确认卡、undo、revert） | `agent/`（requiresConfirmation 机制） | **P1 简化版** | DSH 侧用工具事件/确认或直接限制为只读+笔记写回 |
| 15 | 外部学术检索（OpenAlex/arXiv/EuroPMC/CrossRef, review 工作流） | `literatureSearchService.ts` | P2 可选 | 本机另有 lit_* 工具，不重复 |
| 16 | Codex/Claude Code/WebChat 后端 | `codexAppServer/`, `claudeCode/`, `webchat/` | **废弃** | 不移植 |
| 17 | XUL/React 侧栏 UI、standalone window、preferences 页面 | `modules/contextPanel/**` | **废弃** | 改为 DSH 右侧栏面板（M3） |
| 18 | 自建 provider/endpoint/模型选择 UI | `modelProviders.ts`, `preferenceScript.ts` 等 | **废弃** | 复用 DSH 模型适配器 |

## 三、可复用 Prompt / 资产清单（直接搬运优先级高）

### 3.1 技能/prompt（Markdown，8 个 —— 直接可搬，几乎零改）

| 文件（`src/agent/skills/`） | 内容 | 用途 |
|---|---|---|
| `simple-paper-qa.md` | 单篇 paper QA：one read 策略、引用规范（blockquote 只用于原文、引文不得翻译、quote anchor 用法） | P0 Chat with PDF 的系统提示骨架 |
| `evidence-based-qa.md` | 定位特定方法/结果/证据段落，返回带页码引文 | P0 聚焦检索回答 |
| `analyze-figures.md` | 图表分析（MinerU images） | P2 |
| `compare-papers.md` | 多文比较（主题/方法/结果） | P0 延伸 |
| `library-analysis.md` | 整库统计/主题分析 | P1 |
| `literature-review.md` | 结构化综述 | P2 |
| `write-note.md` | **笔记模板 + 7 字段 frontmatter 锁定 + 文件名规则 + 图片嵌入规则 + 检查清单**（344 行，质量最高） | P1 笔记回写 |
| `import-cited-reference.md` | DOI 导入 | P2 可选 |

### 3.2 行为规则文本（上游在 prompt 里累积的"血泪规则"，可直接进 DSH prompt 配置）

- `utils/llmDefaults.ts`（默认系统提示，含引用/证据规范段落）
- `agent/model/agentPersona.ts`（persona + paper_read 各 mode 用法 + 引用规则）
- `agent/context/resourceContextPlan.ts`（技能注入与引用纪律）
- `modules/contextPanel/paperAttribution.ts`（sourceLabel 生成与引用规范）
- `modules/contextPanel/retrievalQueryPlan.ts`（query plan 生成 prompt："生成同语言变体，含翻译/缩写/notation variants"）

### 3.3 检索/分块常量与算法（P0/P2 直接用）

- `modules/contextPanel/constants.ts`：
  - `CHUNK_TARGET_LENGTH = 2000`（字符），`CHUNK_OVERLAP = 200`
  - `RETRIEVAL_MIN_ACTIVE_PAPER_CHUNKS = 2`，`RETRIEVAL_MIN_OTHER_PAPER_CHUNKS = 1`
  - `PAPER_FOLLOWUP_RETRIEVAL_MIN_CHUNKS = 2`, `MAX = 5`
- `services/retrievalService.ts`：evidence cache key（小写+去标点+120 字符截断）、perPaperTopK 默认 4、topK 默认 6、按 score 降序
- `pdfContext.ts`：`splitIntoChunks`（按段落边界切 2000 字符）与 `splitMarkdownIntoChunks`（按标题切，保留 section 结构）——MinerU full.md 走后者

### 3.4 工具语义（facade 工具名 + 描述 + guidance，可在 M1 直接改编为 DSH 工具描述）

模型可见 facade 集（`agent/tools/index.ts`）：

- 读：`library_search`、`library_read`、`library_retrieve`、`paper_read`（mode: overview/targeted/full/figures/visual/capture）、`literature_search`
- 写：`library_update`、`collection_update`、`note_write`、`note_write_batch`、`library_import`、`library_delete`、`attachment_update`、`undo_last_action`、`revert_changes`、`annotate_pdf`、`saved_search_update`、`library_settings`、`cite_export`
- 高级：`file_io`、`run_command`、`zotero_script`（带确认）
- 内部原语（标注 internal，被 facade 委托）：queryLibrary/readLibrary/readPaper/searchPaper/viewPdfPages/readAttachment/applyTags/…

`MCP_SCOPE_TABLE`（`mcp/server.ts`）给了与 scope 相关的参数名惯例（`itemId`, `paperContext`, `activeContextItemId`…），面板送上下文时可沿用。

### 3.5 MinerU 集成契约（M2 核心，可近乎原样移植）

- **Cloud**（`utils/mineruClient.ts`）：
  - Base：`https://mineru.net/api/v4`，`Authorization: Bearer <key>`
  - 流程：`POST /file-urls/batch`（拿 OSS 上传签名）→ multipart 上传 → 轮询 `GET /extract-results/batch/{batchId}`（间隔 3s→15s→60s，超时 10/30min）→ 下载 zip 产物
  - 模型：pipeline / vlm（默认 vlm）；`/extract-results/batch/_test` 做连通性测试
- **Local**（`mineru-api` 兼容服务）：
  - Base 默认 `http://127.0.0.1:8000`（normalize：去尾斜杠）
  - `POST /file_parse`（multipart，同步；无 job 状态）→ 返回 zip 字节
  - backend 参数：pipeline / vlm-auto-engine / hybrid-auto-engine（默认 pipeline）
  - 忙时重试间隔 [5,15,30,60,120]s；`LOCAL_PARSE_TIMEOUT_MS=0`（不设超时，靠显式 abort）
  - 支持 AbortSignal 取消（`MineruCancelledError`）
- **配置项**（`utils/mineruConfig.ts`）：enabled / mode(cloud|local) / apiKey / cloudModel / localApiBase / localBackend / forceOcr / maxAutoPages(默认100) / excludePatterns(子串或 `/regex/`) / autoWatchCollections / globalAutoParse / syncEnabled
- **缓存布局**（`modules/contextPanel/mineruCache.ts`）——DSH 侧迁移为 workspace 缓存：
  ```
  <cacheRoot>/mineru/<attachmentId>/
    full.md            # canonical 全文 markdown
    content_list.json  # 块清单（标题偏移/section）
    images/…           # 提取图（stableHash 去重命名: <stem>-<hash8>.<ext>）
    manifest（sourcePath 指纹 → 判断失效重建）
  ```
  - 注意上游缓存原样存 zip 解包；DSH 侧直接存 full.md + images + manifest.json。

### 3.6 字段投影（`services/libraryIndex/projection.ts` + `contracts.ts`）

- `LibraryIndexItem` 契约：itemID/key/itemType/title/creators/year/dateAdded/dateModified/collections/tags/notes/attachments/searchable 文本
- `projectItem()` 产出 searchable 拼接（title+creators+abstract+tags+DOI+publicationTitle 等）
- DSH 侧输入是 Local API JSON，字段名基本一致（itemType/title/creatorSummary/date/abstractNote…），直接适配映射即可，无冲突。

## 四、关键差异与移植决策

| 差异点 | 决策 |
|---|---|
| 数据源：上游用 Zotero 内部 API | DSH 插件（进程外）用 **Zotero Local API**（`127.0.0.1:23119/api/users/{libID}/...`，Basic auth 可选）。需要新写客户端（`src/zotero/localClient.ts`）。Local API 需 Zotero 7+ 且 HTTP server 开启；健康检测 `/connector/ping` + `/api/users/0/items?limit=1` |
| 桌面端关闭 | 降级 **Zotero Web API**（`api.zotero.org`，userId + apiKey → 读元数据/全文；附件正文无法拿 → 只用摘要和元数据，标注降级） |
| PDF 正文获取 | 上游经 Zotero 内部取附件路径 + pdfService。DSH：Local API `GET /items/{key}/file`（或附件路径直读本地文件，需要 Zotero 返回 `filePath`? Local API 不返回路径）→ 实际策略：**先尝试 Local API 附件下载**，再按配置走 MinerU（cloud/local）。M2 验证。注：如果 Zotero 库在本地且用户授权，也可配置 dataDir 直读文件（M2 再做调研）—保留为增强项 |
| LLM 调用 | 上游自建 client+provider 选择 → **废弃**，DSH 模型适配器统一处理；prompt 资产进 DSH 配置（可覆盖） |
| UI | 上游 XUL/React 侧栏 → **废弃**，DSH 右侧栏面板（M3）：库树 + 条目详情 + 全文问答 + 产出物区 + "送入当前对话" |
| 翻译（P1） | 上游无 → 新写：`zotero_translate` 工具 = 取全文/选中段 → DSH LLM 翻译 → 返回双栏译文；prompt 可配置 |
| 写操作安全 | 上游确认卡机制（写前 confirmation）→ DSH 用 tools/** 事件（guard/pre-execute）或先只读，笔记写回（P1）设确认门槛；`undo_last_action` 不做（Local API 无事务） |
| Agent loop | 上游自带完整 agent loop + cache-aware compaction → **不移植**，DSH agent loop 原生具备；只移植工具与提示词 |
| RAG | 上游 retrievalService（可选 embeddings + LLM query plan）→ P2：M4 daemon 预解析（MinerU）→ workspace 缓存 → 简单 BM25/关键词检索（不引向量库，保持零依赖；embeddings 可作为配置项接 DSH 模型适配器） |

## 五、执行映射（M1–M4）

- **M1**：`dsh-zotero` hybrid 插件骨架 → `src/zotero/localClient.ts`（Local API + 健康检测 `zotero_health`）→ 三个工具：
  - `zotero_search`（items/collections/tags，q/qmode/sort/limit 映射 `library_search` 子集）
  - `zotero_get_item`（单条 + 子项 + 附件清单，映射 `library_read` 子集）
  - `zotero_collections`（库树，映射 `collection_list`/view:tree）
  - 验证：dev_build_plugin + dev_inject_plugin + zotero 未启动时的优雅报错
- **M2**：移植 MinerU client（cloud/local，AbortSignal，配置 schema 对应项）→ `zotero_read_pdf`（下载/取路径 → MinerU → 缓存 full.md，返回摘要+段落索引）→ `zotero_summarize`（overview/targeted，prompt 用 simple-paper-qa/evidence-based-qa）→ `zotero_translate`（P1 前置）
- **M3**：右侧栏面板（DOM 注入 GUI 对话页侧栏：库树、条目详情、全文问答发起、产出物列表、"送入当前对话"按钮 → agent.inject 进当前会话上下文）+ 完整设置 schema
- **M4**：`zotero_note_write`（create/append/edit，walk write-note.md 模板规则）+ daemon 预解析（timer 扫描 + 队列 + 状态持久化到 workspace）+ RAG（可选开关）

## 六、风险与前置条件

1. **本机无 Zotero Desktop 时无法端到端验证** → 工具层必须优雅报错（含明显引导文案），M1 起就要mock 测试（fixtures 用 Local API JSON 样例，放 `test/fixtures/`）。
2. Local API 新版本 Zotero 8 可能增加 `api.httpServer.port` pref，端口探测要做（先试 23119，再读 `connector/ping` 或按 pref 注入的配置）。
3. MinerU cloud 需要 apiKey（配置里可选降级：无 Key → 自动退 local，无 local → 摘要降级为元数据/摘要）。
4. AGPL-3.0 传染：移植代码保留 LICENSE 与出处声明（项目 README + 文件头注释）。
