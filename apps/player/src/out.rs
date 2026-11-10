//! The speakers: one playback stream on the sound server (PipeWire's PulseAudio side),
//! read and written through the `pulseaudio` crate's plain wire format, as mp-shell's
//! sound box. The server asks for bytes (`Request`), the player answers with sound.

use std::error::Error;
use std::io::{self, BufReader, Cursor, Read};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::time::SystemTime;

use pulseaudio::protocol::{self as pa, Command, TagStructRead, TagStructReader};

/// How far ahead of the speakers the server keeps sound: what a pause, a seek or a
/// song change lags by. The server's own default is about 2 s.
const AHEAD_MS: u32 = 200;

#[derive(Clone, Copy, Debug)]
pub struct Stream {
    channel: u32,
    index: u32,
    pub rate: u32,
    pub channels: u8,
    /// Seconds of sound the server keeps waiting: the target it granted.
    line: f64,
}

pub enum Heard {
    /// The server wants more bytes (`Out::owed`).
    Wants,
    /// The speakers' own delay came back (`Out::ahead`).
    Timed,
    /// Everything sent so far has been played.
    Drained,
    /// The server ended the stream, or refused to make one.
    Killed,
    Nothing,
}

pub struct Out {
    sock: BufReader<UnixStream>,
    version: u16,
    seq: u32,
    payload: Vec<u8>,
    pub stream: Option<Stream>,
    /// Bytes the stream asked for and hasn't had yet. Asks keep coming while paused (a
    /// seek empties the stream), and the server never asks for the same bytes twice.
    pub owed: usize,
    /// Seconds from sending sound to hearing it: the stream's line (the target the server
    /// granted) plus the speakers' own delay, asked once a stream (200 + 42.7 ms here).
    pub ahead: f64,
    /// That delay asked for: its message number.
    timing: Option<u32>,
    /// A stream asked for: its message number, rate and channels.
    making: Option<(u32, u32, u8)>,
    /// A drain asked for: its message number.
    draining: Option<u32>,
    /// Streams asked for and no longer wanted (a second `open` came before the answer):
    /// their message numbers, each deleted when its answer comes.
    unwanted: Vec<u32>,
}

impl Out {
    /// Signs in to the server, as mp-shell's `sound::connect` (no change notices).
    pub fn connect() -> Result<Out, Box<dyn Error>> {
        let path = pulseaudio::socket_path_from_env().ok_or("no sound server socket")?;
        let mut sock = BufReader::new(UnixStream::connect(path)?);
        let cookie = pulseaudio::cookie_path_from_env().and_then(|p| std::fs::read(p).ok()).unwrap_or_default();
        let auth = pa::AuthParams { version: pa::MAX_VERSION, supports_shm: false, supports_memfd: false, cookie };
        pa::write_command_message(sock.get_mut(), 0, &Command::Auth(auth), pa::MAX_VERSION)?;
        let version = pa::MAX_VERSION.min(pa::read_reply_message::<pa::AuthReply>(&mut sock, pa::MAX_VERSION)?.1.version);
        let mut props = pa::Props::new();
        props.set(pa::Prop::ApplicationName, c"Music");
        pa::write_command_message(sock.get_mut(), 1, &Command::SetClientName(props), version)?;
        pa::read_reply_message::<pa::SetClientNameReply>(&mut sock, version)?;
        Ok(Out { sock, version, seq: 2, payload: Vec::new(), stream: None, owed: 0, ahead: 0.0, timing: None, making: None, draining: None, unwanted: Vec::new() })
    }

    pub fn fd(&self) -> RawFd {
        self.sock.get_ref().as_raw_fd()
    }

    /// A message already read off the socket and waiting in the buffer.
    pub fn waiting(&self) -> bool {
        !self.sock.buffer().is_empty()
    }

    fn send(&mut self, command: &Command) -> u32 {
        self.seq += 1;
        if let Err(e) = pa::write_command_message(self.sock.get_mut(), self.seq, command, self.version) {
            eprintln!("mp-player: sound server: {e}");
        }
        self.seq
    }

    /// A stream for this rate and channels, unless the one there already fits. Sound
    /// still in the old one is dropped.
    pub fn open(&mut self, rate: u32, channels: u8, volume: f64, corked: bool) {
        if self.stream.is_some_and(|s| s.rate == rate && s.channels == channels) || self.making.is_some_and(|m| m.1 == rate && m.2 == channels) {
            return;
        }
        self.close();
        self.unwanted.extend(self.making.take().map(|m| m.0));
        let ahead = rate * channels as u32 * 4 * AHEAD_MS / 1000;
        let params = pa::PlaybackStreamParams {
            sample_spec: pa::SampleSpec { format: pa::SampleFormat::Float32Le, channels, sample_rate: rate },
            channel_map: if channels == 1 { pa::ChannelMap::mono() } else { pa::ChannelMap::stereo() },
            cvolume: Some(level(volume, channels)),
            sink_name: Some(pa::DEFAULT_SINK.to_owned()),
            buffer_attr: pa::stream::BufferAttr { max_length: u32::MAX, target_length: ahead, pre_buffering: u32::MAX, minimum_request_length: u32::MAX, fragment_size: u32::MAX },
            flags: pa::stream::StreamFlags { start_corked: corked, ..Default::default() },
            ..Default::default()
        };
        let seq = self.send(&Command::CreatePlaybackStream(params));
        self.making = Some((seq, rate, channels));
    }

    pub fn close(&mut self) {
        if let Some(s) = self.stream.take() {
            self.send(&Command::DeletePlaybackStream(s.channel));
        }
        (self.owed, self.ahead, self.timing) = (0, 0.0, None);
        self.draining = None;
    }

    pub fn cork(&mut self, cork: bool) {
        if let Some(s) = self.stream {
            self.send(&Command::CorkPlaybackStream(pa::CorkStreamParams { channel: s.channel, cork }));
        }
    }

    /// Drops the sound not played yet (a seek, a skip); the server asks for more.
    pub fn flush(&mut self) {
        if let Some(s) = self.stream {
            self.send(&Command::FlushPlaybackStream(s.channel));
        }
    }

    /// Asks to hear when everything sent has been played; false when there's no stream
    /// to wait for.
    pub fn drain(&mut self) -> bool {
        let Some(s) = self.stream else { return false };
        self.draining = Some(self.send(&Command::DrainPlaybackStream(s.channel)));
        true
    }

    /// The stream's own volume, 1.0 = 100%. The server's scale is cubic, so this is
    /// Windows' cubic volume curve as it stands.
    pub fn volume(&mut self, volume: f64) {
        if let Some(s) = self.stream {
            self.send(&Command::SetSinkInputVolume(pa::SetStreamVolumeParams { index: s.index, volume: level(volume, s.channels) }));
        }
    }

    pub fn write(&mut self, sound: &[u8]) {
        if let Some(s) = self.stream {
            if let Err(e) = pa::write_memblock(self.sock.get_mut(), s.channel, sound, 0) {
                eprintln!("mp-player: sound server: {e}");
            }
            self.owed = self.owed.saturating_sub(sound.len());
        }
    }

    /// Reads one message (blocks until a whole one is there).
    pub fn read(&mut self) -> io::Result<Heard> {
        let desc = pa::read_descriptor(&mut self.sock).map_err(io::Error::other)?;
        self.payload.resize(desc.length as usize, 0);
        self.sock.read_exact(&mut self.payload)?;
        let mut r = Cursor::new(self.payload.as_slice());
        Ok(match Command::read_tag_prefixed(&mut r, self.version) {
            Ok((_, Command::Request(ask))) if self.stream.is_some_and(|s| s.channel == ask.channel) => {
                self.owed += ask.length as usize;
                Heard::Wants
            }
            Ok((seq, Command::Reply)) if self.making.is_some_and(|m| m.0 == seq) => {
                let (_, rate, channels) = self.making.take().unwrap();
                let made = pa::CreatePlaybackStreamReply::read(&mut TagStructReader::new(&mut r, self.version), self.version).map_err(io::Error::other)?;
                let line = made.buffer_attr.target_length as f64 / (4 * channels as u32 * rate) as f64;
                self.stream = Some(Stream { channel: made.channel, index: made.stream_index, rate, channels, line });
                self.owed = made.requested_bytes as usize;
                self.ahead = line;
                Heard::Wants
            }
            Ok((seq, Command::Reply)) if self.unwanted.contains(&seq) => {
                self.unwanted.retain(|&s| s != seq);
                let made = pa::CreatePlaybackStreamReply::read(&mut TagStructReader::new(&mut r, self.version), self.version).map_err(io::Error::other)?;
                self.send(&Command::DeletePlaybackStream(made.channel));
                Heard::Nothing
            }
            // Playing now (its line is full): the speakers' delay reads true only from here.
            Ok((_, Command::Started(channel))) if self.stream.is_some_and(|s| s.channel == channel) => {
                self.timing = Some(self.send(&Command::GetPlaybackLatency(pa::LatencyParams { channel, now: SystemTime::now() })));
                Heard::Nothing
            }
            Ok((seq, Command::Reply)) if self.timing == Some(seq) => {
                self.timing = None;
                let timing = pa::PlaybackLatency::read(&mut TagStructReader::new(&mut r, self.version), self.version).map_err(io::Error::other)?;
                self.ahead = self.stream.map_or(0.0, |s| s.line) + timing.sink_usec as f64 / 1e6;
                Heard::Timed
            }
            Ok((seq, Command::Reply)) if self.draining == Some(seq) => {
                self.draining = None;
                Heard::Drained
            }
            Ok((seq, Command::Error(e))) => {
                eprintln!("mp-player: sound server refused #{seq}: {e:?}");
                self.unwanted.retain(|&s| s != seq);
                if self.draining == Some(seq) {
                    self.draining = None;
                    return Ok(Heard::Drained);
                }
                if self.making.is_some_and(|m| m.0 == seq) {
                    self.making = None;
                    return Ok(Heard::Killed);
                }
                Heard::Nothing
            }
            Ok((_, Command::PlaybackStreamKilled(channel))) if self.stream.is_some_and(|s| s.channel == channel) => {
                eprintln!("mp-player: the sound server ended the stream");
                // A drain in flight will never be answered: what will play has played.
                let draining = self.draining.is_some();
                self.stream = None;
                self.close();
                if draining { Heard::Drained } else { Heard::Killed }
            }
            Ok(_) => Heard::Nothing,
            Err(e) => {
                eprintln!("mp-player: sound server message: {e}");
                Heard::Nothing
            }
        })
    }
}

fn level(volume: f64, channels: u8) -> pa::ChannelVolume {
    let mut cvolume = pa::ChannelVolume::empty();
    let level = pa::Volume::from_u32_clamped((volume.clamp(0.0, 1.0) * pa::Volume::NORM.as_u32() as f64).round() as u32);
    (0..channels.max(1)).for_each(|_| cvolume.push(level));
    cvolume
}
