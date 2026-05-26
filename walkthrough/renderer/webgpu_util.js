// Shared WebGPU helpers used by every 3D visualizer (heightmap,
// polar trace, future blocks). Pure math + DOM interaction; no
// device or context. Each block module owns its own pipeline +
// shader.

// ---------- camera math (right-handed, +z up) ----------

export function orbitView({ azimuth, elevation, distance }) {
  const eye = [
    distance * Math.cos(elevation) * Math.cos(azimuth),
    distance * Math.cos(elevation) * Math.sin(azimuth),
    distance * Math.sin(elevation),
  ];
  return lookAt(eye, [0, 0, 0], [0, 0, 1]);
}

export function lookAt(eye, target, up) {
  const f = norm(sub(target, eye));
  const s = norm(cross(f, up));
  const u = cross(s, f);
  // column-major mat4
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
  ]);
}

export function perspective(fovRad, aspect, near, far) {
  const f = 1 / Math.tan(fovRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function mul(a, b) {
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

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
export const deg = (d) => d * Math.PI / 180;

// ---------- orbit controls ----------

export function attachOrbitControls(canvas, cam) {
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
    cam.distance = Math.max(0.5, Math.min(50, cam.distance));
  }, { passive: false });
}

// ---------- misc ----------

export function niceStep(range, targetCount) {
  if (!isFinite(range) || range <= 0) return 1;
  const raw = range / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

// IntersectionObserver-gated callback. The block renderer calls
// this to defer WebGPU init until the canvas scrolls into view —
// otherwise every heightmap/trace on every slide would compile
// its pipeline at page load, even slides the user never visits.
export function onceVisible(el, cb) {
  if (typeof IntersectionObserver === "undefined") {
    cb();
    return;
  }
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        cb();
        obs.disconnect();
        return;
      }
    }
  }, { threshold: 0.01 });
  obs.observe(el);
}
