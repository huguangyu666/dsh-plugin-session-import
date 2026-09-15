# Changelog

## [0.1.2] - 2026-09-15

### Fixed
- 适配 dsh 0.1.2-rc.1 / 0.1.5-rc.1 兼容性与会话流校验（修复 #1, #3）：
  - `assistant/message` 事件补充 `stream: []` 字段，满足 `assertAssistantSettlementShape` 强校验（修复 #3）
  - client 侧栏按钮改为 `ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(...))` 等待父 slot 声明后再注册，避免 `slot is not declared` 导致客户端插件树中断白屏（修复 #3）
  - 修复导入会话丢失标题：seed 首位生成合法的 `session/title` 事件（`source: { kind: "user" }, messageSeqs: []`），并在 zcode 解析器与各工具源中准确提取原会话标题（修复 #3）
  - 修复工具调用事件流中 step 未闭合导致 token meter 报 `step/start arrived before turn/step ended` 崩溃问题，严格配对 `step/start` / `step/end` 并闭合悬挂 call（修复 #1）
  - host 端 `webServer.register` 用 `ctx.effect(() => ...)` 托管生命周期，避免注册脱离插件 fiber
- 新增单元测试（测试总数提升至 45 项）

## [0.1.1] - 2026-08-15

### Fixed
- codex 解析器：`exec_command` 单引号参数（`{cmd: 'dir'}`）转 JSON 失败会降级——现在正确转换
- `decodeSlugPath`：不存在的路径不再拼出垃圾路径，正确返回 `undefined`

### Added
- 测试 37 项（事件转换 21 / codex 7 / reasonix 5 / slug 4）
