# hurricaneTerm

**跨平台终端客户端：SSH / Telnet / 串口 / TCP + SFTP，Tauri 2 + Rust + xterm.js。**

- 后端：Rust（`russh` 实连、`portable-pty`、`tokio`）
- 前端：原生 Web（xterm.js，无打包器），全量本地资源、离线可用
- 外壳：Tauri 2，Linux / Windows / macOS 三平台单二进制安装包

## 功能现状

界面形态 0.7.0 起为无边框窗口 + 标签内嵌标题栏 + 图标活动栏 + 全页设置，
配色令牌取自 [Tabby](https://github.com/eugeny/tabby) 上游 `theme.vars.scss` / `colorSchemes.ts`。

| 模块 | 状态 |
|---|---|
| 无边框标题栏：标签内嵌、拖拽区、自绘窗口控制（macOS 自绘红绿灯） | ✅ |
| 左侧图标活动栏（会话 / 文件 / 发送 / 传输 / 大纲 / 日志 + 主题 / 设置） | ✅ |
| 全页设置页（外观 / 终端 / 机器与连接 / 触发器 / 快捷键 / 关于），取代弹窗 | ✅ |
| 窗口级标签栏：拖拽排序 / 右键菜单 / 颜色 / 固定 / 活动通知 / 行内重命名 | ✅ |
| 主页快速连接 + 分组机器列表 | ✅ |
| 可拖宽侧栏六窗格（Explorer / Filer / Outline / Sender / Transfer / Output） | ✅ |
| 极简状态栏（模式、同步输入、尺寸、编码、EOL、缩放、主题、时钟），可在设置页关闭 | ✅ |
| 多标签终端 + 左右/上下分屏（可拖分隔条）+ OSC 标题跟随 | ✅ |
| 主题 6 套（tabby-dark / tabby-light + 4 套内置深浅色方案） | ✅ |
| 命令面板（Ctrl+Shift+P，分组 + 图标）+ 浮动搜索卡 | ✅ |
| 触发器引擎（后端 `re/triggers.rs`；前端映射高亮 / 响铃 / 发送文本） | ✅ |
| 会话管理（JSON 持久化，folder/command/args/host/port/user/proxy/jumpHost） | ✅ |
| SFTP 双栏文件浏览器 + 传输进度 | ✅ |
| 发送窗格 + 同步输入广播 | ✅ |
| 查找（Ctrl+F）、缩放（Ctrl±）、全屏（F11） | ✅ |
| SSH（russh 实连，支持跳板机 direct-tcpip）/ Telnet（协商引擎）/ 串口（termios 直驱）/ TCP（直连·Socks5·HTTP CONNECT·ProxyCommand） | ✅ |
| 本地会话落盘日志、选中自动复制 + 右键/中键粘贴、输出内置高亮 | ✅ |
| X/Y/Zmodem、端口转发隧道、传输队列（引擎已完成，待接线到命令层） | ⏳ |
| 语法高亮方案、命令库补全、vim 键位层、i18n | ⏳ |

## 构建

### 依赖（Debian / Ubuntu / Kali）
```bash
sudo apt install -y pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libssl-dev libxdo-dev build-essential curl
# 另需 Rust 工具链（rustup）与 Node.js
```

### 编译与打包
```bash
npm install
npm run build-deb        # dist 准备 + tauri build --bundles deb
```
产物：`src-tauri/target/release/bundle/deb/hurricaneTerm_<版本>_amd64.deb`

开发运行：
```bash
npm run tauri dev
```

前端测试（jsdom 集成用例，无需浏览器）：
```bash
npm run test:ui
```

## 发布（GitHub Actions 自动构建）

仓库自带 `.github/workflows/release.yml`：**推送 `v*` 标签即自动构建三平台安装包并创建 Release（草稿）**。

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

| 平台 | Runner | 产物 |
|---|---|---|
| Linux x64 | ubuntu-22.04 | `.deb` / `.rpm` / `.AppImage` |
| Windows x64 | windows-latest | `.msi` / NSIS `.exe` |
| macOS arm64 | macos-latest | `.dmg` / `.app` |

> **已知问题（macOS）**：CI 未配置 Apple 开发者证书与公证，产物为**未签名**包，从网络下载会被
> Gatekeeper 拦截（`xattr -cr /Applications/hurricaneTerm.app` 可临时绕过）；且仅构建 arm64，
> Intel Mac 无法运行。v0.6.0 的 macOS job 曾挂在 `bundle_dmg.sh`（AppleScript 在无 GUI 的
> runner 上失败），导致该版本无 macOS 产物；详见 `tauri.conf.json` 的 `bundle.macOS` 说明。

前端 `dist/` 由 `tauri.conf.json` 的 `beforeBuildCommand`（`npm run prepare-dist`）自动生成，CI 无需额外步骤。也可在 Actions 页面用 `workflow_dispatch` 手动触发。

### macOS 签名与公证

不配置时产物为**未签名**包，从浏览器/网盘下载会带 `com.apple.quarantine`，Gatekeeper 直接拦截
（"已损坏，无法打开"）。临时绕过：`xattr -cr /Applications/hurricaneTerm.app`。
要根治需要 Apple Developer 账号（$99/年；免费个人账号**不能**公证）：

1. **建证书**：developer.apple.com → Certificates → 创建 **Developer ID Application**
   （注意不是 "Apple Development"，后者过不了 Gatekeeper 分发校验）。
   或 Xcode → Settings → Accounts → Manage Certificates → `+`。
2. **导出 .p12**：钥匙串访问 → 选中该证书 → 右键 → 导出 → `.p12`，设置导出密码。
3. **转 base64**：`base64 -w0 cert.p12`（macOS 用 `base64 -i cert.p12 | pbcopy`）。
4. **配 6 个 secrets**（仓库 Settings → Secrets and variables → Actions；或命令行）：

   | Secret | 值 |
   |---|---|
   | `APPLE_CERTIFICATE` | 第 3 步的 base64 串 |
   | `APPLE_CERTIFICATE_PASSWORD` | .p12 导出密码 |
   | `APPLE_SIGNING_IDENTITY` | 证书全名，如 `Developer ID Application: Your Name (TEAMID)`（`security find-identity -v` 可查） |
   | `APPLE_ID` | Apple 账号邮箱 |
   | `APPLE_PASSWORD` | **App 专用密码**（appleid.apple.com → 登录和安全 → App 专用密码），不是账号密码 |
   | `APPLE_TEAM_ID` | 团队 ID（developer.apple.com → Membership） |

   ```bash
   gh secret set APPLE_CERTIFICATE          --repo edwardlewis35/hurricaneTerm < cert.b64
   gh secret set APPLE_CERTIFICATE_PASSWORD --repo edwardlewis35/hurricaneTerm
   gh secret set APPLE_SIGNING_IDENTITY     --repo edwardlewis35/hurricaneTerm
   gh secret set APPLE_ID                   --repo edwardlewis35/hurricaneTerm
   gh secret set APPLE_PASSWORD             --repo edwardlewis35/hurricaneTerm
   gh secret set APPLE_TEAM_ID              --repo edwardlewis35/hurricaneTerm
   ```

5. 之后推 `v*` tag，`tauri-action` 会自动 **签名 → 公证 → staple**；secrets 缺失时自动跳过（保持现状）。
6. **验证**：`spctl -a -vvv -t install hurricaneTerm.app` 应输出 `accepted`；
   `codesign -dv --verbose=2 hurricaneTerm.app` 的 Authority 链应含 `Developer ID Application` → `Developer ID Certification Authority` → `Apple Root CA`。

`release.yml` 已把这 6 个变量透传给 `tauri-action`，配好 secrets 即生效，无需再改 workflow。

## 架构

```
src/            前端（无构建器，原生脚本；prepare-dist 全量拷贝到 dist/）
  index.html    布局骨架（无边框标题栏/活动栏/侧栏/终端区/状态栏/命令面板）
  style.css     设计令牌 + 全量布局
  core.js       Tauri 桥 / 持久化 / 引导 / JS 错误自捕获
  icons.js      内联 SVG 图标集（离线，无图标字体）
  titlebar.js   无边框窗口控制（min/max/close、macOS 红绿灯、拖拽区）
  tabbar.js     窗口级标签栏（拖拽/右键菜单/颜色/固定/活动通知/重命名）
  actbar.js     左侧图标活动栏（点按开合侧栏窗格）
  settings.js   全页设置（六分区，取代 <dialog>）
  profiles.js   机器管理（左列表右表单）
  home.js       主页快速连接 + 分组机器列表
  term.js       终端管理：多标签、分屏、主题、搜索、触发器、缩放、广播
  ui.js         侧栏六窗格 / 状态栏 / 命令面板 / 浮动搜索 / Toast
src-tauri/      Rust 后端
  src/main.rs   Tauri command 层：PTY（spawn/write/resize/kill）+ SSH/Telnet/串口/TCP + SFTP + 触发器接线
  src/ssh_live.rs   russh 实连会话（认证、pty、数据泵、SFTP 子系统）
  src/ssh_relay.rs  中继/代理拨号层（直连·Socks5·HTTP CONNECT·ProxyCommand·跳板）
  src/jump.rs       跳板机（direct-tcpip 二级会话 → std Read/Write 适配）
  src/serial_live.rs / src/tcp_live.rs   串口、裸 TCP 实连
  src/re/       协议与会话引擎：SSH 认证编排与连接流、Telnet 协商、expect 自动登录、
                串口/TCP/隧道与端口转发、Shell 会话、X/Y/Zmodem、传输队列、大纲 Filer、
                触发器、语法高亮 scheme
```

运行时数据目录：`~/.config/io.github.edwardlewis35.hurricaneterm/`
（`sessions.json`、`ui-settings.json`、`ui-jserror.json`）

## 路线图

- **P1**：SSH（russh）+ SFTP 浏览器 + 传输队列 + Telnet；Filer 远端化
- **P2**：语法高亮方案（开放 grammar）+ 命令库补全管线 + 触发器增强
- **P3**：vim 键位层、同步输入增强、i18n、主题包

## 许可

Apache-2.0（见 [LICENSE](LICENSE)）。hurricaneTerm 是独立项目，代码与本仓库内全部实现均为原创。
