use super::*;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

#[derive(Default)]
struct FakeStore { keys: Mutex<BTreeMap<String, String>>, fail: bool }
impl SecretStore for FakeStore {
    fn read(&self, account: &str) -> StoreResult<Option<String>> { if self.fail { Err(StoreError::Unavailable) } else { Ok(self.keys.lock().unwrap().get(account).cloned()) } }
    fn write(&self, account: &str, key: &str) -> StoreResult<()> { if self.fail { Err(StoreError::Unavailable) } else { self.keys.lock().unwrap().insert(account.into(), key.into()); Ok(()) } }
    fn delete(&self, account: &str) -> StoreResult<()> { if self.fail { Err(StoreError::Unavailable) } else { self.keys.lock().unwrap().remove(account); Ok(()) } }
}
fn state(store: Arc<dyn SecretStore>) -> Credentials { Credentials { store, gate: Arc::new(tokio::sync::Mutex::new(())) } }
struct Temp { parent: PathBuf, root: PathBuf }
impl Temp {
    fn new() -> Self {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let suffix = random_bytes::<16>().unwrap().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let parent = base.join(format!("hurricane-credentials-test-{}-{suffix}", std::process::id()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
        builder.create(&parent).unwrap(); Self { root: parent.join("ai-secrets"), parent }
    }
    fn store(&self) -> LocalStore { LocalStore::new(self.root.clone()) }
    fn credentials(&self) -> Credentials { Credentials::new(self.root.clone()) }
    fn seed(&self) -> String { let id = account("https://fixture.invalid/v1").unwrap(); self.store().write(&id, "fixture-original-secret").unwrap(); id }
    fn file(&self, name: &str) -> PathBuf { self.root.join(name) }
    fn assert_no_pending(&self) { assert!(!fs::read_dir(&self.root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".pending-"))); }
}
impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.parent); } }
fn encode_contents(contents: &Contents, key: &[u8; 32], aad: &[u8]) -> Vec<u8> {
    let nonce = random_bytes::<12>().unwrap();
    let cipher = Aes256Gcm::new_from_slice(key).unwrap().encrypt(Nonce::from_slice(&nonce), Payload { msg: &serde_json::to_vec(contents).unwrap(), aad }).unwrap();
    serde_json::to_vec(&Envelope { format: FORMAT.into(), version: VERSION, algorithm: ALGORITHM.into(), nonce: STANDARD.encode(nonce), ciphertext: STANDARD.encode(cipher) }).unwrap()
}

// Retain the original eight API/namespace/serialization regressions. These now
// exercise the unchanged public contracts with the local-store error mapping.
#[test]
fn endpoint_namespace_normalizes_equivalent_urls_without_storing_the_url() {
    let a = account("https://PROVIDER.example:443/v1/").unwrap();
    assert_eq!(a, account("https://provider.example/v1/chat/completions").unwrap());
    assert_eq!(a, account("https://provider.example/v1?api-version=123&token=fixture-secret").unwrap());
    assert!(!a.contains("provider") && !a.contains("fixture-secret"));
    for endpoint in ["https://other.example/v1", "http://provider.example/v1", "https://provider.example/other"] { assert_ne!(a, account(endpoint).unwrap()); }
}
#[test]
fn invalid_endpoints_never_echo_credentials() {
    for endpoint in ["file:///private/path", "https://user:fixture-secret@host/v1", "https://host/v1#fixture-secret", "not-an-endpoint"] {
        assert!(!account(endpoint).unwrap_err().contains("fixture-secret"));
    }
}
#[test]
fn key_validation_rejects_empty_controls_and_oversized_without_echo() {
    for key in ["".into(), "fixture\nsecret".into(), "a".repeat(4097)] { assert!(!valid_key(&key).unwrap_err().contains("fixture")); }
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
        assert_eq!(error, StoreError::Unavailable.message()); assert!(!error.contains("fixture-secret") && !error.contains("private-provider"));
    }
}
#[tokio::test]
async fn corrupt_native_key_is_not_returned_or_logged() {
    let store = Arc::new(FakeStore::default()); let endpoint = "https://one.example/v1".to_string();
    store.keys.lock().unwrap().insert(account(&endpoint).unwrap(), "fixture\nsecret".into());
    assert!(!state(store).read(endpoint).await.unwrap_err().contains("fixture"));
}
#[tokio::test]
async fn embedding_and_chat_keys_are_separate_and_equivalent_embedding_urls_share_only_embedding_entry() {
    let store = Arc::new(FakeStore::default()); let credentials = state(store.clone()); let endpoint = "https://one.example/v1".to_string();
    credentials.write(endpoint.clone(), "chat-secret".into()).await.unwrap(); credentials.write_embedding(endpoint.clone(), "embedding-secret".into()).await.unwrap();
    assert_eq!(credentials.read(endpoint.clone()).await.unwrap().as_deref(), Some("chat-secret"));
    assert_eq!(credentials.read_embedding("https://one.example/v1/embeddings?api-version=1".into()).await.unwrap().as_deref(), Some("embedding-secret"));
    credentials.delete_embedding(endpoint.clone()).await.unwrap(); assert_eq!(credentials.read_embedding(endpoint.clone()).await.unwrap(), None);
    assert_eq!(credentials.read(endpoint).await.unwrap().as_deref(), Some("chat-secret")); assert_eq!(store.keys.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn cancelled_ipc_keeps_native_write_serialized_until_it_finishes() {
    #[derive(Default)] struct BlockingStore { key: Mutex<Option<String>>, started: tokio::sync::Notify, released: (Mutex<bool>, Condvar) }
    impl SecretStore for BlockingStore {
        fn read(&self, _: &str) -> StoreResult<Option<String>> { Ok(self.key.lock().unwrap().clone()) }
        fn write(&self, _: &str, key: &str) -> StoreResult<()> {
            self.started.notify_one(); let guard = self.released.0.lock().unwrap();
            let _guard = self.released.1.wait_while(guard, |released| !*released).unwrap(); *self.key.lock().unwrap() = Some(key.into()); Ok(())
        }
        fn delete(&self, _: &str) -> StoreResult<()> { *self.key.lock().unwrap() = None; Ok(()) }
    }
    let store = Arc::new(BlockingStore::default()); let credentials = Arc::new(state(store.clone()));
    let writer_state = credentials.clone(); let writer = tokio::spawn(async move { writer_state.write("https://fixture.invalid/v1".into(), "fixture-key".into()).await });
    store.started.notified().await; writer.abort();
    let reader_state = credentials.clone(); let mut reader = tokio::spawn(async move { reader_state.read("https://fixture.invalid/v1".into()).await });
    let held = tokio::time::timeout(Duration::from_millis(30), &mut reader).await.is_err();
    *store.released.0.lock().unwrap() = true; store.released.1.notify_all();
    assert!(held); assert_eq!(reader.await.unwrap().unwrap().as_deref(), Some("fixture-key"));
}

#[tokio::test]
async fn absent_read_and_delete_do_not_create_local_files() {
    let temp = Temp::new(); let credentials = temp.credentials(); let endpoint = "https://fixture.invalid/v1".to_string();
    assert_eq!(credentials.read(endpoint.clone()).await.unwrap(), None);
    assert_eq!(credentials.read_embedding(endpoint.clone()).await.unwrap(), None);
    credentials.delete(endpoint.clone()).await.unwrap(); credentials.delete_embedding(endpoint).await.unwrap();
    assert!(!temp.root.exists()); assert_eq!(fs::read_dir(&temp.parent).unwrap().count(), 0);
}
#[tokio::test]
async fn encrypted_restart_roundtrip_keeps_keys_and_endpoints_out_of_disk_plaintext() {
    let temp = Temp::new(); let endpoint = "https://private-fixture.invalid/v1?token=private-query".to_string();
    temp.credentials().write(endpoint.clone(), "fixture-chat-private".into()).await.unwrap();
    temp.credentials().write_embedding(endpoint.clone(), "fixture-embedding-private".into()).await.unwrap();
    let reopened = temp.credentials(); assert_eq!(reopened.read(endpoint.clone()).await.unwrap().as_deref(), Some("fixture-chat-private"));
    assert_eq!(reopened.read_embedding(endpoint).await.unwrap().as_deref(), Some("fixture-embedding-private"));
    for entry in fs::read_dir(&temp.root).unwrap() {
        let raw = fs::read(entry.unwrap().path()).unwrap();
        for secret in ["fixture-chat-private", "fixture-embedding-private", "private-fixture", "private-query", "endpoint-v1:", "memory-embedding-v1:"] { assert!(!raw.windows(secret.len()).any(|window| window == secret.as_bytes())); }
    }
    temp.assert_no_pending();
}
#[test]
fn installation_key_and_every_saved_nonce_are_random_and_updates_preserve_other_accounts() {
    let first = Temp::new(); let second = Temp::new(); let a = first.seed(); second.seed();
    let key = fs::read(first.file(KEY_FILE)).unwrap(); assert_ne!(key, fs::read(second.file(KEY_FILE)).unwrap());
    let original = fs::read(first.file(VAULT_FILE)).unwrap(); let b = embedding_account("https://fixture.invalid/v1").unwrap();
    first.store().write(&b, "fixture-embedding").unwrap(); let updated = fs::read(first.file(VAULT_FILE)).unwrap();
    first.store().write(&b, "fixture-embedding").unwrap(); let repeated = fs::read(first.file(VAULT_FILE)).unwrap();
    let nonce = |bytes: &[u8]| serde_json::from_slice::<Envelope>(bytes).unwrap().nonce;
    assert_ne!(nonce(&original), nonce(&updated)); assert_ne!(nonce(&updated), nonce(&repeated));
    assert_eq!(fs::read(first.file(KEY_FILE)).unwrap(), key); assert_eq!(first.store().read(&a).unwrap().as_deref(), Some("fixture-original-secret"));
}
#[test]
fn deletes_are_idempotent_and_do_not_touch_other_keys_or_unrelated_files() {
    let temp = Temp::new(); let a = temp.seed(); let b = embedding_account("https://fixture.invalid/v1").unwrap(); temp.store().write(&b, "fixture-other").unwrap();
    let sentinel = temp.root.join("unrelated.txt"); fs::write(&sentinel, b"retained").unwrap();
    temp.store().delete(&a).unwrap(); let bytes = fs::read(temp.file(VAULT_FILE)).unwrap(); temp.store().delete(&a).unwrap();
    assert_eq!(fs::read(temp.file(VAULT_FILE)).unwrap(), bytes); assert_eq!(fs::read(&sentinel).unwrap(), b"retained");
    assert_eq!(temp.store().read(&a).unwrap(), None); assert_eq!(temp.store().read(&b).unwrap().as_deref(), Some("fixture-other"));
}
#[test]
fn missing_corrupt_or_wrong_key_never_regenerates_over_existing_ciphertext() {
    for variant in ["missing", "truncated", "header", "wrong"] {
        let temp = Temp::new(); let id = temp.seed(); let original = fs::read(temp.file(VAULT_FILE)).unwrap();
        if variant == "missing" { fs::remove_file(temp.file(KEY_FILE)).unwrap(); }
        else { let mut key = fs::read(temp.file(KEY_FILE)).unwrap(); if variant == "truncated" { key.truncate(10); } else if variant == "header" { key[0] ^= 1; } else { *key.last_mut().unwrap() ^= 1; } fs::write(temp.file(KEY_FILE), key).unwrap(); }
        let old_key = fs::read(temp.file(KEY_FILE)).ok();
        assert!(temp.store().read(&id).is_err()); assert!(temp.store().write(&id, "fixture-new").is_err()); assert!(temp.store().delete(&id).is_err());
        assert_eq!(fs::read(temp.file(VAULT_FILE)).unwrap(), original); assert_eq!(fs::read(temp.file(KEY_FILE)).ok(), old_key); temp.assert_no_pending();
    }
}
#[test]
fn bad_envelopes_and_authentication_fail_closed_without_overwriting() {
    for variant in ["version", "format", "algorithm", "unknown-field", "truncated", "nonce", "ciphertext", "oversized"] {
        let temp = Temp::new(); let id = temp.seed(); let mut value: serde_json::Value = serde_json::from_slice(&fs::read(temp.file(VAULT_FILE)).unwrap()).unwrap();
        match variant { "version" => value["version"] = 999.into(), "format" => value["format"] = "foreign".into(), "algorithm" => value["algorithm"] = "none".into(),
            "unknown-field" => value["extra"] = true.into(), "nonce" => value["nonce"] = STANDARD.encode([1; 12]).into(), "ciphertext" => value["ciphertext"] = STANDARD.encode([1; 32]).into(), _ => {} }
        let mut bytes = serde_json::to_vec(&value).unwrap(); if variant == "truncated" { bytes.truncate(20); } if variant == "oversized" { bytes.resize(MAX_VAULT + 1, b'x'); }
        fs::write(temp.file(VAULT_FILE), &bytes).unwrap();
        assert!(temp.store().read(&id).is_err()); assert!(temp.store().write(&id, "fixture-new").is_err()); assert!(temp.store().delete(&id).is_err());
        assert_eq!(fs::read(temp.file(VAULT_FILE)).unwrap(), bytes); temp.assert_no_pending();
    }
}
#[test]
fn authenticated_payload_still_validates_namespace_key_format_version_and_bounds() {
    for variant in ["namespace", "key", "version", "entries", "aad"] {
        let temp = Temp::new(); let id = temp.seed(); let root = RootHandle::open(&temp.root, false).unwrap().unwrap(); let key = LocalStore::load_key(&root).unwrap().unwrap();
        let mut contents = Contents { version: VERSION, entries: BTreeMap::from([(id.clone(), "fixture-key".into())]) };
        match variant { "namespace" => { contents.entries.insert("untrusted-account".into(), "fixture".into()); }, "key" => { contents.entries.insert(id.clone(), "fixture\nsecret".into()); },
            "version" => contents.version = 999, "entries" => for i in 0..=MAX_ENTRIES { contents.entries.insert(format!("endpoint-v1:{i:064x}"), "fixture".into()); }, _ => {} }
        let bytes = encode_contents(&contents, &key, if variant == "aad" { b"different-domain" } else { AAD }); fs::write(temp.file(VAULT_FILE), &bytes).unwrap();
        assert!(temp.store().read(&id).is_err()); assert!(temp.store().write(&id, "fixture-new").is_err()); assert_eq!(fs::read(temp.file(VAULT_FILE)).unwrap(), bytes);
    }
}
#[test]
fn capacity_refuses_new_entries_without_losing_existing_keys_and_delete_frees_space() {
    let temp = Temp::new(); temp.seed(); let root = RootHandle::open(&temp.root, false).unwrap().unwrap(); let key = LocalStore::load_key(&root).unwrap().unwrap();
    let contents = Contents { version: VERSION, entries: (0..MAX_ENTRIES).map(|i| (format!("endpoint-v1:{i:064x}"), "fixture".into())).collect() };
    fs::write(temp.file(VAULT_FILE), encode_contents(&contents, &key, AAD)).unwrap();
    let before = fs::read(temp.file(VAULT_FILE)).unwrap(); let fresh = account("https://new.fixture.invalid/v1").unwrap();
    assert_eq!(temp.store().write(&fresh, "fixture-new"), Err(StoreError::Limit)); assert_eq!(fs::read(temp.file(VAULT_FILE)).unwrap(), before);
    temp.store().delete(&format!("endpoint-v1:{:064x}", 0)).unwrap(); temp.store().write(&fresh, "fixture-new").unwrap(); assert_eq!(temp.store().read(&fresh).unwrap().as_deref(), Some("fixture-new"));
}
#[test]
fn precommit_faults_leave_previous_vault_unchanged_and_clean_temporary_files() {
    for stage in ["before-write", "after-sync", "before-vault-commit"] {
        let temp = Temp::new(); let id = temp.seed(); let before = fs::read(temp.file(VAULT_FILE)).unwrap();
        let broken = LocalStore { root: temp.root.clone(), fault: Some(Arc::new(move |name| name == stage)) };
        assert_eq!(broken.write(&id, "fixture-replacement"), Err(StoreError::Unavailable)); assert_eq!(fs::read(temp.file(VAULT_FILE)).unwrap(), before);
        assert_eq!(temp.store().read(&id).unwrap().as_deref(), Some("fixture-original-secret")); temp.assert_no_pending();
    }
}
#[test]
fn initial_key_commit_failure_is_retryable_and_never_creates_a_partial_vault() {
    for stage in ["before-write", "after-sync", "before-key-commit", "after-commit"] {
        let temp = Temp::new(); let id = account("https://fixture.invalid/v1").unwrap();
        let broken = LocalStore { root: temp.root.clone(), fault: Some(Arc::new(move |name| name == stage)) };
        assert!(broken.write(&id, "fixture-initial").is_err()); assert!(!temp.file(VAULT_FILE).exists()); temp.assert_no_pending();
        temp.store().write(&id, "fixture-retry").unwrap(); assert_eq!(temp.store().read(&id).unwrap().as_deref(), Some("fixture-retry"));
    }
}
#[test]
fn error_after_atomic_commit_keeps_a_complete_readable_new_vault() {
    let temp = Temp::new(); let id = temp.seed();
    let broken = LocalStore { root: temp.root.clone(), fault: Some(Arc::new(|stage| stage == "after-commit")) };
    assert!(broken.write(&id, "fixture-committed").is_err()); assert_eq!(temp.store().read(&id).unwrap().as_deref(), Some("fixture-committed")); temp.assert_no_pending();
}
#[tokio::test]
async fn independent_instances_serialize_real_file_updates_without_lost_accounts() {
    let temp = Temp::new(); let mut jobs = tokio::task::JoinSet::new();
    for i in 0..24 { let root = temp.root.clone(); jobs.spawn(async move { Credentials::new(root).write(format!("https://instance-{i}.invalid/v1"), format!("fixture-{i}")).await }); }
    while let Some(result) = jobs.join_next().await { result.unwrap().unwrap(); }
    for i in 0..24 { assert_eq!(temp.credentials().read(format!("https://instance-{i}.invalid/v1")).await.unwrap(), Some(format!("fixture-{i}"))); }
}
#[test]
fn held_cross_instance_lock_fails_fast_and_never_exposes_secret_or_path() {
    let temp = Temp::new(); let id = temp.seed(); let root = RootHandle::open(&temp.root, false).unwrap().unwrap(); let _lock = root.lock().unwrap();
    for error in [temp.store().read(&id).unwrap_err(), temp.store().write(&id, "fixture-new").unwrap_err(), temp.store().delete(&id).unwrap_err()] {
        assert_eq!(error, StoreError::Busy); assert!(!error.message().contains("fixture") && !error.message().contains(temp.root.to_str().unwrap()));
    }
}
#[tokio::test]
async fn cancelled_real_file_write_keeps_shared_locks_until_background_commit_finishes() {
    let temp = Temp::new(); temp.seed(); let started = Arc::new(tokio::sync::Notify::new()); let release = Arc::new((Mutex::new(false), Condvar::new()));
    let signal = started.clone(); let wake = release.clone();
    let store = LocalStore { root: temp.root.clone(), fault: Some(Arc::new(move |stage| {
        if stage == "before-vault-commit" { signal.notify_one(); let guard = wake.0.lock().unwrap(); let _guard = wake.1.wait_while(guard, |ready| !*ready).unwrap(); } false
    })) };
    let credentials = Arc::new(state(Arc::new(store))); let writer_state = credentials.clone();
    let writer = tokio::spawn(async move { writer_state.write("https://fixture.invalid/v1".into(), "fixture-after-cancel".into()).await });
    started.notified().await; writer.abort();
    let other = temp.credentials(); let mut reader = tokio::spawn(async move { other.read("https://fixture.invalid/v1".into()).await });
    let held = tokio::time::timeout(Duration::from_millis(30), &mut reader).await.is_err();
    *release.0.lock().unwrap() = true; release.1.notify_all(); assert!(held);
    assert_eq!(reader.await.unwrap().unwrap().as_deref(), Some("fixture-after-cancel")); temp.assert_no_pending();
}
#[test]
fn separate_processes_preserve_all_accounts_under_real_os_lock_contention() {
    let temp = Temp::new(); temp.seed(); let executable = std::env::current_exe().unwrap();
    let launch = |worker: &str| std::process::Command::new(&executable).args(["--exact", "credentials::tests::subprocess_writer_child", "--nocapture"])
        .env("HURRICANE_CREDENTIAL_TEST_ROOT", &temp.root).env("HURRICANE_CREDENTIAL_TEST_WORKER", worker)
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
    let first = launch("first"); let second = launch("second");
    for child in [first, second] { let result = child.wait_with_output().unwrap(); assert!(result.status.success(), "child failed: {}", String::from_utf8_lossy(&result.stdout)); }
    for worker in ["first", "second"] { for i in 0..8 { let endpoint = format!("https://{worker}-{i}.fixture.invalid/v1"); assert_eq!(temp.store().read(&account(&endpoint).unwrap()).unwrap(), Some(format!("fixture-{worker}-{i}"))); } }
    temp.assert_no_pending();
}
#[test]
fn subprocess_writer_child() {
    let Some(root) = std::env::var_os("HURRICANE_CREDENTIAL_TEST_ROOT") else { return; };
    let worker = std::env::var("HURRICANE_CREDENTIAL_TEST_WORKER").unwrap(); assert!(matches!(worker.as_str(), "first" | "second"));
    let root = PathBuf::from(root); assert!(root.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with("hurricane-credentials-test-"));
    let store = LocalStore::new(root);
    for i in 0..8 { let account = account(&format!("https://{worker}-{i}.fixture.invalid/v1")).unwrap(); let key = format!("fixture-{worker}-{i}"); let mut done = false;
        for _ in 0..500 { match store.write(&account, &key) { Ok(()) => { done = true; break; }, Err(StoreError::Busy) => std::thread::sleep(Duration::from_millis(2)), Err(error) => panic!("unexpected fixture store error: {error:?}") } } assert!(done);
    }
}
#[test]
fn invalid_root_paths_and_nonregular_files_are_rejected() {
    let temp = Temp::new(); assert!(LocalStore::new(PathBuf::from("relative/ai-secrets")).read("ignored").is_err());
    // PathBuf::join normalizes `..` after a Windows verbatim prefix, including
    // canonicalize's output. Append raw OS text so the store receives traversal.
    for parts in [&[".."][..], &["..", "ai-secrets"][..]] {
        let mut raw = temp.root.as_os_str().to_os_string();
        for part in parts { raw.push(std::path::MAIN_SEPARATOR.to_string()); raw.push(part); }
        let traversal = PathBuf::from(raw);
        assert!(traversal.is_absolute());
        assert!(traversal.components().any(|part| matches!(part, Component::ParentDir)));
        assert!(LocalStore::new(traversal).read("ignored").is_err());
    }
    assert!(LocalStore::new(PathBuf::new()).read("ignored").is_err());
    let root_only: PathBuf = temp.root.components().take_while(|part| !matches!(part, Component::Normal(_))).collect();
    assert!(root_only.is_absolute());
    assert!(!root_only.components().any(|part| matches!(part, Component::Normal(_))));
    assert!(LocalStore::new(root_only).read("ignored").is_err());
    #[cfg(windows)] {
        for raw in [r"C:ai-secrets", r"\ai-secrets"] {
            let relative = PathBuf::from(raw); assert!(!relative.is_absolute());
            assert!(LocalStore::new(relative).read("ignored").is_err());
        }
        for raw in [r"C:\vault\..\outside", r"\\?\C:\vault\..\outside", r"\\server\share\vault\..\outside", r"\\?\UNC\server\share\vault\..\outside"] {
            let traversal = PathBuf::from(raw); assert!(traversal.is_absolute());
            assert!(traversal.components().any(|part| matches!(part, Component::ParentDir)));
            assert!(LocalStore::new(traversal).read("ignored").is_err());
        }
    }
    assert!(!temp.root.exists());
    let ordinary = temp.parent.join("ordinary.txt"); fs::write(&ordinary, b"retained").unwrap();
    assert!(LocalStore::new(ordinary.join("ai-secrets")).read("ignored").is_err()); assert_eq!(fs::read(&ordinary).unwrap(), b"retained");
    for name in [KEY_FILE, VAULT_FILE, LOCK_FILE] {
        let bad = Temp::new(); let id = bad.seed(); fs::remove_file(bad.file(name)).unwrap(); fs::create_dir(bad.file(name)).unwrap();
        assert!(bad.store().read(&id).is_err()); assert!(bad.store().write(&id, "fixture").is_err());
    }
}

#[cfg(unix)]
#[test]
fn unix_private_directory_and_file_permissions_are_created_and_repaired_only_for_owner() {
    use std::os::unix::fs::PermissionsExt;
    let temp = Temp::new(); let id = temp.seed();
    assert_eq!(fs::metadata(&temp.root).unwrap().permissions().mode() & 0o777, 0o700);
    for name in [KEY_FILE, VAULT_FILE, LOCK_FILE] { assert_eq!(fs::metadata(temp.file(name)).unwrap().permissions().mode() & 0o777, 0o600); fs::set_permissions(temp.file(name), fs::Permissions::from_mode(0o644)).unwrap(); }
    fs::set_permissions(&temp.root, fs::Permissions::from_mode(0o755)).unwrap(); temp.store().read(&id).unwrap();
    assert_eq!(fs::metadata(&temp.root).unwrap().permissions().mode() & 0o777, 0o700);
    for name in [KEY_FILE, VAULT_FILE, LOCK_FILE] { assert_eq!(fs::metadata(temp.file(name)).unwrap().permissions().mode() & 0o777, 0o600); }
}

#[cfg(unix)]
#[test]
fn unix_symbolic_links_hardlinks_and_fifo_cannot_redirect_vault_operations() {
    use std::os::unix::fs::symlink;
    use std::os::unix::ffi::OsStrExt;
    let outside = Temp::new(); fs::create_dir(&outside.root).unwrap(); let alias = outside.parent.join("linked-directory"); symlink(&outside.root, &alias).unwrap();
    assert!(LocalStore::new(alias).write(&account("https://fixture.invalid/v1").unwrap(), "fixture").is_err()); assert_eq!(fs::read_dir(&outside.root).unwrap().count(), 0);
    for name in [KEY_FILE, VAULT_FILE, LOCK_FILE] {
        let temp = Temp::new(); let id = temp.seed(); let other = temp.parent.join("outside-bytes"); fs::write(&other, b"must-not-change").unwrap(); fs::remove_file(temp.file(name)).unwrap(); symlink(&other, temp.file(name)).unwrap();
        assert!(temp.store().read(&id).is_err()); assert!(temp.store().write(&id, "fixture").is_err()); assert_eq!(fs::read(&other).unwrap(), b"must-not-change");
    }
    let temp = Temp::new(); let id = temp.seed(); let hardlink = temp.parent.join("hardlinked-key"); fs::hard_link(temp.file(KEY_FILE), &hardlink).unwrap();
    assert!(temp.store().read(&id).is_err()); assert!(temp.store().write(&id, "fixture").is_err()); fs::remove_file(hardlink).unwrap();
    fs::remove_file(temp.file(KEY_FILE)).unwrap(); let fifo = std::ffi::CString::new(temp.file(KEY_FILE).as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0); assert!(temp.store().read(&id).is_err());
}

#[cfg(unix)]
#[test]
fn unix_foreign_owned_storage_is_rejected_before_permissions_or_contents_change() {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::ffi::OsStrExt;
    let uid = unsafe { libc::geteuid() };
    if uid != 0 {
        let directory = fs::canonicalize("/etc").unwrap(); assert_ne!(fs::metadata(&directory).unwrap().uid(), uid);
        let before = fs::metadata(&directory).unwrap().mode(); assert!(RootHandle::open(&directory, false).is_err()); assert_eq!(fs::metadata(&directory).unwrap().mode(), before);
    } else {
        let temp = Temp::new(); let id = temp.seed(); let path = std::ffi::CString::new(temp.file(KEY_FILE).as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::chown(path.as_ptr(), 65534, !0) }, 0); let bytes = fs::read(temp.file(KEY_FILE)).unwrap();
        assert!(temp.store().read(&id).is_err()); assert_eq!(fs::read(temp.file(KEY_FILE)).unwrap(), bytes);
    }
}
