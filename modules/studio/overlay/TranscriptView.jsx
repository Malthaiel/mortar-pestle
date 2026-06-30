// The transcript surface. While a job runs it shows the live prose READ-ONLY
// (segments stream in, a caret trails the text); once `final` settles it becomes
// an editable textarea so STT slips can be fixed before Copy / Insert. The page
// owns the engine-down / no-model / empty states — this only renders text.
export default function TranscriptView({ text, settled, busy, placeholder, onChange }) {
  const editable = settled && !busy;
  if (editable) {
    return (
      <textarea
        className="stt-transcript stt-transcript-edit"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        spellCheck
        placeholder={placeholder}
        aria-label="Transcript (editable)"
      />
    );
  }
  return (
    <div className="stt-transcript stt-transcript-live" aria-live="polite">
      {text
        ? <span>{text}{busy ? <span className="stt-caret">▍</span> : null}</span>
        : <span className="stt-transcript-empty">{placeholder}</span>}
    </div>
  );
}
