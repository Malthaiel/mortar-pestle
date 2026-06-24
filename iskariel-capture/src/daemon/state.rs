//! The daemon's authoritative engine state (control thread). The snapshot
//! projection is the sole source of UI truth (Complete Phase 1 plan, §3.2).
#![allow(dead_code)] // in-progress scaffold: the socket loop + record loop mutate this next.

use crate::daemon::protocol::{
    Capabilities, CaptureConfig, HotkeysSnapshot, ProtoError, StateSnapshot,
};

/// Engine lifecycle. BUILD-PER-CLIP (locked, plan §9.1): `Recording` holds the
/// clip's monotonic start anchor so `elapsed_ns` derives from the clock, never
/// from a recomputed wall time. The transient `Starting`/`Finalizing` states
/// make stop-before-started and async-mux-after-stop races safe. Phase 2 adds
/// `Armed` additively (the ring) — do not collapse these variants.
#[derive(Debug, Clone)]
pub enum EngineState {
    Idle,
    Starting,
    Recording {
        game: String,
        started_at_unix_ms: u64,
        started_at_mono_ns: u64,
        clip_tmp_path: String,
    },
    /// Phase 2: the replay ring is armed (encode running, ring filling). `recording`
    /// is true when a manual recording is teed alongside the ring (the full tee).
    Armed {
        game: String,
        since_unix_ms: u64,
        since_mono_ns: u64,
        recording: bool,
    },
    Finalizing,
    Error(ProtoError),
}

impl EngineState {
    fn label(&self) -> &'static str {
        match self {
            EngineState::Idle => "idle",
            EngineState::Starting => "starting",
            EngineState::Recording { .. } => "recording",
            EngineState::Armed { .. } => "armed",
            EngineState::Finalizing => "finalizing",
            EngineState::Error(_) => "error",
        }
    }
}

/// Owns the dynamic state + the static config/hotkeys for snapshot projection.
pub struct Engine {
    pub state: EngineState,
    pub config: CaptureConfig,
    pub hotkeys: HotkeysSnapshot,
}

impl Engine {
    pub fn new(config: CaptureConfig) -> Self {
        Self {
            state: EngineState::Idle,
            config,
            hotkeys: HotkeysSnapshot {
                bound: false,
                portal_version: 1,
                can_configure: false,
                shortcuts: Vec::new(),
                last_error: None,
            },
        }
    }

    /// Project the authoritative state into the wire snapshot. `now_mono_ns` is
    /// the caller's current CLOCK_MONOTONIC reading, so `elapsed_ns` derives from
    /// the clock — correct even after the UI was dead for minutes.
    pub fn snapshot(&self, now_mono_ns: u64) -> StateSnapshot {
        let (recording, armed, game, started_at_unix_ms, elapsed_ns, last_error) = match &self.state {
            EngineState::Recording { game, started_at_unix_ms, started_at_mono_ns, .. } => (
                true,
                false,
                Some(game.clone()),
                *started_at_unix_ms,
                now_mono_ns.saturating_sub(*started_at_mono_ns),
                None,
            ),
            EngineState::Armed { game, since_unix_ms, since_mono_ns, recording } => (
                *recording,
                true,
                Some(game.clone()),
                *since_unix_ms,
                now_mono_ns.saturating_sub(*since_mono_ns),
                None,
            ),
            EngineState::Error(e) => (false, false, None, 0, 0, Some(e.clone())),
            _ => (false, false, None, 0, 0, None),
        };
        StateSnapshot {
            version: 1,
            recording,
            state: self.state.label().into(),
            game,
            started_at_unix_ms,
            elapsed_ns,
            codec: self.config.codec.clone(),
            bitrate_bps: self.config.bitrate_mbps as u64 * 1_000_000,
            gop_len: self.config.keyint_sec * 60,
            fps_num: 60,
            fps_den: 1,
            hotkeys: self.hotkeys.clone(),
            config: self.config.clone(),
            last_error,
            capabilities: Capabilities { screenshot: true, save_replay: true, arm: true },
            armed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gate (c): `elapsed_ns` derives from the clock anchor, so a snapshot taken
    /// after the UI was dead for N seconds reports N — and `started_at_unix_ms`
    /// never moves. No capture involved; this is the autonomously-testable core.
    #[test]
    fn snapshot_elapsed_derives_from_mono_anchor() {
        const S: u64 = 1_000_000_000; // 1 second in ns.
        let anchor_mono = 5_000 * S; // arbitrary CLOCK_MONOTONIC reading.
        let started_unix_ms = 1_700_000_000_123u64;

        let mut engine = Engine::new(CaptureConfig::default());
        engine.state = EngineState::Recording {
            game: "Deadlock".into(),
            started_at_unix_ms: started_unix_ms,
            started_at_mono_ns: anchor_mono,
            clip_tmp_path: "/tmp/iskariel-capture/clip.tmp".into(),
        };

        // +5s after the anchor.
        let snap5 = engine.snapshot(anchor_mono + 5 * S);
        assert!(snap5.recording);
        assert_eq!(snap5.state, "recording");
        assert_eq!(snap5.elapsed_ns, 5 * S, "elapsed must be exactly 5s");
        assert_eq!(snap5.started_at_unix_ms, started_unix_ms, "start time is stable");
        assert_eq!(snap5.game.as_deref(), Some("Deadlock"));

        // +10s: elapsed grows, started_at unchanged.
        let snap10 = engine.snapshot(anchor_mono + 10 * S);
        assert_eq!(snap10.elapsed_ns, 10 * S, "elapsed must grow to 10s");
        assert!(snap10.elapsed_ns > snap5.elapsed_ns);
        assert_eq!(snap10.started_at_unix_ms, started_unix_ms, "start time still stable");

        // A `now` earlier than the anchor saturates to 0, never panics/underflows.
        let snap_stale = engine.snapshot(anchor_mono - S);
        assert_eq!(snap_stale.elapsed_ns, 0, "saturating_sub guards a stale clock");
    }
}
