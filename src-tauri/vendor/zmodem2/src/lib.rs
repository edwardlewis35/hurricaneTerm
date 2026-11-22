// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2017-2020 Alexey Arbuzov
// Copyright (c) 2023-2026 Jarkko Sakkinen

//! ZMODEM file transfer protocol library. `zmodem2::Sender` and
//! `zmodem2::Receiver` provide stream alike state machines for sending and
//! receiving files with the ZMODEM protocol.
//!
//! The usage can be described in the high-level with the following flow:
//! 1. Create `zmodem2::Sender` or `zmodem2::Receiver`.
//! 2. Drain `drain_outgoing()` returned bytes into the wire and call
//!    `advance_outgoing()` after writing. Then, feed incoming bytes with
//!    `feed_incoming()`.
//! 3. In the sender, complete `poll_file()` with `feed_file()` if required
//!    and handle events via `poll_event()`.
//! 4. In the receiver, write `drain_file()` returned bytes into storage, and
//!    call `advance_file()` after writing. Handle events via `poll_event()`.

#![deny(clippy::all)]
#![deny(clippy::pedantic)]
#![allow(clippy::result_large_err)]
#![cfg_attr(not(feature = "std"), no_std)]

mod buffer;
mod crc;
mod error;
mod header;
mod io;
#[cfg(feature = "std")]
mod std;
mod string;
mod transmission;
mod zdle;

pub use buffer::*;
pub use error::*;
pub use header::*;
pub use io::*;
pub use string::*;
pub use transmission::*;

pub const ZPAD: u8 = b'*';
pub const ZDLE: u8 = 0x18;
pub const XON: u8 = 0x11;
