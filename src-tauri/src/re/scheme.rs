//! P2-1 scheme 引擎 —— bash 命令行语法分词（TextMate 式 scope 分层）。
//! 设计借鉴 WindTerm .lexer 的**格式思想**（scopeName/patterns），模式全部自研；
//! 未读取任何 WindTerm 专有数据文件。用途：输入行高亮、补全上下文判定、Outline 分组。
//!
//! 已知简化（v1）：
//! - 词法按字节扫描，UTF-8 安全（切分点只落在 ASCII 边界）；
//! - 不处理 heredoc 正文、反引号命令体、`|&`（视作两个算符）、`$'...'` ANSI-C 引号；
//! - 提示符为启发式识别：`$ ` 可裸现，`#`/`%`/`>` 前必须至少有一个非提示符字符
//!   （避免把 `# 注释` 误判成 root 提示符）。

use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TokenKind {
    Prompt,
    Command,
    SubCommand,
    Option,
    LongOption,
    StringLit,
    Variable,
    Operator,
    Redirect,
    Comment,
    Number,
    Text,
}

impl TokenKind {
    /// TextMate 风格 scope（自拟命名，供前端高亮层直接使用）
    pub fn scope(self) -> &'static str {
        match self {
            TokenKind::Prompt => "sign.directive.prompt.shell",
            TokenKind::Command => "entity.name.command.shell",
            TokenKind::SubCommand => "entity.name.subcommand.shell",
            TokenKind::Option => "keyword.other.option.shell",
            TokenKind::LongOption => "keyword.other.longoption.shell",
            TokenKind::StringLit => "string.quoted.shell",
            TokenKind::Variable => "variable.other.shell",
            TokenKind::Operator => "keyword.operator.shell",
            TokenKind::Redirect => "keyword.operator.redirection.shell",
            TokenKind::Comment => "comment.line.number-sign.shell",
            TokenKind::Number => "constant.numeric.shell",
            TokenKind::Text => "meta.text.shell",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub start: usize, // 字节偏移
    pub end: usize,
}

/// 常见二级子命令工具 -> 子命令表（公开常识，手写）。
/// main.rs 补全层依赖此函数，故为 pub。
pub fn subcommand_tools() -> &'static HashMap<&'static str, Vec<&'static str>> {
    static M: OnceLock<HashMap<&'static str, Vec<&'static str>>> = OnceLock::new();
    M.get_or_init(|| {
        let mut m: HashMap<&'static str, Vec<&'static str>> = HashMap::new();
        m.insert("git", vec!["status","add","commit","push","pull","fetch","clone","branch","checkout","switch","merge","rebase","reset","restore","stash","tag","remote","log","diff","config","init","blame","cherry-pick","revert","bisect","bundle","apply","am","mv","rm","grep","show","clean","worktree","submodule"]);
        m.insert("docker", vec!["run","exec","build","push","pull","ps","images","image","logs","inspect","compose","network","volume","system","service","swarm","commit","cp","export","import","load","save","tag","stop","start","restart","rm","rmi","attach","stats","top","version"]);
        m.insert("kubectl", vec!["get","describe","logs","apply","delete","exec","port-forward","scale","rollout","top","label","annotate","patch","create","expose","run","config","version","cordon","drain","taint"]);
        m.insert("systemctl", vec!["start","stop","restart","reload","status","enable","disable","mask","unmask","daemon-reload","list-units","list-unit-files","show","cat","edit","is-active","is-enabled","journal","reset-failed"]);
        m.insert("apt", vec!["install","remove","purge","update","upgrade","full-upgrade","autoremove","search","show","list","edit-sources"]);
        m.insert("cargo", vec!["build","run","check","test","fmt","clippy","add","remove","update","publish","install","doc","clean","bench","tree","fix"]);
        m
    })
}

/// 提示符识别（启发式）：返回提示符之后的字节偏移（= 命令区起点），无提示符返回 0。
/// 支持 `$ `、`root@host:~# `、`user@host:~$ `、`[user@host ~]% `、`PS> ` 等常见形态。
pub fn prompt_end(line: &str) -> usize {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        // 注意：(?x) 下空白在字符类内也被忽略、`#` 会被当注释（regex crate 行为），
        // 故类内空格用 \x20、`#` 用 \x23。
        Regex::new(
            r"(?x)^(?:
                (?:[\w.@\-]+@[\w\-]+:\x20?[^\x23$%>\n]*[\x23$%>])   # user@host:path$ 形态
              | (?:\[[\w.@\-]+\s+[^\]]*\][\x23$%>])                   # [user@host dir]% 形态
              | (?:\$                                                   # 裸 $ （bash 默认）
                 | [^\x23$%>\n\s]{1,80}?[\x23$%>])                     # 无空白短前缀 + 提示符
            )\x20+
        ",
        )
        .unwrap()
    });
    re.find(line).map(|m| m.end()).unwrap_or(0)
}

/// 把任意字节偏移向下吸附到字符边界（前端传来的 caret 可能是 UTF-16 折算值）。
fn floor_boundary(s: &str, i: usize) -> usize {
    let mut j = i.min(s.len());
    while j > 0 && !s.is_char_boundary(j) {
        j -= 1;
    }
    j
}

/// 分词主入口：先剥提示符，再按 shell 词法扫描整行。
pub fn tokenize(line: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let pe = prompt_end(line);
    if pe > 0 {
        out.push(Token { kind: TokenKind::Prompt, start: 0, end: pe });
    }
    let b = line.as_bytes();
    let mut i = pe;
    let mut at_word_start = true;
    let mut first_word_done = false;
    let mut pending_tool: Option<&'static [&'static str]> = None;
    while i < b.len() {
        let c = b[i];
        match c {
            b' ' | b'\t' => {
                i += 1;
                at_word_start = true;
                continue;
            }
            b'#' if at_word_start => {
                push(&mut out, TokenKind::Comment, i, b.len());
                break;
            }
            q @ (b'\'' | b'"') => {
                // 引号串：双引号内支持 \ 转义；未闭合则吞到行尾（编辑中友好）
                let start = i;
                i += 1;
                while i < b.len() {
                    if b[i] == b'\\' && q == b'"' {
                        i += 2;
                        continue;
                    }
                    if b[i] == q {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                push(&mut out, TokenKind::StringLit, start, i);
                at_word_start = false;
                continue;
            }
            b'$' => {
                // $VAR / ${...} / $(...)（按深度配对括号）
                let start = i;
                i += 1;
                if i < b.len() && b[i] == b'{' {
                    while i < b.len() && b[i] != b'}' {
                        i += 1;
                    }
                    if i < b.len() {
                        i += 1;
                    }
                } else if i < b.len() && b[i] == b'(' {
                    let mut depth = 0usize;
                    while i < b.len() {
                        match b[i] {
                            b'(' => depth += 1,
                            b')' => {
                                depth -= 1;
                                if depth == 0 {
                                    i += 1;
                                    break;
                                }
                            }
                            _ => {}
                        }
                        i += 1;
                    }
                } else {
                    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                        i += 1;
                    }
                }
                push(&mut out, TokenKind::Variable, start, i);
                at_word_start = false;
                continue;
            }
            o @ (b'|' | b';' | b'&') => {
                let start = i;
                i += 1;
                if i < b.len() && b[i] == o {
                    i += 1; // || && ;;
                }
                push(&mut out, TokenKind::Operator, start, i);
                at_word_start = true;
                first_word_done = false; // 管道/连接符后重新计命令词
                pending_tool = None;
                continue;
            }
            r @ (b'>' | b'<') => {
                let start = i;
                // 2>&1 之类：回吞紧邻的 fd 号（仅当上一 token 恰为相邻 Number）
                if start > pe && b[start - 1].is_ascii_digit() {
                    let mut s2 = start - 1;
                    while s2 > pe && b[s2 - 1].is_ascii_digit() {
                        s2 -= 1;
                    }
                    if let Some(last) = out.last_mut() {
                        if last.kind == TokenKind::Number && last.end == start {
                            last.start = s2;
                            last.kind = TokenKind::Redirect;
                        }
                    }
                }
                i += 1;
                if i < b.len() && (b[i] == r || b[i] == b'&') {
                    i += 1; // >> << <& >&
                }
                push(&mut out, TokenKind::Redirect, start, i);
                at_word_start = true;
                // 注意：不重置 first_word_done —— 重定向后是文件参数而非命令
                continue;
            }
            b'-' if at_word_start => {
                let start = i;
                i += 1;
                scan_word(b, &mut i);
                let kind = if line[start..i].starts_with("--") {
                    TokenKind::LongOption
                } else {
                    TokenKind::Option
                };
                push(&mut out, kind, start, i);
                at_word_start = false;
                continue;
            }
            _ => {
                let start = i;
                scan_word(b, &mut i);
                let word = &line[start..i];
                if !first_word_done && at_word_start {
                    push(&mut out, TokenKind::Command, start, i);
                    first_word_done = true;
                    pending_tool = subcommand_tools().get(word).map(|v| v.as_slice());
                } else if let Some(subs) = pending_tool {
                    // 已知工具的后续非选项词：命中子命令表则标 SubCommand；
                    // 未命中（如 `-C /repo` 的参数值）保持 pending，继续等子命令。
                    if subs.contains(&word) {
                        push(&mut out, TokenKind::SubCommand, start, i);
                        pending_tool = None;
                    } else {
                        push(&mut out, TokenKind::Text, start, i);
                    }
                } else if !word.is_empty() && word.bytes().all(|ch| ch.is_ascii_digit()) {
                    push(&mut out, TokenKind::Number, start, i);
                } else {
                    push(&mut out, TokenKind::Text, start, i);
                }
                at_word_start = false;
                continue;
            }
        }
    }
    out
}

/// 词扫描：吃到空白/元字符为止；反斜杠转义吞掉下一个字节（`a\|b` 是一个词）。
fn scan_word(b: &[u8], i: &mut usize) {
    while *i < b.len() {
        let c = b[*i];
        if c.is_ascii_whitespace() || matches!(c, b'|' | b';' | b'&' | b'<' | b'>') {
            break;
        }
        if c == b'\\' && *i + 1 < b.len() {
            *i += 2;
            continue;
        }
        *i += 1;
    }
}

fn push(v: &mut Vec<Token>, kind: TokenKind, start: usize, end: usize) {
    if end > start {
        v.push(Token { kind, start, end });
    }
}

/// 光标处的补全上下文：正在补命令？子命令？选项？普通词（文件参数）？
#[derive(Debug, PartialEq, Eq)]
pub enum CompletionCtx {
    /// 补命令名；prompt = 替换起点（当前/下一个命令词起始偏移）
    Command { prompt: usize },
    /// 补已知工具的子命令
    SubCommand { tool: String, sub_prefix: String },
    /// 补选项；tool/sub 供查选项表，word_start = 当前词起点
    Option { tool: String, sub: Option<String>, word_start: usize },
    /// 补普通词（文件/目录参数）
    Word { word: String, word_start: usize },
}

/// 取当前段内「工具 + 子命令」：跳过前导选项；支持 sudo/env 等包装词
/// （优先取段内第一个已知工具，否则取第一个非选项词）。
fn tool_ctx(line: &str, words: &[(usize, usize, TokenKind)]) -> (String, Option<String>) {
    let args: Vec<(usize, usize, TokenKind)> = words
        .iter()
        .cloned()
        .filter(|&(_, _, k)| !matches!(k, TokenKind::Option | TokenKind::LongOption))
        .collect();
    if args.is_empty() {
        return (String::new(), None);
    }
    let mut ti = 0usize;
    if !subcommand_tools().contains_key(&line[args[0].0..args[0].1]) {
        if let Some(p) = args
            .iter()
            .position(|&(s, e, _)| subcommand_tools().contains_key(&line[s..e]))
        {
            ti = p;
        }
    }
    let (s0, e0, _) = args[ti];
    let tool = &line[s0..e0];
    let sub = if subcommand_tools().contains_key(tool) {
        args.get(ti + 1)
            .filter(|&&(_, _, k)| matches!(k, TokenKind::SubCommand | TokenKind::Text))
            .map(|&(s, e, _)| line[s..e].to_string())
    } else {
        None
    };
    (tool.to_string(), sub)
}

/// 补全上下文判定主入口。caret 为字节偏移（自动向下吸附字符边界）。
pub fn completion_context(line: &str, caret: usize) -> CompletionCtx {
    let caret = floor_boundary(line, caret);
    let toks = tokenize(&line[..caret]);

    // 段 = 最后一个 算符/重定向/注释 之后的 token 区间。
    let seg = toks
        .iter()
        .rposition(|t| matches!(t.kind, TokenKind::Operator | TokenKind::Redirect | TokenKind::Comment))
        .map(|p| p + 1)
        .unwrap_or(0);
    let boundary = if seg > 0 { Some(toks[seg - 1].kind) } else { None };
    let words: Vec<(usize, usize, TokenKind)> = toks[seg..]
        .iter()
        .filter(|t| {
            matches!(
                t.kind,
                TokenKind::Command
                    | TokenKind::SubCommand
                    | TokenKind::Option
                    | TokenKind::LongOption
                    | TokenKind::Number
                    | TokenKind::Text
                    | TokenKind::StringLit
                    | TokenKind::Variable
            )
        })
        .map(|t| (t.start, t.end, t.kind))
        .collect();

    let args: Vec<(usize, usize, TokenKind)> = words
        .iter()
        .cloned()
        .filter(|&(_, _, k)| !matches!(k, TokenKind::Option | TokenKind::LongOption))
        .collect();
    // 段内第一个已知工具的位置（无则 0）
    let mut ti = 0usize;
    if args.is_empty() || !subcommand_tools().contains_key(&line[args[0].0..args[0].1]) {
        ti = args
            .iter()
            .position(|&(s, e, _)| subcommand_tools().contains_key(&line[s..e]))
            .unwrap_or(0);
    }
    let known_tool_at = |idx: usize| -> Option<String> {
        args.get(idx).map(|&(s, e, _)| line[s..e].to_string()).filter(|t| subcommand_tools().contains_key(t.as_str()))
    };

    match words.last() {
        // —— 光标紧贴一个词尾：补全「该词本身」 ——
        Some(&(ws, we, wk)) if we == caret => {
            if matches!(wk, TokenKind::StringLit | TokenKind::Variable) {
                return CompletionCtx::Word { word: String::new(), word_start: caret };
            }
            let cur = line[ws..we].to_string();
            if cur.starts_with('-') || matches!(wk, TokenKind::Option | TokenKind::LongOption) {
                let (tool, sub) = tool_ctx(line, &words);
                return CompletionCtx::Option { tool, sub, word_start: ws };
            }
            if wk == TokenKind::Command && args.len() == 1 {
                return CompletionCtx::Command { prompt: ws };
            }
            if wk == TokenKind::SubCommand {
                // 子命令已完整命中 -> 下一个词才是补全目标
                return CompletionCtx::Word { word: String::new(), word_start: caret };
            }
            if wk == TokenKind::Text
                && args.len() >= 2
                && ti + 1 == args.len() - 1
                && known_tool_at(ti).is_some()
            {
                return CompletionCtx::SubCommand {
                    tool: known_tool_at(ti).unwrap(),
                    sub_prefix: cur,
                };
            }
            CompletionCtx::Word { word: cur, word_start: ws }
        }
        // —— 光标在空白后（或行/段首）：补「新词」 ——
        _ => {
            if boundary == Some(TokenKind::Redirect) {
                return CompletionCtx::Word { word: String::new(), word_start: caret };
            }
            if words.is_empty() {
                return CompletionCtx::Command { prompt: caret };
            }
            // 段内最后一个非选项词是已知工具 -> 补子命令（支持 sudo git 等包装）
            if let Some(tool) = known_tool_at(args.len() - 1) {
                return CompletionCtx::SubCommand { tool, sub_prefix: String::new() };
            }
            CompletionCtx::Word { word: String::new(), word_start: caret }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(line: &str) -> Vec<TokenKind> {
        tokenize(line).into_iter().map(|t| t.kind).collect()
    }

    #[test]
    fn plain_command() {
        assert_eq!(kinds("ls -la /tmp"), vec![TokenKind::Command, TokenKind::Option, TokenKind::Text]);
    }
    #[test]
    fn prompt_stripped() {
        let t = tokenize("el@ustc:~$ ls");
        assert_eq!(t[0].kind, TokenKind::Prompt);
        assert_eq!(t[1].kind, TokenKind::Command);
    }
    #[test]
    fn root_prompt_hash() {
        let t = tokenize("root@box:~# apt update");
        assert_eq!(t[0].kind, TokenKind::Prompt);
        assert_eq!(t[1].kind, TokenKind::Command);
    }
    #[test]
    fn bare_dollar_prompt() {
        let t = tokenize("$ ls");
        assert_eq!(t[0].kind, TokenKind::Prompt);
        assert_eq!(t[1].kind, TokenKind::Command);
    }
    #[test]
    fn git_subcommand() {
        assert_eq!(
            kinds("git commit -m x"),
            vec![TokenKind::Command, TokenKind::SubCommand, TokenKind::Option, TokenKind::Text]
        );
    }
    #[test]
    fn subcommand_after_options() {
        // 选项不打断「工具->子命令」识别
        assert_eq!(
            kinds("git -C /repo commit"),
            vec![TokenKind::Command, TokenKind::Option, TokenKind::Text, TokenKind::SubCommand]
        );
    }
    #[test]
    fn long_option() {
        assert_eq!(kinds("grep --color=auto x"), vec![TokenKind::Command, TokenKind::LongOption, TokenKind::Text]);
    }
    #[test]
    fn quotes() {
        let t = tokenize("echo \"a b $c\" 'd e'");
        assert_eq!(t[1].kind, TokenKind::StringLit);
        assert_eq!(t[2].kind, TokenKind::StringLit);
    }
    #[test]
    fn variable_forms() {
        assert_eq!(kinds("echo $HOME ${PWD}"), vec![TokenKind::Command, TokenKind::Variable, TokenKind::Variable]);
    }
    #[test]
    fn command_substitution() {
        assert_eq!(kinds("echo $(ls /tmp)"), vec![TokenKind::Command, TokenKind::Variable]);
    }
    #[test]
    fn pipeline_chain() {
        let k = kinds("ps aux | grep x");
        assert_eq!(k, vec![TokenKind::Command, TokenKind::Text, TokenKind::Operator, TokenKind::Command, TokenKind::Text]);
    }
    #[test]
    fn redirect_with_fd() {
        let k = kinds("make 2>&1 | tee log");
        assert!(k.contains(&TokenKind::Redirect));
    }
    #[test]
    fn redirect_does_not_reset_command() {
        // 重定向后的词是文件参数，不是命令
        assert_eq!(
            kinds("ls > out"),
            vec![TokenKind::Command, TokenKind::Redirect, TokenKind::Text]
        );
    }
    #[test]
    fn comment_line() {
        // 行首裸 `#` 是注释而非 root 提示符
        assert_eq!(kinds("# just a note"), vec![TokenKind::Comment]);
    }
    #[test]
    fn comment_after_command() {
        assert_eq!(kinds("ls # note"), vec![TokenKind::Command, TokenKind::Comment]);
    }
    #[test]
    fn unclosed_quote_still_tokenized() {
        let t = tokenize("echo \"abc");
        assert_eq!(t.last().unwrap().kind, TokenKind::StringLit);
    }
    #[test]
    fn escaped_operator_is_word() {
        // `a\|b` 是一个词（转义不吃掉元字符语义）
        let t = tokenize("cat a\\|b");
        assert_eq!(t.len(), 2);
        assert_eq!(t[1].kind, TokenKind::Text);
        assert_eq!(t[1].end, "cat a\\|b".len());
    }
    #[test]
    fn unicode_word_safe() {
        let t = tokenize("echo 你好 x");
        assert_eq!(t, vec![
            Token { kind: TokenKind::Command, start: 0, end: 4 },
            Token { kind: TokenKind::Text, start: 5, end: 11 },
            Token { kind: TokenKind::Text, start: 12, end: 13 },
        ]);
    }
    #[test]
    fn empty_line() {
        assert!(tokenize("").is_empty());
    }
    #[test]
    fn scope_names_stable() {
        assert_eq!(TokenKind::Command.scope(), "entity.name.command.shell");
        assert_eq!(TokenKind::Prompt.scope(), "sign.directive.prompt.shell");
    }
    #[test]
    fn ctx_command_start() {
        assert_eq!(completion_context("git ", 4), CompletionCtx::SubCommand { tool: "git".into(), sub_prefix: String::new() });
    }
    #[test]
    fn ctx_option_after_sub() {
        match completion_context("git commit --am", 15) {
            CompletionCtx::Option { tool, sub, .. } => {
                assert_eq!(tool, "git");
                assert_eq!(sub.as_deref(), Some("commit"));
            }
            other => panic!("{other:?}"),
        }
    }
    #[test]
    fn ctx_first_word() {
        assert_eq!(completion_context("sys", 3), CompletionCtx::Command { prompt: 0 });
    }
    #[test]
    fn ctx_partial_subcommand() {
        assert_eq!(completion_context("git com", 7), CompletionCtx::SubCommand { tool: "git".into(), sub_prefix: "com".into() });
    }
    #[test]
    fn ctx_wrapped_tool() {
        // sudo 包装后仍能识别 git 的子命令上下文
        assert_eq!(completion_context("sudo git com", 12), CompletionCtx::SubCommand { tool: "git".into(), sub_prefix: "com".into() });
        assert_eq!(completion_context("sudo git ", 9), CompletionCtx::SubCommand { tool: "git".into(), sub_prefix: String::new() });
    }
    #[test]
    fn ctx_unknown_tool_option() {
        match completion_context("ls -l", 5) {
            CompletionCtx::Option { tool, sub, word_start } => {
                assert_eq!(tool, "ls");
                assert_eq!(sub, None);
                assert_eq!(word_start, 3);
            }
            other => panic!("{other:?}"),
        }
    }
    #[test]
    fn ctx_after_redirect_is_word() {
        assert_eq!(completion_context("ls > ", 5), CompletionCtx::Word { word: String::new(), word_start: 5 });
    }
    #[test]
    fn ctx_after_pipe_is_command() {
        assert_eq!(completion_context("ls | gr", 7), CompletionCtx::Command { prompt: 5 });
        assert_eq!(completion_context("ls | ", 5), CompletionCtx::Command { prompt: 5 });
    }
    #[test]
    fn ctx_complete_subcommand_moves_to_word() {
        // 子命令已完整命中 -> 不再补子命令
        assert_eq!(completion_context("git status", 10), CompletionCtx::Word { word: String::new(), word_start: 10 });
    }
    #[test]
    fn ctx_with_prompt() {
        assert_eq!(completion_context("user@host:~$ git ", 17), CompletionCtx::SubCommand { tool: "git".into(), sub_prefix: String::new() });
    }
    #[test]
    fn ctx_caret_mid_utf8() {
        // caret 落在多字节字符中间：向下吸附，不 panic
        let c = completion_context("echo 你好", 7);
        assert!(matches!(c, CompletionCtx::Word { .. }));
    }
    #[test]
    fn ctx_caret_beyond_len() {
        assert_eq!(completion_context("ls", 999), CompletionCtx::Command { prompt: 0 });
    }
    #[test]
    fn ctx_docker_compose() {
        match completion_context("docker compose up -f", 20) {
            CompletionCtx::Option { tool, sub, word_start } => {
                assert_eq!(tool, "docker");
                assert_eq!(sub.as_deref(), Some("compose")); // 选项表键 "docker compose"
                assert_eq!(word_start, 18);
            }
            other => panic!("{other:?}"),
        }
    }
    #[test]
    fn numbers() {
        assert_eq!(kinds("sleep 10"), vec![TokenKind::Command, TokenKind::Number]);
    }
    #[test]
    fn andand_operator() {
        let k = kinds("cd /tmp && ls");
        assert!(k.contains(&TokenKind::Operator));
        // && 后重新计命令词
        assert_eq!(k[k.len() - 1], TokenKind::Command);
    }
}
