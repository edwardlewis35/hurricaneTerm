//! Filer/cwd 跟踪 —— shell 集成上报 cwd 的解码。
//!
//! 算法：
//! 1. 仅当 OS 名包含 "Darwin" 且数据中反斜杠数量 > 1 时解码；否则原样透传
//! 2. 扫描字节：`\\`   -> 折叠为单个 `\`
//!              `\xHH` -> 解码为单字节 HH（写回原位置，删除 "xHH" 三字符）
//! 3. 解码结果经 Unicode 转换后设为 shell cwd（本模块返回解码后的字节串）
//! 4. 目录扫描过滤器：形如 "\s*%1\s*" 的模式以 ':' 分号切分

/// shell 上报 cwd 的解码核心。os_is_darwin 对应 OS 名含 "Darwin" 的分支。
pub fn decode_shell_cwd(raw: &[u8], os_is_darwin: bool) -> Vec<u8> {
    // 守卫：Darwin 且反斜杠计数 > 1，否则原样返回
    if !os_is_darwin || raw.iter().filter(|b| **b == b'\\').count() <= 1 {
        return raw.to_vec();
    }
    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let mut i = 0usize;
    while i < raw.len() {
        if raw[i] == b'\\' {
            if i + 1 < raw.len() && raw[i + 1] == b'\\' {
                // `\\` -> `\`，消费两字符后继续
                out.push(b'\\');
                i += 2;
                continue;
            }
            if i + 3 < raw.len() && raw[i + 1] == b'x' {
                // `\xHH` -> 单字节，写回原位置并消费四字符
                if let Some(b) = hex2(raw[i + 2], raw[i + 3]) {
                    out.push(b);
                    i += 4;
                    continue;
                }
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

fn hex2(hi: u8, lo: u8) -> Option<u8> {
    let v = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    Some(v(hi)? * 16 + v(lo)?)
}

/// 目录扫描过滤器列表解析："\s*%1\s*" 形态的模式以 ':' 分隔
pub fn parse_scan_filters(spec: &str) -> Vec<String> {
    spec.split(':')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_darwin_passthrough() {
        let raw = b"/home/a\\\\b";
        assert_eq!(decode_shell_cwd(raw, false), raw.to_vec());
    }

    #[test]
    fn single_backslash_no_decode() {
        // 守卫：反斜杠计数必须 > 1
        let raw = b"/home/\\x41";
        assert_eq!(decode_shell_cwd(raw, true), raw.to_vec());
    }

    #[test]
    fn double_backslash_collapses() {
        assert_eq!(
            decode_shell_cwd(b"/tmp/a\\\\\\\\b", true), // /tmp/a\\\\b -> /tmp/a\\b
            b"/tmp/a\\\\b".to_vec()
        );
    }

    #[test]
    fn hex_escape_decodes() {
        // raw = a \\ b \ x 4 1 c  （3 个反斜杠 > 1 满足守卫）
        // 折叠优先：`\\\\`->`\\`，随后 `\\x41`->'A'  =>  a\\bAc
        let raw = b"a\\\\b\\x41c";
        assert_eq!(decode_shell_cwd(raw, true), b"a\\bAc".to_vec());
    }

#[test]
    fn filter_list_split() {
        assert_eq!(parse_scan_filters(" .git : node_modules :.svn"),
                   vec![".git".to_string(), "node_modules".to_string(), ".svn".to_string()]);
        assert!(parse_scan_filters("  ").is_empty());
    }
}