// hurricaneTerm — re/ : 逆向重写模块
// 来源：WindTerm 2.6.0 Mach-O（sha256 d26c6406…35edd1）经 REA/Ghidra 反编译的
// 声明级语义重写。证据文件：windterm-analysis/re-work/decompiled/。
// ⚠ 衍生作品：默认仅本地使用，发布决定归用户。
pub mod telnet;
pub mod ssh_auth;
pub mod ssh_connect;
pub mod filer;
pub mod tunnel;
pub mod expect;
pub mod auto_login;
pub mod serial;
pub mod shell;
pub mod tcp;
pub mod transfer;
pub mod zmodem;
pub mod scheme;
pub mod xmodem;