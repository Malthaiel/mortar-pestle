import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { useStt } from './SttProvider.jsx';
import RecordButton from './RecordButton.jsx';
import VuMeter from './VuMeter.jsx';
import FileDrop from './FileDrop.jsx';

// The composer-style control bar: record + level meter + file + copy + insert.
// While a file transcribes, the meter slot becomes a progress bar and the file
// chip becomes a Cancel button. Pure consumer of the STT context.
export default function ControlBar({ accent }) {
  const {
    recording, fileBusy, vu, progress, text, engineDown, modelReady,
    toggleDictation, pickFile, cancel, copy, insertToNote,
  } = useStt();
  const hasText = !!(text && text.trim());

  return (
    <div className="stt-controlbar">
      {/* Text/aria fallback for the (aria-hidden) level meter: announces the
          recording / transcribing state to screen readers, incl. a hotkey-started
          session the user can't see the button for. */}
      <span className="stt-sr-only" role="status">
        {recording ? 'Recording' : fileBusy ? 'Transcribing audio' : ''}
      </span>
      <RecordButton
        recording={recording}
        disabled={engineDown || !modelReady || fileBusy}
        accent={accent}
        onToggle={toggleDictation}
      />

      <div className="stt-controlbar-meter">
        {fileBusy ? (
          <div className="stt-progress" title={`Transcribing… ${Math.round(progress ?? 0)}%`}>
            <div
              className="stt-progress-fill"
              style={{ width: `${Math.round(progress ?? 0)}%`, background: accent || 'var(--accent)' }}
            />
          </div>
        ) : (
          <VuMeter rms={vu} active={recording} accent={accent} />
        )}
      </div>

      {fileBusy ? (
        <OutlinedBtn small onClick={cancel} title="Cancel transcription">Cancel</OutlinedBtn>
      ) : (
        <FileDrop onPick={pickFile} disabled={recording} />
      )}

      <OutlinedBtn small onClick={copy} disabled={!hasText} title="Copy transcript">Copy</OutlinedBtn>
      <PrimaryBtn small accent={accent} onClick={insertToNote} disabled={!hasText} title="Insert into today’s daily log">
        Insert → note
      </PrimaryBtn>
    </div>
  );
}
