//! 传输队列/任务语义 —— 语义重写自 WindTerm 2.6.0（反编译语料为准）
//!
//! 目标二进制 sha256: d26c6406b848d3bdcc97bd3cf87ba8fdb089a0f5e960fb7155a34d341235edd1
//! 证据目录: re-work/decompiled/session/（下文 `符号@entry` 引用）
//!
//! ## 已确证语义清单
//! - TransferTask 字段：+0x30 uuid(QString)、+0x50 状态字节（2=Calculating，
//!   addTask 插入扫描实证）、+0x51 方向字节（2=Upload/3=Download 实证；1/0 推断）、
//!   +0xc2 bit5/bit6（updateDirection 写入的源/目标本地标志）、
//!   +0xc3 bit0=Paused、bit1=Stopped（pauseTask `|1` / resumeTask `&0xfe` / stop `|2` 实证）、
//!   +0xd4 maxFileDescriptors、+0xd8/+0xdc 生效簇大小(源/目标)、
//!   +0xe0/+0xe4 配置簇大小(源/目标)、+0xf0/+0xf8 读/写 Chunk 队列、
//!   +0x114/+0x13c 源/目标 handler 数（setHandlers 两处同写实证）。
//! - `Chunk::Chunk@1001200d0`：+8 = 0x7fffffffffffffff（i64::MAX 哨兵）、
//!   +0x10..+0x30 全 0、+0x48 = -1、+0x58 = false。
//! - `Item::Item@100120230`：+0x10=size、+0x30=原始 size、+0x18=max(1,size)。
//! - `TransferTask::stop@100129b70`：flags|=2；clearChunks 清读队列(+0xf0,true)与
//!   写队列(+0xf8,false)。`isStopped`：bit1 或线程中断请求。
//! - `SuperTransfer::addTask@100426d10`：空任务拒绝；读会话选项
//!   transfer.handlers / transfer.maxHandlers / transfer.maxFileDescriptors →
//!   setHandlers / setMaxFileDescriptors；**插入位置 = 队列中第一个 state != 2
//!   （非 Calculating）的任务之前**（计算中任务保持队首）。
//! - `dispatchTask@100428f20`：工作线程中断请求 → clearTasks；否则从队首找第一个
//!   非暂停（+0xc3 bit0==0）任务出队执行。QTimer timeout→dispatchTask
//!   （startTaskTimer 实证）。
//! - `pauseTask@100429520`：按 uuid 置 bit0；`resumeTask@1004297b0`：清 bit0 +
//!   startTaskTimer + 发 taskResumed；空队列也发 taskResumed。
//! - `cancelTask@100427810`：按 uuid → task.stop() + 出列 + 发 taskCanceled；
//!   队列空 → 停 timer + 发 taskCanceled。
//! - `isAllTasksPaused`：空队列 → true；否则全部 bit0。
//! - `controllCongestion@100125900`：Controller{timer, history QList<pair<double,int>>,
//!   handlers(+0x10), max(+0x14), counter(+0x18), best(+0x20)}；
//!   speed = counter*1000.0/elapsed（items/s；1000.0=DAT_10097eab8 实读）；
//!   首采样 best=speed、handlers=min(handlers+4,max)；
//!   增速（speed-best>ε 且 handlers<max）→ 扩容（步长沿用 +4，分支操作不完整——推断）；
//!   降速（best*0.5-speed>ε 且 非主方向 且 handlers>8）→ 压历史、best=speed、
//!   收缩（0.8=DAT_10097e978 实读；精确回滚顺序反编译不完整——推断为
//!   handlers=max(8, handlers*0.8) 且保留历史）。
//!   0.5=DAT_10097dea8、ε=DBL_EPSILON 实读。
//!   方向守卫：`(uint)(param+1) <= 1` → param ∈ {-1,0} 才处理（实证）。
//!   主方向判定（实证 bVar12）：source控制器 && dir==2，或 target控制器 && dir==3。
//! - `setHandlers@1001292a0`：对 maxHandlers 参数钳位 [1,128]，同写源/目标两处；
//!   >8 且对端 LocalTransfer → 8。
//! - `setMaxFileDescriptors@100129380`：n>0 取 n，否则默认 16（实证 `iVar1=0x10;
//!   if (0 < param_1) iVar1 = param_1;`）。
//! - `createMemoryPool@100126a20`：dir∈{1,2}且源簇配置>0 →
//!   (生效%配置==0 ? u32::MAX : 配置)；dir∈{2,3}且目标簇配置>0 同理；
//!   结果 = 带符号取大（u32::MAX 作 i32=-1 输给具体值 → 具体约束胜出，
//!   双 MAX 才保留 MAX）。
//! - `updateDirection@100120f10`：源/目标 isLocal → 方向 2(上传)/3(下载)；
//!   +0xc2 bit5/bit6 写本地标志；生效簇写入 +0xd8/+0xdc。
//!   （方向 1/0 为 openFile `dir-1<2` / `dir|2==3` 范围检查的推断。）
//! - `openFile@100127660`：读(param==1)取 +0xd8（源生效簇），写取 +0xdc
//!   （目标生效簇）；方向守卫不适用时 0xffffffff。
//! - `Progress`：start 一次性记 start/last 同一时间戳；
//!   speed=(bytes-prev)*1000/Δt → formatBytesAsBinary + "/s"（Δt==0 或回拨无输出）；
//!   average=bytes*1000/(now-start)；leftTime=(now-start)*((total-bytes)/bytes) →
//!   formatSeconds(.,true)，bytes<1 或负估 → "?"；elapsedTime=start==0?0:now-start；
//!   countSpeed="%1 items/s"（0xa522de 实读）。
//! - TransferCenter：`setTransferState@1001065d0` state==1 → 无条件插入；
//!   其余仅当 uuid 已存在：6→删除，else→写入。`onTaskPaused→(3, changed 1)`、
//!   `onTaskResumed→(1, changed 3)`、`removeTask@1001072e0→(5, asyncCall op=0)`。
//!   自旋锁退避（registerTransfer/setTransferState 等同构实证）：尝试 0/1 纯旋、
//!   <16 sched_yield、<32 sleep100ms、否则 sleep10s。
//!   `registerTransfer`：先 tryRemoveInvalidTransfer（剔除死 QPointer）再追加。
//! - `formatBytesAsBinary@100104050` / `formatBytesAsDecimal@1001043b0` /
//!   `formatSeconds@100104770`：与 re/zmodem.rs 同源（此处独立复制以便单文件编译，
//!   集成时可合并去重）。
//! - `SuperTransfer::onAsyncMessage@100427fd0`：操作码 0..0x12（19 个）分发，
//!   case5 落 default；完整映射表待后续批次（TODO）。
//! - `updateTransferProgress@`：从进度 map 取 transfer-uuid + weightPercent 定位
//!   条目更新（细节截断，TODO）。

use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// 常量 / 标志
// ---------------------------------------------------------------------------

/// TransferTask+0x50 状态字节（实证值）
pub mod task_state {
    pub const CALCULATING: u8 = 2; // addTask 扫描 `!= 2` 实证
    pub const UNKNOWN_3: u8 = 3; // updateDirection 早退 `== 3` 实证（含义待办）
}

/// TransferTask+0x51 方向字节
pub mod direction {
    pub const REMOTE_TO_REMOTE: u8 = 0; // 推断
    pub const LOCAL_COPY: u8 = 1; // 推断（openFile `dir-1<2` 用源簇）
    pub const UPLOAD: u8 = 2; // 实证（controllCongestion source&&dir==2）
    pub const DOWNLOAD: u8 = 3; // 实证（controllCongestion target&&dir==3）
}

/// TransferTask+0xc3 标志位（位运算实证）
pub const FLAG_PAUSED: u8 = 1 << 0;
pub const FLAG_STOPPED: u8 = 1 << 1;

/// 证据：addTask 读取的三个会话选项（_PROP_TRANSFER_* 全局符号名）
pub const OPT_TRANSFER_HANDLERS: &str = "transfer.handlers";
pub const OPT_TRANSFER_MAX_HANDLERS: &str = "transfer.maxHandlers";
pub const OPT_TRANSFER_MAX_FILE_DESCRIPTORS: &str = "transfer.maxFileDescriptors";

const SPEED_SCALE: f64 = 1000.0; // DAT_10097eab8 实读
const DECAY: f64 = 0.5; // DAT_10097dea8 实读
const SHRINK: f64 = 0.8; // DAT_10097e978 实读
const EPS: f64 = 2.220446049250313e-16; // DAT_1009825f0 = DBL_EPSILON 实读

// ---------------------------------------------------------------------------
// Chunk / Item
// ---------------------------------------------------------------------------

/// 证据：Chunk::Chunk@1001200d0 字段初值（+0x10..+0x30 语义部分未确证）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chunk {
    pub kind: u32,
    /// +0x08 = 0x7fffffffffffffff
    pub deadline: i64,
    /// +0x10..+0x30：初值 0
    pub offset: i64,
    pub size: i64,
    pub reserved_a: i64,
    pub reserved_b: i64,
    pub reserved_c: i64,
    /// +0x48 = -1
    pub index: i64,
    /// +0x50 = 0
    pub retry: i64,
    /// +0x58 = false
    pub done: bool,
}

impl Chunk {
    pub fn new(kind: u32) -> Self {
        Self {
            kind,
            deadline: i64::MAX,
            offset: 0,
            size: 0,
            reserved_a: 0,
            reserved_b: 0,
            reserved_c: 0,
            index: -1,
            retry: 0,
            done: false,
        }
    }
}

/// 证据：Item::Item@100120230：+0x10=size、+0x30=原始 size、+0x18=max(1,size)
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub kind: i32,
    pub size: i64,
    pub original_size: i64,
    pub step: i64,
    pub extra: u64,
    pub mode: u32,
    pub source: String,
    pub target: String,
}

impl Item {
    pub fn new(kind: i32, source: &str, target: &str, size: i64, extra: u64, mode: u32) -> Self {
        Self {
            kind,
            size,
            original_size: size,
            step: if size > 0 { size } else { 1 },
            extra,
            mode,
            source: source.to_string(),
            target: target.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// TransferTask（单任务模型）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct TransferTask {
    pub uuid: String,
    pub state: u8,
    pub direction: u8,
    pub flags: u8,
    pub max_file_descriptors: i32,
    /// +0x114 / +0x13c：setHandlers 两处同写 → 单字段建模
    pub handlers: i32,
    pub read_chunks: Vec<Chunk>,
    pub write_chunks: Vec<Chunk>,
    pub thread_interrupted: bool,
}

impl TransferTask {
    pub fn new(uuid: impl Into<String>) -> Self {
        Self {
            uuid: uuid.into(),
            state: 0,
            direction: 0,
            flags: 0,
            max_file_descriptors: 16,
            handlers: 0,
            read_chunks: Vec::new(),
            write_chunks: Vec::new(),
            thread_interrupted: false,
        }
    }

    /// 证据：stop@100129b70 —— flags|=2 + clearChunks(读队列)+clearChunks(写队列)
    pub fn stop(&mut self) {
        self.flags |= FLAG_STOPPED;
        self.read_chunks.clear();
        self.write_chunks.clear();
    }

    /// 证据：isStopped —— bit1 或 QThread::isInterruptionRequested
    pub fn is_stopped(&self) -> bool {
        (self.flags & FLAG_STOPPED) != 0 || self.thread_interrupted
    }

    /// 证据：hasChunks —— 读队列非空 或 写队列非空
    pub fn has_chunks(&self) -> bool {
        !self.read_chunks.is_empty() || !self.write_chunks.is_empty()
    }

    /// 证据：setMaxFileDescriptors@100129380 —— n>0 取 n，否则 16
    pub fn set_max_file_descriptors(&mut self, n: i32) {
        self.max_file_descriptors = if n > 0 { n } else { 16 };
    }

    /// 证据：setHandlers@1001292a0 —— clamp [1,128]；>8 且本地 FS → 8
    pub fn set_handlers(&mut self, max_handlers: i32, local_fs: bool) {
        self.handlers = clamp_handlers(max_handlers, local_fs);
    }

    pub fn pause(&mut self) {
        self.flags |= FLAG_PAUSED;
    }
    pub fn resume(&mut self) {
        self.flags &= !FLAG_PAUSED;
    }
    pub fn is_paused(&self) -> bool {
        (self.flags & FLAG_PAUSED) != 0
    }
}

/// 证据：setHandlers 钳位（0x80=128 上限、1 下限、本地 FS 时 >8 收敛到 8）
pub fn clamp_handlers(v: i32, local_fs: bool) -> i32 {
    let mut h = v;
    if h > 128 {
        h = 128;
    }
    if h < 1 {
        h = 1;
    }
    if h > 8 && local_fs {
        h = 8;
    }
    h
}

/// 证据：updateDirection@100120f10 —— 源/目标本地性 → 方向
/// （2/3 实证；1/0 为 openFile 范围检查推断）
pub fn update_direction(src_local: bool, tgt_local: bool) -> u8 {
    match (src_local, tgt_local) {
        (true, false) => direction::UPLOAD,
        (false, true) => direction::DOWNLOAD,
        (true, true) => direction::LOCAL_COPY,
        (false, false) => direction::REMOTE_TO_REMOTE,
    }
}

/// 证据：updateDirection 对 +0xc2 bit5/bit6 的写入（源/目标本地标志）
pub fn direction_local_flags(flags_c2: u8, src_local: bool, tgt_local: bool) -> u8 {
    let mut f = flags_c2 & !(1 << 5) & !(1 << 6);
    if src_local {
        f |= 1 << 5;
    }
    if tgt_local {
        f |= 1 << 6;
    }
    f
}

// ---------------------------------------------------------------------------
// 内存池块大小 / 打开文件的簇限制
// ---------------------------------------------------------------------------

/// 证据：createMemoryPool@100126a20 ——
/// dir∈{1,2}且 src_cfg>0 → (src_eff % src_cfg == 0 ? u32::MAX : src_cfg)；
/// dir∈{2,3}且 tgt_cfg>0 → 同理；结果带符号取大（MAX 视为无约束）。
pub fn memory_pool_block_size(
    direction: u8,
    src_cfg: u32,
    tgt_cfg: u32,
    src_eff: u32,
    tgt_eff: u32,
) -> u32 {
    let mut a = u32::MAX;
    if (direction == 1 || direction == 2) && src_cfg > 0 {
        a = if src_eff % src_cfg == 0 { u32::MAX } else { src_cfg };
    }
    let mut b = u32::MAX;
    if (direction == 2 || direction == 3) && tgt_cfg > 0 {
        b = if tgt_eff % tgt_cfg == 0 { u32::MAX } else { tgt_cfg };
    }
    if (a as i32) < (b as i32) {
        b
    } else {
        a
    }
}

/// 证据：openFile@100127660 —— 读取源生效簇(+0xd8)、写取目标生效簇(+0xdc)，
/// 方向守卫不适用 → 0xffffffff
pub fn open_file_cluster(
    direction: u8,
    src_cfg: u32,
    tgt_cfg: u32,
    src_eff: u32,
    tgt_eff: u32,
    for_read: bool,
) -> u32 {
    if for_read {
        if (direction == 1 || direction == 2) && src_cfg > 0 {
            src_eff
        } else {
            u32::MAX
        }
    } else if (direction == 2 || direction == 3) && tgt_cfg > 0 {
        tgt_eff
    } else {
        u32::MAX
    }
}

// ---------------------------------------------------------------------------
// Controller —— 自适应并发（controllCongestion@100125900）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Controller {
    /// +0x10 当前 handler 数
    pub handlers: i32,
    /// +0x14 上限
    pub max_handlers: i32,
    /// +0x18 本窗口完成计数（调用方在 chunk 完成时 +1）
    pub counter: i32,
    /// +0x20 最佳速率
    pub best: f64,
    /// history：QList<std::pair<double,int>>（降速时压入）
    pub history: Vec<(f64, i32)>,
}

impl Controller {
    /// 证据：Controller::Controller —— 全零
    pub fn new() -> Self {
        Self { handlers: 0, max_handlers: 0, counter: 0, best: 0.0, history: Vec::new() }
    }

    /// 采样并调整。返回 Some(新 handlers) = 有调整；None = 无调整。
    /// - `direction`：实证守卫 (uint)(direction+1) <= 1 → 仅 -1/0 处理，其余 no-op。
    /// - `primary`：本控制器是否属于任务主方向（source&&dir==2 || target&&dir==3）。
    /// - `elapsed_ms`：QElapsedTimer::elapsed()。
    pub fn on_sample(&mut self, direction: i32, primary: bool, elapsed_ms: i64) -> Option<i32> {
        if (direction as u32).wrapping_add(1) > 1 {
            return None;
        }
        let elapsed = if elapsed_ms > 0 { elapsed_ms } else { 1 };
        let speed = self.counter as f64 * SPEED_SCALE / elapsed as f64;
        if self.best == 0.0 {
            // 首采样（实证）：best=speed；handlers=min(handlers+4, max)
            self.best = speed;
            self.handlers = std::cmp::min(self.handlers + 4, self.max_handlers);
            return Some(self.handlers);
        }
        if speed - self.best > EPS && self.handlers < self.max_handlers {
            // 增速扩容（步长 +4 沿用首分支——推断）
            self.handlers = std::cmp::min(self.handlers + 4, self.max_handlers);
            return Some(self.handlers);
        }
        if self.best * DECAY - speed > EPS && !primary && self.handlers > 8 {
            // 降速：压历史（实证 push pair(best, handlers)）→ best=speed →
            // 收缩 handlers（0.8 实读；回滚细节反编译不完整——推断）
            self.history.push((self.best, self.handlers));
            self.best = speed;
            self.handlers = std::cmp::max(8, (self.handlers as f64 * SHRINK) as i32);
            return Some(self.handlers);
        }
        None
    }
}

impl Default for Controller {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 队列（SuperTransfer 模型）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueueEvent {
    TaskResumed(String),
    TaskCanceled(String),
}

#[derive(Clone, Debug)]
pub struct TransferQueue {
    pub tasks: Vec<TransferTask>,
    pub timer_active: bool,
}

impl TransferQueue {
    pub fn new() -> Self {
        Self { tasks: Vec::new(), timer_active: false }
    }

    /// 证据：addTask@100426d10 —— 空任务拒绝；选项 handlers/maxHandlers/maxFd
    /// 配置进任务；插入到第一个非 Calculating 任务之前（计算中任务保队首）。
    pub fn add_task(
        &mut self,
        task: Option<TransferTask>,
        max_handlers: i32,
        max_fd: i32,
        local_fs: bool,
    ) -> bool {
        let mut task = match task {
            Some(t) => t,
            None => return false,
        };
        task.set_handlers(max_handlers, local_fs);
        task.set_max_file_descriptors(max_fd);
        let idx = self
            .tasks
            .iter()
            .position(|t| t.state != task_state::CALCULATING)
            .unwrap_or(self.tasks.len());
        self.tasks.insert(idx, task);
        true
    }

    /// 证据：dispatchTask@100428f20 —— 中断 → 清队列停 timer；否则队首起第一个
    /// 非暂停任务出队。返回被派发任务的 uuid。
    pub fn dispatch(&mut self, interrupted: bool) -> Option<String> {
        if interrupted {
            self.tasks.clear();
            self.timer_active = false;
            return None;
        }
        let idx = self.tasks.iter().position(|t| !t.is_paused())?;
        let task = self.tasks.remove(idx);
        Some(task.uuid)
    }

    /// 证据：pauseTask@100429520 —— 按 uuid 置 bit0（找到才动作）
    pub fn pause_task(&mut self, uuid: &str) -> bool {
        if let Some(t) = self.tasks.iter_mut().find(|t| t.uuid == uuid) {
            t.pause();
            return true;
        }
        false
    }

    /// 证据：resumeTask@1004297b0 —— 清 bit0 + startTaskTimer + 发 Resumed；
    /// 空队列也发 Resumed。
    pub fn resume_task(&mut self, uuid: &str) -> Option<QueueEvent> {
        if self.tasks.is_empty() {
            return Some(QueueEvent::TaskResumed(uuid.to_string()));
        }
        if let Some(t) = self.tasks.iter_mut().find(|t| t.uuid == uuid) {
            t.resume();
            self.timer_active = true;
            return Some(QueueEvent::TaskResumed(uuid.to_string()));
        }
        None
    }

    /// 证据：cancelTask@100427810 —— 命中 → stop + 出列 + Canceled；
    /// 空队列 → 停 timer + Canceled；未命中（队列非空）→ 无事件。
    pub fn cancel_task(&mut self, uuid: &str) -> Option<QueueEvent> {
        if let Some(idx) = self.tasks.iter().position(|t| t.uuid == uuid) {
            self.tasks[idx].stop();
            self.tasks.remove(idx);
            return Some(QueueEvent::TaskCanceled(uuid.to_string()));
        }
        if self.tasks.is_empty() {
            self.timer_active = false;
            return Some(QueueEvent::TaskCanceled(uuid.to_string()));
        }
        None
    }

    /// 证据：isAllTasksPaused —— 空 → true；否则全部 bit0
    pub fn is_all_paused(&self) -> bool {
        self.tasks.iter().all(|t| t.is_paused())
    }

    /// 证据：isTaskPaused —— 按 uuid 查 bit0
    pub fn is_task_paused(&self, uuid: &str) -> bool {
        self.tasks
            .iter()
            .find(|t| t.uuid == uuid)
            .map(|t| t.is_paused())
            .unwrap_or(false)
    }
}

impl Default for TransferQueue {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// TransferCenter 状态注册表
// ---------------------------------------------------------------------------

/// 实证的状态值（事件→状态映射）
pub mod center_state {
    pub const RUNNING: u32 = 1; // onTaskResumed→1 实证
    pub const PAUSED: u32 = 3; // onTaskPaused→3 实证
    pub const REMOVED: u32 = 5; // removeTask→5 实证
    pub const FINISHED: u32 = 6; // setTransferState(6) → 从表删除 实证
}

/// 证据：setTransferState@1001065d0 —— state==1 无条件插入；
/// 其余仅当 uuid 已存在：6→删除，else→写入。
pub fn apply_transfer_state(states: &mut BTreeMap<String, u32>, uuid: &str, state: u32) {
    if state == center_state::RUNNING {
        states.insert(uuid.to_string(), state);
        return;
    }
    if states.contains_key(uuid) {
        if state == center_state::FINISHED {
            states.remove(uuid);
        } else {
            states.insert(uuid.to_string(), state);
        }
    }
}

/// 证据：onTaskPaused/onTaskResumed —— setTransferState + transferChanged(kind)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CenterEvent {
    Changed(u32),
}

pub fn on_task_paused(states: &mut BTreeMap<String, u32>, uuid: &str) -> CenterEvent {
    apply_transfer_state(states, uuid, center_state::PAUSED);
    CenterEvent::Changed(1)
}

pub fn on_task_resumed(states: &mut BTreeMap<String, u32>, uuid: &str) -> CenterEvent {
    apply_transfer_state(states, uuid, center_state::RUNNING);
    CenterEvent::Changed(3)
}

/// 证据：removeTask@1001072e0 —— 找到 transfer → setTransferState(5) + asyncCall(op=0)
pub fn remove_task(
    states: &mut BTreeMap<String, u32>,
    uuid: &str,
    transfer_exists: bool,
) -> Option<u32> {
    if transfer_exists {
        apply_transfer_state(states, uuid, center_state::REMOVED);
        return Some(0);
    }
    None
}

/// 证据：registerTransfer —— 先剔除死 QPointer（None），再追加（含空引用也入列，
/// 下次注册时被剔除）。
pub fn register_transfer(transfers: &mut Vec<Option<u32>>, id: Option<u32>) {
    transfers.retain(|t| t.is_some());
    transfers.push(id);
}

/// 证据：TransferCenter 自旋锁退避（多处同构实证）：
/// 尝试 0/1 → 纯自旋；2..15 → sched_yield；16..31 → sleep 100ms；≥32 → sleep 10s。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockWait {
    Spin,
    Yield,
    Sleep100Ms,
    Sleep10S,
}

pub fn lock_backoff(attempt: u32) -> LockWait {
    if attempt < 2 {
        LockWait::Spin
    } else if attempt < 0x10 {
        LockWait::Yield
    } else if attempt < 0x20 {
        LockWait::Sleep100Ms
    } else {
        LockWait::Sleep10S
    }
}

// ---------------------------------------------------------------------------
// 格式化（与 re/zmodem.rs 同源证据，独立复制以便单文件编译）
// ---------------------------------------------------------------------------

/// 证据：formatBytesAsBinary@100104050（阈值 0x400/0x100000/0x40000000，
/// 乘数 2^-10/2^-20/2^-30 实读；小数位 2 —— 推断）
pub fn format_bytes_binary(bytes: i64) -> String {
    const KIB: f64 = 0.0009765625;
    const MIB: f64 = 9.5367431640625e-07;
    const GIB: f64 = 9.313225746154785e-10;
    let v = bytes as f64;
    if bytes >= 0x40000000 {
        format!("{:.2} GiB", v * GIB)
    } else if bytes >= 0x100000 {
        format!("{:.2} MiB", v * MIB)
    } else if bytes >= 0x400 {
        format!("{:.2} KiB", v * KIB)
    } else {
        format!("{} Bytes", bytes)
    }
}

/// 证据：formatBytesAsDecimal@1001043b0（阈值 1000/1e6/1e9，除数实读）
pub fn format_bytes_decimal(bytes: i64) -> String {
    let v = bytes as f64;
    if bytes >= 1_000_000_000 {
        format!("{:.2} GB", v / 1e9)
    } else if bytes >= 1_000_000 {
        format!("{:.2} MB", v / 1e6)
    } else if bytes >= 1000 {
        format!("{:.2} KB", v / 1000.0)
    } else {
        format!("{}", bytes)
    }
}

/// 证据：formatSeconds@100104770（"%1:%2:%3"，分秒宽 2，with_ms 加 ".%1" 宽 3，
/// 总秒 <36000 前插 '0'）
pub fn format_seconds(ms: i64, with_ms: bool) -> String {
    let sec = ms / 1000;
    let mut s = format!("{}:{:02}:{:02}", sec / 3600, (sec % 3600) / 60, sec % 60);
    if with_ms {
        s.push_str(&format!(".{:03}", (ms % 1000).abs()));
    }
    if sec < 36000 {
        s.insert(0, '0');
    }
    s
}

// ---------------------------------------------------------------------------
// Progress（TransferTask::Progress）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Progress {
    pub bytes: i64,
    pub total: i64,
    /// +0x48 起始时间戳（0 = 未启动）
    pub start_ms: i64,
    /// +0x40 上次采样时间戳
    pub last_sample_ms: i64,
    /// +0x28 上次采样字节
    pub last_sample_bytes: i64,
}

impl Progress {
    pub fn new() -> Self {
        Self { bytes: 0, total: 0, start_ms: 0, last_sample_ms: 0, last_sample_bytes: 0 }
    }

    /// 证据：Progress::start —— 仅当未启动时记 start 与 last 同一时间戳
    pub fn start(&mut self, now_ms: i64) {
        if self.start_ms == 0 {
            self.start_ms = now_ms;
            self.last_sample_ms = now_ms;
        }
    }

    /// 证据：Progress::speed@100120820 —— (bytes-prev)*1000/Δt；
    /// Δt==0 或时钟回拨 → None；随后刷新上次采样。
    pub fn speed_string(&mut self, now_ms: i64) -> Option<String> {
        let dt = now_ms - self.last_sample_ms;
        if dt == 0 || now_ms < self.last_sample_ms {
            return None;
        }
        let v = ((self.bytes - self.last_sample_bytes) as f64 * SPEED_SCALE / dt as f64) as i64;
        self.last_sample_ms = now_ms;
        self.last_sample_bytes = self.bytes;
        Some(format!("{}/s", format_bytes_binary(v)))
    }

    /// 证据：Progress::averageSpeed —— bytes*1000/(now-start)
    pub fn average_speed_string(&self, now_ms: i64) -> Option<String> {
        let dt = now_ms - self.start_ms;
        if dt == 0 || now_ms < self.start_ms {
            return None;
        }
        let v = (self.bytes as f64 * SPEED_SCALE / dt as f64) as i64;
        Some(format!("{}/s", format_bytes_binary(v)))
    }

    /// 证据：Progress::leftTime —— bytes<1 → "?"；
    /// est=(now-start)*((total-bytes)/bytes)；est≥0 → formatSeconds(est,true) 否则 "?"
    pub fn left_time(&self, now_ms: i64) -> String {
        if self.bytes < 1 {
            return "?".to_string();
        }
        let est = ((now_ms - self.start_ms) as f64
            * ((self.total - self.bytes) as f64 / self.bytes as f64)) as i64;
        if est > -1 {
            format_seconds(est, true)
        } else {
            "?".to_string()
        }
    }

    /// 证据：Progress::elapsedTime —— start==0 → 0；formatSeconds(.,true)
    pub fn elapsed_time(&self, now_ms: i64) -> String {
        let dt = if self.start_ms == 0 { 0 } else { now_ms - self.start_ms };
        format_seconds(dt, true)
    }

    /// 证据：Progress::countSpeed —— "%1 items/s"（0xa522de 实读）
    pub fn count_speed_string(items_per_sec: i64) -> String {
        format!("{} items/s", items_per_sec)
    }
}

impl Default for Progress {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 测试（断言全部来自伪代码行为）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_defaults_match_ctor() {
        // 证据 Chunk::Chunk：+8=LLONG_MAX、+0x48=-1、+0x58=false
        let c = Chunk::new(1);
        assert_eq!(c.deadline, i64::MAX);
        assert_eq!(c.index, -1);
        assert!(!c.done);
        assert_eq!(
            (c.offset, c.size, c.reserved_a, c.reserved_b, c.reserved_c, c.retry),
            (0, 0, 0, 0, 0, 0)
        );
    }

    #[test]
    fn item_step_is_max_of_one_and_size() {
        // 证据 Item::Item：+0x18 = (size>0?size:1)、+0x30 = size
        let i = Item::new(0, "a", "b", 4096, 0, 0o644);
        assert_eq!(i.step, 4096);
        assert_eq!(i.original_size, 4096);
        let z = Item::new(0, "a", "b", 0, 0, 0);
        assert_eq!(z.step, 1);
    }

    #[test]
    fn stop_and_flags() {
        // 证据 stop/isStopped/pause/resume 位运算
        let mut t = TransferTask::new("u1");
        t.read_chunks.push(Chunk::new(0));
        t.write_chunks.push(Chunk::new(1));
        assert!(t.has_chunks());
        t.pause();
        assert!(t.is_paused());
        t.resume();
        assert!(!t.is_paused());
        t.stop();
        assert!(t.is_stopped());
        assert!(!t.has_chunks()); // 两队列清空
        let mut t2 = TransferTask::new("u2");
        t2.thread_interrupted = true;
        assert!(t2.is_stopped()); // 线程中断也算
    }

    #[test]
    fn handlers_clamps() {
        // 证据 setHandlers：[1,128]，本地 FS >8 → 8
        assert_eq!(clamp_handlers(0, false), 1);
        assert_eq!(clamp_handlers(200, false), 128);
        assert_eq!(clamp_handlers(16, false), 16);
        assert_eq!(clamp_handlers(16, true), 8);
        assert_eq!(clamp_handlers(8, true), 8);
        // 证据 setMaxFileDescriptors：n>0 取 n，否则 16
        let mut t = TransferTask::new("x");
        t.set_max_file_descriptors(0);
        assert_eq!(t.max_file_descriptors, 16);
        t.set_max_file_descriptors(-3);
        assert_eq!(t.max_file_descriptors, 16);
        t.set_max_file_descriptors(5);
        assert_eq!(t.max_file_descriptors, 5);
        t.set_max_file_descriptors(20);
        assert_eq!(t.max_file_descriptors, 20);
    }

    #[test]
    fn direction_and_cluster_rules() {
        assert_eq!(update_direction(true, false), direction::UPLOAD);
        assert_eq!(update_direction(false, true), direction::DOWNLOAD);
        // +0xc2 bit5/bit6
        assert_eq!(direction_local_flags(0, true, false), 1 << 5);
        assert_eq!(direction_local_flags(0xFF, true, true), 0xFF);
        // 证据 createMemoryPool
        // src: 4096%4096==0→MAX；tgt: 4096%8192!=0→8192；MAX 输给具体值
        assert_eq!(memory_pool_block_size(2, 4096, 8192, 4096, 4096), 8192);
        // src: 6144%4096!=0→4096；tgt: 8192%8192==0→MAX；取大(带符号)→4096
        assert_eq!(memory_pool_block_size(2, 4096, 8192, 6144, 8192), 4096);
        // dir=1 目标不参与：src 6144%4096!=0 → 4096
        assert_eq!(memory_pool_block_size(1, 4096, 8192, 6144, 4096), 4096);
        // dir=3 源不参与：tgt 4096%8192!=0 → 8192
        assert_eq!(memory_pool_block_size(3, 4096, 8192, 6144, 4096), 8192);
        // 配置 ≤0 → 双 MAX
        assert_eq!(memory_pool_block_size(2, 0, 0, 6144, 4096), u32::MAX);
        // 证据 openFile：读=源生效簇（守卫 dir∈{1,2}），写=目标生效簇（dir∈{2,3}）
        assert_eq!(open_file_cluster(2, 4096, 8192, 4096, 8192, true), 4096);
        assert_eq!(open_file_cluster(2, 4096, 8192, 4096, 8192, false), 8192);
        assert_eq!(open_file_cluster(3, 4096, 8192, 4096, 8192, true), u32::MAX); // 下载读远端不用源簇
        assert_eq!(open_file_cluster(1, 4096, 8192, 4096, 8192, false), u32::MAX);
    }

    #[test]
    fn controller_first_sample_and_growth() {
        // 证据：首采样 best=speed、handlers=min(+4,max)
        let mut c = Controller::new();
        c.max_handlers = 20;
        c.handlers = 4;
        c.counter = 10;
        let r = c.on_sample(-1, true, 1000); // speed = 10*1000/1000 = 10/s
        assert_eq!(r, Some(8));
        assert_eq!(c.best, 10.0);
        // 增速：speed(20)-best(10)>ε 且 handlers(8)<max → +4
        c.counter = 20;
        assert_eq!(c.on_sample(-1, true, 1000), Some(12));
        // 封顶 max_handlers
        c.handlers = 18;
        c.counter = 40;
        assert_eq!(c.on_sample(-1, true, 1000), Some(20));
        // 方向守卫：dir=1 不处理（(uint)(1+1)>1 实证）
        let before = c.handlers;
        assert_eq!(c.on_sample(1, true, 1000), None);
        assert_eq!(c.handlers, before);
    }

    #[test]
    fn controller_degradation_gates() {
        // 降速三条件：speed < best*0.5 - ε、非主方向、handlers > 8
        let mut c = Controller::new();
        c.max_handlers = 64;
        c.handlers = 16;
        c.counter = 100;
        c.on_sample(0, false, 1000); // 首采样 best=100、handlers=20
        assert_eq!(c.best, 100.0);
        c.handlers = 16;
        // 主方向 → 不降
        c.counter = 10; // speed=10 < 50
        assert_eq!(c.on_sample(0, true, 1000), None);
        // handlers ≤ 8 → 不降
        c.handlers = 8;
        assert_eq!(c.on_sample(0, false, 1000), None);
        // 非主方向 & >8 → 降 + 历史
        c.handlers = 16;
        let r = c.on_sample(0, false, 1000);
        assert!(r.is_some());
        let h = r.unwrap();
        assert!(h < 16 && h >= 8);
        assert_eq!(c.history.len(), 1);
        assert_eq!(c.history[0], (100.0, 16));
        assert_eq!(c.best, 10.0);
    }

    #[test]
    fn queue_insertion_keeps_calculating_first() {
        // 证据 addTask：插到第一个非 Calculating 之前
        let mut q = TransferQueue::new();
        let mut calc = TransferTask::new("c1");
        calc.state = task_state::CALCULATING;
        q.tasks.push(calc);
        let mut calc2 = TransferTask::new("c2");
        calc2.state = task_state::CALCULATING;
        q.tasks.push(calc2);
        q.tasks.push(TransferTask::new("r1"));
        assert!(q.add_task(Some(TransferTask::new("n1")), 16, 16, false));
        let order: Vec<String> = q.tasks.iter().map(|t| t.uuid.clone()).collect();
        assert_eq!(order, vec!["c1", "c2", "n1", "r1"]);
        // 空任务拒绝
        assert!(!q.add_task(None, 16, 16, false));
        // 选项进入任务：maxFd=16
        assert_eq!(q.tasks[2].max_file_descriptors, 16);
        assert_eq!(q.tasks[2].handlers, 16);
    }

    #[test]
    fn queue_dispatch_skips_paused_and_interrupt_clears() {
        let mut q = TransferQueue::new();
        let mut a = TransferTask::new("a");
        a.pause();
        q.tasks.push(a);
        q.tasks.push(TransferTask::new("b"));
        q.tasks.push(TransferTask::new("c"));
        assert_eq!(q.dispatch(false).as_deref(), Some("b")); // 跳过暂停的 a
        assert_eq!(q.tasks.len(), 2);
        // 中断 → 清队列
        assert_eq!(q.dispatch(true), None);
        assert!(q.tasks.is_empty());
        assert!(!q.timer_active);
    }

    #[test]
    fn queue_pause_resume_cancel_events() {
        let mut q = TransferQueue::new();
        q.tasks.push(TransferTask::new("t1"));
        q.tasks.push(TransferTask::new("t2"));
        assert!(q.pause_task("t1"));
        assert!(q.is_task_paused("t1"));
        assert!(!q.is_all_paused());
        assert!(q.pause_task("t2"));
        assert!(q.is_all_paused());
        assert!(!q.pause_task("ghost"));
        // resume t1 → 事件 + timer
        assert_eq!(q.resume_task("t1"), Some(QueueEvent::TaskResumed("t1".into())));
        assert!(q.timer_active);
        assert!(!q.is_all_paused());
        // cancel 命中 → stop+remove+事件
        assert_eq!(q.cancel_task("t2"), Some(QueueEvent::TaskCanceled("t2".into())));
        assert_eq!(q.tasks.len(), 1);
        // cancel 未命中（队列非空）→ 无事件
        assert_eq!(q.cancel_task("zz"), None);
        // cancel 空队列 → 事件 + 停 timer
        assert_eq!(q.cancel_task("t1"), Some(QueueEvent::TaskCanceled("t1".into())));
        assert_eq!(q.cancel_task("t1"), Some(QueueEvent::TaskCanceled("t1".into())));
        assert!(!q.timer_active);
        // 空队列 resume 也发事件
        assert_eq!(q.resume_task("x"), Some(QueueEvent::TaskResumed("x".into())));
        // 空队列 is_all_paused → true（实证初值 1）
        assert!(q.is_all_paused());
    }

    #[test]
    fn state_registry_semantics() {
        // 证据 setTransferState：1 无条件插入；其余仅当已存在
        let mut m: BTreeMap<String, u32> = BTreeMap::new();
        apply_transfer_state(&mut m, "a", center_state::PAUSED);
        assert!(m.is_empty()); // 未先注册 → 3 不插入
        apply_transfer_state(&mut m, "a", center_state::RUNNING);
        assert_eq!(m["a"], 1);
        apply_transfer_state(&mut m, "a", center_state::PAUSED);
        assert_eq!(m["a"], 3);
        apply_transfer_state(&mut m, "a", center_state::FINISHED);
        assert!(!m.contains_key("a")); // 6 → 删除
        // 事件映射
        let mut m2: BTreeMap<String, u32> = BTreeMap::new();
        m2.insert("b".into(), 1);
        assert_eq!(on_task_paused(&mut m2, "b"), CenterEvent::Changed(1));
        assert_eq!(m2["b"], 3);
        assert_eq!(on_task_resumed(&mut m2, "b"), CenterEvent::Changed(3));
        assert_eq!(m2["b"], 1);
        // removeTask → 5 + async op 0；不存在 → 无操作
        assert_eq!(remove_task(&mut m2, "b", true), Some(0));
        assert_eq!(m2["b"], 5);
        assert_eq!(remove_task(&mut m2, "ghost", false), None);
    }

    #[test]
    fn register_purges_dead_pointers() {
        // 证据 registerTransfer：tryRemoveInvalidTransfer 先行，再追加
        let mut v = vec![Some(1), None, Some(2)];
        register_transfer(&mut v, Some(3));
        assert_eq!(v, vec![Some(1), Some(2), Some(3)]);
        // 追加空引用：本次入列，下次剔除（实证 append 在 null 分支之后仍执行）
        register_transfer(&mut v, None);
        register_transfer(&mut v, Some(9));
        assert_eq!(v, vec![Some(1), Some(2), Some(3), Some(9)]);
    }

    #[test]
    fn lock_backoff_schedule() {
        // 证据退避：0/1 spin；<16 yield；<32 100ms；else 10s
        assert_eq!(lock_backoff(0), LockWait::Spin);
        assert_eq!(lock_backoff(1), LockWait::Spin);
        assert_eq!(lock_backoff(2), LockWait::Yield);
        assert_eq!(lock_backoff(15), LockWait::Yield);
        assert_eq!(lock_backoff(16), LockWait::Sleep100Ms);
        assert_eq!(lock_backoff(31), LockWait::Sleep100Ms);
        assert_eq!(lock_backoff(32), LockWait::Sleep10S);
        assert_eq!(lock_backoff(1000), LockWait::Sleep10S);
    }

    #[test]
    fn format_helpers_match_evidence() {
        assert_eq!(format_bytes_binary(1023), "1023 Bytes");
        assert_eq!(format_bytes_binary(1024), "1.00 KiB");
        assert_eq!(format_bytes_binary(1 << 30), "1.00 GiB");
        assert_eq!(format_bytes_decimal(999), "999");
        assert_eq!(format_bytes_decimal(1000), "1.00 KB");
        assert_eq!(format_bytes_decimal(1_500_000_000), "1.50 GB");
        assert_eq!(format_seconds(1000, false), "00:00:01");
        assert_eq!(format_seconds(3_661_000, true), "01:01:01.000");
        assert_eq!(format_seconds(36_000_000, false), "10:00:00");
    }

    #[test]
    fn progress_formulas() {
        let mut p = Progress::new();
        // start 幂等（仅未启动时写）
        p.start(1000);
        p.start(5000);
        assert_eq!(p.start_ms, 1000);
        assert_eq!(p.last_sample_ms, 1000);
        // speed：(2000-0)*1000/(3000-1000) = 1000 B/s → "1000 Bytes/s"
        p.bytes = 2000;
        assert_eq!(p.speed_string(3000).as_deref(), Some("1000 Bytes/s"));
        // Δt==0 → None
        assert_eq!(p.speed_string(3000), None);
        // average：2000*1000/2000ms = 1000
        assert_eq!(p.average_speed_string(3000).as_deref(), Some("1000 Bytes/s"));
        // leftTime：bytes<1 → "?"
        let q = Progress { bytes: 0, total: 100, start_ms: 0, ..Progress::new() };
        assert_eq!(q.left_time(1000), "?");
        // 50/100、用时 1000ms → 剩 1000ms → "00:00:01.000"
        let r = Progress { bytes: 50, total: 100, start_ms: 100, ..Progress::new() };
        assert_eq!(r.left_time(1100), "00:00:01.000");
        // 已超总量（total 小于 bytes）→ 负估 → "?"
        let neg = Progress { bytes: 10, total: 5, start_ms: 0, ..Progress::new() };
        assert_eq!(neg.left_time(1000), "?");
        // elapsedTime：未启动 → 0
        assert_eq!(Progress::new().elapsed_time(9999), "00:00:00.000");
        // countSpeed 模板
        assert_eq!(Progress::count_speed_string(7), "7 items/s");
    }
}
