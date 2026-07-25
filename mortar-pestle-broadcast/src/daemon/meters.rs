//! Meter fan-in (SP6 SF2): libobs volmeter callbacks land on OBS audio threads
//! at ~60 Hz PER SOURCE. Sending one NDJSON line per callback would put N×60
//! frames/sec on the pipe, so callbacks only write into a shared latest-value
//! map and a single ticker thread coalesces the whole map into ONE `meters`
//! event at 30 Hz.
//!
//! Nothing is sent while unsubscribed — the app turns the stream on when the
//! mixer strip is expanded and off when it collapses (`subscribe_meters`).
//!
//! Values are dB: libobs's volmeter already maps magnitude/peak through
//! obs_mul_to_db before invoking the callback, so no conversion happens here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::sync::broadcast;

use crate::daemon::protocol::Event;

/// Coalesce rate while subscribed. 30 Hz is smooth for a meter; the eye cannot
/// use 60 and the pipe would carry twice the lines for it.
const TICK_MS: u64 = 33;
/// Idle poll while unsubscribed — the thread must stay alive to notice a later
/// subscribe, but it should not wake 30x/sec to do nothing.
const IDLE_MS: u64 = 200;
/// libobs writes MAX_AUDIO_CHANNELS entries; never read past that.
const MAX_CHANNELS: usize = 8;

#[derive(Clone, Default)]
pub struct MeterFrame {
    pub mag: Vec<f32>,
    pub peak: Vec<f32>,
}

pub type Sink = Arc<Mutex<HashMap<String, MeterFrame>>>;

/// The `param` handed to libobs per attached volmeter. Boxed and leaked on
/// attach, reclaimed in `free_slot` after the volmeter is destroyed — freeing
/// it while the volmeter is live would hand the callback a dangling pointer.
pub struct Slot {
    pub key: String,
    pub sink: Sink,
    pub channels: usize,
}

/// libobs volmeter callback. Runs on an OBS audio thread: it must not call any
/// `obs_*` function and must not block. Copying a handful of floats under a
/// short-lived lock satisfies both.
///
/// # Safety
/// `param` must be a live `*mut Slot` from `attach`; the float pointers must
/// each address at least `MAX_AUDIO_CHANNELS` values, as libobs guarantees.
pub unsafe extern "C" fn on_updated(
    param: *mut std::os::raw::c_void,
    magnitude: *const f32,
    peak: *const f32,
    _input_peak: *const f32,
) {
    if param.is_null() || magnitude.is_null() || peak.is_null() {
        return;
    }
    let slot = &*(param as *const Slot);
    let n = slot.channels.clamp(1, MAX_CHANNELS);
    let mag = std::slice::from_raw_parts(magnitude, n).to_vec();
    let pk = std::slice::from_raw_parts(peak, n).to_vec();
    // try_lock, not lock: the ticker holds this for microseconds, and dropping
    // one meter frame is invisible where blocking an audio thread is not.
    if let Ok(mut map) = slot.sink.try_lock() {
        map.insert(slot.key.clone(), MeterFrame { mag, peak: pk });
    }
}

/// Reclaim a leaked slot. Call only AFTER `obs_volmeter_destroy`.
///
/// # Safety
/// `slot` must come from `Box::into_raw` and must not be freed twice.
pub unsafe fn free_slot(slot: *mut Slot) {
    if !slot.is_null() {
        drop(Box::from_raw(slot));
    }
}

/// One ticker for the whole daemon, spawned at engine start and parked on the
/// idle poll until the app subscribes.
pub fn spawn_ticker(sink: Sink, on: Arc<AtomicBool>, events: broadcast::Sender<Event>) {
    std::thread::Builder::new()
        .name("meter-ticker".into())
        .spawn(move || {
            let start = Instant::now();
            loop {
                if !on.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(IDLE_MS));
                    continue;
                }
                std::thread::sleep(Duration::from_millis(TICK_MS));
                let frames = match sink.lock() {
                    Ok(map) => map.clone(),
                    Err(_) => continue,
                };
                if frames.is_empty() {
                    continue;
                }
                let mut sources = serde_json::Map::with_capacity(frames.len());
                for (name, f) in frames {
                    sources.insert(name, json!({ "mag": f.mag, "peak": f.peak }));
                }
                let _ = events.send(Event {
                    event: "meters".into(),
                    data: json!({ "t": start.elapsed().as_millis() as u64, "sources": sources }),
                });
            }
        })
        .expect("spawn meter ticker");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The callback contract: dB floats land in the sink under the slot key,
    /// truncated to the slot's channel count. Breaks if the slice length or
    /// the key ever drifts.
    #[test]
    fn callback_writes_frame() {
        let sink: Sink = Arc::new(Mutex::new(HashMap::new()));
        let slot = Box::into_raw(Box::new(Slot {
            key: "Mic/Aux".into(),
            sink: sink.clone(),
            channels: 2,
        }));
        let mag = [-31.0f32, -30.0, -99.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let peak = [-24.0f32, -23.0, -99.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        unsafe {
            on_updated(slot as *mut _, mag.as_ptr(), peak.as_ptr(), peak.as_ptr());
        }
        let map = sink.lock().unwrap();
        let f = map.get("Mic/Aux").expect("frame stored under the slot key");
        assert_eq!(f.mag, vec![-31.0, -30.0], "reads exactly `channels` values");
        assert_eq!(f.peak, vec![-24.0, -23.0]);
        drop(map);
        unsafe { free_slot(slot) };
    }

    /// A null param must be survivable — libobs calls back during teardown.
    #[test]
    fn null_param_is_a_noop() {
        let v = [0.0f32; 8];
        unsafe {
            on_updated(std::ptr::null_mut(), v.as_ptr(), v.as_ptr(), v.as_ptr());
        }
    }
}
