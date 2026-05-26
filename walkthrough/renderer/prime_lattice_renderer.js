// WebGPU renderer for walkthrough.v1.PrimeLatticeBlock.
//
// Surface kinds (LOG_PRODUCT, GOLDBACH_BIT) are implemented now;
// ULAM_SPIRAL and PRIME_GAP_LANDSCAPE render a placeholder
// (different topology — point cloud rather than surface; will land
// in a follow-up rev).
//
// Mesh vertices are placed at the actual prime values along x and
// y, NOT at uniform integer positions — that's the whole point of
// the block. z = f(p_i, p_j) is pre-computed JS-side and uploaded
// as a per-vertex attribute.
//
// An SVG tick overlay above the canvas shows prime labels at the
// projected positions of (p_i, p_min, 0) for x ticks and
// (p_min, p_j, 0) for y ticks; the overlay redraws each frame so
// labels track the camera. (At sharp orbit angles the labels can
// overlap; we auto-thin to ~8 visible labels per axis.)

import {
  orbitView, perspective, mul, deg,
  attachOrbitControls, onceVisible,
} from "./webgpu_util.js";

const NS_SVG = "http://www.w3.org/2000/svg";

const IMPLEMENTED_FUNCTIONS = new Set(["LOG_PRODUCT", "GOLDBACH_BIT"]);

export function renderPrimeLattice(block) {
  const el = document.createElement("div");
  el.className = "block prime-lattice";
  el.style.position = "relative";

  const spec = block.primeLattice || block.prime_lattice || {};
  const W = spec.widthPx || spec.width_px || 640;
  const H = spec.heightPx || spec.height_px || 480;
  const fnName = spec.function || "LOG_PRODUCT";

  if (!navigator.gpu) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.style.height = `${H}px`;
    ph.style.display = "flex";
    ph.style.alignItems = "center";
    ph.style.justifyContent = "center";
    ph.textContent =
      "[prime lattice: WebGPU not available. Try Chrome/Edge ≥ 113.]";
    el.appendChild(ph);
    return el;
  }

  if (!IMPLEMENTED_FUNCTIONS.has(fnName)) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.style.height = `${H}px`;
    ph.style.display = "flex";
    ph.style.alignItems = "center";
    ph.style.justifyContent = "center";
    ph.textContent =
      `[prime lattice: ${fnName} not yet implemented (deferred to follow-up).]`;
    el.appendChild(ph);
    return el;
  }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.display = "block";
  canvas.style.margin = "0 auto";
  canvas.style.cursor = "grab";
  el.appendChild(canvas);

  // SVG overlay for prime tick labels. Positioned absolutely over
  // the canvas so it tracks orbit. pointer-events:none lets the
  // canvas keep mouse focus for drag.
  const tickSvg = document.createElementNS(NS_SVG, "svg");
  tickSvg.setAttribute("width", W);
  tickSvg.setAttribute("height", H);
  tickSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  tickSvg.style.position = "absolute";
  tickSvg.style.left = "50%";
  tickSvg.style.top = "0";
  tickSvg.style.transform = "translateX(-50%)";
  tickSvg.style.pointerEvents = "none";
  tickSvg.style.maxWidth = "100%";
  el.appendChild(tickSvg);

  const hud = document.createElement("div");
  hud.style.fontFamily = "monospace";
  hud.style.fontSize = "11px";
  hud.style.color = "#666";
  hud.style.textAlign = "center";
  hud.style.marginTop = "0.3rem";
  const N = spec.nPrimes || spec.n_primes || 60;
  hud.textContent = `${fnName} · N=${N} primes per axis · drag to orbit · scroll to zoom`;
  el.appendChild(hud);

  onceVisible(canvas, () => {
    _initLattice(canvas, tickSvg, spec).catch((err) => {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = `[prime lattice init failed: ${err.message}]`;
      el.appendChild(ph);
    });
  });

  return el;
}

async function _initLattice(canvas, tickSvg, spec) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });

  const fnName = spec.function || "LOG_PRODUCT";
  const N = Math.max(4, spec.nPrimes || spec.n_primes || 60);
  const zScale = spec.zScale ?? spec.z_scale ?? 1;
  const showTicks = spec.showPrimeTicks ?? spec.show_prime_ticks ?? true;

  // Sieve enough primes. The N-th prime is < N · log(N · log N) for
  // small N; pad by 2x for safety.
  const sieveLimit = Math.max(60, Math.ceil(N * Math.log(N) * 2 + 20));
  const primes = _sieve(sieveLimit).slice(0, N);
  if (primes.length < N) {
    throw new Error(`only sieved ${primes.length} primes, needed ${N}`);
  }
  const primeSet = new Set(primes);
  // For Goldbach we need to recognize primes up to 2 · p_N as well.
  const goldbachSieve = fnName === "GOLDBACH_BIT"
    ? _sieve(2 * primes[primes.length - 1] + 1) : null;
  const goldbachSet = goldbachSieve ? new Set(goldbachSieve) : null;

  // Domain bounds.
  const xMax = primes[primes.length - 1];
  const xMin = primes[0];
  // For both implemented surfaces, z is non-negative.
  // LOG_PRODUCT max ≈ 2 · log(p_N). GOLDBACH_BIT max = 1.
  const zMax = fnName === "LOG_PRODUCT"
    ? 2 * Math.log(xMax)
    : 1;

  // ----- vertex buffer -----
  // (xRaw, yRaw, zRaw) per vertex; N×N vertices.
  const vCount = N * N;
  const verts = new Float32Array(vCount * 3);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = (j * N + i) * 3;
      const p = primes[i], q = primes[j];
      verts[idx] = p;
      verts[idx + 1] = q;
      let z;
      if (fnName === "LOG_PRODUCT") {
        z = Math.log(p) + Math.log(q);
      } else {
        z = goldbachSet.has(p + q) ? 1 : 0;
      }
      verts[idx + 2] = z;
    }
  }
  const vbuf = device.createBuffer({
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vbuf, 0, verts);

  // Index buffer: 2 triangles per quad over the (N-1)×(N-1) cells.
  const indices = new Uint32Array((N - 1) * (N - 1) * 6);
  let k = 0;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = b; indices[k++] = d; indices[k++] = c;
    }
  }
  const ibuf = device.createBuffer({
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(ibuf, 0, indices);

  // ----- uniforms: mvp (64) + bounds vec4(16) = 80 bytes -----
  const uBufSize = 80;
  const ubuf = device.createBuffer({
    size: uBufSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const module = device.createShaderModule({ code: _wgsl() });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module, entryPoint: "vs_main",
      buffers: [{
        arrayStride: 3 * 4,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
      }],
    },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
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
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: ubuf } }],
  });

  // ----- camera -----
  const cam = {
    azimuth: deg(spec.camera?.azimuthDeg ?? spec.camera?.azimuth_deg ?? -40),
    elevation: deg(spec.camera?.elevationDeg ?? spec.camera?.elevation_deg ?? 35),
    distance: spec.camera?.distance ?? 3.6,
    fov: deg(spec.camera?.fovDeg ?? spec.camera?.fov_deg ?? 42),
  };
  attachOrbitControls(canvas, cam);

  // ----- frame loop -----
  function frame() {
    const aspect = canvas.width / canvas.height;
    const view = orbitView(cam);
    const proj = perspective(cam.fov, aspect, 0.1, 100);
    const mvp = mul(proj, view);

    const u = new Float32Array(uBufSize / 4);
    for (let i = 0; i < 16; i++) u[i] = mvp[i];
    u[16] = xMax;
    u[17] = xMax;  // y_max == x_max
    u[18] = zMax * zScale;
    // u[19] unused
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
    pass.end();
    device.queue.submit([encoder.finish()]);

    if (showTicks) _updateTickOverlay(tickSvg, primes, mvp, xMax, canvas.width, canvas.height);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------- SVG tick overlay ----------

function _updateTickOverlay(svg, primes, mvp, xMax, W, H) {
  // Project a 3D world point (x, y, z) through the MVP and map
  // NDC → canvas pixel coords.
  const project = (x, y, z) => {
    // Normalize to [-1, 1] for x and y.
    const nx = (x / xMax) * 2 - 1;
    const ny = (y / xMax) * 2 - 1;
    const nz = z;
    // mvp is column-major; vector is (nx, ny, nz, 1).
    const wx = mvp[0]*nx + mvp[4]*ny + mvp[8]*nz  + mvp[12];
    const wy = mvp[1]*nx + mvp[5]*ny + mvp[9]*nz  + mvp[13];
    const wz = mvp[2]*nx + mvp[6]*ny + mvp[10]*nz + mvp[14];
    const ww = mvp[3]*nx + mvp[7]*ny + mvp[11]*nz + mvp[15];
    if (ww <= 0) return null;
    return [
      (wx / ww * 0.5 + 0.5) * W,
      (1 - (wy / ww * 0.5 + 0.5)) * H,
      wz / ww,
    ];
  };

  // Auto-thin: target ~8 ticks per axis.
  const stride = Math.max(1, Math.ceil(primes.length / 8));

  // Build label set: x-ticks at (p_i, p_min, 0); y-ticks at (p_min, p_j, 0).
  const items = [];
  for (let i = 0; i < primes.length; i += stride) {
    const p = primes[i];
    const projX = project(p, primes[0], 0);
    if (projX) items.push({ x: projX[0], y: projX[1], text: String(p), axis: "x" });
  }
  for (let j = 0; j < primes.length; j += stride) {
    if (j === 0) continue;  // shared corner
    const q = primes[j];
    const projY = project(primes[0], q, 0);
    if (projY) items.push({ x: projY[0], y: projY[1], text: String(q), axis: "y" });
  }
  // Always include the last prime explicitly so axis ends are labeled.
  const last = primes[primes.length - 1];
  const lastX = project(last, primes[0], 0);
  const lastY = project(primes[0], last, 0);
  if (lastX) items.push({ x: lastX[0], y: lastX[1], text: String(last), axis: "x" });
  if (lastY) items.push({ x: lastY[0], y: lastY[1], text: String(last), axis: "y" });

  // Rebuild SVG (cheap at ~16 labels).
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  for (const it of items) {
    const t = document.createElementNS(NS_SVG, "text");
    t.setAttribute("x", it.x.toFixed(1));
    t.setAttribute("y", (it.y + (it.axis === "x" ? 14 : 0)).toFixed(1));
    t.setAttribute("text-anchor", it.axis === "x" ? "middle" : "end");
    t.setAttribute("font-family", "monospace");
    t.setAttribute("font-size", "10");
    t.setAttribute("fill", "#555");
    t.textContent = it.text;
    svg.appendChild(t);
  }
}

// ---------- prime sieve ----------

function _sieve(n) {
  const isC = new Uint8Array(n + 1);
  const out = [];
  for (let i = 2; i <= n; i++) {
    if (isC[i]) continue;
    out.push(i);
    for (let j = i * i; j <= n; j += i) isC[j] = 1;
  }
  return out;
}

// ---------- WGSL ----------

function _wgsl() {
  return `
struct Uniforms {
  mvp: mat4x4<f32>,
  bounds: vec4<f32>,  // x_max, y_max, z_max_scaled, _
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) z_norm: f32,
}

@vertex
fn vs_main(@location(0) raw: vec3<f32>) -> VOut {
  let nx = raw.x / u.bounds.x * 2.0 - 1.0;
  let ny = raw.y / u.bounds.y * 2.0 - 1.0;
  let nz = raw.z / max(u.bounds.z, 0.0001);
  let world = vec3<f32>(nx, ny, nz);
  var out: VOut;
  out.pos = u.mvp * vec4<f32>(world, 1.0);
  out.z_norm = nz;
  return out;
}

fn colormap(t: f32) -> vec3<f32> {
  let c = clamp(t, 0.0, 1.0);
  let s0 = vec3<f32>(0.020, 0.015, 0.118);
  let s1 = vec3<f32>(0.392, 0.090, 0.412);
  let s2 = vec3<f32>(0.851, 0.345, 0.337);
  let s3 = vec3<f32>(0.988, 0.760, 0.541);
  let s4 = vec3<f32>(0.988, 0.992, 0.749);
  let t4 = c * 4.0;
  let i = floor(t4);
  let f = fract(t4);
  if (i < 1.0) { return mix(s0, s1, f); }
  if (i < 2.0) { return mix(s1, s2, f); }
  if (i < 3.0) { return mix(s2, s3, f); }
  return mix(s3, s4, f);
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let rgb = colormap(in.z_norm);
  // Fade flat regions (z near 0) to a soft cream so the "floor"
  // reads as floor.
  let floor_mix = smoothstep(0.0, 0.05, in.z_norm);
  let bg = vec3<f32>(0.97, 0.97, 0.96);
  let out_rgb = mix(bg, rgb, floor_mix);
  return vec4<f32>(out_rgb, 1.0);
}
`;
}
