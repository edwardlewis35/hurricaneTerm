// Run the real Rust local-file service tests without linking Tauri/WebKit.
// Requires a Rust toolchain and cached crates; use --online to fetch missing crates.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'hurricaneterm-file-tests-'));
try {
  mkdirSync(join(scratch, 'src'));
  writeFileSync(join(scratch, 'Cargo.toml'), `[package]
name = "hurricaneterm-file-service-tests"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
dirs = "6"
base64 = "0.22"
uuid = { version = "1", features = ["v4"] }

[target.'cfg(unix)'.dependencies]
libc = "0.2"
`);
  writeFileSync(join(scratch, 'src/lib.rs'), `#![allow(dead_code)]
#[derive(Clone, serde::Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub is_link: bool,
    pub permissions: Option<u32>,
}
#[path = ${JSON.stringify(resolve(root, 'src-tauri/src/files.rs'))}]
mod files;
`);
  const args = ['test', '--manifest-path', join(scratch, 'Cargo.toml')];
  if (!process.argv.includes('--online')) args.push('--offline');
  args.push('--', '--nocapture');
  const result = spawnSync(process.env.CARGO || 'cargo', args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`Rust tests could not start: ${result.error.message}`);
    process.exitCode = 1;
  } else process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
