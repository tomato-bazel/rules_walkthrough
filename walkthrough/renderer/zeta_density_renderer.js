// WebGPU renderer for walkthrough.v1.ZetaDensityBlock.
//
// Two-pass pipeline:
//   1. Accumulation pass — render the line strip
//      `t → (Re ζ(σ+i·t), Im ζ(σ+i·t))` for t_samples vertices into
//      an offscreen rgba16float texture, with additive blending. Each
//      fragment contributes (1, 1, 1, 1) so every pixel under a
//      segment increments its R channel by 1.
//   2. Display pass — either:
//      - HEATMAP_2D: full-screen quad sampling the density texture
//        and applying log-compression + colormap.
//      - HEIGHTMAP_3D: 256×256 vertex grid; vertex shader samples
//        density at its uv and displaces z by intensity. Fragment
//        colors by the same colormap, with light directional shading.
//
// Accumulation happens once on init (depending on t_samples it can
// be ~30 ms one-time); the frame loop only redraws the display pass.

import {
  orbitView, perspective, mul, deg,
  attachOrbitControls, onceVisible,
} from "./webgpu_util.js";
import {
  COLORMAP_MAGMA, ZETA_COMPLEX_DIRICHLET_ETA,
  assertNoReservedIdentifiers,
} from "./wgsl_common.js";

export function renderZetaDensity(block) {
  const el = document.createElement("div");
  el.className = "block zeta-density";
  const spec = block.zetaDensity || block.zeta_density || {};
  const W = spec.widthPx || spec.width_px || 640;
  const H = spec.heightPx || spec.height_px || 480;

  if (!navigator.gpu) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.style.height = `${H}px`;
    ph.style.display = "flex";
    ph.style.alignItems = "center";
    ph.style.justifyContent = "center";
    ph.textContent =
      "[zeta density: WebGPU not available. Try Chrome/Edge ≥ 113.]";
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

  const mode = spec.mode || "HEIGHTMAP_3D";
  const hud = document.createElement("div");
  hud.style.fontFamily = "monospace";
  hud.style.fontSize = "11px";
  hud.style.color = "#666";
  hud.style.textAlign = "center";
  hud.style.marginTop = "0.3rem";
  const tMaxLabel = spec.tMax ?? spec.t_max ?? 500;
  const tSamplesLabel = spec.tSamples || spec.t_samples || 50000;
  hud.textContent =
    `${mode} · σ=${spec.sigma ?? 0.5} · t ∈ [0, ${tMaxLabel}] · ` +
    `${tSamplesLabel.toLocaleString()} samples` +
    (mode === "HEIGHTMAP_3D" ? " · drag to orbit · wheel to zoom" : "");
  el.appendChild(hud);

  onceVisible(canvas, () => {
    _initDensity(canvas, spec, mode).catch((err) => {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = `[zeta density init failed: ${err.message}]`;
      el.appendChild(ph);
    });
  });
  return el;
}

async function _initDensity(canvas, spec, mode) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });

  const sigma = spec.sigma ?? 0.5;
  const tMin = spec.tMin ?? spec.t_min ?? 0;
  const tMax = spec.tMax ?? spec.t_max ?? 500;
  const tSamples = Math.max(2, spec.tSamples || spec.t_samples || 50000);
  const xyMin = spec.xyMin ?? spec.xy_min ?? -6;
  const xyMax = spec.xyMax ?? spec.xy_max ?? 6;
  const densityRes = spec.densityResolution || spec.density_resolution || 512;
  const zScale = spec.zScale ?? spec.z_scale ?? 1;

  // ---------- accumulation texture ----------
  const densityTex = device.createTexture({
    size: [densityRes, densityRes],
    format: "rgba16float",
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING,
  });
  const densityView = densityTex.createView();
  const densitySampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  // ---------- pass 1: accumulate ----------
  // Uniforms for the trace pass: sigma, t_min, t_max, t_samples,
  // xy_min, xy_max, padding to 16-byte alignment.
  const accumUBuf = device.createBuffer({
    size: 32,  // 8 floats
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(accumUBuf, 0, new Float32Array([
    sigma, tMin, tMax, tSamples,
    xyMin, xyMax, 0, 0,
  ]));

  const accumCode = await _loadShader("density_accum", _accumWGSL);
  const accumModule = device.createShaderModule({ code: accumCode });
  const accumPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: accumModule, entryPoint: "vs_main", buffers: [] },
    fragment: {
      module: accumModule, entryPoint: "fs_main",
      targets: [{
        format: "rgba16float",
        blend: {
          color: {
            srcFactor: "one",
            dstFactor: "one",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one",
            operation: "add",
          },
        },
      }],
    },
    primitive: { topology: "line-strip" },
  });
  const accumBindGroup = device.createBindGroup({
    layout: accumPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: accumUBuf } }],
  });

  // Run pass 1 once. Clears to black, then accumulates all segments.
  {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: densityView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(accumPipeline);
    pass.setBindGroup(0, accumBindGroup);
    pass.draw(tSamples);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  // ---------- pass 2: display ----------
  // Uniforms: mvp(64) + cfg vec4(density_max, z_scale, ref_radius_uv, ring_width_uv) +
  //           extras vec4(density_scale, cam_x, cam_y, cam_z) = 96
  //
  // cam_xyz is the orbit camera's world position; the glass display
  // shader uses it to compute the view direction at each fragment so
  // the Fresnel split and refraction-into-base maths line up with the
  // perspective transform.
  const displayUBuf = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Empirical density_max: with N=50000 segments, hot pixels can hit
  // ~100. Use log compression so cool spots are still visible. If
  // normalize is on, density values are smaller; bump display sensitivity.
  const normalize = !!(spec.normalize);
  const referenceRadius = spec.referenceRadius ?? spec.reference_radius ?? 0;
  // Map data radius (units of |ζ|) → uv radius (fraction of viewport).
  const refRadiusUv = referenceRadius > 0
    ? referenceRadius / ((xyMax - xyMin) * 0.5)
    : 0;
  const densityMax = normalize ? (80 / tMax) : 80;

  let displayPipeline, displayBindGroup, depthTex, runFrame;

  if (mode === "HEATMAP_2D") {
    const displayCode = await _loadShader("density_display_2d", _display2dWGSL);
    const displayModule = device.createShaderModule({ code: displayCode });
    displayPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: displayModule, entryPoint: "vs_main", buffers: [] },
      fragment: {
        module: displayModule, entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
    displayBindGroup = device.createBindGroup({
      layout: displayPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: displayUBuf } },
        { binding: 1, resource: densitySampler },
        { binding: 2, resource: densityView },
      ],
    });

    runFrame = () => {
      const u = new Float32Array(24);
      // identity mvp for 2D
      u[0] = 1; u[5] = 1; u[10] = 1; u[15] = 1;
      u[16] = densityMax;
      u[17] = zScale;
      u[18] = refRadiusUv;
      u[19] = 0.008;  // ring width in uv
      u[20] = normalize ? (1.0 / tMax) : 1.0;
      device.queue.writeBuffer(displayUBuf, 0, u);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0.98, g: 0.98, b: 0.97, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(displayPipeline);
      pass.setBindGroup(0, displayBindGroup);
      pass.draw(3);  // full-screen triangle
      pass.end();
      device.queue.submit([encoder.finish()]);
    };
  } else {
    // HEIGHTMAP_3D
    const N = 192;  // grid resolution
    const { vertices, indices } = _buildGrid(N);
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

    depthTex = device.createTexture({
      size: [canvas.width, canvas.height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const displayCode = await _loadShader("density_display_3d", _display3dWGSL);
    const displayModule = device.createShaderModule({ code: displayCode });
    displayPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: displayModule, entryPoint: "vs_main",
        buffers: [{
          arrayStride: 2 * 4,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        }],
      },
      fragment: {
        module: displayModule, entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
    displayBindGroup = device.createBindGroup({
      layout: displayPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: displayUBuf } },
        { binding: 1, resource: densitySampler },
        { binding: 2, resource: densityView },
      ],
    });

    const cam = {
      azimuth: deg(spec.camera?.azimuthDeg ?? spec.camera?.azimuth_deg ?? -45),
      elevation: deg(spec.camera?.elevationDeg ?? spec.camera?.elevation_deg ?? 35),
      distance: spec.camera?.distance ?? 3.4,
      fov: deg(spec.camera?.fovDeg ?? spec.camera?.fov_deg ?? 42),
    };
    attachOrbitControls(canvas, cam);

    runFrame = () => {
      const aspect = canvas.width / canvas.height;
      const view = orbitView(cam);
      const proj = perspective(cam.fov, aspect, 0.1, 100);
      const mvp = mul(proj, view);
      // World-space camera position — must mirror orbitView's
      // eye computation in webgpu_util.js (right-handed, +Z up).
      const ce = Math.cos(cam.elevation);
      const se = Math.sin(cam.elevation);
      const ca = Math.cos(cam.azimuth);
      const sa = Math.sin(cam.azimuth);
      const camX = cam.distance * ce * ca;
      const camY = cam.distance * ce * sa;
      const camZ = cam.distance * se;
      const u = new Float32Array(24);
      for (let i = 0; i < 16; i++) u[i] = mvp[i];
      u[16] = densityMax;
      u[17] = zScale;
      u[18] = refRadiusUv;
      u[19] = 0.008;
      u[20] = normalize ? (1.0 / tMax) : 1.0;
      u[21] = camX;
      u[22] = camY;
      u[23] = camZ;
      device.queue.writeBuffer(displayUBuf, 0, u);

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
      pass.setPipeline(displayPipeline);
      pass.setBindGroup(0, displayBindGroup);
      pass.setVertexBuffer(0, vbuf);
      pass.setIndexBuffer(ibuf, "uint32");
      pass.drawIndexed(indices.length);
      pass.end();
      device.queue.submit([encoder.finish()]);
    };
  }

  function loop() {
    runFrame();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// ---------- mesh helpers ----------

function _buildGrid(N) {
  const vCount = (N + 1) * (N + 1);
  const verts = new Float32Array(vCount * 2);
  let p = 0;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      verts[p++] = i / N;
      verts[p++] = j / N;
    }
  }
  const indices = new Uint32Array(N * N * 6);
  let k = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + (N + 1);
      const d = c + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = b; indices[k++] = d; indices[k++] = c;
    }
  }
  return { vertices: verts, indices };
}

// Prefer the Bazel-built shader (validated by naga at build time);
// fall back to the inline templated WGSL if the pre-built module
// isn't staged (e.g. when running the renderer outside Bazel).
async function _loadShader(name, fallbackFn) {
  try {
    const mod = await import(`./shaders/${name}.wgsl.js`);
    return mod.default || mod;
  } catch (err) {
    console.warn(`zeta_density: pre-built shader ${name} unavailable:`, err.message);
    return fallbackFn();
  }
}

// ---------- WGSL: accumulation pass ----------

function _accumWGSL() {
  const wgsl = `
struct Uniforms {
  params: vec4<f32>,    // sigma, t_min, t_max, t_samples
  viewport: vec4<f32>,  // xy_min, xy_max, _, _
}
@group(0) @binding(0) var<uniform> u: Uniforms;

${ZETA_COMPLEX_DIRICHLET_ETA}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
  let n = u.params.w;
  let t = mix(u.params.y, u.params.z, f32(idx) / max(n - 1.0, 1.0));
  let z = zeta_complex(u.params.x, t);
  let nx = (z.x - u.viewport.x) / (u.viewport.y - u.viewport.x) * 2.0 - 1.0;
  let ny = (z.y - u.viewport.x) / (u.viewport.y - u.viewport.x) * 2.0 - 1.0;
  return vec4<f32>(nx, ny, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
`;
  assertNoReservedIdentifiers(wgsl, "zeta_density:accum");
  return wgsl;
}

// ---------- WGSL: display pass (2D heatmap) ----------

function _display2dWGSL() {
  const wgsl = `
struct Uniforms {
  mvp: mat4x4<f32>,
  cfg: vec4<f32>,    // density_max, z_scale, ref_radius_uv, ring_width_uv
  extras: vec4<f32>, // density_scale (1/t_max if normalize, else 1), _, _, _
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var density: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VOut {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );
  var out: VOut;
  out.pos = vec4<f32>(positions[idx], 0.0, 1.0);
  out.uv = uvs[idx];
  return out;
}

${COLORMAP_MAGMA}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let raw = textureSample(density, smp, in.uv).r * u.extras.x;
  let compressed = log(1.0 + raw) / log(1.0 + u.cfg.x);
  var c = colormap(clamp(compressed, 0.0, 1.0));

  if (u.cfg.z > 0.0) {
    let centered = in.uv - vec2<f32>(0.5, 0.5);
    let r = length(centered);
    let ring = smoothstep(u.cfg.w, 0.0, abs(r - u.cfg.z));
    c = mix(c, vec3<f32>(0.95, 0.95, 0.95), 0.55 * ring);
  }
  return vec4<f32>(c, 1.0);
}
`;
  assertNoReservedIdentifiers(wgsl, "zeta_density:display2d");
  return wgsl;
}

// ---------- WGSL: display pass (3D heightmap) ----------

function _display3dWGSL() {
  const wgsl = `
struct Uniforms {
  mvp: mat4x4<f32>,
  cfg: vec4<f32>,    // density_max, z_scale, _, _
  extras: vec4<f32>, // density_scale, _, _, _
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var density: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) intensity: f32,
  @location(1) normal: vec3<f32>,
}

fn density_at(uv: vec2<f32>) -> f32 {
  let raw = textureSampleLevel(density, smp, uv, 0.0).r * u.extras.x;
  return log(1.0 + raw) / log(1.0 + u.cfg.x);
}

fn world_pos(uv: vec2<f32>) -> vec3<f32> {
  let h = density_at(uv) * u.cfg.y;
  return vec3<f32>((uv.x - 0.5) * 2.0, (uv.y - 0.5) * 2.0, h);
}

@vertex
fn vs_main(@location(0) uv: vec2<f32>) -> VOut {
  let world = world_pos(uv);
  let eps = 0.008;
  let p_px = world_pos(uv + vec2<f32>(eps, 0.0));
  let p_mx = world_pos(uv - vec2<f32>(eps, 0.0));
  let p_py = world_pos(uv + vec2<f32>(0.0, eps));
  let p_my = world_pos(uv - vec2<f32>(0.0, eps));
  let n = normalize(cross(p_px - p_mx, p_py - p_my));
  var out: VOut;
  out.pos = u.mvp * vec4<f32>(world, 1.0);
  out.intensity = density_at(uv);
  out.normal = n;
  return out;
}

${COLORMAP_MAGMA}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let base = colormap(clamp(in.intensity, 0.0, 1.0));
  let N = normalize(in.normal);
  let L1 = normalize(vec3<f32>( 0.4,  0.5, 0.9));
  let L2 = normalize(vec3<f32>(-0.6, -0.3, 0.7));
  let diff = max(dot(N, L1), 0.0) * 0.7 + max(dot(N, L2), 0.0) * 0.3;
  let lit = base * (0.35 + 0.7 * diff);
  let floor_mix = smoothstep(0.0, 0.03, in.intensity);
  let bg = vec3<f32>(0.97, 0.97, 0.96);
  return vec4<f32>(mix(bg, lit, floor_mix), 1.0);
}
`;
  assertNoReservedIdentifiers(wgsl, "zeta_density:display3d");
  return wgsl;
}
