use super::*;
struct Temp(PathBuf);
impl Temp {fn new()->Self{let p=std::env::temp_dir().join(format!("hurricane-modem-{}",uuid::Uuid::new_v4()));fs::create_dir(&p).unwrap();Self(p)}}
impl Drop for Temp{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
fn req(protocol:&str,direction:&str)->Request{Request{session_id:"session".into(),transfer_id:uuid::Uuid::new_v4().to_string(),protocol:protocol.into(),direction:direction.into(),paths:vec![],destination:String::new(),overwrite:"rename".into(),packet_size:1024,trim_padding:false}}
#[test] fn known_crc_and_wire_frame(){assert_eq!(crc16(b"123456789"),0x31c3);let f=frame(255,b"abc",128,true);assert_eq!(&f[..3],&[SOH,255,0]);assert_eq!(f.len(),133);assert_eq!(u16::from_be_bytes([f[131],f[132]]),crc16(&f[3..131]));}
#[test] fn remote_names_cannot_escape_or_name_windows_devices(){for name in ["../x","/tmp/x","..\\x","C:x","CON","nul.txt","LPT9",".","..","x\0y","x\ny","x."]{assert!(safe_name(name).is_err(),"{name}")}assert!(safe_name("文件.bin").is_ok());}
#[test] fn y_header_uses_standard_size_field(){let mut h=b"data.bin\x001025 0 0\0".to_vec();h.resize(128,0);assert_eq!(metadata(&h).unwrap(),Some(("data.bin".into(),1025)));assert!(metadata(b"../outside\x0010\0").is_err());}
#[test] fn failed_receive_never_replaces_existing_file(){let t=Temp::new();let path=t.0.join("data");fs::write(&path,b"old").unwrap();{let mut s=Saved::new(&t.0,"data","overwrite").unwrap();s.write(b"partial").unwrap();}assert_eq!(fs::read(path).unwrap(),b"old");assert_eq!(fs::read_dir(&t.0).unwrap().count(),1);}
#[test] fn receive_collision_policies_are_atomic(){let t=Temp::new();fs::write(t.0.join("data"),b"old").unwrap();for (policy,want) in [("skip",None),("rename",Some("data (1)")),("overwrite",Some("data"))]{let mut s=Saved::new(&t.0,"data",policy).unwrap();s.write(b"new").unwrap();let out=s.commit(false).unwrap();assert_eq!(out.map(|p|PathBuf::from(p).file_name().unwrap().to_string_lossy().into_owned()),want.map(str::to_owned));}assert_eq!(fs::read(t.0.join("data")).unwrap(),b"new");}
#[test] fn binary_padding_is_preserved_unless_explicitly_trimmed(){let t=Temp::new();for trim in [false,true]{let mut s=Saved::new(&t.0,if trim{"trim"}else{"binary"},"rename").unwrap();s.write(b"abc\x1a\x1a").unwrap();let dest=s.commit(trim).unwrap().unwrap();assert_eq!(fs::read(dest).unwrap(),if trim{b"abc".as_slice()}else{b"abc\x1a\x1a".as_slice()});}}
struct ChannelWriter(mpsc::Sender<Vec<u8>>);
impl Write for ChannelWriter{fn write(&mut self,b:&[u8])->std::io::Result<usize>{self.0.blocking_send(b.to_vec()).map_err(|_|std::io::ErrorKind::BrokenPipe)?;Ok(b.len())}fn flush(&mut self)->std::io::Result<()>{Ok(())}}
fn lanes()->(SessionWriter,mpsc::Receiver<Vec<u8>>,SessionWriter,mpsc::Receiver<Vec<u8>>){let(a,ar)=mpsc::channel(256);let(b,br)=mpsc::channel(256);(Arc::new(tokio::sync::Mutex::new(Box::new(ChannelWriter(a)))),br,Arc::new(tokio::sync::Mutex::new(Box::new(ChannelWriter(b)))),ar)}
#[tokio::test] async fn all_protocols_transfer_binary_empty_and_batch(){
 for protocol in ["xmodem","ymodem","zmodem"] {let t=Temp::new();let src=t.0.join("src");let dest=t.0.join("dest");fs::create_dir(&src).unwrap();fs::create_dir(&dest).unwrap();let content:Vec<u8>=(0..4096).map(|n|(n%256) as u8).collect();fs::write(src.join("binary.bin"),&content).unwrap();fs::write(src.join("empty"),[]).unwrap();
  let mut send=req(protocol,"upload");send.paths.push(src.join("binary.bin").to_string_lossy().into_owned());if protocol!="xmodem"{send.paths.push(src.join("empty").to_string_lossy().into_owned())}
  let mut receive=req(protocol,"download");receive.destination=if protocol=="xmodem"{dest.join("binary.bin")}else{dest.clone()}.to_string_lossy().into_owned();let(sw,sr,rw,rr)=lanes();let(_sc_tx,sc)=watch::channel(false);let(_rc_tx,rc)=watch::channel(false);
  let operation=async{tokio::join!(run(send,sr,sc,sw,Arc::new(|_|{})),run(receive,rr,rc,rw,Arc::new(|_|{})))};
  let (s,r)=tokio::time::timeout(Duration::from_secs(20),operation).await.unwrap();assert!(s.is_ok(),"{protocol} sender: {s:?}; receiver: {r:?}");assert!(r.is_ok(),"{protocol} receiver: {r:?}");assert_eq!(fs::read(dest.join("binary.bin")).unwrap(),content);if protocol!="xmodem"{assert_eq!(fs::read(dest.join("empty")).unwrap(),Vec::<u8>::new());}
 }
}
#[tokio::test] async fn cancellation_wakes_waiting_protocol(){let t=Temp::new();let mut r=req("xmodem","download");r.destination=t.0.join("data").to_string_lossy().into_owned();let (writer,input,_,_)=lanes();let (tx,cancel)=watch::channel(false);let op=tokio::spawn(run(r,input,cancel,writer,Arc::new(|_|{})));tx.send_replace(true);assert!(tokio::time::timeout(Duration::from_secs(1),op).await.unwrap().unwrap().is_err());assert_eq!(fs::read_dir(&t.0).unwrap().count(),0);}

#[tokio::test] async fn xy_receiver_retries_bad_crc_and_does_not_duplicate_a_retransmitted_block(){
 let t=Temp::new();let mut request=req("xmodem","download");let path=t.0.join("received.bin");request.destination=path.to_string_lossy().into_owned();
 let (mut peer_input,native_input)={let(a,ar)=mpsc::channel(256);let(b,br)=mpsc::channel(256);((a,br),(b,ar))};
 let writer:SessionWriter=Arc::new(tokio::sync::Mutex::new(Box::new(ChannelWriter(native_input.0))));let(_tx,cancel)=watch::channel(false);
 let operation=tokio::spawn(run(request,native_input.1,cancel,writer,Arc::new(|_|{})));
 assert_eq!(peer_input.1.recv().await.unwrap(),b"C");let payload=[0x42;128];let good=frame(1,&payload,128,true);let mut bad=good.clone();bad[40]^=1;
 peer_input.0.send(bad).await.unwrap();assert_eq!(peer_input.1.recv().await.unwrap(),[NAK]);
 for _ in 0..2 {peer_input.0.send(good.clone()).await.unwrap();assert_eq!(peer_input.1.recv().await.unwrap(),[ACK]);}
 peer_input.0.send(vec![EOT]).await.unwrap();assert_eq!(peer_input.1.recv().await.unwrap(),[ACK]);
 assert!(operation.await.unwrap().is_ok());assert_eq!(fs::read(path).unwrap(),payload);
}

// Independent peer tests are explicit: missing tools is a failure, never a skip.
#[cfg(unix)]
#[tokio::test]
#[ignore = "requires installed lrzsz; run explicitly in native interoperability CI"]
async fn interoperability_with_lrzsz_both_directions(){
 use std::process::{Command,Stdio};
 for protocol in ["xmodem","ymodem","zmodem"] {for sending in [true,false]{
  let t=Temp::new();let source=t.0.join("source.bin");let dest=t.0.join("dest");fs::create_dir(&dest).unwrap();let data:Vec<_>=(0..8192).map(|n|(n%256) as u8).collect();fs::write(&source,&data).unwrap();
  let mut command=Command::new(if sending{"rz"}else{"sz"});command.arg("-b");if protocol=="xmodem"{command.arg("-X");}else if protocol=="ymodem"{command.arg("--ymodem");}if sending{command.current_dir(&dest);if protocol=="xmodem"{command.arg("source.bin");}}else{command.arg(&source);}
  let mut child=command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().expect("lrzsz peer must be installed");let child_in=child.stdin.take().unwrap();let mut child_out=child.stdout.take().unwrap();let (tx,rx)=mpsc::channel(256);
  let reader=std::thread::spawn(move||{let mut buf=[0;8192];while let Ok(n)=child_out.read(&mut buf){if n==0{break}if tx.blocking_send(buf[..n].to_vec()).is_err(){break}}});
  let writer:SessionWriter=Arc::new(tokio::sync::Mutex::new(Box::new(child_in)));let(_cancel_tx,cancel)=watch::channel(false);let mut r=req(protocol,if sending{"upload"}else{"download"});if sending{r.paths.push(source.to_string_lossy().into_owned());}else{r.destination=if protocol=="xmodem"{dest.join("source.bin")}else{dest.clone()}.to_string_lossy().into_owned();}
  let result=tokio::time::timeout(Duration::from_secs(30),run(r,rx,cancel,writer,Arc::new(|_|{}))).await;
  let _=child.kill();let _=child.wait();let _=reader.join();assert!(matches!(result,Ok(Ok(_))),"{protocol} sending={sending}: {result:?}");assert_eq!(fs::read(dest.join("source.bin")).unwrap(),data,"{protocol} sending={sending}");
 }}
}
