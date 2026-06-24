// glDisplay — the editor's WebGL2 preview pipeline (Color Grading SF1).
// Production port of the GPU spike's measured workload (gpuSpikeLib.js):
// shaders are VERBATIM — including FS_LUT's half-texel coordinate math
// (c·(N−1)/N + 0.5/N), which the export side mirrors with
// lut3d=interp=trilinear so both paths compute the identical function.
//
// Deliberate differences from the spike harness:
//  - Upload stays the spike's exact texImage2D(.., video) call — the ONLY
//    upload path measured PASS on this WebKitGTK/ANGLE port (p95 13 ms at
//    1080p incl. LUT). texStorage2D + texSubImage2D is the recorded later
//    optimization knob, NOT proven on this port; a first attempt with it
//    froze the canvas (SF1 gate finding).
//  - TWO persistent video textures, one per <video> element, so texture
//    parameters survive cuts between sources.
//  - Aspect-fit draw (the videos' objectFit:contain equivalent): full-canvas
//    clear to the Projection Booth stage tone, then a centered viewport —
//    letterbox bars stay byte-identical to the pre-canvas look.
//  - 3D LUT slot is plumbed but inert until SF3 wires compiled grades in.

const VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_PASS = `#version 300 es
precision mediump float;
uniform sampler2D u_video;
in vec2 v_uv;
out vec4 o;
void main() { o = vec4(texture(u_video, v_uv).rgb, 1.0); }`;

const FS_LUT = `#version 300 es
precision mediump float;
precision mediump sampler3D;
uniform sampler2D u_video;
uniform sampler3D u_lut;
uniform float u_lutN;
in vec2 v_uv;
out vec4 o;
void main() {
  vec3 c = texture(u_video, v_uv).rgb;
  vec3 coord = c * ((u_lutN - 1.0) / u_lutN) + 0.5 / u_lutN;
  o = vec4(texture(u_lut, coord).rgb, 1.0);
}`;

// Composite path (Compositing & Titles SF4): an attributed transform quad (vs
// the attribute-less full-screen triangle above). a_pos arrives already in clip
// space (computeLayerQuad bakes the transform); the FS keeps FS_LUT's half-texel
// math VERBATIM and outputs the source's per-pixel alpha × the per-layer opacity
// for normal alpha-over blending (opaque video → α=1; a transparent title PNG
// keeps its glyph cut-out so the layers below show through).
const VS_COMPOSITE = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS_COMPOSITE = `#version 300 es
precision mediump float;
precision mediump sampler3D;
uniform sampler2D u_video;
uniform sampler3D u_lut;
uniform float u_lutN;
uniform int u_useLut;
uniform float u_opacity;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 src = texture(u_video, v_uv);
  vec3 c = src.rgb;
  if (u_useLut == 1) {
    c = texture(u_lut, c * ((u_lutN - 1.0) / u_lutN) + 0.5 / u_lutN).rgb;
  }
  o = vec4(c, src.a * u_opacity);
}`;

// computeLayerQuad (Compositing & Titles SF4) — pure geometry for one composited
// layer. Maps the layer's (cropped) source rect into SEQUENCE space (identity =
// aspect-fit fill, center anchor), then the sequence rect into the canvas
// (letterbox), applying the normalized transform: position as a fraction of the
// sequence dims, uniform scale, rotation in degrees (clockwise), static crop.
// Returns 4 interleaved verts [x_ndc, y_ndc, u, v] in TL, TR, BL, BR order for a
// TRIANGLE_STRIP. v=0 is the source TOP (matches render()). Exported for offline
// unit tests. Identity transform with source dims == sequence dims reproduces
// render()'s aspect-fit viewport rect — the preview↔grade parity hinge.
export function computeLayerQuad({ srcW, srcH, seqW, seqH, cw, ch, transform, isTitle }) {
  const t = transform || {};
  const cropL = t.crop?.l || 0;
  const cropT = t.crop?.t || 0;
  const cropR = t.crop?.r || 0;
  const cropB = t.crop?.b || 0;
  const scale = t.scale ?? 1;
  const rot = ((t.rot ?? 0) * Math.PI) / 180;
  const ox = t.x ?? 0;
  const oy = t.y ?? 0;

  // Sequence rect within the canvas (letterbox), centered.
  const seqFit = Math.min(cw / seqW, ch / seqH);
  const seqRectW = seqW * seqFit;
  const seqRectH = seqH * seqFit;

  // Layer base size in canvas px: source aspect-fit into the sequence, then the
  // sequence's own fit into the canvas. A TITLE is authored in sequence pixels
  // already (its tight box), so it maps 1:1 (fit=1) — placed at native size and
  // then transformed — instead of the aspect-fit-fill a video layer gets.
  const layerFit = isTitle ? 1 : Math.min(seqW / srcW, seqH / srcH);
  const baseW = srcW * layerFit * seqFit;
  const baseH = srcH * layerFit * seqFit;

  // Crop shrinks the displayed rect proportionally (no stretch); scale on top.
  const visW = Math.max(0, 1 - cropL - cropR);
  const visH = Math.max(0, 1 - cropT - cropB);
  const halfW = (baseW * visW * scale) / 2;
  const halfH = (baseH * visH * scale) / 2;

  // Center: canvas center + normalized offset of the sequence dims (canvas px).
  const cx = cw / 2 + ox * seqRectW;
  const cy = ch / 2 - oy * seqRectH;

  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  // Local corner offsets (screen space, y down): TL, TR, BL, BR.
  const local = [[-halfW, -halfH], [halfW, -halfH], [-halfW, halfH], [halfW, halfH]];
  // Crop insets the sampled uv (v=0 is the source top, matching render()).
  const uv = [[cropL, cropT], [1 - cropR, cropT], [cropL, 1 - cropB], [1 - cropR, 1 - cropB]];
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    const lx = local[i][0];
    const ly = local[i][1];
    const px = cx + (lx * cos - ly * sin);
    const py = cy + (lx * sin + ly * cos);
    out[i * 4 + 0] = (2 * px) / cw - 1;   // NDC x
    out[i * 4 + 1] = 1 - (2 * py) / ch;   // NDC y (flip)
    out[i * 4 + 2] = uv[i][0];
    out[i * 4 + 3] = uv[i][1];
  }
  return out;
}

// Projection Booth stage tone (#0a0a0c) — gaps and letterbox bars must match
// what the stage background showed before the canvas existed.
const CLEAR = [10 / 255, 10 / 255, 12 / 255, 1];

export const looksSoftware = (renderer) =>
  /llvmpipe|softpipe|swiftshader|software/i.test(String(renderer || ''));

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function link(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export function createGlDisplay(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!gl || gl.isContextLost()) return null;

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg
    ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);

  const progPass = link(gl, VS, FS_PASS);
  const progLut = link(gl, VS, FS_LUT);
  const uPassVideo = gl.getUniformLocation(progPass, 'u_video');
  const uLutVideo = gl.getUniformLocation(progLut, 'u_video');
  const uLutLut = gl.getUniformLocation(progLut, 'u_lut');
  const uLutN = gl.getUniformLocation(progLut, 'u_lutN');

  const progComposite = link(gl, VS_COMPOSITE, FS_COMPOSITE);
  const cAttrPos = gl.getAttribLocation(progComposite, 'a_pos');
  const cAttrUv = gl.getAttribLocation(progComposite, 'a_uv');
  const uCVideo = gl.getUniformLocation(progComposite, 'u_video');
  const uCLut = gl.getUniformLocation(progComposite, 'u_lut');
  const uCLutN = gl.getUniformLocation(progComposite, 'u_lutN');
  const uCUseLut = gl.getUniformLocation(progComposite, 'u_useLut');
  const uCOpacity = gl.getUniformLocation(progComposite, 'u_opacity');
  // Interleaved [x, y, u, v] quad, rewritten per layer (16-byte stride).
  const compBuf = gl.createBuffer();
  const compVao = gl.createVertexArray();
  gl.bindVertexArray(compVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, compBuf);
  gl.enableVertexAttribArray(cAttrPos);
  gl.vertexAttribPointer(cAttrPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(cAttrUv);
  gl.vertexAttribPointer(cAttrUv, 2, gl.FLOAT, false, 16, 8);
  gl.bindVertexArray(null);

  // One persistent texture per <video> element: Map<el, tex>. Parameters are
  // set once; texImage2D re-specifies the storage every frame (the measured
  // path — see header).
  const sources = new Map();
  let lut = null; // { tex, n } — set by SF3's grade pipeline
  // Per-grade composite LUT cache (SF4): version → { tex, n }. Keyed by the
  // gradePipeline version token so each layer's grade uploads its 3D LUT once.
  const lutCache = new Map();

  // SF9 scope tap: a small offscreen FBO the active picture is re-drawn into,
  // then read back for the 2D-canvas scopes. 480-wide, aspect-preserving, NO
  // letterbox — scopes want pure picture pixels, not stage bars. readPixels
  // rows come back bottom-up; all three scopes are row-order independent
  // (waveform maps source COLUMN → plot x, luma → plot y), so no flip.
  let scope = null; // { fbo, tex, w, h, buf }

  function ensureScope(w, h) {
    if (scope && scope.w === w && scope.h === h) return scope;
    if (scope) {
      gl.deleteFramebuffer(scope.fbo);
      gl.deleteTexture(scope.tex);
    }
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    scope = ok ? { fbo, tex, w, h, buf: new Uint8Array(w * h * 4) } : null;
    if (!ok) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
    }
    return scope;
  }

  function ensureSource(el) {
    let tex = sources.get(el);
    if (!tex) {
      tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      sources.set(el, tex);
    }
    return tex;
  }

  // SF4: upload (once, cached by version) a per-grade 3D LUT for the composite
  // path. Mirrors setLut's texture params; the single-clip render() path keeps
  // its own `lut` slot untouched.
  function ensureLut(rgba8, n, version) {
    let e = lutCache.get(version);
    if (e) return e;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, n, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba8);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    e = { tex, n };
    lutCache.set(version, e);
    return e;
  }

  function clearAll() {
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(...CLEAR);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  return {
    gl,
    renderer,

    resize(w, h) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    },

    // Upload el's current frame and draw it aspect-fit. useLut draws through
    // the 33³ grade LUT when one is loaded (SF3+); identity = passthrough.
    render(el, useLut) {
      const w = el.videoWidth;
      const h = el.videoHeight;
      const tex = ensureSource(el);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
      clearAll();
      const cw = canvas.width;
      const ch = canvas.height;
      const scale = Math.min(cw / w, ch / h);
      const vw = Math.max(1, Math.round(w * scale));
      const vh = Math.max(1, Math.round(h * scale));
      gl.viewport(Math.floor((cw - vw) / 2), Math.floor((ch - vh) / 2), vw, vh);
      if (useLut && lut) {
        gl.useProgram(progLut);
        gl.uniform1i(uLutVideo, 0);
        gl.uniform1i(uLutLut, 1);
        gl.uniform1f(uLutN, lut.n);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, lut.tex);
      } else {
        gl.useProgram(progPass);
        gl.uniform1i(uPassVideo, 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    // Composite N layers bottom→top with normal alpha-over (Compositing SF4).
    // layers: [{ el, transform, lut }] — lut = { rgba8, n, version } | null,
    // cached per version. seqW/seqH define the sequence space the transforms
    // are normalized against. Per layer: upload the frame, build its transform
    // quad, optionally grade through its LUT, draw with its opacity. render(),
    // renderScope() and the single `lut` slot are untouched.
    renderComposite(layers, seqW, seqH) {
      const cw = canvas.width;
      const ch = canvas.height;
      clearAll();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(progComposite);
      gl.uniform1i(uCVideo, 0);
      gl.uniform1i(uCLut, 1);
      gl.bindVertexArray(compVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, compBuf);
      for (const layer of layers) {
        const el = layer.el;
        // A title layer's `el` is a <canvas> (no videoWidth/Height) — fall back to
        // width/height. Its box is authored in sequence px, so isTitle → fit=1.
        const w = el?.videoWidth || el?.width;
        const h = el?.videoHeight || el?.height;
        if (!w || !h) continue;
        const tex = ensureSource(el);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
        const verts = computeLayerQuad({ srcW: w, srcH: h, seqW, seqH, cw, ch, transform: layer.transform, isTitle: layer.isTitle });
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        if (layer.lut) {
          const e = ensureLut(layer.lut.rgba8, layer.lut.n, layer.lut.version);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_3D, e.tex);
          gl.uniform1i(uCUseLut, 1);
          gl.uniform1f(uCLutN, e.n);
        } else {
          gl.uniform1i(uCUseLut, 0);
        }
        gl.uniform1f(uCOpacity, layer.transform?.opacity ?? 1);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    },

    // Gap / no-source frame: the stage tone, full canvas.
    drawBlack() {
      clearAll();
    },

    // SF9: re-draw el's ALREADY-UPLOADED frame into the scope FBO and read it
    // back. Call right after render(el, …) — it reuses the source texture
    // from that upload (also valid for parked one-shot refreshes; the texture
    // holds the element's last frame). Returns { data, w, h } or null.
    renderScope(el, useLut) {
      const vw = el.videoWidth;
      const vh = el.videoHeight;
      if (!vw || !vh) return null;
      const w = 480;
      const h = Math.max(1, Math.min(480, Math.round((w * vh) / vw)));
      const s = ensureScope(w, h);
      if (!s) return null;
      const tex = ensureSource(el);
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (useLut && lut) {
        gl.useProgram(progLut);
        gl.uniform1i(uLutVideo, 0);
        gl.uniform1i(uLutLut, 1);
        gl.uniform1f(uLutN, lut.n);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, lut.tex);
      } else {
        gl.useProgram(progPass);
        gl.uniform1i(uPassVideo, 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, s.buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { data: s.buf, w, h };
    },

    // SF3: install/replace the active grade LUT (RGBA8, n³).
    setLut(rgba8, n) {
      if (lut) gl.deleteTexture(lut.tex);
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, n, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba8);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      lut = { tex, n };
    },

    clearLut() {
      if (lut) gl.deleteTexture(lut.tex);
      lut = null;
    },

    // NEVER loseContext() here: React StrictMode runs effect → cleanup →
    // effect on the SAME canvas in dev, and a canvas hands back its one
    // context object forever — losing it in cleanup hands the second effect
    // run a dead context, which fails shader compile and silently falls back
    // to plain video (the SF3 gate bug: the canvas had been falling back on
    // every mount since SF1). Freeing programs + textures is the real
    // cleanup; the context itself dies with the canvas node on true unmount.
    dispose() {
      for (const tex of sources.values()) gl.deleteTexture(tex);
      sources.clear();
      if (lut) gl.deleteTexture(lut.tex);
      lut = null;
      for (const e of lutCache.values()) gl.deleteTexture(e.tex);
      lutCache.clear();
      if (scope) {
        gl.deleteFramebuffer(scope.fbo);
        gl.deleteTexture(scope.tex);
        scope = null;
      }
      gl.deleteBuffer(compBuf);
      gl.deleteVertexArray(compVao);
      gl.deleteProgram(progPass);
      gl.deleteProgram(progLut);
      gl.deleteProgram(progComposite);
    },
  };
}
