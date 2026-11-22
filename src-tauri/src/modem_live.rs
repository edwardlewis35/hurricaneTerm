//! Live, bounded X/Y/ZMODEM over the existing terminal's binary lane.
//! X/Y framing is native; Z uses the MIT/Apache-2.0 zmodem2 state machine.
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, fs::{self, File, OpenOptions}, io::{Read, Write, Seek, SeekFrom}, path::{Path, PathBuf}, sync::Arc, time::{Duration, Instant}};
use tokio::sync::{mpsc, watch};
use crate::SessionWriter;
const SOH:u8=1; const STX:u8=2; const EOT:u8=4; const ACK:u8=6; const NAK:u8=21; const CAN:u8=24;
const RETRIES:usize=10;
const TIMEOUT:Duration=Duration::from_secs(10);
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Request {
 pub session_id:String, pub transfer_id:String, pub protocol:String, pub direction:String,
 #[serde(default)] pub paths:Vec<String>, #[serde(default)] pub destination:String,
 #[serde(default="rename_policy")] pub overwrite:String, #[serde(default="packet")] pub packet_size:usize,
 #[serde(default)] pub trim_padding:bool,
}
fn rename_policy()->String{"rename".into()} fn packet()->usize{1024}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all="camelCase")]
pub struct Progress { pub session_id:String,pub transfer_id:String,pub protocol:String,pub direction:String,pub name:String,pub done:u64,pub total:u64,pub status:String,pub speed:f64 }
#[derive(Serialize, Debug)]
pub struct Outcome {pub status:String,pub done:u64,pub total:u64,pub files:Vec<String>}
pub type Sink=Arc<dyn Fn(Progress)+Send+Sync>;
pub fn validate(r:&Request)->Result<(),String>{
 if r.transfer_id.is_empty()||r.transfer_id.len()>200||r.session_id.is_empty()||r.session_id.len()>200{return Err("传输和连接编号无效".into())}
 if !["xmodem","ymodem","zmodem"].contains(&r.protocol.as_str())||!["upload","download"].contains(&r.direction.as_str()){return Err("传输协议或方向无效".into())}
 if !["rename","skip","overwrite"].contains(&r.overwrite.as_str())||![128,1024].contains(&r.packet_size){return Err("同名处理或数据块大小无效".into())}
 if r.paths.len()>128||r.paths.iter().chain(std::iter::once(&r.destination)).any(|p|p.len()>4096||p.contains(['\0','\r','\n'])){return Err("路径过长或包含控制字符".into())}
 if r.direction=="upload"&&(r.paths.is_empty()||r.protocol=="xmodem"&&r.paths.len()!=1){return Err("XMODEM需要一个文件，Y/ZMODEM需要1–128个文件".into())}
 if r.direction=="download"&&r.destination.trim().is_empty(){return Err("请选择接收文件或目录".into())} Ok(())
}
pub fn safe_name(name:&str)->Result<&str,String>{
 let stem=name.split('.').next().unwrap_or("").to_ascii_uppercase();
 if name.is_empty()||name.len()>255||name=="."||name==".."||name.chars().any(|c|c.is_control()||"/\\:<>\"|?*".contains(c))||name.ends_with(['.',' '])||["CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"].contains(&stem.as_str()) {return Err("对端文件名不是安全的单个文件名".into())} Ok(name)
}
fn abs(path:&str)->Result<PathBuf,String>{crate::files::absolute(path)}
fn ioerr(e:impl std::fmt::Display)->String{e.to_string()}
struct Wire {input:mpsc::Receiver<Vec<u8>>,cancel:watch::Receiver<bool>,writer:SessionWriter,buffer:VecDeque<u8>,timeout:Duration}
impl Wire {
 async fn send(&self,data:&[u8])->Result<(),String>{
  if *self.cancel.borrow(){return Err("传输已取消或连接已断开".into())}
  self.send_unchecked(data).await
 }
 async fn send_unchecked(&self,data:&[u8])->Result<(),String>{
  let mut writer=self.writer.clone().lock_owned().await; let bytes=data.to_vec();
  tokio::task::spawn_blocking(move||{writer.write_all(&bytes).and_then(|_|writer.flush()).map_err(ioerr)}).await.map_err(ioerr)?
 }
 async fn fill(&mut self)->Result<(),String>{
  if *self.cancel.borrow(){return Err("传输已取消或连接已断开".into())}
  let chunk=tokio::select!{biased;_ = self.cancel.changed()=>return Err("传输已取消或连接已断开".into()),v=tokio::time::timeout(self.timeout,self.input.recv())=>v.map_err(|_|"传输等待对端超时".to_string())?.ok_or("传输连接已断开")?};
  if chunk.len()>128*1024||self.buffer.len()+chunk.len()>256*1024{return Err("协议输入缓冲超过上限".into())} self.buffer.extend(chunk); Ok(())
 }
 async fn byte(&mut self)->Result<u8,String>{if self.buffer.is_empty(){self.fill().await?} self.buffer.pop_front().ok_or_else(||"未收到协议字节".into())}
 async fn bytes(&mut self,len:usize)->Result<Vec<u8>,String>{let mut out=Vec::with_capacity(len);while out.len()<len {out.push(self.byte().await?)}Ok(out)}
 async fn control(&mut self,wanted:&[u8])->Result<u8,String>{
  let deadline=tokio::time::Instant::now()+self.timeout;let mut can=false;
  loop {let c=tokio::time::timeout_at(deadline,self.byte()).await.map_err(|_|"传输等待对端超时".to_string())??;
   if c==CAN {if can{return Err("对端取消了传输".into())}can=true;continue}can=false;if wanted.contains(&c){return Ok(c)} }
 }
 async fn confirmed(&mut self,frame:&[u8])->Result<(),String>{for _ in 0..RETRIES{self.send(frame).await?;match self.control(&[ACK,NAK]).await {Ok(ACK)=>return Ok(()),Ok(_)=>{},Err(e) if e.contains("超时")=>{},Err(e)=>return Err(e)}} Err("对端未确认，重试次数已用完".into())}
}
pub fn crc16(bytes:&[u8])->u16{let mut crc=0u16;for &b in bytes{crc^=(b as u16)<<8;for _ in 0..8{crc=if crc&0x8000!=0{(crc<<1)^0x1021}else{crc<<1}}}crc}
fn frame(seq:u8,data:&[u8],size:usize,crc:bool)->Vec<u8>{let mut f=vec![if size==1024{STX}else{SOH},seq,!seq];f.extend_from_slice(data);f.resize(3+size,0x1a);if crc{f.extend_from_slice(&crc16(&f[3..]).to_be_bytes())}else{f.push(f[3..].iter().fold(0u8,|a,b|a.wrapping_add(*b)))}f}
struct Source {file:File,name:String,size:u64}
fn sources(r:&Request)->Result<Vec<Source>,String>{r.paths.iter().map(|p|{let path=abs(p)?;let file=File::open(&path).map_err(ioerr)?;let md=file.metadata().map_err(ioerr)?;if !md.is_file()||md.len()>u32::MAX as u64{return Err("只能发送不超过4GiB的普通文件".into())}let name=path.file_name().and_then(|v|v.to_str()).ok_or("文件名不是有效UTF-8")?.to_string();safe_name(&name)?;Ok(Source{file,name,size:md.len()})}).collect()}
struct Saved {file:File,temp:PathBuf,dest:PathBuf,policy:String,size:u64}
impl Drop for Saved{fn drop(&mut self){let _=fs::remove_file(&self.temp);}}
impl Saved {
 fn new(dir:&Path,name:&str,policy:&str)->Result<Self,String>{safe_name(name)?;let temp=dir.join(format!(".hurricaneterm-{}.part",uuid::Uuid::new_v4()));let file=OpenOptions::new().read(true).write(true).create_new(true).open(&temp).map_err(ioerr)?;Ok(Self{file,temp,dest:dir.join(name),policy:policy.into(),size:0})}
 fn write(&mut self,data:&[u8])->Result<(),String>{if self.size+data.len() as u64>u32::MAX as u64{return Err("接收文件超过4GiB上限".into())}self.file.write_all(data).map_err(ioerr)?;self.size+=data.len() as u64;Ok(())}
 fn commit(mut self,trim:bool)->Result<Option<String>,String>{
  if trim{while self.size>0{self.file.seek(SeekFrom::Start(self.size-1)).map_err(ioerr)?;let mut last=[0];self.file.read_exact(&mut last).map_err(ioerr)?;if last[0]!=0x1a{break}self.size-=1;}self.file.set_len(self.size).map_err(ioerr)?;}
  self.file.sync_all().map_err(ioerr)?;
  if self.policy=="overwrite"{if fs::symlink_metadata(&self.dest).is_ok_and(|md|!md.is_file()||md.is_symlink()){return Err("接收目标不是普通文件，拒绝覆盖".into())}fs::rename(&self.temp,&self.dest).map_err(ioerr)?;return Ok(Some(self.dest.to_string_lossy().into_owned()))}
  for i in 0..10000{let dest=if i==0{self.dest.clone()}else{let name=self.dest.file_name().unwrap().to_string_lossy();self.dest.with_file_name(format!("{name} ({i})"))};
   match fs::hard_link(&self.temp,&dest){Ok(())=>return Ok(Some(dest.to_string_lossy().into_owned())),Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>{if self.policy=="skip"{return Ok(None)}},Err(e)=>return Err(format!("无法原子保存接收文件：{e}"))}}
  Err("同名文件过多，无法生成新文件名".into())
 }
}
struct Report {r:Request,sink:Sink,started:Instant,last:Instant,done:u64,total:u64,files:Vec<String>,name:String}
impl Report {
 fn update(&mut self,status:&str,force:bool){if force||self.last.elapsed()>Duration::from_millis(100){(self.sink)(Progress{session_id:self.r.session_id.clone(),transfer_id:self.r.transfer_id.clone(),protocol:self.r.protocol.clone(),direction:self.r.direction.clone(),name:self.name.clone(),done:self.done,total:self.total,status:status.into(),speed:self.done as f64/self.started.elapsed().as_secs_f64().max(0.001)});self.last=Instant::now()}}
}
async fn xy_send(w:&mut Wire,p:&mut Report,mut files:Vec<Source>)->Result<(),String>{
 let y=p.r.protocol=="ymodem";p.total=files.iter().map(|f|f.size).sum();p.update("negotiating",true);
 let mut mode=w.control(&[b'C',NAK]).await?==b'C';
 for source in &mut files {
  p.name=source.name.clone();p.update("running",true);
  if y {let header=format!("{}\0{} 0 0\0",source.name,source.size);if header.len()>128{return Err("YMODEM文件名太长".into())}let mut data=header.into_bytes();data.resize(128,0);w.confirmed(&frame(0,&data,128,mode)).await?;mode=w.control(&[b'C',NAK]).await?==b'C';}
  let mut seq=1u8;let mut left=source.size;
  while left>0{let size=if left<=128{128}else{p.r.packet_size};let n=left.min(size as u64) as usize;let mut data=vec![0;n];source.file.read_exact(&mut data).map_err(|e|format!("读取发送文件失败：{e}"))?;w.confirmed(&frame(seq,&data,size,mode)).await?;left-=n as u64;p.done+=n as u64;seq=seq.wrapping_add(1);p.update("running",false);}
  w.confirmed(&[EOT]).await?;p.files.push(source.name.clone());
  if y {mode=w.control(&[b'C',NAK]).await?==b'C';}
 }
 if y {w.confirmed(&frame(0,&[0;128],128,mode)).await?;}Ok(())
}
enum Packet {Data(u8,Vec<u8>),End}
async fn read_packet(w:&mut Wire,crc:bool)->Result<Packet,String>{
 let c=w.control(&[SOH,STX,EOT]).await?;if c==EOT{return Ok(Packet::End)}let size=if c==STX{1024}else{128};let data=w.bytes(2+size+if crc{2}else{1}).await?;
 if data[0]!=!data[1]{return Err("帧序号校验失败".into())}let payload=&data[2..2+size];
 let good=if crc{crc16(payload)==u16::from_be_bytes([data[2+size],data[3+size]])}else{payload.iter().fold(0u8,|a,b|a.wrapping_add(*b))==data[2+size]};
 if !good{return Err("帧CRC或校验和错误".into())}Ok(Packet::Data(data[0],payload.to_vec()))
}
fn metadata(data:&[u8])->Result<Option<(String,u64)>,String>{let end=data.iter().position(|b|*b==0).ok_or("YMODEM文件头缺少结束符")?;if end==0{return Ok(None)}let name=std::str::from_utf8(&data[..end]).map_err(ioerr)?;safe_name(name)?;let text=std::str::from_utf8(&data[end+1..]).map_err(ioerr)?;let size=text.split(|c:char|c=='\0'||c.is_ascii_whitespace()).next().ok_or("缺少文件大小")?.parse::<u64>().map_err(|_|"YMODEM文件大小无效")?;if size>u32::MAX as u64{return Err("文件超过4GiB上限".into())}Ok(Some((name.into(),size)))}
async fn xy_receive(w:&mut Wire,p:&mut Report)->Result<(),String>{
 let y=p.r.protocol=="ymodem";let path=abs(&p.r.destination)?;let (dir,xname)=if y{(fs::canonicalize(path).map_err(ioerr)?,None)}else{let name=path.file_name().and_then(|v|v.to_str()).ok_or("接收路径缺少文件名")?.to_owned();safe_name(&name)?;(fs::canonicalize(path.parent().ok_or("路径没有父目录")?).map_err(ioerr)?,Some(name))};
 if !dir.is_dir(){return Err("接收位置不是目录".into())}let mut seq=if y{0}else{1};let mut crc=true;let mut errors=0;let mut saved:Option<Saved>=if y{None}else{Some(Saved::new(&dir,xname.as_deref().unwrap(),&p.r.overwrite)?)};let mut remaining:Option<u64>=None;let mut negotiated=false;let mut files=0;
 p.name=xname.clone().unwrap_or_default();p.update("negotiating",true);w.send(b"C").await?;
 loop {let packet=read_packet(w,crc).await;match packet {
  Ok(Packet::Data(n,data)) if n==seq=>{
   errors=0;negotiated=true;
   if y&&saved.is_none(){let Some((name,size))=metadata(&data)? else {w.send(&[ACK]).await?;return Ok(())};if files>=128{return Err("接收批次超过128个文件".into())}p.name=name.clone();p.total=p.total.checked_add(size).ok_or("总大小溢出")?;saved=Some(Saved::new(&dir,&name,&p.r.overwrite)?);remaining=Some(size);seq=1;w.send(&[ACK,b'C']).await?;p.update("running",true);continue;}
   let count=remaining.map(|left|left.min(data.len() as u64) as usize).unwrap_or(data.len());saved.as_mut().ok_or("缺少接收文件头")?.write(&data[..count])?;if let Some(left)=remaining.as_mut(){*left-=count as u64}p.done+=count as u64;seq=seq.wrapping_add(1);w.send(&[ACK]).await?;p.update("running",false);
  },
  Ok(Packet::Data(n,_)) if n==seq.wrapping_sub(1)=>{w.send(&[ACK]).await?;if y&&seq==1&&saved.as_ref().is_some_and(|f|f.size==0){w.send(b"C").await?;}},
  Ok(Packet::End)=>{
   if remaining.is_some_and(|left|left!=0){return Err("对端提前结束，接收文件大小不足".into())}let file=saved.take().ok_or("未收到文件头便结束")?;
   // Commit before ACK: sender must not see success after a local write failure.
   if let Some(path)=file.commit(!y&&p.r.trim_padding)?{p.files.push(path)}files+=1;
   w.send(&[ACK]).await?;if !y{return Ok(())}seq=0;remaining=None;w.send(b"C").await?;
  },
  Ok(_)=>{errors+=1;w.send(&[NAK]).await?;},
  Err(e) if e.contains("取消")||e.contains("断开")=>return Err(e),
  Err(e)=>{if e.contains("帧"){negotiated=true}errors+=1;if !negotiated {if errors>=3{crc=false}w.send(&[if crc{b'C'}else{NAK}]).await?;}else{w.send(&[NAK]).await?;}},
 }if errors>=RETRIES{return Err("校验失败或对端未响应，重试次数已用完".into())}}
}
async fn z_send(w:&mut Wire,p:&mut Report,mut files:Vec<Source>)->Result<(),String>{
 let mut sender=zmodem2::Sender::new().map_err(ioerr)?;let mut index=0usize;let mut current=false;let mut done_base=0;let mut finishing=false;
 p.total=files.iter().map(|f|f.size).sum();p.update("negotiating",true);
 loop {
  if !sender.drain_outgoing().is_empty(){let data=sender.drain_outgoing().to_vec();w.send(&data).await?;sender.advance_outgoing(data.len());continue;}
  while let Some(event)=sender.poll_event(){match event{zmodem2::SenderEvent::FileComplete=>{if !current{return Err("ZMODEM文件状态无效".into())}done_base+=files[index].size;p.done=done_base;p.files.push(files[index].name.clone());index+=1;current=false;},zmodem2::SenderEvent::SessionComplete=>return Ok(())}}
  if !current&&!finishing {if index==files.len(){sender.finish_session().map_err(ioerr)?;finishing=true;}else{let f=&files[index];sender.start_file(f.name.as_bytes(),f.size as u32).map_err(ioerr)?;current=true;p.name=f.name.clone();p.update("running",true);}continue;}
  if let Some(request)=sender.poll_file(){let f=files.get_mut(index).ok_or("ZMODEM请求了不存在的文件")?;if request.offset as u64>f.size{return Err("对端请求的位置超过发送文件".into())}let n=request.len.min((f.size-request.offset as u64) as usize);let mut data=vec![0;n];f.file.seek(SeekFrom::Start(request.offset as u64)).map_err(ioerr)?;f.file.read_exact(&mut data).map_err(ioerr)?;sender.feed_file(&data).map_err(ioerr)?;p.done=done_base+request.offset as u64+n as u64;p.update("running",false);continue;}
  if w.buffer.is_empty(){w.fill().await?}let data:Vec<_>=w.buffer.iter().copied().collect();let n=sender.feed_incoming(&data).map_err(ioerr)?;w.buffer.drain(..n);if n==0&&sender.drain_outgoing().is_empty()&&sender.poll_file().is_none(){return Err("ZMODEM对端响应无进展".into())}
 }
}
async fn z_receive(w:&mut Wire,p:&mut Report)->Result<(),String>{
 let dir=fs::canonicalize(abs(&p.r.destination)?).map_err(ioerr)?;if !dir.is_dir(){return Err("接收位置不是目录".into())}
 let mut receiver=zmodem2::Receiver::new().map_err(ioerr)?;let mut saved:Option<Saved>=None;let mut completed=0u64;let mut advertised=0u64;let mut count=0;let mut finished=false;
 p.update("negotiating",true);
 loop {
  while let Some(event)=receiver.poll_event(){match event{
   zmodem2::ReceiverEvent::FileStart=>{if saved.is_some()||count>=128{return Err("ZMODEM文件状态无效或批次超过128".into())}let name=std::str::from_utf8(receiver.file_name()).map_err(ioerr)?;safe_name(name)?;p.name=name.into();advertised=receiver.file_size() as u64;p.total+=advertised;saved=Some(Saved::new(&dir,name,&p.r.overwrite)?);p.update("running",true);},
   zmodem2::ReceiverEvent::FileComplete=>{let file=saved.take().ok_or("ZMODEM缺少接收文件")?;if file.size!=advertised{return Err("ZMODEM文件长度与声明不符".into())}completed+=file.size;if let Some(path)=file.commit(false)?{p.files.push(path)}count+=1;p.done=completed;},
   zmodem2::ReceiverEvent::SessionComplete=>{if saved.is_some(){return Err("ZMODEM会话提前结束".into())}finished=true;}
  }}
  if !receiver.drain_file().is_empty(){let data=receiver.drain_file();let file=saved.as_mut().ok_or("ZMODEM未声明文件就发送数据")?;if file.size+data.len() as u64>advertised{return Err("ZMODEM数据超过声明大小".into())}file.write(data)?;let n=data.len();p.done=completed+file.size;receiver.advance_file(n).map_err(ioerr)?;p.update("running",false);continue;}
  if !receiver.drain_outgoing().is_empty(){let data=receiver.drain_outgoing().to_vec();w.send(&data).await?;receiver.advance_outgoing(data.len());continue;}
  if finished {w.control(&[b'O']).await?;w.control(&[b'O']).await?;return Ok(())}
  if w.buffer.is_empty(){w.fill().await?}let data:Vec<_>=w.buffer.iter().copied().collect();let n=receiver.feed_incoming(&data).map_err(ioerr)?;w.buffer.drain(..n);if n==0&&receiver.drain_outgoing().is_empty()&&receiver.drain_file().is_empty(){return Err("ZMODEM对端响应无进展".into())}
 }
}
pub async fn run(request:Request,input:mpsc::Receiver<Vec<u8>>,cancel:watch::Receiver<bool>,writer:SessionWriter,sink:Sink)->Result<Outcome,String>{
 validate(&request)?;let upload=if request.direction=="upload"{sources(&request)?}else{Vec::new()};let z=request.protocol=="zmodem";let sending=request.direction=="upload";
 let now=Instant::now();let mut report=Report{r:request,sink,started:now,last:now,done:0,total:0,files:vec![],name:String::new()};let mut wire=Wire{input,cancel,writer,buffer:VecDeque::new(),timeout:TIMEOUT};
 let result=if z&&sending{z_send(&mut wire,&mut report,upload).await}else if z{z_receive(&mut wire,&mut report).await}else if sending{xy_send(&mut wire,&mut report,upload).await}else{xy_receive(&mut wire,&mut report).await};
 if let Err(e)=result{let _=wire.send_unchecked(&[CAN;8]).await;return Err(e)}report.update("completed",true);Ok(Outcome{status:"completed".into(),done:report.done,total:report.total,files:report.files})
}
#[cfg(test)]
#[path="modem_tests.rs"]
mod tests;
