// Compile the production PTY owner/UTF-8 modules without linking a GUI runtime.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = /name = "portable-pty"\nversion = "([^"]+)"/.exec(readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8'))?.[1];
if (!version) throw new Error('portable-pty is missing from the production lockfile');
const scratch = mkdtempSync(join(tmpdir(), 'hurricane-native-terminal-'));
try {
  mkdirSync(join(scratch, 'src'));
  writeFileSync(join(scratch, 'Cargo.toml'), `[package]
name = "hurricane-native-terminal-regression"
version = "0.1.0"
edition = "2021"

[dependencies]
portable-pty = "=${version}"
`);
  writeFileSync(join(scratch, 'src/lib.rs'), `#![allow(dead_code)]
#[path = ${JSON.stringify(join(root, 'src-tauri/src/pty_child.rs'))}]
mod pty_child;
#[path = ${JSON.stringify(join(root, 'src-tauri/src/terminal_io.rs'))}]
mod terminal_io;
`);
  const args = ['test', '--manifest-path', join(scratch, 'Cargo.toml')];
  if (!process.argv.includes('--online')) args.push('--offline');
  args.push('--', '--nocapture');
  const result = spawnSync(process.env.CARGO || 'cargo', args, { stdio: 'inherit' });
  if (result.error) { console.error('Native tests could not start: ' + result.error.message); process.exitCode = 1; }
  else process.exitCode = result.status ?? 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
