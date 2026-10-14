//! Keep UTF-8 decoding state across PTY / socket reads, which can split anywhere.

#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut consumed = 0;
        while consumed < self.pending.len() {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(s) => { out.push_str(s); consumed = self.pending.len(); }
                Err(error) => {
                    let end = consumed + error.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[consumed..end]).unwrap());
                    consumed = end;
                    match error.error_len() {
                        Some(n) => { out.push('\u{fffd}'); consumed += n; }
                        None => break, // the next read may complete this character
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        out
    }

    pub fn finish(&mut self) -> String {
        let remaining = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        remaining
    }
}

pub fn append_tail(tail: &mut String, text: &str, max_bytes: usize) {
    tail.push_str(text);
    if tail.len() > max_bytes {
        let mut start = tail.len() - max_bytes;
        while !tail.is_char_boundary(start) { start += 1; }
        tail.drain(..start);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multibyte_output_survives_every_read_boundary() {
        let text = "中文输出🙂\x1b[34m蓝色文本\x1b[0m\r\n";
        for split in 0..=text.len() {
            let mut decoder = Utf8Decoder::default();
            let output = decoder.push(&text.as_bytes()[..split]) + &decoder.push(&text.as_bytes()[split..]) + &decoder.finish();
            assert_eq!(output, text, "split byte {split}");
        }
    }

    #[test]
    fn invalid_sequences_and_final_incomplete_character_are_replaced() {
        let mut decoder = Utf8Decoder::default();
        assert_eq!(decoder.push(&[b'a', 0xff, 0xe4]), "a\u{fffd}");
        assert_eq!(decoder.push(&[0xb8, 0xad, b'b', 0xf0, 0x9f]), "中b");
        assert_eq!(decoder.finish(), "\u{fffd}");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn expect_tail_never_splits_a_unicode_character() {
        let mut tail = String::new();
        append_tail(&mut tail, &"中".repeat(100), 240);
        append_tail(&mut tail, "ab", 240); // len - 240 is inside a 3-byte character
        assert!(tail.len() <= 240);
        assert!(tail.ends_with("ab"));
        assert!(!tail.contains('\u{fffd}'));
    }
}
