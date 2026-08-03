/**
 * lokLiquid — deterministic GPU fluid field
 *
 * Clean-room implementation of Stam, "Stable Fluids" (SIGGRAPH '99) with
 * Fedkiw/Stam/Jensen vorticity confinement (2001). Written from the published
 * methods. No third-party source. Proprietary to Lok-Motion.
 *
 * v2 adds:
 *   - obstacle mask channel (objects the fluid collides with)
 *   - explicit GL resource disposal (no FBO leak on resize/reseed)
 *   - webglcontextlost/restored recovery
 *   - preset packs
 */

// ---------------------------------------------------------------------------
// deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// shaders
// ---------------------------------------------------------------------------
const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv, vL, vR, vT, vB;
uniform vec2 uTexel;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(uTexel.x, 0.0);
  vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y);
  vB = vUv - vec2(0.0, uTexel.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB;
out vec4 fragColor;
`;

/* Obstacle mask convention:
   R = solidity  (1 = solid, 0 = open)
   G = mode      (0 deflect, 0.5 absorb, 1.0 attract)
   Sampled in the boundary-sensitive passes below. */

const F_ADVECT = HEAD + `
uniform sampler2D uVelocity, uSource, uMask;
uniform vec2 uTexel;
uniform float uDt, uDissipation;
void main() {
  if (texture(uMask, vUv).r > 0.5) { fragColor = vec4(0.0); return; }
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  fragColor = texture(uSource, coord) / (1.0 + uDissipation * uDt);
}`;

const F_DIVERGENCE = HEAD + `
uniform sampler2D uVelocity, uMask;
void main() {
  float l = texture(uVelocity, vL).x;
  float r = texture(uVelocity, vR).x;
  float t = texture(uVelocity, vT).y;
  float b = texture(uVelocity, vB).y;
  vec2 c = texture(uVelocity, vUv).xy;
  // domain walls
  if (vL.x < 0.0) l = -c.x;
  if (vR.x > 1.0) r = -c.x;
  if (vT.y > 1.0) t = -c.y;
  if (vB.y < 0.0) b = -c.y;
  // obstacle walls — treat solid neighbours as reflecting boundaries
  if (texture(uMask, vL).r > 0.5) l = -c.x;
  if (texture(uMask, vR).r > 0.5) r = -c.x;
  if (texture(uMask, vT).r > 0.5) t = -c.y;
  if (texture(uMask, vB).r > 0.5) b = -c.y;
  fragColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}`;

const F_CURL = HEAD + `
uniform sampler2D uVelocity;
void main() {
  float l = texture(uVelocity, vL).y;
  float r = texture(uVelocity, vR).y;
  float t = texture(uVelocity, vT).x;
  float b = texture(uVelocity, vB).x;
  fragColor = vec4(0.5 * ((r - l) - (t - b)), 0.0, 0.0, 1.0);
}`;

const F_VORTICITY = HEAD + `
uniform sampler2D uVelocity, uCurl, uMask;
uniform float uCurlStrength, uDt;
void main() {
  if (texture(uMask, vUv).r > 0.5) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float l = texture(uCurl, vL).x;
  float r = texture(uCurl, vR).x;
  float t = texture(uCurl, vT).x;
  float b = texture(uCurl, vB).x;
  float c = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
  force /= length(force) + 1e-4;
  force *= uCurlStrength * c;
  force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  fragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
}`;

const F_PRESSURE = HEAD + `
uniform sampler2D uPressure, uDivergence, uMask;
void main() {
  float c = texture(uPressure, vUv).x;
  float l = texture(uMask, vL).r > 0.5 ? c : texture(uPressure, vL).x;
  float r = texture(uMask, vR).r > 0.5 ? c : texture(uPressure, vR).x;
  float t = texture(uMask, vT).r > 0.5 ? c : texture(uPressure, vT).x;
  float b = texture(uMask, vB).r > 0.5 ? c : texture(uPressure, vB).x;
  float div = texture(uDivergence, vUv).x;
  fragColor = vec4((l + r + b + t - div) * 0.25, 0.0, 0.0, 1.0);
}`;

const F_GRADIENT = HEAD + `
uniform sampler2D uPressure, uVelocity, uMask;
uniform float uSlip;
void main() {
  vec4 m = texture(uMask, vUv);
  if (m.r > 0.5) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float c = texture(uPressure, vUv).x;
  float l = texture(uMask, vL).r > 0.5 ? c : texture(uPressure, vL).x;
  float r = texture(uMask, vR).r > 0.5 ? c : texture(uPressure, vR).x;
  float t = texture(uMask, vT).r > 0.5 ? c : texture(uPressure, vT).x;
  float b = texture(uMask, vB).r > 0.5 ? c : texture(uPressure, vB).x;
  vec2 vel = texture(uVelocity, vUv).xy - vec2(r - l, t - b);

  // wall response near a solid edge — mode in G, strength in B
  vec4 mL = texture(uMask, vL), mR = texture(uMask, vR);
  vec4 mT = texture(uMask, vT), mB = texture(uMask, vB);
  float near = max(max(mL.r, mR.r), max(mT.r, mB.r));
  if (near > 0.5) {
    // pick the mode/strength of whichever neighbour is actually solid
    float mode = max(max(mL.r > 0.5 ? mL.g : 0.0, mR.r > 0.5 ? mR.g : 0.0),
                     max(mT.r > 0.5 ? mT.g : 0.0, mB.r > 0.5 ? mB.g : 0.0));
    float strength = max(max(mL.r > 0.5 ? mL.b : 0.0, mR.r > 0.5 ? mR.b : 0.0),
                         max(mT.r > 0.5 ? mT.b : 0.0, mB.r > 0.5 ? mB.b : 0.0));
    strength = max(strength, 0.04);

    // outward normal, pointing away from the solid
    vec2 n = normalize(vec2(mR.r - mL.r, mT.r - mB.r) + 1e-5);

    if (mode < 0.25) {
      // DEFLECT — remove the into-wall component, keep the tangent.
      // uSlip 1 = frictionless glide along the edge, 0 = fluid sticks.
      float into = min(0.0, dot(vel, n));
      vec2 tangent = vel - dot(vel, n) * n;
      vel = tangent * mix(1.0 - strength * 0.9, 1.0, uSlip) - into * n * strength;
    } else if (mode < 0.75) {
      // ABSORB — velocity bleeds away, fluid pools against the shape
      vel *= mix(1.0, 0.08, strength);
    } else {
      // ATTRACT — pulled inward, reads as clinging/wet
      vel -= n * (strength * 22.0);
    }
  }
  fragColor = vec4(vel, 0.0, 1.0);
}`;

const F_SPLAT = HEAD + `
uniform sampler2D uTarget, uMask;
uniform float uAspect, uRadius;
uniform vec3 uColor;
uniform vec2 uPoint;
void main() {
  if (texture(uMask, vUv).r > 0.5) { fragColor = texture(uTarget, vUv); return; }
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
  fragColor = vec4(texture(uTarget, vUv).xyz + splat, 1.0);
}`;

const F_CLEAR = HEAD + `
uniform sampler2D uTarget;
uniform float uValue;
void main() { fragColor = uValue * texture(uTarget, vUv); }`;

const F_DISPLAY = HEAD + `
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uShading;
void main() {
  vec3 c = texture(uTexture, vUv).rgb;
  if (uShading > 0.0) {
    float lc = length(texture(uTexture, vL).rgb);
    float rc = length(texture(uTexture, vR).rgb);
    float tc = length(texture(uTexture, vT).rgb);
    float bc = length(texture(uTexture, vB).rgb);
    vec3 n = normalize(vec3(rc - lc, tc - bc, length(uTexel) * 2.0));
    float diff = clamp(dot(n, vec3(0.0, 0.0, 1.0)) + 0.7, 0.7, 1.0);
    c *= mix(1.0, diff, uShading);
  }
  fragColor = vec4(c, 1.0);
}`;

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------
export const PRESETS = {
  ink:     { curl: 12, densityDissipation: 0.6, velocityDissipation: 0.35, shading: 0.4,
             palette: [[.02,.02,.05],[.06,.05,.10],[.01,.03,.08]] },
  plasma:  { curl: 42, densityDissipation: 1.4, velocityDissipation: 0.15, shading: 1.0,
             palette: null },
  smoke:   { curl: 8,  densityDissipation: 0.35, velocityDissipation: 0.5, shading: 0.8,
             palette: [[.07,.07,.08],[.10,.10,.11],[.05,.05,.06]] },
  current: { curl: 30, densityDissipation: 0.9, velocityDissipation: 0.2, shading: 1.0,
             palette: [[.14,.03,.16],[.02,.08,.16],[.16,.07,.01],[.15,.12,.01]] }
};

// ---------------------------------------------------------------------------
// gl helpers
// ---------------------------------------------------------------------------
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('lokLiquid shader: ' + log);
  }
  return s;
}

class Program {
  constructor(gl, vertSrc, fragSrc) {
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.bindAttribLocation(this.program, 0, 'aPos');
    gl.linkProgram(this.program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error('lokLiquid link: ' + gl.getProgramInfoLog(this.program));
    }
    this.uniforms = {};
    const n = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(this.program, i).name;
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
  }
  use() { this.gl.useProgram(this.program); }
  dispose() { this.gl.deleteProgram(this.program); }
}

function createFBO(gl, w, h, internal, format, type, filter) {
  gl.activeTexture(gl.TEXTURE0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, w, h);
  gl.clear(gl.COLOR_BUFFER_BIT);

  return {
    texture, fbo, width: w, height: h, texelX: 1 / w, texelY: 1 / h,
    attach(id) {
      gl.activeTexture(gl.TEXTURE0 + id);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      return id;
    },
    dispose() { gl.deleteTexture(texture); gl.deleteFramebuffer(fbo); }
  };
}

function createDoubleFBO(gl, w, h, internal, format, type, filter) {
  let a = createFBO(gl, w, h, internal, format, type, filter);
  let b = createFBO(gl, w, h, internal, format, type, filter);
  return {
    width: w, height: h, texelX: 1 / w, texelY: 1 / h,
    get read() { return a; }, set read(v) { a = v; },
    get write() { return b; }, set write(v) { b = v; },
    swap() { const t = a; a = b; b = t; },
    dispose() { a.dispose(); b.dispose(); }
  };
}

// ---------------------------------------------------------------------------
export const DEFAULTS = {
  simResolution: 128,
  dyeResolution: 1024,
  densityDissipation: 1.0,
  velocityDissipation: 0.2,
  pressureIterations: 20,
  pressure: 0.8,
  curl: 30,
  splatRadius: 0.25,
  splatForce: 6000,
  shading: 1.0,
  fps: 60,
  seed: 1,
  palette: null,
  ambient: 0,
  slip: 0.6,
  reducedMotion: false
};

export default class LokFluid {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.config = { ...DEFAULTS, ...options };
    if (options.preset && PRESETS[options.preset]) {
      Object.assign(this.config, PRESETS[options.preset]);
    }
    this.frame = 0;
    this.time = 0;
    this.rng = makeRng(this.config.seed);
    this._ambientAcc = 0;
    this._running = false;
    this._accumulator = 0;
    this._lost = false;
    this._disposed = false;
    this._maskDirty = true;
    this._maskSource = null;   // canvas supplied by the object system

    this._onLost = (e) => { e.preventDefault(); this._lost = true; this.stop(); };
    this._onRestored = () => { this._lost = false; this._boot(); if (this._wasRunning) this.start(); };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);

    this._boot();
  }

  _boot() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true, depth: false, stencil: false,
      antialias: false, preserveDrawingBuffer: false
    });
    if (!gl) throw new Error('lokLiquid requires WebGL2.');
    this.gl = gl;

    this.ext = {
      colorFloat: gl.getExtension('EXT_color_buffer_float'),
      colorHalf: gl.getExtension('EXT_color_buffer_half_float'),
      linear: gl.getExtension('OES_texture_float_linear')
    };
    if (!this.ext.colorFloat && !this.ext.colorHalf) {
      throw new Error('lokLiquid: no float render target support.');
    }
    this.filtering = this.ext.linear ? gl.LINEAR : gl.NEAREST;

    this._initGeometry();
    this._initPrograms();
    this._initMaskTexture();
    this.resize();
  }

  /**
   * Real capability probe. Extension strings lie in some webviews, so we
   * actually build a render target and ask the driver if it's complete.
   * Returns { ok, reason, detail } instead of a bare boolean.
   */
  static probe() {
    let c, gl;
    try {
      c = document.createElement('canvas');
      c.width = c.height = 2;
      gl = c.getContext('webgl2', { alpha: true, depth: false, stencil: false });
    } catch (e) {
      return { ok: false, reason: 'no-context', detail: e.message };
    }
    if (!gl) {
      const gl1 = (() => { try { return c.getContext('webgl'); } catch { return null; } })();
      return {
        ok: false,
        reason: gl1 ? 'webgl1-only' : 'no-webgl',
        detail: gl1
          ? 'This browser has WebGL1 but not WebGL2.'
          : 'WebGL is disabled entirely — usually an in-app browser or a privacy setting.'
      };
    }

    const hasFloat = !!gl.getExtension('EXT_color_buffer_float');
    const hasHalf = !!gl.getExtension('EXT_color_buffer_half_float');

    // trust nothing — try to actually make the target we need
    const tryFormat = (internal, format, type) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, internal, 2, 2, 0, format, type, null); }
      catch { gl.deleteTexture(tex); return false; }
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
      return ok;
    };

    const halfOk = tryFormat(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
    const renderer = (() => {
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
    })();

    if (!halfOk) {
      return {
        ok: false, reason: 'no-float-target',
        detail: `WebGL2 present but half-float render targets are unavailable ` +
                `(float ext: ${hasFloat}, half ext: ${hasHalf}, renderer: ${renderer}).`
      };
    }
    return { ok: true, reason: 'ok', detail: renderer };
  }

  static supported() { return LokFluid.probe().ok; }

  _initGeometry() {
    const gl = this.gl;
    this._vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, -1,1, 1,1, 1,-1]), gl.STATIC_DRAW);
    this._ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2, 0,2,3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
  }

  _initPrograms() {
    const gl = this.gl;
    this.programs = {
      clear: new Program(gl, VERT, F_CLEAR),
      splat: new Program(gl, VERT, F_SPLAT),
      advect: new Program(gl, VERT, F_ADVECT),
      divergence: new Program(gl, VERT, F_DIVERGENCE),
      curl: new Program(gl, VERT, F_CURL),
      vorticity: new Program(gl, VERT, F_VORTICITY),
      pressure: new Program(gl, VERT, F_PRESSURE),
      gradient: new Program(gl, VERT, F_GRADIENT),
      display: new Program(gl, VERT, F_DISPLAY)
    };
  }

  _initMaskTexture() {
    const gl = this.gl;
    this._maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
  }

  /** Object system hands us a canvas; we only re-upload when it says it's dirty. */
  setMaskSource(canvasEl) { this._maskSource = canvasEl; this._maskDirty = true; }
  invalidateMask() { this._maskDirty = true; }

  _uploadMask() {
    if (!this._maskDirty || !this._maskSource) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this._maskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._maskSource);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this._maskDirty = false;
  }

  _attachMask(unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this._maskTex);
    return unit;
  }

  _blit(target) {
    const gl = this.gl;
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  _dims(res) {
    const gl = this.gl;
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const min = Math.round(res), max = Math.round(res * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight
      ? { width: max, height: min } : { width: min, height: max };
  }

  _disposeTargets() {
    for (const t of [this.dye, this.velocity, this.pressure, this.divergence, this.curlFBO]) {
      if (t && t.dispose) t.dispose();
    }
    this.dye = this.velocity = this.pressure = this.divergence = this.curlFBO = null;
  }

  resize() {
    if (this._lost || this._disposed) return;
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (this.canvas.width === w && this.canvas.height === h && this.dye) return;
    this.canvas.width = w;
    this.canvas.height = h;

    this._disposeTargets();   // <- no leak on rotate/reseed

    const sim = this._dims(this.config.simResolution);
    const dye = this._dims(this.config.dyeResolution);
    const half = gl.HALF_FLOAT;
    this.dye = createDoubleFBO(gl, dye.width, dye.height, gl.RGBA16F, gl.RGBA, half, this.filtering);
    this.velocity = createDoubleFBO(gl, sim.width, sim.height, gl.RG16F, gl.RG, half, this.filtering);
    this.divergence = createFBO(gl, sim.width, sim.height, gl.R16F, gl.RED, half, gl.NEAREST);
    this.curlFBO = createFBO(gl, sim.width, sim.height, gl.R16F, gl.RED, half, gl.NEAREST);
    this.pressure = createDoubleFBO(gl, sim.width, sim.height, gl.R16F, gl.RED, half, gl.NEAREST);
    this._maskDirty = true;
  }

  _nextColor() {
    const p = this.config.palette;
    if (p && p.length) {
      const c = p[Math.floor(this.rng() * p.length) % p.length];
      return [c[0], c[1], c[2]];
    }
    const h = this.rng();
    const i = Math.floor(h * 6), f = h * 6 - i, q = 1 - f;
    const table = [[1,f,0],[q,1,0],[0,1,f],[0,q,1],[f,0,1],[1,0,q]];
    const c = table[i % 6];
    return [c[0] * 0.15, c[1] * 0.15, c[2] * 0.15];
  }

  _radius() {
    let r = this.config.splatRadius / 100;
    const a = this.canvas.width / this.canvas.height;
    return a > 1 ? r * a : r;
  }

  splat(x, y, dx, dy, color) {
    if (this._lost || !this.velocity) return;
    const gl = this.gl;
    const c = color || this._nextColor();
    const p = this.programs.splat;
    this._uploadMask();
    p.use();
    gl.uniform2f(p.uniforms.uTexel, this.velocity.texelX, this.velocity.texelY);
    gl.uniform1i(p.uniforms.uTarget, this.velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uMask, this._attachMask(2));
    gl.uniform1f(p.uniforms.uAspect, this.canvas.width / this.canvas.height);
    gl.uniform2f(p.uniforms.uPoint, x, y);
    gl.uniform3f(p.uniforms.uColor, dx, dy, 0);
    gl.uniform1f(p.uniforms.uRadius, this._radius());
    this._blit(this.velocity.write);
    this.velocity.swap();

    gl.uniform2f(p.uniforms.uTexel, this.dye.texelX, this.dye.texelY);
    gl.uniform1i(p.uniforms.uTarget, this.dye.read.attach(0));
    gl.uniform1i(p.uniforms.uMask, this._attachMask(2));
    gl.uniform3f(p.uniforms.uColor, c[0], c[1], c[2]);
    this._blit(this.dye.write);
    this.dye.swap();
  }

  stroke(x, y, prevX, prevY) {
    const rect = this.canvas.getBoundingClientRect();
    const nx = (x - rect.left) / rect.width;
    const ny = 1 - (y - rect.top) / rect.height;
    const px = (prevX - rect.left) / rect.width;
    const py = 1 - (prevY - rect.top) / rect.height;
    const f = this.config.splatForce;
    this.splat(nx, ny, (nx - px) * f, (ny - py) * f);
  }

  _step(dt) {
    const gl = this.gl, P = this.programs;
    if (this._lost || !this.velocity) return;
    this._uploadMask();
    gl.disable(gl.BLEND);

    P.curl.use();
    gl.uniform2f(P.curl.uniforms.uTexel, this.velocity.texelX, this.velocity.texelY);
    gl.uniform1i(P.curl.uniforms.uVelocity, this.velocity.read.attach(0));
    this._blit(this.curlFBO);

    P.vorticity.use();
    gl.uniform2f(P.vorticity.uniforms.uTexel, this.velocity.texelX, this.velocity.texelY);
    gl.uniform1i(P.vorticity.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(P.vorticity.uniforms.uCurl, this.curlFBO.attach(1));
    gl.uniform1i(P.vorticity.uniforms.uMask, this._attachMask(2));
    gl.uniform1f(P.vorticity.uniforms.uCurlStrength, this.config.curl);
    gl.uniform1f(P.vorticity.uniforms.uDt, dt);
    this._blit(this.velocity.write);
    this.velocity.swap();

    P.divergence.use();
    gl.uniform2f(P.divergence.uniforms.uTexel, this.velocity.texelX, this.velocity.texelY);
    gl.uniform1i(P.divergence.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(P.divergence.uniforms.uMask, this._attachMask(2));
    this._blit(this.divergence);

    P.clear.use();
    gl.uniform1i(P.clear.uniforms.uTarget, this.pressure.read.attach(0));
    gl.uniform1f(P.clear.uniforms.uValue, this.config.pressure);
    this._blit(this.pressure.write);
    this.pressure.swap();

    P.pressure.use();
    gl.uniform2f(P.pressure.uniforms.uTexel, this.velocity.texelX, this.velocity.texelY);
    gl.uniform1i(P.pressure.uniforms.uDivergence, this.divergence.attach(0));
    gl.uniform1i(P.pressure.uniforms.uMask, this._attachMask(2));
    for (let i = 0; i < this.config.pressureIterations; i++) {
      gl.uniform1i(P.pressure.uniforms.uPressure, this.pressure.read.attach(1));
      this._blit(this.pressure.write);
      this.pressure.swap();
    }

    P.gradient.use();
    gl.uniform2f(P.gradient.uniforms.uTexel, this.velocity.texelX, this.velocity.texelY);
    gl.uniform1i(P.gradient.uniforms.uPressure, this.pressure.read.attach(0));
    gl.uniform1i(P.gradient.uniforms.uVelocity, this.velocity.read.attach(1));
    gl.uniform1i(P.gradient.uniforms.uMask, this._attachMask(2));
    gl.uniform1f(P.gradient.uniforms.uSlip, this.config.slip);
    this._blit(this.velocity.write);
    this.velocity.swap();

    P.advect.use();
    gl.uniform2f(P.advect.uniforms.uTexel, this.velocity.texelX, this.velocity.texelY);
    const v = this.velocity.read.attach(0);
    gl.uniform1i(P.advect.uniforms.uVelocity, v);
    gl.uniform1i(P.advect.uniforms.uSource, v);
    gl.uniform1i(P.advect.uniforms.uMask, this._attachMask(2));
    gl.uniform1f(P.advect.uniforms.uDt, dt);
    gl.uniform1f(P.advect.uniforms.uDissipation, this.config.velocityDissipation);
    this._blit(this.velocity.write);
    this.velocity.swap();

    gl.uniform2f(P.advect.uniforms.uTexel, this.dye.texelX, this.dye.texelY);
    gl.uniform1i(P.advect.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(P.advect.uniforms.uSource, this.dye.read.attach(1));
    gl.uniform1i(P.advect.uniforms.uMask, this._attachMask(2));
    gl.uniform1f(P.advect.uniforms.uDissipation, this.config.densityDissipation);
    this._blit(this.dye.write);
    this.dye.swap();
  }

  _ambient(dt) {
    const rate = this.config.reducedMotion ? this.config.ambient * 0.25 : this.config.ambient;
    if (!rate) return;
    this._ambientAcc += rate * dt;
    while (this._ambientAcc >= 1) {
      this._ambientAcc -= 1;
      const x = this.rng(), y = this.rng();
      const a = this.rng() * Math.PI * 2;
      const m = 500 + this.rng() * 500;
      this.splat(x, y, Math.cos(a) * m, Math.sin(a) * m);
    }
  }

  render() {
    if (this._lost || !this.dye) return;
    const gl = this.gl, p = this.programs.display;
    p.use();
    gl.uniform2f(p.uniforms.uTexel, this.dye.texelX, this.dye.texelY);
    gl.uniform1i(p.uniforms.uTexture, this.dye.read.attach(0));
    gl.uniform1f(p.uniforms.uShading, this.config.shading);
    this._blit(null);
  }

  stepFrame() {
    const dt = 1 / this.config.fps;
    this._ambient(dt);
    this._step(dt);
    this.frame++;
    this.time += dt;
    this.render();
    return this.frame;
  }

  seek(t) {
    this.reset();
    const target = Math.round(t * this.config.fps);
    const dt = 1 / this.config.fps;
    for (let i = 0; i < target; i++) {
      this._ambient(dt); this._step(dt); this.frame++; this.time += dt;
    }
    this.render();
  }

  reset() {
    this.frame = 0; this.time = 0; this._ambientAcc = 0;
    this.rng = makeRng(this.config.seed);
    if (this.dye) {
      const gl = this.gl, P = this.programs;
      P.clear.use();
      gl.uniform1f(P.clear.uniforms.uValue, 0);
      for (const t of [this.dye, this.velocity, this.pressure]) {
        gl.uniform1i(P.clear.uniforms.uTarget, t.read.attach(0));
        this._blit(t.write); t.swap();
      }
      this.render();
    }
  }

  sampleVelocity() {
    const gl = this.gl;
    const { width, height, fbo } = this.velocity.read;
    const buf = new Float32Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, buf);
    return { width, height, data: buf };
  }

  start() {
    if (this._running || this._lost || this._disposed) return;
    this._running = true; this._wasRunning = true;
    this._lastWall = performance.now();
    const loop = () => {
      if (!this._running) return;
      const now = performance.now();
      this._accumulator += Math.min((now - this._lastWall) / 1000, 0.25);
      this._lastWall = now;
      const dt = 1 / this.config.fps;
      let stepped = false;
      while (this._accumulator >= dt) {
        this._accumulator -= dt;
        this._ambient(dt); this._step(dt);
        this.frame++; this.time += dt; stepped = true;
      }
      if (stepped) this.render();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  pause() { this._wasRunning = this._running; this.stop(); }
  resume() { if (this._wasRunning) this.start(); }

  set(key, value) {
    this.config[key] = value;
    if (key === 'seed') this.rng = makeRng(value);
    if (key === 'simResolution' || key === 'dyeResolution') { this.dye = null; this.resize(); }
  }

  applyPreset(name) {
    if (!PRESETS[name]) return;
    Object.assign(this.config, PRESETS[name]);
  }

  getShareState() {
    const c = this.config;
    return {
      seed: c.seed, curl: c.curl,
      densityDissipation: c.densityDissipation,
      velocityDissipation: c.velocityDissipation,
      splatRadius: c.splatRadius, shading: c.shading,
      ambient: c.ambient, slip: c.slip, palette: c.palette
    };
  }

  destroy() {
    this.stop();
    this._disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    this._disposeTargets();
    if (this.programs) for (const k in this.programs) this.programs[k].dispose();
    const gl = this.gl;
    if (gl) {
      gl.deleteTexture(this._maskTex);
      gl.deleteBuffer(this._vbo);
      gl.deleteBuffer(this._ibo);
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
  }
}
