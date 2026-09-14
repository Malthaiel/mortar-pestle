// Job 4 — make the coaching recording from the app, so its audio-track layout is
// ours by construction instead of probed. Every step below is an existing engine op
// riding `broadcast_request` (commands/broadcast.rs:60) — no Rust was added for this.
//
// Why the track pinning is unconditional: `ensure_desktop_audio` / `ensure_mic`
// (mortar-pestle-broadcast engine.rs:1770, :1790) re-stamp their masks on EVERY engine
// boot, so a layout set once on the Live page never survives. Stamping it at record
// time is the only thing that holds.
//
// Track number → ffmpeg stream: `ensure_encoders` (engine.rs:1874) walks the enabled
// RecTracks bits ascending and fills encoder slots in that order, so tracks 1/2/3
// become `0:a:0` / `0:a:1` / `0:a:2`. That reproduces the OBS layout CoachPopup's
// MIC_TRACK / COMMS_TRACK already assume — recordings made before this still work.

/// The engine's own names for the two global audio sources it always creates.
const MIC_SOURCE = 'Mic/Aux';
const DESKTOP_SOURCE = 'Desktop Audio';
/// Application Audio Capture (win-wasapi, OBS 28+). Confirmed present in the payload.
const COMMS_ID = 'wasapi_process_output_capture';
const COMMS_SOURCE = 'Discord';
/// Its `window` property is a `title:class:exe` string, same shape as window capture.
const COMMS_EXE = 'discord.exe';

/// OBS track numbers (1-based). The whole point of Job 4 is that these are FIXED.
export const TRACKS = { mic: 1, desktop: 2, comms: 3 };

const bit = (track) => 1 << (track - 1);
const RECORD_MASK = bit(TRACKS.mic) | bit(TRACKS.desktop) | bit(TRACKS.comms); // 7

/// The scene to record. Matched, never hardcoded — the collection's name carries a
/// non-ASCII dash ("Scrim – Game") that would not survive being retyped.
export function pickScene(snapshot) {
  const scenes = snapshot?.scenes || [];
  const match = scenes.find((s) => /scrim.*game/i.test(s.name || ''));
  return match?.name || snapshot?.current_scene || scenes[0]?.name || null;
}

/// Find a source of `typeId` anywhere in the collection → `{ scene, name }`.
/// Group children are walked too (the `allItems` shape, inlined to keep this module
/// free of a cross-module import for six lines).
export function findSourceByType(snapshot, typeId) {
  for (const scene of snapshot?.scenes || []) {
    for (const item of scene.sources || []) {
      const kids = item.is_group ? item.children || [] : [];
      for (const node of [item, ...kids]) {
        if (node.id === typeId) return { scene: scene.name, name: node.name };
      }
    }
  }
  return null;
}

/// Pick Discord out of a fresh Application-Audio-Capture property list. Values look
/// like `Discord:Chrome_WidgetWin_1:Discord.exe`; only the exe tail is trustworthy
/// (the window title changes with whatever channel is open).
export function pickWindowValue(props, exe = COMMS_EXE) {
  const list = (props || []).find((p) => p.name === 'window');
  const hit = (list?.items || []).find(
    (i) => typeof i.value === 'string' && i.value.toLowerCase().endsWith(exe.toLowerCase()),
  );
  return hit ? hit.value : null;
}

/// Set the recording up and start it. `request(op, args)` is one `broadcast_request`.
/// Returns the file path the engine chose. Throws with a sentence a beginner can act
/// on — every message here is shown verbatim in the popup.
export async function startCoachingRecord(request, { snapshot, stem }) {
  const scene = pickScene(snapshot);
  if (!scene) throw new Error('The Live studio has no screens set up yet — make one there first.');
  await request('set_current_scene', { name: scene });

  // Everyone else's voices need a track of their own, or the writing-out cannot tell
  // them from you. Made once; it persists in the scene collection.
  //
  // It has to live in the scene being recorded, not merely somewhere: a source only
  // sounds while its scene is the current one, so a catcher sitting in another scene
  // would hand back an hour of silence on track 3 — and silence still transcribes,
  // into a half-empty file that reads like a real one.
  const here = findSourceByType({ scenes: (snapshot?.scenes || []).filter((s) => s.name === scene) }, COMMS_ID);
  const elsewhere = here ? null : findSourceByType(snapshot, COMMS_ID);
  let commsName = here?.name || elsewhere?.name;
  if (elsewhere) await request('add_existing', { scene, source_name: elsewhere.name });
  if (!commsName) commsName = await createCommsSource(request, scene);

  await request('set_tracks', { source: MIC_SOURCE, mask: bit(TRACKS.mic) });
  await request('set_tracks', { source: DESKTOP_SOURCE, mask: bit(TRACKS.desktop) });
  await request('set_tracks', { source: commsName, mask: bit(TRACKS.comms) });
  // Tracks the recording actually writes. Rejected while active — we are idle here,
  // and the same call drops stale encoders so the new track count takes effect.
  await request('set_output_settings', { patch: { SimpleOutput: { RecTracks: String(RECORD_MASK) } } });

  const started = await request('start_record', { stem });
  return started?.path || null;
}

/// Create the Discord catcher and point it at Discord. A source that exists but points
/// nowhere would be found by `findSourceByType` on the next press and silently record
/// silence, so a failure to aim it removes it again.
async function createCommsSource(request, scene) {
  const made = await request('create_source', { scene, id: COMMS_ID, name: COMMS_SOURCE });
  const name = made?.name || COMMS_SOURCE;
  try {
    const shown = await request('get_properties', { scene, item: made?.item });
    const value = pickWindowValue(shown?.props);
    if (!value) throw new Error('Discord does not look like it is running. Start it, then press Record again.');
    await request('set_source_settings', { scene, name, settings: { window: value } });
  } catch (e) {
    await request('remove_source', { scene, name }).catch(() => {});
    throw e;
  }
  return name;
}
