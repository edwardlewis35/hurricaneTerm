//! AI provider secrets live in the operating system credential store only.
//! Entries are scoped to a normalized provider endpoint; no config/Gist writes.
use sha2::{Digest, Sha256};
use std::sync::Arc;

const SERVICE: &str = "io.github.edwardlewis35.hurricaneterm.ai";
const STORE_ERROR: &str = "系统安全凭据存储不可用或访问被拒绝，请解锁钥匙串/系统密钥环后重试；API Key 未写入普通配置";

trait SecretStore: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<String>, ()>;
    fn write(&self, account: &str, key: &str) -> Result<(), ()>;
    fn delete(&self, account: &str) -> Result<(), ()>;
}

struct PlatformStore;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
impl SecretStore for PlatformStore {
    fn read(&self, account: &str) -> Result<Option<String>, ()> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|_| ())?;
        match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }
    fn write(&self, account: &str, key: &str) -> Result<(), ()> {
        keyring::Entry::new(SERVICE, account).map_err(|_| ())?.set_password(key).map_err(|_| ())
    }
    fn delete(&self, account: &str) -> Result<(), ()> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|_| ())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
impl SecretStore for PlatformStore {
    fn read(&self, _: &str) -> Result<Option<String>, ()> { Err(()) }
    fn write(&self, _: &str, _: &str) -> Result<(), ()> { Err(()) }
    fn delete(&self, _: &str) -> Result<(), ()> { Err(()) }
}

pub struct Credentials {
    store: Arc<dyn SecretStore>,
    // The native backends do not promise concurrent access ordering. Serialize
    // read/write/delete, including work still running in the blocking pool.
    gate: Arc<tokio::sync::Mutex<()>>,
}
impl Default for Credentials {
    fn default() -> Self { Self { store: Arc::new(PlatformStore), gate: Arc::new(tokio::sync::Mutex::new(())) } }
}

fn account(endpoint: &str) -> Result<String, String> {
    let mut url = crate::ai::endpoint(endpoint)?;
    // Queries can contain api-version or even a secret. They are neither
    // stored nor included in diagnostic text or credential account metadata.
    url.set_query(None);
    let digest = Sha256::digest(url.as_str().as_bytes());
    Ok(format!("endpoint-v1:{digest:x}"))
}

// Embedding credentials never share the chat account namespace, even when a
// provider hosts both APIs at the same origin/base path.
fn embedding_account(endpoint: &str) -> Result<String, String> {
    let mut url = crate::memory::embedding_endpoint(endpoint)?;
    url.set_query(None);
    let digest = Sha256::digest(url.as_str().as_bytes());
    Ok(format!("memory-embedding-v1:{digest:x}"))
}

fn valid_key(key: &str) -> Result<&str, String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
        return Err("API Key 不能为空、超过4096字节或包含控制字符；清除密钥请使用忘记功能".into());
    }
    Ok(key)
}

fn supported_platform() -> Result<(), String> {
    if cfg!(any(target_os = "macos", target_os = "windows", target_os = "linux")) { Ok(()) }
    else { Err("此平台暂不支持安全保存API Key；不会回退到明文配置".into()) }
}

impl Credentials {
    pub async fn read(&self, endpoint: String) -> Result<Option<String>, String> {
        supported_platform()?;
        let account = account(&endpoint)?;
        self.read_account(account).await
    }

    pub async fn read_embedding(&self, endpoint: String) -> Result<Option<String>, String> {
        supported_platform()?;
        self.read_account(embedding_account(&endpoint)?).await
    }

    async fn read_account(&self, account: String) -> Result<Option<String>, String> {
        let gate = self.gate.clone().lock_owned().await;
        let store = self.store.clone();
        let key = tokio::task::spawn_blocking(move || {
            let _gate = gate;
            store.read(&account).map_err(|_| STORE_ERROR.to_string())
        }).await.map_err(|_| STORE_ERROR.to_string())??;
        if let Some(key) = &key {
            valid_key(key).map_err(|_| "系统凭据中的API Key格式无效，请重新保存或忘记密钥".to_string())?;
        }
        Ok(key)
    }

    pub async fn write(&self, endpoint: String, api_key: String) -> Result<(), String> {
        supported_platform()?;
        let account = account(&endpoint)?;
        self.write_account(account, api_key).await
    }

    pub async fn write_embedding(&self, endpoint: String, api_key: String) -> Result<(), String> {
        supported_platform()?;
        self.write_account(embedding_account(&endpoint)?, api_key).await
    }

    async fn write_account(&self, account: String, api_key: String) -> Result<(), String> {
        let key = valid_key(&api_key)?.to_string();
        let gate = self.gate.clone().lock_owned().await;
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let _gate = gate;
            store.write(&account, &key).map_err(|_| STORE_ERROR.to_string())
        }).await.map_err(|_| STORE_ERROR.to_string())?
    }

    pub async fn delete(&self, endpoint: String) -> Result<(), String> {
        supported_platform()?;
        let account = account(&endpoint)?;
        self.delete_account(account).await
    }

    pub async fn delete_embedding(&self, endpoint: String) -> Result<(), String> {
        supported_platform()?;
        self.delete_account(embedding_account(&endpoint)?).await
    }

    async fn delete_account(&self, account: String) -> Result<(), String> {
        let gate = self.gate.clone().lock_owned().await;
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let _gate = gate;
            store.delete(&account).map_err(|_| STORE_ERROR.to_string())
        }).await.map_err(|_| STORE_ERROR.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    #[derive(Default)]
    struct FakeStore { keys: Mutex<HashMap<String, String>>, fail: bool }
    impl SecretStore for FakeStore {
        fn read(&self, account: &str) -> Result<Option<String>, ()> { if self.fail { Err(()) } else { Ok(self.keys.lock().unwrap().get(account).cloned()) } }
        fn write(&self, account: &str, key: &str) -> Result<(), ()> { if self.fail { Err(()) } else { self.keys.lock().unwrap().insert(account.into(), key.into()); Ok(()) } }
        fn delete(&self, account: &str) -> Result<(), ()> { if self.fail { Err(()) } else { self.keys.lock().unwrap().remove(account); Ok(()) } }
    }
    fn state(store: Arc<FakeStore>) -> Credentials { Credentials { store, gate: Arc::new(tokio::sync::Mutex::new(())) } }
    #[test]
    fn endpoint_namespace_normalizes_equivalent_urls_without_storing_the_url() {
        let a = account("https://PROVIDER.example:443/v1/").unwrap();
        assert_eq!(a, account("https://provider.example/v1/chat/completions").unwrap());
        assert_eq!(a, account("https://provider.example/v1?api-version=123&token=fixture-secret").unwrap());
        assert!(!a.contains("provider") && !a.contains("fixture-secret"));
        assert_ne!(a, account("https://other.example/v1").unwrap());
        assert_ne!(a, account("http://provider.example/v1").unwrap());
        assert_ne!(a, account("https://provider.example/other").unwrap());
    }
    #[test]
    fn invalid_endpoints_never_echo_credentials() {
        for endpoint in ["file:///private/path", "https://user:fixture-secret@host/v1", "https://host/v1#fixture-secret", "not-an-endpoint"] {
            let error = account(endpoint).unwrap_err(); assert!(!error.contains("fixture-secret"));
        }
    }
    #[test]
    fn key_validation_rejects_empty_controls_and_oversized_without_echo() {
        for key in ["".into(), "fixture\nsecret".into(), "a".repeat(4097)] {
            let error = valid_key(&key).unwrap_err(); assert!(!error.contains("fixture"));
        }
        assert_eq!(valid_key("  fixture-key  ").unwrap(), "fixture-key");
    }
    #[tokio::test]
    async fn save_read_delete_and_endpoint_isolation_use_only_the_store() {
        let store = Arc::new(FakeStore::default()); let credentials = state(store.clone());
        let a = "https://one.example/v1".to_string(); let b = "https://two.example/v1".to_string();
        assert_eq!(credentials.read(a.clone()).await.unwrap(), None);
        credentials.write(a.clone(), "fixture-key".into()).await.unwrap();
        assert_eq!(credentials.read(a.clone()).await.unwrap().as_deref(), Some("fixture-key"));
        assert_eq!(state(store.clone()).read(a.clone()).await.unwrap().as_deref(), Some("fixture-key"));
        assert_eq!(credentials.read(b).await.unwrap(), None);
        credentials.delete(a.clone()).await.unwrap(); credentials.delete(a.clone()).await.unwrap();
        assert_eq!(credentials.read(a).await.unwrap(), None); assert!(store.keys.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn store_failure_is_explicit_and_contains_no_key_or_endpoint() {
        let credentials = state(Arc::new(FakeStore { fail: true, ..Default::default() }));
        let endpoint = "https://private-provider.invalid/v1".to_string();
        for error in [credentials.write(endpoint.clone(), "fixture-secret".into()).await.unwrap_err(), credentials.read(endpoint.clone()).await.unwrap_err(), credentials.delete(endpoint).await.unwrap_err()] {
            assert_eq!(error, STORE_ERROR); assert!(!error.contains("fixture-secret") && !error.contains("private-provider"));
        }
    }
    #[tokio::test]
    async fn corrupt_native_key_is_not_returned_or_logged() {
        let store = Arc::new(FakeStore::default()); let endpoint = "https://one.example/v1".to_string();
        store.keys.lock().unwrap().insert(account(&endpoint).unwrap(), "fixture\nsecret".into());
        let error = state(store).read(endpoint).await.unwrap_err(); assert!(!error.contains("fixture"));
    }

    #[tokio::test]
    async fn embedding_and_chat_keys_are_separate_and_equivalent_embedding_urls_share_only_embedding_entry() {
        let store = Arc::new(FakeStore::default()); let credentials = state(store.clone());
        let endpoint = "https://one.example/v1".to_string();
        credentials.write(endpoint.clone(), "chat-secret".into()).await.unwrap();
        credentials.write_embedding(endpoint.clone(), "embedding-secret".into()).await.unwrap();
        assert_eq!(credentials.read(endpoint.clone()).await.unwrap().as_deref(), Some("chat-secret"));
        assert_eq!(credentials.read_embedding("https://one.example/v1/embeddings?api-version=1".into()).await.unwrap().as_deref(), Some("embedding-secret"));
        credentials.delete_embedding(endpoint.clone()).await.unwrap();
        assert_eq!(credentials.read_embedding(endpoint.clone()).await.unwrap(), None);
        assert_eq!(credentials.read(endpoint).await.unwrap().as_deref(), Some("chat-secret"));
        assert_eq!(store.keys.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn cancelled_ipc_keeps_native_write_serialized_until_it_finishes() {
        use std::sync::Condvar;
        #[derive(Default)]
        struct BlockingStore {
            key: Mutex<Option<String>>, started: tokio::sync::Notify,
            released: (Mutex<bool>, Condvar),
        }
        impl SecretStore for BlockingStore {
            fn read(&self, _: &str) -> Result<Option<String>, ()> { Ok(self.key.lock().unwrap().clone()) }
            fn write(&self, _: &str, key: &str) -> Result<(), ()> {
                self.started.notify_one();
                let (released, wake) = &self.released;
                let guard = released.lock().unwrap();
                let _guard = wake.wait_while(guard, |released| !*released).unwrap();
                *self.key.lock().unwrap() = Some(key.into()); Ok(())
            }
            fn delete(&self, _: &str) -> Result<(), ()> { *self.key.lock().unwrap() = None; Ok(()) }
        }
        let store = Arc::new(BlockingStore::default());
        let credentials = Arc::new(Credentials { store: store.clone(), gate: Arc::new(tokio::sync::Mutex::new(())) });
        let writer_state = credentials.clone();
        let writer = tokio::spawn(async move { writer_state.write("https://fixture.invalid/v1".into(), "fixture-key".into()).await });
        store.started.notified().await;
        writer.abort();
        let reader_state = credentials.clone();
        let mut reader = tokio::spawn(async move { reader_state.read("https://fixture.invalid/v1".into()).await });
        let held = tokio::time::timeout(std::time::Duration::from_millis(30), &mut reader).await.is_err();
        *store.released.0.lock().unwrap() = true;
        store.released.1.notify_all();
        assert!(held, "a detached native write must still hold its ordering lock");
        assert_eq!(reader.await.unwrap().unwrap().as_deref(), Some("fixture-key"));
    }
}
