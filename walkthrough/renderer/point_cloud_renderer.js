// WebGPU renderer for walkthrough.v1.PointCloudBlock.
//
// Loads (binbuf, manifest.json[, labels.tsv]) referenced by the
// block and draws each row as an instanced Gaussian splat — six
// vertices per quad, screen-aligned, colored by a diverging cool-
// warm colormap of the per-vertex `value` scalar.
//
// Per-vertex layout in binbuf (matches manifest.stride_bytes = 20):
//
//     pos.xyz (3×f32) | kind (u32) | value (f32)
//
// We render the struct as five scalars (px, py, pz, kind, value) so
// WGSL's storage-array stride stays 20 bytes; vec3<f32> would force
// 16-byte alignment and a 32-byte stride that doesn't match the
// packed buffer.
//
// Orbit-camera controls: drag to orbit, wheel to zoom, shift-drag
// to pan. Identical interaction model to heightmap_renderer.

// Hull pass — draws each cluster's triangle-mesh ellipsoid as a
// translucent overlay. Vertex stage projects to clip space; fragment
// applies a per-cluster color (from mean Ricci through the same
// diverging colormap) and a Fresnel-style edge term so the ellipsoid
// reads as a solid volume rather than a flat polygon.
const HULL_WGSL = `
struct HullUniforms {
  view_proj: mat4x4<f32>,
  camera_pos: vec4<f32>,
  alpha: f32,
  _pad0: f32, _pad1: f32, _pad2: f32,
}

struct ClusterUniforms {
  color: vec4<f32>,   // rgb from colormap + a=fill alpha
  center: vec4<f32>,  // xyz=center, w=unused
}

@group(0) @binding(0) var<uniform> view: HullUniforms;
@group(0) @binding(1) var<uniform> cluster: ClusterUniforms;

struct VOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0) world_pos: vec3<f32>,
  @location(1) view_dir: vec3<f32>,
  @location(2) center_offset: vec3<f32>,
}

@vertex
fn vs_main(@location(0) pos: vec3<f32>) -> VOut {
  var out: VOut;
  out.clip_pos = view.view_proj * vec4<f32>(pos, 1.0);
  out.world_pos = pos;
  out.view_dir = normalize(view.camera_pos.xyz - pos);
  out.center_offset = pos - cluster.center.xyz;
  return out;
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  // Approximate surface normal as normalized offset from center
  // — exact for ellipsoids of uniform aspect; fine for the
  // visualization.
  let n = normalize(in.center_offset);
  let ndv = abs(dot(n, in.view_dir));
  // Fresnel-ish term — bright at glancing angles, dim at face-on.
  // Plus a soft volumetric base so face-on regions aren't invisible.
  let fres = pow(1.0 - ndv, 2.0);
  let base = 0.18;
  let intensity = base + fres * 0.7;
  return vec4<f32>(cluster.color.rgb * intensity, cluster.color.a * view.alpha);
}
`;

function colormapDiverging(t) {
  const s = Math.max(-1, Math.min(1, t));
  const cold = [0.140, 0.270, 0.560];
  const mid  = [0.960, 0.940, 0.910];
  const warm = [0.700, 0.100, 0.150];
  const lerp = (a, b, k) => [a[0]+(b[0]-a[0])*k, a[1]+(b[1]-a[1])*k, a[2]+(b[2]-a[2])*k];
  return s < 0 ? lerp(mid, cold, -s) : lerp(mid, warm, s);
}

const POINT_CLOUD_WGSL = `
struct ViewUniforms {
  view_proj: mat4x4<f32>,
  camera_pos: vec4<f32>,
  splat_radius: f32,
  value_abs_max: f32,
  alpha: f32,
  _pad0: f32,
}

struct Vertex {
  px: f32,
  py: f32,
  pz: f32,
  kind: u32,
  value: f32,
}

@group(0) @binding(0) var<uniform> view: ViewUniforms;
@group(0) @binding(1) var<storage, read> vertices: array<Vertex>;

struct VOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0) quad_uv: vec2<f32>,
  @location(1) val_norm: f32,
  @location(2) @interpolate(flat) kind: u32,
}

const QUAD_OFFSETS = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0),
  vec2<f32>( 1.0, -1.0),
  vec2<f32>(-1.0,  1.0),
  vec2<f32>(-1.0,  1.0),
  vec2<f32>( 1.0, -1.0),
  vec2<f32>( 1.0,  1.0),
);

@vertex
fn vs_main(
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) iid: u32,
) -> VOut {
  let v = vertices[iid];
  let center = view.view_proj * vec4<f32>(v.px, v.py, v.pz, 1.0);
  let offset_world = QUAD_OFFSETS[vid] * view.splat_radius;
  var out: VOut;
  out.clip_pos = vec4<f32>(
    center.x + offset_world.x * center.w,
    center.y + offset_world.y * center.w,
    center.z,
    center.w,
  );
  out.quad_uv = QUAD_OFFSETS[vid];
  out.val_norm = clamp(v.value / max(view.value_abs_max, 1e-9), -1.0, 1.0);
  out.kind = v.kind;
  return out;
}

fn colormap_diverging(t: f32) -> vec3<f32> {
  let s = clamp(t, -1.0, 1.0);
  let cold = vec3<f32>(0.140, 0.270, 0.560);
  let mid  = vec3<f32>(0.960, 0.940, 0.910);
  let warm = vec3<f32>(0.700, 0.100, 0.150);
  if (s < 0.0) {
    return mix(mid, cold, -s);
  } else {
    return mix(mid, warm,  s);
  }
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let r2 = dot(in.quad_uv, in.quad_uv);
  if (r2 > 1.0) { discard; }
  let gauss = exp(-3.0 * r2);
  let color = colormap_diverging(in.val_norm);
  var tint = vec3<f32>(1.0);
  if (in.kind == 1u)      { tint = vec3<f32>(1.00, 1.05, 1.05); }
  else if (in.kind == 2u) { tint = vec3<f32>(1.05, 1.00, 0.95); }
  else if (in.kind == 3u) { tint = vec3<f32>(1.00, 1.00, 1.10); }
  else if (in.kind == 4u) { tint = vec3<f32>(0.90, 1.05, 0.95); }
  return vec4<f32>(color * tint, gauss * view.alpha);
}
`;

export function renderPointCloud(block) {
  const spec = block.pointCloud || block.point_cloud || {};
  const W = spec.widthPx || spec.width_px || 720;
  const H = spec.heightPx || spec.height_px || 480;

  const el = document.createElement("div");
  el.className = "block point-cloud";

  if (!navigator.gpu) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.style.height = `${H}px`;
    ph.style.display = "flex";
    ph.style.alignItems = "center";
    ph.style.justifyContent = "center";
    ph.textContent =
      "[point_cloud: WebGPU not available. " +
      "Try Chrome/Edge ≥ 113, Safari 18+, or Firefox with " +
      "dom.webgpu.enabled.]";
    el.appendChild(ph);
    return el;
  }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.cursor = "grab";
  canvas.style.display = "block";
  el.appendChild(canvas);

  const status = document.createElement("div");
  status.className = "caption point-cloud-status";
  status.textContent = "loading…";
  el.appendChild(status);

  if (spec.caption) {
    const cap = document.createElement("div");
    cap.className = "caption";
    cap.textContent = spec.caption;
    el.appendChild(cap);
  }

  const negLabel = spec.legendLabelNegative || spec.legend_label_negative;
  const zeroLabel = spec.legendLabelZero || spec.legend_label_zero;
  const posLabel = spec.legendLabelPositive || spec.legend_label_positive;
  if (negLabel || zeroLabel || posLabel) {
    const legend = document.createElement("div");
    legend.className = "point-cloud-legend";
    legend.innerHTML = `
      <div class="bar"></div>
      <div class="bar-labels">
        <span>${negLabel || "negative"}</span>
        <span>${zeroLabel || "zero"}</span>
        <span>${posLabel || "positive"}</span>
      </div>
    `;
    el.appendChild(legend);
  }

  const bufUri      = spec.vertexBufferUri || spec.vertex_buffer_uri;
  const manifestUri = spec.manifestUri || spec.manifest_uri;
  const clustersUri = spec.clustersUri || spec.clusters_uri;
  if (!bufUri || !manifestUri) {
    status.textContent = "[point_cloud: missing vertex_buffer_uri or manifest_uri]";
    return el;
  }

  _start(canvas, status, spec, bufUri, manifestUri, clustersUri).catch((err) => {
    console.error(err);
    status.textContent = `[point_cloud: ${err.message}]`;
  });

  return el;
}

async function _start(canvas, status, spec, bufUri, manifestUri, clustersUri) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();

  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });

  status.textContent = "fetching data…";
  const fetches = [fetch(manifestUri), fetch(bufUri)];
  if (clustersUri) fetches.push(fetch(clustersUri));
  const responses = await Promise.all(fetches);
  const [manifestResp, bufResp, clustersResp] = responses;
  if (!manifestResp.ok || !bufResp.ok) {
    throw new Error(`fetch failed: manifest=${manifestResp.status} buf=${bufResp.status}`);
  }
  const manifest = await manifestResp.json();
  const bufBytes = new Uint8Array(await bufResp.arrayBuffer());
  let clustersData = null;
  if (clustersResp && clustersResp.ok) {
    clustersData = await clustersResp.json();
  }

  const N = manifest.n_vertices;
  const STRIDE = manifest.stride_bytes;
  if (bufBytes.byteLength !== N * STRIDE) {
    throw new Error(`buffer size mismatch: ${bufBytes.byteLength} != ${N} * ${STRIDE}`);
  }

  const vertexStorage = device.createBuffer({
    size: bufBytes.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexStorage, 0, bufBytes);

  const VIEW_BYTES = 16 * 4 + 4 * 4 + 4 * 4; // mat4 + vec4 + 4 floats = 96
  const viewUniform = device.createBuffer({
    size: VIEW_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const module = device.createShaderModule({ code: POINT_CLOUD_WGSL });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module, entryPoint: "fs_main",
      targets: [{
        format,
        blend: {
          color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { operation: "add", srcFactor: "one",       dstFactor: "one-minus-src-alpha" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: viewUniform } },
      { binding: 1, resource: { buffer: vertexStorage } },
    ],
  });

  // === Hull pass (optional) =============================================
  // One pipeline shared across all clusters; per-cluster vertex/index
  // buffers + uniforms (color, center).
  let hullPipeline = null;
  let hullViewUniform = null;
  let hulls = [];   // [{vbuf, ibuf, indexCount, clusterUniform, bindGroup}]
  if (clustersData && clustersData.clusters && clustersData.clusters.length > 0) {
    const hullModule = device.createShaderModule({ code: HULL_WGSL });
    hullPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: hullModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        }],
      },
      fragment: {
        module: hullModule,
        entryPoint: "fs_main",
        targets: [{
          format,
          blend: {
            color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { operation: "add", srcFactor: "one",       dstFactor: "one-minus-src-alpha" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });

    // View uniform — vp(64) + camera_pos(16) + 4 floats = 96 bytes.
    const HULL_VIEW_BYTES = 16 * 4 + 4 * 4 + 4 * 4;
    hullViewUniform = device.createBuffer({
      size: HULL_VIEW_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const absMaxForHullColor = manifest.value_abs_max ?? manifest.ricci_abs_max ?? 1.0;
    for (const cl of clustersData.clusters) {
      const verts = new Float32Array(cl.vertices);
      const idx = new Uint32Array(cl.indices);
      const vbuf = device.createBuffer({
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(vbuf, 0, verts);
      const ibuf = device.createBuffer({
        size: idx.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(ibuf, 0, idx);

      // Per-cluster uniform: color (4 floats) + center (4 floats) = 32 B.
      const clusterUniform = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const t = cl.mean_ricci / Math.max(absMaxForHullColor, 1e-9);
      const rgb = colormapDiverging(t);
      const fillAlpha = 0.20;
      const cu = new Float32Array(8);
      cu[0] = rgb[0]; cu[1] = rgb[1]; cu[2] = rgb[2]; cu[3] = fillAlpha;
      cu[4] = cl.center[0]; cu[5] = cl.center[1]; cu[6] = cl.center[2]; cu[7] = 0;
      device.queue.writeBuffer(clusterUniform, 0, cu);

      const bg = device.createBindGroup({
        layout: hullPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: hullViewUniform } },
          { binding: 1, resource: { buffer: clusterUniform } },
        ],
      });
      hulls.push({ vbuf, ibuf, indexCount: idx.length, bindGroup: bg });
    }
  }

  const bboxMin = manifest.bbox_min;
  const bboxMax = manifest.bbox_max;
  const center = [
    (bboxMin[0] + bboxMax[0]) * 0.5,
    (bboxMin[1] + bboxMax[1]) * 0.5,
    (bboxMin[2] + bboxMax[2]) * 0.5,
  ];
  const span = Math.max(
    bboxMax[0] - bboxMin[0],
    bboxMax[1] - bboxMin[1],
    bboxMax[2] - bboxMin[2],
  );

  // `value_abs_max` (or legacy `ricci_abs_max`) — both keys accepted.
  const absMax = manifest.value_abs_max ?? manifest.ricci_abs_max ?? 1.0;

  const cam = {
    yaw: Math.PI / 4,
    pitch: Math.PI / 6,
    distance: span * 2.5,
    panX: 0, panY: 0,
  };
  let lastX = 0, lastY = 0, dragging = false, panning = false;
  canvas.addEventListener("mousedown", (e) => {
    lastX = e.clientX; lastY = e.clientY;
    dragging = true; panning = e.shiftKey;
    canvas.style.cursor = "grabbing";
  });
  window.addEventListener("mouseup", () => {
    dragging = false; canvas.style.cursor = "grab";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (panning) {
      cam.panX -= dx * 0.002 * cam.distance;
      cam.panY += dy * 0.002 * cam.distance;
    } else {
      cam.yaw   -= dx * 0.005;
      cam.pitch += dy * 0.005;
      cam.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, cam.pitch));
    }
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    cam.distance *= Math.exp(e.deltaY * 0.001);
    cam.distance = Math.max(span * 0.05, Math.min(span * 20, cam.distance));
  }, { passive: false });

  const splatRadius = spec.splatRadius || spec.splat_radius || 0.012;
  const alpha = spec.alpha || 0.85;

  status.textContent =
    `${N.toLocaleString()} points` +
    (manifest.model_version ? ` · ${manifest.model_version}` : "") +
    ` · value range [${(manifest.value_min ?? manifest.ricci_min)?.toFixed?.(3) ?? "?"}, ` +
    `${(manifest.value_max ?? manifest.ricci_max)?.toFixed?.(3) ?? "?"}]` +
    (hulls.length > 0 ? ` · ${hulls.length} cluster hulls` : "");

  function viewProj() {
    const aspect = canvas.width / canvas.height;
    const fov = Math.PI / 4;
    const near = span * 0.001;
    const far  = span * 100;
    const eye = [
      center[0] + cam.distance * Math.cos(cam.pitch) * Math.sin(cam.yaw) + cam.panX,
      center[1] + cam.distance * Math.sin(cam.pitch)                    + cam.panY,
      center[2] + cam.distance * Math.cos(cam.pitch) * Math.cos(cam.yaw),
    ];
    const tgt = [center[0] + cam.panX, center[1] + cam.panY, center[2]];
    return { vp: multiply(perspective(fov, aspect, near, far), lookAt(eye, tgt, [0, 1, 0])), eye };
  }

  function frame() {
    const { vp, eye } = viewProj();
    const uni = new Float32Array(VIEW_BYTES / 4);
    uni.set(vp, 0);
    uni.set(eye, 16); uni[19] = 1.0;
    uni[20] = splatRadius;
    uni[21] = absMax;
    uni[22] = alpha;
    uni[23] = 0.0;
    device.queue.writeBuffer(viewUniform, 0, uni);

    // Same view matrix → hull uniform, packed differently
    // (vp + camera_pos + alpha + 3 pad floats = 96 bytes).
    if (hullViewUniform) {
      const huni = new Float32Array(24);
      huni.set(vp, 0);
      huni.set(eye, 16); huni[19] = 1.0;
      huni[20] = alpha;
      device.queue.writeBuffer(hullViewUniform, 0, huni);
    }

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        clearValue: { r: 0.02, g: 0.025, b: 0.06, a: 1.0 },
        loadOp: "clear", storeOp: "store",
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6, N);

    // Hull pass — run inside the same render pass so the splats and
    // hulls composite over the same clear. Hulls draw after splats
    // so they appear above (with their own translucent blend).
    if (hullPipeline) {
      pass.setPipeline(hullPipeline);
      for (const h of hulls) {
        pass.setBindGroup(0, h.bindGroup);
        pass.setVertexBuffer(0, h.vbuf);
        pass.setIndexBuffer(h.ibuf, "uint32");
        pass.drawIndexed(h.indexCount);
      }
    }

    pass.end();
    device.queue.submit([enc.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// --- math helpers (column-major mat4) -----------------------------

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, (2 * far * near) * nf, 0,
  ]);
}

function lookAt(eye, target, up) {
  const z = norm3(sub3(eye, target));
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ]);
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    out[i * 4 + j] =
      a[0 * 4 + j] * b[i * 4 + 0] +
      a[1 * 4 + j] * b[i * 4 + 1] +
      a[2 * 4 + j] * b[i * 4 + 2] +
      a[3 * 4 + j] * b[i * 4 + 3];
  }
  return out;
}

function sub3(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function cross3(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function dot3(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function norm3(a) { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/n, a[1]/n, a[2]/n]; }
