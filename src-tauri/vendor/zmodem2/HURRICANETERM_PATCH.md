# Vendored zmodem2 0.5.0

Upstream: https://codeberg.org/jarkko/zmodem2 (MIT OR Apache-2.0).
Source: https://static.crates.io/crates/zmodem2/zmodem2-0.5.0.crate

One production change in src/transmission.rs: accept ZEOF at offset zero while a declared zero-length file is in FileBegin. The published sender emits ZEOF directly for an empty file; the original receiver only accepted it after a data subpacket, so both endpoints waited forever. Nonempty files still require FileWaitingSubpacket and the exact received offset. hurricaneTerm tests cover empty files in a batch and independent lrzsz interoperability. No remote command execution is exposed.
