// WebGPU renderer for walkthrough.v1.ZetaDomainColoringBlock.
//
// Per-pixel domain coloring of ζ over a rectangle in the (σ, t) plane:
//   hue   = arg(ζ)              — full rainbow around each zero
//   value = soft tone-map of |ζ| — bright peaks, dim near zeros
// Optional Wegert-style contour bands on phase or log|ζ|.
//
// Single pipeline, single full-screen triangle. The fragment shader
// does the entire ζ evaluation (200-term Dirichlet-eta) per pixel.
// At 800×600 that's ~480K pixel evaluations per frame; not cheap,
// but it's a static image so we render once and stop.

import { onceVisible } from "./webgpu_util.js";
import {
  HSV_TO_RGB, ZETA_COMPLEX_DIRICHLET_ETA,
  assertNoReservedIdentifiers,
} from "./wgsl_common.js";

export function renderZetaDomainColoring(block) {
  const el = document.createElement("div");
  el.className = "block zeta-domain-coloring";
  const spec = block.zetaDomainColoring || block.zeta_domain_coloring || {};
  const W = spec.widthPx || spec.width_px || 720;
  const H = spec.heightPx || spec.height_px || 540;

  if (!navigator.gpu) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.style.height = `${H}px`;
    ph.style.display = "flex";
    ph.style.alignItems = "center";
    ph.style.justifyContent = "center";
    ph.textContent =
      "[zeta domain coloring: WebGPU not available. Try Chrome/Edge ≥ 113.]";
    el.appendChild(ph);
    return el;
  }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.display = "block";
  canvas.style.margin = "0 auto";
  el.appendChild(canvas);

  const hud = document.createElement("div");
  hud.style.fontFamily = "monospace";
  hud.style.fontSize = "11px";
  hud.style.color = "#666";
  hud.style.textAlign = "center";
  hud.style.marginTop = "0.3rem";
  hud.textContent =
    `hue = arg(ζ) · brightness = |ζ| · σ ∈ [${spec.sigmaMin ?? spec.sigma_min ?? -4}, ${spec.sigmaMax ?? spec.sigma_max ?? 4}], t ∈ [${spec.tMin ?? spec.t_min ?? -30}, ${spec.tMax ?? spec.t_max ?? 30}]`;
  el.appendChild(hud);

  onceVisible(canvas, () => {
    _init(canvas, spec).catch((err) => {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = `[domain coloring init failed: ${err.message}]`;
      el.appendChild(ph);
    });
  });
  return el;
}

async function _init(canvas, spec) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });

  const sigmaMin = spec.sigmaMin ?? spec.sigma_min ?? -4;
  const sigmaMax = spec.sigmaMax ?? spec.sigma_max ?? 4;
  const tMin = spec.tMin ?? spec.t_min ?? -30;
  const tMax = spec.tMax ?? spec.t_max ?? 30;
  const phaseBands = spec.phaseBands || spec.phase_bands || 0;
  const magBands = spec.magnitudeBands || spec.magnitude_bands || 0;
  const showCritical = spec.showCriticalLine ?? spec.show_critical_line ?? true;

  // Uniforms: viewport(4) + cfg(4) = 32 bytes
  const ubuf = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(ubuf, 0, new Float32Array([
    sigmaMin, sigmaMax, tMin, tMax,
    phaseBands, magBands, showCritical ? 1.0 : 0.0, 0,
  ]));

  // Prefer the Bazel-built shader; fall back to inline.
  let code;
  try {
    const mod = await import("./shaders/domain_coloring.wgsl.js");
    code = mod.default || mod;
  } catch (err) {
    console.warn("domain_coloring: pre-built shader unavailable:", err.message);
    code = _wgsl();
  }
  const module = device.createShaderModule({ code });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main", buffers: [] },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: ubuf } }],
  });

  // One-shot render. The image is static; no animation loop needed.
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: ctx.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

function _wgsl() {
  const wgsl = `
struct Uniforms {
  viewport: vec4<f32>,  // sigma_min, sigma_max, t_min, t_max
  cfg: vec4<f32>,       // phase_bands, mag_bands, show_critical, _
}
@group(0) @binding(0) var<uniform> u: Uniforms;

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

const PI: f32 = 3.14159265358979;
const TWO_PI: f32 = 6.28318530717959;

${ZETA_COMPLEX_DIRICHLET_ETA}
${HSV_TO_RGB}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let sigma = mix(u.viewport.x, u.viewport.y, in.uv.x);
  let t = mix(u.viewport.z, u.viewport.w, 1.0 - in.uv.y);

  let z = zeta_complex(sigma, t);
  let mag = length(z);
  let phase_z = atan2(z.y, z.x);

  let hue = (phase_z + PI) / TWO_PI;

  // Tone-map |ζ|: gentle curve so both small and large values render.
  let v_base = pow(mag / (mag + 1.0), 0.45);
  var v = mix(0.18, 1.0, v_base);

  // Wegert-style phase contour bands.
  if (u.cfg.x > 0.5) {
    let bands = u.cfg.x;
    let band_pos = fract(hue * bands);
    let edge = min(band_pos, 1.0 - band_pos);
    let w = fwidth(hue * bands) * 0.7;
    let line = smoothstep(0.0, w, edge);
    v = v * mix(0.65, 1.0, line);
  }

  // Log-magnitude contour bands.
  if (u.cfg.y > 0.5) {
    let lm = log(mag + 1e-9);
    let bands = u.cfg.y;
    let band_pos = fract(lm * 0.7);
    let edge = min(band_pos, 1.0 - band_pos);
    let w = fwidth(lm * 0.7) * 0.7;
    let line = smoothstep(0.0, w, edge);
    v = v * mix(0.78, 1.0, line);
  }

  var rgb = hsv_to_rgb(hue, 1.0, v);

  // Critical-line dashed overlay at σ = 0.5.
  if (u.cfg.z > 0.5) {
    let sigma_uv_pos = (0.5 - u.viewport.x) / (u.viewport.y - u.viewport.x);
    let d = abs(in.uv.x - sigma_uv_pos);
    let w = 0.003;
    let dashed = step(0.5, fract(t * 0.4));
    let line = smoothstep(w, 0.0, d) * dashed;
    rgb = mix(rgb, vec3<f32>(0.95, 0.95, 0.95), 0.7 * line);
  }

  return vec4<f32>(rgb, 1.0);
}
`;
  assertNoReservedIdentifiers(wgsl, "domain_coloring_renderer");
  return wgsl;
}
