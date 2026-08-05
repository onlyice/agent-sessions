# Agent Sessions

一个 macOS 桌面应用，集中浏览、搜索并 **resume** 本机所有 Coding Agent 的会话记录。

支持的 Agent：

| Agent | 存储位置 | Resume 命令 |
|---|---|---|
| **Claude Code** | `~/.claude/projects/<cwd>/<id>.jsonl` | `claude --resume <id>` |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex resume <id>` |
| **OpenCode** | `~/.local/share/opencode/storage/{session,message,part}` | `opencode --session <id>` |
| **Amp** | `~/.local/share/amp/threads/T-*.json` | `amp threads continue <id>` |
| **Pi** | `~/.pi/agent/sessions/<cwd>/<ts>_<id>.jsonl` | `pi --session <id>` |

## 功能

- **统一收集**：扫描所有 agent 的 transcript，归一化成同一套数据模型。
- **友好展示**：类 Claude Desktop 的会话视图，区分 user / assistant / thinking / tool_use / tool_result，工具调用可折叠。
- **全局搜索**：基于 SQLite **FTS5（trigram 分词）**，支持中英文子串搜索；2 字以内的短词（含中文）自动走 `LIKE` 回退。可按 **角色范围**（user / assistant / thinking / tool / system）和 **Agent** 过滤；点击搜索结果可直接跳转到对应消息。
- **一键 Resume**：在已运行的 **Ghostty** 中新开一个 tab，自动 `cd` 到原工作目录并执行该 agent 的 resume 命令。

## 安装

在 macOS 终端运行以下命令，即可自动下载并安装最新版本到 `/Applications`。安装脚本会在完成后通过 `xattr` 移除 macOS 的 quarantine 标记，避免出现无法验证开发者的安全提醒。

```bash
curl -fsSL https://raw.githubusercontent.com/onlyice/agent-sessions/main/install.sh | bash
```

## 技术栈

Electron + React + TypeScript + Vite（electron-vite），原生 `better-sqlite3` 提供 FTS5 全文索引。所有依赖均为当前最新版本，Node 固定在 **LTS 24**（见 `.node-version`）。

> **关于 Electron 版本**：依赖整体取最新，但 **Electron 固定在 41.x**。最新的 Electron 42 携带的 V8 有 API breaking change（`v8::External::New` 增加了第三个参数），当前最新的 `better-sqlite3@12` 原生代码尚未适配、无法编译。Electron 41 是能与最新 `better-sqlite3` 正常编译的最高大版本，待 better-sqlite3 适配后即可升到 42。

## 架构

```
src/main/                Electron 主进程（Node）
  collectors/            每个 agent 一个解析器，扫描磁盘并归一化
    claude / codex / opencode / amp / pi.ts
  db.ts                  better-sqlite3 + FTS5(trigram) 索引与搜索
  indexer.ts             增量索引（以 updatedAt 作为版本标记）
  resume.ts              生成 resume 命令 + 通过 AppleScript 打开 Ghostty 新 tab
  ipc.ts / index.ts      IPC 与窗口/生命周期
src/preload/             contextBridge 暴露的安全 API
src/renderer/            React UI（侧边栏 + transcript 视图 + 搜索）
```

数据流：启动后主进程在后台跑 `reindex()`，把所有 transcript 写入用户目录下的 `index.db`（`app.getPath('userData')`）。会话列表/搜索读索引；打开会话时再按需从源文件解析完整 transcript（省内存）。点底栏 ↻ 可手动重新扫描。

## 开发与运行

工具链版本都被锁定，保证可复现：

- **Node**：`.node-version` 固定在 **24.16.0（LTS）**。配合 fnm 的 shell 集成，`cd` 进目录会自动切到该版本。
- **pnpm**：`package.json` 的 `packageManager` 字段（带完整性哈希）固定在 **11.1.3**，由 corepack 强制启用。

### 首次准备（每台新机器一次）

```bash
fnm install 24 && fnm use   # 读取 .node-version，切到 Node 24
corepack enable             # 启用 corepack 的 pnpm shim；之后 pnpm 自动锁到 11.1.3
                            # （走 fnm 时写在用户目录，无需 sudo）
```

> corepack 是 Node 自带的。只有 `corepack enable` 之后，`packageManager` 的 pin 才会被强制生效——否则系统里其它来源（如 Homebrew）的 pnpm 仍可能被用到。验证：`which pnpm` 应指向 fnm/corepack 的 shim，`pnpm -v` 为 `11.1.3`。
>
> 如需变更锁定版本，用 `corepack use pnpm@<version>`（会更新 `packageManager` 字段并重算哈希）。

### 日常命令

```bash
pnpm install                # 安装依赖；postinstall 会自动:
                            #   1) 校验并修复 Electron 二进制（见下方说明）
                            #   2) 针对 Electron ABI 编译 better-sqlite3

pnpm dev                    # 开发模式
pnpm build                  # 生产构建
pnpm dist                   # 打包 .dmg

pnpm run rebuild:sqlite     # 升级 Electron 后，单独重编 better-sqlite3
```

> **关于 Electron 二进制自愈**：Electron 自带的解压器 `extract-zip` 在 Node 24 + 本机环境下有时会在解压第一个文件后“静默中断”，导致 `node_modules/electron/dist` 不完整、报 “Electron failed to install correctly”。`postinstall` 里的 `scripts/ensure-electron.mjs` 会检测这种情况并改用 macOS `ditto` 重新解压（`ditto` 还能正确保留 `.app` 的符号链接与签名），对你完全透明。若手动遇到该报错，单独跑 `node scripts/ensure-electron.mjs` 即可修复。

## Resume 需要的系统权限

“Resume in Ghostty” 通过 AppleScript + System Events 向 Ghostty 发送 `⌘T` 并键入命令，因此需要授予控制进程 **辅助功能（Accessibility）** 权限：

- 开发模式下控制进程是 **Electron**；打包后是本应用。
- 首次点击时 macOS 会弹窗，到「系统设置 → 隐私与安全性 → 辅助功能」勾选对应 App 即可。
- 若 Ghostty 无法控制，会自动把 resume 命令复制到剪贴板作为兜底（也可点「Copy command」手动复制）。

## 已知限制

- Codex 的 reasoning 内容多为加密（`encrypted_content`），只能展示有 summary 文本的部分。
- Claude 的工程目录名是把 `/` 编码成 `-`（有损），cwd 优先取 transcript 内记录的真实 `cwd`，取不到时才回退解码目录名。
- Amp thread 不一定记录 cwd；缺失时 resume 命令不带 `cd`（amp thread 是全局的，通常仍可继续）。
