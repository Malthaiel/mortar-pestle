import { useStt } from './SttProvider.jsx';
import { OutlinedBtn } from '@host/components/ui/Button.jsx';
import TranscriptView from './TranscriptView.jsx';
import ControlBar from './ControlBar.jsx';
import './stt.css';

// Composer-bar layout (Voice Transcription Phase 3): a header (title + live
// status), the transcript body (live → editable), an error banner, and the
// bottom control bar. Mirrors the sibling /tools Capture surface. Pure consumer
// of the always-mounted SttProvider.

const ERROR_TEXT = {
  no_input_device: 'No microphone found. Plug one in and try again.',
  device_busy: 'Microphone is busy or unavailable.',
  model_download_failed: 'Model download failed — check your connection.',
  load_failed: 'The speech model failed to load.',
  vad_init_failed: 'Voice detection failed to start.',
};
function friendlyError(err) {
  if (!err) return '';
  return ERROR_TEXT[err.code] || err.message || err.code || 'Something went wrong.';
}

const PLACEHOLDER =
  'Click ● Record to dictate, or ⁂ Transcribe a file. Your transcript appears here — edit it, copy it, or insert it into today’s journal.';

export default function SttPage({ accent }) {
  const {
    engine, engineDown, modelName, model, modelReady, modelLoading,
    recording, fileBusy, text, settled, error, setText, clearError,
    progress, openSettings, downloadModel,
  } = useStt();

  // Header status dot + label.
  let dotColor = 'var(--text-faint)';
  let statusLabel = `loading ${modelName}…`;
  if (engineDown) {
    dotColor = 'var(--error)';
    statusLabel = engine?.message || 'engine unavailable';
  } else if (modelReady) {
    dotColor = accent || 'var(--accent)';
    statusLabel = `${model?.name || modelName}${model?.backend ? ` · ${model.backend}` : ''}`;
  } else if (!modelLoading) {
    dotColor = 'var(--error)';
    statusLabel = 'model unavailable';
  }

  let body;
  if (engineDown) {
    body = (
      <div className="stt-statepanel">
        <div className="stt-statepanel-title">Voice engine unavailable</div>
        <div className="stt-statepanel-sub">
          {engine?.message || 'The transcription engine isn’t running.'} It restarts automatically — check back in a moment.
        </div>
      </div>
    );
  } else if (!modelReady) {
    body = modelLoading ? (
      <div className="stt-statepanel">
        <div className="stt-statepanel-title">{progress != null ? `Downloading ${modelName}…` : 'Loading speech model…'}</div>
        <div className="stt-statepanel-sub">
          {progress != null
            ? `${Math.round(progress)}% — SHA-verified as it downloads.`
            : `${modelName} — your first recording will be ready shortly.`}
        </div>
        {progress != null && (
          <div style={{ marginTop: 12, height: 4, borderRadius: 2, background: 'var(--surface-2)', overflow: 'hidden', maxWidth: 280, marginInline: 'auto' }}>
            <div style={{ width: `${Math.round(progress)}%`, height: '100%', background: accent || 'var(--accent)', transition: 'width 200ms ease' }} />
          </div>
        )}
      </div>
    ) : (
      <div className="stt-statepanel">
        <div className="stt-statepanel-title">No speech model loaded</div>
        <div className="stt-statepanel-sub">
          {error
            ? friendlyError(error)
            : `Download ${modelName} (offline, one-time) to start dictating — or pick a different model in Settings.`}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <OutlinedBtn small onClick={() => downloadModel(modelName)}>Download {modelName}</OutlinedBtn>
          <OutlinedBtn small onClick={openSettings}>Manage models</OutlinedBtn>
        </div>
      </div>
    );
  } else if (settled && !text) {
    body = (
      <div className="stt-statepanel">
        <div className="stt-statepanel-title">No speech detected</div>
        <div className="stt-statepanel-sub">Nothing was transcribed. Try recording again, or transcribe a file.</div>
      </div>
    );
  } else {
    body = (
      <TranscriptView
        text={text}
        settled={settled}
        busy={recording || fileBusy}
        placeholder={PLACEHOLDER}
        onChange={setText}
      />
    );
  }

  return (
    <div className="stt-page">
      <div className="stt-header">
        <div className="stt-title">Voice</div>
        <div style={{ flex: 1 }} />
        <div className="stt-status" title={engine?.message || statusLabel}>
          <span className="stt-dot" style={{ background: dotColor }} />
          <span>{statusLabel}</span>
        </div>
      </div>

      <div className="stt-body">{body}</div>

      {modelReady && error && (
        <div className="stt-errorbar" role="alert">
          <span>{friendlyError(error)}</span>
          <button type="button" className="stt-errorbar-x" onClick={clearError} title="Dismiss">✕</button>
        </div>
      )}

      <ControlBar accent={accent} />
    </div>
  );
}
