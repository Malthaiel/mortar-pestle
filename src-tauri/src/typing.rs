//! Type text into whatever window currently has keyboard focus (Windows).
//!
//! The push-to-talk sink: on `dictation_committed` the app is UNFOCUSED — the
//! foreground window is whatever the user was typing in (a terminal, a browser
//! field, the M&P app itself). `SendInput` with `KEYEVENTF_UNICODE` delivers each
//! UTF-16 code unit as a synthetic keystroke to that focus, exactly as if typed.
//!
//! `KEYEVENTF_UNICODE` carries the character in `wScan` (with `wVk = 0`), so it is
//! layout-independent — no VK mapping, no dead keys, and non-ASCII works. Surrogate
//! pairs need no special handling: each UTF-16 unit is its own event and the target
//! recombines them.
//!
//! No clipboard involvement — the user's copied content is never clobbered.

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
};

/// A key-down + key-up `INPUT` pair per UTF-16 code unit of `text`.
///
/// ponytail: one flat batch, no chunking. A dictation is a sentence or two;
/// SendInput's practical ceiling is far above that. Chunk if a transcript ever
/// gets long enough to hit it.
fn build_inputs(text: &str) -> Vec<INPUT> {
    let mut inputs: Vec<INPUT> = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: Default::default(),
                        wScan: unit,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
    }
    inputs
}

/// Send `text` to the focused window as synthetic keystrokes.
///
/// Returns the number of input events the OS accepted. A short count means a
/// higher-integrity process owns the foreground (an elevated window, or the
/// secure desktop) and silently swallowed the input — UIPI blocks SendInput
/// across integrity levels. Non-fatal: the caller logs and moves on.
pub fn type_text(text: &str) -> usize {
    let inputs = build_inputs(text);
    if inputs.is_empty() {
        return 0;
    }
    // SAFETY: `inputs` is a live, correctly-sized slice of INPUT for the duration
    // of the call, and `size_of::<INPUT>()` is the size the API expects.
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) as usize }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The event vector IS the logic — assert its shape without calling
    /// SendInput (there is no focused window under `cargo test`).
    #[test]
    fn builds_two_unicode_events_per_utf16_unit() {
        let v = build_inputs("hi");
        assert_eq!(v.len(), 4, "2 chars = 2 down + 2 up");
        for (i, inp) in v.iter().enumerate() {
            assert_eq!(inp.r#type, INPUT_KEYBOARD);
            // SAFETY: every event was built with the `ki` union arm.
            let ki = unsafe { inp.Anonymous.ki };
            assert_eq!(ki.wVk, Default::default(), "UNICODE mode requires wVk = 0");
            assert_eq!(ki.wScan, "hi".encode_utf16().nth(i / 2).unwrap());
            assert!(ki.dwFlags.contains(KEYEVENTF_UNICODE));
            // Even index = down (no KEYUP), odd = up.
            assert_eq!(ki.dwFlags.contains(KEYEVENTF_KEYUP), i % 2 == 1);
        }
    }

    /// A non-BMP char is a surrogate PAIR — 2 units, 4 events, sent as-is.
    #[test]
    fn surrogate_pair_emits_four_events() {
        assert_eq!(build_inputs("\u{1F600}").len(), 4);
    }

    /// Empty transcript must not reach SendInput (it rejects a zero-length array).
    #[test]
    fn empty_text_sends_nothing() {
        assert!(build_inputs("").is_empty());
        assert_eq!(type_text(""), 0);
    }
}
