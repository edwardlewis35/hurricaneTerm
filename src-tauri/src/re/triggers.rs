//! 触发器引擎
//!
//! 语义要点：
//! 1. rule_id == rules 表的全局下标；扫描任务以同一 id 索引规则表。
//! 2. 规则编译只收可执行者；空 pattern 丢弃；非正则模式走 escape（字面量子串）。
//! 3. Highlight/PlaySound（{8,9}）从 settings["value"] 数组展开多条规则；其余类型 settings 即单规则。
//! 4. TriggerData.action 仅对 {1..5} 有意义（执行分派用）；{9,10,11} 执行期直接按 rule.type 走专用分支。
//! 5. 连接触发不进全局规则表（执行时现场用 settings 构造临时规则）。
//! 6. condition 缺省 = 2（LinePrompt），delay 单位为毫秒（JSON 里是秒）。
//! 7. 集合更新的"内容变更重编译"按"删除=移除或变更、编译=新增或变更"超集实现。
//! 8. 匹配标志取常规等价语义：默认忽略大小写、matchCase 关闭忽略、matchWholeWord 以 \b 包裹。

use std::collections::{BTreeMap, BTreeSet};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Settings = BTreeMap<String, Value>;

/// 触发器类型；7 在显示表中缺失，expect 面 7/11 仅通知
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(i64)]
pub enum TriggerType {
    None = 0,
    AfterConnection = 1,
    AfterDisconnection = 2,
    BeforeConnection = 3,
    BeforeDisconnection = 4,
    CustomLink = 5,
    CustomMenu = 6,
    /// 显示表缺失项；expect 引擎按"仅通知"处理
    Reserved7 = 7,
    HighlightText = 8,
    PlaySound = 9,
    RunCommand = 10,
    SendText = 11,
    ShowTooltip = 12,
}

impl TriggerType {
    /// 显示名表（无 7 项）
    pub fn display_name(self) -> Option<&'static str> {
        Some(match self {
            TriggerType::AfterConnection => "Event: after connection",
            TriggerType::AfterDisconnection => "Event: after disconnection",
            TriggerType::BeforeConnection => "Event: before connection",
            TriggerType::BeforeDisconnection => "Event: before disconnection",
            TriggerType::CustomLink => "Custom link",
            TriggerType::CustomMenu => "Custom menu",
            TriggerType::HighlightText => "Highlight text",
            TriggerType::PlaySound => "Play sound",
            TriggerType::RunCommand => "Run command",
            TriggerType::SendText => "Send text",
            TriggerType::ShowTooltip => "Show tooltip",
            TriggerType::None | TriggerType::Reserved7 => return None,
        })
    }

    pub fn from_display_name(name: &str) -> Option<TriggerType> {
        [
            TriggerType::AfterConnection,
            TriggerType::AfterDisconnection,
            TriggerType::BeforeConnection,
            TriggerType::BeforeDisconnection,
            TriggerType::CustomLink,
            TriggerType::CustomMenu,
            TriggerType::HighlightText,
            TriggerType::PlaySound,
            TriggerType::RunCommand,
            TriggerType::SendText,
            TriggerType::ShowTooltip,
        ]
        .into_iter()
        .find(|t| t.display_name() == Some(name))
    }

    /// 连接触发类型判定：(t-1)<4
    pub fn is_connection(self) -> bool {
        matches!(
            self,
            TriggerType::AfterConnection
                | TriggerType::AfterDisconnection
                | TriggerType::BeforeConnection
                | TriggerType::BeforeDisconnection
        )
    }

    pub fn from_i64(v: i64) -> TriggerType {
        match v {
            1 => TriggerType::AfterConnection,
            2 => TriggerType::AfterDisconnection,
            3 => TriggerType::BeforeConnection,
            4 => TriggerType::BeforeDisconnection,
            5 => TriggerType::CustomLink,
            6 => TriggerType::CustomMenu,
            7 => TriggerType::Reserved7,
            8 => TriggerType::HighlightText,
            9 => TriggerType::PlaySound,
            10 => TriggerType::RunCommand,
            11 => TriggerType::SendText,
            12 => TriggerType::ShowTooltip,
            _ => TriggerType::None,
        }
    }
}

/// 触发动作表
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i64)]
pub enum TriggerAction {
    None = 0,
    OpenHyperlink = 1,
    PlaySound = 2,
    RunCommand = 3,
    SendText = 4,
}

impl TriggerAction {
    pub fn from_name(name: &str) -> Option<i64> {
        Some(match name {
            "Open hyperlink" => 1,
            "Play sound" => 2,
            "Run command" => 3,
            "Send text" => 4,
            _ => return None,
        })
    }
}

/// 触发条件取值；condition 缺省 2
pub const COND_NO: i64 = 0;
pub const COND_LINE_FEED: i64 = 1;
pub const COND_LINE_PROMPT: i64 = 2;

fn condition_from_name(name: &str) -> Option<i64> {
    Some(match name {
        "NoCondition" => COND_NO,
        "LineFeedCondition" => COND_LINE_FEED,
        "LinePromptCondition" => COND_LINE_PROMPT,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// JSON 值宽松转换语义近似（toString/toBool 行为）
// ---------------------------------------------------------------------------

/// null→""；字符串原样；数字/布尔按文本形式
pub fn variant_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(_) | Value::Object(_) => String::new(),
    }
}

/// null/0/"0"/"false"→假；字符串非空且非 "0"/"false"→真
pub fn variant_to_bool(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => {
            let l = s.to_lowercase();
            !l.is_empty() && l != "0" && l != "false"
        }
        _ => true,
    }
}

/// 宽松转 f64；失败→0.0
pub fn variant_to_f64(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.trim().parse::<f64>().unwrap_or(0.0),
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

fn settings_str<'a>(s: &'a Settings, key: &str) -> Option<&'a Value> {
    s.get(key)
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/// 触发器实体；未序列化缓存字段不建模
#[derive(Debug, Clone, PartialEq)]
pub struct Trigger {
    pub name: String,
    pub uuid: String,
    pub description: String,
    pub enabled: bool,
    /// 参与 ==、不序列化
    pub dynamic: bool,
    pub r#type: TriggerType,
    pub settings: Settings,
    /// 会话 uuid → 布尔
    pub target_sessions: BTreeMap<String, bool>,
    /// 系统名集合
    pub target_systems: BTreeSet<String>,
}

impl Default for Trigger {
    /// 默认构造：enabled=false、type=None、settings 空、表空
    fn default() -> Self {
        Self {
            name: String::new(),
            uuid: String::new(),
            description: String::new(),
            enabled: false,
            dynamic: false,
            r#type: TriggerType::None,
            settings: Settings::new(),
            target_sessions: BTreeMap::new(),
            target_systems: BTreeSet::new(),
        }
    }
}

impl Trigger {
    /// 带参构造：enabled/dynamic=true；uuid 空且 type≠0 → 生成 v4；
    /// type∈{5,6,12} → 默认装饰 settings
    pub fn new(r#type: TriggerType, name: &str, uuid: &str) -> Self {
        let mut t = Trigger {
            name: name.into(),
            uuid: uuid.into(),
            enabled: true,
            dynamic: true,
            r#type,
            ..Default::default()
        };
        if t.r#type != TriggerType::None && t.uuid.is_empty() {
            t.uuid = uuid::Uuid::new_v4().to_string();
        }
        if matches!(
            t.r#type,
            TriggerType::CustomLink | TriggerType::CustomMenu | TriggerType::ShowTooltip
        ) {
            t.settings.insert(
                "text.lineStyle".into(),
                // 占位样式值，不参与匹配
                Value::String("linebackground".into()),
            );
            t.settings.insert(
                "text.lineColor".into(),
                Value::String("terminal.ansiBrightBlack".into()),
            );
        }
        t
    }

    /// 重置为新的 v4 uuid
    pub fn reset_uuid(&mut self) {
        self.uuid = uuid::Uuid::new_v4().to_string();
    }

    /// 会话匹配判定。session_system: uuid→系统名（由宿主注入）
    pub fn has_session<F: Fn(&str) -> Option<String>>(
        &self,
        session: &str,
        match_all: bool,
        session_system: &F,
    ) -> bool {
        if session.is_empty() {
            return false;
        }
        if match_all && !self.target_sessions.is_empty() {
            if let Some(v) = self.target_sessions.get(session) {
                return *v;
            }
        }
        if self.target_systems.contains("*") {
            return true;
        }
        match session_system(session) {
            Some(sys) => self.target_systems.contains(&sys),
            None => false,
        }
    }

    /// 系统匹配判定
    pub fn has_system(&self, system: &str) -> bool {
        self.target_systems.contains("*") || self.target_systems.contains(system)
    }

    /// 设置目标会话：与系统级判定一致时**删除**条目（去冗余）
    pub fn set_target_session<F: Fn(&str) -> Option<String>>(
        &mut self,
        session: &str,
        value: bool,
        session_system: &F,
    ) {
        if session.is_empty() {
            return;
        }
        if self.has_session(session, false, session_system) == value {
            self.target_sessions.remove(session);
        } else {
            self.target_sessions.insert(session.into(), value);
        }
    }

    /// 设置目标系统集合
    pub fn set_target_systems(&mut self, systems: BTreeSet<String>) {
        self.target_systems = systems;
    }
}

// ---------------------------------------------------------------------------
// TriggerData / TriggerRule
// ---------------------------------------------------------------------------

/// TriggerData：settings 视图 + 派生 action；装饰信息仅保留在原始 settings 中
#[derive(Debug, Clone, PartialEq)]
pub struct TriggerData {
    pub settings: Settings,
    pub action: i64,
}

impl TriggerData {
    /// 构造时 action 推导：
    /// type>12→0；{1..4}→查找（缺省 3）；{5,6,8,12}→装饰后 type>5→0、type==5→查找；{7,9,10,11}→0
    pub fn new(r#type: TriggerType, settings: &Settings) -> Self {
        let tv = r#type as i64;
        let action = if tv > 12 {
            0
        } else if r#type.is_connection() {
            lookup_action(settings)
        } else if matches!(
            r#type,
            TriggerType::CustomLink
                | TriggerType::CustomMenu
                | TriggerType::HighlightText
                | TriggerType::ShowTooltip
        ) {
            if tv > 5 {
                0
            } else {
                lookup_action(settings)
            }
        } else {
            0
        };
        Self {
            settings: settings.clone(),
            action,
        }
    }

    fn get(&self, key: &str) -> &Value {
        static NULL: Value = Value::Null;
        settings_str(&self.settings, key).unwrap_or(&NULL)
    }

    /// condition：settings["condition"] 名→值；缺省/未知名 → 2
    pub fn condition(&self) -> i64 {
        let name = variant_to_string(self.get("condition"));
        condition_from_name(&name).unwrap_or(COND_LINE_PROMPT)
    }

    /// delay：秒→毫秒（*1000 截断）
    pub fn delay_ms(&self) -> i64 {
        (variant_to_f64(self.get("delay")) * 1000.0) as i64
    }

    /// 是否声明带脚本
    pub fn has_script(&self) -> bool {
        variant_to_bool(self.get("script"))
    }

    /// 是否需要隐藏 shell 窗口
    pub fn need_hide_shell_window(&self) -> bool {
        variant_to_bool(self.get("hideShellWindow"))
    }

    /// 待执行命令
    pub fn process_command(&self) -> String {
        variant_to_string(self.get("command"))
    }

    /// 命令参数（按命令行切分）
    pub fn process_arguments(&self) -> Vec<String> {
        split_command_line(&variant_to_string(self.get("arguments")))
    }

    /// 工作目录
    pub fn process_working_directory(&self) -> String {
        variant_to_string(self.get("workingDirectory"))
    }

    /// 声音资源路径
    pub fn sound(&self) -> String {
        variant_to_string(self.get("sound"))
    }

    /// 文本：settings["text"]；!has_script 时做 %N 捕获替换（JS 脚本面不移植）。
    /// captures[0]=整匹配，captures[1..]=组
    pub fn text(&self, captures: &[String]) -> String {
        let raw = variant_to_string(self.get("text"));
        if raw.is_empty() || self.has_script() {
            return raw;
        }
        substitute_percent(&raw, captures)
    }

    /// 可执行判定：action 1/4→text 非空；3→command 非空；其余→真
    pub fn is_executable(&self) -> bool {
        match self.action {
            1 | 4 => !variant_to_string(self.get("text")).is_empty(),
            3 => !self.process_command().is_empty(),
            _ => true,
        }
    }
}

fn lookup_action(settings: &Settings) -> i64 {
    let name = variant_to_string(settings_str(settings, "action").unwrap_or(&Value::Null));
    TriggerAction::from_name(&name).unwrap_or(3) // 表缺省 3（兜底）
}

/// %N 替换（%1..%9；%0=整匹配；越界→空串）
pub fn substitute_percent(tpl: &str, captures: &[String]) -> String {
    let mut out = String::with_capacity(tpl.len());
    let bytes = tpl.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 1 < bytes.len() && (b'0'..=b'9').contains(&bytes[i + 1]) {
            let n = (bytes[i + 1] - b'0') as usize;
            out.push_str(captures.get(n).map(|s| s.as_str()).unwrap_or(""));
            i += 2;
        } else {
            // UTF-8 安全：按 char 推进
            let ch = tpl[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// TriggerRule：type + regex + data + uuid
#[derive(Debug, Clone)]
pub struct TriggerRule {
    pub r#type: TriggerType,
    pub regex: Option<Regex>,
    pub data: TriggerData,
    pub uuid: String,
}

/// 规则编译。返回 None = 空 pattern 或非可执行（不入库）
pub fn compile_rule(trigger: &Trigger, rule_map: &Settings) -> Option<TriggerRule> {
    let pattern = variant_to_string(rule_map.get("text.pattern").unwrap_or(&Value::Null));
    if pattern.is_empty() {
        return None;
    }
    let match_regex = rule_map
        .get("text.matchRegex")
        .map(variant_to_bool)
        .unwrap_or(false);
    let match_case = rule_map
        .get("text.matchCase")
        .map(variant_to_bool)
        .unwrap_or(false);
    let whole_word = rule_map
        .get("text.matchWholeWord")
        .map(variant_to_bool)
        .unwrap_or(false);

    let body = if match_regex {
        pattern.clone()
    } else {
        regex::escape(&pattern)
    };
    // 匹配标志取常规等价语义（默认忽略大小写；whole word 以 \b 包裹）
    let mut src = String::new();
    if !match_case {
        src.push_str("(?i)");
    }
    if whole_word {
        src.push_str(r"(?:\b(?:");
        src.push_str(&body);
        src.push_str(r")\b)");
    } else {
        src.push_str(&body);
    }
    let regex = Regex::new(&src).ok()?;

    let data = TriggerData::new(trigger.r#type, rule_map);
    if !data.is_executable() {
        return None; // 仅可执行规则入库
    }
    Some(TriggerRule {
        r#type: trigger.r#type,
        regex: Some(regex),
        data,
        uuid: trigger.uuid.clone(),
    })
}

// ---------------------------------------------------------------------------
// 文本/命令行辅助
// ---------------------------------------------------------------------------

/// 终端转义串解析
pub fn parse_escaped_string(s: &str) -> String {
    let mut out: Vec<u8> = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c != '\\' || i + 1 >= chars.len() {
            let mut b = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
            i += 1;
            continue;
        }
        let n = chars[i + 1];
        let mut consumed = 2usize;
        match n {
            '0' => {
                out.push(0);
                // 仅产 NUL，consumed=2（不吞后续八进制位）
            }
            '\\' => out.push(b'\\'),
            'a' => out.push(0x07),
            'b' => out.push(0x08),
            'f' => out.push(0x0c),
            'n' => out.push(b'\n'),
            'r' => out.push(b'\r'),
            't' => out.push(b'\t'),
            'v' => out.push(0x0b),
            'c' => {
                // \cX：大写后 ∈@A-Z[\]^_ → X-0x40；\c- → 0x7f
                if let Some(&x) = chars.get(i + 2) {
                    if x == '-' {
                        out.push(0x7f);
                        consumed = 3;
                    } else {
                        let up = x.to_ascii_uppercase();
                        if (0x40..=0x5f).contains(&(up as u32)) {
                            out.push(up as u8 - 0x40);
                        } else {
                            // 不合法：原样
                            out.push(b'\\');
                            out.push(b'c');
                        }
                        consumed = 3;
                    }
                } else {
                    consumed = 2;
                    out.push(b'\\');
                    out.push(b'c');
                }
            }
            'm' => {
                if let Some(&x) = chars.get(i + 2) {
                    let b0 = x as u32;
                    if b0 <= 0x7f {
                        // 0x80|X：按码点编码
                        if let Some(ch) = char::from_u32(b0 | 0x80) {
                            let mut b = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut b).as_bytes());
                        }
                    } else {
                        out.push(b'\\');
                        out.push(b'm');
                        let mut b = [0u8; 4];
                        out.extend_from_slice(x.encode_utf8(&mut b).as_bytes());
                    }
                    consumed = 3;
                } else {
                    consumed = 2;
                    out.push(b'\\');
                    out.push(b'm');
                }
            }
            'u' | 'x' => {
                // 读后续十六进制数字（\u 4 位、\x 2 位，宽松）
                let radix = 16;
                let mut j = i + 2;
                let mut val: u32 = 0;
                let mut cnt = 0;
                while j < chars.len() && cnt < if n == 'u' { 4 } else { 2 } {
                    if let Some(d) = chars[j].to_digit(radix) {
                        val = val * 16 + d;
                        j += 1;
                        cnt += 1;
                    } else {
                        break;
                    }
                }
                if cnt == 0 {
                    out.push(b'\\');
                    out.push(n as u8);
                    consumed = 2;
                } else {
                    // 十六进制值 → 码点
                    if let Some(ch) = char::from_u32(val) {
                        let mut b = [0u8; 4];
                        out.extend_from_slice(ch.encode_utf8(&mut b).as_bytes());
                    }
                    consumed = j - i;
                }
            }
            _ => {
                // 未知转义原样保留
                out.push(b'\\');
                let mut b = [0u8; 4];
                out.extend_from_slice(n.encode_utf8(&mut b).as_bytes());
                consumed = 2;
            }
        }
        i += consumed;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 命令行切分：空白分词 + ' " 引号；无转义
pub fn split_command_line(s: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has = false;
    for c in s.chars() {
        let ws = match quote {
            None => c.is_whitespace(),
            Some(_) => false,
        };
        if ws {
            if has {
                tokens.push(std::mem::take(&mut cur));
                has = false;
            }
            continue;
        }
        if c == '\'' || c == '"' {
            if quote == Some(c) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(c);
                has = true;
            } else {
                cur.push(c);
            }
            continue;
        }
        cur.push(c);
        has = true;
    }
    if has {
        tokens.push(cur);
    }
    tokens
}

// ---------------------------------------------------------------------------
// 执行面 sink
// ---------------------------------------------------------------------------

/// 规则执行的外部效应接口（UI/进程/网络面交宿主实现）
pub trait TriggerSink {
    fn open_url(&mut self, url: &str);
    fn play_sound(&mut self, sound: &str);
    /// 分离启动进程：返回成功与否
    fn start_process_detached(
        &mut self,
        program: &str,
        args: &[String],
        cwd: &str,
        hide_window: bool,
    ) -> bool;
    /// 转义解析后写入终端
    fn send_text(&mut self, text: &str);
    /// 以 name/body 上报错误
    fn report_error(&mut self, name: &str, body: &str);
    /// 当前会话是否有终端控件（type 11/4 动作必需）
    fn has_widget(&self) -> bool;
}

// ---------------------------------------------------------------------------
// TriggerManager
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct TriggerManager {
    loaded: bool,
    /// 位表（下标=TriggerType）
    bits: Vec<bool>,
    rules: Vec<TriggerRule>,
    triggers: Vec<Trigger>,
}

/// 触发器集合更新结果（供宿主做每窗口 diff/刷新）
#[derive(Debug, Default, PartialEq)]
pub struct SetTriggersResult {
    pub changed: bool,
    pub removed_uuids: Vec<String>,
    pub added_uuids: Vec<String>,
    pub rules_len: usize,
}

impl TriggerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    pub fn triggers(&self) -> &[Trigger] {
        &self.triggers
    }

    pub fn trigger_rules(&self) -> &[TriggerRule] {
        &self.rules
    }

    /// 按全局下标取规则：越界→None
    pub fn trigger_rule(&self, i: i64) -> Option<&TriggerRule> {
        if i < 0 {
            return None;
        }
        self.rules.get(i as usize)
    }

    /// 按 uuid 查找 trigger：未命中/空 uuid 返回 None
    pub fn trigger_from_uuid(&self, uuid: &str) -> Option<&Trigger> {
        if uuid.is_empty() {
            return None;
        }
        self.triggers.iter().find(|t| t.uuid == uuid)
    }

    pub fn trigger_bits(&self) -> &[bool] {
        &self.bits
    }

    pub fn has_enabled_type(&self, t: TriggerType) -> bool {
        let i = t as usize;
        i < self.bits.len() && self.bits[i]
    }

    /// 重建位表：全 false 后由 enabled trigger 置 bit[type]
    pub fn update_trigger_bits(&mut self) {
        let size = self
            .triggers
            .iter()
            .map(|t| t.r#type as usize)
            .max()
            .map(|m| m + 1)
            .unwrap_or(0);
        self.bits = vec![false; size.max(13)];
        for t in &self.triggers {
            if t.enabled {
                let i = t.r#type as usize;
                if i < self.bits.len() {
                    self.bits[i] = true;
                }
            }
        }
    }

    /// 编译并入库规则：enabled 门；{8,9} 从 settings["value"] 数组展开
    pub fn add_trigger_rule(&mut self, trigger: &Trigger, _flag: bool) {
        if !trigger.enabled {
            return;
        }
        let expanded = (trigger.r#type as i64) & !1 == 8; // {8,9}
        if expanded {
            if let Some(Value::Array(list)) = trigger.settings.get("value") {
                for item in list {
                    if let Value::Object(_) = item {
                        let map = value_to_settings(item);
                        if let Some(rule) = compile_rule(trigger, &map) {
                            self.rules.push(rule);
                        }
                    }
                }
            }
        } else if let Some(rule) = compile_rule(trigger, &trigger.settings) {
            self.rules.push(rule);
        }
    }

    /// 加载：先 (userPath,true)→append，
    /// 再 (defaultPath,false)→按下标 insert（默认最终占前位）；按 uuid 去重——**先载入者（user）优先**；
    /// loaded 门（重复调用直接返回）
    pub fn load_triggers(&mut self, default_json: &str, user_json: &str) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        let mut seen: BTreeSet<String> = BTreeSet::new();
        // 调用序：user 先 append，default 后 insert
        for t in parse_triggers(user_json) {
            if seen.insert(t.uuid.clone()) {
                self.triggers.push(t);
            }
        }
        let mut idx = 0usize;
        for t in parse_triggers(default_json) {
            if seen.insert(t.uuid.clone()) {
                self.triggers.insert(idx, t);
                idx += 1;
            }
        }
        let snapshot = self.triggers.clone();
        for t in snapshot {
            self.add_trigger_rule(&t, true);
        }
        self.update_trigger_bits();
    }

    /// 更新触发器集合：变更触发（同 uuid 不同内容）按删除+重编译的超集处理
    pub fn set_triggers(&mut self, triggers: Vec<Trigger>) -> SetTriggersResult {
        let mut res = SetTriggersResult::default();
        // 无变化门
        if self.triggers == triggers {
            return res; // changed=false
        }
        res.changed = true;
        let new_uuids: BTreeSet<String> = triggers.iter().map(|t| t.uuid.clone()).collect();
        let old: BTreeMap<String, Trigger> =
            self.triggers.iter().map(|t| (t.uuid.clone(), t.clone())).collect();

        // 删除：uuid 不在新集合，或内容变更
        let doomed: BTreeSet<String> = triggers
            .iter()
            .filter(|t| old.get(&t.uuid).map(|o| o != *t).unwrap_or(false))
            .map(|t| t.uuid.clone())
            .chain(
                self.triggers
                    .iter()
                    .map(|t| t.uuid.clone())
                    .filter(|u| !new_uuids.contains(u)),
            )
            .collect();
        let before_len = self.rules.len();
        self.rules.retain(|r| !doomed.contains(&r.uuid));
        res.removed_uuids = doomed.iter().cloned().collect();

        // 编译：新 uuid 或内容变更
        for t in &triggers {
            let need = match old.get(&t.uuid) {
                None => true,
                Some(o) => o != t,
            };
            if need {
                self.add_trigger_rule(t, false);
                res.added_uuids.push(t.uuid.clone());
            }
        }
        let _ = before_len;
        self.triggers = triggers;
        self.update_trigger_bits();
        res.rules_len = self.rules.len();
        res
    }

    /// 会话可见 trigger 的 uuid 列表：enabled && (include_connection || !is_connection)
    /// && has_session(match_all=true) → uuid 列表（保持列表序）
    pub fn session_triggers<F: Fn(&str) -> Option<String>>(
        &self,
        session: &str,
        include_connection: bool,
        session_system: &F,
    ) -> Vec<String> {
        self.triggers
            .iter()
            .filter(|t| {
                (include_connection || !t.r#type.is_connection())
                    && t.enabled
                    && t.has_session(session, true, session_system)
            })
            .map(|t| t.uuid.clone())
            .collect()
    }

    /// 执行规则：rule_idx = 全局规则下标
    pub fn execute_trigger_rule<S: TriggerSink>(
        &self,
        rule_idx: i64,
        captures: &[String],
        sink: &mut S,
    ) {
        let rule = match self.trigger_rule(rule_idx) {
            Some(r) => r,
            None => return,
        };
        self.execute_rule(rule, captures, sink);
    }

    /// 规则执行核心（供全局规则与连接触发临时规则共用）
    pub fn execute_rule<S: TriggerSink>(&self, rule: &TriggerRule, captures: &[String], sink: &mut S) {
        if !rule.data.is_executable() {
            return; // is_executable 门
        }
        let t = rule.r#type;
        if t.is_connection() || t == TriggerType::CustomLink {
            match rule.data.action {
                1 => sink.open_url(&rule.data.text(captures)),
                2 => sink.play_sound(&rule.data.sound()),
                3 => {
                    let ok = sink.start_process_detached(
                        &rule.data.process_command(),
                        &rule.data.process_arguments(),
                        &rule.data.process_working_directory(),
                        rule.data.need_hide_shell_window(),
                    );
                    if !ok {
                        let name = self
                            .trigger_from_uuid(&rule.uuid)
                            .map(|x| x.name.clone())
                            .unwrap_or_default();
                        sink.report_error(&name, &rule.data.process_command());
                    }
                }
                4 => {
                    // 仅 type==11 继续；连接/CustomLink 的 action4 走同分支但被 type 门挡下
                    if t == TriggerType::SendText && sink.has_widget() {
                        sink.send_text(&parse_escaped_string(&rule.data.text(captures)));
                    }
                }
                _ => {}
            }
            return;
        }
        match t {
            TriggerType::PlaySound => sink.play_sound(&rule.data.sound()),
            TriggerType::RunCommand => {
                let ok = sink.start_process_detached(
                    &rule.data.process_command(),
                    &rule.data.process_arguments(),
                    &rule.data.process_working_directory(),
                    rule.data.need_hide_shell_window(),
                );
                if !ok {
                    let name = self
                        .trigger_from_uuid(&rule.uuid)
                        .map(|x| x.name.clone())
                        .unwrap_or_default();
                    sink.report_error(&name, &rule.data.process_command());
                }
            }
            TriggerType::SendText => {
                if sink.has_widget() {
                    sink.send_text(&parse_escaped_string(&rule.data.text(captures)));
                }
            }
            _ => {} // {6,7,8,12} 与 default → 无动作（编辑层/菜单面）
        }
    }

    /// 连接触发执行：bit 门 + 现场临时规则
    pub fn execute_connection_trigger<S: TriggerSink, F: Fn(&str) -> Option<String>>(
        &self,
        t: TriggerType,
        session: &str,
        session_system: &F,
        sink: &mut S,
    ) {
        if !self.has_enabled_type(t) {
            return;
        }
        for trig in &self.triggers {
            if trig.r#type == t && trig.enabled && trig.has_session(session, true, session_system) {
                let rule = TriggerRule {
                    r#type: t,
                    regex: None,
                    data: TriggerData::new(t, &trig.settings),
                    uuid: trig.uuid.clone(),
                };
                self.execute_rule(&rule, &[], sink);
            }
        }
    }

    /// 文本匹配扫描：
    /// 对给定 uuid 集合的规则扫描文本，返回 (rule_id, captures)（rule_id=全局下标）
    pub fn match_output(&self, allowed_uuids: &BTreeSet<String>, text: &str) -> Vec<MatchHit> {
        let mut hits = Vec::new();
        for (id, rule) in self.rules.iter().enumerate() {
            if !allowed_uuids.contains(&rule.uuid) {
                continue;
            }
            if let Some(re) = &rule.regex {
                if let Some(caps) = re.captures(text) {
                    let full = caps.get(0).map(|x| x.as_str().to_string()).unwrap_or_default();
                    let captures: Vec<String> = (0..caps.len())
                        .map(|g| {
                            if g == 0 {
                                full.clone()
                            } else {
                                caps.get(g).map(|x| x.as_str().to_string()).unwrap_or_default()
                            }
                        })
                        .collect();
                    hits.push(MatchHit {
                        rule_id: id as i64,
                        uuid: rule.uuid.clone(),
                        captures,
                    });
                }
            }
        }
        hits
    }

    /// 序列化 trigger 列表 → JSON 字符串
    pub fn save_triggers(&self) -> String {
        let arr: Vec<Value> = self
            .triggers
            .iter()
            .map(|t| {
                let mut obj = serde_json::Map::new();
                obj.insert("name".into(), Value::String(t.name.clone()));
                obj.insert("uuid".into(), Value::String(t.uuid.clone()));
                obj.insert(
                    "type".into(),
                    Value::String(t.r#type.display_name().unwrap_or("").to_string()),
                );
                obj.insert("enabled".into(), Value::Bool(t.enabled));
                obj.insert("description".into(), Value::String(t.description.clone()));
                obj.insert(
                    "targetSessions".into(),
                    serde_json::Value::Object(
                        t.target_sessions
                            .iter()
                            .map(|(k, v)| (k.clone(), Value::Bool(*v)))
                            .collect(),
                    ),
                );
                obj.insert(
                    "targetSystems".into(),
                    Value::Array(t.target_systems.iter().cloned().map(Value::String).collect()),
                );
                obj.insert("settings".into(), settings_to_value(&t.settings));
                Value::Object(obj)
            })
            .collect();
        serde_json::to_string(&arr).unwrap_or_else(|_| "[]".into())
    }
}

/// match_output 命中项
#[derive(Debug, Clone, PartialEq)]
pub struct MatchHit {
    pub rule_id: i64,
    pub uuid: String,
    pub captures: Vec<String>,
}

pub fn value_to_settings(v: &Value) -> Settings {
    match v {
        Value::Object(map) => map
            .iter()
            .map(|(k, val)| (k.clone(), val.clone()))
            .collect(),
        _ => Settings::new(),
    }
}

pub fn settings_to_value(s: &Settings) -> Value {
    Value::Object(s.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// 单条 trigger 解析：type 名→枚举；缺字段取默认
pub fn parse_trigger(v: &Value) -> Option<Trigger> {
    let obj = v.as_object()?;
    let get = |k: &str| obj.get(k);
    let type_name = get("type").map(variant_to_string).unwrap_or_default();
    let r#type = TriggerType::from_display_name(&type_name).unwrap_or(TriggerType::None);
    let mut t = Trigger {
        name: get("name").map(variant_to_string).unwrap_or_default(),
        uuid: get("uuid").map(variant_to_string).unwrap_or_default(),
        description: get("description").map(variant_to_string).unwrap_or_default(),
        enabled: get("enabled").map(variant_to_bool).unwrap_or(false),
        dynamic: false,
        r#type,
        settings: get("settings").map(value_to_settings).unwrap_or_default(),
        target_sessions: match get("targetSessions") {
            Some(Value::Object(m)) => m
                .iter()
                .map(|(k, val)| (k.clone(), variant_to_bool(val)))
                .collect(),
            _ => BTreeMap::new(),
        },
        target_systems: match get("targetSystems") {
            Some(Value::Array(a)) => a.iter().map(|x| variant_to_string(x)).collect(),
            _ => BTreeSet::new(),
        },
    };
    if t.r#type != TriggerType::None && t.uuid.is_empty() {
        t.reset_uuid(); // 带参构造语义：uuid 空且 type≠0 → 生成
    }
    Some(t)
}

pub fn parse_triggers(json: &str) -> Vec<Trigger> {
    match serde_json::from_str::<Value>(json) {
        Ok(Value::Array(arr)) => arr.iter().filter_map(parse_trigger).collect(),
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// 测试（用例覆盖以下行为）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn sys(_s: &str) -> Option<String> {
        None
    }

    fn sys_map<'a>(m: Vec<(&'a str, &'a str)>) -> impl Fn(&str) -> Option<String> + 'a {
        move |s: &str| m.iter().find(|(k, _)| *k == s).map(|(_, v)| v.to_string())
    }

    #[derive(Default)]
    struct Recorder {
        events: RefCell<Vec<String>>,
        widget: bool,
    }
    impl TriggerSink for Recorder {
        fn open_url(&mut self, url: &str) {
            self.events.borrow_mut().push(format!("url:{url}"));
        }
        fn play_sound(&mut self, sound: &str) {
            self.events.borrow_mut().push(format!("sound:{sound}"));
        }
        fn start_process_detached(
            &mut self,
            program: &str,
            args: &[String],
            cwd: &str,
            hide: bool,
        ) -> bool {
            self.events.borrow_mut().push(format!(
                "run:{program}|{}|{cwd}|{hide}",
                args.join(",")
            ));
            !program.is_empty()
        }
        fn send_text(&mut self, text: &str) {
            self.events.borrow_mut().push(format!("send:{text}"));
        }
        fn report_error(&mut self, name: &str, body: &str) {
            self.events.borrow_mut().push(format!("err:{name}|{body}"));
        }
        fn has_widget(&self) -> bool {
            self.widget
        }
    }

    fn setting(pairs: &[(&str, Value)]) -> Settings {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn type_table_values() {
        // 显示表 11 项；7 无显示名
        assert_eq!(TriggerType::AfterConnection.display_name(), Some("Event: after connection"));
        assert_eq!(TriggerType::ShowTooltip.display_name(), Some("Show tooltip"));
        assert_eq!(TriggerType::Reserved7.display_name(), None);
        assert_eq!(TriggerType::None.display_name(), None);
        assert_eq!(TriggerType::from_display_name("Run command"), Some(TriggerType::RunCommand));
        // 连接类型判定 (t-1)<4
        for t in [TriggerType::AfterConnection, TriggerType::AfterDisconnection,
                  TriggerType::BeforeConnection, TriggerType::BeforeDisconnection] {
            assert!(t.is_connection());
        }
        assert!(!TriggerType::SendText.is_connection());
        assert!(!TriggerType::CustomLink.is_connection());
    }

    #[test]
    fn default_ctor_is_disabled_none() {
        let t = Trigger::default();
        assert!(!t.enabled);
        assert!(!t.dynamic);
        assert_eq!(t.r#type, TriggerType::None);
        assert!(t.settings.is_empty());
    }

    #[test]
    fn param_ctor_generates_uuid_and_default_decoration() {
        let t = Trigger::new(TriggerType::ShowTooltip, "tip", "");
        assert!(t.enabled && t.dynamic);
        assert!(!t.uuid.is_empty()); // 自动生成 v4 uuid
        assert_eq!(
            t.settings.get("text.lineColor").map(|v| v.as_str()),
            Some(Some("terminal.ansiBrightBlack"))
        );
        // type=SendText 不带默认装饰
        let s = Trigger::new(TriggerType::SendText, "s", "uuid-1");
        assert!(s.settings.is_empty());
        assert_eq!(s.uuid, "uuid-1");
    }

    #[test]
    fn equality_field_set_is_nine() {
        let mut a = Trigger::new(TriggerType::SendText, "n", "u");
        let b = a.clone();
        assert_eq!(a, b);
        a.dynamic = !a.dynamic; // 参与 ==
        assert_ne!(a, b);
    }

    #[test]
    fn has_session_matrix() {
        let mut t = Trigger::new(TriggerType::SendText, "n", "u");
        assert!(!t.has_session("", true, &sys)); // 空 session → 假
        t.target_sessions.insert("s1".into(), true);
        t.target_sessions.insert("s2".into(), false);
        assert!(t.has_session("s1", true, &sys));
        assert!(!t.has_session("s2", true, &sys));
        // map 非空但未命中 → 落到 systems
        t.target_systems.insert("linux".into());
        assert!(t.has_session("other", true, &sys_map(vec![("other", "linux")])));
        assert!(!t.has_session("other", true, &sys_map(vec![("other", "win")])));
        // "*" 通配
        t.target_systems.insert("*".into());
        assert!(t.has_session("whatever", false, &sys));
    }

    #[test]
    fn set_target_session_dedup_semantics() {
        // 系统级已命中（"*"）且 value=true → 删除条目（不写入）
        let mut t = Trigger::new(TriggerType::SendText, "n", "u");
        t.target_systems.insert("*".into());
        t.set_target_session("s1", true, &sys);
        assert!(t.target_sessions.is_empty());
        t.set_target_session("s1", false, &sys);
        assert_eq!(t.target_sessions.get("s1"), Some(&false));
    }

    #[test]
    fn action_derivation_matrix() {
        // 连接类型：查找 settings["action"]，缺省 3
        let d = TriggerData::new(TriggerType::BeforeConnection, &setting(&[]));
        assert_eq!(d.action, 3);
        let d = TriggerData::new(
            TriggerType::BeforeConnection,
            &setting(&[("action", Value::String("Send text".into()))]),
        );
        assert_eq!(d.action, 4);
        // CustomLink 查找
        let d = TriggerData::new(TriggerType::CustomLink, &setting(&[]));
        assert_eq!(d.action, 3);
        // {6,8,12} → 0；{7,9,10,11} → 0；>12 → 0
        for t in [TriggerType::CustomMenu, TriggerType::HighlightText, TriggerType::ShowTooltip,
                  TriggerType::Reserved7, TriggerType::PlaySound, TriggerType::RunCommand,
                  TriggerType::SendText] {
            assert_eq!(TriggerData::new(t, &setting(&[])).action, 0, "{t:?}");
        }
        assert_eq!(TriggerData::new(TriggerType::None, &setting(&[])).action, 0);
    }

    #[test]
    fn condition_default_and_delay_units() {
        let d = TriggerData::new(TriggerType::SendText, &setting(&[]));
        assert_eq!(d.condition(), COND_LINE_PROMPT); // 缺省 2
        let d = TriggerData::new(
            TriggerType::SendText,
            &setting(&[("condition", Value::String("NoCondition".into()))]),
        );
        assert_eq!(d.condition(), COND_NO);
        // delay：秒→毫秒截断
        let d = TriggerData::new(TriggerType::SendText, &setting(&[("delay", Value::from(2.5))]));
        assert_eq!(d.delay_ms(), 2500);
        let d = TriggerData::new(
            TriggerType::SendText,
            &setting(&[("delay", Value::String("1.5".into()))]),
        );
        assert_eq!(d.delay_ms(), 1500);
    }

    #[test]
    fn is_executable_matrix() {
        // action 1/4 → text 非空；3 → command 非空；2/0 → 真
        let mut s = setting(&[]);
        s.insert("action".into(), Value::String("Send text".into()));
        let mut d = TriggerData::new(TriggerType::BeforeDisconnection, &s); // action 4
        assert!(!d.is_executable());
        d.settings.insert("text".into(), Value::String("hi".into()));
        assert!(d.is_executable());
        let d = TriggerData::new(TriggerType::BeforeDisconnection, &setting(&[])); // 缺省 action 3
        assert!(!d.is_executable());
        let mut s2 = setting(&[]);
        s2.insert("action".into(), Value::String("Play sound".into())); // 2
        assert!(TriggerData::new(TriggerType::BeforeDisconnection, &s2).is_executable());
        // type 9/10/11 → action 0 → 恒真
        assert!(TriggerData::new(TriggerType::SendText, &setting(&[])).is_executable());
    }

    #[test]
    fn compile_rule_gates() {
        let t = Trigger::new(TriggerType::SendText, "n", "u");
        // 空 pattern 丢弃
        assert!(compile_rule(&t, &setting(&[])).is_none());
        // 字面量模式：escape 生效（"a.b" 不匹配 "axb"）
        let map = setting(&[
            ("text.pattern", Value::String("a.b".into())),
            ("text", Value::String("x".into())),
        ]);
        let r = compile_rule(&t, &map).expect("compiled");
        let re = r.regex.as_ref().unwrap();
        assert!(re.is_match("xa.by"));
        assert!(!re.is_match("xaxby"));
        // 忽略大小写默认开
        assert!(re.is_match("A.B"));
        // matchCase=true → 区分
        let map2 = setting(&[
            ("text.pattern", Value::String("AbC".into())),
            ("text.matchCase", Value::Bool(true)),
            ("text", Value::String("x".into())),
        ]);
        let r2 = compile_rule(&t, &map2).unwrap();
        assert!(!r2.regex.as_ref().unwrap().is_match("abc"));
        // whole word
        let map3 = setting(&[
            ("text.pattern", Value::String("err".into())),
            ("text.matchWholeWord", Value::Bool(true)),
            ("text", Value::String("x".into())),
        ]);
        let r3 = compile_rule(&t, &map3).unwrap();
        assert!(r3.regex.as_ref().unwrap().is_match("an err here"));
        assert!(!r3.regex.as_ref().unwrap().is_match("error"));
        // 非正则模式下非法正则不报错（escape 后合法）
        let map4 = setting(&[
            ("text.pattern", Value::String("*(bad[".into())),
            ("text", Value::String("x".into())),
        ]);
        assert!(compile_rule(&t, &map4).is_some());
    }

    #[test]
    fn add_trigger_rule_expands_value_list_for_8_9() {
        let mut c = TriggerManager::new();
        // type 8：settings["value"] 数组 → 多条规则
        let t = Trigger {
            name: "hl".into(),
            uuid: "u8".into(),
            enabled: true,
            r#type: TriggerType::HighlightText,
            settings: setting(&[(
                "value",
                Value::Array(vec![
                    json_rule("one", "hi"),
                    json_rule("two", "yo"),
                ]),
            )]),
            ..Default::default()
        };
        c.add_trigger_rule(&t, true);
        assert_eq!(c.trigger_rules().len(), 2);
        // disabled trigger 不编译
        let mut t2 = t.clone();
        t2.enabled = false;
        c.add_trigger_rule(&t2, true);
        assert_eq!(c.trigger_rules().len(), 2);
        // type 11：settings 即单规则
        let t3 = Trigger {
            uuid: "u11".into(),
            enabled: true,
            r#type: TriggerType::SendText,
            settings: setting(&[
                ("text.pattern", Value::String("ready".into())),
                ("text", Value::String("go\r".into())),
            ]),
            ..Default::default()
        };
        c.add_trigger_rule(&t3, true);
        assert_eq!(c.trigger_rules().len(), 3);
        assert_eq!(c.trigger_rules()[2].uuid, "u11");
    }

    fn json_rule(pattern: &str, text: &str) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("text.pattern".into(), Value::String(pattern.into()));
        m.insert("text".into(), Value::String(text.into()));
        Value::Object(m)
    }

    #[test]
    fn load_order_dedup_and_gate() {
        // 加载序：flag=true → append（user 文件先加载）；flag=false → 按下标 insert 到前部
        // （default 后加载但占前位）；按 uuid 对已载集合去重 → user 同名 uuid 优先（覆盖默认）
        let default = r#"[{"name":"d1","uuid":"D1","type":"Send text","enabled":true,"settings":{"text.pattern":"p1","text":"a"}},{"name":"d2","uuid":"D2","type":"Send text","enabled":true,"settings":{"text.pattern":"p0","text":"a"}}]"#;
        let user = r#"[{"name":"u1","uuid":"U1","type":"Run command","enabled":true,"settings":{"text.pattern":"p2","command":"ls"}},{"name":"dup","uuid":"D1","type":"Send text","enabled":true,"settings":{"text.pattern":"zz","text":"q"}}]"#;
        let mut c = TriggerManager::new();
        c.load_triggers(default, user);
        // user 先入列 [U1, D1(dup)]；default 的 D1 去重跳过、D2 插到最前
        assert_eq!(
            c.triggers().iter().map(|t| t.uuid.as_str()).collect::<Vec<_>>(),
            vec!["D2", "U1", "D1"]
        );
        // 规则：D2(p0)+U1(p2)+D1dup(zz) 三条；默认 d1 的 p1 未载入
        assert_eq!(c.trigger_rules().len(), 3);
        let d1 = c.trigger_rules().iter().find(|r| r.uuid == "D1").unwrap();
        assert!(d1.regex.as_ref().unwrap().is_match("zz"));
        assert!(!d1.regex.as_ref().unwrap().is_match("p1")); // 默认 d1 的 pattern 未载入（user 覆盖）
        assert!(c.is_loaded());
        // loaded 门：再调用不重复加载
        c.load_triggers(default, user);
        assert_eq!(c.trigger_rules().len(), 3);
        // bits：SendText+RunCommand 有、PlaySound 无
        assert!(c.has_enabled_type(TriggerType::SendText));
        assert!(!c.has_enabled_type(TriggerType::PlaySound));
    }

    #[test]
    fn set_triggers_diff_and_recompile() {
        let mut c = TriggerManager::new();
        let t1 = Trigger {
            uuid: "A".into(),
            enabled: true,
            r#type: TriggerType::SendText,
            settings: setting(&[("text.pattern", Value::String("one".into())), ("text", Value::String("x".into()))]),
            ..Default::default()
        };
        let t2 = Trigger {
            uuid: "B".into(),
            enabled: true,
            r#type: TriggerType::PlaySound,
            settings: setting(&[("value", Value::Array(vec![json_rule("two", "s")]))]),
            ..Default::default()
        };
        c.set_triggers(vec![t1.clone(), t2.clone()]);
        assert_eq!(c.trigger_rules().len(), 2);
        // 无变化门
        let res = c.set_triggers(vec![t1.clone(), t2.clone()]);
        assert!(!res.changed);
        assert_eq!(c.trigger_rules().len(), 2);
        // 删除 B → 其规则消失
        let res = c.set_triggers(vec![t1.clone()]);
        assert!(res.changed);
        assert_eq!(res.removed_uuids, vec!["B".to_string()]);
        assert_eq!(c.trigger_rules().len(), 1);
        // 变更 A（同 uuid 新 pattern）→ 旧规则删除 + 新规则编译（超集语义）
        let t1b = Trigger {
            settings: setting(&[("text.pattern", Value::String("ONE+".into())), ("text", Value::String("x".into()))]),
            ..t1.clone()
        };
        let res = c.set_triggers(vec![t1b]);
        assert_eq!(res.added_uuids, vec!["A".to_string()]);
        assert_eq!(c.trigger_rules().len(), 1);
        assert_eq!(c.trigger_rules()[0].uuid, "A");
        assert!(c.trigger_rules()[0].regex.as_ref().unwrap().is_match("ONE+x"));
    }

    #[test]
    fn rule_bounds_and_uuid_lookup() {
        let mut c = TriggerManager::new();
        c.set_triggers(vec![Trigger {
            uuid: "A".into(),
            enabled: true,
            r#type: TriggerType::SendText,
            settings: setting(&[("text.pattern", Value::String("p".into())), ("text", Value::String("x".into()))]),
            ..Default::default()
        }]);
        assert!(c.trigger_rule(-1).is_none()); // 下界
        assert!(c.trigger_rule(0).is_some());
        assert!(c.trigger_rule(1).is_none()); // 上界
        assert!(c.trigger_from_uuid("").is_none()); // 空 uuid → None
        assert!(c.trigger_from_uuid("nope").is_none());
        assert!(c.trigger_from_uuid("A").is_some());
    }

    #[test]
    fn session_triggers_filtering() {
        let mut c = TriggerManager::new();
        let mut conn = Trigger::new(TriggerType::BeforeConnection, "c", "C");
        conn.target_systems.insert("*".into());
        let mut out = Trigger::new(TriggerType::SendText, "o", "O");
        out.target_systems.insert("linux".into());
        let mut off = Trigger::new(TriggerType::SendText, "f", "F");
        off.enabled = false;
        c.set_triggers(vec![conn, out, off]);
        let f = sys_map(vec![("s1", "linux"), ("s2", "win")]);
        // 默认不含连接触发；disabled 排除；system 不匹配排除
        assert_eq!(c.session_triggers("s1", false, &f), vec!["O".to_string()]);
        assert_eq!(c.session_triggers("s2", false, &f), Vec::<String>::new());
        // include_connection=true
        assert_eq!(c.session_triggers("s1", true, &f), vec!["C".to_string(), "O".to_string()]);
    }

    #[test]
    fn execute_dispatch_send_text_with_escapes_and_captures() {
        let mut c = TriggerManager::new();
        let t = Trigger {
            uuid: "A".into(),
            name: "auto".into(),
            enabled: true,
            r#type: TriggerType::SendText,
            settings: setting(&[
                ("text.pattern", Value::String(r"pass-(\w+)".into())),
                ("text.matchRegex", Value::Bool(true)),
                ("text", Value::String(r"secret-%1\r".into())),
            ]),
            ..Default::default()
        };
        c.set_triggers(vec![t]);
        let mut rec = Recorder::default();
        rec.widget = true;
        let hits = c.match_output(&["A".to_string()].into_iter().collect(), "need pass-abc now");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].captures[1], "abc");
        c.execute_trigger_rule(hits[0].rule_id, &hits[0].captures, &mut rec);
        // %1 替换 + 转义解析（\r→CR）
        assert_eq!(rec.events.borrow().as_slice(), &["send:secret-abc\r".to_string()]);
    }

    #[test]
    fn execute_send_text_requires_widget() {
        let mut c = TriggerManager::new();
        c.set_triggers(vec![Trigger {
            uuid: "A".into(),
            enabled: true,
            r#type: TriggerType::SendText,
            settings: setting(&[("text.pattern", Value::String("p".into())), ("text", Value::String("x".into()))]),
            ..Default::default()
        }]);
        let mut rec = Recorder::default(); // widget=false
        c.execute_trigger_rule(0, &[], &mut rec);
        assert!(rec.events.borrow().is_empty());
    }

    #[test]
    fn execute_run_command_empty_command_reports_error() {
        // RunCommand(10) → action=0 → is_executable 恒真 → 入库；
        // 空 command 在 start_process_detached 处返回 false → 失败上报
        let mut c = TriggerManager::new();
        c.set_triggers(vec![Trigger {
            uuid: "A".into(),
            name: "boom".into(),
            enabled: true,
            r#type: TriggerType::RunCommand,
            settings: setting(&[
                ("text.pattern", Value::String("p".into())),
                ("command", Value::String("".into())),
            ]),
            ..Default::default()
        }]);
        assert_eq!(c.trigger_rules().len(), 1);
        let mut rec = Recorder::default();
        c.execute_trigger_rule(0, &[], &mut rec);
        assert_eq!(rec.events.borrow().as_slice(), &["run:|||false".to_string(), "err:boom|".to_string()]);
    }

    #[test]
    fn run_command_type10_dispatch_and_error() {
        let mut c = TriggerManager::new();
        c.set_triggers(vec![Trigger {
            uuid: "A".into(),
            name: "boom".into(),
            enabled: true,
            r#type: TriggerType::RunCommand,
            settings: setting(&[
                ("text.pattern", Value::String("go".into())),
                ("command", Value::String("tool".into())),
                ("arguments", Value::String("--flag \"two words\"".into())),
                ("workingDirectory", Value::String("/tmp".into())),
                ("hideShellWindow", Value::Bool(true)),
            ]),
            ..Default::default()
        }]);
        let mut rec = Recorder::default();
        c.execute_trigger_rule(0, &[], &mut rec);
        assert_eq!(
            rec.events.borrow().as_slice(),
            &["run:tool|--flag,two words|/tmp|true".to_string()]
        );
    }

    #[test]
    fn highlight_and_tooltip_are_noops_in_execute() {
        // {6,7,8,12} default → 无动作（高亮在编辑层）
        let mut c = TriggerManager::new();
        c.set_triggers(vec![Trigger {
            uuid: "H".into(),
            enabled: true,
            r#type: TriggerType::HighlightText,
            settings: setting(&[("value", Value::Array(vec![json_rule("pat", "")]))]),
            ..Default::default()
        }]);
        let mut rec = Recorder::default();
        c.execute_trigger_rule(0, &[], &mut rec);
        assert!(rec.events.borrow().is_empty());
    }

    #[test]
    fn connection_trigger_bit_gate_and_adhoc_rule() {
        let mut c = TriggerManager::new();
        let mut t = Trigger::new(TriggerType::BeforeConnection, "pre", "P");
        t.settings = setting(&[
            ("action", Value::String("Send text".into())),
            ("text", Value::String("hi\r".into())),
        ]);
        t.target_systems.insert("*".into());
        c.set_triggers(vec![t.clone()]);
        let mut rec = Recorder::default();
        rec.widget = true;
        // 错误 type（AfterConnection）bit 未置 → 立即返回
        c.execute_connection_trigger(TriggerType::AfterConnection, "s1", &sys, &mut rec);
        assert!(rec.events.borrow().is_empty());
        // BeforeConnection：action=4（Send text）→ type∈{1..5} 走 action 分派；
        // 动作 4 要求 type==11 —— 连接类型 action4 被 type 门挡下
        c.execute_connection_trigger(TriggerType::BeforeConnection, "s1", &sys, &mut rec);
        assert!(rec.events.borrow().is_empty());
        // action3（缺省）→ run command
        let mut t2 = Trigger::new(TriggerType::BeforeConnection, "pre2", "P2");
        t2.settings = setting(&[("command", Value::String("echo".into()))]);
        t2.target_systems.insert("*".into());
        c.set_triggers(vec![t, t2]);
        let mut rec2 = Recorder::default();
        c.execute_connection_trigger(TriggerType::BeforeConnection, "s1", &sys, &mut rec2);
        assert_eq!(rec2.events.borrow().len(), 1);
        assert!(rec2.events.borrow()[0].starts_with("run:echo"));
    }

    #[test]
    fn parse_escaped_string_grammar() {
        // 转义语法
        assert_eq!(parse_escaped_string(r"a\nb"), "a\nb");
        assert_eq!(parse_escaped_string(r"\t\v\f\a\b"), "\t\u{0b}\u{0c}\u{07}\u{08}");
        assert_eq!(parse_escaped_string(r"\\x"), "\\x");
        assert_eq!(parse_escaped_string(r"\0"), "\0");
        assert_eq!(parse_escaped_string(r"\cH"), "\u{8}"); // H=0x48 → 0x48-0x40=0x08
        assert_eq!(parse_escaped_string(r"\cC"), "\u{3}");
        assert_eq!(parse_escaped_string(r"\c-"), "\u{7f}");
        assert_eq!(parse_escaped_string(r"\mA"), "\u{c1}"); // A|0x80
        assert_eq!(parse_escaped_string(r"\x41"), "A");
        assert_eq!(parse_escaped_string(r"\q"), r"\q"); // 未知转义原样
    }

    #[test]
    fn split_command_line_quoting() {
        assert_eq!(split_command_line("a b  c"), vec!["a", "b", "c"]);
        assert_eq!(split_command_line(r#"'two words' x"#), vec!["two words", "x"]);
        assert_eq!(split_command_line("\"k=1 2\" z"), vec!["k=1 2", "z"]);
        assert_eq!(split_command_line("   "), Vec::<String>::new());
    }

    #[test]
    fn save_roundtrip() {
        let mut c = TriggerManager::new();
        let mut t = Trigger::new(TriggerType::SendText, "n", "U1");
        t.description = "d".into();
        t.settings.insert("text.pattern".into(), Value::String("p".into()));
        t.target_sessions.insert("s1".into(), false);
        t.target_systems.insert("linux".into());
        c.set_triggers(vec![t.clone()]);
        let json = c.save_triggers();
        let mut c2 = TriggerManager::new();
        c2.set_triggers(parse_triggers(&json));
        // dynamic 不序列化 → 往返后以 parse 默认 false 重建；其余字段一致
        let mut expect = t.clone();
        expect.dynamic = false;
        assert_eq!(c2.triggers()[0], expect);
    }

    #[test]
    fn match_output_rule_id_is_global_index() {
        let mut c = TriggerManager::new();
        let a = Trigger {
            uuid: "A".into(),
            enabled: true,
            r#type: TriggerType::SendText,
            settings: setting(&[("text.pattern", Value::String("x".into())), ("text", Value::String("1".into()))]),
            ..Default::default()
        };
        let b = Trigger {
            uuid: "B".into(),
            enabled: true,
            r#type: TriggerType::SendText,
            settings: setting(&[("text.pattern", Value::String("y".into())), ("text", Value::String("2".into()))]),
            ..Default::default()
        };
        c.set_triggers(vec![a, b]);
        let only_b: BTreeSet<String> = ["B".to_string()].into_iter().collect();
        let hits = c.match_output(&only_b, "x y");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rule_id, 1); // 全局下标
    }

    #[test]
    fn percent_substitution_bounds() {
        let caps = vec!["full".to_string(), "g1".to_string()];
        assert_eq!(substitute_percent("a%0b%1c%9d", &caps), "afullbg1cd");
        assert_eq!(substitute_percent("100%", &caps), "100%");
    }
}
