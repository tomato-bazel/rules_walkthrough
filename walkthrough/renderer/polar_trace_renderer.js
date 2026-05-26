// WebGPU renderer for walkthrough.v1.PolarTraceBlock.
//
// Draws a parametric 3D curve `t → (Re f(1/2+it), Im f(1/2+it), t)`
// as a line strip; ζ or η is evaluated per-vertex in WGSL via a
// 200-term Dirichlet-eta sum. Companion to the heightmap renderer
// — this is the slice σ = 1/2 of the heightmap, viewed end-on.
//
// Pipelines:
//   - Curve: line-strip, color-by-|ζ|, vertex_index drives t.
//   - Axis:  line-list, two vertices from (0,0,t_min) to (0,0,t_max),
//            so the corkscrew motif reads as "winding around an axis".
//
// Camera + WebGPU init mirrors heightmap_renderer.js (orbit camera,
// IntersectionObserver lazy init, graceful WebGPU-not-available
// placeholder). Shared math lives in webgpu_util.js.

import {
  orbitView, perspective, mul, deg,
  attachOrbitControls, onceVisible,
} from "./webgpu_util.js";
import {
  COLORMAP_MAGMA, ZETA_COMPLEX_DIRICHLET_ETA,
  assertNoReservedIdentifiers,
} from "./wgsl_common.js";

const TRACE_FUNCTIONS = {
  ZETA_CRITICAL_LINE: { sigma: 0.5, kind: "zeta" },
  ETA_CRITICAL_LINE: { sigma: 0.5, kind: "eta" },
};

export function renderPolarTrace(block) {
  const el = document.createElement("div");
  el.className = "block polar-trace";
  const spec = block.polarTrace || block.polar_trace || {};
  const W = spec.widthPx || spec.width_px || 640;
  const H = spec.heightPx || spec.height_px || 440;

  if (!navigator.gpu) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.style.height = `${H}px`;
    ph.style.display = "flex";
    ph.style.alignItems = "center";
    ph.style.justifyContent = "center";
    ph.textContent =
      "[polar trace: WebGPU not available. Try Chrome/Edge ≥ 113 " +
      "or Safari 18+.]";
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
  hud.textContent = `drag to orbit · wheel to zoom · ${spec.trace || "ZETA_CRITICAL_LINE"}`;
  el.appendChild(hud);

  onceVisible(canvas, () => {
    _initTrace(canvas, spec).catch((err) => {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = `[polar trace init failed: ${err.message}]`;
      el.appendChild(ph);
    });
  });

  return el;
}

async function _initTrace(canvas, spec) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });

  const traceName = spec.trace || "ZETA_CRITICAL_LINE";
  const traceSpec = TRACE_FUNCTIONS[traceName] || TRACE_FUNCTIONS.ZETA_CRITICAL_LINE;

  const tMin = spec.tMin ?? spec.t_min ?? 0;
  const tMax = spec.tMax ?? spec.t_max ?? 50;
  const tSamples = Math.max(2, spec.tSamples || spec.t_samples || 1200);
  const xyScale = spec.xyScale ?? spec.xy_scale ?? 0.3;
  const tScale = spec.tScale ?? spec.t_scale ?? 0.04;
  const showAxis = spec.showAxis ?? spec.show_axis ?? true;

  // ----- uniforms -----
  // mvp(64) + params(8 floats = 32) = 96 bytes
  const uBufSize = 96;
  const ubuf = device.createBuffer({
    size: uBufSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ----- pipelines -----
  // Pre-built shader (kind="zeta", sigma=0.5). For other variants
  // (eta, alternate sigma) fall back to inline templating — only
  // the zeta-on-critical-line variant has a Bazel target today.
  let wgsl;
  if (traceSpec.kind === "zeta" && traceSpec.sigma === 0.5) {
    try {
      const mod = await import("./shaders/polar_trace.wgsl.js");
      wgsl = mod.default || mod;
    } catch (err) {
      console.warn("polar_trace: pre-built shader unavailable:", err.message);
      wgsl = _wgsl(traceSpec.kind, traceSpec.sigma);
    }
  } else {
    wgsl = _wgsl(traceSpec.kind, traceSpec.sigma);
  }
  const module = device.createShaderModule({ code: wgsl });

  const curvePipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_curve", buffers: [] },
    fragment: {
      module, entryPoint: "fs_curve", targets: [{ format }],
    },
    primitive: { topology: "line-strip" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });

  const axisPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_axis", buffers: [] },
    fragment: {
      module, entryPoint: "fs_axis", targets: [{ format }],
    },
    primitive: { topology: "line-list" },
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

  const curveBindGroup = device.createBindGroup({
    layout: curvePipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: ubuf } }],
  });
  const axisBindGroup = device.createBindGroup({
    layout: axisPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: ubuf } }],
  });

  // ----- camera -----
  const cam = {
    azimuth: deg(spec.camera?.azimuthDeg ?? spec.camera?.azimuth_deg ?? -55),
    elevation: deg(spec.camera?.elevationDeg ?? spec.camera?.elevation_deg ?? 18),
    distance: spec.camera?.distance ?? 4.0,
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
    u[16] = tMin;
    u[17] = tMax;
    u[18] = xyScale;
    u[19] = tScale;
    u[20] = tSamples;
    // u[21..23] unused / reserved
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

    if (showAxis) {
      pass.setPipeline(axisPipeline);
      pass.setBindGroup(0, axisBindGroup);
      pass.draw(2);
    }

    pass.setPipeline(curvePipeline);
    pass.setBindGroup(0, curveBindGroup);
    pass.draw(tSamples);
    pass.end();

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------- WGSL ----------

function _wgsl(kind /* "zeta" | "eta" */, sigma) {
  // For "eta": evaluate the Dirichlet-eta directly (drop the
  // (1 − 2^(1−s)) divide that ZETA_COMPLEX_DIRICHLET_ETA applies).
  // Tiny local eta function rather than another shared snippet —
  // only this one block uses it.
  const evalBody = kind === "eta"
    ? `
fn eta_only(sigma: f32, t: f32) -> vec2<f32> {
  var re: f32 = 0.0;
  var im: f32 = 0.0;
  for (var n: u32 = 1u; n <= 200u; n = n + 1u) {
    let nf = f32(n);
    let log_n = log(nf);
    let mag = exp(-sigma * log_n);
    let phase = -t * log_n;
    let s = select(-1.0, 1.0, (n & 1u) == 1u);
    re = re + s * mag * cos(phase);
    im = im + s * mag * sin(phase);
  }
  return vec2<f32>(re, im);
}

fn evaluate(t: f32) -> vec2<f32> { return eta_only(${sigma}, t); }
`
    : `
fn evaluate(t: f32) -> vec2<f32> { return zeta_complex(${sigma}, t); }
`;
  const wgsl = `
struct Uniforms {
  mvp: mat4x4<f32>,
  params: vec4<f32>,  // t_min, t_max, xy_scale, t_scale
  counts: vec4<f32>,  // t_samples, _, _, _
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) modulus: f32,
}

${ZETA_COMPLEX_DIRICHLET_ETA}
${COLORMAP_MAGMA}
${evalBody}

fn t_to_z(t: f32) -> f32 {
  let mid = 0.5 * (u.params.x + u.params.y);
  return (t - mid) * u.params.w;
}

@vertex
fn vs_curve(@builtin(vertex_index) idx: u32) -> VOut {
  let t = mix(u.params.x, u.params.y, f32(idx) / max(u.counts.x - 1.0, 1.0));
  let z = evaluate(t);
  let world = vec3<f32>(z.x * u.params.z, z.y * u.params.z, t_to_z(t));
  var out: VOut;
  out.pos = u.mvp * vec4<f32>(world, 1.0);
  out.modulus = length(z);
  return out;
}

@fragment
fn fs_curve(in: VOut) -> @location(0) vec4<f32> {
  let norm = smoothstep(0.0, 4.0, in.modulus);
  let rgb = colormap(norm);
  return vec4<f32>(rgb, 1.0);
}

@vertex
fn vs_axis(@builtin(vertex_index) idx: u32) -> VOut {
  let t = select(u.params.x, u.params.y, idx == 1u);
  let world = vec3<f32>(0.0, 0.0, t_to_z(t));
  var out: VOut;
  out.pos = u.mvp * vec4<f32>(world, 1.0);
  out.modulus = 0.0;
  return out;
}

@fragment
fn fs_axis(in: VOut) -> @location(0) vec4<f32> {
  return vec4<f32>(0.55, 0.55, 0.55, 1.0);
}
`;
  assertNoReservedIdentifiers(wgsl, "polar_trace_renderer");
  return wgsl;
}
