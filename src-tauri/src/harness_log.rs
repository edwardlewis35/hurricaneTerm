//! Durable, local-only event journal for the operations assistant.
//!
//! Every acknowledged append has passed `sync_data`; a caller must treat a write
//! error as indeterminate and read the journal before deciding what to do next.
//! A completed tool dispatch is never inferred from a missing result. Recovery
//! policy belongs to the harness, not to this storage layer.
//!
//! Unix advisory file locks and Windows exclusive file sharing protect scans
//! and appends from other cooperating application instances. Lock contention
//! fails immediately and is retryable; the async UI never waits on a file lock.
//!
//! Secret-looking *field names* are removed recursively. Arbitrary text, command
//! output, or a URL may itself contain a secret; this module cannot identify such
//! strings. Callers must never pass API configuration/keys into journal payloads.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const FORMAT: &str = "hurricane-harness-log";
const VERSION: u32 = 1;
const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_PAYLOAD: usize = 256 * 1024;
const MAX_METADATA: usize = 64 * 1024;
const MAX_EVENTS: u64 = 4096;
const MAX_SESSIONS: usize = 256;
const LIST_LIMIT: usize = 100;
const MAX_LINE: usize = MAX_PAYLOAD + 2048;
const MAX_DEPTH: usize = 64;
const DISPATCH_BYTE_RESERVE: u64 = MAX_PAYLOAD as u64 + 4096;
const DISPATCH_EVENT_RESERVE: u64 = 3;
const UNAVAILABLE_GOAL: &str = "此记录暂时无法读取，请查看详情或稍后重试";
const UNAVAILABLE_ERROR: &str = "事件日志暂时不可读，无法安全恢复；请查看详情或稍后重试";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionEvent {
    pub seq: u64,
    pub kind: String,
    pub data: Value,
    pub at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub metadata: Value,
    pub events: Vec<SessionEvent>,
    pub interrupted_tail: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub metadata: Value,
    pub event_count: u64,
    pub updated_at: u64,
    pub interrupted_tail: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    format: String,
    version: u32,
    id: String,
    metadata: Value,
    created_at: u64,
}

/// Store instances share a process-wide gate, including independently created
/// instances for the same directory. A cancelled async caller cannot release
/// the gate while its blocking write is still running.
#[derive(Clone)]
pub struct HarnessStore {
    root: PathBuf,
}

fn store_gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

impl HarnessStore {
    pub fn new(root: PathBuf) -> Self { Self { root } }

    async fn blocking<T, F>(&self, operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(RootHandle) -> Result<T, String> + Send + 'static,
    {
        let path = self.root.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = store_gate().lock().map_err(|_| "AI 事件日志锁已损坏".to_string())?;
            operation(RootHandle::open(&path)?)
        }).await.map_err(|_| "AI 事件日志后台任务失败".to_string())?
    }

    pub async fn create(&self, id: String, metadata: Value) -> Result<SessionRecord, String> {
        validate_id(&id)?;
        let metadata = clean_value(metadata, MAX_METADATA, "会话元信息")?;
        self.blocking(move |root| {
            if root.session_ids()?.len() >= MAX_SESSIONS {
                return Err("AI 事件日志最多保存 256 个会话，请先归档旧会话".into());
            }
            let header = Header {
                format: FORMAT.into(), version: VERSION, id: id.clone(),
                metadata: metadata.clone(), created_at: now()?,
            };
            let bytes = encode_line(&header)?;
            let mut file = root.open_file(&id, true)?;
            let result = file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(io_error)
                .and_then(|_| root.sync_directory());
            if let Err(error) = result {
                // This name was created exclusively by this operation. Do not
                // leave a partial header that appears to be a recoverable log.
                drop(file);
                let _ = root.remove_file(&id);
                return Err(error);
            }
            Ok(SessionRecord { id, metadata, events: Vec::new(), interrupted_tail: false })
        }).await
    }

    /// `expected_seq` is the last sequence the caller has observed (zero for a
    /// new session). Conflicts never modify the file, including a crash tail.
    /// Each append rescans the complete bounded journal (O(n), hence O(n²)
    /// cumulative work for n appends); no cached offset can bypass validation.
    pub async fn append(&self, id: String, expected_seq: u64, kind: String, data: Value) -> Result<SessionEvent, String> {
        validate_id(&id)?;
        validate_kind(&kind)?;
        let data = clean_value(data, MAX_PAYLOAD, "事件内容")?;
        self.blocking(move |root| {
            let mut file = root.open_file(&id, false)?;
            let parsed = scan(&mut file, &id, false)?;
            if parsed.last_seq != expected_seq {
                return Err(format!("AI 事件日志序号冲突：预期 {expected_seq}，当前 {}；请重新读取会话", parsed.last_seq));
            }
            if parsed.last_seq >= MAX_EVENTS {
                return Err("单个 AI 会话最多保存 4096 条事件".into());
            }
            let event = SessionEvent { seq: parsed.last_seq + 1, kind, data, at: now()? };
            let bytes = encode_line(&event)?;
            if parsed.good_len + bytes.len() as u64 > MAX_FILE {
                return Err("单个 AI 事件日志不能超过 16 MiB".into());
            }
            // Refuse predictable quota exhaustion *before* the caller executes
            // a command. Keep room for one maximal result and small step/turn
            // endings. Other event kinds retain their normal limits.
            if event.kind == "tool/dispatch" && (
                event.seq + DISPATCH_EVENT_RESERVE > MAX_EVENTS ||
                parsed.good_len + bytes.len() as u64 + DISPATCH_BYTE_RESERVE > MAX_FILE
            ) {
                return Err("AI 事件日志剩余容量不足以保存命令结果和结束事件，请新建会话后重试".into());
            }
            if parsed.interrupted_tail {
                file.set_len(parsed.good_len).map_err(io_error)?;
                file.sync_data().map_err(io_error)?;
            }
            file.seek(SeekFrom::Start(parsed.good_len)).map_err(io_error)?;
            file.write_all(&bytes).map_err(io_error)?;
            file.sync_data().map_err(io_error)?;
            Ok(event)
        }).await
    }

    pub async fn read(&self, id: String) -> Result<SessionRecord, String> {
        validate_id(&id)?;
        self.blocking(move |root| {
            let mut file = root.open_file(&id, false)?;
            let parsed = scan(&mut file, &id, true)?;
            Ok(SessionRecord { id, metadata: parsed.metadata, events: parsed.events, interrupted_tail: parsed.interrupted_tail })
        }).await
    }

    /// Scans bounded lines rather than collecting histories. Completed lines
    /// are still checked: a corrupt journal must not look resumable in the UI.
    pub async fn list(&self) -> Result<Vec<SessionSummary>, String> {
        self.blocking(move |root| {
            let mut summaries = Vec::new();
            for id in root.session_ids()? {
                let parsed = root.open_file(&id, false).and_then(|mut file| scan(&mut file, &id, false));
                summaries.push(match parsed {
                    Ok(parsed) => SessionSummary {
                        id, metadata: parsed.metadata, event_count: parsed.last_seq,
                        updated_at: parsed.updated_at, interrupted_tail: parsed.interrupted_tail,
                        error: None,
                    },
                    Err(_) => SessionSummary {
                        updated_at: root.modified_at(&id), id,
                        metadata: serde_json::json!({ "goal": UNAVAILABLE_GOAL, "unavailable": true }),
                        event_count: 0, interrupted_tail: true,
                        // Never expose a parse error or untrusted file content
                        // in the history picker. Strict `read` gives safe detail.
                        error: Some(UNAVAILABLE_ERROR.into()),
                    },
                });
            }
            summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
            summaries.truncate(LIST_LIMIT);
            Ok(summaries)
        }).await
    }
}

/// Stable identity comparison without storing raw connection credentials. The
/// caller supplies a canonical, non-secret machine identity, not API settings.
pub fn fingerprint(identity: &str) -> Result<String, String> {
    if identity.trim().is_empty() || identity.len() > 16 * 1024 {
        return Err("机器身份不能为空或超过 16 KiB".into());
    }
    let mut hash = Sha256::new();
    hash.update(b"hurricane-harness-identity-v1\0");
    hash.update(identity.as_bytes());
    Ok(format!("{:x}", hash.finalize()))
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 96 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        return Err("会话 ID 只允许 1 至 96 个英文字母、数字、下划线或连字符".into());
    }
    Ok(())
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if matches!(kind,
        "session/start" | "turn/start" | "history/replace" | "step/start" |
        "assistant/message" | "tool/call" | "tool/dispatch" | "tool/approval" |
        "tool/result" | "step/end" | "turn/end" | "session/resume"
    ) { Ok(()) } else { Err("AI 事件类型不受支持".into()) }
}

fn now() -> Result<u64, String> {
    SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "系统时间早于 Unix 纪元".to_string())?
        .as_millis().try_into().map_err(|_| "系统时间超出事件日志范围".into())
}

fn io_error(error: io::Error) -> String { format!("AI 事件日志读写失败：{error}") }

struct LimitedCounter { size: usize, limit: usize }
impl Write for LimitedCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.size = self.size.checked_add(bytes.len()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "JSON too large"))?;
        if self.size > self.limit { return Err(io::Error::new(io::ErrorKind::InvalidData, "JSON too large")); }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

fn clean_value(mut value: Value, limit: usize, label: &str) -> Result<Value, String> {
    // Check the original value as well: removing a huge secret field must not
    // bypass the IPC/storage resource limit. Counting avoids a second big copy.
    let mut counter = LimitedCounter { size: 0, limit };
    serde_json::to_writer(&mut counter, &value).map_err(|_| format!("{label}超过 {} KiB 或无法编码", limit / 1024))?;
    redact(&mut value, 0)?;
    Ok(value)
}

fn secret_field(key: &str) -> bool {
    // Kept identical to the renderer journal contract. Exact names avoid
    // accidentally removing ordinary model contextTokens/tokenCount fields.
    let key: String = key.chars().filter(|c| *c != '_' && *c != '-').map(|c| c.to_ascii_lowercase()).collect();
    matches!(key.as_str(), "apikey" | "password" | "passwd" | "token" | "accesstoken" | "refreshtoken" |
        "authorization" | "privatekey" | "secret" | "embeddingkey")
}

fn redact(value: &mut Value, depth: usize) -> Result<(), String> {
    if depth > MAX_DEPTH { return Err("AI 事件内容嵌套不能超过 64 层".into()); }
    match value {
        Value::Object(map) => {
            map.retain(|key, _| !secret_field(key));
            for value in map.values_mut() { redact(value, depth + 1)?; }
        }
        Value::Array(values) => for value in values { redact(value, depth + 1)?; },
        _ => {}
    }
    Ok(())
}

fn encode_line<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| "AI 事件日志无法编码".to_string())?;
    if bytes.len() + 1 > MAX_LINE { return Err("AI 事件日志单行超过大小限制".into()); }
    bytes.push(b'\n');
    Ok(bytes)
}

struct Parsed {
    metadata: Value,
    events: Vec<SessionEvent>,
    last_seq: u64,
    updated_at: u64,
    good_len: u64,
    interrupted_tail: bool,
}

fn next_line<R: BufRead>(reader: &mut R) -> Result<Option<(Vec<u8>, bool)>, String> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(io_error)?;
        if available.is_empty() { return Ok(if line.is_empty() { None } else { Some((line, false)) }); }
        let end = available.iter().position(|byte| *byte == b'\n').map(|position| position + 1);
        let take = end.unwrap_or(available.len());
        if line.len() + take > MAX_LINE { return Err("AI 事件日志单行超过大小限制".into()); }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if end.is_some() { return Ok(Some((line, true))); }
    }
}

fn scan(file: &mut File, id: &str, keep_events: bool) -> Result<Parsed, String> {
    if file.metadata().map_err(io_error)?.len() > MAX_FILE { return Err("单个 AI 事件日志不能超过 16 MiB".into()); }
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut reader = BufReader::new(file);
    let (line, complete) = next_line(&mut reader)?.ok_or_else(|| "AI 事件日志头缺失".to_string())?;
    if !complete { return Err("AI 事件日志头未完整写入".into()); }
    let mut header: Header = serde_json::from_slice(&line).map_err(|_| "AI 事件日志头损坏或格式不受支持".to_string())?;
    if header.format != FORMAT || header.version != VERSION { return Err("AI 事件日志格式版本不受支持".into()); }
    if header.id != id { return Err("AI 事件日志中的会话 ID 与文件名不一致".into()); }
    header.metadata = clean_value(header.metadata, MAX_METADATA, "会话元信息")?;
    let mut parsed = Parsed {
        metadata: header.metadata, events: Vec::new(), last_seq: 0,
        updated_at: header.created_at, good_len: line.len() as u64, interrupted_tail: false,
    };
    while let Some((line, complete)) = next_line(&mut reader)? {
        if !complete { parsed.interrupted_tail = true; break; }
        if parsed.last_seq >= MAX_EVENTS { return Err("单个 AI 会话最多保存 4096 条事件".into()); }
        let mut event: SessionEvent = serde_json::from_slice(&line)
            .map_err(|_| format!("AI 事件日志第 {} 条完整事件损坏", parsed.last_seq + 1))?;
        if event.seq != parsed.last_seq + 1 { return Err("AI 事件日志包含不连续或重复的序号".into()); }
        validate_kind(&event.kind)?;
        event.data = clean_value(event.data, MAX_PAYLOAD, "事件内容")?;
        parsed.last_seq = event.seq;
        parsed.updated_at = parsed.updated_at.max(event.at);
        parsed.good_len += line.len() as u64;
        if keep_events { parsed.events.push(event); }
    }
    Ok(parsed)
}

struct RootHandle { path: PathBuf, directory: File }

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))] { metadata.file_type().is_symlink() }
}

impl RootHandle {
    fn open(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() || !path.components().any(|part| matches!(part, Component::Normal(_)))
            || path.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir)) {
            return Err("AI 事件日志目录必须是没有相对跳转的绝对路径".into());
        }
        // Do not follow a symlink/junction in any existing directory component.
        // Child operations use the opened directory descriptor on Unix, so a
        // subsequent rename of the path cannot redirect a read or append.
        let mut walked = PathBuf::new();
        for component in path.components() {
            walked.push(component.as_os_str());
            match fs::symlink_metadata(&walked) {
                Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {}
                Ok(_) => return Err("AI 事件日志目录包含符号链接或非目录路径".into()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    #[cfg(unix)] {
                        use std::os::unix::fs::DirBuilderExt;
                        fs::DirBuilder::new().mode(0o700).create(&walked).map_err(io_error)?;
                    }
                    #[cfg(not(unix))] fs::create_dir(&walked).map_err(io_error)?;
                    let metadata = fs::symlink_metadata(&walked).map_err(io_error)?;
                    if !metadata.is_dir() || is_reparse(&metadata) { return Err("AI 事件日志目录不安全".into()); }
                }
                Err(error) => return Err(io_error(error)),
            }
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            // Do not share deletion: keep this directory from being replaced
            // while path-based Windows child operations are in progress.
            options.custom_flags(0x02000000 | 0x00200000).share_mode(0x1 | 0x2);
        }
        let directory = options.open(path).map_err(io_error)?;
        let metadata = directory.metadata().map_err(io_error)?;
        if !metadata.is_dir() || is_reparse(&metadata) { return Err("AI 事件日志目录不安全".into()); }
        #[cfg(unix)] {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.uid() != unsafe { libc::geteuid() } { return Err("AI 事件日志目录不属于当前用户".into()); }
            directory.set_permissions(fs::Permissions::from_mode(0o700)).map_err(io_error)?;
        }
        Ok(Self { path: path.to_path_buf(), directory })
    }

    fn open_file(&self, id: &str, create: bool) -> Result<File, String> {
        validate_id(id)?;
        #[cfg(unix)]
        let file = {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = std::ffi::CString::new(format!("{id}.jsonl")).map_err(|_| "会话 ID 无效".to_string())?;
            let flags = libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
                | if create { libc::O_CREAT | libc::O_EXCL } else { 0 };
            let descriptor = unsafe { libc::openat(self.directory.as_raw_fd(), name.as_ptr(), flags, 0o600) };
            if descriptor < 0 { return Err(io_error(io::Error::last_os_error())); }
            unsafe { File::from_raw_fd(descriptor) }
        };
        #[cfg(not(unix))]
        let file = {
            let path = self.path.join(format!("{id}.jsonl"));
            if let Ok(metadata) = fs::symlink_metadata(&path) {
                if !metadata.is_file() || is_reparse(&metadata) { return Err("AI 事件日志不是普通文件或是符号链接".into()); }
            }
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(create);
            #[cfg(windows)] {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x00200000).share_mode(0);
            }
            options.open(path).map_err(io_error)?
        };
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_file() || is_reparse(&metadata) { return Err("AI 事件日志不是普通文件或是符号链接".into()); }
        #[cfg(unix)] {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() } {
                return Err("AI 事件日志存在硬链接或不属于当前用户".into());
            }
            // The process-wide gate also covers independently constructed
            // stores, but cannot serialize another application instance. Keep
            // this nonblocking, descriptor-scoped lock until `file` is dropped.
            // Ordinary-file validation comes first so a FIFO never blocks here.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                let error = io::Error::last_os_error();
                return Err(if error.kind() == io::ErrorKind::WouldBlock {
                    "AI 事件日志正被其他应用实例使用，请稍后重试".into()
                } else {
                    format!("AI 事件日志无法取得文件锁，请稍后重试：{error}")
                });
            }
            file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(io_error)?;
        }
        Ok(file)
    }

    fn remove_file(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        #[cfg(unix)] {
            use std::os::fd::AsRawFd;
            let name = std::ffi::CString::new(format!("{id}.jsonl")).map_err(|_| "会话 ID 无效".to_string())?;
            if unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io_error(io::Error::last_os_error()));
            }
            Ok(())
        }
        #[cfg(not(unix))] { fs::remove_file(self.path.join(format!("{id}.jsonl"))).map_err(io_error) }
    }

    fn sync_directory(&self) -> Result<(), String> {
        #[cfg(unix)] { self.directory.sync_all().map_err(io_error) }
        #[cfg(not(unix))] { Ok(()) }
    }

    fn session_ids(&self) -> Result<Vec<String>, String> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.path).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| "AI 事件日志目录含无效文件名".to_string())?;
            let id = name.strip_suffix(".jsonl").ok_or_else(|| "AI 事件日志目录含未知文件".to_string())?;
            validate_id(id)?;
            // Keep names for unreadable, linked, or special entries. `open_file`
            // refuses their payload; list can then show an explicit unavailable
            // record instead of hiding all other valid histories.
            ids.push(id.to_owned());
            if ids.len() > MAX_SESSIONS { return Err("AI 事件日志会话数量超过 256 个限制".into()); }
        }
        Ok(ids)
    }

    fn modified_at(&self, id: &str) -> u64 {
        // Do not follow a symlink just to obtain the fallback timestamp.
        fs::symlink_metadata(self.path.join(format!("{id}.jsonl")))
            .and_then(|metadata| metadata.modified()).ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| duration.as_millis().try_into().ok()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Temp { path: PathBuf }
    impl Temp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let parent = std::env::temp_dir().canonicalize().unwrap();
            let path = parent.join(format!("hurricane-harness-log-{}-{}-{}", std::process::id(), now().unwrap(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap();
            Self { path }
        }
        fn store(&self) -> HarnessStore { HarnessStore::new(self.path.join("journal")) }
        fn file(&self, id: &str) -> PathBuf { self.path.join("journal").join(format!("{id}.jsonl")) }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.path); } }
    async fn created(temp: &Temp) -> HarnessStore {
        let store = temp.store(); store.create("session_1".into(), json!({"title":"fixture"})).await.unwrap(); store
    }
    fn raw_append(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(bytes).unwrap(); file.sync_all().unwrap();
    }

    #[tokio::test]
    async fn create_append_reopen_and_camel_case_contract() {
        let temp = Temp::new(); let store = created(&temp).await;
        let initial = store.read("session_1".into()).await.unwrap();
        assert!(initial.events.is_empty()); assert!(!initial.interrupted_tail);
        let event = store.append("session_1".into(), 0, "session/start".into(), json!({"name":"test"})).await.unwrap();
        assert_eq!(event.seq, 1); assert!(event.at > 0);
        let reopened = temp.store().read("session_1".into()).await.unwrap();
        assert_eq!(reopened.events, vec![event]);
        let wire = serde_json::to_value(&reopened).unwrap();
        assert_eq!(wire["interruptedTail"], false); assert!(wire.get("interrupted_tail").is_none());
        let summary = serde_json::to_value(&store.list().await.unwrap()[0]).unwrap();
        assert_eq!(summary["eventCount"], 1); assert!(summary["updatedAt"].as_u64().unwrap() > 0);
        assert!(summary.get("error").is_none());
    }

    #[tokio::test]
    async fn duplicate_create_never_overwrites_existing_history() {
        let temp = Temp::new(); let store = created(&temp).await;
        let before = fs::read(temp.file("session_1")).unwrap();
        assert!(store.create("session_1".into(), json!({"changed":true})).await.is_err());
        assert_eq!(fs::read(temp.file("session_1")).unwrap(), before);
    }

    #[tokio::test]
    async fn sequence_conflicts_leave_complete_and_interrupted_bytes_untouched() {
        let temp = Temp::new(); let store = created(&temp).await;
        store.append("session_1".into(), 0, "turn/start".into(), json!({})).await.unwrap();
        raw_append(&temp.file("session_1"), b"{\"seq\":2,");
        let before = fs::read(temp.file("session_1")).unwrap();
        assert!(store.append("session_1".into(), 0, "turn/end".into(), json!({})).await.unwrap_err().contains("序号冲突"));
        assert_eq!(fs::read(temp.file("session_1")).unwrap(), before);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn separate_store_instances_serialize_concurrent_compare_and_append() {
        let temp = Temp::new(); created(&temp).await;
        let a = temp.store(); let b = temp.store();
        let (first, second) = tokio::join!(
            a.append("session_1".into(), 0, "step/start".into(), json!({"a":1})),
            b.append("session_1".into(), 0, "step/start".into(), json!({"b":1}))
        );
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        assert_eq!(a.read("session_1".into()).await.unwrap().events.len(), 1);
    }

    #[tokio::test]
    async fn incomplete_tail_is_reported_and_next_append_truncates_it_without_reusing_a_committed_sequence() {
        let temp = Temp::new(); let store = created(&temp).await;
        store.append("session_1".into(), 0, "tool/dispatch".into(), json!({"id":"call-1"})).await.unwrap();
        raw_append(&temp.file("session_1"), b"{\"seq\":2,\"kind\":\"tool/result\"");
        let record = store.read("session_1".into()).await.unwrap();
        assert!(record.interrupted_tail); assert_eq!(record.events.len(), 1);
        assert!(store.list().await.unwrap()[0].interrupted_tail);
        let next = store.append("session_1".into(), 1, "session/resume".into(), json!({"reason":"interrupted"})).await.unwrap();
        assert_eq!(next.seq, 2);
        let record = temp.store().read("session_1".into()).await.unwrap();
        assert!(!record.interrupted_tail); assert_eq!(record.events.len(), 2);
        assert_eq!(record.events[0].kind, "tool/dispatch");
        assert_eq!(record.events[1].kind, "session/resume");
    }

    #[tokio::test]
    async fn complete_json_without_newline_is_still_uncommitted_tail() {
        let temp = Temp::new(); let store = created(&temp).await;
        raw_append(&temp.file("session_1"), br#"{"seq":1,"kind":"tool/result","data":{},"at":1}"#);
        let record = store.read("session_1".into()).await.unwrap();
        assert!(record.events.is_empty()); assert!(record.interrupted_tail);
    }

    #[tokio::test]
    async fn damaged_complete_line_fails_read_and_append_while_list_marks_it_unavailable_without_repair() {
        let temp = Temp::new(); let store = created(&temp).await;
        raw_append(&temp.file("session_1"), b"{broken}\n");
        let before = fs::read(temp.file("session_1")).unwrap();
        assert!(store.read("session_1".into()).await.unwrap_err().contains("完整事件损坏"));
        let summary = store.list().await.unwrap().pop().unwrap();
        assert_eq!(summary.metadata["unavailable"], true); assert!(summary.error.is_some());
        assert!(store.append("session_1".into(), 0, "turn/end".into(), json!({})).await.is_err());
        assert_eq!(fs::read(temp.file("session_1")).unwrap(), before);
    }

    #[tokio::test]
    async fn sequence_gaps_duplicate_sequence_and_unknown_kind_are_rejected() {
        for event in [
            json!({"seq":2,"kind":"step/start","data":{},"at":1}),
            json!({"seq":0,"kind":"step/start","data":{},"at":1}),
            json!({"seq":1,"kind":"future/event","data":{},"at":1}),
        ] {
            let temp = Temp::new(); let store = created(&temp).await;
            raw_append(&temp.file("session_1"), &encode_line(&event).unwrap());
            assert!(store.read("session_1".into()).await.is_err());
        }
    }

    #[tokio::test]
    async fn future_version_header_id_mismatch_and_truncated_header_are_rejected() {
        for bytes in [
            b"{\"format\":\"hurricane-harness-log\",\"version\":2,\"id\":\"session_1\",\"metadata\":{},\"createdAt\":1}\n".as_slice(),
            b"{\"format\":\"hurricane-harness-log\",\"version\":1,\"id\":\"other\",\"metadata\":{},\"createdAt\":1}\n".as_slice(),
            b"{\"format\":".as_slice(), b"".as_slice(),
        ] {
            let temp = Temp::new(); let store = created(&temp).await;
            fs::write(temp.file("session_1"), bytes).unwrap();
            assert!(store.read("session_1".into()).await.is_err());
        }
    }

    #[tokio::test]
    async fn secret_fields_are_removed_from_metadata_and_nested_event_arrays_before_disk_write() {
        let temp = Temp::new(); let store = temp.store();
        let fixture = json!({"name":"visible", "api_key":"fixture-secret", "Password":"fixture-secret", "embedding-key":"fixture-secret", "nested":[{"Authorization":"fixture-secret","private-key":"fixture-secret","passwd":"fixture-secret","token":"fixture-secret","refresh_token":"fixture-secret","endpoint":"https://safe.example","tokenCount":10,"contextTokens":20}]});
        store.create("session_1".into(), fixture.clone()).await.unwrap();
        let event = store.append("session_1".into(), 0, "assistant/message".into(), fixture).await.unwrap();
        assert_eq!(event.data["nested"][0]["tokenCount"], 10);
        assert_eq!(event.data["nested"][0]["contextTokens"], 20);
        assert_eq!(event.data["nested"][0]["endpoint"], "https://safe.example");
        assert!(!String::from_utf8(fs::read(temp.file("session_1")).unwrap()).unwrap().contains("fixture-secret"));
        assert_eq!(store.read("session_1".into()).await.unwrap().metadata, event.data);
    }

    #[tokio::test]
    async fn payload_metadata_and_nesting_limits_fail_before_mutating_the_log() {
        let temp = Temp::new(); let store = created(&temp).await;
        assert!(store.create("huge".into(), json!({"text":"x".repeat(MAX_METADATA)})).await.unwrap_err().contains("64 KiB"));
        let before = fs::read(temp.file("session_1")).unwrap();
        assert!(store.append("session_1".into(), 0, "turn/start".into(), json!({"text":"x".repeat(MAX_PAYLOAD)})).await.unwrap_err().contains("256 KiB"));
        let mut nested = Value::Null;
        for _ in 0..MAX_DEPTH + 2 { nested = json!([nested]); }
        assert!(store.append("session_1".into(), 0, "turn/start".into(), nested).await.unwrap_err().contains("64 层"));
        assert_eq!(fs::read(temp.file("session_1")).unwrap(), before);
    }

    #[tokio::test]
    async fn event_limit_is_enforced_for_read_and_append() {
        let temp = Temp::new(); let store = created(&temp).await;
        let mut batch = Vec::new();
        for seq in 1..=MAX_EVENTS {
            batch.extend(encode_line(&json!({"seq":seq,"kind":"step/end","data":{},"at":seq})).unwrap());
        }
        raw_append(&temp.file("session_1"), &batch);
        assert_eq!(store.read("session_1".into()).await.unwrap().events.len(), MAX_EVENTS as usize);
        assert!(store.append("session_1".into(), MAX_EVENTS, "turn/end".into(), json!({})).await.unwrap_err().contains("4096"));
        raw_append(&temp.file("session_1"), &encode_line(&json!({"seq":MAX_EVENTS+1,"kind":"step/end","data":{},"at":1})).unwrap());
        assert!(store.read("session_1".into()).await.unwrap_err().contains("4096"));
    }

    #[tokio::test]
    async fn file_and_single_line_limits_are_enforced() {
        let temp = Temp::new(); let store = created(&temp).await;
        OpenOptions::new().write(true).open(temp.file("session_1")).unwrap().set_len(MAX_FILE + 1).unwrap();
        assert!(store.read("session_1".into()).await.unwrap_err().contains("16 MiB"));
        let temp = Temp::new(); let store = created(&temp).await;
        raw_append(&temp.file("session_1"), &vec![b'x'; MAX_LINE + 1]);
        assert!(store.read("session_1".into()).await.unwrap_err().contains("单行"));
    }

    #[tokio::test]
    async fn file_limit_is_checked_before_an_append_even_when_existing_lines_are_valid() {
        let temp = Temp::new(); let store = created(&temp).await;
        let data = json!({"text":"x".repeat(MAX_PAYLOAD - 128)});
        let mut seq = 0;
        while fs::metadata(temp.file("session_1")).unwrap().len() + (MAX_PAYLOAD as u64) < MAX_FILE {
            seq += 1;
            raw_append(&temp.file("session_1"), &encode_line(&json!({"seq":seq,"kind":"tool/result","data":data,"at":1})).unwrap());
        }
        // Fill the remaining space with one valid bounded record, leaving less
        // than the next payload. The journal stays valid up to the failed append.
        let remaining = MAX_FILE - fs::metadata(temp.file("session_1")).unwrap().len();
        seq += 1;
        raw_append(&temp.file("session_1"), &encode_line(&json!({"seq":seq,"kind":"tool/result","data":{"text":"x".repeat(remaining as usize - 200)},"at":1})).unwrap());
        let before_len = fs::metadata(temp.file("session_1")).unwrap().len();
        assert!(store.append("session_1".into(), seq, "tool/result".into(), json!({"text":"x".repeat(1024)})).await.unwrap_err().contains("16 MiB"));
        assert_eq!(fs::metadata(temp.file("session_1")).unwrap().len(), before_len);
    }

    #[tokio::test]
    async fn dispatch_reserves_result_and_ending_capacity_before_any_file_mutation() {
        // Sequence capacity: a dispatch needs its own sequence plus at least
        // three later records. Ordinary events can still use all 4096 slots.
        let temp = Temp::new(); let store = created(&temp).await;
        let mut batch = Vec::new();
        let committed = MAX_EVENTS - DISPATCH_EVENT_RESERVE;
        for seq in 1..=committed {
            batch.extend(encode_line(&json!({"seq":seq,"kind":"step/end","data":{},"at":1})).unwrap());
        }
        raw_append(&temp.file("session_1"), &batch);
        let before = fs::read(temp.file("session_1")).unwrap();
        assert!(store.append("session_1".into(), committed, "tool/dispatch".into(), json!({"callId":"blocked"})).await.unwrap_err().contains("剩余容量"));
        assert_eq!(fs::read(temp.file("session_1")).unwrap(), before);
        assert_eq!(store.append("session_1".into(), committed, "turn/end".into(), json!({})).await.unwrap().seq, committed + 1);

        // Byte capacity: valid journal data leaves enough space for a normal
        // event, but less than the reserved maximal result plus end records.
        let temp = Temp::new(); let store = created(&temp).await;
        let target = MAX_FILE - DISPATCH_BYTE_RESERVE + 1024;
        let data = json!({"text":"x".repeat(MAX_PAYLOAD - 128)});
        let mut seq = 0;
        while fs::metadata(temp.file("session_1")).unwrap().len() + (MAX_PAYLOAD as u64) < target {
            seq += 1;
            raw_append(&temp.file("session_1"), &encode_line(&json!({"seq":seq,"kind":"tool/result","data":data,"at":1})).unwrap());
        }
        let remaining = target - fs::metadata(temp.file("session_1")).unwrap().len();
        seq += 1;
        let mut filler = json!({"seq":seq,"kind":"tool/result","data":{"text":""},"at":1});
        let overhead = encode_line(&filler).unwrap().len();
        assert!(remaining as usize > overhead);
        filler["data"]["text"] = Value::String("x".repeat(remaining as usize - overhead));
        raw_append(&temp.file("session_1"), &encode_line(&filler).unwrap());
        assert_eq!(fs::metadata(temp.file("session_1")).unwrap().len(), target);
        let before = fs::read(temp.file("session_1")).unwrap();
        assert!(store.append("session_1".into(), seq, "tool/dispatch".into(), json!({"callId":"blocked"})).await.unwrap_err().contains("剩余容量"));
        assert_eq!(fs::read(temp.file("session_1")).unwrap(), before);
        assert_eq!(store.append("session_1".into(), seq, "turn/end".into(), json!({})).await.unwrap().seq, seq + 1);
    }

    #[tokio::test]
    async fn list_keeps_valid_history_visible_beside_corrupt_and_future_records_without_changing_them() {
        let temp = Temp::new(); let store = created(&temp).await;
        store.append("session_1".into(), 0, "turn/end".into(), json!({"result":"valid"})).await.unwrap();
        let variants = [
            ("bad_header", b"{fixture-secret broken header}\n".to_vec()),
            ("bad_event", {
                let mut bytes = encode_line(&json!({"format":FORMAT,"version":VERSION,"id":"bad_event","metadata":{},"createdAt":1})).unwrap();
                bytes.extend(encode_line(&json!({"seq":1,"kind":"step/start","data":{},"at":1})).unwrap());
                bytes.extend_from_slice(b"{fixture-secret broken event}\n"); bytes
            }),
            ("future", encode_line(&json!({"format":FORMAT,"version":VERSION+1,"id":"future","metadata":{"token":"fixture-secret"},"createdAt":1})).unwrap()),
        ];
        for (id, bytes) in &variants { fs::write(temp.file(id), bytes).unwrap(); }
        let summaries = store.list().await.unwrap();
        assert_eq!(summaries.len(), 4);
        let valid = summaries.iter().find(|item| item.id == "session_1").unwrap();
        assert_eq!(valid.event_count, 1); assert!(valid.error.is_none()); assert!(valid.metadata.get("unavailable").is_none());
        for (id, before) in variants {
            let summary = summaries.iter().find(|item| item.id == id).unwrap();
            assert_eq!(summary.metadata, json!({"goal":UNAVAILABLE_GOAL,"unavailable":true}));
            assert_eq!(summary.event_count, 0); assert!(summary.interrupted_tail);
            assert_eq!(summary.error.as_deref(), Some(UNAVAILABLE_ERROR));
            assert!(summary.metadata.get("target").is_none());
            assert!(!serde_json::to_string(summary).unwrap().contains("fixture-secret"));
            assert!(store.read(id.into()).await.is_err());
            assert!(store.append(id.into(), 0, "session/resume".into(), json!({})).await.is_err());
            assert_eq!(fs::read(temp.file(id)).unwrap(), before);
        }
    }

    #[tokio::test]
    async fn session_count_is_bounded_and_list_only_returns_the_100_most_recent_metadata_records() {
        let temp = Temp::new(); let store = temp.store();
        store.create("first".into(), json!({"title":"first"})).await.unwrap();
        for number in 1..MAX_SESSIONS {
            let id = format!("session_{number:03}");
            let header = Header { format:FORMAT.into(), version:VERSION, id:id.clone(), metadata:json!({"number":number}), created_at:number as u64 };
            fs::write(temp.file(&id), encode_line(&header).unwrap()).unwrap();
        }
        assert!(store.create("overflow".into(), json!({})).await.unwrap_err().contains("256"));
        let list = store.list().await.unwrap();
        assert_eq!(list.len(), LIST_LIMIT); assert_eq!(list[0].id, "first");
        assert!(list.iter().all(|item| item.event_count == 0));
    }

    #[tokio::test]
    async fn invalid_ids_roots_and_unknown_kinds_never_create_files() {
        let temp = Temp::new(); let store = temp.store();
        for id in ["", "../escape", "one/two", "one\\two", ".", "汉字", &"x".repeat(97)] {
            assert!(store.create(id.into(), json!({})).await.is_err());
            assert!(store.read(id.into()).await.is_err());
        }
        assert!(!temp.path.join("journal").exists());
        assert!(HarnessStore::new(PathBuf::from("relative")).list().await.is_err());
        let store = created(&temp).await;
        assert!(store.append("session_1".into(), 0, "future/event".into(), json!({})).await.is_err());
        assert!(store.read("session_1".into()).await.unwrap().events.is_empty());
    }

    #[test]
    fn fingerprint_is_stable_non_reversible_and_bounded() {
        let first = fingerprint("ssh:user@example:22").unwrap();
        assert_eq!(first.len(), 64); assert_eq!(first, fingerprint("ssh:user@example:22").unwrap());
        assert_ne!(first, fingerprint("ssh:other@example:22").unwrap());
        assert!(!first.contains("example"));
        assert!(fingerprint("").is_err()); assert!(fingerprint(&"x".repeat(16 * 1024 + 1)).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_root_ancestor_and_session_are_rejected_without_touching_the_target() {
        use std::os::unix::fs::symlink;
        let temp = Temp::new(); let target = temp.path.join("target"); fs::create_dir(&target).unwrap();
        let link = temp.path.join("link"); symlink(&target, &link).unwrap();
        assert!(HarnessStore::new(link.clone()).list().await.is_err());
        assert!(HarnessStore::new(link.join("child")).list().await.is_err());
        assert!(!target.join("child").exists());
        let store = created(&temp).await;
        let outside = temp.path.join("outside"); fs::write(&outside, b"untouched").unwrap();
        symlink(&outside, temp.file("linked")).unwrap();
        assert!(store.read("linked".into()).await.is_err());
        let summaries = store.list().await.unwrap();
        assert_eq!(summaries.len(), 2);
        assert!(summaries.iter().find(|item| item.id == "linked").unwrap().error.is_some());
        assert!(summaries.iter().find(|item| item.id == "session_1").unwrap().error.is_none());
        assert!(store.create("linked".into(), json!({})).await.is_err());
        assert_eq!(fs::read(outside).unwrap(), b"untouched");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hardlinks_fifo_and_directory_sessions_are_rejected() {
        use std::os::unix::ffi::OsStrExt;
        let temp = Temp::new(); let store = created(&temp).await;
        fs::hard_link(temp.file("session_1"), temp.file("linked")).unwrap();
        assert!(store.read("session_1".into()).await.is_err()); assert!(store.read("linked".into()).await.is_err());
        fs::remove_file(temp.file("linked")).unwrap();
        fs::create_dir(temp.file("directory")).unwrap();
        assert!(store.read("directory".into()).await.is_err());
        let fifo = std::ffi::CString::new(temp.file("fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(store.read("fifo".into()).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn independent_descriptors_cannot_scan_or_append_while_a_file_lock_is_held() {
        let temp = Temp::new(); let store = created(&temp).await;
        let root = RootHandle::open(&temp.path.join("journal")).unwrap();
        let owner = root.open_file("session_1", false).unwrap();
        let before = fs::read(temp.file("session_1")).unwrap();
        assert!(root.open_file("session_1", false).unwrap_err().contains("稍后重试"));
        assert!(store.read("session_1".into()).await.unwrap_err().contains("稍后重试"));
        let summary = store.list().await.unwrap().pop().unwrap();
        assert_eq!(summary.metadata["unavailable"], true); assert!(summary.error.is_some());
        assert!(store.append("session_1".into(), 0, "turn/start".into(), json!({})).await.unwrap_err().contains("稍后重试"));
        assert_eq!(fs::read(temp.file("session_1")).unwrap(), before);
        drop(owner);
        let event = store.append("session_1".into(), 0, "turn/start".into(), json!({})).await.unwrap();
        assert_eq!(event.seq, 1);
        assert_eq!(store.read("session_1".into()).await.unwrap().events, vec![event]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn directories_are_0700_and_files_0600_including_reopened_legacy_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let temp = Temp::new(); let store = created(&temp).await;
        assert_eq!(fs::metadata(temp.path.join("journal")).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(temp.file("session_1")).unwrap().mode() & 0o777, 0o600);
        fs::set_permissions(temp.path.join("journal"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(temp.file("session_1"), fs::Permissions::from_mode(0o644)).unwrap();
        store.read("session_1".into()).await.unwrap();
        assert_eq!(fs::metadata(temp.path.join("journal")).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(temp.file("session_1")).unwrap().mode() & 0o777, 0o600);
    }
}
