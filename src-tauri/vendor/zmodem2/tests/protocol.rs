// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2017-2020 Alexey Arbuzov
// Copyright (c) 2023-2026 Jarkko Sakkinen

use rstest::rstest;
use zmodem2::{Encoding, Frame, Header, Receiver, ReceiverEvent, Sender, XON, ZDLE, ZPAD};

#[rstest]
#[case(Encoding::ZBIN, Frame::ZRQINIT, &[0; 4], &[ZPAD, ZDLE, Encoding::ZBIN as u8, 0, 0, 0, 0, 0, 0, 0])]
#[case(Encoding::ZBIN32, Frame::ZRQINIT, &[0; 4], &[ZPAD, ZDLE, Encoding::ZBIN32 as u8, 0, 0, 0, 0, 0, 29, 247, 34, 198])]
#[case(Encoding::ZBIN, Frame::ZRQINIT, &[1; 4], &[ZPAD, ZDLE, Encoding::ZBIN as u8, 0, 1, 1, 1, 1, 98, 148])]
#[case(Encoding::ZHEX, Frame::ZRQINIT, &[1; 4], &[ZPAD, ZPAD, ZDLE, Encoding::ZHEX as u8, b'0', b'0', b'0', b'1', b'0', b'1', b'0', b'1', b'0', b'1', 54, 50, 57, 52, b'\r', b'\n', XON])]
pub fn test_header_write(
    #[case] encoding: Encoding,
    #[case] frame: Frame,
    #[case] flags: &[u8; 4],
    #[case] expected: &[u8],
) {
    let header = Header::new(encoding, frame, flags);
    let mut port = vec![];
    assert!(header.write(&mut port) == Ok(Some(())));
    assert_eq!(port, expected);
}

#[rstest]
#[case(&[Encoding::ZHEX as u8, b'0', b'1', b'0', b'1', b'0', b'2', b'0', b'3', b'0', b'4', b'a', b'7', b'5', b'2'], Encoding::ZHEX, Frame::ZRINIT, &[0x1, 0x2, 0x3, 0x4])]
#[case(&[Encoding::ZBIN as u8, Frame::ZRINIT as u8, 0xa, 0xb, 0xc, 0xd, 0xa6, 0xcb], Encoding::ZBIN, Frame::ZRINIT, &[0xa, 0xb, 0xc, 0xd])]
#[case(&[Encoding::ZBIN32 as u8, Frame::ZRINIT as u8, 0xa, 0xb, 0xc, 0xd, 0x99, 0xe2, 0xae, 0x4a], Encoding::ZBIN32, Frame::ZRINIT, &[0xa, 0xb, 0xc, 0xd])]
#[case(&[Encoding::ZBIN as u8, Frame::ZRINIT as u8, 0xa, ZDLE, b'l', 0xd, ZDLE, b'm', 0x5e, 0x6f], Encoding::ZBIN, Frame::ZRINIT, &[0xa, 0x7f, 0xd, 0xff])]
pub fn test_header_read(
    #[case] port: &[u8],
    #[case] encoding: Encoding,
    #[case] frame: Frame,
    #[case] flags: &[u8; 4],
) {
    let port = &mut port.to_vec();
    let port = &mut port.as_slice();
    assert!(Header::read(port) == Ok(Some(Header::new(encoding, frame, flags))));
}

#[test]
fn test_receive_malformed_header() {
    let mut receiver = Receiver::new().unwrap();
    receiver.advance_outgoing(receiver.drain_outgoing().len());

    let input = b"malformed data";
    let consumed = receiver.feed_incoming(input).unwrap();

    assert_eq!(consumed, input.len());
    assert!(receiver.drain_outgoing().is_empty());
    assert!(receiver.drain_file().is_empty());
    assert!(receiver.poll_event().is_none());
}

#[test]
fn test_receive_zfile_with_non_utf8_name() {
    let file_name = b"bad\x80name";
    let file_size = 123;

    let mut sender = Sender::new().unwrap();
    sender.start_file(file_name, file_size).unwrap();
    sender.advance_outgoing(sender.drain_outgoing().len());

    let zrinit = Header::new(Encoding::ZHEX, Frame::ZRINIT, &[0; 4]);
    let mut zrinit_bytes = Vec::new();
    zrinit.write(&mut zrinit_bytes).unwrap();
    let consumed = sender.feed_incoming(&zrinit_bytes).unwrap();
    assert!(consumed > 0 && consumed <= zrinit_bytes.len());

    let wire = sender.drain_outgoing().to_vec();
    sender.advance_outgoing(wire.len());

    let mut receiver = Receiver::new().unwrap();
    receiver.advance_outgoing(receiver.drain_outgoing().len());

    let mut input = wire.as_slice();
    let mut got_start = false;
    for _ in 0..(wire.len() * 4) {
        if input.is_empty() {
            break;
        }
        let consumed = receiver.feed_incoming(input).unwrap();
        if consumed == 0 {
            if !receiver.drain_outgoing().is_empty() {
                receiver.advance_outgoing(receiver.drain_outgoing().len());
            }
        } else {
            input = &input[consumed..];
        }

        if let Some(ReceiverEvent::FileStart) = receiver.poll_event() {
            got_start = true;
            break;
        }
    }

    assert!(got_start);
    assert_eq!(receiver.file_name(), file_name);
    assert_eq!(receiver.file_size(), file_size);
}
