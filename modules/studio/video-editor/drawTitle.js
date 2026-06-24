// drawTitle — the ONE canvas-2D title renderer, used by BOTH paths so they share
// pixels by construction (Compositing & Titles SF10):
//   preview  PreviewPlayer → useTitleLayers caches drawTitle(model, 1) and feeds
//            the canvas to glDisplay.renderComposite as a layer `el`.
//   export   ExportDialog rasterizes drawTitle(model, 1) → PNG bytes →
//            materialize_titles writes a temp the filtergraph loops (-loop 1).
// One renderer in both paths = inherent preview↔export parity, zero deps.
//
// The canvas is sized to the TIGHT text box (measured text + stroke/shadow/
// lower-third-background padding), so the returned canvas's width/height ARE the
// layer's source pixel dims. Because the text is authored in SEQUENCE pixels, the
// box maps 1:1 into the sequence (fit=1 in computeLayerQuad / layer_geom — NOT
// the aspect-fit-fill a video layer gets); a default identity transform centers
// the box in the frame. `scale` multiplies all model sizes (1 = sequence-res, the
// value both shipping paths pass; the parity battery may pass a screen scale).

const fontString = (m, scale) => {
  const parts = [];
  if (m.italic) parts.push('italic');
  if (m.bold) parts.push('bold');
  parts.push(`${Math.max(1, (m.size || 96) * scale)}px`);
  parts.push(`"${m.font || 'Segoe UI'}"`);
  return parts.join(' ');
};

const splitLines = (text) => String(text ?? '').split('\n');

// Measure the text block (max line advance + ascent/descent/line height) at the
// given scale. A throwaway 2D context — measurement only.
function measureBlock(m, scale) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = fontString(m, scale);
  const lines = splitLines(m.text);
  const fallback = (m.size || 96) * scale;
  let maxW = 0;
  let ascent = 0;
  let descent = 0;
  for (const ln of lines) {
    const mt = ctx.measureText(ln || ' ');
    if (mt.width > maxW) maxW = mt.width;
    ascent = Math.max(ascent, mt.actualBoundingBoxAscent || fallback * 0.8);
    descent = Math.max(descent, mt.actualBoundingBoxDescent || fallback * 0.2);
  }
  const lineH = (ascent + descent) * 1.18 || fallback * 1.18;
  return { lines, maxW, ascent, lineH };
}

// Render a title model to a tight-box HTMLCanvasElement. Draw order (decision):
// lower-third background → text fill (with shadow) → stroke on top (no shadow).
export function drawTitle(model, scale = 1) {
  const m = model || {};
  const { lines, maxW, ascent, lineH } = measureBlock(m, scale);

  const strokeW = Math.max(0, (m.stroke?.width || 0) * scale);
  const sh = m.shadow || {};
  const shBlur = Math.max(0, (sh.blur || 0) * scale);
  const shDx = (sh.dx || 0) * scale;
  const shDy = (sh.dy || 0) * scale;
  const bg = m.background || null;
  const bgPadX = bg ? Math.max(0, (bg.padX || 0) * scale) : 0;
  const bgPadY = bg ? Math.max(0, (bg.padY || 0) * scale) : 0;

  // Padding around the text block: half the stroke each side, the shadow's
  // blur±offset extent, and the lower-third background padding.
  const padL = strokeW / 2 + Math.max(0, shBlur - shDx) + bgPadX;
  const padR = strokeW / 2 + Math.max(0, shBlur + shDx) + bgPadX;
  const padT = strokeW / 2 + Math.max(0, shBlur - shDy) + bgPadY;
  const padB = strokeW / 2 + Math.max(0, shBlur + shDy) + bgPadY;

  const textW = Math.ceil(maxW);
  const textH = Math.ceil(lineH * lines.length);
  const W = Math.max(1, textW + Math.ceil(padL + padR));
  const H = Math.max(1, textH + Math.ceil(padT + padB));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.font = fontString(m, scale);
  ctx.textBaseline = 'alphabetic';
  const align = ['left', 'center', 'right'].includes(m.align) ? m.align : 'center';
  ctx.textAlign = align;

  if (bg) {
    ctx.fillStyle = bg.color || '#000000';
    ctx.fillRect(0, 0, W, H);
  }

  // x anchor within the text column [padL, padL + textW], matching textAlign.
  const x = align === 'left' ? padL : align === 'right' ? padL + textW : padL + textW / 2;

  for (let i = 0; i < lines.length; i++) {
    const baseY = padT + ascent + i * lineH;
    ctx.save();
    if (shBlur || shDx || shDy) {
      ctx.shadowColor = sh.color || '#000000';
      ctx.shadowBlur = shBlur;
      ctx.shadowOffsetX = shDx;
      ctx.shadowOffsetY = shDy;
    }
    ctx.fillStyle = m.color || '#ffffff';
    ctx.fillText(lines[i] || '', x, baseY);
    ctx.restore();
    if (strokeW > 0) {
      ctx.lineWidth = strokeW;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = m.stroke?.color || '#000000';
      ctx.strokeText(lines[i] || '', x, baseY);
    }
  }
  return canvas;
}
