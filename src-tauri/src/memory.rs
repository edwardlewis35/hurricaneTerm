//! OpenClaw-inspired local memory: Markdown is authoritative, SQLite/FTS5 and
//! embeddings are disposable derived data. No chat log or credential is written
//! automatically. All scopes, paths, provider responses and resource use are bounded.
use futures_util::StreamExt;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_FILE: usize = 512 * 1024;
const MAX_FILES: usize = 256;
const MAX_TOTAL: usize = 16 * 1024 * 1024;
const MAX_CHUNKS: usize = 8192;
const MAX_DIMENSIONS: usize = 4096;
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
const MAX_BATCH: usize = 16;
const MAX_QUERY: usize = 8192;
const INDEX_ERROR: &str = "记忆索引读写失败；Markdown 原文保持不变，可重建索引后重试";
const FILE_ERROR: &str = "记忆文件读写失败，请检查应用配置目录权限";
const PATH_ERROR: &str = "记忆路径无效，只允许 MEMORY.md 或 memory/ 下的普通 Markdown 文件，不允许符号链接";
const EMBEDDING_ERROR: &str = "Embedding 接口不可用或返回无效向量";

fn hash(value: &[u8]) -> String { format!("{:x}", Sha256::digest(value)) }
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64 }
fn io<T>(value: std::io::Result<T>) -> Result<T, String> { value.map_err(|_| FILE_ERROR.into()) }
fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> { value.map_err(|_| INDEX_ERROR.into()) }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddingConfig {
    pub endpoint: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub dimensions: Option<usize>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDoc { pub scope: String, pub path: String, pub hash: String, pub bytes: usize, pub updated_ms: u64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile { pub scope: String, pub path: String, pub content: String, pub hash: String, pub start_line: usize, pub end_line: usize, pub total_lines: usize }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryWriteRequest { pub scope: String, pub path: String, pub content: String, #[serde(default)] pub expected_hash: Option<String>, #[serde(default)] pub append: bool, #[serde(default)] pub if_idle: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryDeleteRequest { pub scope: String, pub path: String, #[serde(default)] pub expected_hash: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteResponse { pub deleted: bool, pub backup_path: Option<String> }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySearchRequest { pub scope: String, #[serde(default)] pub include_global: bool, pub query: String, #[serde(default)] pub max_results: Option<usize>, #[serde(default)] pub min_score: Option<f64>, #[serde(default)] pub embedding: Option<EmbeddingConfig> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryReindexRequest { pub scope: String, #[serde(default)] pub include_global: bool, #[serde(default)] pub embedding: Option<EmbeddingConfig> }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit { pub scope: String, pub path: String, pub start_line: usize, pub end_line: usize, pub snippet: String, pub hash: String, pub score: f64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResponse { pub hits: Vec<MemoryHit>, pub mode: String, pub warning: Option<String>, pub indexed_chunks: usize, pub embedding_chunks: usize }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatus { pub root: String, pub documents: usize, pub indexed_chunks: usize, pub embedding_chunks: usize, pub scopes: Vec<String>, pub mode: String, pub warning: Option<String> }
#[derive(Serialize)]
pub struct EmbeddingTestResponse { pub dimensions: usize, pub message: String }

pub struct MemoryState { root: PathBuf, gate: Arc<tokio::sync::Mutex<()>> }
impl MemoryState {
    /// `root` is supplied by the application config directory, never by IPC.
    pub fn new(root: PathBuf) -> Self { Self { root, gate: Arc::new(tokio::sync::Mutex::new(())) } }
    async fn blocking<T: Send + 'static>(&self, task: impl FnOnce(PathBuf) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        self.blocking_mode(false, task).await
    }
    async fn blocking_mode<T: Send + 'static>(&self, if_idle: bool, task: impl FnOnce(PathBuf) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let root = self.root.clone();
        // Background flush must never queue behind a slow Embedding request and
        // commit minutes after its UI task has been cancelled.
        let guard = if if_idle { self.gate.clone().try_lock_owned().map_err(|_| "记忆库正在检索或保存，后台整理未写入，请稍后重试".to_string())? }
            else { self.gate.clone().lock_owned().await };
        tokio::task::spawn_blocking(move || { let _guard = guard; task(root) }).await.map_err(|_| FILE_ERROR.to_string())?
    }
    pub async fn list(&self, scope: String) -> Result<Vec<MemoryDoc>, String> {
        self.blocking(move |root| { let scopes = scopes(&scope, false)?; Ok(scan(&root, &scopes)?.into_iter().map(|f| f.doc).collect()) }).await
    }
    pub async fn get(&self, scope: String, path: String, from_line: Option<usize>, lines: Option<usize>) -> Result<MemoryFile, String> {
        self.blocking(move |root| {
            let file = doc_path(&root, &scope, &path, false)?; let content = read_text(&file)?;
            let full_hash = hash(content.as_bytes()); let all: Vec<&str> = content.lines().collect();
            if from_line.is_none() && lines.is_none() {
                return Ok(MemoryFile { scope, path, hash: full_hash, start_line: 1, end_line: all.len(), total_lines: all.len(), content });
            }
            let start = from_line.unwrap_or(1); let count = lines.unwrap_or(500);
            if start == 0 || count == 0 || count > 500 { return Err("记忆读取行号须从 1 开始，每次最多 500 行".into()); }
            let begin = (start - 1).min(all.len()); let end = (begin + count).min(all.len());
            Ok(MemoryFile { scope, path, content: all[begin..end].join("\n"), hash: full_hash, start_line: begin + 1, end_line: end, total_lines: all.len() })
        }).await
    }
    pub async fn write(&self, request: MemoryWriteRequest) -> Result<MemoryDoc, String> {
        self.blocking_mode(request.if_idle, move |root| {
            let file = doc_path(&root, &request.scope, &request.path, true)?;
            let old = if file.exists() { Some(read_text(&file)?) } else { None };
            check_expected(old.as_deref(), request.expected_hash.as_deref())?;
            let content = if request.append { format!("{}{}", old.as_deref().unwrap_or(""), request.content) } else { request.content };
            validate_text(&content)?;
            let current = scan(&root, &scopes(&request.scope, false)?)?;
            if old.is_none() && current.len() >= MAX_FILES { return Err("记忆文件数量已达上限，请整理后重试".into()); }
            if current.iter().filter(|f| f.doc.path != request.path).map(|f| f.doc.bytes).sum::<usize>() + content.len() > MAX_TOTAL { return Err("当前记忆空间已达 16 MiB 上限".into()); }
            atomic_write(&file, content.as_bytes())?;
            metadata_doc(&request.scope, &request.path, &file, &content)
        }).await
    }
    pub async fn delete(&self, request: MemoryDeleteRequest) -> Result<MemoryDeleteResponse, String> {
        self.blocking(move |root| {
            let file = doc_path(&root, &request.scope, &request.path, false)?;
            let old = match read_text(&file) { Ok(v) => v, Err(_) if !file.exists() => { check_expected(None, request.expected_hash.as_deref())?; return Ok(MemoryDeleteResponse { deleted: false, backup_path: None }); }, Err(e) => return Err(e) };
            check_expected(Some(&old), request.expected_hash.as_deref())?;
            let backup_dir = root.join("backups"); ensure_dir(&root, &backup_dir, true)?;
            let name = format!("{}-{}-{}.md", now_ms(), &hash(format!("{}:{}", request.scope, request.path).as_bytes())[..12], uuid::Uuid::new_v4());
            let backup = backup_dir.join(name); io(fs::rename(&file, &backup))?;
            Ok(MemoryDeleteResponse { deleted: true, backup_path: Some(backup.to_string_lossy().into_owned()) })
        }).await
    }
    pub async fn status(&self, scope: String) -> Result<MemoryStatus, String> {
        self.blocking(move |root| { let selected = scopes(&scope, true)?; let indexed = sync_index(&root, &selected)?; let embeddings = cached_embedding_count(&root, &indexed)?; make_status(&root, &selected, &indexed, embeddings, "keyword", None) }).await
    }
    pub async fn embedding_test(&self, embedding: EmbeddingConfig) -> Result<EmbeddingTestResponse, String> {
        let _guard = self.gate.clone().lock_owned().await;
        let vectors = embed(&embedding, &["hurricaneTerm memory connection test".into()]).await?;
        Ok(EmbeddingTestResponse { dimensions: vectors[0].len(), message: "Embedding 接口连接成功".into() })
    }
    pub async fn reindex(&self, request: MemoryReindexRequest) -> Result<MemoryStatus, String> {
        scopes(&request.scope, request.include_global)?;
        if let Some(config) = &request.embedding { embedding_profile(config)?; }
        // Rebuild discards only derived data. Markdown and recoverable deletions
        // are untouched; this also lets a provider with changed dimensions heal.
        self.blocking(move |root| {
            ensure_dir(&root, &root, true)?;
            for name in ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm", "index.sqlite-journal"] {
                let file = root.join(name);
                if check_plain(&file, false)? { io(fs::remove_file(file))?; }
            }
            Ok(())
        }).await?;
        let result = self.search(MemorySearchRequest { scope: request.scope.clone(), include_global: request.include_global, query: "".into(), max_results: Some(1), min_score: None, embedding: request.embedding }).await?;
        let selected = scopes(&request.scope, request.include_global)?;
        self.blocking(move |root| { let indexed = sync_index(&root, &selected)?; make_status(&root, &selected, &indexed, result.embedding_chunks, &result.mode, result.warning) }).await
    }
    pub async fn search(&self, request: MemorySearchRequest) -> Result<MemorySearchResponse, String> {
        if request.query.len() > MAX_QUERY || request.query.contains('\0') { return Err("记忆检索文本过长或无效（最多 8 KiB）".into()); }
        if request.max_results.is_some_and(|v| v == 0 || v > 20) || request.min_score.is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v)) { return Err("记忆检索数量须为 1–20，最小分数须在 0–1 之间".into()); }
        let selected = scopes(&request.scope, request.include_global)?;
        // Single-flight spans disk and network. Cancellation cannot let a detached
        // blocking writer race with a later request: the owned guard travels with it.
        let guard = self.gate.clone().lock_owned().await;
        let root = self.root.clone(); let selected2 = selected.clone();
        let (guard, indexed) = tokio::task::spawn_blocking(move || { let result = sync_index(&root, &selected2); (guard, result) }).await.map_err(|_| INDEX_ERROR.to_string())?;
        let indexed = indexed?;
        let mut warning = None; let mut profile = None; let mut vector_map = HashMap::new(); let mut query_vector = None;
        if let Some(config) = request.embedding.as_ref() {
            match prepare_embeddings(&self.root, &indexed.chunks, config, &request.query).await {
                Ok((key, vectors, query)) => { profile = Some(key); vector_map = vectors; query_vector = query; }
                Err(_) => warning = Some(format!("{EMBEDDING_ERROR}，已降级为本地关键词检索")),
            }
        }
        let mode = if profile.is_some() { "hybrid" } else { "keyword" };
        let embedding_chunks = vector_map.len(); let query = request.query.clone(); let min = request.min_score.unwrap_or(0.35); let count = request.max_results.unwrap_or(6);
        let root = self.root.clone();
        let response = tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let keyword = keyword_scores(&root, &indexed.chunks, &query)?;
            let mut hits = Vec::new();
            if !query.trim().is_empty() { for chunk in &indexed.chunks {
                let text_score = keyword.get(&chunk.id).copied().unwrap_or(0.0);
                let vector_score = query_vector.as_ref().and_then(|q| vector_map.get(&chunk.hash).and_then(|v| cosine(q,v))).unwrap_or(0.0).max(0.0);
                // Same 0.7/0.3 weighting as OpenClaw's default hybrid search.
                let score = if profile.is_some() { vector_score * 0.7 + text_score * 0.3 } else { text_score };
                if score >= min && score > 0.0 { hits.push(MemoryHit { scope: chunk.scope.clone(), path: chunk.path.clone(), start_line: chunk.start, end_line: chunk.end, snippet: chunk.text.clone(), hash: chunk.hash.clone(), score }); }
            }}
            // Eligibility above uses relevance before aging, as in OpenClaw:
            // old facts remain retrievable but recent/evergreen facts rank first.
            let hits = rerank(hits, count, now_ms());
            Ok(MemorySearchResponse { hits, mode: mode.into(), warning, indexed_chunks: indexed.chunks.len(), embedding_chunks })
        }).await.map_err(|_| INDEX_ERROR.to_string())?;
        response
    }
}

fn scopes(scope: &str, include_global: bool) -> Result<Vec<String>, String> {
    let machine_hash = scope.strip_prefix("machine-").unwrap_or("");
    if scope != "global" && scope != "machine-local" && !(machine_hash.len() == 64 && machine_hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))) { return Err("记忆空间标识无效".into()); }
    let mut result = vec![scope.to_string()]; if include_global && scope != "global" { result.push("global".into()); } Ok(result)
}
fn valid_path(path: &str) -> bool {
    if path == "MEMORY.md" { return true; }
    let Some(name) = path.strip_prefix("memory/") else { return false; };
    !name.is_empty() && name.len() <= 128 && name.ends_with(".md") && !name.starts_with('.') && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)) && !name.contains("..")
}
fn check_plain(path: &Path, is_dir: bool) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_symlink() && if is_dir { meta.is_dir() } else { meta.is_file() } => Ok(true),
        Ok(_) => Err(PATH_ERROR.into()), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false), Err(_) => Err(FILE_ERROR.into())
    }
}
fn ensure_dir(root: &Path, dir: &Path, create: bool) -> Result<(), String> {
    if !check_plain(root, true)? { if create { io(fs::create_dir_all(root))?; #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; io(fs::set_permissions(root, fs::Permissions::from_mode(0o700)))?; } } else { return Ok(()); } }
    let tail = dir.strip_prefix(root).map_err(|_| PATH_ERROR.to_string())?; let mut current = root.to_path_buf();
    for part in tail.components() { if !matches!(part, std::path::Component::Normal(_)) { return Err(PATH_ERROR.into()); } current.push(part); if !check_plain(&current, true)? && create { io(fs::create_dir(&current))?; #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; io(fs::set_permissions(&current, fs::Permissions::from_mode(0o700)))?; } } }
    Ok(())
}
fn doc_path(root: &Path, scope: &str, path: &str, create: bool) -> Result<PathBuf, String> {
    scopes(scope, false)?; if !valid_path(path) { return Err(PATH_ERROR.into()); }
    let result = root.join("scopes").join(scope).join(path); ensure_dir(root, result.parent().unwrap(), create)?; check_plain(&result, false)?; Ok(result)
}
fn validate_text(content: &str) -> Result<(), String> { if content.len() > MAX_FILE || content.contains('\0') { Err("单个记忆文件最多 512 KiB，且不能包含空字节".into()) } else { Ok(()) } }
fn read_text(path: &Path) -> Result<String, String> {
    if !check_plain(path, false)? { return Err("记忆文件不存在".into()); }
    let mut options = OpenOptions::new(); options.read(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW); }
    let mut bytes = Vec::new(); io(options.open(path))?.take((MAX_FILE + 1) as u64).read_to_end(&mut bytes).map_err(|_| FILE_ERROR.to_string())?;
    let text = String::from_utf8(bytes).map_err(|_| "记忆文件必须使用 UTF-8 编码".to_string())?; validate_text(&text)?; Ok(text)
}
fn check_expected(old: Option<&str>, expected: Option<&str>) -> Result<(), String> {
    if let Some(expected) = expected { if expected != old.map(|v| hash(v.as_bytes())).unwrap_or_default() { return Err("记忆文件已被其他操作修改，请重新读取后再保存".into()); } } Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_file_name(format!(".memory-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| { let mut options = OpenOptions::new(); options.write(true).create_new(true); #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); } let mut file = io(options.open(&temp))?; io(file.write_all(bytes))?; io(file.sync_all())?; io(fs::rename(&temp, path))?; Ok(()) })();
    if result.is_err() { let _ = fs::remove_file(&temp); } result
}
fn metadata_doc(scope: &str, path: &str, file: &Path, text: &str) -> Result<MemoryDoc, String> { let modified = io(fs::metadata(file))?.modified().unwrap_or(UNIX_EPOCH).duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64; Ok(MemoryDoc { scope: scope.into(), path: path.into(), hash: hash(text.as_bytes()), bytes: text.len(), updated_ms: modified }) }
struct Source { doc: MemoryDoc, text: String }
fn scan(root: &Path, selected: &[String]) -> Result<Vec<Source>, String> {
    ensure_dir(root, root, false)?; let mut result = Vec::new(); let mut total = 0;
    for scope in selected {
        let scope_root = root.join("scopes").join(scope); ensure_dir(root, &scope_root, false)?;
        let mut paths = vec!["MEMORY.md".to_string()]; let memory = scope_root.join("memory");
        if check_plain(&memory, true)? { for entry in io(fs::read_dir(&memory))? { let entry = io(entry)?; let path = format!("memory/{}", entry.file_name().to_string_lossy()); if valid_path(&path) { paths.push(path); } } }
        paths.sort();
        for path in paths { let file = doc_path(root, scope, &path, false)?; if !check_plain(&file, false)? { continue; } let text = read_text(&file)?; total += text.len(); if result.len() >= MAX_FILES || total > MAX_TOTAL { return Err("记忆空间超过 256 个文件或 16 MiB 上限，请整理后重试".into()); } result.push(Source { doc: metadata_doc(scope,&path,&file,&text)?, text }); }
    }
    Ok(result)
}
#[derive(Clone)]
struct Chunk { id: String, scope: String, path: String, start: usize, end: usize, hash: String, text: String }
struct Indexed { documents: usize, chunks: Vec<Chunk> }
fn token_cost(c: char) -> usize { if c.is_ascii() { 1 } else { 6 } }
fn chunks(source: &Source) -> Vec<Chunk> {
    let mut pieces: Vec<(usize,String,usize)> = Vec::new();
    for (i,line) in source.text.lines().enumerate() {
        let mut part = String::new(); let mut cost = 0;
        for c in line.chars().chain(std::iter::once('\n')) { let add = token_cost(c); if cost + add > 1600 && !part.is_empty() { pieces.push((i+1,std::mem::take(&mut part),cost)); cost=0; } part.push(c); cost+=add; }
        if !part.is_empty() { pieces.push((i+1,part,cost)); }
    }
    let mut result = Vec::new(); let mut start = 0;
    while start < pieces.len() {
        let mut end = start; let mut cost = 0;
        while end < pieces.len() && (end == start || cost + pieces[end].2 <= 1600) { cost += pieces[end].2; end += 1; }
        let text = pieces[start..end].iter().map(|v|v.1.as_str()).collect::<String>();
        if !text.trim().is_empty() { let content_hash = hash(text.as_bytes()); let first=pieces[start].0; let last=pieces[end-1].0; let id=hash(format!("{}\0{}\0{}\0{}\0{}\0{}",source.doc.scope,source.doc.path,first,last,start,content_hash).as_bytes()); result.push(Chunk { id, scope:source.doc.scope.clone(),path:source.doc.path.clone(),start:first,end:last,hash:content_hash,text }); }
        if end == pieces.len() { break; } let mut next=end; let mut overlap=0; while next>start+1 && overlap+pieces[next-1].2<=320 { next-=1; overlap+=pieces[next].2; } start=next;
    }
    result
}
fn database(root: &Path) -> Result<Connection, String> {
    ensure_dir(root, root, true)?; let path=root.join("index.sqlite"); check_plain(&path,false)?;
    for ext in ["index.sqlite-wal","index.sqlite-shm","index.sqlite-journal"] { check_plain(&root.join(ext),false)?; }
    let connection=sql(Connection::open(&path))?;
    sql(connection.busy_timeout(Duration::from_secs(5)))?;
    sql(connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,scope TEXT NOT NULL,path TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,hash TEXT NOT NULL,text TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED,text,tokenize='unicode61'); CREATE TABLE IF NOT EXISTS vectors(profile TEXT NOT NULL,hash TEXT NOT NULL,dims INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(profile,hash));"))?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; io(fs::set_permissions(&path,fs::Permissions::from_mode(0o600)))?; }
    Ok(connection)
}
fn sync_index(root: &Path, selected: &[String]) -> Result<Indexed, String> {
    let files=scan(root,selected)?; let mut output=Vec::new(); for source in &files { output.extend(chunks(source)); if output.len()>MAX_CHUNKS { return Err("记忆片段超过 8192 上限，请整理文件后重试".into()); } }
    let mut connection=database(root)?; let tx=sql(connection.transaction())?;
    let desired: HashSet<&str> = output.iter().map(|chunk| chunk.id.as_str()).collect();
    let mut existing = HashSet::new();
    for scope in selected {
        let mut statement = sql(tx.prepare("SELECT id FROM chunks WHERE scope=?1"))?;
        let rows = sql(statement.query_map([scope], |row| row.get::<_,String>(0)))?;
        for row in rows { existing.insert(sql(row)?); }
    }
    for id in &existing { if !desired.contains(id.as_str()) { sql(tx.execute("DELETE FROM chunks_fts WHERE id=?1", [id]))?; sql(tx.execute("DELETE FROM chunks WHERE id=?1", [id]))?; } }
    for chunk in &output { if !existing.contains(&chunk.id) { sql(tx.execute("INSERT INTO chunks VALUES(?1,?2,?3,?4,?5,?6,?7)",params![chunk.id,chunk.scope,chunk.path,chunk.start as i64,chunk.end as i64,chunk.hash,chunk.text]))?; sql(tx.execute("INSERT INTO chunks_fts(id,text) VALUES(?1,?2)",params![chunk.id,chunk.text]))?; } }
    // Bound the shared derived index even after visiting many machines. Evict
    // other scopes if necessary; their Markdown remains authoritative and will
    // be indexed again when selected.
    let count: i64 = sql(tx.query_row("SELECT count(*) FROM chunks", [], |row| row.get(0)))?;
    let total: i64 = sql(tx.query_row("SELECT coalesce(sum(length(CAST(text AS BLOB))),0) FROM chunks", [], |row| row.get(0)))?;
    if count > MAX_CHUNKS as i64 || total > (MAX_TOTAL * 2) as i64 {
        let keep: HashSet<&str> = selected.iter().map(String::as_str).collect();
        let mut stale = Vec::new();
        { let mut stmt = sql(tx.prepare("SELECT DISTINCT scope FROM chunks"))?; let rows = sql(stmt.query_map([], |row| row.get::<_,String>(0)))?; for row in rows { let scope = sql(row)?; if !keep.contains(scope.as_str()) { stale.push(scope); } } }
        for scope in stale { sql(tx.execute("DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE scope=?1)", [&scope]))?; sql(tx.execute("DELETE FROM chunks WHERE scope=?1", [&scope]))?; }
    }
    // No deleted/edited source remains searchable or retains an orphan vector.
    sql(tx.execute("DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM chunks)",[]))?;
    sql(tx.commit())?; Ok(Indexed { documents:files.len(),chunks:output })
}
fn cached_embedding_count(root: &Path, indexed: &Indexed) -> Result<usize,String> {
    let hashes:HashSet<&str> = indexed.chunks.iter().map(|c|c.hash.as_str()).collect();
    let connection=database(root)?; let mut statement=sql(connection.prepare("SELECT DISTINCT hash FROM vectors"))?;
    let rows=sql(statement.query_map([], |row|row.get::<_,String>(0)))?; let mut count=0;
    for row in rows { if hashes.contains(sql(row)?.as_str()) { count+=1; } } Ok(count)
}
fn make_status(root: &Path, selected: &[String], indexed: &Indexed, embeddings: usize, mode: &str, warning: Option<String>) -> Result<MemoryStatus,String> { Ok(MemoryStatus { root:root.to_string_lossy().into_owned(),documents:indexed.documents,indexed_chunks:indexed.chunks.len(),embedding_chunks:embeddings,scopes:selected.to_vec(),mode:mode.into(),warning }) }

pub(crate) fn embedding_endpoint(value: &str) -> Result<reqwest::Url,String> {
    if value.len()>4096 { return Err("Embedding 端点地址过长".into()); }
    let mut url=reqwest::Url::parse(value.trim()).map_err(|_| "Embedding 端点地址无效".to_string())?;
    if !matches!(url.scheme(),"http"|"https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return Err("Embedding 端点须为不含用户名、密码和片段的 HTTP/HTTPS 地址".into()); }
    let path=url.path().trim_end_matches('/'); let path=if path.is_empty(){"/v1/embeddings".into()}else if path.ends_with("/embeddings"){path.into()}else{format!("{path}/embeddings")}; url.set_path(&path); Ok(url)
}
fn embedding_profile(config: &EmbeddingConfig) -> Result<String,String> {
    let url=embedding_endpoint(&config.endpoint)?;
    if config.model.trim().is_empty() || config.model.len()>256 || config.model.chars().any(char::is_control) || config.api_key.len()>4096 || config.api_key.chars().any(char::is_control) || config.dimensions.is_some_and(|v|v==0 || v>MAX_DIMENSIONS) { return Err("Embedding 模型、密钥或维度配置无效".into()); }
    Ok(hash(format!("memory-embedding-v1\0{}\0{}\0{:?}",url.as_str(),config.model.trim(),config.dimensions).as_bytes()))
}
fn valid_vector(vector: &[f32], dimensions: Option<usize>) -> bool { !vector.is_empty() && vector.len()<=MAX_DIMENSIONS && dimensions.map_or(true,|v|v==vector.len()) && vector.iter().all(|v|v.is_finite()) && vector.iter().map(|v|(*v as f64)*(*v as f64)).sum::<f64>()>f64::EPSILON }
fn parse_vectors(bytes: &[u8], count: usize, dimensions: Option<usize>) -> Result<Vec<Vec<f32>>,String> {
    #[derive(Deserialize)] struct Response { data:Vec<Item> }
    #[derive(Deserialize)] struct Item { index:usize, embedding:Vec<f32> }
    let response:Response=serde_json::from_slice(bytes).map_err(|_| EMBEDDING_ERROR.to_string())?; if response.data.len()!=count { return Err(EMBEDDING_ERROR.into()); }
    let mut result:Vec<Option<Vec<f32>>>=vec![None;count]; let mut dims=dimensions;
    for item in response.data { if item.index>=count || result[item.index].is_some() || !valid_vector(&item.embedding,dims) { return Err(EMBEDDING_ERROR.into()); } dims=Some(item.embedding.len()); result[item.index]=Some(item.embedding); }
    result.into_iter().map(|v|v.ok_or_else(||EMBEDDING_ERROR.to_string())).collect()
}
async fn embed(config: &EmbeddingConfig, texts: &[String]) -> Result<Vec<Vec<f32>>,String> {
    embed_with_timeout(config, texts, Duration::from_secs(40)).await
}
fn embedding_client(timeout: Duration) -> Result<reqwest::Client,String> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(10)).timeout(timeout).build().map_err(|_|EMBEDDING_ERROR.to_string())
}
async fn embed_with_timeout(config: &EmbeddingConfig, texts: &[String], timeout: Duration) -> Result<Vec<Vec<f32>>,String> {
    embed_with_client(config, texts, &embedding_client(timeout)?).await
}
async fn embed_with_client(config: &EmbeddingConfig, texts: &[String], client: &reqwest::Client) -> Result<Vec<Vec<f32>>,String> {
    embedding_profile(config)?; if texts.is_empty() || texts.len()>MAX_BATCH || texts.iter().map(String::len).sum::<usize>()>128*1024 { return Err(EMBEDDING_ERROR.into()); }
    let mut payload=serde_json::json!({"model":config.model.trim(),"input":texts,"encoding_format":"float"}); if let Some(dim)=config.dimensions { payload["dimensions"]=dim.into(); }
    let mut builder=client.post(embedding_endpoint(&config.endpoint)?).json(&payload); if !config.api_key.trim().is_empty() { builder=builder.bearer_auth(config.api_key.trim()); }
    let response=builder.send().await.map_err(|_|EMBEDDING_ERROR.to_string())?;
    if !response.status().is_success() || response.content_length().is_some_and(|n|n>MAX_RESPONSE as u64) { return Err(EMBEDDING_ERROR.into()); }
    let mut stream=response.bytes_stream(); let mut bytes=Vec::new(); while let Some(chunk)=stream.next().await { let chunk=chunk.map_err(|_|EMBEDDING_ERROR.to_string())?; if bytes.len()+chunk.len()>MAX_RESPONSE { return Err(EMBEDDING_ERROR.into()); } bytes.extend_from_slice(&chunk); }
    parse_vectors(&bytes,texts.len(),config.dimensions)
}
fn encode_vector(vector: &[f32]) -> Vec<u8> { vector.iter().flat_map(|v|v.to_le_bytes()).collect() }
fn decode_vector(bytes: &[u8], dimensions: usize) -> Option<Vec<f32>> { if dimensions==0 || dimensions>MAX_DIMENSIONS || bytes.len()!=dimensions*4{return None;} let vector:Vec<f32>=bytes.chunks_exact(4).map(|c|f32::from_le_bytes(c.try_into().unwrap())).collect(); valid_vector(&vector,Some(dimensions)).then_some(vector) }
async fn prepare_embeddings(root:&Path,chunks:&[Chunk],config:&EmbeddingConfig,query:&str)->Result<(String,HashMap<String,Vec<f32>>,Option<Vec<f32>>),String>{
    let profile=embedding_profile(config)?;
    // Reuse the HTTP connection pool across batches and the query embedding.
    let client=embedding_client(Duration::from_secs(40))?;
    let root2=root.to_path_buf();let key=profile.clone(); let desired:HashSet<String>=chunks.iter().map(|c|c.hash.clone()).collect();
    let mut vectors=tokio::task::spawn_blocking(move||{
        let conn=database(&root2)?; let mut statement=sql(conn.prepare("SELECT hash,dims,vector FROM vectors WHERE profile=?1"))?; let rows=sql(statement.query_map([key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)? as usize,r.get::<_,Vec<u8>>(2)?))))?;
        let mut result=HashMap::new();for row in rows{let(hash,dims,bytes)=sql(row)?;if desired.contains(&hash){if let Some(v)=decode_vector(&bytes,dims){result.insert(hash,v);}}} Ok::<_,String>(result)
    }).await.map_err(|_|INDEX_ERROR.to_string())??;
    let mut unique=HashSet::new();let missing:Vec<&Chunk>=chunks.iter().filter(|c|!vectors.contains_key(&c.hash)&&unique.insert(c.hash.clone())).collect();
    // Explicit reindex/search is bounded. Large first imports can be resumed;
    // cached successes are retained even if a later batch fails.
    let deadline=tokio::time::Instant::now()+Duration::from_secs(120);
    for batch in missing.chunks(MAX_BATCH){
        let remaining=deadline.saturating_duration_since(tokio::time::Instant::now());if remaining.is_zero(){return Err(EMBEDDING_ERROR.into());}
        let input:Vec<String>=batch.iter().map(|c|c.text.clone()).collect(); let output=tokio::time::timeout(remaining,embed_with_client(config,&input,&client)).await.map_err(|_|EMBEDDING_ERROR.to_string())??;
        if let Some(first)=vectors.values().next(){if output.iter().any(|v|v.len()!=first.len()){return Err(EMBEDDING_ERROR.into());}}
        let save:Vec<(String,Vec<f32>)>=batch.iter().zip(output).map(|(c,v)|(c.hash.clone(),v)).collect();for(h,v)in &save{vectors.insert(h.clone(),v.clone());}
        let root2=root.to_path_buf();let key=profile.clone();tokio::task::spawn_blocking(move||{let mut conn=database(&root2)?;let tx=sql(conn.transaction())?;
            // Keep one provider profile to bound the derived cache, not old models.
            sql(tx.execute("DELETE FROM vectors WHERE profile<>?1",[&key]))?;
            for(h,v)in save {sql(tx.execute("INSERT OR REPLACE INTO vectors VALUES(?1,?2,?3,?4)",params![key,h,v.len() as i64,encode_vector(&v)]))?;}sql(tx.commit())?;Ok::<_,String>(())
        }).await.map_err(|_|INDEX_ERROR.to_string())??;
    }
    let query_vector=if query.trim().is_empty(){None}else{let remaining=deadline.saturating_duration_since(tokio::time::Instant::now());let mut output=tokio::time::timeout(remaining,embed_with_client(config,&[query.to_string()],&client)).await.map_err(|_|EMBEDDING_ERROR.to_string())??;let q=output.remove(0);if vectors.values().any(|v|v.len()!=q.len()){return Err(EMBEDDING_ERROR.into());}Some(q)};
    Ok((profile,vectors,query_vector))
}
fn cosine(a:&[f32],b:&[f32])->Option<f64>{if a.len()!=b.len()||!valid_vector(a,None)||!valid_vector(b,None){return None;}let mut dot=0.0;let mut x=0.0;let mut y=0.0;for(a,b)in a.iter().zip(b){dot+=*a as f64 * *b as f64;x+=(*a as f64).powi(2);y+=(*b as f64).powi(2);}Some((dot/(x.sqrt()*y.sqrt())).clamp(-1.0,1.0))}
fn terms(query:&str)->Vec<String>{let mut output=Vec::new();let mut word=String::new();for c in query.to_lowercase().chars(){if c.is_ascii_alphanumeric()||c=='_'{word.push(c);}else{if !word.is_empty(){output.push(std::mem::take(&mut word));}if !c.is_ascii()&&!c.is_whitespace()&&!c.is_ascii_punctuation(){output.push(c.to_string());}}}if !word.is_empty(){output.push(word);}output.sort();output.dedup();output.truncate(32);output}
// UTC date parsing without platform time-zone state or an extra dependency.
// The arithmetic converts a civil date to days since 1970-01-01.
fn dated_memory_ms(path: &str) -> Option<i64> {
    let name = path.strip_prefix("memory/")?.strip_suffix(".md")?;
    if name.len() != 10 || name.as_bytes()[4] != b'-' || name.as_bytes()[7] != b'-' { return None; }
    let year: i64 = name.get(0..4)?.parse().ok()?;
    let month: i64 = name.get(5..7)?.parse().ok()?;
    let day: i64 = name.get(8..10)?.parse().ok()?;
    if year < 1 || !(1..=12).contains(&month) { return None; }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let last = match month { 2 if leap => 29, 2 => 28, 4|6|9|11 => 30, _ => 31 };
    if !(1..=last).contains(&day) { return None; }
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400); let yoe = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * shifted_month + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some(days * 86_400_000)
}
fn temporal_factor(path: &str, now: u64) -> f64 {
    let Some(timestamp) = dated_memory_ms(path) else { return 1.0; };
    let age = ((now as f64 - timestamp as f64) / 86_400_000.0).max(0.0);
    2.0_f64.powf(-age / 30.0)
}
fn is_cjk(c: char) -> bool { matches!(c as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x3040..=0x30ff | 0xac00..=0xd7af) }
fn similarity_tokens(text: &str) -> HashSet<String> {
    fn flush_word(word: &mut String, output: &mut HashSet<String>) { if !word.is_empty() { output.insert(std::mem::take(word)); } }
    fn flush_cjk(run: &mut Vec<char>, output: &mut HashSet<String>) { for c in run.iter() { output.insert(c.to_string()); } for pair in run.windows(2) { output.insert(pair.iter().collect()); } run.clear(); }
    let mut output = HashSet::new(); let mut word = String::new(); let mut cjk = Vec::new();
    for c in text.to_lowercase().chars() {
        if is_cjk(c) { flush_word(&mut word, &mut output); cjk.push(c); }
        else { flush_cjk(&mut cjk, &mut output); if c.is_alphanumeric() || c == '_' { word.push(c); } else { flush_word(&mut word, &mut output); } }
    }
    flush_word(&mut word, &mut output); flush_cjk(&mut cjk, &mut output); output
}
fn jaccard(a: &HashSet<String>, b: &HashSet<String>, a_text: &str, b_text: &str) -> f64 {
    if a.is_empty() && b.is_empty() { return if a_text.trim().to_lowercase() == b_text.trim().to_lowercase() { 1.0 } else { 0.0 }; }
    let intersection = a.intersection(b).count(); let union = a.len() + b.len() - intersection;
    if union == 0 { 0.0 } else { intersection as f64 / union as f64 }
}
fn rerank(mut candidates: Vec<MemoryHit>, count: usize, now: u64) -> Vec<MemoryHit> {
    for hit in &mut candidates { hit.score *= temporal_factor(&hit.path, now); }
    candidates.sort_by(|a,b| b.score.total_cmp(&a.score).then_with(|| a.scope.cmp(&b.scope)).then_with(|| a.path.cmp(&b.path)).then_with(|| a.start_line.cmp(&b.start_line)));
    // Exact duplicates keep the freshest / evergreen source. Bound MMR work by
    // eight candidate slots per requested hit (at most 160), not the full corpus.
    let mut seen = HashSet::new(); candidates.retain(|hit| seen.insert(hit.hash.clone())); candidates.truncate((count * 8).min(160));
    if candidates.is_empty() { return candidates; }
    let highest = candidates[0].score; let lowest = candidates.last().unwrap().score; let range = highest - lowest;
    let relevance: Vec<f64> = candidates.iter().map(|hit| if range <= f64::EPSILON { 1.0 } else { (hit.score - lowest) / range }).collect();
    let tokens: Vec<HashSet<String>> = candidates.iter().map(|hit| similarity_tokens(&hit.snippet)).collect();
    let mut selected = Vec::new(); let mut used = vec![false; candidates.len()]; let mut similarity = vec![0.0_f64; candidates.len()];
    while selected.len() < count.min(candidates.len()) {
        let best = (0..candidates.len()).filter(|i| !used[*i]).max_by(|a,b| {
            let a_score = 0.7 * relevance[*a] - 0.3 * similarity[*a]; let b_score = 0.7 * relevance[*b] - 0.3 * similarity[*b];
            a_score.total_cmp(&b_score).then_with(|| candidates[*a].score.total_cmp(&candidates[*b].score)).then_with(|| b.cmp(a))
        }).unwrap();
        used[best] = true; selected.push(candidates[best].clone());
        for next in 0..candidates.len() { if !used[next] { similarity[next] = similarity[next].max(jaccard(&tokens[next], &tokens[best], &candidates[next].snippet, &candidates[best].snippet)); } }
    }
    // Public score remains decayed relevance, not the MMR selection objective.
    selected
}
fn bm25_score(rank: f64) -> f64 {
    if !rank.is_finite() { return 0.001; }
    if rank < 0.0 { let relevance = -rank; relevance / (1.0 + relevance) } else { 1.0 / (1.0 + rank) }
}
fn keyword_scores(root:&Path,chunks:&[Chunk],query:&str)->Result<HashMap<String,f64>,String>{
    let terms=terms(query);if terms.is_empty(){return Ok(HashMap::new());}let mut result=HashMap::new();let conn=database(root)?;
    let expression=terms.iter().filter(|t|t.is_ascii()).map(|t|format!("\"{}\"",t.replace('"',"\"\""))).collect::<Vec<_>>().join(" OR ");
    if !expression.is_empty(){let mut statement=sql(conn.prepare("SELECT id,bm25(chunks_fts) FROM chunks_fts WHERE chunks_fts MATCH ?1 ORDER BY bm25(chunks_fts) LIMIT 256"))?;let rows=sql(statement.query_map([expression],|r|Ok((r.get::<_,String>(0)?,r.get::<_,f64>(1)?))))?;for row in rows{let(id,rank)=sql(row)?;result.insert(id,bm25_score(rank));}}
    // unicode61 does not segment CJK. Bounded substring coverage adds multilingual
    // recall while FTS5 supplies token matching for English/paths/commands.
    for chunk in chunks{let text=chunk.text.to_lowercase();let matched=terms.iter().filter(|t|text.contains(t.as_str())).count();if matched>0{let coverage=matched as f64/terms.len() as f64;let exact=if text.contains(&query.to_lowercase()){0.15}else{0.0};let rank_score=result.get(&chunk.id).copied().unwrap_or(0.0);result.insert(chunk.id.clone(),(coverage*0.7+exact+rank_score*0.15).min(1.0));}}
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);impl Temp{fn new()->Self{Self(std::env::temp_dir().join(format!("hurricane-memory-fixture-{}",uuid::Uuid::new_v4())))}fn state(&self)->MemoryState{MemoryState::new(self.0.clone())}}impl Drop for Temp{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    fn write(scope:&str,path:&str,content:&str)->MemoryWriteRequest{MemoryWriteRequest{scope:scope.into(),path:path.into(),content:content.into(),expected_hash:None,append:false,if_idle:false}}
    fn search(scope:&str,query:&str)->MemorySearchRequest{MemorySearchRequest{scope:scope.into(),include_global:true,query:query.into(),max_results:Some(6),min_score:Some(0.1),embedding:None}}
    #[tokio::test]async fn background_flush_rejects_busy_store_instead_of_queuing_a_late_commit(){
        let t=Temp::new();let state=t.state();let guard=state.gate.clone().lock_owned().await;
        let mut request=write("global","memory/2026-10-17.md","confirmed fact");request.if_idle=true;
        let result=tokio::time::timeout(Duration::from_secs(1),state.write(request)).await.expect("busy flush must fail immediately");
        assert!(result.unwrap_err().contains("后台整理未写入"));assert!(!t.0.exists());drop(guard);
        let mut request=write("global","memory/2026-10-17.md","confirmed fact");request.if_idle=true;
        assert!(state.write(request).await.is_ok());assert_eq!(state.list("global".into()).await.unwrap().len(),1);
    }
    #[tokio::test]async fn markdown_roundtrip_survives_new_state_and_conflicts(){let t=Temp::new();let state=t.state();let doc=state.write(write("global","MEMORY.md","# 环境\n服务在 8080 端口\n")).await.unwrap();assert_eq!(state.list("global".into()).await.unwrap().len(),1);let file=t.state().get("global".into(),"MEMORY.md".into(),Some(2),Some(1)).await.unwrap();assert_eq!(file.content,"服务在 8080 端口");assert_eq!(file.hash,doc.hash);let mut req=write("global","MEMORY.md","overwrite");req.expected_hash=Some("old".into());assert!(state.write(req).await.unwrap_err().contains("修改"));}
    #[tokio::test]async fn append_and_delete_retains_recoverable_backup(){let t=Temp::new();let state=t.state();let doc=state.write(write("machine-local","memory/2026-10-17.md","first\n")).await.unwrap();let mut req=write("machine-local","memory/2026-10-17.md","second\n");req.append=true;req.expected_hash=Some(doc.hash);let doc=state.write(req).await.unwrap();let deleted=state.delete(MemoryDeleteRequest{scope:"machine-local".into(),path:doc.path.clone(),expected_hash:Some(doc.hash)}).await.unwrap();assert_eq!(fs::read_to_string(deleted.backup_path.unwrap()).unwrap(),"first\nsecond\n");assert!(state.list("machine-local".into()).await.unwrap().is_empty());}
    #[tokio::test]async fn mixed_language_retrieval_and_machine_isolation(){let t=Temp::new();let state=t.state();let a=format!("machine-{}","a".repeat(64));let b=format!("machine-{}","b".repeat(64));state.write(write("global","MEMORY.md","团队约定 nginx 生产环境")).await.unwrap();state.write(write(&a,"MEMORY.md","nginx 专属机器A 8080")).await.unwrap();state.write(write(&b,"MEMORY.md","nginx 专属机器B 9090")).await.unwrap();let result=state.search(search(&a,"nginx")).await.unwrap();assert_eq!(result.hits.len(),2);assert!(result.hits.iter().all(|h|h.scope!=b));assert_eq!(state.search(search(&a,"生产环境")).await.unwrap().hits.len(),1);}
    #[tokio::test]async fn external_edits_and_deletes_invalidate_derived_index(){let t=Temp::new();let state=t.state();state.write(write("global","MEMORY.md","oldneedle")).await.unwrap();assert_eq!(state.search(search("global","oldneedle")).await.unwrap().hits.len(),1);fs::write(t.0.join("scopes/global/MEMORY.md"),"newneedle").unwrap();assert!(state.search(search("global","oldneedle")).await.unwrap().hits.is_empty());assert_eq!(state.search(search("global","newneedle")).await.unwrap().hits.len(),1);fs::remove_file(t.0.join("scopes/global/MEMORY.md")).unwrap();assert!(state.search(search("global","newneedle")).await.unwrap().hits.is_empty());}
    #[tokio::test]async fn path_traversal_and_resource_limits_reject_without_writes(){let t=Temp::new();let state=t.state();for path in ["../outside.md","/tmp/outside.md","memory/../x.md","memory/.hidden.md","memory/nested/x.md","MEMORY.txt"]{assert!(state.write(write("global",path,"fixture")).await.is_err());}for scope in ["../global","machine-INVALID","GLOBAL",""]{assert!(state.list(scope.into()).await.is_err());}assert!(state.write(write("global","MEMORY.md",&"x".repeat(MAX_FILE+1))).await.is_err());assert!(state.search(search("global",&"x".repeat(MAX_QUERY+1))).await.is_err());assert!(!t.0.join("outside.md").exists());}
    #[cfg(unix)]#[tokio::test]async fn symlink_sources_and_index_are_rejected(){use std::os::unix::fs::symlink;let t=Temp::new();let state=t.state();state.write(write("global","MEMORY.md","safe")).await.unwrap();let outside=t.0.join("fixture-outside");fs::write(&outside,"private").unwrap();fs::remove_file(t.0.join("scopes/global/MEMORY.md")).unwrap();symlink(&outside,t.0.join("scopes/global/MEMORY.md")).unwrap();assert!(state.get("global".into(),"MEMORY.md".into(),None,None).await.is_err());assert!(state.write(write("global","MEMORY.md","overwrite")).await.is_err());fs::remove_file(t.0.join("scopes/global/MEMORY.md")).unwrap();symlink(&outside,t.0.join("index.sqlite")).unwrap();assert!(state.status("global".into()).await.is_err());assert_eq!(fs::read_to_string(outside).unwrap(),"private");}
    #[test]fn chunks_are_utf8_safe_bounded_and_have_source_lines(){let source=Source{doc:MemoryDoc{scope:"global".into(),path:"MEMORY.md".into(),hash:"".into(),bytes:0,updated_ms:0},text:(0..200).map(|i|format!("第 {i} 行 安全数据库运维资料\n")).collect()};let list=chunks(&source);assert!(list.len()>2);for c in list{assert!(c.start>=1&&c.end>=c.start);assert!(c.text.chars().map(token_cost).sum::<usize>()<=1600);assert_eq!(c.hash,hash(c.text.as_bytes()));}}
    #[test]fn embeddings_validate_reorder_indices_dimensions_finiteness_and_nonzero(){let parsed=parse_vectors(br#"{"data":[{"index":1,"embedding":[0,1]},{"index":0,"embedding":[1,0]}]}"#,2,None).unwrap();assert_eq!(parsed[0],vec![1.0,0.0]);for bytes in [br#"{"data":[{"index":0,"embedding":[0,0]}]}"#.as_slice(),br#"{"data":[{"index":1,"embedding":[1,0]}]}"#,br#"{"data":[{"index":0,"embedding":[1,0]},{"index":0,"embedding":[1,0]}]}"#]{assert!(parse_vectors(bytes,1,None).is_err());}assert!(parse_vectors(br#"{"data":[{"index":0,"embedding":[1,0]}]}"#,1,Some(3)).is_err());assert!(!valid_vector(&[f32::NAN,1.0],None));assert!(!valid_vector(&[f32::INFINITY,1.0],None));assert!(cosine(&[1.0,0.0],&[0.0,1.0]).unwrap().abs()<0.0001);assert!(cosine(&[1.0],&[1.0,0.0]).is_none());}
    #[test]fn embedding_provider_identity_and_endpoints_are_isolated_without_plaintext_metadata(){let config=EmbeddingConfig{endpoint:"https://PROVIDER.example:443/v1/".into(),model:"fixture-model".into(),api_key:"fixture-secret".into(),dimensions:None};assert_eq!(embedding_endpoint(&config.endpoint).unwrap().as_str(),"https://provider.example/v1/embeddings");let first=embedding_profile(&config).unwrap();let mut next=config.clone();next.endpoint="https://provider.example/v1/embeddings".into();assert_eq!(first,embedding_profile(&next).unwrap());next.model="other".into();assert_ne!(first,embedding_profile(&next).unwrap());next=config.clone();next.dimensions=Some(2);assert_ne!(first,embedding_profile(&next).unwrap());assert!(!first.contains("fixture")&&!first.contains("provider"));for endpoint in ["file:///tmp/private","https://user:fixture-secret@host/v1","https://host/#fixture-secret"]{assert!(!embedding_endpoint(endpoint).unwrap_err().contains("fixture-secret"));}}

    #[tokio::test]async fn editor_default_get_returns_complete_markdown_and_final_newline(){let t=Temp::new();let state=t.state();let text=(0..900).map(|i|format!("line {i}\n")).collect::<String>();state.write(write("global","MEMORY.md",&text)).await.unwrap();let full=state.get("global".into(),"MEMORY.md".into(),None,None).await.unwrap();assert_eq!(full.content,text);assert_eq!(full.total_lines,900);let partial=state.get("global".into(),"MEMORY.md".into(),Some(899),Some(2)).await.unwrap();assert_eq!(partial.content,"line 898\nline 899");}

    #[tokio::test]async fn repeated_long_single_line_has_unique_source_chunks(){let t=Temp::new();let state=t.state();state.write(write("global","MEMORY.md",&"x".repeat(10000))).await.unwrap();let result=state.search(search("global","x")).await.unwrap();assert!(result.indexed_chunks>1);assert!(!result.hits.is_empty());let conn=database(&t.0).unwrap();let count:i64=conn.query_row("SELECT count(DISTINCT id) FROM chunks",[],|r|r.get(0)).unwrap();assert_eq!(count as usize,result.indexed_chunks);}

    fn hit(scope:&str,path:&str,text:&str,score:f64)->MemoryHit{MemoryHit{scope:scope.into(),path:path.into(),start_line:1,end_line:1,snippet:text.into(),hash:hash(text.as_bytes()),score}}
    #[test]fn mmr_prefers_diverse_sources_and_keeps_scope_metadata(){let machine=format!("machine-{}","a".repeat(64));let candidates=vec![hit(&machine,"MEMORY.md","nginx upstream database host production port",1.0),hit(&machine,"memory/duplicate.md","nginx upstream database host production port retry",0.99),hit("global","MEMORY.md","nginx certificates renewal expiry verification",0.99)];let result=rerank(candidates,2,0);assert_eq!(result.len(),2);assert_eq!(result[0].scope,machine);assert_eq!(result[1].scope,"global");assert!(result[1].snippet.contains("certificates"));assert_eq!(result[0].score,1.0);}
    #[test]fn dated_notes_decay_before_mmr_and_evergreen_remains_retrievable(){let now=dated_memory_ms("memory/2026-10-17.md").unwrap() as u64;let old=hit("global","memory/2026-09-17.md","database old port 5000",0.9);let new=hit("global","memory/2026-10-17.md","database current port 5432",0.9);let evergreen=hit("global","MEMORY.md","database stable deployment preference",0.9);let result=rerank(vec![old,new,evergreen],3,now);assert_eq!(result.last().unwrap().path,"memory/2026-09-17.md");assert!((result.last().unwrap().score-0.45).abs()<1e-10);assert!(result.iter().any(|h|h.path=="MEMORY.md"&&h.score==0.9));assert_eq!(temporal_factor("memory/topic.md",now),1.0);assert_eq!(temporal_factor("memory/2026-10-18.md",now),1.0);assert!(dated_memory_ms("memory/2026-02-30.md").is_none());assert_eq!(dated_memory_ms("memory/1970-01-01.md"),Some(0));assert!(dated_memory_ms("memory/2024-02-29.md").is_some());}
    #[test]fn exact_duplicate_ranking_keeps_recent_source_without_losing_other_fact(){let now=dated_memory_ms("memory/2026-10-17.md").unwrap() as u64;let result=rerank(vec![hit("global","memory/2020-01-01.md","database verified fact",0.9),hit("global","MEMORY.md","database verified fact",0.9),hit("global","memory/notes.md","independent nginx fact",0.8)],6,now);assert_eq!(result.len(),2);assert_eq!(result[0].path,"MEMORY.md");assert!(result.iter().any(|h|h.path=="memory/notes.md"));}
    #[test]fn cjk_mmr_tokens_support_unigrams_bigrams_and_do_not_bridge_ascii(){let a=similarity_tokens("数据库 nginx 故障排查");let b=similarity_tokens("数据库 nginx 故障修复");assert!(a.contains("数据")&&a.contains("数")&&a.contains("nginx"));assert!(!similarity_tokens("数nginx据").contains("数据"));assert!(jaccard(&a,&b,"","")>0.4);}

    struct Server { endpoint:String, requests:Arc<std::sync::Mutex<Vec<String>>>, stop:Arc<std::sync::atomic::AtomicBool>, thread:Option<std::thread::JoinHandle<()>> }
    impl Server {
        fn new(mode:&'static str)->Self {
            use std::net::TcpListener;
            let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let address=listener.local_addr().unwrap();
            let requests=Arc::new(std::sync::Mutex::new(Vec::new()));let stored=requests.clone();let stop=Arc::new(std::sync::atomic::AtomicBool::new(false));let stopped=stop.clone();
            let thread=std::thread::spawn(move||{while !stopped.load(std::sync::atomic::Ordering::Relaxed){
                match listener.accept(){Ok((mut stream,_))=>{
                    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();let mut request=Vec::new();let mut buffer=[0;4096];let mut expected=None;
                    loop{match stream.read(&mut buffer){Ok(0)|Err(_)=>break,Ok(n)=>{request.extend_from_slice(&buffer[..n]);if request.len()>256*1024{break;}if let Some(at)=request.windows(4).position(|w|w==b"\r\n\r\n"){let headers=String::from_utf8_lossy(&request[..at]).to_lowercase();let length=headers.lines().find_map(|l|l.strip_prefix("content-length:").and_then(|v|v.trim().parse::<usize>().ok())).unwrap_or(0);expected=Some(at+4+length);}if expected.is_some_and(|n|request.len()>=n){break;}}}}
                    let text=String::from_utf8_lossy(&request).into_owned();stored.lock().unwrap().push(text.clone());
                    let at=request.windows(4).position(|w|w==b"\r\n\r\n").unwrap_or(request.len());
                    let body:serde_json::Value=serde_json::from_slice(request.get(at+4..).unwrap_or(&[])).unwrap_or_default();
                    let input=body["input"].as_array().cloned().unwrap_or_default();
                    let data=input.iter().enumerate().map(|(i,v)|{let text=v.as_str().unwrap_or("");let vector=if text.contains("database")||text.contains("postgres"){vec![1.0,0.0]}else{vec![0.0,1.0]};serde_json::json!({"index":i,"embedding":vector})}).rev().collect::<Vec<_>>();
                    if mode == "slow" { std::thread::sleep(Duration::from_millis(30)); }
                    let response=match mode{
                        "failure"=>"HTTP/1.1 503 Unavailable\r\nContent-Length: 20\r\nConnection: close\r\n\r\nfixture-secret-error".into(),
                        "redirect"=>"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private-key\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
                        "oversized"=>format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",MAX_RESPONSE+1),
                        "invalid"=>{let body=r#"{"data":[{"index":0,"embedding":[0,0]}]}"#;format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body)},
                        _=>{let body=serde_json::json!({"data":data}).to_string();format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",body.len(),body)}
                    };let _=stream.write_all(response.as_bytes());
                },Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(2)),Err(_)=>break}
            }});
            Self{endpoint:format!("http://{address}/custom/v1"),requests,stop,thread:Some(thread)}
        }
        fn config(&self)->EmbeddingConfig{EmbeddingConfig{endpoint:self.endpoint.clone(),model:"fixture-embedding".into(),api_key:"fixture-secret".into(),dimensions:Some(2)}}
        fn count(&self)->usize{self.requests.lock().unwrap().len()}
    }
    impl Drop for Server{fn drop(&mut self){self.stop.store(true,std::sync::atomic::Ordering::Relaxed);if let Some(thread)=self.thread.take(){thread.join().unwrap();}}}

    #[tokio::test]async fn semantic_http_reorders_vectors_hybrid_ranks_and_cache_is_idempotent(){
        let t=Temp::new();let server=Server::new("success");let state=t.state();
        state.write(write("global","MEMORY.md","postgres configuration listens 5432")).await.unwrap();state.write(write("global","memory/2026-10-17.md","rabbitMQ message queue listens 5672")).await.unwrap();
        let mut request=search("global","database");request.embedding=Some(server.config());request.min_score=Some(0.35);
        let result=state.search(request.clone()).await.unwrap();assert_eq!(result.mode,"hybrid");assert!(result.warning.is_none());assert_eq!(result.hits.len(),1);assert!(result.hits[0].snippet.contains("postgres"));assert_eq!(result.embedding_chunks,2);assert_eq!(server.count(),2);assert_eq!(state.status("global".into()).await.unwrap().embedding_chunks,2);
        state.search(request.clone()).await.unwrap();assert_eq!(server.count(),3,"unchanged chunks use cache; only query embeds again");
        request.embedding.as_mut().unwrap().api_key="another-fixture-key".into();state.search(request.clone()).await.unwrap();assert_eq!(server.count(),4,"auth is not part of vector identity");
        request.embedding.as_mut().unwrap().model="another-model".into();state.search(request).await.unwrap();assert_eq!(server.count(),6,"changed model must re-embed document chunks");
        let requests=server.requests.lock().unwrap();assert!(requests.iter().all(|r|r.starts_with("POST /custom/v1/embeddings ")));assert!(requests[0].contains("Bearer fixture-secret"));
        let conn=database(&t.0).unwrap();let cache:Vec<u8>=conn.query_row("SELECT vector FROM vectors LIMIT 1",[],|r|r.get(0)).unwrap();assert!(decode_vector(&cache,2).is_some());
        let profiles:String=conn.query_row("SELECT group_concat(profile) FROM vectors",[],|r|r.get(0)).unwrap();assert!(!profiles.contains("fixture-secret")&&!profiles.contains("127.0.0.1"));
    }
    #[tokio::test]async fn external_change_invalidates_embedding_cache_and_deleted_vectors_are_purged(){
        let t=Temp::new();let server=Server::new("success");let state=t.state();state.write(write("global","MEMORY.md","postgres database settings")).await.unwrap();let mut request=search("global","database");request.embedding=Some(server.config());state.search(request.clone()).await.unwrap();assert_eq!(server.count(),2);
        fs::write(t.0.join("scopes/global/MEMORY.md"),"postgres database changed settings").unwrap();state.search(request.clone()).await.unwrap();assert_eq!(server.count(),4);
        fs::remove_file(t.0.join("scopes/global/MEMORY.md")).unwrap();let result=state.search(request).await.unwrap();assert!(result.hits.is_empty());let conn=database(&t.0).unwrap();assert_eq!(conn.query_row("SELECT count(*) FROM vectors",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[tokio::test]async fn failed_invalid_redirected_or_oversized_embeddings_degrade_explicitly_without_leaking_provider(){
        for mode in ["failure","invalid","redirect","oversized"]{let t=Temp::new();let server=Server::new(mode);let state=t.state();state.write(write("global","MEMORY.md","postgres database port 5432")).await.unwrap();let mut request=search("global","database");request.embedding=Some(server.config());let result=state.search(request).await.unwrap();assert_eq!(result.mode,"keyword");let warning=result.warning.unwrap();assert!(!warning.contains("fixture-secret")&&!warning.contains("127.0.0.1")&&!warning.contains("private-key"));assert_eq!(result.hits.len(),1);assert_eq!(result.embedding_chunks,0);assert_eq!(server.count(),1);}
    }
    #[tokio::test]async fn http_total_timeout_is_enforced_and_returns_no_partial_vector(){let server=Server::new("slow");let result=embed_with_timeout(&server.config(),&["database".into()],Duration::from_millis(5)).await;assert!(result.is_err());}
    #[test]fn bm25_negative_ranks_have_monotonic_finite_scores(){assert!(bm25_score(-10.0)>bm25_score(-1.0));assert!(bm25_score(-1.0)>bm25_score(-0.01));assert!((bm25_score(-1.0)-0.5).abs()<1e-10);assert!((bm25_score(2.0)-1.0/3.0).abs()<1e-10);assert_eq!(bm25_score(f64::NAN),0.001);}
    #[tokio::test]async fn explicit_embedding_test_works_without_any_memory_or_database(){let t=Temp::new();let server=Server::new("success");let result=t.state().embedding_test(server.config()).await.unwrap();assert_eq!(result.dimensions,2);assert_eq!(server.count(),1);assert!(!t.0.exists());}
    #[tokio::test]async fn reindex_recovers_corrupt_derived_database_without_touching_markdown(){let t=Temp::new();let state=t.state();state.write(write("global","MEMORY.md","recoverable database")).await.unwrap();fs::write(t.0.join("index.sqlite"),b"not-a-sqlite-database").unwrap();assert!(state.status("global".into()).await.is_err());let status=state.reindex(MemoryReindexRequest{scope:"global".into(),include_global:false,embedding:None}).await.unwrap();assert_eq!(status.documents,1);assert_eq!(state.search(search("global","recoverable")).await.unwrap().hits.len(),1);assert_eq!(fs::read_to_string(t.0.join("scopes/global/MEMORY.md")).unwrap(),"recoverable database");}
    #[tokio::test]async fn empty_expected_hash_requires_file_not_to_exist(){let t=Temp::new();let state=t.state();let mut req=write("global","MEMORY.md","new");req.expected_hash=Some(String::new());state.write(req).await.unwrap();let mut req=write("global","MEMORY.md","replacement");req.expected_hash=Some(String::new());assert!(state.write(req).await.is_err());assert_eq!(state.get("global".into(),"MEMORY.md".into(),None,None).await.unwrap().content,"new");}
}
