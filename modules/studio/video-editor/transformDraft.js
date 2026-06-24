// Live transform draft (Compositing & Titles SF6) — mirrors color's gradeDraft.
// During an on-preview handle gesture the draft overrides the committed clip
// transform so the GL loop previews it per tick with NO React render; the
// gesture commits ONE setClipTransform op on release and clears the draft. A
// module singleton (not state) for the same reason gradeDraft is: the mount-once
// GL loop reads it every frame without re-subscribing.
export const xformDraft = { clipId: null, transform: null };

export function setXformDraft(clipId, transform) {
  xformDraft.clipId = clipId;
  xformDraft.transform = transform;
}

export function clearXformDraft() {
  xformDraft.clipId = null;
  xformDraft.transform = null;
}
