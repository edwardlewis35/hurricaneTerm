# GitHub Gist 机器配置同步

设置 → Gist 同步提供 Gist ID / 仓库地址、GitHub Token、配置加密密钥、同步文件名和 GitHub HTTP 代理。默认文件名 `tabby-sync-settings` 与参考插件相同。代理默认 `http://192.168.8.246:7890`，可修改或留空直连；只作用于此功能的 GitHub API 请求，不修改系统代理。

Token 须具有 Gist 读写权限。Token 和配置加密密钥只存于当前应用进程内存，关闭应用后需重新输入；保存连接信息仅保存 ID、文件名和代理。此版本没有自动后台同步。

1. 填写现有 Gist ID 或完整 `https://gist.github.com/<owner>/<id>` 地址和 Token。用「测试连接」检查权限；测试不会创建或修改 Gist。
2. 「读取云端 / 预览」列出本机、云端、相同与内容不同的机器，选择本机优先或云端优先合并。本机已有密码与最近使用记录保留。
3. 「以云端替换本机」需要勾选允许删除本机独有机器。合并或替换前，先备份本机机器到应用配置目录 `ui-gist-machines-backup.json`，成功保存后才更新当前界面。需要手工恢复时关闭应用，将该文件内容恢复为同目录 `sessions.json`。
4. 「上传本机 / 预览」读取远端版本并显示差异，确认后合并上传，本机同名同分组同协议机器优先；云端独有机器、其他文件和非机器设置保留。新建使用「新建私密 Gist」，查看预览后再次确认才会创建；不会在测试连接时创建。
5. 新建和上传需要至少 12 字符的配置加密密钥。上传现有 V2 文件需原密钥，密钥不正确时阻止覆盖。记住原密钥，其他设备读取该文件时需要同一密钥。

## 格式互通

参考版本为 [niceit/tabby-cloud-sync-settings `607e45a`](https://github.com/niceit/tabby-cloud-sync-settings/tree/607e45adfed4d6969f2a485315aae213debce39f)：[Gist 适配器](https://github.com/niceit/tabby-cloud-sync-settings/blob/607e45adfed4d6969f2a485315aae213debce39f/src/utils/cloud-components/Gist.ts)、[GitHub 文件名](https://github.com/niceit/tabby-cloud-sync-settings/blob/607e45adfed4d6969f2a485315aae213debce39f/src/utils/cloud-components/gists/github.ts)、[加密格式](https://github.com/niceit/tabby-cloud-sync-settings/blob/607e45adfed4d6969f2a485315aae213debce39f/src/utils/settings-crypto.ts)。实现为独立代码，通过共享文件格式与 Tabby 互通。

- 读取：参考插件固定注释头 + V1 CryptoJS/OpenSSL AES 密文、V2 scrypt + AES-256-GCM envelope，以及未加密 Tabby JSON/YAML。
- 写入：同样的注释头与 V2 JSON envelope；参数与参考插件一致（scrypt N=16384/r=8/p=1，32-byte key、16-byte salt、12-byte IV、16-byte authentication tag）。随机 salt 与 IV 令相同配置的密文不同。明文是合法 YAML 的 JSON 对象，标准 `profiles` 供 Tabby 使用。
- SSH 标准字段包括 host、port、user、auth、私钥路径、HTTP/SOCKS 代理、ProxyCommand 和跳板机。Tabby 的跳板机 Profile ID 会转换为本机地址；导出时匹配回已保存 Profile ID。缺失、循环和多级跳板引用会逐机提示并跳过导入。无法匹配的本机跳板地址保留在 `hurricaneTerm` 扩展字段中，Tabby 需手工补选。
- 串口映射标准 `port/baudrate/databits/stopbits/parity/rtscts/xon/xoff`。本机后端不支持 1.5 停止位，导入时明确提示并跳过。扩展字段保留额外本机参数。TCP、Telnet 和本地连接亦可同步；未知插件协议、模板和内置配置不导入，本次上传保留其原云端记录。
- 新生成的本机机器记录不会上传密码、Token、代理密码、私钥内容和历史使用时间。私钥只同步路径。匹配更新的云端机器记录也会清除这些敏感字段；未更新的云端记录和非机器配置原样保留，其原有内容不属于本机新上传数据。
- 不导入或同步本机 UI、主题、触发器、终端日志、SFTP 内容或文件数据。已有云端完整配置的非机器字段保留，避免破坏 Tabby 配置。
- 加密后文件限制 900 KiB，留在 GitHub inline Gist 内容阈值以下。过大或 GitHub 返回 truncated 均明确报错，不使用不完整内容或 raw_url 重定向。

## 并发与验证边界

上传前重新获取远端 history revision，与预览版本不同则拒绝覆盖并要求重新预览。GitHub Gist 更新接口没有本功能可依赖的原子比较写入机制，最后一次版本检查和 PATCH 之间仍存在很短的跨设备竞争窗口；避免多台设备同时确认上传。

当前测试使用虚构机器与令牌，没有上传真实用户配置或修改真实 Gist。前端覆盖输入、格式转换、差异/合并、确认步骤、备份顺序、敏感字段、并发点击与异步导航。Rust 测试覆盖本地 HTTP 模拟的 read/test/create/write、冲突、错误密钥、截断和错误响应。`gist_compat_fixture.json` 由未经修改的参考项目加密模块实际生成 V1/V2；Rust 均能解密，Rust 生成的 V2 亦能由该参考模块解密。
