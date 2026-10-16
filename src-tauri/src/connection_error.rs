//! User-visible connection failures, with phase context and credential redaction.
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt;
use std::sync::OnceLock;

pub type BoxError = Box<dyn Error + Send + Sync>;

#[derive(Debug)]
struct Context { stage: &'static str, label: String, source: BoxError }
impl fmt::Display for Context {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}：{}", self.label, self.source) }
}
impl Error for Context { fn source(&self) -> Option<&(dyn Error + 'static)> { Some(self.source.as_ref()) } }
pub fn context(stage: &'static str, label: impl Into<String>, source: BoxError) -> BoxError {
    Box::new(Context { stage, label: label.into(), source })
}
pub fn failure(stage: &'static str, label: impl Into<String>, detail: impl Into<String>) -> BoxError {
    context(stage, label, Box::new(std::io::Error::new(std::io::ErrorKind::Other, detail.into())))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionError {
    pub id: String,
    pub protocol: String,
    pub stage: String,
    pub error: String,
}
impl ConnectionError {
    pub fn new(id: &str, protocol: &str, error: &(dyn Error + 'static), secrets: &[String]) -> Self {
        let mut stage = "connection";
        let mut causes = Vec::new();
        let mut current = Some(error);
        for _ in 0..12 {
            let Some(cause) = current else { break; };
            if let Some(context) = cause.downcast_ref::<Context>() { stage = context.stage; }
            let text = cause.to_string();
            if !text.is_empty() && !causes.iter().any(|existing: &String| existing.contains(&text)) { causes.push(text); }
            current = cause.source();
        }
        let mut detail = causes.join("；原因：");
        let lower = detail.to_ascii_lowercase();
        if lower.contains("unknown server key") || lower.contains("unknownkey") || lower.contains("host key mismatch") || lower.contains("主机密钥不匹配") {
            stage = "host-key";
            detail = format!("SSH 主机密钥验证失败，请核实服务器密钥与 known_hosts 记录后重试：{detail}");
        }
        Self { id: id.into(), protocol: protocol.into(), stage: stage.into(), error: redact(&detail, secrets) }
    }
}

pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut safe = text.to_string();
    let mut secrets: Vec<&str> = secrets.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for secret in secrets { safe = safe.replace(secret, "[已隐藏]"); }
    static PATTERNS: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| vec![
        (regex::Regex::new(r"(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)").unwrap(), "[私钥内容已隐藏]"),
        (regex::Regex::new(r"(?im)\b(?:proxy-authorization|authorization)\s*[:=]\s*[^\r\n]+").unwrap(), "Authorization: [已隐藏]"),
        (regex::Regex::new(r#"(?i)(\b(?:password|passwd|passphrase|token|api[_-]?key|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)"#).unwrap(), "$1[已隐藏]"),
        (regex::Regex::new(r#"(?i)((?:--?(?:password|passwd|passphrase|token|api[_-]?key|secret)|-pw)\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)"#).unwrap(), "$1[已隐藏]"),
        (regex::Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^/@\s]+@").unwrap(), "$1[凭据已隐藏]@"),
        (regex::Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))").unwrap(), ""),
    ]);
    for (pattern, replacement) in patterns { safe = pattern.replace_all(&safe, *replacement).into_owned(); }
    safe = safe.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if safe.len() > 4096 {
        let mut end = 4096; while !safe.is_char_boundary(end) { end -= 1; }
        safe.truncate(end); safe.push_str("…");
    }
    safe
}

pub fn proxy_secrets(proxy: &crate::ssh_relay::Proxy) -> Vec<String> {
    use base64::Engine;
    use crate::ssh_relay::Proxy;
    let pair = match proxy {
        Proxy::Socks5(p) => Some((&p.user, &p.password)),
        Proxy::Http(p) => Some((&p.user, &p.password)),
        Proxy::System => return proxy_secrets(&crate::ssh_relay::system_proxy()),
        Proxy::ProxyCommand(p) => {
            let mut secrets = vec![p.cmd.clone()];
            for (key, value) in &p.environment {
                let name = key.to_ascii_lowercase();
                if name.contains("token") || name.contains("password") || name.contains("secret") || name.contains("key") { secrets.push(value.clone()); }
            }
            return secrets;
        }
        _ => None,
    };
    let mut secrets = Vec::new();
    if let Some((user, password)) = pair {
        if let Some(password) = password {
            secrets.push(password.clone());
            if let Some(user) = user { secrets.push(base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"))); }
        }
    }
    secrets
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_phase_and_underlying_os_cause() {
        let error = context("tcp", "SSH TCP 连接失败 example:22", Box::new(std::io::Error::from_raw_os_error(111)));
        let payload = ConnectionError::new("fixture", "ssh", error.as_ref(), &[]);
        assert_eq!(payload.stage, "tcp"); assert!(payload.error.contains("example:22")); assert!(payload.error.contains("111"));
    }
    #[test]
    fn credentials_pem_headers_and_control_sequences_are_not_exposed() {
        let text = "failed top-secret https://alice:hunter2@proxy:7890 token=abcd password='two words' --token 'cli sensitive' -pw cli-password\nAuthorization: Bearer sk-xyz\n-----BEGIN OPENSSH PRIVATE KEY-----\nprivate bytes\n-----END OPENSSH PRIVATE KEY-----\x1b[31mhello\x1b[0m";
        let safe = redact(text, &["top-secret".into()]);
        for value in ["top-secret", "hunter2", "abcd", "two words", "cli sensitive", "cli-password", "sk-xyz", "private bytes", "\x1b"] { assert!(!safe.contains(value), "leaked {value}: {safe}"); }
        assert!(safe.contains("proxy:7890")); assert!(safe.contains("hello"));
    }
    #[test]
    fn host_key_failure_is_specific_and_does_not_recommend_bypassing_trust() {
        let error = failure("handshake", "SSH 握手失败", "Unknown server key");
        let payload = ConnectionError::new("fixture", "ssh", error.as_ref(), &[]);
        assert_eq!(payload.stage, "host-key"); assert!(payload.error.contains("核实")); assert!(!payload.error.contains("删除"));
    }
    #[test]
    fn long_unicode_detail_is_bounded_at_a_character_boundary() {
        let safe = redact(&"远程".repeat(4000), &[]); assert!(safe.len() <= 4099); assert!(!safe.contains('\u{fffd}'));
    }
}
