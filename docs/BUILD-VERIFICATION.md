# dsh-zotero 构建环境与打包通路验证报告

## 1. 验证背景与目标
- 目标：验证并跑通 `dsh-zotero` 插件的依赖安装与打包通路。
- 环境要求：避免使用 npm 11，使用 pnpm；支持 Windows 路径与 DSH 环境自动探测；跑通 host 与 client 双端构建。
- 工作目录：`C:\Users\15775\.dsh\plugins\dsh-zotero\.agentflow-worktrees\zotero-fusion-v1`
- 分支：`feat/zotero-fusion-v1`

## 2. 发现的环境与脚本兼容性问题及修复

1. **pnpm peerDependencies 解析问题**：
   - 现象：pnpm 11 在 `pnpm install` 时默认开启 `auto-install-peers`，尝试从 registry 拉取私有的 `@deepseek-ai/*` 依赖，导致 404 失败。
   - 修复：在项目根目录添加 `.npmrc` 配置 `auto-install-peers=false`，避免拉取 DSH 内部私有 peer 依赖。

2. **Windows 下 bash 构建脚本不兼容**：
   - 现象：`package.json` 中的 `build` 脚本配置为 `bash scripts/build.sh`，在 Windows 终端中调用 `bash` 时遇到 `set: pipefail: invalid option name`，且在无 bash 环境中无法直接运行。
   - 修复：
     - 将 `package.json` 中的 `"build"` 统一改为 `"node scripts/build.mjs"`，实现跨平台无缝执行。
     - 调整 `scripts/build.sh`，移除 Windows 终端 sh 不兼容的 `pipefail`，改用标准的 `set -e`。

3. **构建脚本 `scripts/build.mjs` 环境探测支持增强**：
   - 现象：原脚本强依赖 `~/.dsh/.external-plugins` 目录下的 donor plugin 包含 `typescript` + `cordis` + `tsdown`，在标准已安装 DSH（`~/.npm-global/node_modules/@deepseek-ai/dsh`）且插件位于 `~/.dsh/plugins` 的 Windows 环境中会直接报错退出。
   - 修复：
     - **Windows 全局 npm 路径探测**：增加对 Windows 平台常见的 `~/.npm-global`、`%APPDATA%/npm` 等 fallback 探测。
     - **DSH 核心模块来源探测**：支持从 `join(dshNm, '@deepseek-ai', ...)` 与 `~/.dsh/profiles/node_modules` 动态解析 `cordis`、`cosmokit`、`schemastery` 等依赖。
     - **Slots 服务探测**：在 `candidateSlots` 中加入 `profiles/node_modules/@deepseek-ai/dsh-client-ui-slots` 及 `plugins` 候选探测。
     - **复用本地构建工具**：优先使用项目本地 `pnpm install` 安装的 `node_modules/typescript` 与 `node_modules/tsdown`，避免破坏本地已安装依赖。
     - **Windows 软链保护**：在 `linkPkg` 中增加同路径判等与安全清理逻辑，使用 `junction` 确保 Windows 下的兼容性。

## 3. 构建与打包验证结果

| 命令 / 步骤 | 状态 | 产物 / 输出 |
|---|---|---|
| `pnpm install` | PASS | 依赖解析完成，本地装载 pdfjs-dist、typescript、tsdown 等依赖 |
| `pnpm run build` | PASS | `scripts/build.mjs` 自动探测 installed dsh 环境，建立软链并调用 tsc 完成 host 编译，生成 `lib/*.js` 及 `lib/types/` |
| `pnpm run build:client` | PASS | `tsdown` (rolldown) 成功打包 `src/client/index.tsx`，生成 `lib/client.js` (899.94 kB) 与 `lib/client.js.map` (1.53 MB) |
| `pnpm run typecheck` | PASS | `tsc -p tsconfig.json --noEmit` 类型校验 0 错误 |
| `node tests/smoke-m2.mjs` | PASS | zip unpack 与 cache 目录解析测试全部通过 (7/7 checks) |
| `node tests/test-annotations.mjs` | PASS | Markdown notes 生成、Zotero Item Payload 构建与端到端 mock 测试全部通过 (25/25 checks) |

## 4. 结论
`dsh-zotero` 在当前 Windows 环境下的依赖安装、双端打包（host tsc + client tsdown）以及自动化测试通路全部验证通过。
