//! Daemon bootstrap: engine thread (owns libobs) + tokio pipe server.
//! Order mirrors the capture daemon's run(): engine first (init failure ⇒
//! exit nonzero before binding), then the socket; a second instance exits 0
//! so the supervisor adopts the incumbent.

pub mod engine;
pub mod meters;
pub mod namer;
pub mod profile;
pub mod protocol;
pub mod socket;

use std::sync::mpsc;

use mortar_pestle_daemon::pipe;
use tokio::sync::{broadcast, oneshot};

const EVENT_BUS_CAPACITY: usize = 256;

pub fn run(payload_root: std::path::PathBuf) -> i32 {
    let (cmd_tx, cmd_rx) = mpsc::channel::<engine::Cmd>();
    let (events, _) = broadcast::channel::<protocol::Event>(EVENT_BUS_CAPACITY);
    let (init_tx, init_rx) = oneshot::channel();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        // Bind-or-yield BEFORE touching libobs: a second instance must exit 0
        // for supervisor adopt without spinning up a whole GPU pipeline.
        let first = match pipe::bind_first(socket::PIPE_NAME) {
            Ok(s) => s,
            Err(e) if pipe::already_running(&e) => {
                log::info!("daemon already running on {} — exiting for adopt", socket::PIPE_NAME);
                return 0;
            }
            Err(e) => {
                log::error!("pipe bind failed: {e}");
                return 1;
            }
        };

        let _engine = engine::spawn(payload_root, cmd_tx.clone(), cmd_rx, events.clone(), init_tx);
        match init_rx.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                log::error!("engine init failed: {e}");
                return 1;
            }
            Err(_) => {
                log::error!("engine thread died during init");
                return 1;
            }
        }
        match socket::serve(first, socket::Ctx { cmd_tx, events }).await {
            Ok(()) => 0,
            Err(e) => {
                log::error!("socket serve failed: {e}");
                1
            }
        }
    })
}
