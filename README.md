# dsh-plugin-session-import

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> 已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表（Sessions & Messages）· [AdamPlatin123 自动雷达](https://github.com/AdamPlatin123/awesome-dsh-plugins)（✅ 运行级验证通过）


DeepSeek Harness（dsh）插件：把 **claude-code / codex / reasonix / zcode** 的历史聊天记录导入为 dsh 会话（含工作区绑定与工具能力），导入后可直接续聊。

## 功能

- **四种工具解析**：
  - claude-code（含 Claude-3p 新端、中文路径 `.claude.json` 权威映射）
  - codex（新旧两种响应格式，`custom_tool_call` 参数自动从 JS 代码转 JSON）
  - reasonix（旧 CLI + 新桌面版，项目 slug 贪心解码真实路径）
  - zcode（`db.sqlite` 权威索引 + compaction 压缩摘要还原）
- **会话发现**：标题 / 项目名 / 消息数 / 时间齐全，30s 缓存扫描
- **搜索**：按标题 / 项目名过滤（防抖输入）
- **批量导入**：多选会话一次导入，每个会话独立 seed + 工作区绑定
- Claude 批量扫描默认跳过 `subagents` 和 `agent-*.jsonl`；无法确定有效工作区时会报告错误，避免绑定到转录目录。
- **工具完整可用**：导入会话自动加入默认 preset scope，25+ 工具（read/edit/glob/grep/pwsh 等）与正常会话一致
- **超长会话保护**：三层保障（内容裁剪 → 消息截断 → 单条兜底），任何长度 / 任何模型窗口都不超限
- **Web UI**：侧边栏「⇩ 导入会话」按钮（明暗主题自适应），导入成功自动关闭
- **命令**：`/import <tool> <path>`（文件或目录批量）

## 安装

**方式一：官方命令（推荐）**

```bash
# 装进 web profile（自动 reconcile dsh.profile.bundles）
dsh plugin --profile web add dsh-plugin-session-import
dsh web   # 重启生效
```

**方式二：商店一键安装**

装 [dsh-store](https://github.com/huguangyu666/dsh-store)，打开「插件商店」搜索安装。

**方式三：手动**

```bash
# 1. 安装插件包
npm i dsh-plugin-session-import

# 2. 在 profile 挂载（~/.dsh/profiles/web/cordis.patch.yml）：
# - insert:
#     - id: session-import
#       name: 'dsh-plugin-session-import'

# 3. 重启 dsh web
dsh web
```

## 使用

- 点击侧边栏底部的 **「⇩ 导入会话」** → 选择工具 → 搜索 / 滚动分批加载 → 勾选 → 导入
- 或命令行：`/import codex C:\Users\xxx\.codex\sessions`（目录=批量）
- <img width="426" height="1361" alt="image" src="https://github.com/user-attachments/assets/ae266fb9-4b93-4327-a232-9b98f8257d88" />
  <img width="891" height="1139" alt="image" src="https://github.com/user-attachments/assets/fc29bbd1-9e79-4cf7-b806-78852d0e5ad0" />



## 会话数据位置

| 工具 | 会话目录 |
|---|---|
| claude-code | `~/.claude/projects/` + `%LOCALAPPDATA%\Claude-3p\claude-code-sessions`（新端） |
| codex | `~/.codex/sessions/` |
| reasonix | `~/.reasonix/sessions/`（CLI）+ `%APPDATA%\reasonix\projects\*\sessions`（桌面版） |
| zcode | `~/.zcode/cli/db/db.sqlite`（权威索引） |

## 导入质量保障

| 能力 | 说明 |
|---|---|
| 工具调用链 | seed 中 assistant/message 承载 tool-call 块，tool/result 紧跟对应调用（含孤儿 result 丢弃、迟到 result 配对），满足 OpenAI/DeepSeek wire 规则 |
| zcode 压缩 | 识别 compaction 标记，摘要正文（summary.body）原样还原为上下文 |
| codex 参数 | `custom_tool_call` 的 JS 代码参数（`tools.exec_command({cmd: 'dir'})` 单引号/反引号）自动转成标准 JSON，避免模型学到错误调用格式 |
| 超长截断 | 文本 ≤16K 字符、工具结果 ≤40K 字符裁剪；消息按预算截断（保留开头锚点 + 压缩摘要 + 尾部）；单条超预算一半直接丢弃 |
| 预算自适应 | 按默认模型真实窗口（contextWindow − maxTokens − 25% 余量）动态计算，`DSH_IMPORT_CONTEXT_BUDGET` 可覆盖 |
| cwd 修复 | claude 中文路径（`.claude.json` 权威映射）、reasonix slug 贪心解码——避免 workspace=主目录导致沙箱拒绝 |

## 已知限制

- 图片附件降级为占位文本（部分工具不支持 image block）
- 被截断的历史消息不保留（超长会话的中间轮次丢失，但保留摘要与锚点）
- reasonix 桌面版部分会话标题依赖 `.titles.json`，缺失时回退文件名提取

## 开发

```bash
npm run build      # esbuild 构建 lib/index.js + lib/client.js
node test-events.mjs   # toSessionEvents 单元测试 21 项（工具配对/孤儿丢弃等）
node test-codex.mjs    # codex 解析器 7 项（exec_command 参数转 JSON）
node test-reasonix.mjs # reasonix 解析器 5 项
node test-slug.mjs     # slug 路径解码 4 项
npm pack           # 打包验证
```

## License

MIT
