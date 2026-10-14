//! Local file-manager operations. Mutations never implicitly replace a destination
//! and recursive copies preserve symlinks instead of traversing them.
use crate::FsEntry;
use base64::Engine;
use serde::Serialize;
use std::fs::{self, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const TEXT_LIMIT: u64 = 2 * 1024 * 1024;
pub const IMAGE_LIMIT: u64 = 15 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct FilePreview {
    pub kind: String,
    pub content: String,
    /// Milliseconds since the epoch; the editor treats this as a revision token.
    pub modified: u64,
    pub size: u64,
    pub revision: String,
}

pub fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法确定本地家目录".into())
}

pub fn absolute(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() { return Err("路径不能为空".into()); }
    let input = if path == "~" {
        home()?
    } else if path.starts_with("~/") || path.starts_with("~\\") {
        home()?.join(&path[2..])
    } else {
        PathBuf::from(path)
    };
    let input = if input.is_absolute() { input } else {
        std::env::current_dir().map_err(|e| e.to_string())?.join(input)
    };
    // Resolve symlinks before `..` by leaving lexical components intact here.
    // canonicalize resolves existing paths, and target() resolves the parent of
    // a new entry without following a symlink at its final component.
    Ok(input)
}

fn target(path: &str) -> Result<PathBuf, String> {
    let last = path.trim_end_matches(std::path::MAIN_SEPARATOR).rsplit(std::path::MAIN_SEPARATOR).next().unwrap_or("");
    if last == "." || last == ".." { return Err("修改操作需要明确的文件或目录名".into()); }
    let p = absolute(path)?;
    let name = p.file_name().ok_or("不能修改文件系统根目录")?;
    if matches!(p.components().next_back(), Some(Component::ParentDir | Component::CurDir)) {
        return Err("修改操作需要明确的文件或目录名".into());
    }
    let parent = p.parent().ok_or("路径没有父目录")?;
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    Ok(parent.join(name))
}

fn protected(path: &Path) -> Result<(), String> {
    if path.parent().is_none() { return Err("不能修改文件系统根目录".into()); }
    // A link can itself be removed/moved without touching its target. For real
    // directories compare identity, not spelling: APFS/NTFS accept case aliases.
    if fs::symlink_metadata(path).is_ok_and(|md| md.is_symlink()) { return Ok(()); }
    if let Ok(h) = home() {
        if same_directory(path, &h).unwrap_or(false) {
            return Err("不能删除或移动整个家目录".into());
        }
    }
    Ok(())
}

fn same_directory(left: &Path, right: &Path) -> Result<bool, String> {
    let a = fs::metadata(left).map_err(|e| e.to_string())?;
    let b = fs::metadata(right).map_err(|e| e.to_string())?;
    if !a.is_dir() || !b.is_dir() { return Ok(false); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(a.dev() == b.dev() && a.ino() == b.ino())
    }
    #[cfg(not(unix))]
    {
        let a = fs::canonicalize(left).map_err(|e| e.to_string())?;
        let b = fs::canonicalize(right).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        return Ok(a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase());
        #[cfg(not(windows))]
        Ok(a == b)
    }
}

fn inside_directory(directory: &Path, new_entry: &Path) -> Result<bool, String> {
    // new_entry's parent has already been canonicalized by target(). Directory
    // identity also detects alternate case spellings and bind-mount aliases.
    for ancestor in new_entry.ancestors().skip(1) {
        if same_directory(directory, ancestor)? { return Ok(true); }
    }
    Ok(false)
}

pub fn modified_ms(md: &Metadata) -> u64 {
    md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64).unwrap_or(0)
}

/// A content-change token, not a security hash. Paired with mtime it catches
/// edits on file systems that expose coarse modification timestamps.
pub fn revision(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn entry(path: PathBuf) -> Result<FsEntry, String> {
    let link_md = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    let md = if link_md.is_symlink() { fs::metadata(&path).unwrap_or_else(|_| link_md.clone()) } else { link_md.clone() };
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        Some(md.permissions().mode() & 0o7777)
    };
    #[cfg(not(unix))]
    let permissions = None;
    Ok(FsEntry {
        name: path.file_name().unwrap_or(path.as_os_str()).to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        is_dir: md.is_dir(),
        size: if md.is_file() { md.len() } else { 0 },
        modified: modified_ms(&md) / 1000,
        is_link: link_md.is_symlink(),
        permissions,
    })
}

pub fn realpath(path: Option<&str>) -> Result<String, String> {
    let p = match path.filter(|p| !p.trim().is_empty()) { Some(p) => absolute(p)?, None => home()? };
    fs::canonicalize(p).map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

pub fn list(path: Option<&str>) -> Result<Vec<FsEntry>, String> {
    let dir = PathBuf::from(realpath(path)?);
    let mut out = Vec::new();
    for child in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let child = child.map_err(|e| e.to_string())?;
        out.push(entry(child.path())?);
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

pub fn stat(path: &str) -> Result<Option<FsEntry>, String> {
    let path = absolute(path)?;
    // Keep final symlinks (including broken links) inspectable in the manager.
    match fs::symlink_metadata(&path) {
        Ok(_) => entry(path).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn mkdir(path: &str) -> Result<(), String> {
    fs::create_dir(target(path)?).map_err(|e| e.to_string())
}

pub fn create_file(path: &str) -> Result<(), String> {
    OpenOptions::new().write(true).create_new(true).open(target(path)?)
        .map(|_| ()).map_err(|e| e.to_string())
}

fn ensure_absent(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
        Ok(_) => Err("目标已存在，操作不会覆盖现有文件".into()),
    }
}

pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> Result<(), String> {
    ensure_absent(to)?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::ffi::OsStrExt;
        let from = std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let to = std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let rc = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(target_os = "linux")]
        let rc = unsafe { libc::renameat2(libc::AT_FDCWD, from.as_ptr(), libc::AT_FDCWD, to.as_ptr(), libc::RENAME_NOREPLACE) };
        if rc != 0 { return Err(std::io::Error::last_os_error().to_string()); }
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fs::rename(from, to).map_err(|e| e.to_string())
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    let from = target(from)?;
    let to = target(to)?;
    protected(&from)?;
    protected(&to)?;
    rename_exclusive(&from, &to)
}

pub fn remove(path: &str, recursive: bool) -> Result<(), String> {
    let path = target(path)?;
    protected(&path)?;
    let md = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if md.is_dir() && !md.is_symlink() {
        if recursive { fs::remove_dir_all(path) } else { fs::remove_dir(path) }
    } else {
        fs::remove_file(path)
    }.map_err(|e| e.to_string())
}

fn image_type(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") { Some("image/png") }
    else if data.starts_with(b"\xff\xd8\xff") { Some("image/jpeg") }
    else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") { Some("image/gif") }
    else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" { Some("image/webp") }
    else if data.starts_with(b"BM") { Some("image/bmp") }
    else if data.starts_with(&[0, 0, 1, 0]) { Some("image/x-icon") }
    else { None }
}

fn text_content(data: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(data).map_err(|_| "该文件是二进制文件或不是 UTF-8，无法安全编辑")?;
    if text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t' | '\u{c}')) {
        return Err("该文件包含二进制控制字符，无法安全编辑".into());
    }
    Ok(text.to_owned())
}

/// Shared decoding rules also used by the remote SFTP editor.
pub fn preview_bytes(data: &[u8], modified: u64, size: u64) -> Result<FilePreview, String> {
    if let Some(mime) = image_type(data) {
        if size > IMAGE_LIMIT || data.len() as u64 > IMAGE_LIMIT { return Err("图片预览上限为 15 MiB".into()); }
        Ok(FilePreview { kind: "image".into(), content: format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(data)), modified, size, revision: revision(data) })
    } else {
        if size > TEXT_LIMIT || data.len() as u64 > TEXT_LIMIT { return Err("文本编辑上限为 2 MiB".into()); }
        Ok(FilePreview { kind: "text".into(), content: text_content(data)?, modified, size, revision: revision(data) })
    }
}

pub fn read_file(path: &str) -> Result<FilePreview, String> {
    let file = fs::File::open(absolute(path)?).map_err(|e| e.to_string())?;
    let md = file.metadata().map_err(|e| e.to_string())?;
    if !md.is_file() { return Err("只能预览普通文件".into()); }
    if md.len() > IMAGE_LIMIT { return Err("文件超过预览上限 15 MiB".into()); }
    let mut data = Vec::new();
    file.take(IMAGE_LIMIT + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
    preview_bytes(&data, modified_ms(&md), data.len() as u64)
}

fn check_editable(path: &Path, expected_modified: Option<u64>, expected_revision: Option<&str>, force: bool) -> Result<Metadata, String> {
    let md = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !md.is_file() || md.is_symlink() { return Err("只能编辑普通文件；符号链接不能直接保存".into()); }
    if !force && expected_modified.is_some_and(|expected| expected != modified_ms(&md)) {
        return Err("文件已在外部修改。请重新加载，或确认强制覆盖".into());
    }
    if md.len() > TEXT_LIMIT { return Err("文本编辑上限为 2 MiB".into()); }
    let mut data = Vec::new();
    fs::File::open(path).map_err(|e| e.to_string())?.take(TEXT_LIMIT + 1)
        .read_to_end(&mut data).map_err(|e| e.to_string())?;
    if data.len() as u64 > TEXT_LIMIT { return Err("文本编辑上限为 2 MiB".into()); }
    text_content(&data)?;
    if !force && expected_revision.is_some_and(|expected| expected != revision(&data)) {
        return Err("文件内容已在外部修改。请重新加载，或确认强制覆盖".into());
    }
    Ok(md)
}

pub fn write_file(path: &str, content: &str, expected_modified: Option<u64>, expected_revision: Option<&str>, force: bool) -> Result<(), String> {
    if !force && expected_modified.is_none() && expected_revision.is_none() {
        return Err("安全保存需要预览时的修改时间或内容修订号".into());
    }
    if content.len() as u64 > TEXT_LIMIT { return Err("文本编辑上限为 2 MiB".into()); }
    text_content(content.as_bytes())?;
    let path = target(path)?;
    let md = check_editable(&path, expected_modified, expected_revision, force)?;
    let parent = path.parent().ok_or("路径没有父目录")?;
    let temp = parent.join(format!(".hurricaneterm-save-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut output = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
        output.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        output.set_permissions(md.permissions()).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        check_editable(&path, expected_modified, expected_revision, force)?;
        fs::rename(&temp, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    let md = fs::symlink_metadata(from).map_err(|e| e.to_string())?;
    if md.is_symlink() {
        let link = fs::read_link(from).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(link, to).map_err(|e| e.to_string());
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileTypeExt;
            return if md.file_type().is_symlink_dir() { std::os::windows::fs::symlink_dir(link, to) }
                else { std::os::windows::fs::symlink_file(link, to) }.map_err(|e| e.to_string());
        }
        #[cfg(not(any(unix, windows)))]
        return Err("当前平台不支持安全复制符号链接".into());
    }
    if md.is_dir() {
        fs::create_dir(to).map_err(|e| e.to_string())?;
        for child in fs::read_dir(from).map_err(|e| e.to_string())? {
            let child = child.map_err(|e| e.to_string())?;
            copy_tree(&child.path(), &to.join(child.file_name()))?;
        }
        fs::set_permissions(to, md.permissions()).map_err(|e| e.to_string())?;
    } else if md.is_file() {
        let mut input = fs::File::open(from).map_err(|e| e.to_string())?;
        let mut output = OpenOptions::new().write(true).create_new(true).open(to).map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output.set_permissions(md.permissions()).map_err(|e| e.to_string())?;
    } else { return Err("不支持复制设备、套接字或其它特殊文件".into()); }
    Ok(())
}

pub fn copy(from: &str, to: &str, move_item: bool) -> Result<(), String> {
    let from = target(from)?;
    let to = target(to)?;
    if move_item { protected(&from)?; }
    protected(&to)?;
    ensure_absent(&to)?;
    let md = fs::symlink_metadata(&from).map_err(|e| e.to_string())?;
    if md.is_dir() && inside_directory(&from, &to)? { return Err("不能将目录复制或移动到自身的子目录".into()); }
    if move_item {
        // Cross-filesystem moves fall back to a complete copy before removal.
        match rename_exclusive(&from, &to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                #[cfg(unix)]
                if fs::metadata(from.parent().unwrap()).ok().zip(fs::metadata(to.parent().unwrap()).ok())
                    .is_some_and(|(a, b)| { use std::os::unix::fs::MetadataExt; a.dev() == b.dev() }) {
                    return Err(e);
                }
                // A raced destination must never become an overwrite fallback.
                ensure_absent(&to)?;
            }
        }
    }
    copy_tree(&from, &to)?;
    if move_item { remove(from.to_str().ok_or("路径不是 UTF-8")?, true)?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("hurricaneterm-files-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&p).unwrap(); Self(p)
        }
        fn path(&self, name: &str) -> String { self.0.join(name).to_string_lossy().into_owned() }
    }
    impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn exclusive_mutations_preserve_existing_content() {
        let d = Scratch::new(); let a = d.path("a"); let b = d.path("b");
        create_file(&a).unwrap(); fs::write(&a, "original").unwrap(); fs::write(&b, "destination").unwrap();
        assert!(create_file(&a).is_err()); assert!(rename(&a, &b).is_err()); assert!(copy(&a, &b, false).is_err());
        assert_eq!(fs::read_to_string(&a).unwrap(), "original"); assert_eq!(fs::read_to_string(&b).unwrap(), "destination");
    }

    #[test]
    fn preview_and_conflict_safe_save() {
        let d = Scratch::new(); let a = d.path("text.txt"); fs::write(&a, "hello\n世界").unwrap();
        let before = read_file(&a).unwrap(); assert_eq!(before.kind, "text");
        assert!(write_file(&a, "replacement", Some(before.modified.wrapping_add(1)), Some(&before.revision), false).is_err());
        assert_eq!(fs::read_to_string(&a).unwrap(), "hello\n世界");
        write_file(&a, "replacement", Some(before.modified), Some(&before.revision), false).unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "replacement");
        assert!(write_file(&a, "lost change", None, Some(&before.revision), false).is_err());
        fs::write(&a, b"\x00binary").unwrap(); assert!(read_file(&a).is_err()); assert!(write_file(&a, "text", None, None, true).is_err());
    }

    #[test]
    fn preview_limits_and_image_signature() {
        assert!(preview_bytes(&vec![b'a'; TEXT_LIMIT as usize + 1], 0, TEXT_LIMIT + 1).is_err());
        let image = preview_bytes(b"\x89PNG\r\n\x1a\n", 5, 8).unwrap();
        assert_eq!(image.kind, "image"); assert!(image.content.starts_with("data:image/png;base64,"));
        assert!(preview_bytes(b"\x89PNG\r\n\x1a\n", 0, IMAGE_LIMIT + 1).is_err());
    }

    #[test]
    fn recursive_copy_and_move_do_not_copy_into_self() {
        let d = Scratch::new(); let a = d.path("a"); let b = d.path("b");
        mkdir(&a).unwrap(); fs::write(Path::new(&a).join("file"), "data").unwrap();
        assert!(copy(&a, &format!("{a}/child"), false).is_err());
        copy(&a, &b, false).unwrap(); assert_eq!(fs::read_to_string(Path::new(&b).join("file")).unwrap(), "data");
        let c = d.path("c"); copy(&b, &c, true).unwrap(); assert!(!Path::new(&b).exists());
        assert!(remove(&a, false).is_err()); remove(&a, true).unwrap();
    }

    #[test]
    fn root_and_home_are_protected() {
        // Test the read-only guards, never pass real user directories to a
        // destructive test even if a future regression breaks their protection.
        assert!(target("/").is_err()); assert!(target("/..").is_err());
        assert!(protected(&fs::canonicalize(home().unwrap()).unwrap()).is_err());
    }

    fn alternate_case(path: &Path) -> Option<PathBuf> {
        let name = path.file_name()?.to_str()?;
        let changed: String = name.chars().map(|c| {
            if c.is_ascii_lowercase() { c.to_ascii_uppercase() }
            else if c.is_ascii_uppercase() { c.to_ascii_lowercase() }
            else { c }
        }).collect();
        (changed != name).then(|| path.with_file_name(changed))
    }

    #[test]
    fn aliases_cannot_bypass_home_or_recursive_copy_guards() {
        let d = Scratch::new(); let source = d.0.join("MixedCaseDirectory");
        fs::create_dir(&source).unwrap();
        // Always test identity through a lexical alias, on every file system.
        assert!(same_directory(&source, &source.join(".")).unwrap());
        assert!(inside_directory(&source, &source.join("child")).unwrap());
        let alias = alternate_case(&source).unwrap();
        // Only exercise case aliases where this actual file system supports
        // them; Linux ext4 CI must not assume NTFS/APFS case semantics.
        if alias.exists() && same_directory(&source, &alias).unwrap() {
            assert!(copy(alias.to_str().unwrap(), source.join("child").to_str().unwrap(), false).is_err());
            assert!(!source.join("child").exists());
        }
        let h = fs::canonicalize(home().unwrap()).unwrap();
        if let Some(alias) = alternate_case(&h) {
            if alias.exists() && same_directory(&h, &alias).unwrap() {
                assert!(protected(&alias).is_err());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn recursive_copy_preserves_symlinks_without_traversal() {
        let d = Scratch::new(); let a = d.path("a"); let b = d.path("b"); mkdir(&a).unwrap();
        std::os::unix::fs::symlink("/", Path::new(&a).join("root-link")).unwrap();
        copy(&a, &b, false).unwrap();
        assert_eq!(fs::read_link(Path::new(&b).join("root-link")).unwrap(), PathBuf::from("/"));
        remove(&b, true).unwrap(); assert!(Path::new("/").is_dir());
    }
}
