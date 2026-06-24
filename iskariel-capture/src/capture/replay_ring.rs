//! In-RAM instant-replay ring (Phase 2) — the encoded-packet side.
//!
//! A bounded, GOP-aligned, refcounted ring of encoded H.264 packets. While the
//! engine is *armed*, the capture thread appends every NVENC packet via
//! [`ReplayRing::push`]; the head is evicted in WHOLE GOPs so it is always an IDR
//! (the OBS/ShadowPlay prune model — a saved clip can only begin at a keyframe).
//! On save, [`ReplayRing::snapshot`] walks back from the live tail to the IDR
//! at-or-before `tail − window`, cloning the packet `Arc` handles (a refcount bump,
//! zero byte-copy) so a save thread can stream them into ffmpeg while the ring keeps
//! rolling — evicted bytes stay alive until both the ring and the in-flight snapshot
//! drop them. Audio is a separate side-ring ([`super::audio`]); this is video-only.
//!
//! The ring lives thread-local (`Rc<RefCell<ReplayRing>>`) on the capture thread, so
//! the hot path (`push`) takes no locks. The only thing that crosses to the save
//! thread is a [`RingSnapshot`] — an owned `Vec<Arc<Vec<u8>>>`, which is `Send`.
//!
//! Bounds: the ring is capped by BOTH bytes (the RAM ceiling, ≈ bitrate × seconds)
//! and wall-seconds (the user's replay length). Either bound being exceeded evicts
//! whole GOPs from the head; the final live GOP is never evicted, so a ring whose
//! single GOP exceeds a cap simply holds that one GOP.

// The ring is wired into the capture loop in R1 (encode-on-arm) and read by the
// save path in R3 (save_replay); until then its API is dead in non-test builds.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::Arc;

/// One encoded video packet retained in the ring. `data` is `Arc`-wrapped so a save
/// snapshot is a refcount bump rather than a copy, and the Annex-B bytes outlive
/// head eviction until every in-flight snapshot has also dropped them.
#[derive(Clone)]
pub struct RingPacket {
    /// Annex-B elementary-stream bytes (an IDR packet carries inline SPS/PPS).
    pub data: Arc<Vec<u8>>,
    /// Raw `CLOCK_MONOTONIC` ns of the packet — the same clock domain as the audio
    /// ring anchors, so the save-time audio cut co-registers (see `capture/mod.rs`).
    pub monotonic_pts_ns: i64,
    /// The CFR pacer index this packet was encoded at (R3 contiguity diagnostics).
    pub cfr_index: u64,
    /// True for an IDR keyframe — a GOP boundary and a legal clip start.
    pub idr: bool,
}

/// An owned, refcounted view of a save window — `Send`, so it moves to the save
/// thread. `packets` are in stream order starting at an IDR; `t0_ns`/`t_end_ns`
/// bound the matching audio cut.
pub struct RingSnapshot {
    pub packets: Vec<Arc<Vec<u8>>>,
    pub t0_ns: i64,
    pub t_end_ns: i64,
}

/// A bounded ring of encoded packets with whole-GOP head eviction.
pub struct ReplayRing {
    packets: VecDeque<RingPacket>,
    bytes: usize,
    cap_bytes: usize,
    cap_ns: i64,
}

impl ReplayRing {
    /// `cap_bytes` is the hard RAM ceiling; `cap_secs` is the wall window. Either
    /// exceeded triggers whole-GOP head eviction.
    pub fn new(cap_bytes: usize, cap_secs: u32) -> Self {
        Self {
            packets: VecDeque::new(),
            bytes: 0,
            cap_bytes,
            cap_ns: cap_secs as i64 * 1_000_000_000,
        }
    }

    /// Live retained byte count — the source for the Settings RAM readout.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Wall span currently retained (newest − oldest pts), or 0 if empty.
    pub fn span_ns(&self) -> i64 {
        match (self.packets.front(), self.packets.back()) {
            (Some(f), Some(b)) => b.monotonic_pts_ns - f.monotonic_pts_ns,
            _ => 0,
        }
    }

    pub fn len(&self) -> usize {
        self.packets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.packets.is_empty()
    }

    /// Append one encoded packet (the encoder's `Vec<u8>` is moved into an `Arc` —
    /// one alloc, no copy), then evict whole head GOPs until both caps hold. A
    /// non-IDR packet into an empty ring is dropped: a ring must seed on a keyframe
    /// (the encoder is IDR-first, so this only guards a degenerate stream).
    pub fn push(&mut self, data: Vec<u8>, monotonic_pts_ns: i64, cfr_index: u64, idr: bool) {
        if self.packets.is_empty() && !idr {
            return;
        }
        self.bytes += data.len();
        self.packets.push_back(RingPacket {
            data: Arc::new(data),
            monotonic_pts_ns,
            cfr_index,
            idr,
        });
        self.evict();
    }

    /// Evict whole GOPs from the head while EITHER cap is exceeded, keeping the head
    /// an IDR. A GOP is an IDR plus the run of non-IDR packets up to the next IDR.
    /// The final GOP is never evicted (a single oversized GOP is kept as-is).
    fn evict(&mut self) {
        while self.bytes > self.cap_bytes || self.span_ns() > self.cap_ns {
            // Index of the start of the SECOND GOP (the next IDR after the head).
            let next_idr = self
                .packets
                .iter()
                .enumerate()
                .skip(1)
                .find(|(_, p)| p.idr)
                .map(|(i, _)| i);
            let Some(boundary) = next_idr else { break };
            for _ in 0..boundary {
                if let Some(p) = self.packets.pop_front() {
                    self.bytes -= p.data.len();
                }
            }
        }
    }

    /// Snapshot the last `window_secs` (or the whole ring if `None`) for a save:
    /// pick the latest IDR with `pts <= tail − window` (falling back to the head IDR
    /// when the window exceeds the ring), and clone the packet handles from there to
    /// the tail. `None` only if the ring is empty.
    pub fn snapshot(&self, window_secs: Option<u32>) -> Option<RingSnapshot> {
        let t_end = self.packets.back()?.monotonic_pts_ns;
        let want_start = match window_secs {
            Some(s) => t_end - s as i64 * 1_000_000_000,
            None => i64::MIN,
        };
        // Latest IDR at-or-before want_start; default the head (always an IDR).
        let mut start = 0usize;
        for (i, p) in self.packets.iter().enumerate() {
            if p.idr && p.monotonic_pts_ns <= want_start {
                start = i;
            }
        }
        debug_assert!(self.packets[start].idr, "snapshot must begin on an IDR");
        let packets = self
            .packets
            .iter()
            .skip(start)
            .map(|p| p.data.clone())
            .collect();
        Some(RingSnapshot {
            packets,
            t0_ns: self.packets[start].monotonic_pts_ns,
            t_end_ns: t_end,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEC: i64 = 1_000_000_000;
    const FRAME: i64 = SEC / 60;
    /// A 2 s GOP at 60 fps (1 IDR + 119 P-frames), matching the keyint-2s contract.
    const GOP_FRAMES: u64 = 120;

    /// Push a GOP: one IDR then `p_frames` P-frames, each `bytes_each` bytes, the IDR
    /// at `base_ns`, frames one 60 fps tick apart. Returns the next GOP's IDR ts.
    fn push_gop(
        ring: &mut ReplayRing,
        base_ns: i64,
        start_cfr: u64,
        p_frames: u64,
        bytes_each: usize,
    ) -> i64 {
        ring.push(vec![0u8; bytes_each], base_ns, start_cfr, true);
        for i in 1..=p_frames {
            ring.push(
                vec![0u8; bytes_each],
                base_ns + i as i64 * FRAME,
                start_cfr + i,
                false,
            );
        }
        base_ns + GOP_FRAMES as i64 * FRAME
    }

    #[test]
    fn head_is_idr_after_eviction() {
        let bytes_each = 1000;
        let cap_bytes = 3 * GOP_FRAMES as usize * bytes_each; // ~3 GOPs
        let mut ring = ReplayRing::new(cap_bytes, 3600); // loose sec cap
        let (mut base, mut cfr) = (1_000_000_000, 0);
        for _ in 0..10 {
            base = push_gop(&mut ring, base, cfr, GOP_FRAMES - 1, bytes_each);
            cfr += GOP_FRAMES;
        }
        assert!(!ring.is_empty());
        assert!(ring.packets.front().unwrap().idr, "head must be an IDR");
        assert!(ring.bytes() <= cap_bytes, "bytes {} > cap {}", ring.bytes(), cap_bytes);
    }

    #[test]
    fn byte_cap_respected() {
        let bytes_each = 500;
        let cap_bytes = 5 * GOP_FRAMES as usize * bytes_each; // ~5 GOPs
        let mut ring = ReplayRing::new(cap_bytes, 3600);
        let (mut base, mut cfr) = (0, 0);
        for _ in 0..40 {
            base = push_gop(&mut ring, base, cfr, GOP_FRAMES - 1, bytes_each);
            cfr += GOP_FRAMES;
        }
        assert!(ring.bytes() <= cap_bytes, "bytes {} > cap {}", ring.bytes(), cap_bytes);
        assert!(ring.len() >= 3 * GOP_FRAMES as usize, "kept too little: {}", ring.len());
    }

    #[test]
    fn sec_cap_respected() {
        let mut ring = ReplayRing::new(usize::MAX, 4); // 4 s window, loose byte cap
        let (mut base, mut cfr) = (10 * SEC, 0);
        for _ in 0..10 {
            base = push_gop(&mut ring, base, cfr, GOP_FRAMES - 1, 100); // 20 s total
            cfr += GOP_FRAMES;
        }
        // Whole-GOP eviction → span within the cap + at most one 2 s GOP of slop.
        assert!(ring.span_ns() <= 4 * SEC + 2 * SEC, "span {} ns too large", ring.span_ns());
        assert!(ring.span_ns() >= 2 * SEC, "should retain multiple GOPs");
        assert!(ring.packets.front().unwrap().idr);
    }

    #[test]
    fn snapshot_full_window() {
        let mut ring = ReplayRing::new(usize::MAX, 3600);
        let (mut base, mut cfr) = (0, 0);
        for _ in 0..3 {
            base = push_gop(&mut ring, base, cfr, GOP_FRAMES - 1, 100);
            cfr += GOP_FRAMES;
        }
        let snap = ring.snapshot(None).unwrap();
        assert_eq!(snap.packets.len(), ring.len());
        assert_eq!(snap.t0_ns, ring.packets.front().unwrap().monotonic_pts_ns);
        assert_eq!(snap.t_end_ns, ring.packets.back().unwrap().monotonic_pts_ns);
    }

    #[test]
    fn snapshot_window_starts_at_idr_at_or_before() {
        let mut ring = ReplayRing::new(usize::MAX, 3600);
        let (mut base, mut cfr) = (0, 0);
        let mut idr_ts = vec![];
        for _ in 0..5 {
            idr_ts.push(base);
            base = push_gop(&mut ring, base, cfr, GOP_FRAMES - 1, 100);
            cfr += GOP_FRAMES;
        }
        let t_end = ring.packets.back().unwrap().monotonic_pts_ns;
        let snap = ring.snapshot(Some(3)).unwrap(); // last 3 s
        let want_start = t_end - 3 * SEC;
        let expected = *idr_ts.iter().filter(|&&t| t <= want_start).max().unwrap();
        assert_eq!(snap.t0_ns, expected, "must start at the latest IDR ≤ want_start");
        assert_eq!(snap.t_end_ns, t_end);
    }

    #[test]
    fn snapshot_window_larger_than_ring_returns_all() {
        let mut ring = ReplayRing::new(usize::MAX, 3600);
        let (mut base, mut cfr) = (0, 0);
        for _ in 0..2 {
            base = push_gop(&mut ring, base, cfr, GOP_FRAMES - 1, 100);
            cfr += GOP_FRAMES;
        }
        let snap = ring.snapshot(Some(600)).unwrap(); // 10 min window, ring has ~4 s
        assert_eq!(snap.packets.len(), ring.len());
        assert_eq!(snap.t0_ns, ring.packets.front().unwrap().monotonic_pts_ns);
    }

    #[test]
    fn empty_ring_seeds_on_idr_only() {
        let mut ring = ReplayRing::new(usize::MAX, 3600);
        ring.push(vec![0u8; 100], 0, 0, false); // non-IDR into empty → dropped
        assert!(ring.is_empty());
        ring.push(vec![0u8; 100], FRAME, 1, true); // IDR seeds
        assert_eq!(ring.len(), 1);
        assert!(ring.packets.front().unwrap().idr);
    }
}
