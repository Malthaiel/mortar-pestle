import { PrimaryBtn, DangerOutlinedBtn } from '@host/components/ui/Button.jsx';
import { IconDot, IconStop } from '@host/components/icons.jsx';

// Toggle record control: click to start, click to stop (the start/stop dictation
// lifecycle). Idle uses the filled primary candy button; while recording it flips
// to the danger candy button inside a softly pulsing halo (.stt-rec-pulse).
// Push-to-talk via a global keybind is Phase 5 — this is the on-screen control.
export default function RecordButton({ recording, disabled, accent, onToggle }) {
  if (recording) {
    return (
      <span className="stt-rec-pulse">
        <DangerOutlinedBtn small onClick={onToggle} title="Stop recording"><IconStop size="0.7em"/> Stop</DangerOutlinedBtn>
      </span>
    );
  }
  return (
    <PrimaryBtn small accent={accent} onClick={onToggle} disabled={disabled} title="Start recording">
      <IconDot size="0.6em"/> Record
    </PrimaryBtn>
  );
}
