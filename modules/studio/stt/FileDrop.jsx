// Click-to-open file affordance. WebKitGTK has NO working HTML5 drag-and-drop
// (see the no-HTML5-DnD constraint), so this is a click target that opens the
// native file dialog — no `draggable`, no onDrop reading dataTransfer.files. The
// provider owns the dialog + the transcribe kickoff (pickFile).
export default function FileDrop({ onPick, disabled }) {
  return (
    <button
      type="button"
      className="stt-filedrop candy-btn"
      data-shape="chip"
      data-own-press
      onClick={disabled ? undefined : onPick}
      disabled={disabled}
      title="Transcribe an audio or video file"
    >
      <span className="candy-face">⁂ Transcribe a file…</span>
    </button>
  );
}
