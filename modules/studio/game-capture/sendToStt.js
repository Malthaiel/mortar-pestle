// "Transcribe" for a captured clip — hand a clip's absolute path to the STT
// module (Voice Transcription Phase 3). The capture module can't reach into the
// STT provider's state across the route boundary, so it emits the path on the
// shared module event bus (SttProvider subscribes to 'stt:transcribe-file' and
// kicks off stt_transcribe_file) and navigates to /tools/stt to show progress.
// Mirrors sendToEditor.js's cross-module hand-off shape.

export function sendToStt({ api, path }) {
  if (!path) throw new Error('no clip path');
  api.events.emit('stt:transcribe-file', { path });
  api.router.navigate('/tools/stt');
}
