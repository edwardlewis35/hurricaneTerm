//! 自动登录（自动登录）
//!
//! 认证状态取值：0=SUCCESS，1=DENIED，2=INFO，3=PARTIAL，-1=ERROR；state∈{0,3} 为成功族、
//! state∈{-1,1} 为失败族、其它为 no-op。
//!
//! update_auto_login 决策表：
//! | 方法 | state∈{0,3} 成功族 | state∈{-1,1} 失败族 | 其它 state |
//! |---|---|---|---|
//! | None | json["session.user"]=value | 同左（不分支） | 同左 |
//! | Password | json["Password"]=value; json["PasswordEnabled"]=true | 若 json["Password"]==value → 删两者 | no-op |
//! | Public Key | list[3]=[path,pass,_]; path 非空→portable; sub[sys.path]=path, sub[sys.pass]=pass | sub[sys.path]!=path → 删两键 | no-op |
//! | Keyboard Interactive | 列表值：整表写入；映射值：merge | 列表值：删键；映射值：按键比对删除 | no-op |

use std::collections::HashMap;

use regex::{Regex, RegexBuilder};
use serde_json::{Map, Value};

// —— 方法名常量 ——
pub const AUTH_NONE: &str = "None";
pub const AUTH_PASSWORD: &str = "Password";
pub const AUTH_PASSWORD_ENABLED: &str = "PasswordEnabled";
pub const AUTH_PUBLICKEY: &str = "Public Key";
pub const AUTH_KEYBOARD_INTERACTIVE: &str = "Keyboard Interactive";

// —— json 键常量 ——
pub const PROP_SESSION_USER: &str = "session.user";
pub const PROP_SESSION_ONEKEY: &str = "session.oneKey";
pub const PROP_SSH_SERVER_FINGERPRINT: &str = "ssh.serverFingerprint";

// —— 触发器配置键 ——
pub const PROP_TEXT_PATTERN: &str = "text.pattern";
pub const PROP_TEXT_MATCH_CASE: &str = "text.matchCase";
pub const PROP_TEXT_MATCH_REGEX: &str = "text.matchRegex";
pub const PROP_TEXT_MATCH_WHOLE_WORD: &str = "text.matchWholeWord";

/// 认证状态（与 re/ssh_auth.rs 的 mapAuthState 输出一致）
pub const STATE_ERROR: i32 = -1;
pub const STATE_SUCCESS: i32 = 0;
pub const STATE_DENIED: i32 = 1;
pub const STATE_INFO: i32 = 2;
pub const STATE_PARTIAL: i32 = 3;

fn state_success(state: i32) -> bool {
    state == STATE_SUCCESS || state == STATE_PARTIAL
}
fn state_failure(state: i32) -> bool {
    state == STATE_ERROR || state == STATE_DENIED
}

/// 就地维护自动登录 json。
/// `system_name`：平台名（如 "macos"），参与 Public Key 条目键 "<sys>.path"/"<sys>.pass"；由宿主传入。
/// `portable_path`：可移植路径规范化，由宿主注入（返回 None 视为空 path 分支的“保持原值”）。
/// 返回 false = 状态/方法不在决策表内（no-op，对应 default 分支）。
pub fn update_auto_login(
    json: &mut Map<String, Value>,
    method: &str,
    value: &Value,
    state: i32,
    system_name: &str,
    portable_path: impl Fn(&str) -> Option<String>,
) -> bool {
    if !state_success(state) && !state_failure(state) {
        // None 之外的方法在 default 直接跳到收尾（不改动）；
        // 但 None 分支不经过 switch —— 先处理 None 再判。
        if method != AUTH_NONE {
            return false;
        }
    }
    match method {
        AUTH_NONE => {
            // None 分支先于 switch：insert("session.user", value)
            json.insert(PROP_SESSION_USER.into(), value.clone());
        }
        AUTH_PASSWORD => {
            if state_success(state) {
                json.insert(AUTH_PASSWORD.into(), value.clone());
                json.insert(AUTH_PASSWORD_ENABLED.into(), Value::Bool(true));
            } else {
                // 失败：仅当存的密码 == 本次尝试值才删除
                if json.get(AUTH_PASSWORD) == Some(value) {
                    json.remove(AUTH_PASSWORD);
                    json.remove(AUTH_PASSWORD_ENABLED);
                }
            }
        }
        AUTH_PUBLICKEY => {
            // value = 字符串列表 [path, pass, _]（size==3 才取前两项）
            let list: Vec<String> = value
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let mut path = list.get(0).cloned().unwrap_or_default();
            let pass = list.get(1).cloned().unwrap_or_default();
            if !path.is_empty() {
                // 非空 path 经可移植路径规范化
                path = portable_path(&path).unwrap_or(path);
            }
            let mut sub: Map<String, Value> = json
                .get(AUTH_PUBLICKEY)
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let k_path = format!("{system_name}.path");
            let k_pass = format!("{system_name}.pass");
            if state_success(state) {
                if !path.is_empty() {
                    sub.insert(k_path, Value::String(path));
                    sub.insert(k_pass, Value::String(pass));
                }
            } else if sub.get(&k_path).and_then(|v| v.as_str()).unwrap_or("") != path {
                // 存储值 != 本次值才删两键
                sub.remove(&k_path);
                sub.remove(&k_pass);
            }
            if sub.is_empty() {
                json.remove(AUTH_PUBLICKEY);
            } else {
                json.insert(AUTH_PUBLICKEY.into(), Value::Object(sub));
            }
        }
        AUTH_KEYBOARD_INTERACTIVE => {
            if value.is_array() {
                if state_success(state) {
                    json.insert(AUTH_KEYBOARD_INTERACTIVE.into(), value.clone());
                } else {
                    json.remove(AUTH_KEYBOARD_INTERACTIVE);
                }
            } else if let Some(obj) = value.as_object() {
                // 映射值：成功 merge；失败按键比对删除
                let mut sub: Map<String, Value> = json
                    .get(AUTH_KEYBOARD_INTERACTIVE)
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                if state_success(state) {
                    for (k, v) in obj {
                        sub.insert(k.clone(), v.clone());
                    }
                } else {
                    for (k, v) in obj {
                        if sub.get(k) != Some(v) {
                            sub.remove(k);
                        }
                    }
                }
                if sub.is_empty() {
                    json.remove(AUTH_KEYBOARD_INTERACTIVE);
                } else {
                    json.insert(AUTH_KEYBOARD_INTERACTIVE.into(), Value::Object(sub));
                }
            } else {
                return false; // 既非列表也非映射 → no-op
            }
        }
        _ => return false,
    }
    true
}

/// 自动登录决策：
/// Some((json, user_utf8)) → 宿主落盘 json 并以 user 走 None 认证；
/// None → 自动登录失败（json 空或 session.user 空）。
pub fn plan_auto_login(ssh_auto_login: &Map<String, Value>) -> Option<(Map<String, Value>, Vec<u8>)> {
    if ssh_auto_login.is_empty() {
        return None;
    }
    let user = ssh_auto_login
        .get(PROP_SESSION_USER)
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if user.is_empty() {
        return None;
    }
    Some((ssh_auto_login.clone(), user.as_bytes().to_vec()))
}

/// 是否需要 ssh 自动登录：option("ssh.autoLogin") 非空即真。
pub fn need_ssh_auto_login(ssh_auto_login: &Map<String, Value>) -> bool {
    !ssh_auto_login.is_empty()
}

/// 取回自动登录 json 前若无 "session.oneKey"，
/// 注入当前服务器指纹（键 "ssh.serverFingerprint"）。
pub fn take_auto_login(json: &mut Map<String, Value>, server_fingerprint: Option<&str>) {
    if !json.contains_key(PROP_SESSION_ONEKEY) {
        if let Some(fp) = server_fingerprint {
            json.insert(PROP_SSH_SERVER_FINGERPRINT.into(), Value::String(fp.into()));
        }
    }
}

// ============================ 自动登录 expect 匹配器 ============================

/// 账户部件：0=密码，1=用户名
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AccountPart {
    Password = 0,
    Username = 1,
}

/// 两个内置默认 expect 配置
pub const DEFAULT_USERNAME_EXPECT: &str =
    "{\"text.matchRegex\":true,\"text.pattern\":\"username:|login:\"}";
pub const DEFAULT_PASSWORD_EXPECT: &str =
    "{\"text.matchRegex\":true,\"text.pattern\":\"password:|password for \\\\S+:\"}";

/// 账户提示符匹配器。
/// 缓存：配置 JSON 原文 → 编译结果。
#[derive(Default)]
pub struct AutoLoginExpect {
    username_cache: HashMap<String, Option<Regex>>,
    password_cache: HashMap<String, Option<Regex>>,
}

/// 行尾锚定包装模板：
/// 非整词 `(%1)[ \t]*+(?<trigger>\S*+)$`；整词 `\b(%1)\b[ \t]*+(?<trigger>\S*+)$`。
/// 实现差异：Rust regex 不支持占有量词 `*+` → 贪心 `*`；`$`（可先于行尾单个 \n）
/// → Rust `\n?$`。捕获组 trigger 保留。
fn wrap_pattern(pattern: &str, whole_word: bool) -> String {
    if whole_word {
        format!("\\b({pattern})\\b[ \\t]*(?<trigger>\\S*)\\n?$")
    } else {
        format!("({pattern})[ \\t]*(?<trigger>\\S*)\\n?$")
    }
}

impl AutoLoginExpect {
    /// 编译单条配置：配置空串/非法 JSON/空 pattern/非法正则 → None（缓存 None）。
    /// 命中缓存直接返回。
    pub fn compile(&mut self, part: AccountPart, config: &str) -> Option<&Regex> {
        if config.is_empty() {
            return None;
        }
        let cache = match part {
            AccountPart::Username => &mut self.username_cache,
            AccountPart::Password => &mut self.password_cache,
        };
        if !cache.contains_key(config) {
            let compiled = Self::build_regex(config);
            cache.insert(config.to_string(), compiled);
        }
        cache.get(config)?.as_ref()
    }

    fn build_regex(config: &str) -> Option<Regex> {
        let doc: Value = serde_json::from_str(config).ok()?;
        if doc.get(PROP_TEXT_PATTERN)?.as_str()?.is_empty() {
            return None; // pattern 空 → None
        }
        let pattern = doc.get(PROP_TEXT_PATTERN)?.as_str()?.to_string();
        let match_case = doc.get(PROP_TEXT_MATCH_CASE).and_then(|v| v.as_bool()).unwrap_or(false);
        let match_regex = doc.get(PROP_TEXT_MATCH_REGEX).and_then(|v| v.as_bool()).unwrap_or(false);
        let whole_word = doc
            .get(PROP_TEXT_MATCH_WHOLE_WORD)
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let body = if match_regex {
            pattern
        } else {
            regex::escape(&pattern) // 字面量模式先转义
        };
        let full = wrap_pattern(&body, whole_word);
        let rx = RegexBuilder::new(&full)
            .case_insensitive(!match_case) // matchCase 取反 = 忽略大小写
            .build()
            .ok()?; // 非法模式 → None
        Some(rx)
    }

    /// 重建缓存：清空（含默认）→ 默认配置 + 每账户自定义配置。
    /// configs = 各 自动登录 的 usernameExpect/passwordExpect JSON（load自动登录s 数据面）。
    pub fn compile_expects(&mut self, part: AccountPart, configs: &[String]) {
        match part {
            AccountPart::Username => self.username_cache.clear(),
            AccountPart::Password => self.password_cache.clear(),
        }
        let default = match part {
            AccountPart::Username => DEFAULT_USERNAME_EXPECT,
            AccountPart::Password => DEFAULT_PASSWORD_EXPECT,
        };
        self.compile(part, default);
        for c in configs {
            self.compile(part, c);
        }
    }

    /// 匹配：任一缓存正则命中即真。空缓存 → false。
    pub fn match_account_expect(&self, part: AccountPart, text: &str) -> bool {
        let cache = match part {
            AccountPart::Username => &self.username_cache,
            AccountPart::Password => &self.password_cache,
        };
        cache.values().flatten().any(|rx| rx.is_match(text))
    }

    /// 捕获组 trigger 的便利暴露（供会话层填充账户部件使用；
    /// 匹配判定本身只回 bool）。
    pub fn find_trigger(&self, part: AccountPart, text: &str) -> Option<String> {
        let cache = match part {
            AccountPart::Username => &self.username_cache,
            AccountPart::Password => &self.password_cache,
        };
        for rx in cache.values().flatten() {
            if let Some(m) = rx.captures(text) {
                if let Some(t) = m.name("trigger") {
                    return Some(t.as_str().to_string());
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map() -> Map<String, Value> {
        Map::new()
    }
    fn portable(s: &str) -> Option<String> {
        Some(s.replace('\\', "/"))
    }

    #[test]
    fn none_method_records_user_any_state() {
        let mut j = map();
        assert!(update_auto_login(&mut j, AUTH_NONE, &json!("alice"), STATE_SUCCESS, "macos", portable));
        assert_eq!(j[PROP_SESSION_USER], json!("alice"));
    }

    #[test]
    fn password_success_stores_and_enables() {
        let mut j = map();
        update_auto_login(&mut j, AUTH_PASSWORD, &json!("s3cret"), STATE_SUCCESS, "macos", portable);
        assert_eq!(j[AUTH_PASSWORD], json!("s3cret"));
        assert_eq!(j[AUTH_PASSWORD_ENABLED], json!(true));
        // PARTIAL(3) 也算成功族（决策表）
        update_auto_login(&mut j, AUTH_PASSWORD, &json!("pw2"), STATE_PARTIAL, "macos", portable);
        assert_eq!(j[AUTH_PASSWORD], json!("pw2"));
    }

    #[test]
    fn password_failure_only_removes_matching() {
        let mut j = map();
        update_auto_login(&mut j, AUTH_PASSWORD, &json!("good"), STATE_SUCCESS, "macos", portable);
        // 尝试值 != 存储值 → 保留；相等才删
        update_auto_login(&mut j, AUTH_PASSWORD, &json!("other"), STATE_DENIED, "macos", portable);
        assert_eq!(j[AUTH_PASSWORD], json!("good"));
        // 相等 → 删两键
        update_auto_login(&mut j, AUTH_PASSWORD, &json!("good"), STATE_DENIED, "macos", portable);
        assert!(!j.contains_key(AUTH_PASSWORD));
        assert!(!j.contains_key(AUTH_PASSWORD_ENABLED));
    }

    #[test]
    fn unknown_state_is_noop_for_non_none() {
        let mut j = map();
        assert!(!update_auto_login(&mut j, AUTH_PASSWORD, &json!("x"), STATE_INFO, "macos", portable));
        assert!(j.is_empty());
        // AGAIN(4)/INFO(2) 均 no-op
        assert!(!update_auto_login(&mut j, AUTH_PASSWORD, &json!("x"), 4, "macos", portable));
    }

    #[test]
    fn publickey_success_normalizes_path_and_keys_by_system() {
        let mut j = map();
        let v = json!(["C:\\Users\\bob\\id_ed25519", "hunter2", "extra"]);
        update_auto_login(&mut j, AUTH_PUBLICKEY, &v, STATE_SUCCESS, "macos", portable);
        let sub = j[AUTH_PUBLICKEY].as_object().unwrap();
        assert_eq!(sub["macos.path"], json!("C:/Users/bob/id_ed25519"));
        assert_eq!(sub["macos.pass"], json!("hunter2"));
    }

    #[test]
    fn publickey_failure_removes_when_mismatch() {
        let mut j = map();
        let v = json!(["/k1", "p1", "x"]);
        update_auto_login(&mut j, AUTH_PUBLICKEY, &v, STATE_SUCCESS, "macos", portable);
        // 失败且本次 path 与存储不同 → 删键 → 空 map → 删方法键
        let v2 = json!(["/k2", "p1", "x"]);
        update_auto_login(&mut j, AUTH_PUBLICKEY, &v2, STATE_DENIED, "macos", portable);
        assert!(!j.contains_key(AUTH_PUBLICKEY));
        // 失败但 path 相同 → 保留
        update_auto_login(&mut j, AUTH_PUBLICKEY, &v, STATE_SUCCESS, "macos", portable);
        update_auto_login(&mut j, AUTH_PUBLICKEY, &v, STATE_DENIED, "macos", portable);
        assert!(j.contains_key(AUTH_PUBLICKEY));
    }

    #[test]
    fn keyboard_interactive_list_and_map_semantics() {
        let mut j = map();
        // 列表值：成功写入，失败无条件删除
        update_auto_login(&mut j, AUTH_KEYBOARD_INTERACTIVE, &json!(["u", "p"]), STATE_SUCCESS, "macos", portable);
        assert_eq!(j[AUTH_KEYBOARD_INTERACTIVE], json!(["u", "p"]));
        update_auto_login(&mut j, AUTH_KEYBOARD_INTERACTIVE, &json!(["x"]), STATE_DENIED, "macos", portable);
        assert!(!j.contains_key(AUTH_KEYBOARD_INTERACTIVE));
        // 映射值：成功 merge；失败按键比对——与新值不同的才删
        update_auto_login(&mut j, AUTH_KEYBOARD_INTERACTIVE, &json!({"a": "1"}), STATE_SUCCESS, "macos", portable);
        update_auto_login(&mut j, AUTH_KEYBOARD_INTERACTIVE, &json!({"b": "2"}), STATE_SUCCESS, "macos", portable);
        assert_eq!(j[AUTH_KEYBOARD_INTERACTIVE], json!({"a": "1", "b": "2"}));
        update_auto_login(&mut j, AUTH_KEYBOARD_INTERACTIVE, &json!({"a": "9"}), STATE_DENIED, "macos", portable);
        assert_eq!(j[AUTH_KEYBOARD_INTERACTIVE], json!({"b": "2"})); // a 不同 → 删
        update_auto_login(&mut j, AUTH_KEYBOARD_INTERACTIVE, &json!({"b": "2"}), STATE_DENIED, "macos", portable);
        assert_eq!(j[AUTH_KEYBOARD_INTERACTIVE], json!({"b": "2"})); // 相同 → 保留
        update_auto_login(&mut j, AUTH_KEYBOARD_INTERACTIVE, &json!({"b": "22"}), STATE_DENIED, "macos", portable);
        assert!(!j.contains_key(AUTH_KEYBOARD_INTERACTIVE)); // 删空 → 移除方法键
    }

    #[test]
    fn auto_login_plan_gates() {
        assert!(plan_auto_login(&map()).is_none()); // 空 json → failed
        let mut j = map();
        j.insert(PROP_SESSION_USER.into(), json!(""));
        assert!(plan_auto_login(&j).is_none()); // 空 user → failed
        j.insert(PROP_SESSION_USER.into(), json!("bob"));
        let (saved, user) = plan_auto_login(&j).unwrap();
        assert_eq!(saved, j);
        assert_eq!(user, b"bob"); // utf8 字节
        assert!(need_ssh_auto_login(&j));
        assert!(!need_ssh_auto_login(&map()));
    }

    #[test]
    fn take_auto_login_injects_fingerprint_unless_onekey() {
        let mut j = map();
        take_auto_login(&mut j, Some("SHA256:abc"));
        assert_eq!(j[PROP_SSH_SERVER_FINGERPRINT], json!("SHA256:abc"));
        let mut j2 = map();
        j2.insert(PROP_SESSION_ONEKEY.into(), json!("uuid-1"));
        take_auto_login(&mut j2, Some("SHA256:zzz"));
        assert!(!j2.contains_key(PROP_SSH_SERVER_FINGERPRINT));
    }

    #[test]
    fn default_username_expect_matches_login_prompts() {
        let mut m = AutoLoginExpect::default();
        m.compile(AccountPart::Username, DEFAULT_USERNAME_EXPECT);
        assert!(m.match_account_expect(AccountPart::Username, "login: "));
        assert!(m.match_account_expect(AccountPart::Username, "Username:")); // 默认大小写不敏感
        assert!(m.match_account_expect(AccountPart::Username, "CentOS release 7 login:"));
        assert!(!m.match_account_expect(AccountPart::Username, "goodbye"));
    }

    #[test]
    fn default_password_expect_matches_password_for_user() {
        let mut m = AutoLoginExpect::default();
        m.compile(AccountPart::Password, DEFAULT_PASSWORD_EXPECT);
        assert!(m.match_account_expect(AccountPart::Password, "Password:"));
        assert!(m.match_account_expect(AccountPart::Password, "password for bob:"));
        assert!(!m.match_account_expect(AccountPart::Password, "pass"));
    }

    #[test]
    fn literal_mode_escapes_and_anchors_end_of_line() {
        let mut m = AutoLoginExpect::default();
        let cfg = "{\"text.matchRegex\":false,\"text.pattern\":\"pass.word\"}";
        m.compile(AccountPart::Password, cfg);
        assert!(m.match_account_expect(AccountPart::Password, "pass.word ")); // 字面量非通配
        assert!(!m.match_account_expect(AccountPart::Password, "passXword"));
    }

    #[test]
    fn whole_word_mode_uses_word_boundaries() {
        let mut m = AutoLoginExpect::default();
        let cfg = "{\"text.matchRegex\":false,\"text.pattern\":\"login\",\"text.matchWholeWord\":true}";
        m.compile(AccountPart::Username, cfg);
        assert!(m.match_account_expect(AccountPart::Username, "login:"));
        assert!(!m.match_account_expect(AccountPart::Username, "mylogin:")); // \b 生效
    }

    #[test]
    fn match_case_option_toggles_insensitivity() {
        let mut m = AutoLoginExpect::default();
        let cfg = "{\"text.matchRegex\":true,\"text.pattern\":\"LOGIN:\",\"text.matchCase\":true}";
        m.compile(AccountPart::Username, cfg);
        assert!(!m.match_account_expect(AccountPart::Username, "login:"));
        assert!(m.match_account_expect(AccountPart::Username, "LOGIN:"));
    }

    #[test]
    fn invalid_configs_compile_to_none_and_are_cached() {
        let mut m = AutoLoginExpect::default();
        assert!(m.compile(AccountPart::Password, "").is_none());
        assert!(m.compile(AccountPart::Password, "not json").is_none());
        assert!(m.compile(AccountPart::Password, "{\"text.pattern\":\"\"}").is_none());
        assert!(m.compile(AccountPart::Password, "{\"text.matchRegex\":true,\"text.pattern\":\"(\"}").is_none());
    }

    #[test]
    fn compile_expects_rebuilds_cache_with_defaults_and_customs() {
        let mut m = AutoLoginExpect::default();
        let custom = "{\"text.matchRegex\":true,\"text.pattern\":\"OTP \\\\d+:\"}".to_string();
        m.compile_expects(AccountPart::Password, std::slice::from_ref(&custom));
        assert!(m.match_account_expect(AccountPart::Password, "Password:")); // 默认仍在
        assert!(m.match_account_expect(AccountPart::Password, "OTP 123:")); // 自定义生效
        m.compile_expects(AccountPart::Password, &[]); // 重建清空
        assert!(!m.match_account_expect(AccountPart::Password, "OTP 123:"));
    }

    #[test]
    fn trigger_capture_group_exposed() {
        let mut m = AutoLoginExpect::default();
        m.compile(AccountPart::Username, DEFAULT_USERNAME_EXPECT);
        // "login: bob" → 包装组 (?<trigger>\S*) 捕获提示符后尾 token
        assert_eq!(m.find_trigger(AccountPart::Username, "login: bob").as_deref(), Some("bob"));
        // 贪婪行为："password: " 后无尾 token → 空串捕获
        m.compile(AccountPart::Password, DEFAULT_PASSWORD_EXPECT);
        assert_eq!(m.find_trigger(AccountPart::Password, "password:").as_deref(), Some(""));
    }
}
