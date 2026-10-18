// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2023-2025 Jarkko Sakkinen

use crate::String;
use thiserror::Error;

/// Top-level error type.
#[derive(Error, Debug, PartialEq)]
pub enum Error {
    #[error("malformed encoding type: {0:#02x}")]
    MalformedEncoding(u8),
    #[error("malformed file size")]
    MalformedFileSize,
    #[error("malformed filename")]
    MalformedFileName,
    #[error("malformed frame type: {0:#02x}")]
    MalformedFrame(u8),
    #[error("malformed header")]
    MalformedHeader,
    #[error("malformed packet type: {0:#02x}")]
    MalformedPacket(u8),
    #[error("not connected")]
    NotConnected,
    #[error("read: {0}")]
    Read(String),
    #[error("out of memory")]
    OutOfMemory,
    #[error("unexpected CRC-16")]
    UnexpectedCrc16,
    #[error("unexpected CRC-32")]
    UnexpectedCrc32,
    #[error("unexpected EOF")]
    UnexpectedEof,
    #[error("unsupported operation")]
    Unsupported,
    #[error("write: {0}")]
    Write(String),
}
