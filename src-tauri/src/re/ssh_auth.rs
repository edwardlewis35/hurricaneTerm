//! SSH 认证编排 —— 认证方法排队执行、返回码分类与状态映射。
//!
//! 语义约定：
//! - is_operation_success: (code & !2) == 0      -> code ∈ {0=SUCCESS, 2=PARTIAL}
//! - is_operation_again:   code == 4             -> SSH_AUTH_AGAIN
//! - is_operation_failed:  code == -1            -> SSH_AUTH_ERROR
//! - map_auth_state 表:    0->0, 1->1, 2->3, 3->2, 4->4   （PARTIAL/INFO 交叉映射）
//! - 队列：begin() 入组 / param(name,val) 挂参数 / execute(fn) 挂动作 /
//!         每步记录映射后的状态；成功即停，失败或传输错误跳过剩余队列

/// libssh 认证返回码
pub const SSH_AUTH_SUCCESS: i32 = 0;
pub const SSH_AUTH_DENIED: i32 = 1;
pub const SSH_AUTH_PARTIAL: i32 = 2;
pub const SSH_AUTH_INFO: i32 = 3;
pub const SSH_AUTH_AGAIN: i32 = 4;
pub const SSH_AUTH_ERROR: i32 = -1;

/// map_auth_state 的输出状态（表驱动）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(i32)]
pub enum AuthState {
    Error = -1, // 默认分支返回 -1（原样透传）
    Success = 0,
    Denied = 1,
    Info = 2,
    Partial = 3,
    Again = 4,
}

pub fn is_operation_success(code: i32) -> bool {
    (code & !2) == 0 // 掩码判定：仅 0 / 2 为成功
}
pub fn is_operation_again(code: i32) -> bool {
    code == SSH_AUTH_AGAIN
}
pub fn is_operation_failed(code: i32) -> bool {
    code == SSH_AUTH_ERROR
}

/// map_auth_state —— 表值 0->0, 1->1, 2->3, 3->2, 4->4；非表内值一律归 Error（-1）
pub fn map_auth_state(code: i32) -> AuthState {
    match code {
        0 => AuthState::Success,
        1 => AuthState::Denied,
        2 => AuthState::Partial, // PARTIAL -> 3 槽位（交叉映射）
        3 => AuthState::Info,    // INFO    -> 2 槽位
        4 => AuthState::Again,
        _ => AuthState::Error,   // 非表内值 -> -1
    }
}

/// 一个认证步骤 {name, params, action}
pub struct Step {
    pub name: Option<String>,
    pub params: Vec<(String, String)>,
    pub action: Box<dyn FnMut(&[(String, String)]) -> i32>,
}

/// 认证计划执行器：按入队顺序执行，成功即停，AGAIN 重试，失败中止。
/// 每步结果经 map_auth_state 记录。
pub struct AuthOperator {
    queue: Vec<Step>,
    current: Option<Step>,
}

/// 构建器句柄：begin() 后连续 param()/execute() 落到同一组
pub struct Pending<'a>(&'a mut AuthOperator);

impl AuthOperator {
    pub fn new() -> Self {
        Self { queue: Vec::new(), current: None }
    }

    /// begin —— 开新组
    pub fn begin(&mut self) -> Pending<'_> {
        if let Some(s) = self.current.take() {
            self.queue.push(s);
        }
        Pending(self)
    }

    /// 完成当前组（对应 execute 变体把 callable 挂上后入列）
    fn seal(&mut self) {
        if let Some(s) = self.current.take() {
            self.queue.push(s);
        }
    }

    /// 驱动整个计划；返回每步 (name, code, state)。action 由调用方提供（russh 落地点）。
    pub fn run(&mut self) -> Vec<StepOutcome> {
        self.seal();
        let mut out = Vec::new();
        let mut aborted = false;
        for mut step in std::mem::take(&mut self.queue) {
            if aborted {
                out.push(StepOutcome { name: step.name.clone(), code: None, state: None, skipped: true });
                continue;
            }
            let mut code;
            loop {
                code = (step.action)(&step.params);
                if !is_operation_again(code) {
                    break;
                }
                // AGAIN(code==4) -> 重试同一组
            }
            let state = map_auth_state(code);
            out.push(StepOutcome { name: step.name.clone(), code: Some(code), state: Some(state), skipped: false });
            if is_operation_success(code) {
                aborted = true; // 认证成功：后续组不再执行
            }
            if is_operation_failed(code) {
                aborted = true; // 传输错误同样中止序列
            }
        }
        out
    }
}

pub struct StepOutcome {
    pub name: Option<String>,
    pub code: Option<i32>,
    pub state: Option<AuthState>,
    pub skipped: bool,
}

impl<'a> Pending<'a> {
    /// param —— 给当前组挂命名参数
    pub fn param(self, name: &str, value: &str) -> Self {
        let op = &mut *self.0;
        let s = op.current.get_or_insert(Step {
            name: None,
            params: Vec::new(),
            action: Box::new(|_| SSH_AUTH_DENIED),
        });
        s.params.push((name.to_string(), value.to_string()));
        self
    }
    /// 设置本组的方法名（结果记录时随状态一并上报）
    pub fn named(self, name: &str) -> Self {
        let op = &mut *self.0;
        let s = op.current.get_or_insert(Step {
            name: None,
            params: Vec::new(),
            action: Box::new(|_| SSH_AUTH_DENIED),
        });
        s.name = Some(name.to_string());
        self
    }
    /// execute —— 挂动作闭包并完成本组
    pub fn execute<F>(self, f: F)
    where
        F: FnMut(&[(String, String)]) -> i32 + 'static,
    {
        let op = &mut *self.0;
        let s = op.current.get_or_insert(Step {
            name: None,
            params: Vec::new(),
            action: Box::new(|_| SSH_AUTH_DENIED),
        });
        s.action = Box::new(f);
        op.seal();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_method_classification_values() {
        assert!(is_operation_success(SSH_AUTH_SUCCESS)); // 0
        assert!(is_operation_success(SSH_AUTH_PARTIAL)); // 2 —— (2 & !2)==0
        assert!(!is_operation_success(SSH_AUTH_DENIED)); // 1
        assert!(!is_operation_success(SSH_AUTH_INFO)); // 3
        assert!(is_operation_again(4));
        assert!(is_operation_failed(-1));
    }

    #[test]
    fn auth_state_table_values() {
        // 表值：0->0 1->1 2->3 3->2 4->4
        assert_eq!(map_auth_state(0) as i32, 0);
        assert_eq!(map_auth_state(1) as i32, 1);
        assert_eq!(map_auth_state(2) as i32, 3); // PARTIAL 交叉映射
        assert_eq!(map_auth_state(3) as i32, 2); // INFO 交叉映射
        assert_eq!(map_auth_state(4) as i32, 4);
    }

    #[test]
    fn queue_order_and_stop_on_success() {
        let mut op = AuthOperator::new();
        let log = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        for (n, code) in [("none", SSH_AUTH_DENIED), ("publickey", SSH_AUTH_SUCCESS), ("password", SSH_AUTH_DENIED)] {
            let l = log.clone();
            let c = code;
            op.begin().named(n).execute(move |_| {
                l.borrow_mut().push(n);
                c
            });
        }
        let out = op.run();
        // 顺序执行；publickey 成功后 password 被跳过
        assert_eq!(log.borrow().clone(), vec!["none", "publickey"]);
        assert_eq!(out.len(), 3);
        assert!(out[2].skipped);
        assert_eq!(out[1].state, Some(AuthState::Success));
    }

    #[test]
    fn again_retries_same_step() {
        let mut op = AuthOperator::new();
        let counter = std::rc::Rc::new(std::cell::Cell::new(0));
        let c = counter.clone();
        op.begin().named("agent").execute(move |_| {
            let n = c.get();
            c.set(n + 1);
            if n < 2 { SSH_AUTH_AGAIN } else { SSH_AUTH_SUCCESS }
        });
        let out = op.run();
        assert_eq!(counter.get(), 3); // 两次 AGAIN + 一次成功
        assert_eq!(out[0].state, Some(AuthState::Success));
    }

    #[test]
    fn error_aborts_remaining() {
        let mut op = AuthOperator::new();
        op.begin().named("keyboard-interactive").execute(|_| SSH_AUTH_ERROR);
        op.begin().named("password").execute(|_| SSH_AUTH_SUCCESS);
        let out = op.run();
        assert_eq!(out[0].state, Some(AuthState::Error)); // map_auth_state(-1) = -1
        assert!(out[1].skipped); // 剩余队列被跳过
    }

    #[test]
    fn params_attach_to_current_group() {
        let mut op = AuthOperator::new();
        let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let s = seen.clone();
        op.begin()
            .named("publickey")
            .param("passphrase", "hunter2")
            .execute(move |p| {
                s.borrow_mut().extend(p.iter().map(|(k, v)| format!("{k}={v}")));
                SSH_AUTH_SUCCESS
            });
        op.run();
        assert_eq!(seen.borrow().as_slice(), ["passphrase=hunter2"]);
    }
}