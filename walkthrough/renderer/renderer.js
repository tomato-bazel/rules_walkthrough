import { renderVizScene } from "./scene_renderer.js";
import { renderHeightmap } from "./heightmap_renderer.js";
import { renderVegaLite } from "./vega_renderer.js";
import { renderPolarTrace } from "./polar_trace_renderer.js";
import { renderPrimeLattice } from "./prime_lattice_renderer.js";
import { renderZetaDensity } from "./zeta_density_renderer.js";
import { renderZetaDomainColoring } from "./domain_coloring_renderer.js";
import { renderPointCloud } from "./point_cloud_renderer.js";
import { renderClusterIndex } from "./cluster_index_renderer.js";

// Walkthrough renderer (MVP).
//
// Consumes a JSON encoding of walkthrough.v1.Walkthrough
// fetched from walkthrough.json in the same directory. Supports the
// SlideBlock variants: text, equation, svg, image, code. Plot and
// canvas render placeholders for now.
//
// URL routing: ?slide=<slide_id> selects a slide; arrow keys / nav
// buttons advance.

const $ = (id) => document.getElementById(id);

async function loadWalkthrough() {
  const resp = await fetch("walkthrough.json", { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`failed to load walkthrough.json: ${resp.status}`);
  }
  return await resp.json();
}

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  if (theme.background) root.setProperty("--bg", theme.background);
  if (theme.foreground) root.setProperty("--fg", theme.foreground);
  if (theme.accent) root.setProperty("--accent", theme.accent);
  if (theme.codeBackground) root.setProperty("--code-bg", theme.codeBackground);
  if (theme.bodyFont) root.setProperty("--body-font", theme.bodyFont);
  if (theme.monoFont) root.setProperty("--mono-font", theme.monoFont);
}

function renderText(block) {
  const el = document.createElement("div");
  el.className = "block text";
  const md = (block.text && block.text.markdown) || "";
  el.innerHTML = window.marked ? window.marked.parse(md) : `<pre>${md}</pre>`;
  return el;
}

function renderEquation(block) {
  const el = document.createElement("div");
  el.className = "block equation";
  const latex = (block.equation && block.equation.latex) || "";
  if (window.katex) {
    window.katex.render(latex, el, { displayMode: true, throwOnError: false });
  } else {
    el.textContent = latex;
  }
  return el;
}

function renderSvg(block) {
  const el = document.createElement("div");
  el.className = "block svg";
  const svg = block.svg || {};
  if (svg.inlineSvg) {
    el.innerHTML = svg.inlineSvg;
  } else if (svg.assetPath) {
    const img = document.createElement("img");
    img.src = svg.assetPath;
    img.alt = "";
    el.appendChild(img);
  }
  return el;
}

function renderImage(block) {
  const el = document.createElement("figure");
  el.className = "block image";
  const img = block.image || {};
  const node = document.createElement("img");
  node.src = img.assetPath || "";
  node.alt = img.altText || "";
  if (img.maxWidthPx) node.style.maxWidth = `${img.maxWidthPx}px`;
  el.appendChild(node);
  if (img.altText) {
    const cap = document.createElement("figcaption");
    cap.textContent = img.altText;
    el.appendChild(cap);
  }
  return el;
}

function renderCode(block) {
  const el = document.createElement("div");
  el.className = "block code";
  const code = block.code || {};
  const lines = (code.source || "").split("\n");
  const highlight = new Set((code.highlightLines || []).map(Number));
  const pre = document.createElement("pre");
  pre.dataset.language = code.language || "";
  lines.forEach((line, i) => {
    const span = document.createElement("span");
    span.textContent = line + "\n";
    if (highlight.has(i + 1)) span.className = "hl";
    pre.appendChild(span);
  });
  el.appendChild(pre);
  return el;
}

// ---------- Plot rendering (inline SVG) ----------

const PLOT_DEFAULTS = {
  width: 540,
  height: 320,
  margin: { top: 14, right: 18, bottom: 38, left: 52 },
  palette: ["#1f5fa8", "#c0392b", "#27ae60", "#8e44ad", "#d68910", "#16a085"],
};

function _seriesExtent(allSeries, axis) {
  let lo = Infinity, hi = -Infinity;
  for (const s of allSeries) {
    const arr = s[axis] || [];
    for (const v of arr) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    return [lo - pad, hi + pad];
  }
  return [lo, hi];
}

function _makeScale(domain, range, log) {
  const [d0, d1] = log
    ? [Math.log10(Math.max(domain[0], 1e-300)),
       Math.log10(Math.max(domain[1], 1e-300))]
    : domain;
  const [r0, r1] = range;
  return (v) => {
    const x = log ? Math.log10(Math.max(v, 1e-300)) : v;
    return r0 + ((x - d0) / (d1 - d0)) * (r1 - r0);
  };
}

function _niceTicks(lo, hi, count = 5) {
  if (lo === hi) return [lo];
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

function _svg(tag, attrs = {}, children = []) {
  const NS = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of children) el.appendChild(c);
  return el;
}

function _drawAxes(svg, axes, xScale, yScale, plotW, plotH, m) {
  const tickColor = "#bbb";
  const labelColor = "#555";
  const fontFamily = "monospace";

  // axis lines
  svg.appendChild(_svg("line", {
    x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH,
    stroke: "#444",
  }));
  svg.appendChild(_svg("line", {
    x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH, stroke: "#444",
  }));

  // x ticks
  const xTicks = _niceTicks(axes.xDomain[0], axes.xDomain[1]);
  for (const t of xTicks) {
    const x = xScale(t);
    svg.appendChild(_svg("line", {
      x1: x, x2: x, y1: m.top + plotH, y2: m.top + plotH + 5,
      stroke: tickColor,
    }));
    const lbl = _svg("text", {
      x: x, y: m.top + plotH + 18, "text-anchor": "middle",
      "font-family": fontFamily, "font-size": 11, fill: labelColor,
    });
    lbl.textContent = String(t);
    svg.appendChild(lbl);
  }
  // y ticks
  const yTicks = _niceTicks(axes.yDomain[0], axes.yDomain[1]);
  for (const t of yTicks) {
    const y = yScale(t);
    svg.appendChild(_svg("line", {
      x1: m.left - 5, x2: m.left, y1: y, y2: y, stroke: tickColor,
    }));
    const lbl = _svg("text", {
      x: m.left - 8, y: y + 4, "text-anchor": "end",
      "font-family": fontFamily, "font-size": 11, fill: labelColor,
    });
    lbl.textContent = String(t);
    svg.appendChild(lbl);
  }
  // axis labels
  if (axes.xLabel) {
    const t = _svg("text", {
      x: m.left + plotW / 2, y: m.top + plotH + 34,
      "text-anchor": "middle", "font-family": fontFamily,
      "font-size": 12, fill: "#333",
    });
    t.textContent = axes.xLabel;
    svg.appendChild(t);
  }
  if (axes.yLabel) {
    const t = _svg("text", {
      x: 14, y: m.top + plotH / 2,
      "text-anchor": "middle", "font-family": fontFamily,
      "font-size": 12, fill: "#333",
      transform: `rotate(-90, 14, ${m.top + plotH / 2})`,
    });
    t.textContent = axes.yLabel;
    svg.appendChild(t);
  }
}

function _drawLegend(svg, series, palette, plotW, m) {
  const fontFamily = "monospace";
  let x = m.left + 10;
  const y = m.top + 4;
  series.forEach((s, i) => {
    const color = s.color || palette[i % palette.length];
    const name = s.name || `series ${i + 1}`;
    const swatch = _svg("rect", {
      x: x, y: y, width: 12, height: 12, fill: color,
    });
    svg.appendChild(swatch);
    const t = _svg("text", {
      x: x + 16, y: y + 10,
      "font-family": fontFamily, "font-size": 11, fill: "#333",
    });
    t.textContent = name;
    svg.appendChild(t);
    x += 18 + Math.max(40, name.length * 6 + 14);
  });
}

function _renderLineOrScatter(plot, axes, xScale, yScale, palette, isScatter) {
  const out = [];
  (plot.series || []).forEach((s, i) => {
    const color = s.color || palette[i % palette.length];
    const xs = s.x || [];
    const ys = s.y || [];
    const n = Math.min(xs.length, ys.length);
    if (!isScatter && n >= 2) {
      const pts = [];
      for (let j = 0; j < n; j++) {
        pts.push(`${xScale(xs[j]).toFixed(2)},${yScale(ys[j]).toFixed(2)}`);
      }
      out.push(_svg("polyline", {
        fill: "none", stroke: color, "stroke-width": 1.8,
        points: pts.join(" "),
      }));
    }
    for (let j = 0; j < n; j++) {
      out.push(_svg("circle", {
        cx: xScale(xs[j]).toFixed(2),
        cy: yScale(ys[j]).toFixed(2),
        r: isScatter ? 3 : 2.2,
        fill: color, "fill-opacity": isScatter ? 0.75 : 1,
      }));
    }
  });
  return out;
}

function _renderHistogram(plot, axes, xScale, yScale, palette) {
  // For histograms, each series.x is bin edges and series.y is counts
  // (length = len(x) - 1). If only y is provided, bins are auto.
  const out = [];
  (plot.series || []).forEach((s, i) => {
    const color = s.color || palette[i % palette.length];
    const ys = s.y || [];
    let edges = s.x;
    if (!edges || edges.length !== ys.length + 1) {
      edges = ys.map((_, j) => j);
      edges.push(ys.length);
    }
    for (let j = 0; j < ys.length; j++) {
      const x0 = xScale(edges[j]);
      const x1 = xScale(edges[j + 1]);
      const y0 = yScale(0);
      const y1 = yScale(ys[j]);
      out.push(_svg("rect", {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        width: Math.abs(x1 - x0) - 1,
        height: Math.abs(y1 - y0),
        fill: color, "fill-opacity": 0.65, stroke: color,
      }));
    }
  });
  return out;
}

function renderPlot(block) {
  const el = document.createElement("div");
  el.className = "block plot";
  const plot = block.plot || {};
  const ds = plot.dataSource || plot.data_source;

  if (ds && ds.uri) {
    // Loading placeholder; fetch the sidecar then merge into series.
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = `[plot: loading ${ds.uri}…]`;
    el.appendChild(ph);

    _loadDataSource(ds)
      .then((bundle) => {
        const merged = _mergeSeries(plot.series || [], bundle.series || []);
        el.removeChild(ph);
        _drawPlot(el, plot, merged);
      })
      .catch((err) => {
        ph.textContent = `[plot: ${ds.uri}: ${err.message}]`;
      });
    return el;
  }

  _drawPlot(el, plot, plot.series || []);
  return el;
}

function _drawPlot(el, plot, series) {
  const kind = (plot.kind || "LINE").toUpperCase();
  if (!series.length) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = `[plot: ${kind} — no series]`;
    el.appendChild(ph);
    return;
  }

  const W = plot.widthPx || PLOT_DEFAULTS.width;
  const H = plot.heightPx || PLOT_DEFAULTS.height;
  const m = PLOT_DEFAULTS.margin;
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;

  const axesIn = plot.axes || {};
  // Auto-fit when explicit ranges are 0/missing.
  const xDomain = (axesIn.xMin || axesIn.xMax)
    ? [axesIn.xMin || 0, axesIn.xMax || 1]
    : _seriesExtent(series, "x");
  const yDomain = (axesIn.yMin || axesIn.yMax)
    ? [axesIn.yMin || 0, axesIn.yMax || 1]
    : (kind === "HISTOGRAM"
        ? [0, _seriesExtent(series, "y")[1]]
        : _seriesExtent(series, "y"));

  const axes = {
    xLabel: axesIn.xLabel || "",
    yLabel: axesIn.yLabel || "",
    xDomain, yDomain,
  };

  const xScale = _makeScale(xDomain, [m.left, m.left + plotW], axesIn.xLog);
  const yScale = _makeScale(yDomain, [m.top + plotH, m.top], axesIn.yLog);

  const svg = _svg("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: `0 0 ${W} ${H}`,
    width: W, height: H, role: "img",
  });

  _drawAxes(svg, axes, xScale, yScale, plotW, plotH, m);

  // Use a synthetic plot view that points at the resolved series so
  // the existing draw helpers find them.
  const view = Object.assign({}, plot, { series });

  let marks;
  if (kind === "SCATTER") {
    marks = _renderLineOrScatter(view, axes, xScale, yScale,
                                 PLOT_DEFAULTS.palette, true);
  } else if (kind === "HISTOGRAM") {
    marks = _renderHistogram(view, axes, xScale, yScale,
                             PLOT_DEFAULTS.palette);
  } else if (kind === "HEATMAP") {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = `[plot: HEATMAP — renderer pending]`;
    el.appendChild(ph);
    return;
  } else {
    marks = _renderLineOrScatter(view, axes, xScale, yScale,
                                 PLOT_DEFAULTS.palette, false);
  }
  for (const m_ of marks) svg.appendChild(m_);

  if (series.length > 1 || (series[0] && series[0].name)) {
    _drawLegend(svg, series, PLOT_DEFAULTS.palette, plotW, m);
  }
  el.appendChild(svg);
}

// Sidecar series win on name collision; otherwise both are kept.
function _mergeSeries(inline, fromSidecar) {
  const byName = new Map();
  for (const s of inline) byName.set(s.name || `_inline_${byName.size}`, s);
  for (const s of fromSidecar) byName.set(s.name || `_sidecar_${byName.size}`, s);
  return Array.from(byName.values());
}

async function _loadDataSource(ds) {
  const resp = await fetch(ds.uri, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`fetch ${ds.uri}: HTTP ${resp.status}`);
  }
  return await resp.json();
}

// ---------- Canvas script loader ----------

function renderCanvas(block) {
  const el = document.createElement("div");
  el.className = "block canvas";
  const spec = block.canvas || {};
  const canvas = document.createElement("canvas");
  canvas.width = spec.widthPx || 600;
  canvas.height = spec.heightPx || 360;
  canvas.style.maxWidth = "100%";
  canvas.style.display = "block";
  canvas.style.margin = "0 auto";
  el.appendChild(canvas);

  if (!spec.scriptPath) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = "[canvas: no script_path]";
    el.appendChild(ph);
    return el;
  }

  let params = {};
  if (spec.initialStateJson) {
    try {
      params = JSON.parse(spec.initialStateJson);
    } catch (e) {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = `[canvas: bad initial_state_json: ${e.message}]`;
      el.appendChild(ph);
      return el;
    }
  }

  // Asset paths are served at assets/<basename> under the site root;
  // accept both bare basenames and explicit assets/<...> paths.
  const path = spec.scriptPath.startsWith("assets/")
    ? spec.scriptPath
    : `assets/${spec.scriptPath}`;
  const moduleUrl = new URL(path, document.baseURI).href;

  const ds = spec.dataSource || spec.data_source;
  const dataPromise = (ds && ds.uri)
    ? _loadDataSource(ds).then((bundle) => { params.data = bundle; })
    : Promise.resolve();

  Promise.all([dataPromise, import(moduleUrl)])
    .then(([, mod]) => {
      if (typeof mod.render !== "function") {
        throw new Error(`module ${path} has no exported render(canvas, params)`);
      }
      mod.render(canvas, params);
    })
    .catch((err) => {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = `[canvas: ${err.message}]`;
      el.appendChild(ph);
    });

  return el;
}

function renderBlock(block) {
  if (block.text) return renderText(block);
  if (block.equation) return renderEquation(block);
  if (block.svg) return renderSvg(block);
  if (block.image) return renderImage(block);
  if (block.code) return renderCode(block);
  if (block.plot) return renderPlot(block);
  if (block.canvas) return renderCanvas(block);
  if (block.vizScene || block.viz_scene) return renderVizScene(block);
  if (block.heightmap) return renderHeightmap(block);
  if (block.vegaLite || block.vega_lite) return renderVegaLite(block);
  if (block.polarTrace || block.polar_trace) return renderPolarTrace(block);
  if (block.primeLattice || block.prime_lattice) return renderPrimeLattice(block);
  if (block.zetaDensity || block.zeta_density) return renderZetaDensity(block);
  if (block.zetaDomainColoring || block.zeta_domain_coloring) return renderZetaDomainColoring(block);
  if (block.pointCloud || block.point_cloud) return renderPointCloud(block);
  if (block.clusterIndex || block.cluster_index) return renderClusterIndex(block);
  const el = document.createElement("div");
  el.className = "block unknown";
  el.textContent = "[unknown block kind]";
  return el;
}

function renderSlide(slide, index) {
  const section = document.createElement("section");
  section.className = "slide";
  section.id = `slide-${slide.id || index}`;
  section.dataset.index = String(index);
  if (slide.title) {
    const h = document.createElement("h2");
    h.textContent = slide.title;
    section.appendChild(h);
  }
  for (const block of slide.blocks || []) {
    section.appendChild(renderBlock(block));
  }
  return section;
}

function renderHeader(wt) {
  $("deck-title").textContent = wt.title || wt.id || "Walkthrough";
  const meta = [wt.author, wt.date].filter(Boolean).join(" · ");
  $("deck-meta").textContent = wt.subtitle
    ? `${wt.subtitle}${meta ? " · " + meta : ""}`
    : meta;
}

function initialSlideIndex(slides) {
  const params = new URLSearchParams(location.search);
  const wanted = params.get("slide");
  if (wanted) {
    const i = slides.findIndex((s) => s.id === wanted);
    if (i >= 0) return i;
  }
  return 0;
}

function syncKatex(slide) {
  if (window.renderMathInElement) {
    window.renderMathInElement(slide, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
  }
}

async function main() {
  let wt;
  try {
    wt = await loadWalkthrough();
  } catch (e) {
    document.body.innerHTML =
      `<pre style="padding:2rem;color:#b00;">${e.message}</pre>`;
    return;
  }
  applyTheme(wt.theme);
  renderHeader(wt);

  const deck = $("deck");
  const slides = wt.slides || [];
  const nodes = slides.map((s, i) => {
    const node = renderSlide(s, i);
    deck.appendChild(node);
    return node;
  });

  let current = initialSlideIndex(slides);

  function show(i) {
    if (i < 0 || i >= nodes.length) return;
    nodes.forEach((n) => n.classList.remove("active"));
    nodes[i].classList.add("active");
    current = i;
    $("prev").disabled = i === 0;
    $("next").disabled = i === nodes.length - 1;
    $("counter").textContent = `${i + 1} / ${nodes.length}`;
    const id = slides[i].id;
    if (id) {
      const url = new URL(location.href);
      url.searchParams.set("slide", id);
      history.replaceState(null, "", url);
    }
    const notes = slides[i].notes;
    const notesEl = $("notes");
    if (notes) {
      notesEl.textContent = notes;
      notesEl.hidden = false;
    } else {
      notesEl.hidden = true;
    }
    syncKatex(nodes[i]);
  }

  $("prev").addEventListener("click", () => show(current - 1));
  $("next").addEventListener("click", () => show(current + 1));
  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === " ") show(current + 1);
    else if (e.key === "ArrowLeft") show(current - 1);
  });

  // KaTeX/marked load with `defer`; they may not be ready at module
  // start. Re-render once they finish.
  window.addEventListener("load", () => show(current));
  show(current);
}

main();
