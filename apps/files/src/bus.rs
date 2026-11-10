//! One File Explorer for every window (GNOME Files' way): the first start takes
//! `org.freedesktop.FileManager1` on the session bus, the name other programs call
//! to show a folder or a file ("show in folder"); a second start (Super+E, the
//! Start menu) hands its folder to the first through that same call and ends. The
//! bus starts the program on a call while none runs
//! (`~/.local/share/dbus-1/services/org.freedesktop.FileManager1.service`, `--bus`).
//!
//! ```text
//! busctl --user call org.freedesktop.FileManager1 /org/freedesktop/FileManager1 org.freedesktop.FileManager1 ShowFolders ass 1 file:///home 0
//! ```

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;

use iced::Subscription;
use iced::futures::channel::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::folder;

const NAME: &str = "org.freedesktop.FileManager1";
const PATH: &str = "/org/freedesktop/FileManager1";

#[derive(Debug, Clone)]
pub enum Call {
    /// Open these folders, a window each.
    Folders(Vec<PathBuf>),
    /// Show these files picked in their folders (Properties waits for step 6).
    Items(Vec<PathBuf>),
}

struct Manager(UnboundedSender<Call>);

#[zbus::interface(name = "org.freedesktop.FileManager1")]
impl Manager {
    fn show_folders(&self, uris: Vec<String>, _startup_id: String) {
        let _ = self.0.unbounded_send(Call::Folders(paths(&uris)));
    }
    fn show_items(&self, uris: Vec<String>, _startup_id: String) {
        let _ = self.0.unbounded_send(Call::Items(paths(&uris)));
    }
    fn show_item_properties(&self, uris: Vec<String>, _startup_id: String) {
        let _ = self.0.unbounded_send(Call::Items(paths(&uris)));
    }
}

fn paths(uris: &[String]) -> Vec<PathBuf> {
    uris.iter().map(|u| folder::from_arg(u)).collect()
}

static CALLS: Mutex<Option<UnboundedReceiver<Call>>> = Mutex::new(None);

/// Another File Explorer holds the name.
pub struct Taken;

/// Takes the name, or says another program has it. With no session bus the program
/// runs alone.
pub fn take() -> Result<(), Taken> {
    let (tx, rx) = mpsc::unbounded();
    let (said, heard) = std::sync::mpsc::channel::<Result<(), bool>>();
    thread::spawn(move || {
        zbus::block_on(async {
            // zbus asks for a name with "take it, and let it be taken" by default:
            // every new start then stole it and ran a copy of its own (measured
            // 2026-11-03). Neither, so a second start finds it taken and hands over.
            let builder = zbus::connection::Builder::session().allow_name_replacements(false).replace_existing_names(false);
            match builder.serve_at(PATH, Manager(tx)).name(NAME).build().await {
                Ok(_conn) => {
                    let _ = said.send(Ok(()));
                    std::future::pending::<()>().await;
                }
                Err(zbus::Error::NameTaken) => {
                    let _ = said.send(Err(true));
                }
                Err(e) => {
                    eprintln!("mp-files: session bus: {e}");
                    let _ = said.send(Err(false));
                }
            }
        })
    });
    match heard.recv() {
        Ok(Ok(())) => {
            *CALLS.lock().unwrap() = Some(rx);
            Ok(())
        }
        Ok(Err(true)) => Err(Taken),
        _ => Ok(()),
    }
}

/// Asks the running File Explorer for a window on `folder`.
pub fn show(folder: &Path) {
    let call = async {
        let conn = zbus::Connection::session().await?;
        conn.call_method(Some(NAME), PATH, Some(NAME), "ShowFolders", &(vec![folder::address(folder)], "")).await
    };
    if let Err(e) = zbus::block_on(call) {
        eprintln!("mp-files: the running File Explorer didn't answer: {e}");
    }
}

/// The calls, in the order they came.
pub fn calls() -> Subscription<Call> {
    Subscription::run(|| CALLS.lock().unwrap().take().unwrap_or_else(|| mpsc::unbounded().1))
}
