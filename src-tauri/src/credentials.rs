//! App-managed secrets: random installation key + authenticated encrypted vault.
//! Both files stay in this user's private app folder. This keeps plaintext out
//! of configuration/export; an account able to read both files can decrypt it.
//! No system credential API or old system-store entry is accessed or deleted.
use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const FORMAT: &str = "hurricane-ai-secret-vault";
const VERSION: u32 = 1;
const ALGORITHM: &str = "aes-256-gcm";
const AAD: &[u8] = b"hurricaneTerm/ai-secrets/v1/aes-256-gcm";
const KEY_MAGIC: &[u8] = b"HURRICANE-AI-KEY\x01";
const KEY_FILE: &str = "installation.key";
const VAULT_FILE: &str = "credentials.enc.json";
const LOCK_FILE: &str = "vault.lock";
const MAX_ENTRIES: usize = 128;
const MAX_PLAINTEXT: usize = 768 * 1024;
const MAX_VAULT: usize = 1024 * 1024 + 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StoreError { Unavailable, Busy, Corrupt, MissingKey, Limit }
impl StoreError {
    fn message(self) -> String { match self {
        Self::Unavailable => "应用本地密钥库操作失败，请检查应用存储权限后重试；密钥不会写入普通配置",
        Self::Busy => "应用本地密钥库正被另一实例使用，请稍后重试",
        Self::Corrupt => "应用本地密钥库损坏、格式不受支持或无法解密；原文件已保留，请恢复完整备份后重试",
        Self::MissingKey => "应用本地密钥库的解密文件缺失；原密文已保留，请恢复完整备份后重试",
        Self::Limit => "应用本地密钥库已达到容量限制，请删除不再使用的服务密钥后重试",
    }.into() }
}
type StoreResult<T> = Result<T, StoreError>;
trait SecretStore: Send + Sync {
    fn read(&self, account: &str) -> StoreResult<Option<String>>;
    fn write(&self, account: &str, key: &str) -> StoreResult<()>;
    fn delete(&self, account: &str) -> StoreResult<()>;
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope { format: String, version: u32, algorithm: String, nonce: String, ciphertext: String }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Contents { version: u32, entries: BTreeMap<String, String> }

struct LocalStore { root: PathBuf, #[cfg(test)] fault: Option<Arc<dyn Fn(&str) -> bool + Send + Sync>> }
impl LocalStore {
    fn new(root: PathBuf) -> Self { Self { root, #[cfg(test)] fault: None } }
    fn fault(&self, _stage: &str) -> StoreResult<()> {
        #[cfg(test)] if self.fault.as_ref().map(|check| check(_stage)).unwrap_or(false) { return Err(StoreError::Unavailable); }
        Ok(())
    }
    fn load(root: &RootHandle) -> StoreResult<Option<(Contents, [u8; 32])>> {
        let Some(bytes) = root.read(VAULT_FILE, MAX_VAULT)? else { return Ok(None); };
        let key = Self::load_key(root)?.ok_or(StoreError::MissingKey)?;
        let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|_| StoreError::Corrupt)?;
        if envelope.format != FORMAT || envelope.version != VERSION || envelope.algorithm != ALGORITHM { return Err(StoreError::Corrupt); }
        if envelope.nonce.len() != 16 || envelope.ciphertext.len() > MAX_VAULT { return Err(StoreError::Corrupt); }
        let nonce = STANDARD.decode(&envelope.nonce).map_err(|_| StoreError::Corrupt)?;
        let ciphertext = STANDARD.decode(&envelope.ciphertext).map_err(|_| StoreError::Corrupt)?;
        if nonce.len() != 12 || ciphertext.len() < 16 || ciphertext.len() > MAX_PLAINTEXT + 16 { return Err(StoreError::Corrupt); }
        let plaintext = Aes256Gcm::new_from_slice(&key).map_err(|_| StoreError::Corrupt)?
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ciphertext, aad: AAD }).map_err(|_| StoreError::Corrupt)?;
        if plaintext.len() > MAX_PLAINTEXT { return Err(StoreError::Corrupt); }
        let contents: Contents = serde_json::from_slice(&plaintext).map_err(|_| StoreError::Corrupt)?;
        if contents.version != VERSION || contents.entries.len() > MAX_ENTRIES { return Err(StoreError::Corrupt); }
        for (account, key) in &contents.entries {
            if !valid_account(account) || valid_key(key).ok() != Some(key.as_str()) { return Err(StoreError::Corrupt); }
        }
        Ok(Some((contents, key)))
    }
    fn load_key(root: &RootHandle) -> StoreResult<Option<[u8; 32]>> {
        let Some(bytes) = root.read(KEY_FILE, KEY_MAGIC.len() + 32)? else { return Ok(None); };
        if bytes.len() != KEY_MAGIC.len() + 32 || !bytes.starts_with(KEY_MAGIC) { return Err(StoreError::Corrupt); }
        let mut key = [0; 32]; key.copy_from_slice(&bytes[KEY_MAGIC.len()..]); Ok(Some(key))
    }
    fn create_key(&self, root: &RootHandle) -> StoreResult<[u8; 32]> {
        if let Some(key) = Self::load_key(root)? { return Ok(key); }
        if root.exists(VAULT_FILE)? { return Err(StoreError::MissingKey); }
        let key = random_bytes::<32>()?;
        let mut bytes = KEY_MAGIC.to_vec(); bytes.extend_from_slice(&key);
        self.atomic_write(root, KEY_FILE, &bytes, false)?; Ok(key)
    }
    fn save(&self, root: &RootHandle, contents: &Contents, key: &[u8; 32]) -> StoreResult<()> {
        if contents.entries.len() > MAX_ENTRIES { return Err(StoreError::Limit); }
        let plaintext = serde_json::to_vec(contents).map_err(|_| StoreError::Unavailable)?;
        if plaintext.len() > MAX_PLAINTEXT { return Err(StoreError::Limit); }
        let nonce = random_bytes::<12>()?;
        let ciphertext = Aes256Gcm::new_from_slice(key).map_err(|_| StoreError::Unavailable)?
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plaintext, aad: AAD }).map_err(|_| StoreError::Unavailable)?;
        let envelope = Envelope { format: FORMAT.into(), version: VERSION, algorithm: ALGORITHM.into(), nonce: STANDARD.encode(nonce), ciphertext: STANDARD.encode(ciphertext) };
        let bytes = serde_json::to_vec(&envelope).map_err(|_| StoreError::Unavailable)?;
        if bytes.len() > MAX_VAULT { return Err(StoreError::Limit); }
        self.atomic_write(root, VAULT_FILE, &bytes, true)
    }
    fn atomic_write(&self, root: &RootHandle, name: &str, bytes: &[u8], replace: bool) -> StoreResult<()> {
        let random = random_bytes::<16>()?;
        let temporary = format!(".pending-{}.tmp", random.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
        let file = root.create_new(&temporary)?;
        let mut cleanup = PendingFile { root, name: temporary.clone(), active: true, file: Some(file) };
        self.fault("before-write")?;
        let file = cleanup.file.as_mut().ok_or(StoreError::Unavailable)?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| StoreError::Unavailable)?;
        self.fault("after-sync")?;
        cleanup.file.take();
        self.fault(if replace { "before-vault-commit" } else { "before-key-commit" })?;
        root.commit(&temporary, name, replace)?;
        cleanup.active = false;
        root.sync()?;
        // A post-commit failure is indeterminate. Keep the complete new file;
        // never roll it back over a concurrent user's subsequently saved key.
        self.fault("after-commit")
    }
}
fn process_gate() -> &'static Mutex<()> { static GATE: OnceLock<Mutex<()>> = OnceLock::new(); GATE.get_or_init(|| Mutex::new(())) }
impl SecretStore for LocalStore {
    fn read(&self, account: &str) -> StoreResult<Option<String>> {
        let _gate = process_gate().lock().map_err(|_| StoreError::Unavailable)?;
        let Some(root) = RootHandle::open(&self.root, false)? else { return Ok(None); };
        if !root.exists(VAULT_FILE)? { return Ok(None); }
        let _lock = root.lock()?;
        Ok(Self::load(&root)?.and_then(|(contents, _)| contents.entries.get(account).cloned()))
    }
    fn write(&self, account: &str, key: &str) -> StoreResult<()> {
        let _gate = process_gate().lock().map_err(|_| StoreError::Unavailable)?;
        let root = RootHandle::open(&self.root, true)?.ok_or(StoreError::Unavailable)?;
        let _lock = root.lock()?;
        let (mut contents, key_material) = match Self::load(&root)? {
            Some(value) => value,
            None => (Contents { version: VERSION, entries: BTreeMap::new() }, self.create_key(&root)?),
        };
        if !contents.entries.contains_key(account) && contents.entries.len() >= MAX_ENTRIES { return Err(StoreError::Limit); }
        contents.entries.insert(account.into(), key.into()); self.save(&root, &contents, &key_material)
    }
    fn delete(&self, account: &str) -> StoreResult<()> {
        let _gate = process_gate().lock().map_err(|_| StoreError::Unavailable)?;
        let Some(root) = RootHandle::open(&self.root, false)? else { return Ok(()); };
        if !root.exists(VAULT_FILE)? { return Ok(()); }
        let _lock = root.lock()?;
        let Some((mut contents, key)) = Self::load(&root)? else { return Ok(()); };
        if contents.entries.remove(account).is_some() { self.save(&root, &contents, &key)?; } Ok(())
    }
}
fn random_bytes<const N: usize>() -> StoreResult<[u8; N]> { let mut bytes = [0; N]; rand::rngs::OsRng.try_fill_bytes(&mut bytes).map_err(|_| StoreError::Unavailable)?; Ok(bytes) }
fn valid_account(value: &str) -> bool {
    value.strip_prefix("endpoint-v1:").or_else(|| value.strip_prefix("memory-embedding-v1:"))
        .map(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))).unwrap_or(false)
}
fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { metadata.file_type().is_symlink() }
}
fn io_error(error: io::Error) -> StoreError {
    if error.kind() == io::ErrorKind::WouldBlock || cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)) { StoreError::Busy } else { StoreError::Unavailable }
}
struct RootHandle { path: PathBuf, directory: File }
impl RootHandle {
    fn open(path: &Path, create: bool) -> StoreResult<Option<Self>> {
        if !path.is_absolute() || !path.components().any(|part| matches!(part, Component::Normal(_)))
            || path.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir)) { return Err(StoreError::Unavailable); }
        let mut walked = PathBuf::new();
        for component in path.components() {
            walked.push(component.as_os_str());
            #[cfg(windows)] if matches!(component, Component::Prefix(_)) { continue; }
            match fs::symlink_metadata(&walked) {
                Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {}
                Ok(_) => return Err(StoreError::Unavailable),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if !create { return Ok(None); }
                    let mut builder = fs::DirBuilder::new();
                    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
                    match builder.create(&walked) { Ok(()) => {}, Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}, Err(_) => return Err(StoreError::Unavailable) }
                    let metadata = fs::symlink_metadata(&walked).map_err(io_error)?;
                    if !metadata.is_dir() || is_reparse(&metadata) { return Err(StoreError::Unavailable); }
                }
                Err(error) => return Err(io_error(error)),
            }
        }
        let mut options = OpenOptions::new(); options.read(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC); }
        #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x02000000 | 0x00200000).share_mode(0x1 | 0x2); }
        let directory = options.open(path).map_err(io_error)?;
        let metadata = directory.metadata().map_err(io_error)?;
        if !metadata.is_dir() || is_reparse(&metadata) { return Err(StoreError::Unavailable); }
        #[cfg(unix)] {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.uid() != unsafe { libc::geteuid() } { return Err(StoreError::Unavailable); }
            if metadata.permissions().mode() & 0o077 != 0 { directory.set_permissions(fs::Permissions::from_mode(0o700)).map_err(io_error)?; }
        }
        Ok(Some(Self { path: path.into(), directory }))
    }
    fn open_file(&self, name: &str, create: bool, writable: bool) -> StoreResult<Option<File>> {
        debug_assert!(!name.contains('/') && !name.contains('\\'));
        #[cfg(unix)] let result = {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = std::ffi::CString::new(name).map_err(|_| StoreError::Unavailable)?;
            let flags = (if writable { libc::O_RDWR } else { libc::O_RDONLY }) | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
                | if create { libc::O_CREAT | libc::O_EXCL } else { 0 };
            let descriptor = unsafe { libc::openat(self.directory.as_raw_fd(), name.as_ptr(), flags, 0o600) };
            if descriptor < 0 { Err(io::Error::last_os_error()) } else { Ok(unsafe { File::from_raw_fd(descriptor) }) }
        };
        #[cfg(not(unix))] let result = {
            let path = self.path.join(name);
            if let Ok(metadata) = fs::symlink_metadata(&path) { if !metadata.is_file() || is_reparse(&metadata) { return Err(StoreError::Unavailable); } }
            let mut options = OpenOptions::new(); options.read(true).write(writable).create_new(create);
            #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x00200000).share_mode(0); }
            options.open(path)
        };
        let file = match result { Ok(file) => file, Err(error) if !create && error.kind() == io::ErrorKind::NotFound => return Ok(None), Err(error) => return Err(io_error(error)) };
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_file() || is_reparse(&metadata) { return Err(StoreError::Unavailable); }
        #[cfg(unix)] {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() } { return Err(StoreError::Unavailable); }
            if metadata.permissions().mode() & 0o077 != 0 { file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(io_error)?; }
        }
        Ok(Some(file))
    }
    fn create_new(&self, name: &str) -> StoreResult<File> { self.open_file(name, true, true)?.ok_or(StoreError::Unavailable) }
    fn exists(&self, name: &str) -> StoreResult<bool> { Ok(self.open_file(name, false, false)?.is_some()) }
    fn read(&self, name: &str, limit: usize) -> StoreResult<Option<Vec<u8>>> {
        let Some(file) = self.open_file(name, false, false)? else { return Ok(None); };
        if file.metadata().map_err(io_error)?.len() > limit as u64 { return Err(StoreError::Corrupt); }
        let mut bytes = Vec::new(); file.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(io_error)?;
        if bytes.len() > limit { return Err(StoreError::Corrupt); } Ok(Some(bytes))
    }
    fn lock(&self) -> StoreResult<File> {
        let file = match self.create_new(LOCK_FILE) {
            Ok(file) => file,
            Err(StoreError::Unavailable) => self.open_file(LOCK_FILE, false, true)?.ok_or(StoreError::Unavailable)?,
            Err(error) => return Err(error),
        };
        if file.metadata().map_err(io_error)?.len() != 0 { return Err(StoreError::Corrupt); }
        #[cfg(unix)] {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err(io_error(io::Error::last_os_error())); }
        }
        Ok(file) // Windows share_mode(0) remains exclusive until blocking IO ends.
    }
    fn commit(&self, temporary: &str, name: &str, replace: bool) -> StoreResult<()> {
        #[cfg(unix)] {
            use std::os::fd::AsRawFd;
            let source = std::ffi::CString::new(temporary).map_err(|_| StoreError::Unavailable)?;
            let destination = std::ffi::CString::new(name).map_err(|_| StoreError::Unavailable)?;
            let fd = self.directory.as_raw_fd();
            let result = unsafe { if replace { libc::renameat(fd, source.as_ptr(), fd, destination.as_ptr()) }
                else { libc::linkat(fd, source.as_ptr(), fd, destination.as_ptr(), 0) } };
            if result != 0 { return Err(io_error(io::Error::last_os_error())); }
            if !replace { self.remove(temporary)?; }
        }
        #[cfg(windows)] {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "kernel32")]
            extern "system" { fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32; }
            let source: Vec<u16> = self.path.join(temporary).as_os_str().encode_wide().chain(Some(0)).collect();
            let destination: Vec<u16> = self.path.join(name).as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x8 | if replace { 0x1 } else { 0 }) } == 0 { return Err(io_error(io::Error::last_os_error())); }
        }
        #[cfg(not(any(unix, windows)))] { let _ = (temporary, name, replace); return Err(StoreError::Unavailable); }
        Ok(())
    }
    fn remove(&self, name: &str) -> StoreResult<()> {
        #[cfg(unix)] {
            use std::os::fd::AsRawFd;
            let name = std::ffi::CString::new(name).map_err(|_| StoreError::Unavailable)?;
            if unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) } != 0 { return Err(io_error(io::Error::last_os_error())); }
        }
        #[cfg(not(unix))] fs::remove_file(self.path.join(name)).map_err(io_error)?;
        Ok(())
    }
    fn sync(&self) -> StoreResult<()> {
        #[cfg(unix)] self.directory.sync_all().map_err(io_error)?;
        // Windows uses mandatory temp sync_all + MoveFileExW WRITE_THROUGH.
        // std offers no portable Windows directory-fsync guarantee.
        Ok(())
    }
}
struct PendingFile<'a> { root: &'a RootHandle, name: String, active: bool, file: Option<File> }
impl Drop for PendingFile<'_> { fn drop(&mut self) { self.file.take(); if self.active { let _ = self.root.remove(&self.name); } } }

pub struct Credentials { store: Arc<dyn SecretStore>, gate: Arc<tokio::sync::Mutex<()>> }
impl Credentials {
    pub fn new(root: PathBuf) -> Self { Self { store: Arc::new(LocalStore::new(root)), gate: Arc::new(tokio::sync::Mutex::new(())) } }
    pub async fn read(&self, endpoint: String) -> Result<Option<String>, String> { self.read_account(account(&endpoint)?).await }
    pub async fn read_embedding(&self, endpoint: String) -> Result<Option<String>, String> { self.read_account(embedding_account(&endpoint)?).await }
    async fn read_account(&self, account: String) -> Result<Option<String>, String> {
        let gate = self.gate.clone().lock_owned().await; let store = self.store.clone();
        let key = tokio::task::spawn_blocking(move || { let _gate = gate; store.read(&account).map_err(StoreError::message) }).await.map_err(|_| StoreError::Unavailable.message())??;
        if let Some(key) = &key { valid_key(key).map_err(|_| StoreError::Corrupt.message())?; } Ok(key)
    }
    pub async fn write(&self, endpoint: String, key: String) -> Result<(), String> { self.write_account(account(&endpoint)?, key).await }
    pub async fn write_embedding(&self, endpoint: String, key: String) -> Result<(), String> { self.write_account(embedding_account(&endpoint)?, key).await }
    async fn write_account(&self, account: String, key: String) -> Result<(), String> {
        let key = valid_key(&key)?.to_string(); let gate = self.gate.clone().lock_owned().await; let store = self.store.clone();
        tokio::task::spawn_blocking(move || { let _gate = gate; store.write(&account, &key).map_err(StoreError::message) }).await.map_err(|_| StoreError::Unavailable.message())?
    }
    pub async fn delete(&self, endpoint: String) -> Result<(), String> { self.delete_account(account(&endpoint)?).await }
    pub async fn delete_embedding(&self, endpoint: String) -> Result<(), String> { self.delete_account(embedding_account(&endpoint)?).await }
    async fn delete_account(&self, account: String) -> Result<(), String> {
        let gate = self.gate.clone().lock_owned().await; let store = self.store.clone();
        tokio::task::spawn_blocking(move || { let _gate = gate; store.delete(&account).map_err(StoreError::message) }).await.map_err(|_| StoreError::Unavailable.message())?
    }
}
fn account(endpoint: &str) -> Result<String, String> { let mut url = crate::ai::endpoint(endpoint)?; url.set_query(None); Ok(format!("endpoint-v1:{:x}", Sha256::digest(url.as_str().as_bytes()))) }
fn embedding_account(endpoint: &str) -> Result<String, String> { let mut url = crate::memory::embedding_endpoint(endpoint)?; url.set_query(None); Ok(format!("memory-embedding-v1:{:x}", Sha256::digest(url.as_str().as_bytes()))) }
fn valid_key(key: &str) -> Result<&str, String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 || key.chars().any(char::is_control) { return Err("API Key 不能为空、超过4096字节或包含控制字符；清除密钥请使用忘记功能".into()); } Ok(key)
}
#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
