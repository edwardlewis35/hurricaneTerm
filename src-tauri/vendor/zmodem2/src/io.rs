// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2023-2025 Jarkko Sakkinen

//! Traits for I/O non-blocking operations.

use crate::Error;

/// Write operations.
pub trait Write {
    /// Writes bytes from a buffer to the I/O port.
    ///
    /// # Errors
    ///
    /// [`Read`](crate::Error::Read) when the read I/O fails with the serial
    /// port.
    /// [`Write`](crate::Error::Write) when the write I/O fails with the
    /// serial port.
    fn write(&mut self, buf: &[u8]) -> Result<Option<u32>, Error> {
        if self.write_all(buf)?.is_none() {
            return Ok(None);
        }
        u32::try_from(buf.len())
            .map(Some)
            .map_err(|_| Error::OutOfMemory)
    }

    /// Writes the entire buffer to the I/O port.
    ///
    /// Returns `Ok(None)` only if no bytes were written.
    ///
    /// # Errors
    ///
    /// [`Read`](crate::Error::Read) when the read I/O fails with the serial
    /// port.
    /// [`Write`](crate::Error::Write) when the write I/O fails with the
    /// serial port.
    fn write_all(&mut self, buf: &[u8]) -> Result<Option<()>, Error>;

    /// Writes a single byte to the I/O port.
    ///
    /// Returns `Ok(None)` only if no bytes were written.
    ///
    /// # Errors
    ///
    /// [`Read`](crate::Error::Read) when the read I/O fails with the serial
    /// port.
    /// [`Write`](crate::Error::Write) when the write I/O fails with the
    /// serial port.
    fn write_byte(&mut self, value: u8) -> Result<Option<()>, Error> {
        self.write_all(&[value])
    }
}

/// Read operations.
pub trait Read {
    /// Read bytes from the I/O port.
    ///
    /// Returns `Ok(None)` only if no bytes were written.
    ///
    /// # Errors
    ///
    /// * [`Read`](crate::Error::Read) when the read I/O fails with the serial port.
    /// * [`Write`](crate::Error::Write) when the write I/O fails with the serial port.
    fn read(&mut self, buf: &mut [u8]) -> Result<Option<u32>, Error>;

    /// Read a byte from the I/O port.
    ///
    /// Returns `Ok(None)` only if no bytes were written.
    ///
    /// # Errors
    ///
    /// [`Read`](crate::Error::Read) when the read I/O fails with the serial port.
    /// [`Write`](crate::Error::Write) when the write I/O fails with the serial port.
    fn read_byte(&mut self) -> Result<Option<u8>, Error>;
}

/// Seek operations
pub trait Seek {
    /// Seeks I/O port to an offset.
    ///
    /// # Errors
    ///
    /// [`Read`](crate::Error::Read) when the read I/O fails with the serial port.
    /// [`Write`](crate::Error::Write) when the write I/O fails with the serial port.
    fn seek(&mut self, offset: u32) -> Result<Option<u32>, Error>;
}
