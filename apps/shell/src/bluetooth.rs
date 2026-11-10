//! Bluetooth as BlueZ tells it on the system bus (Left Strip Return plan step 3): the
//! controller, on or off and whether it is looking for devices, and the devices it
//! knows, each with its name, BlueZ's picture name, paired, connected and battery. One
//! connection on its own thread, as `music/now.rs`: BlueZ's whole list once
//! (`GetManagedObjects`), then only its signals, so nothing runs between changes.
//! BlueZ is asked only while it runs (its owner read first), so a stopped bluetoothd
//! is never started by a call. The Bluetooth menu's asks (step 4) go out on the same
//! connection, each answer awaited beside the signals, so a slow connect holds up
//! nothing else.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::thread;

use iced::Subscription;
use iced::futures::channel::mpsc;
use iced::futures::future::{self, Either};
use iced::futures::stream::FuturesUnordered;
use iced::futures::{StreamExt, stream};
use iced::time::Instant;
use zbus::message::Type;
use zbus::{Connection, MatchRule, Message, MessageStream, ObjectPath, OwnedObjectPath, OwnedVariant, Variant};

const BLUEZ: &str = "org.bluez";
const ADAPTER: &str = "org.bluez.Adapter1";
const DEVICE: &str = "org.bluez.Device1";
const BATTERY: &str = "org.bluez.Battery1";
const OBJECTS: &str = "org.freedesktop.DBus.ObjectManager";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";

type Props = HashMap<String, OwnedVariant>;

/// A controller.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Adapter {
    pub powered: bool,
    /// Looking for devices, for anyone (BlueZ keeps one look for each program that asks).
    pub discovering: bool,
}

/// A device BlueZ knows: found nearby, or paired before.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Device {
    /// `Alias`: the name it gives, or one set on this PC.
    pub name: String,
    /// `Icon`: the freedesktop picture name BlueZ guesses from its class ("audio-headset").
    pub icon: String,
    pub paired: bool,
    /// Paired with its keys kept: what Caelestia offers to forget.
    pub bonded: bool,
    pub connected: bool,
    /// `Battery1.Percentage`, for a device that tells it.
    pub battery: Option<u8>,
    /// When a connect or disconnect asked from here went out, while its answer is awaited
    /// (Quickshell's Connecting / Disconnecting, which Caelestia shows; BlueZ has no such
    /// state).
    pub busy: Option<Instant>,
}

/// One BlueZ object: a controller, or a device with its battery.
#[derive(Debug, Clone, Default, PartialEq)]
struct Object {
    adapter: Option<Adapter>,
    device: Option<Device>,
}

/// What BlueZ knows, by its paths (`/org/bluez/hci0`, `/org/bluez/hci0/dev_..`), so in
/// its order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Bluetooth(BTreeMap<String, Object>);

impl Bluetooth {
    /// The first controller (Quickshell's `defaultAdapter`, which Caelestia reads); none
    /// without one.
    pub fn adapter(&self) -> Option<&Adapter> {
        self.0.values().find_map(|o| o.adapter.as_ref())
    }

    fn adapter_path(&self) -> Option<&str> {
        self.0.iter().find(|(_, o)| o.adapter.is_some()).map(|(path, _)| path.as_str())
    }

    /// Each device with its path, the name the asks go by.
    pub fn devices(&self) -> impl Iterator<Item = (&str, &Device)> {
        self.0.iter().filter_map(|(path, o)| Some((path.as_str(), o.device.as_ref()?)))
    }
}

/// What the Bluetooth menu asks of BlueZ.
#[derive(Debug, Clone)]
pub enum Ask {
    /// The controller on or off (`Adapter1.Powered`).
    Power(bool),
    /// Looking for devices or not (`StartDiscovery` / `StopDiscovery`). BlueZ ends a look
    /// by itself when the program that started it leaves the bus.
    Look(bool),
    /// A device (its path) connected or disconnected.
    Connect(String, bool),
    /// A paired device forgotten (`Adapter1.RemoveDevice` on its controller).
    Forget(String),
}

static ASKS: Mutex<Option<mpsc::UnboundedSender<Ask>>> = Mutex::new(None);

pub fn send(ask: Ask) {
    if let Some(tx) = ASKS.lock().unwrap().as_ref() {
        let _ = tx.unbounded_send(ask);
    }
}

static BLUETOOTH: Mutex<Bluetooth> = Mutex::new(Bluetooth(BTreeMap::new()));

pub fn bluetooth() -> Bluetooth {
    BLUETOOTH.lock().unwrap().clone()
}

/// Fires whenever `BLUETOOTH` changes.
pub fn events() -> Subscription<()> {
    Subscription::run(|| {
        let (tx, rx) = mpsc::channel(1);
        thread::spawn(move || {
            if let Err(e) = zbus::block_on(run(tx)) {
                eprintln!("mp-shell: bluetooth: {e}");
            }
        });
        rx
    })
}

enum Heard {
    Bus(zbus::Result<Message>),
    Ask(Ask),
}

/// An ask on its way: done once BlueZ answers, giving back the device it kept busy.
type Call<'a> = Pin<Box<dyn Future<Output = Option<String>> + 'a>>;

async fn run(mut out: mpsc::Sender<()>) -> zbus::Result<()> {
    let conn = Connection::system().await?;
    let signal = |interface: &'static str, member: &'static str| MatchRule::builder().msg_type(Type::Signal).interface(interface).member(member);
    // Listening first, then the list, so no change can slip in between.
    let rules = [
        signal("org.freedesktop.DBus", "NameOwnerChanged").sender("org.freedesktop.DBus").arg(0, BLUEZ).build()?,
        signal(OBJECTS, "InterfacesAdded").sender(BLUEZ).build()?,
        signal(OBJECTS, "InterfacesRemoved").sender(BLUEZ).build()?,
        signal(PROPERTIES, "PropertiesChanged").sender(BLUEZ).path_namespace("/org/bluez").build()?,
    ];
    let mut streams = Vec::new();
    for rule in rules {
        streams.push(MessageStream::for_match_rule(rule, &conn, None).await?);
    }
    let (tx, rx) = mpsc::unbounded();
    *ASKS.lock().unwrap() = Some(tx);
    let mut bus = stream::select(stream::select_all(streams).map(Heard::Bus), rx.map(Heard::Ask));
    let mut calls = FuturesUnordered::<Call>::new();
    // Whether this shell's own look runs (BlueZ refuses to stop another program's).
    let mut looking = false;

    let running = conn.call_method(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "NameHasOwner", &(BLUEZ,)).await.ok().and_then(|reply| reply.body().deserialize::<bool>().ok()).unwrap_or(false);
    let mut bt = Bluetooth::default();
    if running {
        read(&conn, &mut bt).await;
    }
    tell(&mut out, &bt);
    loop {
        let next = if calls.is_empty() {
            bus.next().await
        } else {
            match future::select(bus.next(), calls.next()).await {
                Either::Left((next, _)) => next,
                Either::Right((done, _)) => {
                    if let Some(d) = done.flatten().and_then(|path| bt.0.get_mut(&path)?.device.as_mut()) {
                        d.busy = None;
                    }
                    tell(&mut out, &bt);
                    continue;
                }
            }
        };
        let Some(next) = next else { break };
        if out.is_closed() {
            break;
        }
        match next {
            Heard::Bus(Ok(msg)) => {
                if heard(&conn, &msg, &mut bt).await {
                    looking = false;
                }
            }
            Heard::Bus(Err(_)) => continue,
            Heard::Ask(Ask::Look(false)) if !looking => continue,
            Heard::Ask(a) => {
                if let Ask::Look(on) = a {
                    looking = on;
                }
                calls.extend(ask(&conn, &mut bt, a));
            }
        }
        tell(&mut out, &bt);
    }
    Ok(())
}

/// One ask sent: a connect or disconnect marks its device busy until BlueZ answers. A
/// refusal is only logged; what BlueZ then tells shows the truth.
fn ask<'a>(conn: &'a Connection, bt: &mut Bluetooth, a: Ask) -> Option<Call<'a>> {
    let adapter = bt.adapter_path()?.to_string();
    let busy = match &a {
        Ask::Connect(path, _) => {
            bt.0.get_mut(path)?.device.as_mut()?.busy = Some(Instant::now());
            Some(path.clone())
        }
        _ => None,
    };
    Some(Box::pin(async move {
        let reply = match &a {
            Ask::Power(on) => conn.call_method(Some(BLUEZ), adapter.as_str(), Some(PROPERTIES), "Set", &(ADAPTER, "Powered", Variant::from(*on))).await,
            Ask::Look(on) => conn.call_method(Some(BLUEZ), adapter.as_str(), Some(ADAPTER), if *on { "StartDiscovery" } else { "StopDiscovery" }, &()).await,
            Ask::Connect(path, on) => conn.call_method(Some(BLUEZ), path.as_str(), Some(DEVICE), if *on { "Connect" } else { "Disconnect" }, &()).await,
            // On the device's own controller: its path's parent.
            Ask::Forget(path) => match (path.rsplit_once('/'), ObjectPath::try_from(path.as_str())) {
                (Some((owner, _)), Ok(device)) => conn.call_method(Some(BLUEZ), owner, Some(ADAPTER), "RemoveDevice", &(device,)).await,
                _ => return None,
            },
        };
        if let Err(e) = reply {
            eprintln!("mp-shell: bluetooth: {a:?}: {e}");
        }
        busy
    }))
}

/// Keeps what BlueZ knows; a change wakes the strips (one wake waiting is enough, they
/// read the newest).
fn tell(out: &mut mpsc::Sender<()>, bt: &Bluetooth) {
    let mut kept = BLUETOOTH.lock().unwrap();
    if *kept != *bt {
        *kept = bt.clone();
        let _ = out.try_send(());
    }
}

/// BlueZ's whole list.
async fn read(conn: &Connection, bt: &mut Bluetooth) {
    if let Ok(reply) = conn.call_method(Some(BLUEZ), "/", Some(OBJECTS), "GetManagedObjects", &()).await
        && let Ok(objects) = reply.body().deserialize::<HashMap<OwnedObjectPath, HashMap<String, Props>>>()
    {
        for (path, interfaces) in &objects {
            for (interface, props) in interfaces {
                change(bt, path.as_str(), interface, props);
            }
        }
    }
}

/// One signal from BlueZ, or from the bus about it; true when bluetoothd started or
/// stopped (everything read anew, any look of ours gone with it).
async fn heard(conn: &Connection, msg: &Message, bt: &mut Bluetooth) -> bool {
    let header = msg.header();
    let body = msg.body();
    match header.member().map(|m| m.as_str()) {
        Some("NameOwnerChanged") => {
            *bt = Bluetooth::default();
            if let Ok((_, _, owner)) = body.deserialize::<(String, String, String)>()
                && !owner.is_empty()
            {
                read(conn, bt).await;
            }
            return true;
        }
        Some("InterfacesAdded") => {
            if let Ok((path, interfaces)) = body.deserialize::<(OwnedObjectPath, HashMap<String, Props>)>() {
                for (interface, props) in &interfaces {
                    change(bt, path.as_str(), interface, props);
                }
            }
        }
        Some("InterfacesRemoved") => {
            if let Ok((path, gone)) = body.deserialize::<(OwnedObjectPath, Vec<String>)>() {
                remove(bt, path.as_str(), &gone);
            }
        }
        Some("PropertiesChanged") => {
            if let Some(path) = header.path()
                && let Ok((interface, props, _)) = body.deserialize::<(String, Props, Vec<String>)>()
            {
                change(bt, path.as_str(), &interface, &props);
            }
        }
        _ => {}
    }
    false
}

/// One interface's properties onto its object, which a change also means exists (a
/// battery can come before its device in BlueZ's list).
fn change(bt: &mut Bluetooth, path: &str, interface: &str, props: &Props) {
    if ![ADAPTER, DEVICE, BATTERY].contains(&interface) {
        return;
    }
    let object = bt.0.entry(path.into()).or_default();
    if interface == ADAPTER {
        let a = object.adapter.get_or_insert_default();
        set(&mut a.powered, props, "Powered");
        set(&mut a.discovering, props, "Discovering");
        return;
    }
    let d = object.device.get_or_insert_default();
    if interface == BATTERY {
        if let Some(percent) = get(props, "Percentage") {
            d.battery = Some(percent);
        }
        return;
    }
    set(&mut d.name, props, "Alias");
    set(&mut d.icon, props, "Icon");
    set(&mut d.paired, props, "Paired");
    set(&mut d.bonded, props, "Bonded");
    set(&mut d.connected, props, "Connected");
}

fn remove(bt: &mut Bluetooth, path: &str, gone: &[String]) {
    let Some(object) = bt.0.get_mut(path) else { return };
    for interface in gone {
        match interface.as_str() {
            ADAPTER => object.adapter = None,
            DEVICE => object.device = None,
            BATTERY => {
                if let Some(d) = object.device.as_mut() {
                    d.battery = None;
                }
            }
            _ => {}
        }
    }
    if object.adapter.is_none() && object.device.is_none() {
        bt.0.remove(path);
    }
}

fn set<T: TryFrom<OwnedVariant>>(field: &mut T, props: &Props, key: &str) {
    if let Some(v) = get(props, key) {
        *field = v;
    }
}

fn get<T: TryFrom<OwnedVariant>>(props: &Props, key: &str) -> Option<T> {
    props.get(key)?.try_clone().ok()?.try_into().ok()
}
