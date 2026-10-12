//! expect 自动登录引擎 —— 语义重写自 WindTerm 2.6.0 `ExpectTask`（QObject, per-Document）
//!
//! 证据（re-work/decompiled/session/ExpectTask__*.pseudo.txt，sha256 d26c6406…5edd1）：
//! - ExpectTask::ExpectTask            1004f4530  字段：rules@+0x10, pendingLF@+0x18,
//!   pendingLP@+0x1c, lastPromptPos@+0x20(= -1), document@+0x28, timer@+0x30(= null)
//! - addExpectRule(QMap)               1004f4590  去重(uuid+captureGroups) → 按 condition 分派
//! - executeExpectRule(QMap)           1004f5000  type 7/11 仅通知；否则 TriggerCenter 三段校验后执行
//! - onTimeout                         1004f57d0  按 timer interval 消耗 delay，未到期者减钟重排
//! - checkLineFeedCondition            1004f5cf0  pendingLF>0 → checkCondition(1)
//! - checkLinePromptCondition          1004f5d10  pendingLP>0 且 endScoped==length → checkCondition(2)
//! - checkCondition(int)               1004f5d50  最旧→最新找首个满足条件者：摘除→计数-1→降级 cond=0 重入列
//! - removeExpectRules(QStringList)    1004f6350  按 trigger uuid 删除并校正 pending 计数
//! - replaceText(long long, long long) 1004f6780  文本替换(start, delta) 时重映射 position/提示位
//! - prop 键名实读自二进制字符串表（re-work/prop-names.tsv）：
//!   uuid / ruleId / type / condition / delay / position / captureGroups / terminalWidget
//!
//! 语义要点（均有反编译行级证据）：
//! 1. 规则入列一律 **prepend**（index0=最新），但 checkCondition/onTimeout/remove 均从**最旧**（表尾）扫起。
//! 2. condition 值域 {0,1,2}；其它值 add 时直接丢弃（1004f4b91 后 `if (iVar7 != 0) return;`）。
//! 3. pending 计数上限：先判 `count > 8` 再自增 → 最大 9（1004f4b91/1004f4c22）。
//! 4. delay==0 的即时规则**不入列**，直接执行；delay<0 丢弃；delay>0 入列并共享单例定时器，
//!    仅当 `delay < remaining || remaining < 1` 时以 delay 重启（1004f4d51）。
//! 5. onTimeout 用 QTimer interval 字段（+0x14）作“已流逝基准”：`rem = delay - interval`，
//!    `rem==0 || delay<interval` → 到期执行并摘除；否则 delay:=rem，收尾以 min(rem) 重启，空则停表。
//! 6. checkCondition 每调用只处理**一条**（摘除后 re-add 即 return，1004f6075→LAB_1004f615b）。
//! 7. LinePrompt 条件：`promptPos != LLONG_MAX && rule.position < promptPos && promptPos != lastPromptPos`，
//!    命中时更新 lastPromptPos —— 同一提示位只放行一条规则（1004f6075 else-if 链）。
//! 8. executeExpectRule 三段校验：triggerFromUuid 非空 → hasSession(document.session) →
//!    triggerRule(ruleId).uuid == rule.uuid；任一失败静默丢弃（1004f5214/1004f534e）。
//! 9. replaceText：无 pending 规则时重置 lastPromptPos=-1；cond∈{1,2} 且 start<position 时
//!    position += delta（delta<0 时钳到 start）；delta>0 且 pendingLF>0 触发 checkCondition(1)；
//!    start<lastPromptPos 时 lastPromptPos += delta（1004f6780 尾段）。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// PROP_CONDITION 值域（addExpectRule 分派证据 1004f4b91..1004f4c68）
pub const COND_IMMEDIATE: i64 = 0;
pub const COND_LINE_FEED: i64 = 1;
pub const COND_LINE_PROMPT: i64 = 2;

/// executeExpectRule 中仅触发 Document::notifyExpectTriggered、不执行动作的 type 值
/// （证据 1004f5112: `if (iVar4 == 7) goto notify`；1004f53aa: `if (iVar4 == 0xb)`）
pub const TYPE_NOTIFY_ONLY: i64 = 7;
pub const TYPE_NOTIFY_ONLY_11: i64 = 11;

/// pending 计数上限守卫：`if (8 < count) return;`（先判后增 → 最大 9）
pub const PENDING_CAP: i32 = 8;

/// 一条 expect 规则 = WindTerm QMap<QString,QVariant>；键名以二进制字符串表实读为准。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    /// "uuid" —— 所属 trigger 的 UUID（去重键之一；执行期三段校验依据）
    #[serde(rename = "uuid", default)]
    pub uuid: String,
    /// "ruleId" —— trigger 内规则序号（TriggerCenter::triggerRule(i) 的入参）
    #[serde(rename = "ruleId", default)]
    pub rule_id: i64,
    /// "type" —— trigger 动作类型；7/11 为仅通知
    #[serde(rename = "type", default)]
    pub r#type: i64,
    /// "condition" —— 0 立即/延迟, 1 等待换行, 2 等待屏幕提示符
    #[serde(rename = "condition", default)]
    pub condition: i64,
    /// "delay" —— 毫秒；仅 condition=0 时有意义
    #[serde(rename = "delay", default)]
    pub delay: i64,
    /// "position" —— 规则创建时文档位置（LineFeed/LinePrompt 判定基准）
    #[serde(rename = "position", default)]
    pub position: i64,
    /// "captureGroups" —— 正则捕获组（去重键之二；执行时传给 executeTriggerRule）
    #[serde(rename = "captureGroups", default)]
    pub capture_groups: BTreeMap<String, String>,
    /// "terminalWidget" —— QPointer<TerminalWidget>，重写为不透明句柄
    #[serde(rename = "terminalWidget", default)]
    pub terminal_widget: Option<String>,
}

impl Rule {
    /// 等价于 QVariant::cmp 的去重比较：uuid 与 captureGroups 全等（1004f46de/1004f479c 双查）
    fn same_identity(&self, other: &Rule) -> bool {
        self.uuid == other.uuid && self.capture_groups == other.capture_groups
    }
}

/// Document 侧查询面（反编译中 Document::Length/getEndScoped/LinesTotal/LineFromPosition/
/// lastScreenPromptSignPosition 与 document+0x2b8 的会话 uuid）
pub trait Doc {
    fn length(&self) -> i64;
    fn end_scoped(&self) -> i64;
    fn lines_total(&self) -> i64;
    fn line_from_position(&self, pos: i64) -> i64;
    /// None 对应 LLONG_MAX（无屏幕提示符标记，1004f6075 的 `!= 0x7fffffffffffffff` 判定）
    fn last_screen_prompt_sign_position(&self) -> Option<i64>;
    fn session_uuid(&self) -> &str;
}

/// TriggerCenter / Document 通知面（executeExpectRule 的全部外部效应）
pub trait Sink {
    /// Document::notifyExpectTriggered —— type 7/11 唯一动作
    fn notify_expect_triggered(&mut self, rule: &Rule);
    /// TriggerCenter::triggerFromUuid(uuid) 是否命中
    fn trigger_exists(&self, uuid: &str) -> bool;
    /// Trigger::hasSession(document+0x2b8, true)
    fn trigger_has_session(&self, uuid: &str, session: &str) -> bool;
    /// TriggerCenter::triggerRule(ruleId) 的 owner uuid；规则不存在 → None
    fn trigger_rule_uuid(&self, rule_id: i64) -> Option<String>;
    /// TriggerCenter::executeTriggerRule(rule, captureGroups, terminalWidget)
    fn execute_trigger_rule(&mut self, rule_id: i64, rule: &Rule);
}

/// QTimer 抽象（证据：addExpectRule 读 remainingTime()，onTimeout 读 interval 字段 +0x14）。
/// 宿主负责真实计时并回调 on_timeout()。
#[derive(Clone, Debug, Default)]
pub struct Timer {
    pub running: bool,
    /// QTimer::start(msecs) 设定值（非 repeating 语义依赖：到期后由 onTimeout 重排/停表）
    pub interval: i64,
    /// remainingTime()：未运行恒为 0
    pub remaining: i64,
}

impl Timer {
    fn remaining_time(&self) -> i64 {
        if self.running {
            self.remaining
        } else {
            0
        }
    }
    fn start(&mut self, msecs: i64) {
        self.interval = msecs;
        self.remaining = msecs;
        self.running = true;
    }
    fn stop(&mut self) {
        self.running = false;
        self.interval = 0;
        self.remaining = 0;
    }
}

/// ExpectTask 重写：泛型注入 Document 与 TriggerCenter 语义面，纯同步可测。
pub struct ExpectEngine<D: Doc, S: Sink> {
    pub doc: D,
    pub sink: S,
    /// QList<QMap> 语义：index 0 = 最新（prepend）；扫描序 = 表尾→表头（最旧→最新）
    pub rules: Vec<Rule>,
    /// +0x18
    pub pending_line_feed: i32,
    /// +0x1c
    pub pending_line_prompt: i32,
    /// +0x20，ctor 置 -1
    pub last_prompt_pos: i64,
    /// +0x30，懒创建（首条 delay>0 规则）
    pub timer: Option<Timer>,
}

impl<D: Doc, S: Sink> ExpectEngine<D, S> {
    pub fn new(doc: D, sink: S) -> Self {
        Self {
            doc,
            sink,
            rules: Vec::new(),
            pending_line_feed: 0,
            pending_line_prompt: 0,
            last_prompt_pos: -1,
            timer: None,
        }
    }

    /// ExpectTask::addExpectRule (1004f4590)
    /// 返回 false = 规则被拒绝（去重命中 / 超上限 / 非法 condition / 负 delay）。
    pub fn add_expect_rule(&mut self, rule: Rule) -> bool {
        // 去重：uuid 与 captureGroups 全等则丢弃（1004f46de..1004f4a77 双 QVariant::cmp）
        if self.rules.iter().any(|r| r.same_identity(&rule)) {
            return false;
        }
        match rule.condition {
            COND_LINE_PROMPT => {
                if self.pending_line_prompt > PENDING_CAP {
                    return false;
                }
                self.pending_line_prompt += 1;
                self.rules.insert(0, rule);
                if self.pending_line_prompt < 1 {
                    return true;
                }
                // 证据：仅 LinePrompt 分支要求 endScoped == length（1004f4b91 cond==2 段）
                if self.doc.end_scoped() != self.doc.length() {
                    return true;
                }
                self.check_condition(COND_LINE_PROMPT);
            }
            COND_LINE_FEED => {
                if self.pending_line_feed > PENDING_CAP {
                    return false;
                }
                self.pending_line_feed += 1;
                self.rules.insert(0, rule);
                if self.pending_line_feed < 1 {
                    return true;
                }
                self.check_condition(COND_LINE_FEED);
            }
            COND_IMMEDIATE => {
                if rule.delay == 0 {
                    // 即时执行，不入列（1004f4d51: executeExpectRule 后 return）
                    self.execute_expect_rule(&rule);
                    return true;
                }
                if rule.delay < 1 {
                    return false; // 负 delay：丢弃（1004f4d51 `if (iVar7 < 1) return;`）
                }
                // 共享定时器懒创建 + 最短 delay 重启（1004f4d51..1004f4e0f）
                let t = self.timer.get_or_insert_with(Timer::default);
                let remaining = t.remaining_time();
                if rule.delay < remaining || remaining < 1 {
                    t.start(rule.delay);
                }
                self.rules.insert(0, rule);
            }
            _ => return false, // 其它 condition 值直接丢弃
        }
        true
    }

    /// ExpectTask::checkCondition(class) (1004f5d50)
    /// 最旧→最新扫描，仅处理首个满足条件者：摘除 → 计数-1 → cond 置 0 重新 add。
    pub fn check_condition(&mut self, class: i64) {
        if self.rules.is_empty() {
            return;
        }
        let mut k = self.rules.len();
        while k > 0 {
            k -= 1; // k = 距表头的相对下标，自表尾（最旧）向表头（最新）
            let satisfied = {
                let r = &self.rules[k];
                if r.condition != class {
                    false
                } else if class == COND_LINE_FEED {
                    // 证据：LineFromPosition(position) < LinesTotal - 1（1004f5fd1）
                    let line = self.doc.line_from_position(r.position);
                    let total = self.doc.lines_total();
                    line < total - 1
                } else if class == COND_LINE_PROMPT {
                    // 证据：p != LLONG_MAX && position < p && p != lastPromptPos（1004f6075）
                    match self.doc.last_screen_prompt_sign_position() {
                        Some(p) => p != i64::MAX && r.position < p && p != self.last_prompt_pos,
                        None => false,
                    }
                } else {
                    false
                }
            };
            if satisfied {
                if class == COND_LINE_PROMPT {
                    if let Some(p) = self.doc.last_screen_prompt_sign_position() {
                        self.last_prompt_pos = p; // 1004f6075: *(this+0x20) = lVar12
                    }
                }
                let mut r = self.rules.remove(k);
                match class {
                    COND_LINE_FEED => self.pending_line_feed -= 1,
                    _ => self.pending_line_prompt -= 1,
                }
                r.condition = COND_IMMEDIATE; // insert(PROP_CONDITION, QVariant(0)) 1004f60fa
                self.add_expect_rule(r);
                return; // 每次调用只推进一条
            }
        }
    }

    /// ExpectTask::checkLineFeedCondition (1004f5cf0)
    pub fn check_line_feed_condition(&mut self) {
        if self.pending_line_feed > 0 {
            self.check_condition(COND_LINE_FEED);
        }
    }

    /// ExpectTask::checkLinePromptCondition (1004f5d10)
    pub fn check_line_prompt_condition(&mut self) {
        if self.pending_line_prompt > 0 && self.doc.end_scoped() == self.doc.length() {
            self.check_condition(COND_LINE_PROMPT);
        }
    }

    /// ExpectTask::executeExpectRule (1004f5000)
    pub fn execute_expect_rule(&mut self, rule: &Rule) {
        if rule.r#type == TYPE_NOTIFY_ONLY {
            self.sink.notify_expect_triggered(rule);
            return;
        }
        // 三段校验（triggerFromUuid / hasSession / triggerRule(id).uuid == uuid）
        if !self.sink.trigger_exists(&rule.uuid) {
            return;
        }
        if !self.sink.trigger_has_session(&rule.uuid, self.doc.session_uuid()) {
            return;
        }
        match self.sink.trigger_rule_uuid(rule.rule_id) {
            Some(owner) if owner == rule.uuid => {}
            _ => return,
        }
        if rule.r#type == TYPE_NOTIFY_ONLY_11 {
            self.sink.notify_expect_triggered(rule);
            return;
        }
        self.sink.execute_trigger_rule(rule.rule_id, rule);
    }

    /// ExpectTask::onTimeout (1004f57d0) —— 宿主定时器到期回调。
    /// 以 timer.interval 为“已消耗时长”基准：到期规则执行并摘除；未到期 delay 减钟，
    /// 收尾以最小剩余重启定时器，全部清空则停表。
    pub fn on_timeout(&mut self) {
        let interval = self.timer.as_ref().map(|t| t.interval).unwrap_or(0);
        let mut best: i64 = -1; // local_4c
        let mut k = self.rules.len();
        while k > 0 {
            k -= 1;
            let (cond, delay) = {
                let r = &self.rules[k];
                (r.condition, r.delay)
            };
            if cond == COND_IMMEDIATE && delay > 0 {
                let rem = delay - interval;
                if rem == 0 || delay < interval {
                    // 到期：delay 清零 → 执行 → 按“距表头相对下标 k”摘除（列表可能因执行期重入而变长）
                    self.rules[k].delay = 0;
                    let snapshot = self.rules[k].clone();
                    self.execute_expect_rule(&snapshot);
                    // 证据 1004f5bd6：界检 (k+1 <= fresh_len) 后按 fresh begin + k 寻址删除
                    if k < self.rules.len() {
                        self.rules.remove(k);
                    }
                } else {
                    self.rules[k].delay = rem;
                    best = if best == -1 { rem } else if rem < best { rem } else { best };
                }
            }
        }
        if let Some(t) = self.timer.as_mut() {
            if best != -1 {
                t.start(best); // 1004f5c2c: QTimer::start(best)
            } else {
                t.stop(); // 1004f5c43: stop + interval 归零
            }
        }
    }

    /// ExpectTask::removeExpectRules (1004f6350) —— 按 trigger uuid 批量删除并校正计数。
    pub fn remove_expect_rules(&mut self, uuids: &[String]) {
        let mut k = self.rules.len();
        while k > 0 {
            k -= 1;
            let hit = uuids.iter().any(|u| *u == self.rules[k].uuid);
            if hit {
                match self.rules[k].condition {
                    COND_LINE_PROMPT => self.pending_line_prompt -= 1,
                    COND_LINE_FEED => self.pending_line_feed -= 1,
                    _ => {}
                }
                self.rules.remove(k);
            }
        }
    }

    /// ExpectTask::replaceText(start, delta) (1004f6780) —— 文档文本替换后维护等待位点。
    pub fn replace_text(&mut self, start: i64, delta: i64) {
        if self.pending_line_feed < 1 && self.pending_line_prompt < 1 {
            self.last_prompt_pos = -1; // 1004f6780 头部：无 pending 即复位提示位标记
            return;
        }
        for r in self.rules.iter_mut() {
            if (r.condition == COND_LINE_FEED || r.condition == COND_LINE_PROMPT)
                && start < r.position
            {
                let mut np = r.position + delta;
                if delta < 0 {
                    np = np.max(start); // 删除时钳到替换起点
                }
                r.position = np;
            }
        }
        if delta > 0 && self.pending_line_feed > 0 {
            self.check_condition(COND_LINE_FEED); // 插入可能推进行数
        }
        if start < self.last_prompt_pos {
            self.last_prompt_pos += delta;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 可控 Document 桩
    struct MockDoc {
        length: i64,
        end_scoped: i64,
        lines_total: i64,
        prompt_pos: Option<i64>,
        session: String,
    }
    impl Default for MockDoc {
        fn default() -> Self {
            Self {
                length: 100,
                end_scoped: 100,
                lines_total: 1,
                prompt_pos: None,
                session: "sess-1".into(),
            }
        }
    }
    impl Doc for MockDoc {
        fn length(&self) -> i64 { self.length }
        fn end_scoped(&self) -> i64 { self.end_scoped }
        fn lines_total(&self) -> i64 { self.lines_total }
        // 简化行模型：每 10 字节一行
        fn line_from_position(&self, pos: i64) -> i64 { pos / 10 }
        fn last_screen_prompt_sign_position(&self) -> Option<i64> { self.prompt_pos }
        fn session_uuid(&self) -> &str { &self.session }
    }

    /// 可控 TriggerCenter 桩
    #[derive(Default)]
    struct MockSink {
        triggers: Vec<String>,
        rule_owner: Vec<(i64, String)>,
        has_sess: bool,
        events: Vec<String>,
    }
    impl Sink for MockSink {
        fn notify_expect_triggered(&mut self, rule: &Rule) {
            self.events.push(format!("notify:{}", rule.uuid));
        }
        fn trigger_exists(&self, uuid: &str) -> bool {
            self.triggers.iter().any(|t| t == uuid)
        }
        fn trigger_has_session(&self, _uuid: &str, _session: &str) -> bool {
            self.has_sess
        }
        fn trigger_rule_uuid(&self, rule_id: i64) -> Option<String> {
            self.rule_owner.iter().find(|(i, _)| *i == rule_id).map(|(_, u)| u.clone())
        }
        fn execute_trigger_rule(&mut self, rule_id: i64, rule: &Rule) {
            self.events.push(format!("exec:{}:{}:{:?}", rule_id, rule.uuid, rule.terminal_widget));
        }
    }

    fn rule(cond: i64, delay: i64, position: i64) -> Rule {
        Rule {
            uuid: "trig-1".into(),
            rule_id: 42,
            r#type: 3,
            condition: cond,
            delay,
            position,
            capture_groups: BTreeMap::new(),
            terminal_widget: Some("tw".into()),
        }
    }

    fn with_uuid(delay: i64, uuid: &str) -> Rule {
        Rule { uuid: uuid.into(), ..rule(COND_IMMEDIATE, delay, 0) }
    }

    fn engine() -> ExpectEngine<MockDoc, MockSink> {
        let mut e = ExpectEngine::new(MockDoc::default(), MockSink::default());
        e.sink.triggers.push("trig-1".into());
        e.sink.rule_owner.push((42, "trig-1".into()));
        e.sink.has_sess = true;
        e
    }

    #[test]
    fn dedup_by_uuid_and_capture_groups() {
        let mut e = engine();
        assert!(e.add_expect_rule(rule(COND_IMMEDIATE, 100, 0)));
        // 同 uuid 同 captureGroups → 拒绝（1004f46de 双 cmp 均等 return）
        assert!(!e.add_expect_rule(rule(COND_IMMEDIATE, 200, 0)));
        e.rules[0].capture_groups.insert("g1".into(), "v".into());
        assert!(e.add_expect_rule(rule(COND_IMMEDIATE, 200, 0))); // captureGroups 不同 → 可加
        assert_eq!(e.rules.len(), 2);
    }

    #[test]
    fn immediate_zero_delay_executes_without_queuing() {
        let mut e = engine();
        assert!(e.add_expect_rule(rule(COND_IMMEDIATE, 0, 0)));
        assert!(e.rules.is_empty()); // 不入列
        assert_eq!(e.sink.events, vec!["exec:42:trig-1:Some(\"tw\")"]);
        assert!(e.timer.is_none()); // 未创建定时器
    }

    #[test]
    fn negative_delay_dropped_and_bad_condition_dropped() {
        let mut e = engine();
        assert!(!e.add_expect_rule(rule(COND_IMMEDIATE, -5, 0))); // 1004f4d51 iVar<1 return
        assert!(!e.add_expect_rule(rule(9, 0, 0))); // 未知 condition
        assert!(e.rules.is_empty());
    }

    #[test]
    fn timer_uses_shortest_delay_restart() {
        let mut e = engine();
        assert!(e.add_expect_rule(rule(COND_IMMEDIATE, 100, 0)));
        assert_eq!(e.timer.as_ref().unwrap().interval, 100);
        // 更长 delay 且定时器在跑 → 不重启（1004f4d51 条件）
        e.timer.as_mut().unwrap().remaining = 50;
        assert!(e.add_expect_rule(with_uuid(300, "trig-2")));
        assert_eq!(e.timer.as_ref().unwrap().interval, 100);
        // 更短 delay → 重启为更短
        assert!(e.add_expect_rule(with_uuid(20, "trig-3")));
        assert_eq!(e.timer.as_ref().unwrap().interval, 20);
        assert_eq!(e.rules.len(), 3);
        // prepend：表头是最新
        assert_eq!(e.rules[0].delay, 20);
    }

    #[test]
    fn on_timeout_consumes_elapsed_and_reschedules() {
        let mut e = engine();
        // 两条不同 uuid 的延迟规则（避开去重）；入列顺序（新→旧）：300 在头，100 在尾
        assert!(e.add_expect_rule(rule(COND_IMMEDIATE, 100, 0)));
        assert!(e.add_expect_rule(with_uuid(300, "trig-2")));
        // 模拟：定时器以 100 到期（interval=100）
        e.timer.as_mut().unwrap().interval = 100;
        e.on_timeout();
        // delay<=interval 的到期执行并摘除；其余减钟
        assert_eq!(e.sink.events, vec!["exec:42:trig-1:Some(\"tw\")"]);
        assert_eq!(e.rules.len(), 1);
        assert_eq!(e.rules[0].delay, 200); // 300-100
        assert_eq!(e.timer.as_ref().unwrap().interval, 200); // 以最小剩余重启
        assert!(e.timer.as_ref().unwrap().running);
        // 第二次到期 → 清空停表
        e.on_timeout();
        assert!(e.rules.is_empty());
        assert!(!e.timer.as_ref().unwrap().running);
    }

    #[test]
    fn line_feed_condition_demotes_and_readds() {
        let mut e = engine();
        // position=0 → line 0；lines_total=1 → 0 < 0 false，未满足
        assert!(e.add_expect_rule(rule(COND_LINE_FEED, 0, 0)));
        assert_eq!(e.pending_line_feed, 1);
        assert_eq!(e.rules[0].condition, COND_LINE_FEED);
        // 输出推进：行数到 2 → line(0)=0 < 1 满足 → 摘除降级 cond=0 → delay0 立即执行
        e.doc.lines_total = 2;
        e.check_line_feed_condition();
        assert_eq!(e.pending_line_feed, 0);
        assert!(e.rules.is_empty());
        assert_eq!(e.sink.events, vec!["exec:42:trig-1:Some(\"tw\")"]);
    }

    #[test]
    fn line_prompt_condition_one_rule_per_prompt_position() {
        let mut e = engine();
        assert!(e.add_expect_rule(rule(COND_LINE_PROMPT, 0, 5)));
        let mut r2 = rule(COND_LINE_PROMPT, 0, 6);
        r2.uuid = "trig-2".into();
        r2.rule_id = 43;
        assert!(e.add_expect_rule(r2));
        e.sink.triggers.push("trig-2".into());
        e.sink.rule_owner.push((43, "trig-2".into()));
        // 提示符出现在 100
        e.doc.prompt_pos = Some(100);
        e.check_line_prompt_condition(); // 只处理最旧一条
        assert_eq!(e.pending_line_prompt, 1);
        assert_eq!(e.sink.events.len(), 1);
        assert_eq!(e.last_prompt_pos, 100);
        // 同一提示位不再放行第二条（p != lastPromptPos 证据 1004f6075）
        e.check_line_prompt_condition();
        assert_eq!(e.sink.events.len(), 1);
        // 新提示位 → 放行
        e.doc.prompt_pos = Some(120);
        e.check_line_prompt_condition();
        assert_eq!(e.sink.events.len(), 2);
        assert_eq!(e.pending_line_prompt, 0);
    }

    #[test]
    fn pending_cap_nine() {
        let mut e = engine();
        for i in 0..9 {
            let mut r = rule(COND_LINE_FEED, 0, i);
            r.uuid = format!("t{i}");
            assert!(e.add_expect_rule(r), "rule {i} should be accepted");
        }
        let mut r = rule(COND_LINE_FEED, 0, 99);
        r.uuid = "overflow".into();
        assert!(!e.add_expect_rule(r)); // count=9 > 8 → 拒绝
        assert_eq!(e.pending_line_feed, 9);
    }

    #[test]
    fn execute_requires_trigger_chain() {
        let mut e = engine();
        // trigger 不存在
        let mut r = rule(COND_IMMEDIATE, 0, 0);
        r.uuid = "ghost".into();
        e.add_expect_rule(r);
        assert!(e.sink.events.is_empty());
        // hasSession false
        e.sink.has_sess = false;
        e.add_expect_rule(rule(COND_IMMEDIATE, 0, 0));
        assert!(e.sink.events.is_empty());
        // ruleId 归属校验失败（triggerRule(42).uuid != rule.uuid）
        e.sink.has_sess = true;
        e.sink.rule_owner.clear();
        e.sink.rule_owner.push((42, "other".into()));
        e.add_expect_rule(rule(COND_IMMEDIATE, 0, 0));
        assert!(e.sink.events.is_empty());
    }

    #[test]
    fn notify_only_types() {
        let mut e = engine();
        let mut r7 = rule(COND_IMMEDIATE, 0, 0);
        r7.r#type = TYPE_NOTIFY_ONLY;
        e.add_expect_rule(r7);
        assert_eq!(e.sink.events, vec!["notify:trig-1"]); // type7 无需 trigger 校验
        let mut r11 = rule(COND_IMMEDIATE, 0, 0);
        r11.r#type = TYPE_NOTIFY_ONLY_11;
        e.add_expect_rule(r11);
        assert_eq!(e.sink.events, vec!["notify:trig-1", "notify:trig-1"]); // 校验通过后才 notify
    }

    #[test]
    fn replace_text_remaps_positions() {
        let mut e = engine();
        assert!(e.add_expect_rule(rule(COND_LINE_FEED, 0, 50)));
        // 在 10 处插入 20 字节 → position 50 → 70
        e.replace_text(10, 20);
        assert_eq!(e.rules[0].position, 70);
        // 删除：start=10, delta=-30 → 70-30=40 > 10 → 40
        e.replace_text(10, -30);
        assert_eq!(e.rules[0].position, 40);
        // 删除过头 → 钳到 start
        e.replace_text(30, -20);
        assert_eq!(e.rules[0].position, 30);
    }

    #[test]
    fn replace_text_resets_prompt_when_no_pending() {
        let mut e = engine();
        e.last_prompt_pos = 77;
        e.replace_text(1, 5);
        assert_eq!(e.last_prompt_pos, -1); // 无 pending → 复位（1004f6780 头部分支）
    }

    #[test]
    fn remove_expect_rules_fixes_counters() {
        let mut e = engine();
        assert!(e.add_expect_rule(rule(COND_LINE_FEED, 0, 0)));
        assert!(e.add_expect_rule({
            let mut r = rule(COND_LINE_PROMPT, 0, 0);
            r.uuid = "trig-9".into();
            r
        }));
        assert_eq!(e.pending_line_feed, 1);
        assert_eq!(e.pending_line_prompt, 1);
        e.remove_expect_rules(&["trig-1".into(), "trig-9".into()]);
        assert!(e.rules.is_empty());
        assert_eq!(e.pending_line_feed, 0);
        assert_eq!(e.pending_line_prompt, 0);
    }

    #[test]
    fn scan_order_is_oldest_first() {
        let mut e = engine();
        // sink 先配好（add 内部会直接触发 check_condition 链）
        e.sink.triggers.push("old".into());
        e.sink.triggers.push("new".into());
        e.sink.rule_owner.push((1, "old".into()));
        e.sink.rule_owner.push((2, "new".into()));
        // 初始 lines_total=1：两条都不满足
        e.doc.lines_total = 1;
        let mut old = rule(COND_LINE_FEED, 0, 0); // line(0)=0 < 0 false
        old.uuid = "old".into();
        old.rule_id = 1;
        assert!(e.add_expect_rule(old));
        let mut new = rule(COND_LINE_FEED, 0, 90); // line(90)=9 < 0 false
        new.uuid = "new".into();
        new.rule_id = 2;
        assert!(e.add_expect_rule(new));
        // 输出推进到 2 行：仅 old 满足（0 < 1）
        e.doc.lines_total = 2;
        e.check_line_feed_condition();
        assert_eq!(e.sink.events, vec!["exec:1:old:Some(\"tw\")"]); // 只处理最旧满足者
        assert_eq!(e.rules.len(), 1);
        assert_eq!(e.rules[0].uuid, "new");
    }
}
