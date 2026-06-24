// colorimetry — the ONE place preview and export resolve a media entry's
// YUV↔RGB conversion (Color Grading SF2). WebKit picks a matrix from the
// container's colorimetry tags when it uploads video to WebGL; ffmpeg picks
// its own when lut3d forces RGB. Parity demands both choose identically, so:
//   tagged sources  → map the tag (601-family strings → bt601),
//   untagged sources → the browser heuristic: HD (≥720 lines) → bt709,
//                      SD → bt601.
// Range defaults tv (limited) unless the source is tagged pc — matching both
// WebKit's and swscale's untagged assumption. Rec.709 end-to-end stance:
// exotic tags (bt2020 etc.) resolve to bt709 — wide gamut is explicitly out
// of scope this phase, and a wrong-but-consistent matrix still previews
// exactly what exports.
//
// Media entries store probe tags as colorSpace/colorPrimaries/colorTransfer/
// colorRange (importQueue); entries imported before SF2 lack the fields and
// take the heuristic from their stored dimensions.

const BT601_TAGS = new Set(['smpte170m', 'bt470bg', 'bt601']);

// → { matrix: 'bt709' | 'bt601', range: 'tv' | 'pc' } — the exact strings
// ffmpeg's scale in_color_matrix/in_range options accept.
export function resolveColorimetry(media) {
  const tag = media?.colorSpace || null;
  let matrix;
  if (tag && BT601_TAGS.has(tag)) matrix = 'bt601';
  else if (tag) matrix = 'bt709';
  else matrix = (media?.height || 0) >= 720 ? 'bt709' : 'bt601';
  return {
    matrix,
    range: media?.colorRange === 'pc' ? 'pc' : 'tv',
  };
}
