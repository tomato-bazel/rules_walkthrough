// MVP renderer for walkthrough.v1.VizScene.
//
// Backend: SVG (matches the existing PlotBlock renderer's output
// shape, so axes/tick code can be reused later). Renders primitives
// top-to-bottom. Supports axis-aware coordinates (data → pixel via
// the Axes2D domain) and binding to DataSource sidecar fields.
//
// Animation (Timeline) is NOT supported here yet — the proto field
// exists for forward compatibility; renderer will pick it up when
// the Timeline animator lands (roadmap A3).
//
// Public entry:
//   renderVizScene(block) → HTMLDivElement
// The block is { vizScene: { ... } } in JSON-encoded camelCase.

import { sampleExpressionPlot } from "./math_eval.js";

const NS = "http://www.w3.org/2000/svg";
const DEFAULTS = {
  width: 620,
  height: 320,
  margin: { top: 20, right: 24, bottom: 36, left: 52 },
  pointColor: "#1f5fa8",
  pointRadius: 4,
  lineColor: "#444",
  lineWidth: 1.4,
  textColor: "#333",
  fontFamily: "monospace",
  fontSize: 12,
};

export function renderVizScene(block) {
  const el = document.createElement("div");
  el.className = "block viz-scene";
  // VizSceneBlock wraps a VizScene at `.scene` per the proto. Accept
  // both the wrapped form `{vizScene: {scene: {...}}}` and the
  // flattened authoring shortcut `{vizScene: {widthPx, primitives, ...}}`
  // — the latter is what intuition usually produces.
  const wrapper = block.vizScene || block.viz_scene || {};
  const scene = wrapper.scene || wrapper;
  const ds = scene.dataSource || scene.data_source;

  if (ds && ds.uri) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = `[scene: loading ${ds.uri}…]`;
    el.appendChild(ph);
    fetch(ds.uri, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(
        new Error(`HTTP ${r.status}`)))
      .then((bundle) => {
        el.removeChild(ph);
        el.appendChild(_buildSceneSvg(scene, bundle));
      })
      .catch((err) => {
        ph.textContent = `[scene: ${ds.uri}: ${err.message}]`;
      });
    return el;
  }

  el.appendChild(_buildSceneSvg(scene, null));
  return el;
}

function _buildSceneSvg(scene, bundle) {
  const W = scene.widthPx || DEFAULTS.width;
  const H = scene.heightPx || DEFAULTS.height;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("xmlns", NS);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.setAttribute("role", "img");

  // Backdrop
  if (scene.backgroundColor) {
    const bg = _el("rect", {
      x: 0, y: 0, width: W, height: H, fill: scene.backgroundColor,
    });
    svg.appendChild(bg);
  }

  const primitives = scene.primitives || [];
  const xform = _coordinateTransform(scene, primitives, bundle, W, H);

  // Layer order, back to front:
  //   1. Grid lines (faint, behind everything)
  //   2. Primitives (the data)
  //   3. Axis frame + ticks + tick labels (always readable)
  //   4. Axis markers (callouts like σ = 1/2 — always on top)
  if (scene.axes) {
    for (const child of _drawAxesBackground(scene.axes, xform)) {
      svg.appendChild(child);
    }
  }

  const registry = {};
  for (const prim of primitives) {
    const rec = _renderPrimitive(prim, xform, bundle);
    if (prim.id) registry[prim.id] = rec;
    for (const child of rec.nodes) svg.appendChild(child);
  }

  if (scene.axes) {
    for (const child of _drawAxesForeground(scene.axes, xform)) {
      svg.appendChild(child);
    }
  }

  const timeline = scene.timeline;
  if (timeline && (timeline.tracks || []).length) {
    _runTimeline(timeline, registry, xform);
  }
  return svg;
}

// ---------- timeline animator ----------

function _runTimeline(timeline, registry, xform) {
  const duration = timeline.durationMs || timeline.duration_ms || 1000;
  const loopCount = timeline.loopCount ?? timeline.loop_count ?? 0;
  const tracks = (timeline.tracks || []).map((t) => ({
    target_id: t.targetId || t.target_id,
    property: t.property,
    easing: t.easing || "linear",
    keyframes: (t.keyframes || []).map((k) => ({
      time: k.timeMs ?? k.time_ms ?? 0,
      value: k.value,
      valueStr: k.valueStr || k.value_str || null,
    })).sort((a, b) => a.time - b.time),
  }));

  let started = 0;
  let cycles = 0;

  function frame(now) {
    if (!started) started = now;
    const elapsed = now - started;
    let phase = elapsed % duration;
    if (loopCount > 0) {
      cycles = Math.floor(elapsed / duration);
      if (cycles >= loopCount) {
        // Freeze on the last frame and stop scheduling.
        phase = duration;
        _applyTracks(tracks, registry, xform, phase);
        return;
      }
    }
    _applyTracks(tracks, registry, xform, phase);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function _applyTracks(tracks, registry, xform, phase) {
  for (const track of tracks) {
    const rec = registry[track.target_id];
    if (!rec) continue;
    const v = _interpolate(track, phase);
    if (v === null) continue;
    _applyProperty(rec, track.property, v, xform);
  }
}

function _interpolate(track, t) {
  const kfs = track.keyframes;
  if (!kfs.length) return null;
  if (t <= kfs[0].time) return kfs[0].valueStr ?? kfs[0].value;
  if (t >= kfs[kfs.length - 1].time) {
    const last = kfs[kfs.length - 1];
    return last.valueStr ?? last.value;
  }
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span > 0 ? (t - a.time) / span : 0;
      const eased = _ease(track.easing, u);
      // Categorical (string) values: step at midpoint.
      if (a.valueStr != null || b.valueStr != null) {
        return eased < 0.5 ? (a.valueStr ?? a.value) : (b.valueStr ?? b.value);
      }
      return a.value + (b.value - a.value) * eased;
    }
  }
  return null;
}

function _ease(name, u) {
  switch (name) {
    case "ease_in_out":
    case "easeInOut":
      return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    case "step":
      return u < 0.5 ? 0 : 1;
    default:
      return u;
  }
}

function _applyProperty(rec, property, value, xform) {
  switch (property) {
    case "opacity":
      for (const n of rec.nodes) n.setAttribute("opacity", String(value));
      return;
    case "radius":
      if (rec.kind !== "points") return;
      for (const n of rec.nodes) n.setAttribute("r", String(value));
      return;
    case "color":
      {
        const attr = rec.kind === "points" || rec.kind === "rect" ? "fill" : "stroke";
        for (const n of rec.nodes) n.setAttribute(attr, String(value));
      }
      return;
    case "x":
      if (rec.kind === "points" && rec.nodes[0]) {
        rec.nodes[0].setAttribute("cx", String(xform.xPx(value).toFixed(2)));
      }
      return;
    case "y":
      if (rec.kind === "points" && rec.nodes[0]) {
        rec.nodes[0].setAttribute("cy", String(xform.yPx(value).toFixed(2)));
      }
      return;
    default:
      // Unknown property — silently ignore. Console.warn would
      // spam an authoring session.
      return;
  }
}

// ---------- coordinate transform ----------

function _coordinateTransform(scene, primitives, bundle, W, H) {
  const m = DEFAULTS.margin;
  const plot = {
    x0: m.left, x1: W - m.right,
    y0: m.top,  y1: H - m.bottom,
  };
  const axes = scene.axes;
  if (!axes) {
    return {
      hasAxes: false,
      plot, m,
      xPx: (x) => x,
      yPx: (y) => y,
      xDomain: [0, W], yDomain: [H, 0],
    };
  }
  // Use `??` not `||` so negative domains and zero bounds are
  // honored correctly. A bound is "specified" iff it's not null /
  // undefined; zero is a perfectly valid bound (e.g. yMin = 0).
  const xMin = axes.xMin ?? axes.x_min ?? null;
  const xMax = axes.xMax ?? axes.x_max ?? null;
  const yMin = axes.yMin ?? axes.y_min ?? null;
  const yMax = axes.yMax ?? axes.y_max ?? null;
  const xSpecified = xMin !== null || xMax !== null;
  const ySpecified = yMin !== null || yMax !== null;

  const allX = [];
  const allY = [];
  if (!xSpecified || !ySpecified) {
    for (const p of primitives) _collectPrimExtents(p, bundle, allX, allY);
  }
  const xDomain = xSpecified
    ? [xMin ?? _extent(allX, 0, 1)[0], xMax ?? _extent(allX, 0, 1)[1]]
    : _extent(allX, 0, 1);
  const yDomain = ySpecified
    ? [yMin ?? _extent(allY, 0, 1)[0], yMax ?? _extent(allY, 0, 1)[1]]
    : _extent(allY, 0, 1);
  const xPx = (x) => plot.x0 +
    ((x - xDomain[0]) / (xDomain[1] - xDomain[0])) * (plot.x1 - plot.x0);
  const yPx = (y) => plot.y1 -
    ((y - yDomain[0]) / (yDomain[1] - yDomain[0])) * (plot.y1 - plot.y0);
  return { hasAxes: true, plot, m, xPx, yPx, xDomain, yDomain };
}

function _extent(arr, fallbackLo, fallbackHi) {
  const finite = arr.filter(Number.isFinite);
  if (finite.length === 0) return [fallbackLo, fallbackHi];
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    lo -= pad; hi += pad;
  }
  return [lo, hi];
}

function _collectPrimExtents(prim, bundle, allX, allY) {
  const p = prim.points || prim.polyline;
  if (p) {
    if (p.expression && p.expression.expression) {
      try {
        const sampled = sampleExpressionPlot(p.expression);
        allX.push(...sampled.xs);
        allY.push(...sampled.ys.filter(Number.isFinite));
      } catch (e) {
        // fall through
      }
    } else {
      const xs = _resolveArray(p.x, p.xBinding || p.x_binding, bundle);
      const ys = _resolveArray(p.y, p.yBinding || p.y_binding, bundle);
      allX.push(...xs); allY.push(...ys);
    }
  }
  const l = prim.lines;
  if (l) {
    allX.push(...(l.x1 || []), ...(l.x2 || []));
    allY.push(...(l.y1 || []), ...(l.y2 || []));
  }
  const r = prim.rect;
  if (r) {
    allX.push(r.x || 0, (r.x || 0) + (r.width || 0));
    allY.push(r.y || 0, (r.y || 0) + (r.height || 0));
  }
  const t = prim.text;
  if (t) {
    allX.push(t.x || 0); allY.push(t.y || 0);
  }
}

// ---------- axes ----------

function _drawAxesBackground(axes, xform) {
  // Gridlines only — drawn before primitives.
  const out = [];
  if (!(axes.showGrid || axes.show_grid)) return out;
  for (const t of _ticks(xform.xDomain[0], xform.xDomain[1])) {
    const px = xform.xPx(t);
    out.push(_el("line", {
      x1: px, x2: px, y1: xform.plot.y0, y2: xform.plot.y1,
      stroke: "#eee", "stroke-width": 1,
    }));
  }
  for (const t of _ticks(xform.yDomain[0], xform.yDomain[1])) {
    const py = xform.yPx(t);
    out.push(_el("line", {
      x1: xform.plot.x0, x2: xform.plot.x1, y1: py, y2: py,
      stroke: "#eee", "stroke-width": 1,
    }));
  }
  return out;
}

function _drawAxesForeground(axes, xform) {
  // Frame + ticks + tick labels + markers + axis labels.
  // Drawn after primitives so they're always readable.
  const out = [];
  const plotW = xform.plot.x1 - xform.plot.x0;
  const plotH = xform.plot.y1 - xform.plot.y0;
  // Frame
  out.push(_el("rect", {
    x: xform.plot.x0, y: xform.plot.y0,
    width: plotW, height: plotH,
    fill: "none", stroke: "#bbb", "stroke-width": 1,
  }));
  // x ticks
  for (const t of _ticks(xform.xDomain[0], xform.xDomain[1])) {
    const px = xform.xPx(t);
    out.push(_el("line", {
      x1: px, x2: px, y1: xform.plot.y1, y2: xform.plot.y1 + 4,
      stroke: "#666",
    }));
    out.push(_text(px, xform.plot.y1 + 16, _fmtTick(t), {
      anchor: "middle", color: "#555", size: 10,
    }));
  }
  // y ticks
  for (const t of _ticks(xform.yDomain[0], xform.yDomain[1])) {
    const py = xform.yPx(t);
    out.push(_el("line", {
      x1: xform.plot.x0 - 4, x2: xform.plot.x0, y1: py, y2: py,
      stroke: "#666",
    }));
    out.push(_text(xform.plot.x0 - 7, py + 3, _fmtTick(t), {
      anchor: "end", color: "#555", size: 10,
    }));
  }
  // Markers — on top so they always read
  for (const mk of (axes.xMarkers || axes.x_markers || [])) {
    const px = xform.xPx(mk.value);
    out.push(_el("line", {
      x1: px, x2: px, y1: xform.plot.y0, y2: xform.plot.y1,
      stroke: mk.color || "#1f5fa8",
      "stroke-width": 1.5,
      "stroke-dasharray": mk.dashed ? "6 4" : null,
    }));
    if (mk.label) {
      out.push(_text(px, xform.plot.y0 - 4, mk.label, {
        anchor: "middle", color: mk.color || "#1f5fa8", size: 11,
      }));
    }
  }
  for (const mk of (axes.yMarkers || axes.y_markers || [])) {
    const py = xform.yPx(mk.value);
    out.push(_el("line", {
      x1: xform.plot.x0, x2: xform.plot.x1, y1: py, y2: py,
      stroke: mk.color || "#1f5fa8",
      "stroke-width": 1.5,
      "stroke-dasharray": mk.dashed ? "6 4" : null,
    }));
    if (mk.label) {
      out.push(_text(xform.plot.x1 - 4, py - 4, mk.label, {
        anchor: "end", color: mk.color || "#1f5fa8", size: 11,
      }));
    }
  }
  // Axis labels
  if (axes.xLabel || axes.x_label) {
    out.push(_text(
      (xform.plot.x0 + xform.plot.x1) / 2,
      xform.plot.y1 + 32,
      axes.xLabel || axes.x_label,
      { anchor: "middle", color: "#333", size: 12 },
    ));
  }
  if (axes.yLabel || axes.y_label) {
    const t = _text(
      14, (xform.plot.y0 + xform.plot.y1) / 2,
      axes.yLabel || axes.y_label,
      { anchor: "middle", color: "#333", size: 12 },
    );
    t.setAttribute("transform",
      `rotate(-90, 14, ${(xform.plot.y0 + xform.plot.y1) / 2})`);
    out.push(t);
  }
  return out;
}

function _fmtTick(v) {
  // Avoid "0.5000000001" style ticks from the rounding in _ticks.
  if (Math.abs(v) < 1e-12) return "0";
  const a = Math.abs(v);
  if (a < 0.01 || a >= 1e4) return v.toExponential(1);
  return Number(v.toFixed(3)).toString();
}

function _ticks(lo, hi, count = 5) {
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) return [lo];
  const step = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step)));
  const norm = step / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const stepNice = nice * mag;
  const start = Math.ceil(lo / stepNice) * stepNice;
  const out = [];
  for (let v = start; v <= hi + 1e-9; v += stepNice) {
    out.push(Number(v.toPrecision(6)));
  }
  return out;
}

// ---------- primitive rendering ----------

function _renderPrimitive(prim, xform, bundle) {
  if (prim.points) {
    return { kind: "points", nodes: _renderPoints(prim.points, xform, bundle) };
  }
  if (prim.lines) {
    return { kind: "lines", nodes: _renderLines(prim.lines, xform) };
  }
  if (prim.polyline) {
    return { kind: "polyline", nodes: _renderPolyline(prim.polyline, xform, bundle) };
  }
  if (prim.rect) {
    return { kind: "rect", nodes: _renderRect(prim.rect, xform) };
  }
  if (prim.text) {
    return { kind: "text", nodes: _renderText(prim.text, xform) };
  }
  return { kind: "unknown", nodes: [] };
}

function _renderPoints(p, xform, bundle) {
  const xs = _resolveArray(p.x, p.xBinding || p.x_binding, bundle);
  const ys = _resolveArray(p.y, p.yBinding || p.y_binding, bundle);
  const r = p.radius ?? DEFAULTS.pointRadius;
  const color = p.color || DEFAULTS.pointColor;
  const opacity = p.opacity ?? 1;
  const out = [];
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    out.push(_el("circle", {
      cx: xform.xPx(xs[i]).toFixed(2),
      cy: xform.yPx(ys[i]).toFixed(2),
      r,
      fill: color,
      "fill-opacity": opacity,
    }));
  }
  return out;
}

function _renderLines(p, xform) {
  const x1 = p.x1 || [], y1 = p.y1 || [];
  const x2 = p.x2 || [], y2 = p.y2 || [];
  const color = p.color || DEFAULTS.lineColor;
  const width = p.width || DEFAULTS.lineWidth;
  const dash = p.dashed ? "6 4" : null;
  const out = [];
  const n = Math.min(x1.length, y1.length, x2.length, y2.length);
  for (let i = 0; i < n; i++) {
    out.push(_el("line", {
      x1: xform.xPx(x1[i]),
      y1: xform.yPx(y1[i]),
      x2: xform.xPx(x2[i]),
      y2: xform.yPx(y2[i]),
      stroke: color,
      "stroke-width": width,
      "stroke-dasharray": dash,
    }));
  }
  return out;
}

function _renderPolyline(p, xform, bundle) {
  let xs, ys;
  if (p.expression && p.expression.expression) {
    try {
      const sampled = sampleExpressionPlot(p.expression);
      xs = sampled.xs;
      ys = sampled.ys;
    } catch (e) {
      console.warn("ExpressionPlot eval failed:", e.message);
      return [];
    }
  } else {
    xs = _resolveArray(p.x, p.xBinding || p.x_binding, bundle);
    ys = _resolveArray(p.y, p.yBinding || p.y_binding, bundle);
  }
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return [];
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push(`${xform.xPx(xs[i]).toFixed(2)},${xform.yPx(ys[i]).toFixed(2)}`);
  }
  return [_el(p.closed ? "polygon" : "polyline", {
    points: pts.join(" "),
    stroke: p.color || DEFAULTS.lineColor,
    "stroke-width": p.width || DEFAULTS.lineWidth,
    fill: p.fill || "none",
    "stroke-linejoin": "round",
  })];
}

function _renderRect(p, xform) {
  const x = xform.xPx(p.x || 0);
  const y = xform.yPx((p.y || 0) + (p.height || 0));
  const w = xform.xPx((p.x || 0) + (p.width || 0)) - x;
  const h = xform.yPx(p.y || 0) - y;
  const opacity = p.opacity ?? 1;
  return [_el("rect", {
    x, y, width: Math.abs(w), height: Math.abs(h),
    fill: p.fill || "none",
    // Only stroke when explicitly requested. Defaulting to a line
    // color produced a strong border around fill rectangles that
    // overpowered the muted fill.
    stroke: p.color || "none",
    "fill-opacity": opacity,
    "stroke-opacity": opacity,
  })];
}

function _renderText(p, xform) {
  return [_text(
    xform.xPx(p.x || 0),
    xform.yPx(p.y || 0),
    p.text || "",
    {
      anchor: p.anchor || "start",
      color: p.color || DEFAULTS.textColor,
      family: p.fontFamily || p.font_family || DEFAULTS.fontFamily,
      size: p.fontSize || p.font_size || DEFAULTS.fontSize,
    },
  )];
}

// ---------- helpers ----------

function _el(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    e.setAttribute(k, String(v));
  }
  return e;
}

function _text(x, y, txt, opts = {}) {
  const e = _el("text", {
    x, y,
    "text-anchor": opts.anchor || "start",
    "font-family": opts.family || DEFAULTS.fontFamily,
    "font-size": opts.size || DEFAULTS.fontSize,
    fill: opts.color || DEFAULTS.textColor,
  });
  e.textContent = txt;
  return e;
}

function _resolveArray(inline, binding, bundle) {
  if (Array.isArray(inline) && inline.length) return inline;
  if (binding && bundle) {
    const parts = binding.split(".");
    let cur = bundle;
    for (const p of parts) {
      if (cur == null) break;
      // Allow bracket indexing for "arrays[name]" forms
      cur = cur[p];
    }
    if (Array.isArray(cur)) return cur;
  }
  return [];
}
