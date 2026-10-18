// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2017-2020 Alexey Arbuzov
// Copyright (c) 2023-2025 Jarkko Sakkinen

use super::{Encoding, Error, Frame, Header, Read, Seek, String, SubpacketType, Write};
use std::{fmt, io::SeekFrom};

impl<W> Write for W
where
    W: std::io::Write,
{
    fn write(&mut self, buf: &[u8]) -> Result<Option<u32>, Error> {
        match std::io::Write::write(self, buf) {
            Ok(bytes_written) => u32::try_from(bytes_written)
                .map(Some)
                .map_err(|_| Error::OutOfMemory),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::WouldBlock {
                    Ok(None)
                } else {
                    Err(Error::Write(String::from(e.to_string().as_str())))
                }
            }
        }
    }

    fn write_all(&mut self, buf: &[u8]) -> Result<Option<()>, Error> {
        match std::io::Write::write_all(self, buf) {
            Ok(()) => Ok(Some(())),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::WouldBlock {
                    Ok(None)
                } else {
                    Err(Error::Write(String::from(e.to_string().as_str())))
                }
            }
        }
    }
}

impl<R> Read for R
where
    R: std::io::Read,
{
    fn read(&mut self, buf: &mut [u8]) -> Result<Option<u32>, Error> {
        match std::io::Read::read(self, buf) {
            Ok(bytes_read) => u32::try_from(bytes_read)
                .map(Some)
                .map_err(|_| Error::OutOfMemory),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::WouldBlock {
                    Ok(None)
                } else {
                    Err(Error::Read(String::from(e.to_string().as_str())))
                }
            }
        }
    }

    fn read_byte(&mut self) -> Result<Option<u8>, Error> {
        let mut buf = [0; 1];
        match std::io::Read::read(self, &mut buf) {
            Ok(1) => Ok(Some(buf[0])),
            Ok(0) => Err(Error::UnexpectedEof),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::WouldBlock {
                    Ok(None)
                } else {
                    Err(Error::Read(String::from(e.to_string().as_str())))
                }
            }
            Ok(_) => Err(Error::Read(String::from("unknown read error"))),
        }
    }
}

impl<S> Seek for S
where
    S: std::io::Seek,
{
    fn seek(&mut self, offset: u32) -> Result<Option<u32>, Error> {
        let new_offset = u64::from(offset);
        match std::io::Seek::seek(self, SeekFrom::Start(new_offset)) {
            Ok(final_offset) => u32::try_from(final_offset)
                .map(Some)
                .map_err(|_| Error::UnexpectedEof),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::WouldBlock {
                    Ok(None)
                } else {
                    Err(Error::Read(String::from(e.to_string().as_str())))
                }
            }
        }
    }
}

impl fmt::Display for Header {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{:8} {}", self.encoding(), self.frame())
    }
}

impl fmt::Display for Encoding {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{:#02x}", *self as u8)
    }
}

impl fmt::Display for Frame {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{:#02x}", *self as u8)
    }
}

impl fmt::Display for SubpacketType {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{:#0x}", *self as u8)
    }
}

impl std::fmt::Debug for String {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match core::str::from_utf8(self) {
            Ok(s) => f.write_str(s),
            Err(_) => f.debug_list().entries(self.iter()).finish(),
        }
    }
}

impl std::fmt::Display for String {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(core::str::from_utf8(self).unwrap_or(""))
    }
}
