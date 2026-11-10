//! The music box's name on the session bus: niri's Mod+Shift+D calls `Key` (the box
//! holds the whole top drawer). The strip serves it from its start.
//!
//! ```text
//! busctl --user call dev.malthaiel.MortarPestle.Music /dev/malthaiel/MortarPestle/Music dev.malthaiel.MortarPestle.Music Key
//! ```

use std::thread;

use iced::Subscription;
use iced::futures::channel::mpsc::{self, UnboundedSender};

const NAME: &str = "dev.malthaiel.MortarPestle.Music";
const PATH: &str = "/dev/malthaiel/MortarPestle/Music";

#[derive(Debug, Clone)]
pub enum Call {
    /// The shortcut: the box opens on the mouse's screen, or closes.
    Key,
    /// A page button on this screen's bar (niri's name, `DP-1`): the box opens there as
    /// by the shortcut (the strip picks the page and shuts it by `Key`; never on the bus).
    Open(String),
}

struct Music(UnboundedSender<Call>);

#[zbus::interface(name = "dev.malthaiel.MortarPestle.Music")]
impl Music {
    fn key(&self) {
        let _ = self.0.unbounded_send(Call::Key);
    }
}

/// The calls, in the order they came (a leave never overtakes its enter). The name is
/// taken once the program runs, so a call that started it waits on the bus till then.
pub fn calls() -> Subscription<Call> {
    Subscription::run(|| {
        let (tx, rx) = mpsc::unbounded();
        thread::spawn(move || {
            let serve = async {
                // zbus's default asks "take it, and let it be taken": a second start
                // stole the name (found in mp-files 2026-11-03). Neither: it ends below.
                let builder = zbus::connection::Builder::session().allow_name_replacements(false).replace_existing_names(false);
                let _conn = builder.serve_at(PATH, Music(tx)).name(NAME).build().await?;
                std::future::pending::<zbus::Result<()>>().await
            };
            // Another copy holding the name (NameTaken) takes the shortcut; the strip
            // goes on, its bar's page buttons still open its own box.
            if let Err(e) = zbus::block_on(serve) {
                eprintln!("mp-shell: music: session bus: {e}");
            }
        });
        rx
    })
}
