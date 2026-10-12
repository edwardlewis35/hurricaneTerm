# hurricaneTerm

**WindTerm 2.6.0 逆向分析 → Tauri 2 重构（clean-room 重实现）。**

本仓库是对 WindTerm 的**功能与界面结构**进行逆向分析后，用开放技术栈重新实现的终端软件。
后端 Rust（`portable-pty`），前端 Web（xterm.js），外壳 Tauri 2。

> ⚠️ **不含任何 WindTerm 专有代码或数据文件。** WindTerm 2.6.0 为闭源商业软件，其
> `.term` / `.lexer` / `.command` 等配置文件头部明确标注 proprietary、禁止再分发；
> 本项目只借鉴其*设计*（布局、交互、数据结构思路），全部代码原创。

## 功能现状

布局与交互对齐 WindTerm 主窗口：

| 模块 | 状态 |
|---|---|
| 菜单栏（Session/Edit/Search/Selection/Goto/View/Mode/Tool/Window/Help） | ✅ |
| 工具栏 + 可拖宽 Dock 六窗格（Explorer / Filer / Outline / Sender / Transfer / Output） | ✅ |
| 状态栏（Local/Remote 模式、同步输入、尺寸、编码、EOL、缩放、主题、时钟） | ✅ |
| 多标签终端 + 左右/上下分屏 + OSC 标题跟随 | ✅ |
| 主题 4 套（default / dige-black / dige-white / dige-black-and-white） | ✅ |
| 命令面板（Ctrl+Shift+P）+ 动作注册表 | ✅ |
| 触发器引擎 v0（正则 → 高亮 / 响铃 / 发送文本） | ✅ |
| 会话管理（JSON 持久化，folder/command/args/host/port/user） | ✅ |
| 本地文件浏览器（浏览 / 导航 / 在终端 cd） | ✅ |
| 发送窗格 + 同步输入广播 | ✅ |
| 查找（Ctrl+F）、缩放（Ctrl±）、全屏（F11） | ✅ |
| SSH（russh 实连）/ Telnet（协商引擎）/ 串口（termios 直驱）/ TCP（直连·Socks5·HTTP CONNECT·ProxyCommand） | ✅ |
| 传输队列（SFTP / ZMODEM） | ⏳ P1 |
| 语法高亮方案、命令库补全、vim 键位层、i18n | ⏳ P2/P3 |

## 构建

### 依赖（Debian / Ubuntu / Kali）
```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libssl-dev build-essential curl
# 另需 Rust 工具链（rustup）与 Node.js
```

### 编译与打包
```bash
npm install
npm run build-deb        # dist 准备 + tauri build --bundles deb
```
产物：`src-tauri/target/release/bundle/deb/hurricaneTerm_0.3.0_amd64.deb`

开发运行：
```bash
npm run tauri dev
```

## 发布（GitHub Actions 自动构建）

仓库自带 `.github/workflows/release.yml`：**推送 `v*` 标签即自动构建三平台安装包并创建 Release（草稿）**。

```bash
git tag v0.3.0
git push origin v0.3.0
```

| 平台 | Runner | 产物 |
|---|---|---|
| Linux x64 | ubuntu-22.04 | `.deb` / `.rpm` / `.AppImage` |
| Windows x64 | windows-latest | `.msi` / NSIS `.exe` |
| macOS arm64 | macos-latest | `.dmg` / `.app` |
| macOS x64 | macos-13 | `.dmg` / `.app` |

前端 `dist/` 由 `tauri.conf.json` 的 `beforeBuildCommand`（`npm run prepare-dist`）自动生成，CI 无需额外步骤。也可在 Actions 页面用 `workflow_dispatch` 手动触发。

## 架构

```
src/            前端（无构建器，原生 ESM-free 脚本）
  index.html    布局骨架（菜单/工具栏/Dock/终端区/状态栏/对话框）
  style.css     主题变量 + 全量布局
  core.js       Tauri 桥 / 持久化 / 引导 / JS 错误自捕获
  term.js       终端管理：多标签、分屏、主题、搜索、触发器、缩放、广播
  ui.js         菜单 / 工具栏 / Dock 六窗格 / 状态栏 / 命令面板 / 对话框
src-tauri/      Rust 后端
  src/main.rs   PTY（spawn/write/resize/kill）+ fs_list + 会话与 UI 状态持久化
```

运行时数据目录：`~/.config/io.github.edwardlewis35.hurricaneterm/`
（`sessions.json`、`ui-settings.json`、`ui-jserror.json`）

## 路线图

- **P1**：SSH（russh）+ SFTP 浏览器 + 传输队列 + Telnet；Filer 远端化
- **P2**：语法高亮方案（开放 grammar）+ 命令库补全管线 + 触发器增强
- **P3**：vim 键位层、同步输入增强、i18n、主题包

## 许可

Apache-2.0（见 [LICENSE](LICENSE)）。项目名与代码均为独立实现，与 WindTerm 原作者无关。