# hurricaneTerm

**跨平台终端客户端：SSH / Telnet / 串口 / TCP + SFTP，Tauri 2 + Rust + xterm.js。**

- 后端：Rust（`russh` 实连、`portable-pty`、`tokio`）
- 前端：原生 Web（xterm.js，无打包器），全量本地资源、离线可用
- 外壳：Tauri 2，Linux / Windows / macOS 三平台单二进制安装包

## 功能现状

界面为 Tabby 风格的无边框窗口、顶部扁平标签栏、居中启动页与全页设置，
配色令牌取自 [Tabby](https://github.com/eugeny/tabby) 上游 `theme.vars.scss` / `colorSchemes.ts`。

标签末尾的 `+` 新建本地终端，旁边可选择连接或分屏；设置入口位于右上角。
侧栏按需展开，六个工具窗格集中在侧栏顶部。状态栏默认关闭，可在外观设置中开启。
机器管理使用全页的连接列表与编辑表单。六套主题统一驱动输入框、下拉菜单、浮层与滚动条。

| 模块 | 状态 |
|---|---|
| 无边框标题栏：标签内嵌、拖拽区、自绘窗口控制（macOS 自绘红绿灯） | ✅ |
| 按需展开的侧栏工具（会话 / 文件 / 发送 / 传输 / 大纲 / 日志 + 主题） | ✅ |
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
| SFTP 独立双栏文件管理、文件编辑与可控传输队列 | ✅ |
| 发送窗格 + 同步输入广播 | ✅ |
| 查找（Ctrl+F）、缩放（Ctrl±）、全屏（F11） | ✅ |
| SSH（russh 实连，支持跳板机 direct-tcpip）/ Telnet（协商引擎）/ 串口（termios 直驱）/ TCP（直连·Socks5·HTTP CONNECT·ProxyCommand） | ✅ |
| 本地会话落盘日志、选中自动复制 + 右键/中键粘贴、输出内置高亮 | ✅ |
| X/Y/Zmodem、端口转发隧道、传输队列（引擎已完成，待接线到命令层） | ⏳ |
| 语法高亮方案、命令库补全、vim 键位层、i18n | ⏳ |

## SFTP 文件管理

点击标题栏文件夹按钮或按 `Ctrl+2` 打开文件管理。界面参考 [Tabby-SFTP-Plus](https://github.com/10D24D/Tabby-SFTP-Plus)，由本项目独立实现，使用现有 SSH 会话的 SFTP 子系统。

- 本地 / 远程双栏，支持左右、上下、自适应和远程单栏布局；窗口可拖动、缩放、最大化，分栏比例可调。
- 每栏独立的路径、前进 / 后退、上级 / 主目录、刷新、筛选、隐藏文件和列排序；支持多选、范围选择及键盘操作。
- 全局与连接专属书签、按连接记忆路径、跟随终端 OSC 7 工作目录。服务器或 shell 未发送 OSC 7 时可手动导航。
- 右键新建文件 / 文件夹、重命名、复制 / 剪切 / 粘贴、删除；文本查看编辑、图片预览、远程权限修改。编辑保存检查文件版本，检测到外部修改时需明确选择强制覆盖。
- 跨栏拖放与系统文件拖入、递归上传 / 下载，独立任务 ID、并发限制、真实字节进度、速度、暂停 / 继续 / 取消 / 失败重试；同名目标提供覆盖、跳过和保留两份。
- 传输记录筛选及 JSON 导出；表格、菜单、弹窗、下拉框全部跟随主主题。

传输通过临时文件完成后再替换目标。取消或失败的 `.part` 文件会保留，便于检查；重试会重新传输，不承诺跨进程断点续传。目录递归拒绝符号链接和特殊文件，避免穿越链接或循环。文本编辑上限 2 MiB、图片预览上限 15 MiB；二进制文件不能通过文本编辑器覆盖。

本版覆盖常用工作流，尚未实现参考插件的 tar 加速、列宽持久化、自定义图标包或全部语言支持。

## 外观与会话生命周期

默认界面采用 Tabby 上游默认蓝色控件配色和 `Tabby Default` 终端调色板。设置 → 外观提供背景不透明度 20–100% 滑杆，默认 100%；文字和图标保持不透明，桌面版使用透明窗口，浏览器演示使用明确的棋盘预览。动态下拉框统一为支持键盘与主题切换的现代控件。

终端输出按实际 xterm 字符单元短暂高亮关键词，正确处理 ANSI、中文及换行，不绘制整行色带。输出合并后按最多 64 KiB 顺序交给解析器；单个大型事件也会拆分，关闭标签后丢弃该标签的迟到事件。

本地 PTY 的等待和终止由独占子进程的控制线程处理，避免 `wait` 持锁导致 `kill` 永久等待。关闭界面立即移除标签，后端不在 UI 线程或全局会话锁内执行阻塞 I/O。SSH 连接、认证、PTY 请求及 SFTP 子任务支持关闭取消；ProxyCommand 关闭后回收专用子进程，UTF-8 解码保留跨读取边界的半字符。

传输进度按 100 ms 合并更新，终态立即发送准确字节数；本地传输文件使用异步 I/O，目录扫描在 blocking worker 内运行。SOCKS5/HTTP 的 TCP 隧道直接接入 Tokio，避免逐块桥接开销。高延迟和大量小文件的吞吐仍需按网络、服务器及磁盘条件实测；剩余优化包括 metadata subsystem 复用、有限目录内并发、目录属性复用及更多通道背压。

前端验证：`npm run test:sftp` 和 `npm run test:ui`。后端安全测试：`cargo test sftp_safety_tests`、`cargo test files::tests`（需要构建依赖）。
控件与终端回归：`npm run test:controls`、`npm run test:terminal`。发布 CI 额外在 macOS 运行真实 PTY 的空闲 / 连续输出 / 忽略 HUP 关闭测试，以及跨字节读取的 UTF-8 测试。

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
  sftp.js / sftp.css   双栏文件管理、书签、编辑器、传输队列及主题样式
src-tauri/      Rust 后端
  src/main.rs   Tauri command 层：PTY（spawn/write/resize/kill）+ SSH/Telnet/串口/TCP + SFTP + 触发器接线
  src/ssh_live.rs   russh 实连会话（认证、pty、数据泵、SFTP 子系统）
  src/files.rs     本地文件服务、预览、安全保存与不覆盖目标的移动
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

- **P1**：SFTP 大目录优化、可持久化续传与列宽配置
- **P2**：语法高亮方案（开放 grammar）+ 命令库补全管线 + 触发器增强
- **P3**：vim 键位层、同步输入增强、i18n、主题包

## 许可

Apache-2.0（见 [LICENSE](LICENSE)）。hurricaneTerm 是独立项目，代码与本仓库内全部实现均为原创。
