// GPU & Codec Spike measurement helpers — dev-only (reached solely from the
// DEV-gated DevTab chunk; prod builds never emit this file).
// Spike artifact (Video Editor sub-plan 3): throwaway-quality harness, but the
// measurement paths mirror the Color Grading phase's real workload — per-frame
// video texture upload + one 33³ 3D-LUT shader — so numbers are decision-grade.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------- LUT data --
// Identity-perturbed 33³ RGBA8 LUT. Perturbation keeps the lookup from being
// optimizable to a no-op while staying visually near-neutral.
export function makeLutData(n = 33) {
  const data = new Uint8Array(n * n * n * 4);
  let i = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const fr = r / (n - 1), fg = g / (n - 1), fb = b / (n - 1);
        data[i++] = Math.round(255 * clamp01(fr * 0.96 + 0.02 * fg));
        data[i++] = Math.round(255 * clamp01(fg * 0.97 + 0.02 * fb));
        data[i++] = Math.round(255 * clamp01(fb * 0.95 + 0.03 * fr));
        data[i++] = 255;
      }
    }
  }
  return data;
}

// ------------------------------------------------------------------- stats --
export function summarize(samples, budgetMs) {
  if (!samples.length) return { n: 0, p50: 0, p95: 0, worst: 0, overPct: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const over = budgetMs ? s.filter((v) => v > budgetMs).length : 0;
  return {
    n: s.length,
    p50: pick(50),
    p95: pick(95),
    worst: s[s.length - 1],
    overPct: budgetMs ? (100 * over) / s.length : 0,
  };
}

export const fmt = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : '—');

// --------------------------------------------------------------- env probe --
export function probeGL(powerPreference) {
  const c = document.createElement('canvas');
  let gl = null;
  try { gl = c.getContext('webgl2', { powerPreference }); } catch { /* report below */ }
  if (!gl) return { ok: false, powerPreference };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const out = {
    ok: true,
    powerPreference,
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
    glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    max3d: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
    timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    attrs: gl.getContextAttributes(),
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return out;
}

export const looksSoftware = (renderer) =>
  /llvmpipe|softpipe|swiftshader|software/i.test(String(renderer || ''));

// ------------------------------------------------------------- GL pipeline --
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

// Compositor spike (Compositing & Titles SF1). Mirrors the matrix-quad VS that
// SF4's production renderComposite will use: a unit quad (4-vert TRIANGLE_STRIP,
// corners from gl_VertexID) transformed by u_model, sampled (+ verbatim half-
// texel LUT) and emitted with straight alpha u_opacity for a real SRC_ALPHA
// blend. Identity u_model = full-frame = worst-case overdraw.
export const MAX_LAYERS = 4;

const VS_COMPOSITE = `#version 300 es
uniform mat3 u_model;
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  v_uv = vec2(corner.x, 1.0 - corner.y);
  vec3 p = u_model * vec3(corner * 2.0 - 1.0, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const FS_COMPOSITE = `#version 300 es
precision mediump float;
precision mediump sampler3D;
uniform sampler2D u_video;
uniform sampler3D u_lut;
uniform float u_lutN;
uniform float u_opacity;
in vec2 v_uv;
out vec4 o;
void main() {
  vec3 c = texture(u_video, v_uv).rgb;
  vec3 coord = c * ((u_lutN - 1.0) / u_lutN) + 0.5 / u_lutN;
  o = vec4(texture(u_lut, coord).rgb, u_opacity);
}`;

export function createBenchPipeline(canvas, lutN = 33) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  const progPass = link(gl, VS, FS_PASS);
  const progLut = link(gl, VS, FS_LUT);
  const progComposite = link(gl, VS_COMPOSITE, FS_COMPOSITE);

  const videoTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, videoTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const lutTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTex);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lutN, lutN, lutN, 0, gl.RGBA, gl.UNSIGNED_BYTE, makeLutData(lutN));
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

  const uPassVideo = gl.getUniformLocation(progPass, 'u_video');
  const uLutVideo = gl.getUniformLocation(progLut, 'u_video');
  const uLutLut = gl.getUniformLocation(progLut, 'u_lut');
  const uLutN = gl.getUniformLocation(progLut, 'u_lutN');

  // Composite: one distinct texture per layer so N uploads are N real reallocs
  // (not one texture overwritten). lutTex stays bound on TEXTURE1 throughout.
  const layerTex = [];
  for (let k = 0; k < MAX_LAYERS; k++) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    layerTex.push(t);
  }
  const uCompModel = gl.getUniformLocation(progComposite, 'u_model');
  const uCompVideo = gl.getUniformLocation(progComposite, 'u_video');
  const uCompLut = gl.getUniformLocation(progComposite, 'u_lut');
  const uCompLutN = gl.getUniformLocation(progComposite, 'u_lutN');
  const uCompOpacity = gl.getUniformLocation(progComposite, 'u_opacity');
  const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  return {
    gl,
    timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    setSize(w, h) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    },
    // Full texImage2D realloc per frame — the pessimistic upload path. A
    // texStorage2D + texSubImage2D variant is a later optimization; measuring
    // the worst case keeps the verdict conservative.
    upload(video) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    },
    uploadFrame(frame) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      return gl.getError();
    },
    draw(kind) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (kind === 'lut') {
        gl.useProgram(progLut);
        gl.uniform1i(uLutVideo, 0);
        gl.uniform1i(uLutLut, 1);
        gl.uniform1f(uLutN, lutN);
      } else {
        gl.useProgram(progPass);
        gl.uniform1i(uPassVideo, 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    // ---- compositor spike (SF1): N uploads + N alpha-blended quad draws ----
    beginComposite() {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.04, 0.04, 0.05, 1); // Projection Booth stage tone
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    },
    uploadLayer(k, video) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layerTex[k]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    },
    drawLayer(k, opacity) {
      gl.useProgram(progComposite);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layerTex[k]);
      gl.uniform1i(uCompVideo, 0);
      gl.uniform1i(uCompLut, 1);
      gl.uniform1f(uCompLutN, lutN);
      gl.uniformMatrix3fv(uCompModel, false, IDENTITY3);
      gl.uniform1f(uCompOpacity, opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

// fenceSync-based GPU completion estimate. Poll-quantized to rAF ticks —
// labeled an estimate everywhere it is reported, never the pass metric.
export function createFenceTracker(gl, maxInFlight = 4) {
  const pending = [];
  return {
    insert(submitT) {
      if (pending.length >= maxInFlight) return;
      const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (s) pending.push({ s, submitT });
    },
    poll(nowT, out) {
      for (let k = pending.length - 1; k >= 0; k--) {
        const st = gl.clientWaitSync(pending[k].s, 0, 0);
        if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
          out.push(nowT - pending[k].submitT);
          gl.deleteSync(pending[k].s);
          pending.splice(k, 1);
        }
      }
    },
    dispose() {
      pending.forEach((p) => gl.deleteSync(p.s));
      pending.length = 0;
    },
  };
}

// --------------------------------------------------------------- WebCodecs --
// Dependency-free Annex-B access-unit splitter. Fixtures are generated with
// aud=1 + scenecut=0, so every AU starts with an AUD NAL (type 9) and the
// splitter never meets a stream it didn't make. Emulation-prevention bytes
// guarantee no false start codes inside NAL payloads.
export function splitAnnexBAccessUnits(buffer) {
  const u8 = new Uint8Array(buffer);
  const nals = [];
  for (let i = 0; i + 3 < u8.length; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0) {
      let sc = 0;
      if (u8[i + 2] === 1) sc = 3;
      else if (u8[i + 2] === 0 && u8[i + 3] === 1) sc = 4;
      if (sc && i + sc < u8.length) {
        nals.push({ offset: i, type: u8[i + sc] & 0x1f });
        i += sc;
      }
    }
  }
  const aus = [];
  let cur = null;
  for (const n of nals) {
    if (n.type === 9) {
      if (cur) aus.push(cur);
      cur = { begin: n.offset, key: false };
    } else if (cur && n.type === 5) {
      cur.key = true;
    }
  }
  if (cur) aus.push(cur);
  for (let k = 0; k < aus.length; k++) {
    aus[k].end = k + 1 < aus.length ? aus[k + 1].begin : u8.length;
  }
  return aus.map((a) => ({ data: u8.subarray(a.begin, a.end), key: a.key }));
}

export async function webCodecsSupport(fx, hardwareAcceleration) {
  if (!('VideoDecoder' in window)) return { available: false };
  try {
    const r = await VideoDecoder.isConfigSupported({
      codec: fx.codec,
      codedWidth: fx.width,
      codedHeight: fx.height,
      hardwareAcceleration,
    });
    return { available: true, supported: !!r.supported };
  } catch (e) {
    return { available: true, supported: false, error: String(e) };
  }
}

// Decode maxAUs access units with backpressure; returns throughput stats plus
// whatever onFrameSample returned for a mid-stream frame. No `description` in
// the config selects Annex-B mode per the WebCodecs AVC registration — the
// dependency-free trick that avoids an mp4 demuxer.
export function webCodecsDecodeBench({ url, fx, hardwareAcceleration, maxAUs = 300, onFrameSample }) {
  return new Promise((resolve) => {
    if (!('VideoDecoder' in window)) { resolve({ ok: false, reason: 'VideoDecoder absent' }); return; }
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error('fetch ' + r.status); return r.arrayBuffer(); })
      .then((buf) => {
        const aus = splitAnnexBAccessUnits(buf).slice(0, maxAUs);
        if (!aus.length || !aus[0].key) { resolve({ ok: false, reason: `bad stream (AUs ${aus.length})` }); return; }
        let outputs = 0, t0 = 0, firstOut = 0, lastOut = 0, sample = null, dead = false;
        const dec = new VideoDecoder({
          output(frame) {
            outputs++;
            const now = performance.now();
            if (outputs === 1) firstOut = now;
            lastOut = now;
            if (outputs === 100 && onFrameSample) {
              try { sample = onFrameSample(frame); } catch (e) { sample = { error: String(e) }; }
            }
            frame.close();
          },
          error(e) {
            if (!dead) { dead = true; resolve({ ok: false, reason: 'decoder error: ' + e.message }); }
          },
        });
        try {
          dec.configure({
            codec: fx.codec,
            codedWidth: fx.width,
            codedHeight: fx.height,
            hardwareAcceleration,
          });
        } catch (e) { resolve({ ok: false, reason: 'configure: ' + String(e) }); return; }
        let i = 0;
        t0 = performance.now();
        const pump = () => {
          if (dead) return;
          try {
            while (i < aus.length && dec.decodeQueueSize < 4) {
              const au = aus[i];
              dec.decode(new EncodedVideoChunk({
                type: au.key ? 'key' : 'delta',
                timestamp: Math.round((i * 1e6) / fx.fps),
                data: au.data,
              }));
              i++;
            }
          } catch (e) {
            if (!dead) { dead = true; resolve({ ok: false, reason: 'decode: ' + String(e) }); }
            return;
          }
          if (i < aus.length) {
            // dequeue-event reliability is unproven on this port — poll fallback.
            setTimeout(pump, 0);
          } else {
            dec.flush().then(() => {
              if (dead) return;
              dead = true;
              const wallS = Math.max(0.001, (lastOut - t0) / 1000);
              resolve({
                ok: true,
                fed: aus.length,
                outputs,
                decodeFps: outputs / wallS,
                firstFrameMs: firstOut - t0,
                sample,
              });
              try { dec.close(); } catch { /* already closed */ }
            }).catch((e) => {
              if (!dead) { dead = true; resolve({ ok: false, reason: 'flush: ' + String(e) }); }
            });
          }
        };
        try { dec.ondequeue = pump; } catch { /* poll covers it */ }
        pump();
      })
      .catch((e) => resolve({ ok: false, reason: String(e) }));
  });
}
