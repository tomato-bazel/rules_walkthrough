// Renderer for walkthrough.v1.VegaLiteBlock.
//
// Loads the vendored vega-embed bundle on demand (lazy — the 800K
// bundle isn't pulled if no slide actually uses Vega), parses the
// block's `spec_json`, splices in DataSource-loaded data, and
// invokes `vegaEmbed`.
//
// The spec is verbatim Vega-Lite. We do exactly two things to it:
//   1. If `data_source` is set, replace/insert `spec.data.values`
//      with the resolver sidecar's row-oriented data.
//   2. If `width_px` / `height_px` are set on the block, copy them
//      onto `spec.width` / `spec.height`.
// Everything else (scales, encodings, transforms, signals) is the
// author's responsibility — and that's the point.

let _embedPromise = null;

function _loadVegaEmbed() {
  if (_embedPromise) return _embedPromise;
  _embedPromise = new Promise((resolve, reject) => {
    // Vega + Vega-Lite + Vega-Embed all attach to window globals.
    // Load in order — vega-embed needs the other two.
    const loadScript = (src) => new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = false;  // preserve order
      s.onload = () => res();
      s.onerror = () => rej(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
    Promise.all([
      loadScript("vendor/vega/vega.min.js"),
      loadScript("vendor/vega/vega-lite.min.js"),
      loadScript("vendor/vega/vega-embed.min.js"),
    ])
      .then(() => {
        if (!window.vegaEmbed) {
          reject(new Error("vega-embed didn't register window.vegaEmbed"));
        } else {
          resolve(window.vegaEmbed);
        }
      })
      .catch(reject);
  });
  return _embedPromise;
}

export function renderVegaLite(block) {
  const el = document.createElement("div");
  el.className = "block vega-lite";
  const spec_block = block.vegaLite || block.vega_lite || {};

  const target = document.createElement("div");
  target.style.maxWidth = "100%";
  target.style.margin = "0 auto";
  el.appendChild(target);

  const showStatus = (msg) => {
    target.innerHTML = "";
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = `[vega: ${msg}]`;
    target.appendChild(ph);
  };

  let spec;
  try {
    spec = JSON.parse(spec_block.specJson || spec_block.spec_json || "{}");
  } catch (e) {
    showStatus(`bad spec_json: ${e.message}`);
    return el;
  }
  if (spec_block.widthPx || spec_block.width_px) {
    spec.width = spec_block.widthPx || spec_block.width_px;
  }
  if (spec_block.heightPx || spec_block.height_px) {
    spec.height = spec_block.heightPx || spec_block.height_px;
  }

  const ds = spec_block.dataSource || spec_block.data_source;
  const dataPromise = (ds && ds.uri)
    ? fetch(ds.uri, { cache: "no-store" })
        .then((r) => r.ok ? r.json() : Promise.reject(
          new Error(`HTTP ${r.status}`)))
        .then((bundle) => {
          spec.data = spec.data || {};
          spec.data.values = _bundleToRows(bundle);
        })
    : Promise.resolve();

  const embedPromise = _loadVegaEmbed();
  const actions = !!(spec_block.showActions || spec_block.show_actions);

  showStatus("loading vega…");
  Promise.all([dataPromise, embedPromise])
    .then(([, vegaEmbed]) => {
      target.innerHTML = "";
      return vegaEmbed(target, spec, {
        actions,
        renderer: "svg",
      });
    })
    .catch((err) => {
      showStatus(err.message);
    });

  return el;
}

// Flatten a resolver sidecar into row-oriented records for Vega.
//
// Priority of consumption:
//   - `bundle.series` (preferred): {name, x, y} → rows with
//     {series, x, y} columns. Best for the common "stacked
//     line/bar/scatter" shape.
//   - `bundle.columns` (CSV/PARQUET fallback): pivot to rows.
//   - `bundle.arrays.x` + `bundle.arrays.y` (NPZ): row-pair them.
function _bundleToRows(bundle) {
  if (!bundle) return [];
  if (Array.isArray(bundle.series) && bundle.series.length) {
    const rows = [];
    for (const s of bundle.series) {
      const n = Math.min((s.x || []).length, (s.y || []).length);
      for (let i = 0; i < n; i++) {
        rows.push({ series: s.name || "series", x: s.x[i], y: s.y[i] });
      }
    }
    return rows;
  }
  if (bundle.columns && typeof bundle.columns === "object") {
    const cols = bundle.columns;
    const names = Object.keys(cols);
    if (!names.length) return [];
    const n = cols[names[0]].length;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const row = {};
      for (const k of names) row[k] = cols[k][i];
      rows.push(row);
    }
    return rows;
  }
  if (bundle.arrays && Array.isArray(bundle.arrays.x)
      && Array.isArray(bundle.arrays.y)) {
    const xs = bundle.arrays.x;
    const ys = bundle.arrays.y;
    const n = Math.min(xs.length, ys.length);
    const rows = [];
    for (let i = 0; i < n; i++) rows.push({ x: xs[i], y: ys[i] });
    return rows;
  }
  return [];
}
