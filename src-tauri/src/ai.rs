//! User-triggered OpenAI-compatible chat transport. No model discovery,
//! credentials persistence, environment proxy, or background network work.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

const MAX_MESSAGES: usize = 64;
const MAX_PROMPT_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_CONCURRENT: usize = 4;
const MAX_PRE_CANCELS: usize = 256;
const PRE_CANCEL_TTL: Duration = Duration::from_secs(60);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(300);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const CANCELLED: &str = "AI 请求已取消";

#[derive(Clone, Deserialize, Serialize)]
pub struct AiMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub request_id: String,
    pub endpoint: String,
    pub model: String,
    #[serde(default, deserialize_with = "optional_key")]
    pub api_key: String,
    pub messages: Vec<AiMessage>,
}

fn optional_key<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Serialize)]
pub struct AiChatResponse {
    pub content: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatDelta {
    pub request_id: String,
    pub delta: String,
    pub done: bool,
}

#[derive(Clone, Default)]
pub struct AiState {
    requests: Arc<Mutex<RequestRegistry>>,
}

#[derive(Default)]
struct RequestRegistry {
    pending: HashMap<String, Arc<watch::Sender<bool>>>,
    pre_cancelled: HashMap<String, Instant>,
}

struct RequestGuard {
    id: String,
    sender: Arc<watch::Sender<bool>>,
    requests: Arc<Mutex<RequestRegistry>>,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.lock() {
            if requests.pending.get(&self.id).is_some_and(|sender| Arc::ptr_eq(sender, &self.sender)) {
                requests.pending.remove(&self.id);
            }
        }
    }
}

impl AiState {
    fn begin(&self, id: &str) -> Result<(RequestGuard, watch::Receiver<bool>), String> {
        let mut requests = self.requests.lock().map_err(|_| "AI 请求状态不可用")?;
        requests.pre_cancelled.retain(|_, at| at.elapsed() < PRE_CANCEL_TTL);
        if requests.pre_cancelled.remove(id).is_some() { return Err(CANCELLED.into()); }
        if requests.pending.contains_key(id) { return Err("此 AI 请求仍在进行中".into()); }
        if requests.pending.len() >= MAX_CONCURRENT { return Err("AI 在途请求过多，请先停止其他请求".into()); }
        let (sender, receiver) = watch::channel(false);
        let sender = Arc::new(sender);
        requests.pending.insert(id.into(), sender.clone());
        Ok((RequestGuard { id: id.into(), sender, requests: self.requests.clone() }, receiver))
    }

    pub fn cancel(&self, id: &str) -> bool {
        if !valid_id(id) { return false; }
        let Ok(mut requests) = self.requests.lock() else { return false; };
        if let Some(sender) = requests.pending.get(id) { return sender.send(true).is_ok(); }
        requests.pre_cancelled.retain(|_, at| at.elapsed() < PRE_CANCEL_TTL);
        if requests.pre_cancelled.len() >= MAX_PRE_CANCELS {
            if let Some(oldest) = requests.pre_cancelled.iter().min_by_key(|(_, at)| **at).map(|(id, _)| id.clone()) {
                requests.pre_cancelled.remove(&oldest);
            }
        }
        requests.pre_cancelled.insert(id.into(), Instant::now());
        false
    }
}

fn endpoint(value: &str) -> Result<reqwest::Url, String> {
    if value.len() > 4096 { return Err("AI 端点地址过长".into()); }
    let mut url = reqwest::Url::parse(value.trim()).map_err(|_| "AI 端点地址无效，请填写 HTTP 或 HTTPS 地址")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("AI 端点须为不含用户名、密码和片段的 HTTP/HTTPS 地址".into());
    }
    let path = url.path().trim_end_matches('/');
    let path = if path.is_empty() { "/v1/chat/completions".to_owned() }
        else if path.ends_with("/chat/completions") { path.to_owned() }
        else { format!("{path}/chat/completions") };
    url.set_path(&path);
    // Query parameters (e.g. api-version) remain on the request, but neither the
    // URL nor provider error bodies are included in any error/event/log.
    Ok(url)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_:.".contains(&c))
}

fn validate(request: &AiChatRequest) -> Result<reqwest::Url, String> {
    if !valid_id(&request.request_id) {
        return Err("AI 请求编号无效".into());
    }
    if request.model.trim().is_empty() || request.model.len() > 256 || request.model.chars().any(char::is_control) {
        return Err("请填写有效的 AI 模型名称".into());
    }
    let key = request.api_key.trim();
    if key.len() > 4096 || key.chars().any(char::is_control) { return Err("AI API Key 格式无效".into()); }
    if request.messages.is_empty() || request.messages.len() > MAX_MESSAGES { return Err("AI 消息数量须在 1–64 条之间".into()); }
    let mut bytes = 0usize;
    for message in &request.messages {
        if !matches!(message.role.as_str(), "system" | "user" | "assistant") { return Err("AI 消息角色无效".into()); }
        bytes = bytes.saturating_add(message.content.len());
        if bytes > MAX_PROMPT_BYTES { return Err("AI 消息过长（最多 256 KiB），请减少历史或终端上下文".into()); }
    }
    if !request.messages.iter().any(|message| !message.content.trim().is_empty()) { return Err("AI 消息不能为空".into()); }
    endpoint(&request.endpoint)
}

fn http_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "AI 服务拒绝认证，请检查 API Key 与权限".into(),
        404 => "AI 接口不存在，请检查端点路径和模型名称".into(),
        429 => "AI 服务限流或额度不足，请稍后重试".into(),
        300..=399 => "AI 服务返回重定向，已停止请求；请填写最终接口地址".into(),
        _ => format!("AI 服务请求失败（HTTP {}）", status.as_u16()),
    }
}

async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow() { return; }
        if receiver.changed().await.is_err() { return; }
    }
}

struct Collector<'a, F> {
    id: &'a str,
    content: String,
    emit: &'a mut F,
}

impl<F: FnMut(AiChatDelta) -> Result<(), String>> Collector<'_, F> {
    fn append(&mut self, delta: &str) -> Result<(), String> {
        if delta.is_empty() { return Ok(()); }
        if self.content.len().saturating_add(delta.len()) > MAX_OUTPUT_BYTES { return Err("AI 回复过长（最多 1 MiB），请求已停止".into()); }
        self.content.push_str(delta);
        (self.emit)(AiChatDelta { request_id: self.id.into(), delta: delta.into(), done: false })
            .map_err(|_| "AI 界面无法接收回复，请重新打开后重试".to_owned())
    }
}

fn text_content(value: &Value) -> Result<String, String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Null => Ok(String::new()),
        Value::Array(parts) => {
            let mut output = String::new();
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if output.len().saturating_add(text.len()) > MAX_OUTPUT_BYTES { return Err("AI 回复过长（最多 1 MiB），请求已停止".into()); }
                    output.push_str(text);
                }
            }
            Ok(output)
        }
        _ => Err("AI 服务返回了不支持的文本格式".into()),
    }
}

#[derive(Default)]
struct SseParser {
    line: Vec<u8>,
    data: Vec<String>,
    event_bytes: usize,
    skip_lf: bool,
    first_line: bool,
    done: bool,
    finished: bool,
    error_event: bool,
}

impl SseParser {
    fn process_line<F: FnMut(AiChatDelta) -> Result<(), String>>(&mut self, collector: &mut Collector<F>) -> Result<(), String> {
        let line = std::mem::take(&mut self.line);
        let line = std::str::from_utf8(&line).map_err(|_| "AI 流式回复不是有效的 UTF-8")?;
        let line = if !self.first_line { self.first_line = true; line.trim_start_matches('\u{feff}') } else { line };
        if line.is_empty() { return self.process_event(collector); }
        if line.starts_with(':') { return Ok(()); }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        if field == "data" {
            self.event_bytes = self.event_bytes.saturating_add(value.len() + 1);
            if self.event_bytes > MAX_EVENT_BYTES || self.data.len() >= 4096 { return Err("AI 流式数据块过大，请检查接口响应".into()); }
            self.data.push(value.into());
        } else if field == "event" && value == "error" { self.error_event = true; }
        Ok(())
    }

    fn process_event<F: FnMut(AiChatDelta) -> Result<(), String>>(&mut self, collector: &mut Collector<F>) -> Result<(), String> {
        let data = std::mem::take(&mut self.data).join("\n");
        self.event_bytes = 0;
        let error_event = std::mem::take(&mut self.error_event);
        if error_event { return Err("AI 服务在流式回复中返回错误，请检查模型或服务状态".into()); }
        if data.trim().is_empty() { return Ok(()); }
        if data.trim() == "[DONE]" { self.done = true; return Ok(()); }
        let value: Value = serde_json::from_str(&data).map_err(|_| "AI 流式回复格式无效，请检查 OpenAI 兼容接口")?;
        if value.get("error").is_some() { return Err("AI 服务在流式回复中返回错误，请检查模型或服务状态".into()); }
        let choices = value.get("choices").and_then(Value::as_array).ok_or("AI 流式回复缺少 choices 数据")?;
        let Some(choice) = choices.first() else { return Ok(()); };
        let delta = choice.get("delta").ok_or("AI 流式回复缺少 delta 数据")?;
        if let Some(content) = delta.get("content") { collector.append(&text_content(content)?)?; }
        if choice.get("finish_reason").and_then(Value::as_str).is_some_and(|reason| !reason.is_empty()) { self.finished = true; }
        Ok(())
    }

    fn feed<F: FnMut(AiChatDelta) -> Result<(), String>>(&mut self, bytes: &[u8], collector: &mut Collector<F>) -> Result<(), String> {
        for byte in bytes {
            if self.done { break; }
            if self.skip_lf { self.skip_lf = false; if *byte == b'\n' { continue; } }
            if *byte == b'\r' || *byte == b'\n' {
                self.process_line(collector)?;
                self.skip_lf = *byte == b'\r';
            } else {
                if self.line.len() >= MAX_EVENT_BYTES { return Err("AI 流式数据行过大，请检查接口响应".into()); }
                self.line.push(*byte);
            }
        }
        Ok(())
    }

    fn finish<F: FnMut(AiChatDelta) -> Result<(), String>>(&mut self, collector: &mut Collector<F>) -> Result<(), String> {
        if !self.done {
            if !self.line.is_empty() { self.process_line(collector)?; }
            if !self.data.is_empty() || self.error_event { self.process_event(collector)?; }
        }
        if !self.done && !self.finished { return Err("AI 流式连接提前结束，已显示的部分回复可能不完整，请重试".into()); }
        Ok(())
    }
}

async fn chat_http<F: FnMut(AiChatDelta) -> Result<(), String>>(
    request: &AiChatRequest, url: reqwest::Url, emit: &mut F,
) -> Result<AiChatResponse, String> {
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15)).timeout(TOTAL_TIMEOUT).pool_max_idle_per_host(0)
        .user_agent("hurricaneTerm-user-chat").build().map_err(|_| "无法初始化 AI HTTPS 客户端")?;
    let mut call = client.post(url).header("Accept", "text/event-stream, application/json")
        .json(&json!({ "model": request.model.trim(), "messages": request.messages, "stream": true }));
    if !request.api_key.trim().is_empty() { call = call.bearer_auth(request.api_key.trim()); }
    let response = call.send().await.map_err(|_| "无法连接 AI 服务，请检查端点、网络与服务状态")?;
    if !response.status().is_success() { return Err(http_error(response.status())); }
    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES as u64 { return Err("AI 服务响应过大（最多 8 MiB），请求已停止".into()); }
    let sse = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/event-stream"));
    let mut stream = response.bytes_stream();
    let mut total = 0usize;
    let mut body = Vec::new();
    let mut parser = SseParser::default();
    let mut collector = Collector { id: &request.request_id, content: String::new(), emit };
    while let Some(chunk) = tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await
        .map_err(|_| "AI 服务长时间没有返回数据，请重试")? {
        let chunk = chunk.map_err(|_| "AI 回复读取中断，请检查连接后重试")?;
        total = total.saturating_add(chunk.len());
        if total > MAX_RESPONSE_BYTES { return Err("AI 服务响应过大（最多 8 MiB），请求已停止".into()); }
        if sse {
            parser.feed(&chunk, &mut collector)?;
            if parser.done { break; }
        } else { body.extend_from_slice(&chunk); }
    }
    if sse { parser.finish(&mut collector)?; }
    else {
        let value: Value = serde_json::from_slice(&body).map_err(|_| "AI 服务未返回有效的 Chat Completions JSON/SSE 回复")?;
        if value.get("error").is_some() { return Err("AI 服务返回错误，请检查模型或服务状态".into()); }
        let message = value["choices"][0].get("message").ok_or("AI 回复缺少 message 数据")?;
        let content = message.get("content").ok_or("AI 回复缺少文本内容")?;
        collector.append(&text_content(content)?)?;
    }
    if collector.content.is_empty() { return Err("AI 服务未返回文本回复，请检查模型是否支持聊天".into()); }
    Ok(AiChatResponse { content: collector.content })
}

pub async fn chat<F: FnMut(AiChatDelta) -> Result<(), String>>(
    state: &AiState, request: AiChatRequest, mut emit: F,
) -> Result<AiChatResponse, String> {
    let url = validate(&request)?;
    let (_guard, mut cancel) = state.begin(&request.request_id)?;
    let response = tokio::select! {
        biased;
        _ = cancelled(&mut cancel) => return Err(CANCELLED.into()),
        result = tokio::time::timeout(TOTAL_TIMEOUT, chat_http(&request, url, &mut emit)) => {
            result.map_err(|_| "AI 请求超时，请重试或检查模型服务")??
        }
    };
    if *cancel.borrow() { return Err(CANCELLED.into()); }
    emit(AiChatDelta { request_id: request.request_id, delta: String::new(), done: true })
        .map_err(|_| "AI 界面无法接收回复，请重新打开后重试".to_owned())?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Reply {
        status: u16,
        kind: &'static str,
        chunks: Vec<Vec<u8>>,
        extra: String,
        length: Option<usize>,
        stall: bool,
        before_headers: bool,
    }
    fn reply(kind: &'static str, bytes: &[u8]) -> Reply {
        Reply { status: 200, kind, chunks: vec![bytes.into()], extra: String::new(), length: None, stall: false, before_headers: false }
    }
    struct Mock {
        base: String,
        accepted: Arc<AtomicBool>,
        disconnected: Arc<AtomicBool>,
        request: Arc<Mutex<(String, String, Value)>>,
        handle: std::thread::JoinHandle<()>,
    }
    fn wait_for_close(socket: &mut TcpStream, closed: &AtomicBool) {
        socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut byte = [0u8; 1];
        if matches!(socket.read(&mut byte), Ok(0)) { closed.store(true, Ordering::SeqCst); }
    }
    fn mock(plan: Reply) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicBool::new(false)); let disconnected = Arc::new(AtomicBool::new(false));
        let request = Arc::new(Mutex::new((String::new(), String::new(), Value::Null)));
        let ready = accepted.clone(); let closed = disconnected.clone(); let recorded = request.clone();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_nodelay(true).unwrap(); socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes = Vec::new();
            let (end, length) = loop {
                let mut buffer = [0u8; 4096]; let n = socket.read(&mut buffer).unwrap(); assert!(n > 0); bytes.extend_from_slice(&buffer[..n]);
                if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..i]).to_lowercase();
                    let length = headers.lines().find_map(|line| line.strip_prefix("content-length:")).map(|v| v.trim().parse::<usize>().unwrap()).unwrap_or(0);
                    break (i + 4, length);
                }
            };
            while bytes.len() < end + length { let mut buffer = [0u8; 4096]; let n = socket.read(&mut buffer).unwrap(); assert!(n > 0); bytes.extend_from_slice(&buffer[..n]); }
            let headers = String::from_utf8_lossy(&bytes[..end]).into_owned();
            *recorded.lock().unwrap() = (headers.lines().next().unwrap().into(), headers, serde_json::from_slice(&bytes[end..end + length]).unwrap());
            ready.store(true, Ordering::SeqCst);
            if plan.before_headers { wait_for_close(&mut socket, &closed); return; }
            let framing = plan.length.map(|n| format!("Content-Length: {n}\r\n")).unwrap_or_else(|| "Transfer-Encoding: chunked\r\n".into());
            if write!(socket, "HTTP/1.1 {} Test\r\nContent-Type: {}\r\n{}{}Connection: close\r\n\r\n", plan.status, plan.kind, framing, plan.extra).is_err() { return; }
            for chunk in plan.chunks {
                let result = if plan.length.is_some() { socket.write_all(&chunk) }
                    else { write!(socket, "{:x}\r\n", chunk.len()).and_then(|_| socket.write_all(&chunk)).and_then(|_| socket.write_all(b"\r\n")) };
                if result.is_err() { return; }
                socket.flush().ok();
            }
            if plan.stall { wait_for_close(&mut socket, &closed); }
            else if plan.length.is_none() { socket.write_all(b"0\r\n\r\n").ok(); }
        });
        Mock { base, accepted, disconnected, request, handle }
    }
    fn request(base: &str) -> AiChatRequest {
        AiChatRequest { request_id: "fixture-request".into(), endpoint: format!("{base}/v1"), model: "fixture-model".into(), api_key: "fixture-key-not-real".into(),
            messages: vec![AiMessage { role: "user".into(), content: "fixture question".into() }] }
    }
    async fn ready(flag: &AtomicBool) {
        for _ in 0..1000 { if flag.load(Ordering::SeqCst) { return; } tokio::time::sleep(Duration::from_millis(2)).await; }
        panic!("mock did not become ready");
    }
    fn frame(content: &str) -> String { format!("data: {}\n\n", json!({ "choices": [{ "delta": { "content": content }, "finish_reason": Value::Null }] })) }

    #[test]
    fn endpoint_paths_query_and_private_url_validation() {
        assert_eq!(endpoint("http://localhost:11434/v1").unwrap().as_str(), "http://localhost:11434/v1/chat/completions");
        assert_eq!(endpoint("https://provider.invalid").unwrap().path(), "/v1/chat/completions");
        assert_eq!(endpoint("https://provider.invalid/custom/api/").unwrap().path(), "/custom/api/chat/completions");
        assert_eq!(endpoint("https://provider.invalid/v1/chat/completions/?api-version=2026").unwrap().as_str(), "https://provider.invalid/v1/chat/completions?api-version=2026");
        for invalid in ["file:///etc/passwd", "ftp://provider.invalid", "https://user:fixture-secret@provider.invalid/v1", "https://provider.invalid/#fixture-secret"] {
            let error = endpoint(invalid).err().unwrap(); assert!(!error.contains("fixture-secret"));
        }
    }
    #[test]
    fn request_bounds_roles_keys_and_nonempty_messages() {
        let mut r = request("http://localhost"); assert!(validate(&r).is_ok());
        r.messages = vec![AiMessage { role: "tool".into(), content: "unsupported".into() }]; assert!(validate(&r).is_err());
        r.messages = vec![AiMessage { role: "user".into(), content: "x".repeat(MAX_PROMPT_BYTES + 1) }]; assert!(validate(&r).is_err());
        r.messages = vec![AiMessage { role: "user".into(), content: "x".into() }; MAX_MESSAGES + 1]; assert!(validate(&r).is_err());
        r.messages = vec![AiMessage { role: "user".into(), content: " ".into() }]; assert!(validate(&r).is_err());
        r.messages[0].content = "valid".into(); r.api_key = "fixture\r\nsecret".into(); assert!(validate(&r).is_err());
        r.api_key.clear(); r.request_id = "invalid request id".into(); assert!(validate(&r).is_err());
    }
    #[test]
    fn api_key_missing_null_or_empty_all_support_no_auth_self_hosted_models() {
        let base = json!({ "requestId": "fixture", "endpoint": "http://localhost:11434/v1", "model": "fixture", "messages": [{ "role": "user", "content": "hello" }] });
        for key in [None, Some(Value::Null), Some(json!(""))] {
            let mut value = base.clone(); if let Some(key) = key { value["apiKey"] = key; }
            let parsed: AiChatRequest = serde_json::from_value(value).unwrap(); assert!(parsed.api_key.is_empty()); assert!(validate(&parsed).is_ok());
        }
    }
    #[test]
    fn bounded_registry_duplicate_ids_pre_cancel_and_ttl_cleanup() {
        let state = AiState::default(); let (guard, _rx) = state.begin("same").unwrap();
        assert!(state.begin("same").is_err()); assert!(state.cancel("same")); drop(guard);
        let mut guards = Vec::new(); for i in 0..MAX_CONCURRENT { guards.push(state.begin(&format!("parallel-{i}")).unwrap()); }
        assert!(state.begin("too-many").is_err()); drop(guards); assert!(state.requests.lock().unwrap().pending.is_empty());
        for i in 0..MAX_PRE_CANCELS + 20 { state.cancel(&format!("pre-{i}")); }
        assert_eq!(state.requests.lock().unwrap().pre_cancelled.len(), MAX_PRE_CANCELS);
        assert!(state.begin("pre-275").err().unwrap().contains("已取消"));
        state.requests.lock().unwrap().pre_cancelled.insert("expired".into(), Instant::now() - PRE_CANCEL_TTL - Duration::from_secs(1));
        assert!(state.begin("expired").is_ok()); assert!(!state.cancel("invalid id"));
    }
    #[test]
    fn parser_utf8_each_byte_multiline_crlf_bom_and_finish_reason() {
        let data = format!("\u{feff}: comment\r\ndata: {{\r\ndata: \"choices\":[{{\"delta\":{{\"content\":\"你好🙂\"}},\"finish_reason\":null}}]}}\r\n\r\ndata: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\r\r");
        let mut pieces = Vec::new(); let mut emit = |event: AiChatDelta| { pieces.push(event.delta); Ok(()) };
        let mut collector = Collector { id: "test", content: String::new(), emit: &mut emit }; let mut parser = SseParser::default();
        for byte in data.as_bytes() { parser.feed(&[*byte], &mut collector).unwrap(); }
        parser.finish(&mut collector).unwrap(); assert_eq!(collector.content, "你好🙂"); assert_eq!(pieces.concat(), "你好🙂");
    }
    #[tokio::test]
    async fn mock_http_streams_unicode_and_done_with_original_request_contract() {
        let data = format!("{}{}data: [DONE]\n\n", frame("你好"), frame("🙂 world"));
        let mut plan = reply("text/event-stream; charset=utf-8", &[]); plan.chunks = data.as_bytes().chunks(7).map(|part| part.to_vec()).collect();
        let server = mock(plan); let state = AiState::default(); let mut events = Vec::new();
        let answer = chat(&state, request(&server.base), |event| { events.push(event); Ok(()) }).await.unwrap();
        assert_eq!(answer.content, "你好🙂 world"); assert_eq!(events.iter().filter(|e| !e.done).map(|e| e.delta.as_str()).collect::<String>(), answer.content);
        assert!(events.last().unwrap().done); assert!(events.iter().all(|e| e.request_id == "fixture-request"));
        server.handle.join().unwrap(); let r = server.request.lock().unwrap();
        assert!(r.0.starts_with("POST /v1/chat/completions ")); assert!(r.1.to_lowercase().contains("authorization: bearer fixture-key-not-real"));
        assert_eq!(r.2["stream"], true); assert_eq!(r.2["model"], "fixture-model"); assert_eq!(r.2["messages"][0]["content"], "fixture question");
        assert!(state.requests.lock().unwrap().pending.is_empty());
    }
    #[tokio::test]
    async fn mock_http_non_streaming_fallback_and_optional_key() {
        let body = json!({ "choices": [{ "message": { "role": "assistant", "content": [{ "type": "text", "text": "fallback " }, { "type": "text", "text": "中文" }] } }] }).to_string();
        let server = mock(reply("application/json", body.as_bytes())); let mut r = request(&server.base); r.api_key.clear(); let mut events = Vec::new();
        let answer = chat(&AiState::default(), r, |event| { events.push(event); Ok(()) }).await.unwrap(); assert_eq!(answer.content, "fallback 中文");
        assert_eq!(events.len(), 2); assert!(events.last().unwrap().done); server.handle.join().unwrap();
        assert!(!server.request.lock().unwrap().1.to_lowercase().contains("authorization:"));
    }
    #[tokio::test]
    async fn mock_http_invalid_json_schema_and_provider_errors_never_leak_secrets() {
        for (status, body) in [(200, "<html>fixture-key-not-real</html>"), (200, "{\"error\":\"fixture-key-not-real\"}"), (200, "{\"choices\":[]}"), (401, "fixture-key-not-real")] {
            let mut plan = reply("application/json", body.as_bytes()); plan.status = status; let server = mock(plan);
            let mut r = request(&server.base); r.endpoint += "?query-secret=fixture-query-secret";
            let mut events = Vec::new(); let error = chat(&AiState::default(), r, |event| { events.push(event); Ok(()) }).await.err().unwrap();
            assert!(!error.contains("fixture-key-not-real") && !error.contains("fixture-query-secret")); assert!(!events.iter().any(|e| e.done)); server.handle.join().unwrap();
        }
    }
    #[tokio::test]
    async fn mock_http_redirect_is_not_followed_or_given_credentials() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap(); target.set_nonblocking(true).unwrap();
        let mut plan = reply("application/json", b"{}"); plan.status = 302; plan.extra = format!("Location: http://{}/steal\r\n", target.local_addr().unwrap());
        let server = mock(plan); let error = chat(&AiState::default(), request(&server.base), |_| Ok(())).await.err().unwrap();
        assert!(error.contains("重定向")); assert_eq!(target.accept().err().unwrap().kind(), std::io::ErrorKind::WouldBlock); server.handle.join().unwrap();
    }
    #[tokio::test]
    async fn mock_http_truncated_stream_reports_error_and_keeps_partial_delta_only() {
        let server = mock(reply("text/event-stream", frame("partial").as_bytes())); let mut events = Vec::new();
        let error = chat(&AiState::default(), request(&server.base), |event| { events.push(event); Ok(()) }).await.err().unwrap();
        assert!(error.contains("提前结束")); assert_eq!(events.iter().map(|e| e.delta.as_str()).collect::<String>(), "partial"); assert!(!events.iter().any(|e| e.done)); server.handle.join().unwrap();
    }
    #[tokio::test]
    async fn mock_http_event_error_invalid_utf8_and_oversized_response_fail_closed() {
        for body in [b"event: error\ndata: fixture-key-not-real\n\n".to_vec(), b"data: \xff\n\n".to_vec(), b"data: not-json\n\n".to_vec()] {
            let server = mock(reply("text/event-stream", &body)); let error = chat(&AiState::default(), request(&server.base), |_| Ok(())).await.err().unwrap();
            assert!(!error.contains("fixture-key-not-real")); server.handle.join().unwrap();
        }
        let mut plan = reply("application/json", b""); plan.length = Some(MAX_RESPONSE_BYTES + 1); let server = mock(plan);
        assert!(chat(&AiState::default(), request(&server.base), |_| Ok(())).await.err().unwrap().contains("响应过大")); server.handle.join().unwrap();
    }
    #[test]
    fn parser_line_event_and_total_output_limits_are_enforced() {
        let mut emit = |_| Ok(()); let mut collector = Collector { id: "test", content: String::new(), emit: &mut emit };
        collector.append(&"x".repeat(MAX_OUTPUT_BYTES)).unwrap(); assert!(collector.append("y").err().unwrap().contains("回复过长"));
        let mut parser = SseParser::default(); assert!(parser.feed(&vec![b'x'; MAX_EVENT_BYTES + 1], &mut collector).is_err());
        let mut parser = SseParser::default(); assert!(parser.feed("data:\n".repeat(4097).as_bytes(), &mut collector).is_err());
    }
    #[tokio::test]
    async fn cancel_before_headers_aborts_transport_and_cleans_request_state() {
        let mut plan = reply("text/event-stream", b""); plan.before_headers = true; let server = mock(plan);
        let state = AiState::default(); let cloned = state.clone(); let r = request(&server.base);
        let task = tokio::spawn(async move { chat(&cloned, r, |_| Ok(())).await }); ready(&server.accepted).await;
        assert!(state.cancel("fixture-request")); let result = tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap();
        assert_eq!(result.err().unwrap(), CANCELLED); assert!(state.requests.lock().unwrap().pending.is_empty()); server.handle.join().unwrap();
        assert!(server.disconnected.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn cancel_mid_stream_stops_reading_emits_no_success_done_and_closes_socket() {
        let mut plan = reply("text/event-stream", frame("partial before stop").as_bytes()); plan.stall = true; let server = mock(plan);
        let state = AiState::default(); let cloned = state.clone(); let r = request(&server.base);
        let seen = Arc::new(AtomicBool::new(false)); let notify = seen.clone(); let events = Arc::new(Mutex::new(Vec::new())); let recorded = events.clone();
        let task = tokio::spawn(async move { chat(&cloned, r, |event| { if !event.delta.is_empty() { notify.store(true, Ordering::SeqCst); } recorded.lock().unwrap().push(event); Ok(()) }).await });
        ready(&seen).await; assert!(state.cancel("fixture-request")); let result = tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap();
        assert_eq!(result.err().unwrap(), CANCELLED); assert!(!events.lock().unwrap().iter().any(|event| event.done));
        server.handle.join().unwrap(); assert!(server.disconnected.load(Ordering::SeqCst)); assert!(state.requests.lock().unwrap().pending.is_empty());
    }
    #[tokio::test]
    async fn pre_cancelled_request_never_contacts_endpoint_and_registry_is_reusable() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); listener.set_nonblocking(true).unwrap();
        let state = AiState::default(); assert!(!state.cancel("fixture-request")); let base = format!("http://{}", listener.local_addr().unwrap());
        assert_eq!(chat(&state, request(&base), |_| Ok(())).await.err().unwrap(), CANCELLED);
        assert_eq!(listener.accept().err().unwrap().kind(), std::io::ErrorKind::WouldBlock);
        assert!(state.requests.lock().unwrap().pending.is_empty()); assert!(state.begin("fixture-request").is_ok());
    }
    #[tokio::test]
    async fn ui_emit_failure_is_safe_and_releases_connection_registry() {
        let server = mock(reply("text/event-stream", format!("{}data: [DONE]\n\n", frame("answer")).as_bytes())); let state = AiState::default();
        let error = chat(&state, request(&server.base), |_| Err("fixture-key-not-real".into())).await.err().unwrap();
        assert!(error.contains("界面")); assert!(!error.contains("fixture-key-not-real")); assert!(state.requests.lock().unwrap().pending.is_empty()); server.handle.join().unwrap();
    }
}
