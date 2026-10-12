//! P2 scheme 引擎 —— bash 命令行语法分词（TextMate 式 scope 分层）。
//! 设计借鉴 WindTerm .lexer 的**格式思想**（scopeName/patterns），模式全部自研；
//! 未读取任何 WindTerm 专有数据文件。用于：输入行高亮、补全上下文判定、Outline 分组。

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
    /// TextMate 风格 scope（自拟命名）
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

/// 常见二级子命令工具 -> 子命令表（公开常识，手写）
pub fn subcommand_tools() -> &'static std::collections::HashMap<&'static str, Vec<&'static str>> {
    static M: OnceLock<std::collections::HashMap<&'static str, Vec<&'static str>>> = OnceLock::new();
    M.get_or_init(|| {
        let mut m = std::collections::HashMap::new();
        m.insert("git", vec!["status","add","commit","push","pull","fetch","clone","branch","checkout","switch","merge","rebase","reset","restore","stash","tag","remote","log","diff","config","init","blame","cherry-pick","revert","bisect","bundle","apply","am","mv","rm","grep","show","clean","worktree","submodule"]);
        m.insert("docker", vec!["run","exec","build","push","pull","ps","images","image","logs","inspect","compose","network","volume","system","service","swarm","commit","cp","export","import","load","save","tag","stop","start","restart","rm","rmi","attach","stats","top","version"]);
        m.insert("kubectl", vec!["get","describe","logs","apply","delete","exec","port-forward","scale","rollout","top","label","annotate","patch","create","expose","run","config","version","cordon","drain","taint"]);
        m.insert("systemctl", vec!["start","stop","restart","reload","status","enable","disable","mask","unmask","daemon-reload","list-units","list-unit-files","show","cat","edit","is-active","is-enabled","journal","reset-failed"]);
        m.insert("apt", vec!["install","remove","purge","update","upgrade","full-upgrade","autoremove","search","show","list","edit-sources"]);
        m.insert("cargo", vec!["build","run","check","test","fmt","clippy","add","remove","update","publish","install","doc","clean","bench","tree","fix"]);
        m
    })
}

/// 提示符识别（手写扫描，避免正则 verbose 与 # 的歧义）。
/// 规则：前 80 字节内寻找 $ % > 后跟空白者；# 仅当此前有 '@' 与 ':'（root 提示形态）才算提示符。
pub fn prompt_end(line: &str) -> usize {
    let b = line.as_bytes();
    let limit = b.len().min(80);
    let mut saw_at = false;
    let mut saw_colon = false;
    let mut i = 0usize;
    while i < limit {
        match b[i] {
            b'@' => saw_at = true,
            b':' => saw_colon = true,
            c @ (b'$' | b'%' | b'>') => {
                if i + 1 < b.len() && (b[i + 1] == b' ' || b[i + 1] == b'\t') {
                    let mut k = i + 1;
                    while k < b.len() && (b[k] == b' ' || b[k] == b'\t') { k += 1; }
                    return k;
                }
            }
            b'#' => {
                if saw_at && saw_colon && i + 1 < b.len() && (b[i + 1] == b' ' || b[i + 1] == b'\t') {
                    let mut k = i + 1;
                    while k < b.len() && (b[k] == b' ' || b[k] == b'\t') { k += 1; }
                    return k;
                }
            }
            _ => {}
        }
        i += 1;
    }
    0
}

/// 分词主入口：先剥提示符，再按 shell 词法扫描。
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
        let c = b[i] as char;
        match c {
            ' ' | '\t' => { i += 1; at_word_start = true; continue; }
            '#' if at_word_start => {
                push(&mut out, TokenKind::Comment, i, b.len());
                break;
            }
            '\'' | '"' => {
                let start = i; i += 1;
                while i < b.len() {
                    if b[i] == b'\\' && c == '"' { i += 2; continue; }
                    if b[i] as char == c { i += 1; break; }
                    i += 1;
                }
                push(&mut out, TokenKind::StringLit, start, i);
                at_word_start = false;
                continue;
            }
            '$' => {
                let start = i; i += 1;
                if i < b.len() && b[i] == b'{' {
                    while i < b.len() && b[i] != b'}' { i += 1; }
                    if i < b.len() { i += 1; }
                } else {
                    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') { i += 1; }
                }
                push(&mut out, TokenKind::Variable, start, i);
                at_word_start = false;
                continue;
            }
            '|' | ';' | '&' => {
                let start = i; i += 1;
                if i < b.len() && b[i] == c as u8 { i += 1; } // || , && , ;;
                push(&mut out, TokenKind::Operator, start, i);
                at_word_start = true;
                first_word_done = false;
                pending_tool = None;
                continue;
            }
            '>' | '<' => {
                let start = i;
                if start > 0 && b[start - 1].is_ascii_digit() {
                    // 2>&1 之类：回吞 fd 号
                    let mut s2 = start - 1;
                    while s2 > pe && b[s2 - 1].is_ascii_digit() { s2 -= 1; }
                    if let Some(last) = out.last_mut() {
                        if last.kind == TokenKind::Number { last.start = s2; last.kind = TokenKind::Redirect; }
                    }
                }
                i += 1;
                if i < b.len() && (b[i] == b'>' || b[i] == b'&') { i += 1; }
                push(&mut out, TokenKind::Redirect, start, i);
                at_word_start = true;
                continue;
            }
            '-' if at_word_start => {
                let start = i; i += 1;
                if i < b.len() && b[i] == b'-' { while i < b.len() && !b[i].is_ascii_whitespace() { i += 1; } }
                else { while i < b.len() && !b[i].is_ascii_whitespace() { i += 1; } }
                let kind = if line[start..i].starts_with("--") { TokenKind::LongOption } else { TokenKind::Option };
                push(&mut out, kind, start, i);
                at_word_start = false;
                continue;
            }
            _ => {
                let start = i;
                while i < b.len() && !b[i].is_ascii_whitespace() && !"|;&<>".contains(b[i] as char) { i += 1; }
                let word = &line[start..i];
                if !first_word_done && at_word_start {
                    push(&mut out, TokenKind::Command, start, i);
                    first_word_done = true;
                    pending_tool = subcommand_tools().get(word).map(|v| v.as_slice());
                } else if let Some(subs) = pending_tool {
                    if subs.contains(&word) {
                        push(&mut out, TokenKind::SubCommand, start, i);
                    } else {
                        push(&mut out, TokenKind::Text, start, i);
                    }
                    pending_tool = None;
                } else if word.chars().all(|ch| ch.is_ascii_digit()) {
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

fn push(v: &mut Vec<Token>, kind: TokenKind, start: usize, end: usize) {
    if end > start { v.push(Token { kind, start, end }); }
}

/// 光标处的补全上下文：正在补命令？子命令？选项？普通词？
#[derive(Debug, PartialEq, Eq)]
pub enum CompletionCtx {
    Command { prompt: usize },
    SubCommand { tool: String, sub_prefix: String },
    Option { tool: String, sub: Option<String>, word_start: usize },
    Word { word: String, word_start: usize },
}

pub fn completion_context(line: &str, caret: usize) -> CompletionCtx {
    let pe = prompt_end(line);
    let toks = tokenize(&line[..caret]);
    let words: Vec<(usize, usize, TokenKind)> = toks
        .iter()
        .filter(|t| matches!(t.kind, TokenKind::Command | TokenKind::SubCommand | TokenKind::Text | TokenKind::Option | TokenKind::LongOption))
        .map(|t| (t.start, t.end, t.kind))
        .collect();
    let ends_with_space = line[pe.max(1)..caret].ends_with(' ') || pe >= caret;
    if words.is_empty() || (ends_with_space && pe < caret) {
        // 新词：如果上一个词是已知工具 -> 补子命令
        if let Some(&(_, _, _)) = words.last() {}
        if let Some(&(s, e, k)) = words.first() {
            if k == TokenKind::Command && words.len() == 1 && ends_with_space {
                let tool = &line[s..e];
                if subcommand_tools().contains_key(tool) {
                    return CompletionCtx::SubCommand { tool: tool.to_string(), sub_prefix: String::new() };
                }
            }
        }
        return CompletionCtx::Command { prompt: pe };
    }
    let (ws, we, wk) = *words.last().unwrap();
    let cur = &line[ws..caret.min(we).max(ws)];
    // 光标在最后一个词之后且有空格 -> 新词
    if caret > we {
        let tool = words.first().map(|&(s, e, _)| line[s..e].to_string()).unwrap_or_default();
        return if subcommand_tools().contains_key(tool.as_str()) && words.len() == 2 {
            CompletionCtx::SubCommand { tool, sub_prefix: String::new() }
        } else {
            CompletionCtx::Word { word: String::new(), word_start: caret }
        };
    }
    if wk == TokenKind::Command {
        return CompletionCtx::Command { prompt: pe };
    }
    if wk == TokenKind::Option || wk == TokenKind::LongOption {
        let tool = words.first().map(|&(s, e, _)| line[s..e].to_string()).unwrap_or_default();
        let sub = words.get(1).filter(|&&(_, _, k)| k == TokenKind::SubCommand).map(|&(s, e, _)| line[s..e].to_string());
        return CompletionCtx::Option { tool, sub, word_start: ws };
    }
    if cur.starts_with('-') {
        let tool = words.first().map(|&(s, e, _)| line[s..e].to_string()).unwrap_or_default();
        let sub = words.get(1).filter(|&&(_, _, k)| k == TokenKind::SubCommand).map(|&(s, e, _)| line[s..e].to_string());
        return CompletionCtx::Option { tool, sub, word_start: ws };
    }
    if words.len() == 1 {
        return CompletionCtx::Command { prompt: pe };
    }
    let tool = line[words[0].0..words[0].1].to_string();
    if subcommand_tools().contains_key(tool.as_str()) && words.len() == 2 && wk != TokenKind::SubCommand {
        return CompletionCtx::SubCommand { tool, sub_prefix: cur.to_string() };
    }
    CompletionCtx::Word { word: cur.to_string(), word_start: ws }
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
    fn git_subcommand() {
        assert_eq!(kinds("git commit -m x"), vec![TokenKind::Command, TokenKind::SubCommand, TokenKind::Option, TokenKind::Text]);
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
    fn comment_line() {
        assert_eq!(kinds("# just a note"), vec![TokenKind::Comment]);
    }
    #[test]
    fn unclosed_quote_still_tokenized() {
        let t = tokenize("echo \"abc");
        assert_eq!(t.last().unwrap().kind, TokenKind::StringLit);
    }
    #[test]
    fn empty_line() {
        assert!(tokenize("").is_empty());
    }
    #[test]
    fn ctx_command_start() {
        assert_eq!(completion_context("git ", 4), CompletionCtx::SubCommand { tool: "git".into(), sub_prefix: String::new() });
    }
    #[test]
    fn ctx_option_after_sub() {
        match completion_context("git commit --am", 15) {
            CompletionCtx::Option { tool, sub, .. } => { assert_eq!(tool, "git"); assert_eq!(sub.as_deref(), Some("commit")); }
            other => panic!("{other:?}"),
        }
    }
    #[test]
    fn ctx_first_word() {
        assert_eq!(completion_context("sys", 3), CompletionCtx::Command { prompt: 0 });
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