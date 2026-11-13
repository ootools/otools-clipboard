# 本次剪贴板插件验证记录

日期：2026-11-13。源码已提交推送，六架构构建产物已发布 GitHub 开发预览 Release；插件市场尚未上架，等待支持原生事件协议的正式宿主。

发布验证：[build-plugin / 43360966873](https://github.com/ootools/otools-clipboard/actions/runs/43360966873)，精确源码 `25e05b4b74638a3c9afa0cda190d38c9a2b35736`。Web、macOS/Windows/Linux x64与arm64全部测试/构建/打包通过；产物下载后再次独立校验各归档、摘要、平台架构及原生导出。

预览下载：[plugin-otools-clipboard-v0.1.0](https://github.com/ootools/otools-clipboard/releases/tag/plugin-otools-clipboard-v0.1.0)。当前正式宿主v0.9.0不具备事件能力，预览请配套使用 `ootools/OTools@8db4e9a3` 或后续开发构建。

## 已实际验证

- 插件 Web：`pnpm test` 68/68，`pnpm typecheck` 通过，Vite 构建通过。
- 插件原生：`cargo test --locked --manifest-path native/Cargo.toml` 50/50；FFI、SQLite、图片、暂停、队列、损坏保护、停止屏障均有回归；本机 clippy `-D warnings` 在评审前版本通过，最终两项原生修复另经50/50与release构建验证。
- 构建/包脚本：12/12；真实 macOS arm64 dylib 的 invoke/free/on_event 三导出检查；实际 `.oplg` 的 ZIP、清单、平台库及 SHA256 校验通过。
- 宿主事件核心：21/21；共享 FFI helper：14/14，另一个文档示例测试明确 ignored。
- 宿主原生插件/身份范围回归：8 passed（两个本文手动集成测试在此普通范围内ignored，已另行显式运行通过；原有外部 codeg smoke未执行）；宿主插件列表范围20/20；开发绑定/打包相关测试9/9。`park::core::tests` 筛选没有匹配测试，不把其0-test退出0算作安装/卸载验证。
- 宿主 `cargo check -p OTools`、`vue-tsc --noEmit` 通过；未改相关的既有 Rust warnings 仍存在。
- 真实宿主 core + 最终 macOS 插件库（隔离 `OTOOLS_HOME`）：文本+PNG事件→2条SQLite历史、重复计数、暂停忽略、停止/重启持久化、shutdown通过。
- **真实系统剪贴板闭环**：macOS arboard 写入人工文本/图片，经共享 ClipboardWatcher、on_event 与实际 dylib 写历史，面板从未创建；基线不导入、图片读取与停止通过。测试只将原剪贴板全部格式备份在内存，结束后恢复；若期间有用户新复制则不覆盖。
- 浏览器人工样例 GUI：布局与可读性、关键词搜索、图片分类与预览、置顶、默认保留设置对话框、取消、复制缺少宿主的准确提示已验证。Browser role/DOM点击通道超时，真实可见位置 CUA 点击可用，未声称所有 GUI 动作都覆盖。

宿主测试代码：

- `otools/src-tauri/src/platform/native_plugins/integration_tests.rs`
- `otools/src-tauri/src/platform/native_plugins/system_clipboard_tests.rs`

手动集成复跑（只在测试环境执行；系统测试会短暂写入人工剪贴板）：

```bash
OTOOLS_CLIPBOARD_NATIVE_LIB=/absolute/path/to/lib/macOS.dylib \
  cargo test -p OTools --lib real_clipboard_plugin_receives_background_events \
  -- --ignored --test-threads=1

OTOOLS_CLIPBOARD_NATIVE_LIB=/absolute/path/to/lib/macOS.dylib \
  cargo test -p OTools --lib system_watcher_captures_real_text \
  -- --ignored --test-threads=1
```

## 未覆盖 / 发布边界

- Windows、Linux、macOS Intel 已在CI运行原生测试与构建，并产出经独立核验的发行包；真实图形桌面剪贴板事件验收仍仅macOS arm64完成。
- Linux v1 当前 arboard/X11 配置支持 X11/XWayland；纯 Wayland 明确不支持。
- 未安装、重启或停止用户正在运行的 `/Applications/OTools.app`，因此完整桌面宿主 startup UI→安装/禁用/卸载→事件服务的 GUI端到端未覆盖。现有运行应用不是改后构建，不能直接使用新事件协议。
- 周期维护的真实计时和断电/强制进程崩溃恢复未做长期实验；事务、损坏保护与手动 flush 回归已验证。
- 默认历史保存在本地，未加密、不识别密码，不保证轮询间隔内所有中间复制均被捕获。
- 回调/命令超时不意味着运行中的原生代码或SQLite事务被强制取消；调用者需要重新查询实际状态。
- 新宿主事件能力尚未发布，不猜测 `minOtoolsVersion`；必须配套使用改后的宿主源码构建。

## 本地产物

`dist-pack/macos/otools-clipboard-0.1.0-macos.oplg`，包内为 macOS arm64 `lib/macOS.dylib`。包旁 `SHA256SUMS` 是当前产物摘要的唯一准确来源；重建后不要沿用旧 hash。

独立只读评审确认7项P2缺陷，全部经失败回归→修复→全套通过：暂停期间宿主排队事件不补录、快速禁用/重新启用恢复订阅、开发重绑定使用packid、原生sequence重复复制更新历史、普通notFound不污染采集健康、完整图片请求有界合并、32MP统一为32,000,000。修复后重新构建面板/原生库、实际macOS包并校验；真实dylib与系统剪贴板两项闭环均重新运行通过。

暂停恢复边界采用事件observed timestamp，恢复所在毫秒及更早事件保守跳过；时钟突变也可能保守跳过。完整PNG选择最多1个运行中与1个最新等待项，缩略图仍最多3并发。
