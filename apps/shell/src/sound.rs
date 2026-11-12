//! Sound: the outputs and microphones, the ones in use, and the output's volume,
//! read live from the sound server (PipeWire's PulseAudio side, `pipewire-pulse`)
//! and set there. One connection on a waiting thread, as `niri.rs` reads niri:
//! the server's change notices and the answers to our own asks both arrive on it,
//! so nothing runs between changes. The `pulseaudio` crate (pure Rust) reads and
//! writes the wire format; his pick 2026-10-30 over libpulse (19 more C libraries
//! loaded) and a `pactl subscribe` helper (1.4 MB more, always on).

use std::ffi::CString;
use std::io::{BufReader, Cursor, Read};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering::Relaxed};
use std::thread;
use std::time::Duration;

use iced::Subscription;
use iced::futures::channel::mpsc;
use pulseaudio::protocol::{self as pa, Command, SubscriptionMask, TagStructRead, TagStructReader};

/// A speaker or microphone: the server's name for it and the one it shows.
#[derive(Debug, Clone, PartialEq)]
pub struct Device {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sound {
    pub outputs: Vec<Device>,
    /// Microphones only: each output's "Monitor of" copy left out (Windows lists none).
    pub inputs: Vec<Device>,
    /// The ones in use (the server's defaults), by name.
    pub output: String,
    pub input: String,
    /// The output's volume, 1.0 = 100% (the scale `wpctl` and the volume keys use).
    pub volume: f32,
    pub muted: bool,
    /// The output's channels, each set alike.
    channels: u8,
}

/// The latest `Sound`, kept by the reader thread and by our own sets at once.
static SOUND: Mutex<Sound> = Mutex::new(Sound { outputs: Vec::new(), inputs: Vec::new(), output: String::new(), input: String::new(), volume: 0.0, muted: false, channels: 2 });

/// The connection's writing half, shared by the reader's asks and the box's sets,
/// with the protocol version agreed.
static WRITE: Mutex<Option<(UnixStream, u16)>> = Mutex::new(None);
/// The next message's number; the handshake takes 0-2.
static SEQ: AtomicU32 = AtomicU32::new(3);

/// The loudest the shell sets (his call 2026-10-30: 100% was too quiet in his
/// headphones; pavucontrol's and GNOME's boost top). Past 1.0 the server boosts in
/// software. Windows and Caelestia (`maxVolume` 1.0) stopped at 100%.
pub const MAX: f32 = 1.5;

pub fn sound() -> Sound {
    SOUND.lock().unwrap().clone()
}

/// Sends a command on the shared connection; its answer comes to the reader. The
/// number it went under, or none when there is no connection.
fn send(command: &Command) -> Option<u32> {
    let mut write = WRITE.lock().unwrap();
    let (stream, version) = write.as_mut()?;
    let seq = SEQ.fetch_add(1, Relaxed);
    match pa::write_command_message(stream, seq, command, *version) {
        Ok(()) => Some(seq),
        Err(e) => {
            eprintln!("mp-shell: sound server: {e}");
            None
        }
    }
}

/// Makes `name` the output everything plays through, or with `input` the microphone.
pub fn choose(name: &str, input: bool) {
    let Ok(device) = CString::new(name) else { return };
    {
        let mut s = SOUND.lock().unwrap();
        *if input { &mut s.input } else { &mut s.output } = name.into();
    }
    send(&if input { Command::SetDefaultSource(device) } else { Command::SetDefaultSink(device) });
}

/// Sets the output's volume (0 to `MAX`, whole percents); moving it unmutes, as
/// Windows' slider and the volume keys.
pub fn set_volume(volume: f32) {
    let volume = (volume.clamp(0.0, MAX) * 100.0).round() / 100.0;
    let (channels, muted) = {
        let mut s = SOUND.lock().unwrap();
        s.volume = volume;
        (s.channels.max(1), std::mem::take(&mut s.muted))
    };
    let mut cvolume = pa::ChannelVolume::empty();
    let level = pa::Volume::from_u32_clamped((volume * pa::Volume::NORM.as_u32() as f32).round() as u32);
    (0..channels).for_each(|_| cvolume.push(level));
    send(&Command::SetSinkVolume(pa::SetDeviceVolumeParams { device_index: None, device_name: Some(pa::DEFAULT_SINK.into()), volume: cvolume }));
    if muted {
        mute(false);
    }
}

/// The volume up or down by `by` from where it is (the wheel's 10%).
pub fn step(by: f32) {
    let volume = SOUND.lock().unwrap().volume;
    set_volume(volume + by);
}

pub fn mute(muted: bool) {
    SOUND.lock().unwrap().muted = muted;
    send(&Command::SetSinkMute(pa::SetDeviceMuteParams { device_index: None, device_name: Some(pa::DEFAULT_SINK.into()), mute: muted }));
}

/// Signs in to the server and asks for its output, microphone and server changes.
fn connect() -> Result<(BufReader<UnixStream>, u16), Box<dyn std::error::Error>> {
    let path = pulseaudio::socket_path_from_env().ok_or("no sound server socket")?;
    let mut sock = BufReader::new(UnixStream::connect(path)?);
    let cookie = pulseaudio::cookie_path_from_env().and_then(|p| std::fs::read(p).ok()).unwrap_or_default();
    let auth = pa::AuthParams { version: pa::MAX_VERSION, supports_shm: false, supports_memfd: false, cookie };
    pa::write_command_message(sock.get_mut(), 0, &Command::Auth(auth), pa::MAX_VERSION)?;
    let version = pa::MAX_VERSION.min(pa::read_reply_message::<pa::AuthReply>(&mut sock, pa::MAX_VERSION)?.1.version);
    let mut props = pa::Props::new();
    props.set(pa::Prop::ApplicationName, c"mp-shell");
    pa::write_command_message(sock.get_mut(), 1, &Command::SetClientName(props), version)?;
    pa::read_reply_message::<pa::SetClientNameReply>(&mut sock, version)?;
    let mask = SubscriptionMask::SINK | SubscriptionMask::SOURCE | SubscriptionMask::SERVER;
    pa::write_command_message(sock.get_mut(), 2, &Command::Subscribe(mask), version)?;
    pa::read_ack_message(&mut sock)?;
    Ok((sock, version))
}

/// One read of everything: the three asks' numbers, and their answers as they come.
#[derive(Default)]
struct Asks {
    seqs: [Option<u32>; 3],
    server: Option<pa::ServerInfo>,
    sinks: Option<pa::SinkInfoList>,
    sources: Option<pa::SourceInfoList>,
}

impl Asks {
    fn send() -> Self {
        let seqs = [Command::GetServerInfo, Command::GetSinkInfoList, Command::GetSourceInfoList].map(|c| send(&c));
        Self { seqs, ..Self::default() }
    }

    fn waiting(&self) -> bool {
        self.seqs.iter().any(Option::is_some)
    }

    /// Takes the answer to ask `seq`, if it is one of ours.
    fn answer(&mut self, seq: u32, ts: &mut TagStructReader<'_>, version: u16) -> Result<(), pa::ProtocolError> {
        match self.seqs.iter().position(|s| *s == Some(seq)) {
            Some(0) => self.server = Some(pa::ServerInfo::read(ts, version)?),
            Some(1) => self.sinks = Some(pa::SinkInfoList::read(ts, version)?),
            Some(2) => self.sources = Some(pa::SourceInfoList::read(ts, version)?),
            _ => return Ok(()),
        }
        self.seqs.iter_mut().filter(|s| **s == Some(seq)).for_each(|s| *s = None);
        Ok(())
    }

    fn sound(&self) -> Option<Sound> {
        let (server, sinks, sources) = (self.server.as_ref()?, self.sinks.as_ref()?, self.sources.as_ref()?);
        let text = |c: &CString| c.to_string_lossy().into_owned();
        let device = |name: &CString, description: &Option<CString>| Device { name: text(name), description: text(description.as_ref().unwrap_or(name)) };
        let output = server.default_sink_name.as_ref().map(text).unwrap_or_default();
        let main = sinks.iter().find(|s| text(&s.name) == output);
        let level = main.and_then(|s| s.cvolume.channels().iter().map(|v| v.as_u32()).max()).unwrap_or(0);
        Some(Sound {
            outputs: sinks.iter().map(|s| device(&s.name, &s.description)).collect(),
            inputs: sources.iter().filter(|s| s.monitor_of_sink_index.is_none()).map(|s| device(&s.name, &s.description)).collect(),
            output,
            input: server.default_source_name.as_ref().map(text).unwrap_or_default(),
            volume: level as f32 / pa::Volume::NORM.as_u32() as f32,
            muted: main.is_some_and(|s| s.muted),
            channels: main.map_or(2, |s| s.cvolume.channels().len() as u8),
        })
    }
}

/// Fires whenever `SOUND` changes. On each change notice the thread reads the
/// server's state anew (one read at a time; notices during a read ask for one more).
pub fn events() -> Subscription<()> {
    Subscription::run(|| {
        let (mut tx, rx) = mpsc::channel(1);
        thread::spawn(move || {
            // The server may not be up yet as the strip starts, and may restart under
            // it: try again every 5 s (as `music/now.rs`), or the speaker stays frozen
            // and the wheel and slider dead until the strip restarts. One log line a
            // failed stretch, not one a try.
            let mut said = false;
            while !tx.is_closed() {
                match connect() {
                    Ok((sock, version)) => {
                        said = false;
                        listen(sock, version, &mut tx);
                        *WRITE.lock().unwrap() = None;
                        eprintln!("mp-shell: sound server connection ended");
                    }
                    Err(e) if !said => {
                        said = true;
                        eprintln!("mp-shell: sound server: {e}");
                    }
                    Err(_) => {}
                }
                thread::sleep(Duration::from_secs(5));
            }
        });
        rx
    })
}

/// Reads one connection until it ends.
fn listen(mut sock: BufReader<UnixStream>, version: u16, tx: &mut mpsc::Sender<()>) {
    *WRITE.lock().unwrap() = sock.get_ref().try_clone().ok().map(|s| (s, version));
    let mut asks = Asks::send();
    let mut again = false;
    let mut payload = Vec::new();
    while let Ok(desc) = pa::read_descriptor(&mut sock) {
        payload.resize(desc.length as usize, 0);
        if sock.read_exact(&mut payload).is_err() {
            break;
        }
        let mut r = Cursor::new(payload.as_slice());
        match Command::read_tag_prefixed(&mut r, version) {
            Ok((_, Command::SubscribeEvent(_))) if asks.waiting() => again = true,
            Ok((_, Command::SubscribeEvent(_))) => asks = Asks::send(),
            Ok((seq, Command::Reply)) => {
                if let Err(e) = asks.answer(seq, &mut TagStructReader::new(&mut r, version), version) {
                    eprintln!("mp-shell: sound server answer: {e}");
                }
            }
            // Our sets' refusals, and a refused ask (its read is dropped).
            Ok((seq, Command::Error(e))) => {
                eprintln!("mp-shell: sound server refused #{seq}: {e:?}");
                asks.seqs.iter_mut().filter(|s| **s == Some(seq)).for_each(|s| *s = None);
            }
            Ok(_) => {}
            Err(e) => eprintln!("mp-shell: sound server message: {e}"),
        }
        if asks.waiting() {
            continue;
        }
        if let Some(new) = asks.sound() {
            let mut s = SOUND.lock().unwrap();
            if *s != new {
                *s = new;
                drop(s);
                let _ = tx.try_send(());
            }
            asks.server = None;
        }
        if std::mem::take(&mut again) {
            asks = Asks::send();
        }
    }
}
