// SF6 of Design Mode plan — message input for Atelier chat. Single textarea,
// Enter sends, Shift+Enter newlines, disabled while streaming. The mention
// chip + send-button area is laid out so SF8 (Markup mode) can drop
// `@ComponentName` chips into the slot above the textarea without
// re-wrapping any of this code.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { invoke } from '../../api.js';

import { IconSend, IconMic } from '../icons.jsx';
import CandySelect from '../ui/CandySelect.jsx';
import { ChipIconBtn } from '../planner/ItemChips.jsx';

// Icon-button height, matched to the chip-field's own ONE-LINE painted height so
// the fused run reads level — the Planner gets this from its --planner-btn-h
// scope, which does not reach this window. 32px is MEASURED off the live chip
// (photographed 2026-09-13: field 32 painted rows, button 28), not derived: the
// field's height comes from the autosize effect below, so it grows past this on
// a multi-line message and the buttons stay centred on it, which is the intent.
// Re-measure here if chip-field's face padding or font metrics move.
export const CHAT_BTN_SIZE = '32px';
const BTN_SIZE = CHAT_BTN_SIZE;
// Clearance above the control run; the bottom adds the candy band on top (below).
const BAR_PAD = 8;
// Shortest gap between mic toggles the engine can survive — see useDictation § 3.
const SETTLE_MS = 1400;

// Model picker — the SAME three values Settings > Agents > Model writes
// (AgentsTab GeneralPanel), driving the SAME settings.agents.model key, so the
// two surfaces can never disagree. Kept here, not re-derived per agent.
const MODELS = [
  { value: 'opus',   label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku',  label: 'Haiku' },
];
export default function ChatInput({ onSend, streaming, accent, mentions = [], onClearMention, seedText, seedNonce = 0, onSeedConsumed, placeholder = 'Ask', busyPlaceholder = 'Thinking', leading = null, settings, setSetting }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  const model = settings?.agents?.model || 'opus';
  const { dictating, toggleDictation } = useDictation(settings, setText);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [text]);

  // SF5 — seed from an external prefill ("Ask Concierge" on a text selection).
  // Keyed on the nonce so re-asking re-seeds even with identical text; appends
  // below any in-progress text, then focuses with the cursor at the end. One-shot:
  // onSeedConsumed clears the provider seed so a later reopen can't re-inject it.
  useEffect(() => {
    if (!seedText) return;
    setText((prev) => (prev.trim() ? prev.replace(/\s+$/, '') + '\n\n' + seedText + '\n\n' : seedText + '\n\n'));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const n = el.value.length;
      try { el.setSelectionRange(n, n); } catch (e) {}
    });
    onSeedConsumed && onSeedConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);

  const canSend = text.trim().length > 0 && !streaming;
  const submit = () => {
    if (!canSend) return;
    const payload = mentions.length > 0
      ? mentions.map(m => m.source ? `@${m.name} (${m.source})` : `@${m.name}`).join(' ') + '\n' + text.trim()
      : text.trim();
    onSend(payload);
    setText('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      data-aos-no-mark
      data-aos-chat-input
      style={{
        // The candy band paints BELOW each control's border box (box-shadow
        // `0 var(--cbtn-depth) 0`), so equal padding leaves the run reading low:
        // measured 8px clear above the painted mass and 5px below it. ONE knob,
        // and the bottom pays for the band, so the two painted gaps cannot drift
        // apart. (Overrides the padding in styles.css § .aos-chat-window.)
        padding: `${BAR_PAD}px 10px calc(${BAR_PAD}px + var(--candy-depth-small))`,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      {mentions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {mentions.map((m) => (
            <MentionChip key={m.id} mention={m} accent={accent} onClear={() => onClearMention?.(m.id)}/>
          ))}
        </div>
      )}
      {/* ONE fused row (user-directed 2026-09-13): file at the far left, the
          message box taking the slack, model / mic / send at the far right —
          a single `.candy-split`, so the whole bar reads as one candy shape with
          straight dividers, exactly like a Planner TaskChip row (ItemChips.jsx).
          The box itself IS a candy button: chip-field + .candy-face + a bare
          .chip-field-input, here a <textarea>.

          --cbtn-size on the run keeps every control the same height as the box:
          the Planner gets that from its --planner-btn-h scope, which does not
          reach this window. position:relative because CandySelect's fused
          variant anchors its absolute menu to the run. */}
      <div
        className="candy-split"
        style={{ display: 'flex', alignItems: 'center', width: '100%', position: 'relative', '--cbtn-size': BTN_SIZE }}
      >
        {leading}
        <span className="candy-btn" data-shape="chip-field" style={{ flex: 1 }}>
          <span className="candy-face">
            <textarea
              ref={ref}
              className="chip-field-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={streaming ? busyPlaceholder : placeholder}
              disabled={streaming}
              rows={1}
              style={{
                resize: 'none',
                scrollbarWidth: 'none',   // user-directed: still scrolls past 140px, just no visible strip
                opacity: streaming ? 0.7 : 1,
              }}
            />
          </span>
        </span>
        <CandySelect
          fuse
          direction="up"
          chevron={false}
          title="Model"
          value={model}
          options={MODELS}
          onChange={(v) => setSetting && setSetting('agents', { model: v })}
        />
        <ChipIconBtn
          title={dictating ? 'Stop dictating' : 'Dictate a message'}
          active={dictating}
          size={BTN_SIZE}
          onClick={toggleDictation}
        ><IconMic size={13}/></ChipIconBtn>
        {/* NOT `disabled` (user-directed 2026-09-13): the house .candy-btn:disabled
            is opacity .55, which on this dark theme all but erased the button in
            its resting state. It stays fully painted and simply does nothing —
            submit() already no-ops unless canSend. */}
        <ChipIconBtn
          title={canSend ? 'Send' : 'Type a message'}
          size={BTN_SIZE}
          onClick={submit}
        ><IconSend size={13}/></ChipIconBtn>
      </div>
    </div>
  );
}

// Click-on / click-off dictation into the message box (user-directed 2026-09-13).
// Same backend surface the Studio overlay + SttDevPanel drive — stt_start_dictation
// with a Channel, stt_stop_dictation to end it — so there is no second STT path:
// 'segment' carries interim text, 'final' is the terminal flush on stop, 'done' is
// always last. Text is APPENDED to whatever is already typed and left for editing;
// it never sends on its own.
function useDictation(settings, setText) {
  const [dictating, setDictating] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    // Set true in the BODY, not just at useRef(true): React StrictMode mounts,
    // unmounts and remounts every component once in dev, and that first cleanup
    // latched this false forever — so EVERY channel event was dropped, the mic
    // never cleared and no transcript ever reached the box (2026-09-13).
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // Never leave the mic hot behind a closed window.
      invoke('stt_stop_dictation').catch(() => {});
    };
  }, []);

  const append = useCallback((chunk) => {
    const t = (chunk || '').trim();
    if (!t) return;
    setText((prev) => (prev.trim() ? prev.replace(/\s+$/, '') + ' ' + t : t));
  }, [setText]);

  // HOLD MODE. The backend ends a run BY ITSELF the moment you pause (VAD + a
  // ~300ms hangover) — traced 2026-09-13: on at 100ms, off at 700ms after one
  // phrase. Click-on / click-off therefore has to RE-ARM on every `done`, which
  // is only safe with BOTH guards below; a naive version jammed the engine into
  // `stt engine error [busy]: dictation already running`, a state that survived
  // stt_stop_dictation, stt_cancel AND stt_unload and needed an app restart.
  //
  //   1. GENERATION — every toggle bumps genRef. A run whose gen is stale is
  //      ignored whole, so a `done` racing in after stop can never re-arm.
  //   2. SWEEP — a start issued microseconds before stop lands AFTER it, leaving
  //      an ORPHAN run nothing owns. Stop is re-sent on a short delay to kill it.
  const wantOnRef = useRef(false);
  const genRef = useRef(0);
  const lastToggleRef = useRef(0);
  // 3. SETTLE — the engine needs a beat to ARM a run, and `stt_stop_dictation`
  //    sent before it arms is a no-op, so the start survives the stop as an
  //    orphan. Guards 1 and 2 keep the UI honest but cannot cancel a start that
  //    has not landed yet; the only reachable way to hit that window is clicking
  //    faster than the engine arms, so clicks inside it are IGNORED. Measured:
  //    8 rapid toggles jammed the engine even with 1 + 2 in place (2026-09-13).

  const stopAll = useCallback(() => {
    genRef.current += 1;
    wantOnRef.current = false;
    invoke('stt_stop_dictation').catch(() => {});
    // Sweep an in-flight start. Two passes: the backend takes a beat to arm.
    setTimeout(() => invoke('stt_stop_dictation').catch(() => {}), 400);
    setTimeout(() => invoke('stt_stop_dictation').catch(() => {}), 1200);
  }, []);

  const startRun = useCallback((gen) => {
    let sawSegment = false;
    const ch = new Channel();
    ch.onmessage = (ev) => {
      if (!aliveRef.current || gen !== genRef.current) return;   // stale run — ignore whole
      if (ev.kind === 'segment') { sawSegment = true; append(ev.text); }
      // `final` repeats the text of the segments it closes, so appending both
      // doubles every utterance; it only fills in when a run produced none.
      else if (ev.kind === 'final') { if (!sawSegment) append(ev.text); }
      else if (ev.kind === 'error') { wantOnRef.current = false; setDictating(false); }
      else if (ev.kind === 'done') {
        if (wantOnRef.current) startRun(gen);
        else setDictating(false);
      }
    };
    invoke('stt_start_dictation', {
      model: settings?.stt?.defaultModel || 'small.en',
      onEvent: ch,
    })
      .then(() => { if (gen !== genRef.current || !wantOnRef.current) invoke('stt_stop_dictation').catch(() => {}); })
      .catch((e) => {
        // Never swallow this: "[busy]: dictation already running" is the one
        // failure that looks exactly like "the button does nothing".
        console.error('[chat] dictation failed to start', e);
        wantOnRef.current = false;
        if (aliveRef.current) setDictating(false);
      });
  }, [settings, append]);

  useEffect(() => () => { genRef.current += 1; wantOnRef.current = false; }, []);

  return {
    dictating,
    toggleDictation: useCallback(() => {
      const now = Date.now();
      if (now - lastToggleRef.current < SETTLE_MS) return;
      lastToggleRef.current = now;
      if (dictating) {
        stopAll();
        setDictating(false);   // the run has usually already self-ended and will emit nothing
        return;
      }
      const gen = (genRef.current += 1);
      wantOnRef.current = true;
      setDictating(true);
      startRun(gen);
    }, [dictating, startRun, stopAll]),
  };
}

function MentionChip({ mention, accent, onClear }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 4px 2px 8px',
      background: `color-mix(in oklch, ${accent || 'var(--text)'} 12%, transparent)`,
      border: `1px solid color-mix(in oklch, ${accent || 'var(--text)'} 24%, transparent)`,
      borderRadius: 999,
      fontSize: 11, fontWeight: 600,
      color: accent || 'var(--text)',
      fontFamily: 'var(--font-mono)',
    }}>
      @{mention.name}
      <button
        type="button"
        onClick={onClear}
        title="Drop mention"
        style={{
          width: 14, height: 14, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none',
          color: 'inherit', cursor: 'pointer', opacity: 0.6,
          fontFamily: 'inherit', fontSize: 12, lineHeight: 1,
          padding: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = 0.6; }}
      >×</button>
    </span>
  );
}
