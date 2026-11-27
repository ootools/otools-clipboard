# 剪贴板历史 / Clipboard History

OTools 的本地文本与图片历史面板。插件通过宿主原生事件订阅后台保存历史；**不自行读取或写入系统剪贴板**，也不上传历史内容。复制回剪贴板由前端调用现有宿主 `copyText` / `copyImage` 能力。

## 正式发行版

[剪贴板历史 v0.2.0 下载](https://github.com/ootools/otools-clipboard/releases/tag/plugin-otools-clipboard-v0.2.0)，已上架插件市场，附六个平台/架构的 `.oplg` 包与 `SHA256SUMS`。最低宿主版本为 **OTools 0.9.1**；宿主正式版本由用户稍后发布，0.9.0及更早版本应拒绝安装。本次不发布宿主。

v0.2.0 变化：**界面按功能重排**——命令栏只保留搜索唯一焦点，历史改为按「今天 / 昨天 / 更早」分组的 48px 单行列表（取消等重卡片墙、彩色胶囊与常驻横幅），右侧为从属检视区（内容预览 + 圆点元信息 + 唯一「复制」主按钮），底部状态压成一行；筛选、置顶、日期收进浮层，保留策略/语言/主题/清空收进设置抽屉与二次确认。仅前端视觉与交互壳改动，原生 `clipboard_list` / `clipboard_clear` 契约不变。同步修复两处发布链路遗留：CI 删除已失效的 vendor SDK 编译步骤（SDK 已走 npm），市场接口测试更新到 0.3.0 的 `invoke` 契约。

[v0.1.3](https://github.com/ootools/otools-clipboard/releases/tag/plugin-otools-clipboard-v0.1.3)（日期筛选 · 区间清空）、[v0.1.2](https://github.com/ootools/otools-clipboard/releases/tag/plugin-otools-clipboard-v0.1.2)（布局优化）、[v0.1.1](https://github.com/ootools/otools-clipboard/releases/tag/plugin-otools-clipboard-v0.1.1)（首个市场版本）与 [v0.1.0](https://github.com/ootools/otools-clipboard/releases/tag/plugin-otools-clipboard-v0.1.0)（开发预览）保持不变。

## 使用与数据

- 支持文本搜索、文本/图片筛选、置顶、详情、复制、删除、清空、暂停和保留策略。
- 默认保留 500 条未置顶历史、30 天、256 MiB 内容预算。置顶免于条数/时间清理，但计入容量；空间不足只清理未置顶内容，无法容纳新增内容时报告 `storageFull`。
- 同类型、同内容合并，保留首次时间和置顶状态，更新最后复制时间与次数。
- 数据在宿主提供的 `<pluginDataDir>/clipboard/` 下：`history.sqlite3`（SQLite/WAL）和 `images/<hash>.png`。不会写插件安装目录。
- 启动只由宿主建立基线，不导入启动前的剪贴板；暂停期间不采集，恢复不补录。
- 需要实现 `host.events.started` / `clipboard.changed` 的 OTools **0.9.1或更新宿主**。包内与市场均声明 `minOtoolsVersion: "0.9.1"`，当前0.9.0应拒绝安装。
- Linux 宿主 v1 支持 X11/XWayland；纯 Wayland 或无图形后端可能报告不支持/不可用。本地内容没有加密或密码识别保证，请按需要暂停或清空。

## 本地开发

Node 22、pnpm 10.33.3、稳定 Rust 与 C 编译器（bundled SQLite）。默认开发面板 `http://127.0.0.1:6549`；原生 `autoReload` 关闭，重建原生库后由宿主停止/重启插件实例。

```bash
pnpm install --frozen-lockfile
pnpm --dir web run dev
cargo test --locked --manifest-path native/Cargo.toml
node scripts/build-native.mjs
pnpm build:web
node --test scripts/build.test.mjs scripts/packaging.test.mjs
```

独立 `native/Cargo.toml` 不加入宿主 workspace。Rust `panic=unwind`，FFI 三导出沿用宿主缓冲区所有权约定，并使用当前 `ot-plugin-ffi` guard。vendored FFI 来源与授权缺口见 `vendor/host-crates/ot-plugin-ffi/PROVENANCE.txt`。

## 平台构建与打包

```bash
# 本机平台，显式架构 x64 / arm64；跨架构需自行准备目标工具链
node scripts/build-native.mjs --arch arm64
pnpm build:web
node scripts/pack-plugin.mjs --platform macos --arch arm64
node scripts/verify-plugin.mjs dist-pack/macos
```

| 平台 / 架构 | 构建源文件 | 包内宿主文件 | 包后缀 |
| --- | --- | --- | --- |
| macOS arm64 | `lib/macOS-arm64.dylib` | `lib/macOS.dylib` | `macos` |
| macOS x64 | `lib/macOS-x86_64.dylib` | `lib/macOS.dylib` | `macos-intel` |
| Windows x64 | `lib/Windows-x64.dll` | `lib/Windows.dll` | `windows` |
| Windows arm64 | `lib/Windows-arm64.dll` | `lib/Windows.dll` | `windows-arm` |
| Linux x64 | `lib/Linux-x64.so` | `lib/Linux.so` | `linux` |
| Linux arm64 | `lib/Linux-arm64.so` | `lib/Linux.so` | `linux-arm` |

本机架构同时生成宿主默认文件名别名；跨架构不覆盖本机别名。正式 `.oplg` 扁平包含 `plugin.json`、`logo.svg`、`dist/**` 和唯一对应平台库，移除 `devUrl` / `quickDev`，`native.autoReload=false`。缺少真实库或必须导出时打包失败，不创建残包。仅打显式平台包，不用缺库的合包伪装跨平台交付。

校验只在内存读取 ZIP、路径、大小、CRC 和摘要，不从不可信包解压或执行代码。`.github/workflows/build-plugin.yml` 只有测试、构建、打包和 Actions artifacts；**没有 Release、推送或市场发布**。编译库和包均被 Git 忽略。CI 定义不代表平台已经实际运行验证；本地验证平台见 `docs/native-progress.md`。

接口、限制和安全错误见 `docs/native-contract.md`。
