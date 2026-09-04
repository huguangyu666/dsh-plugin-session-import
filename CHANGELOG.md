# Changelog

## [Unreleased]

### Fixed
- 适配 dsh 0.1.2-rc.1 API 变更（9/3 发布，破坏性）：
  - client 侧栏按钮改为 `ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(...))` 等待父 slot 声明后再注册（直接 register 会抛 `slot is not declared`）
  - host 端 `webServer.register` 用 `ctx.effect(() => ...)` 包生命周期，避免注册脱离插件 fiber
- 详情见 `dsh-plugins/DEVELOPMENT.md` §9

## [0.1.1] - 2026-08-15

### Fixed
- codex 解析器：`exec_command` 单引号参数（`{cmd: 'dir'}`）转 JSON 失败会降级——现在正确转换
- `decodeSlugPath`：不存在的路径不再拼出垃圾路径，正确返回 `undefined`

### Added
- 测试 37 项（事件转换 21 / codex 7 / reasonix 5 / slug 4）
