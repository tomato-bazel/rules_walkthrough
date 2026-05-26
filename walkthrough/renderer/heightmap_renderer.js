import {
  COLORMAP_MAGMA, HSV_TO_RGB,
  ZETA_COMPLEX_DIRICHLET_ETA, ZETA_MODULUS,
  EULER_PRIMES_BINDING, ZETA_EULER_PRODUCT,
  SURFACE_NORMAL_CENTRAL_DIFF, PHONG_TWO_KEY,
  CONTOUR_FWIDTH, GRID_FACTOR_2D, FLOOR_FADE,
  assertNoReservedIdentifiers,
} from "./wgsl_common.js";

// WebGPU heightmap renderer for walkthrough.v1.HeightmapBlock.
//
// Builds an (N+1)×(M+1) vertex grid in unit-square uv coordinates,
// runs a vertex shader that evaluates the chosen height function
// per-vertex (including a 200-term Dirichlet-eta sum for
// ZETA_MODULUS), and rasterizes with a heat colormap. Mouse drag
// orbits the camera; wheel zooms.
//
// Falls back to a textual "WebGPU not available" placeholder on
// browsers without `navigator.gpu` (Safari < 18 without flags,
// some Firefox builds).

const HEIGHT_FUNCTIONS = {
  ZETA_MODULUS: "return zeta_modulus(x, y);",
  ZETA_MODULUS_LOG: "return log(1.0 + zeta_modulus(x, y));",
  SADDLE: "return x * x - y * y;",
  GAUSSIAN: "return exp(-(x*x + y*y));",
  // x = K (# primes), y = σ. t hardcoded to 10.0 — a "boring" spot
  // on the imaginary axis away from low-index zeros. The visual
  // intent is the convergence-vs-divergence boundary in σ; t just
  // needs to be off the real axis (ζ has a pole at s=1) and away
  // from zero clusters. Pole is avoided by clamping σ away from 1
  // in slide bounds.
  EULER_PRODUCT_ERROR_LOG: "return euler_error_log(u32(max(1.0, x)), y, 10.0);",
};

// Map (height function × color mode) → name of the pre-built shader
// module under `shaders/`. Missing combinations fall back to inline
// JS-templated WGSL. Build-time validation happens via rules_naga
// + wgsl_stdlib (see the consumer-supplied `shaders` attr on `walkthrough_html(...)`).
const PREBUILT_SHADERS = {
  "SADDLE:HEIGHT":             "heightmap_saddle",
  "GAUSSIAN:HEIGHT":           "heightmap_gaussian",
  "ZETA_MODULUS:HEIGHT":       "heightmap_zeta_modulus",
  "ZETA_MODULUS_LOG:HEIGHT":   "heightmap_zeta_modulus_log",
  "ZETA_MODULUS_LOG:PHASE":    "heightmap_zeta_phase",
};

async function _loadPrebuiltShader(heightFn, colorByPhase) {
  const colorKey = colorByPhase ? "PHASE" : "HEIGHT";
  const variant = PREBUILT_SHADERS[`${heightFn}:${colorKey}`];
  if (!variant) return null;
  try {
    const mod = await import(`./shaders/${variant}.wgsl.js`);
    return mod.default || mod;
  } catch (err) {
    // Pre-built shader missing or failed to load — fall back to
    // inline. Helps if someone runs the renderer outside Bazel.
    console.warn(`heightmap: pre-built shader ${variant} unavailable: ${err.message}`);
    return null;
  }
}

// First 100 primes — enough for the Euler-product height function.
// Hardcoded so we don't need a separate sieve module; the array is
// uploaded as a storage buffer at binding 1.
const FIRST_100_PRIMES = (() => {
  const out = [];
  const sieve = new Uint8Array(600);  // p_100 = 541
  for (let i = 2; i < 600 && out.length < 100; i++) {
    if (sieve[i]) continue;
    out.push(i);
    for (let j = i * i; j < 600; j += i) sieve[j] = 1;
  }
  return Float32Array.from(out);
})();

export function renderHeightmap(block) {
  const el = document.createElement("div");
  el.className = "block heightmap";
  const spec = block.heightmap || {};
  const W = spec.widthPx || 640;
  const H = spec.heightPx || 400;

  if (!navigator.gpu) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.style.height = `${H}px`;
    ph.style.display = "flex";
    ph.style.alignItems = "center";
    ph.style.justifyContent = "center";
    ph.textContent =
      "[heightmap: WebGPU not available in this browser. " +
      "Try Chrome/Edge ≥ 113, Safari 18+, or Firefox with " +
      "dom.webgpu.enabled.]";
    el.appendChild(ph);
    return el;
  }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.maxWidth = "100%";
  canvas.style.display = "block";
  canvas.style.margin = "0 auto";
  canvas.style.cursor = "grab";
  el.appendChild(canvas);

  const hud = document.createElement("div");
  hud.style.fontFamily = "monospace";
  hud.style.fontSize = "11px";
  hud.style.color = "#666";
  hud.style.textAlign = "center";
  hud.style.marginTop = "0.3rem";
  hud.textContent = `drag to orbit · wheel to zoom · ${spec.height || "?"}`;
  el.appendChild(hud);

  // Defer WebGPU initialization until the canvas actually becomes
  // visible. Renderer.js builds every slide's DOM up front; without
  // this gate, slide 1 would spin up pipelines for slides 5/6 and
  // any WGSL compile error would spam the console even when the
  // user is nowhere near the offending slide.
  let initialized = false;
  const kickoff = () => {
    if (initialized) return;
    initialized = true;
    _initHeightmap(canvas, spec).catch((err) => {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = `[heightmap init failed: ${err.message}]`;
      el.appendChild(ph);
    });
  };
  if (typeof IntersectionObserver !== "undefined") {
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          kickoff();
          obs.disconnect();
          break;
        }
      }
    }, { threshold: 0.01 });
    obs.observe(canvas);
  } else {
    kickoff();
  }

  return el;
}

async function _initHeightmap(canvas, spec) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });

  // ----- mesh -----
  const Nx = Math.max(2, spec.xSamples || spec.x_samples || 128);
  const Ny = Math.max(2, spec.ySamples || spec.y_samples || 128);
  const { vertices, indices } = _buildGrid(Nx, Ny);

  const vbuf = device.createBuffer({
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vbuf, 0, vertices);

  const ibuf = device.createBuffer({
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(ibuf, 0, indices);

  // ----- uniforms -----
  // layout: mat4 mvp (64) + 6 floats (xMin, xMax, yMin, yMax, zScale, zMax)
  //         + 2 pad = 64 + 32 = 96 bytes.
  const uBufSize = 64 + 8 * 4;
  const ubuf = device.createBuffer({
    size: uBufSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ----- primes storage buffer (only created for EULER variants;
  // with `layout: "auto"`, WebGPU strips unused bindings from the
  // inferred bind-group layout, so providing binding 1 when the
  // shader doesn't read it causes a layout mismatch crash) -----
  const useEuler = spec.height === "EULER_PRODUCT_ERROR_LOG";
  let primesBuf = null;
  if (useEuler) {
    primesBuf = device.createBuffer({
      size: FIRST_100_PRIMES.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(primesBuf, 0, FIRST_100_PRIMES);
  }

  // ----- pipeline -----
  const heightExpr = HEIGHT_FUNCTIONS[spec.height] || HEIGHT_FUNCTIONS.SADDLE;
  const colorByPhase = (spec.colorBy || spec.color_by) === "PHASE";
  // Prefer the Bazel-built shader for variants that have one. The
  // pre-built shaders are composed from wgsl_stdlib + a templated
  // main, validated by naga at build time, and shipped as ES modules
  // under `shaders/`. If no variant matches (e.g. EULER_PRODUCT_ERROR_LOG,
  // which still has a runtime-conditional binding) fall back to the
  // inline JS-templated WGSL.
  const prebuilt = await _loadPrebuiltShader(spec.height, colorByPhase);
  const shaderCode = prebuilt !== null
    ? prebuilt
    : _wgsl(heightExpr, useEuler, colorByPhase);
  const module = device.createShaderModule({ code: shaderCode });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module, entryPoint: "vs_main",
      buffers: [{
        arrayStride: 2 * 4,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
      }],
    },
    fragment: {
      module, entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });
  const depthTex = device.createTexture({
    size: [canvas.width, canvas.height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const bindGroupEntries = [{ binding: 0, resource: { buffer: ubuf } }];
  if (useEuler) {
    bindGroupEntries.push({ binding: 1, resource: { buffer: primesBuf } });
  }
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: bindGroupEntries,
  });

  // ----- reference geometry (floor / critical plane / strip box) -----
  const showFloor = spec.showFloorPlane || spec.show_floor_plane || false;
  const showCritical = spec.showCriticalPlane || spec.show_critical_plane || false;
  const showStrip = spec.showStripVolume || spec.show_strip_volume || false;
  const criticalX = spec.criticalX ?? spec.critical_x ?? 0.5;
  const refPipeline = _buildReferencePipeline(device, format, ubuf);
  // BindGroup must match the pipeline's layout. Both pipelines use
  // `layout: "auto"` and therefore get *distinct* layouts even though
  // their bindings are structurally identical — so create a second
  // bind group sourced from refPipeline's layout.
  const refBindGroup = device.createBindGroup({
    layout: refPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: ubuf } }],
  });
  const refMeshes = _buildReferenceMeshes(device, {
    showFloor, showCritical, showStrip, criticalX,
    xMin: spec.xMin ?? spec.x_min ?? -1,
    xMax: spec.xMax ?? spec.x_max ?? 1,
  });

  // ----- camera -----
  const cam = {
    azimuth: _deg(spec.camera?.azimuthDeg ?? spec.camera?.azimuth_deg ?? -35),
    elevation: _deg(spec.camera?.elevationDeg ?? spec.camera?.elevation_deg ?? 25),
    distance: spec.camera?.distance ?? 3.2,
    fov: _deg(spec.camera?.fovDeg ?? spec.camera?.fov_deg ?? 45),
  };
  _attachOrbitControls(canvas, cam);

  // ----- domain + z normalization -----
  const xMin = spec.xMin ?? spec.x_min ?? -1;
  const xMax = spec.xMax ?? spec.x_max ?? 1;
  const yMin = spec.yMin ?? spec.y_min ?? -1;
  const yMax = spec.yMax ?? spec.y_max ?? 1;
  const zScale = spec.zScale ?? spec.z_scale ?? 1;
  // Empirical z normalization for color ramp. |ζ| in the strip
  // peaks around 5–8 for the demo domain; tune per-function.
  const zMax = spec.height === "ZETA_MODULUS_LOG"
    ? 2.5
    : spec.height === "EULER_PRODUCT_ERROR_LOG"
      ? 6
      : spec.height?.startsWith("ZETA") ? 10 : 1;
  // Grid line spacing in data space — "nice" steps aimed at
  // ~10 lines along each axis. Passed to the shader so the grid
  // texture lands on data ticks, not uv ticks.
  const stepX = _niceStep(xMax - xMin, 10);
  const stepY = _niceStep(yMax - yMin, 10);

  // ----- frame loop -----
  function frame() {
    const aspect = canvas.width / canvas.height;
    const view = _orbitView(cam);
    const proj = _perspective(cam.fov, aspect, 0.1, 50);
    const mvp = _mul(proj, view);

    const u = new Float32Array(uBufSize / 4);
    for (let i = 0; i < 16; i++) u[i] = mvp[i];
    u[16] = xMin; u[17] = xMax; u[18] = yMin; u[19] = yMax;
    u[20] = zScale; u[21] = zMax; u[22] = stepX; u[23] = stepY;
    device.queue.writeBuffer(ubuf, 0, u);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        clearValue: { r: 0.98, g: 0.98, b: 0.97, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthTex.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vbuf);
    pass.setIndexBuffer(ibuf, "uint32");
    pass.drawIndexed(indices.length);

    // Reference planes draw last so their alpha blends over the
    // surface. Order: strip box (largest), floor, critical plane.
    if (refMeshes.length) {
      pass.setPipeline(refPipeline);
      pass.setBindGroup(0, refBindGroup);
      for (const m of refMeshes) {
        pass.setVertexBuffer(0, m.vbuf);
        pass.draw(m.count);
      }
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------- reference geometry (planes + box) ----------

function _buildReferencePipeline(device, format, ubuf) {
  const code = `
struct Uniforms {
  mvp: mat4x4<f32>,
  domain: vec4<f32>,
  scale: vec4<f32>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@vertex
fn vs_ref(
  @location(0) world: vec3<f32>,
  @location(1) color: vec4<f32>,
) -> VOut {
  var out: VOut;
  out.pos = u.mvp * vec4<f32>(world, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs_ref(in: VOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;
  const module = device.createShaderModule({ code });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module, entryPoint: "vs_ref",
      buffers: [{
        arrayStride: 7 * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 3 * 4, format: "float32x4" },
        ],
      }],
    },
    fragment: {
      module, entryPoint: "fs_ref",
      targets: [{
        format,
        blend: {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        },
      }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus",
      // Don't write depth — translucent overlays shouldn't occlude
      // anything (including each other) for cleaner blends.
      depthWriteEnabled: false,
      depthCompare: "less",
    },
  });
}

function _buildReferenceMeshes(device, opts) {
  const out = [];
  // Map data x in [xMin, xMax] to world x in [-1, 1].
  const xToWorld = (x) => (x - opts.xMin) / (opts.xMax - opts.xMin) * 2 - 1;
  const worldCriticalX = xToWorld(opts.criticalX);

  // World cube goes from (-1, -1, 0) to (1, 1, ~1). For the floor
  // we use z=0 exactly. For the critical plane we span y in [-1, 1]
  // and z in [0, 1.05] so it pokes a hair above peak.
  // For the strip box we span the entire xy plane, z in [0, 1].

  if (opts.showStrip) {
    out.push(_makeBoxMesh(device,
      [-1, -1, 0], [1, 1, 1.05],
      [0.10, 0.13, 0.18, 0.08]));
  }
  if (opts.showFloor) {
    out.push(_makeQuadMesh(device,
      [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0],
      [0.35, 0.45, 0.55, 0.22]));
  }
  if (opts.showCritical) {
    out.push(_makeQuadMesh(device,
      [worldCriticalX, -1, 0],
      [worldCriticalX,  1, 0],
      [worldCriticalX,  1, 1.05],
      [worldCriticalX, -1, 1.05],
      [0.12, 0.37, 0.66, 0.28]));
  }
  return out;
}

function _makeQuadMesh(device, p0, p1, p2, p3, rgba) {
  // Two triangles (CCW): p0-p1-p2, p0-p2-p3.
  const data = new Float32Array(6 * 7);
  const w = (i, p) => {
    data[i * 7 + 0] = p[0];
    data[i * 7 + 1] = p[1];
    data[i * 7 + 2] = p[2];
    data[i * 7 + 3] = rgba[0];
    data[i * 7 + 4] = rgba[1];
    data[i * 7 + 5] = rgba[2];
    data[i * 7 + 6] = rgba[3];
  };
  w(0, p0); w(1, p1); w(2, p2);
  w(3, p0); w(4, p2); w(5, p3);
  const vbuf = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vbuf, 0, data);
  return { vbuf, count: 6 };
}

function _makeBoxMesh(device, lo, hi, rgba) {
  // 12 triangles (6 faces · 2 tris); CCW from outside is fiddly
  // and cullMode is "none" anyway, so we keep order arbitrary.
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  // Each face is two triangles; 36 vertices total.
  const faces = [
    [0,1,2, 0,2,3],  // -z (bottom)
    [4,6,5, 4,7,6],  // +z (top)
    [0,4,5, 0,5,1],  // -y
    [3,2,6, 3,6,7],  // +y
    [0,3,7, 0,7,4],  // -x
    [1,5,6, 1,6,2],  // +x
  ];
  const data = new Float32Array(36 * 7);
  let idx = 0;
  for (const f of faces) {
    for (const i of f) {
      const p = v[i];
      data[idx++] = p[0]; data[idx++] = p[1]; data[idx++] = p[2];
      data[idx++] = rgba[0]; data[idx++] = rgba[1];
      data[idx++] = rgba[2]; data[idx++] = rgba[3];
    }
  }
  const vbuf = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vbuf, 0, data);
  return { vbuf, count: 36 };
}

// ---------- mesh ----------

function _buildGrid(Nx, Ny) {
  const vCount = (Nx + 1) * (Ny + 1);
  const verts = new Float32Array(vCount * 2);
  let p = 0;
  for (let j = 0; j <= Ny; j++) {
    for (let i = 0; i <= Nx; i++) {
      verts[p++] = i / Nx;
      verts[p++] = j / Ny;
    }
  }
  const indices = new Uint32Array(Nx * Ny * 6);
  let k = 0;
  for (let j = 0; j < Ny; j++) {
    for (let i = 0; i < Nx; i++) {
      const a = j * (Nx + 1) + i;
      const b = a + 1;
      const c = a + (Nx + 1);
      const d = c + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = b; indices[k++] = d; indices[k++] = c;
    }
  }
  return { vertices: verts, indices };
}

// ---------- camera math (right-handed, +z up) ----------

function _orbitView({ azimuth, elevation, distance }) {
  const eye = [
    distance * Math.cos(elevation) * Math.cos(azimuth),
    distance * Math.cos(elevation) * Math.sin(azimuth),
    distance * Math.sin(elevation),
  ];
  return _lookAt(eye, [0, 0, 0], [0, 0, 1]);
}

function _lookAt(eye, target, up) {
  const f = _norm(_sub(target, eye));
  const s = _norm(_cross(f, up));
  const u = _cross(s, f);
  // column-major mat4
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -_dot(s, eye), -_dot(u, eye), _dot(f, eye), 1,
  ]);
}

function _perspective(fovRad, aspect, near, far) {
  const f = 1 / Math.tan(fovRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function _mul(a, b) {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

const _sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const _cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function _norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const _deg = (d) => d * Math.PI / 180;

function _niceStep(range, targetCount) {
  if (!isFinite(range) || range <= 0) return 1;
  const raw = range / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

// ---------- orbit controls ----------

function _attachOrbitControls(canvas, cam) {
  let dragging = false;
  let lastX = 0, lastY = 0;
  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    canvas.style.cursor = "grabbing";
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    canvas.style.cursor = "grab";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    cam.azimuth -= dx * 0.01;
    cam.elevation = Math.max(-Math.PI / 2 + 0.05,
                    Math.min(Math.PI / 2 - 0.05,
                             cam.elevation + dy * 0.01));
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    cam.distance *= Math.exp(e.deltaY * 0.001);
    cam.distance = Math.max(0.5, Math.min(20, cam.distance));
  }, { passive: false });
}

// ---------- WGSL ----------

function _wgsl(heightExprBody, useEuler, colorByPhase) {
  const wgsl = `
struct Uniforms {
  mvp: mat4x4<f32>,
  domain: vec4<f32>,  // x_min, x_max, y_min, y_max
  scale: vec4<f32>,   // z_scale, z_max, step_x, step_y
}
@group(0) @binding(0) var<uniform> u: Uniforms;
${useEuler ? EULER_PRIMES_BINDING : ""}

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) height: f32,
  @location(3) domain_uv: vec2<f32>,  // (x, y) in original data space
  @location(4) phase: f32,            // arg(ζ) when color_by_phase, else 0
}

fn height_fn(x: f32, y: f32) -> f32 {
  ${heightExprBody}
}

${ZETA_COMPLEX_DIRICHLET_ETA}
${ZETA_MODULUS}
${useEuler ? ZETA_EULER_PRODUCT : ""}

// Map a domain (x, y, z) into the unit display cube.
fn world_pos(uv: vec2<f32>) -> vec3<f32> {
  let x = mix(u.domain.x, u.domain.y, uv.x);
  let y = mix(u.domain.z, u.domain.w, uv.y);
  let z = height_fn(x, y) * u.scale.x;
  return vec3<f32>((uv.x - 0.5) * 2.0, (uv.y - 0.5) * 2.0, z);
}

${SURFACE_NORMAL_CENTRAL_DIFF}
${HSV_TO_RGB}
${COLORMAP_MAGMA}
${GRID_FACTOR_2D}
${PHONG_TWO_KEY}

// Local contour: bands at every 1/6 of normalized height.
fn height_contour(t: f32) -> f32 {
  let bands = 6.0;
  let f = fract(t * bands);
  let d = min(f, 1.0 - f);
  let w = fwidth(t * bands) * 0.8;
  return smoothstep(0.0, w, d);
}

@vertex
fn vs_main(@location(0) uv: vec2<f32>) -> VOut {
  let world = world_pos(uv);
  let xd = mix(u.domain.x, u.domain.y, uv.x);
  let yd = mix(u.domain.z, u.domain.w, uv.y);
  let raw_z = height_fn(xd, yd);
  var out: VOut;
  out.pos = u.mvp * vec4<f32>(world, 1.0);
  out.world = world;
  out.normal = surface_normal(uv);
  out.height = raw_z;
  out.domain_uv = vec2<f32>(xd, yd);
  ${colorByPhase ? `
  let z_for_phase = zeta_complex(xd, yd);
  out.phase = atan2(z_for_phase.y, z_for_phase.x);
  ` : `
  out.phase = 0.0;
  `}
  return out;
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let t = clamp(in.height / max(u.scale.y, 0.0001), 0.0, 1.0);
  ${colorByPhase ? `
  let hue = (in.phase + 3.14159265) / 6.28318530;
  let base = hsv_to_rgb(hue, 1.0, 1.0);
  ` : `
  let base = colormap(t);
  `}

  let N = normalize(in.normal);
  let V = normalize(vec3<f32>(0.0, 0.0, 4.0) - in.world);
  let lit = phong_two_key(base, N, V);

  let line = height_contour(t);
  let with_lines = mix(lit * 0.55, lit, line);

  let grid = grid_factor(in.domain_uv, u.scale.zw);
  let major = mix(with_lines * 0.62, with_lines, grid);

  let floor_mix = smoothstep(0.0, 0.05, t);
  let bg = vec3<f32>(0.97, 0.97, 0.96);
  let out_rgb = mix(bg, major, floor_mix);

  return vec4<f32>(out_rgb, 1.0);
}
`;
  assertNoReservedIdentifiers(wgsl, "heightmap_renderer");
  return wgsl;
}
