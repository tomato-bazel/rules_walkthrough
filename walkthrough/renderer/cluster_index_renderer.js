// Renderer for walkthrough.v1.ClusterIndexBlock.
//
// Fetches a `clusters.json` sidecar (same one PointCloudBlock uses for
// hull meshes) and renders a sortable table:
//
//   [color swatch] [#id] [N members] [mean ± std Ricci]  [rep1 · rep2 · rep3 …]
//
// Color swatch is the same diverging cool-warm map applied to each
// cluster's mean Ricci, normalized by the block's `ricci_abs_max`
// (or computed from the data when zero). Clicking a column header
// sorts ascending; second click flips. No GPU needed.

function colormapDiverging(t) {
  const s = Math.max(-1, Math.min(1, t));
  const cold = [0.140, 0.270, 0.560];
  const mid  = [0.960, 0.940, 0.910];
  const warm = [0.700, 0.100, 0.150];
  const lerp = (a, b, k) => [a[0]+(b[0]-a[0])*k, a[1]+(b[1]-a[1])*k, a[2]+(b[2]-a[2])*k];
  return s < 0 ? lerp(mid, cold, -s) : lerp(mid, warm, s);
}
const rgbStr = (rgb) =>
  `rgb(${Math.round(rgb[0]*255)}, ${Math.round(rgb[1]*255)}, ${Math.round(rgb[2]*255)})`;

export function renderClusterIndex(block) {
  const spec = block.clusterIndex || block.cluster_index || {};
  const el = document.createElement("div");
  el.className = "block cluster-index";

  if (spec.caption) {
    const cap = document.createElement("div");
    cap.className = "caption";
    cap.textContent = spec.caption;
    el.appendChild(cap);
  }

  const status = document.createElement("div");
  status.className = "caption cluster-index-status";
  status.textContent = "loading…";
  el.appendChild(status);

  const uri = spec.clustersUri || spec.clusters_uri;
  if (!uri) {
    status.textContent = "[cluster_index: missing clusters_uri]";
    return el;
  }

  fetch(uri)
    .then((r) => {
      if (!r.ok) throw new Error(`fetch ${uri} → ${r.status}`);
      return r.json();
    })
    .then((data) => {
      const clusters = data.clusters || [];
      if (clusters.length === 0) {
        status.textContent = "[cluster_index: no clusters in sidecar]";
        return;
      }

      // Colormap normalization — explicit or computed.
      let absMax = spec.ricciAbsMax || spec.ricci_abs_max || 0;
      if (!absMax) {
        for (const c of clusters) {
          const m = Math.abs(c.mean_ricci ?? 0);
          if (m > absMax) absMax = m;
        }
      }
      absMax = Math.max(absMax, 1e-9);

      const topN = spec.topN || spec.top_n || 5;

      status.textContent = `${clusters.length} clusters · sorted by ascending mean Ricci (bridges → cores)`;

      const table = document.createElement("table");
      table.className = "cluster-index-table";
      const thead = document.createElement("thead");
      thead.innerHTML = `
        <tr>
          <th></th>
          <th data-key="cluster_id">#</th>
          <th>description</th>
          <th data-key="member_count">members</th>
          <th data-key="mean_ricci">mean Ricci</th>
          <th data-key="ricci_stdev">stdev</th>
          <th>representatives</th>
        </tr>
      `;
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      table.appendChild(tbody);
      el.appendChild(table);

      let sortKey = "mean_ricci";
      let ascending = true;
      function rebuild() {
        const sorted = clusters.slice().sort((a, b) => {
          const av = a[sortKey] ?? 0;
          const bv = b[sortKey] ?? 0;
          return ascending ? av - bv : bv - av;
        });
        tbody.innerHTML = "";
        for (const c of sorted) {
          const tr = document.createElement("tr");
          const rgb = colormapDiverging((c.mean_ricci ?? 0) / absMax);
          const swatch = document.createElement("td");
          swatch.innerHTML = `<span class="cluster-swatch" style="background:${rgbStr(rgb)};"></span>`;
          tr.appendChild(swatch);
          const idCell = document.createElement("td");
          idCell.textContent = `#${c.cluster_id}`;
          tr.appendChild(idCell);
          const descCell = document.createElement("td");
          descCell.className = "cluster-desc";
          descCell.textContent = c.description || "(no description)";
          tr.appendChild(descCell);
          const countCell = document.createElement("td");
          countCell.textContent = (c.member_count ?? 0).toLocaleString();
          tr.appendChild(countCell);
          const meanCell = document.createElement("td");
          meanCell.textContent = (c.mean_ricci ?? 0).toFixed(2);
          tr.appendChild(meanCell);
          const stdCell = document.createElement("td");
          stdCell.textContent = (c.ricci_stdev ?? 0).toFixed(2);
          tr.appendChild(stdCell);
          const repsCell = document.createElement("td");
          repsCell.className = "cluster-reps";
          const reps = (c.representatives || []).slice(0, topN);
          repsCell.textContent = reps.length > 0
            ? reps.join("  ·  ")
            : "(no representatives — re-run agentic-ide-viz with --num-clusters)";
          tr.appendChild(repsCell);
          tbody.appendChild(tr);
        }
      }
      thead.querySelectorAll("th[data-key]").forEach((th) => {
        th.style.cursor = "pointer";
        th.addEventListener("click", () => {
          const key = th.getAttribute("data-key");
          if (key === sortKey) ascending = !ascending;
          else { sortKey = key; ascending = true; }
          rebuild();
        });
      });
      rebuild();
    })
    .catch((err) => {
      console.error(err);
      status.textContent = `[cluster_index: ${err.message}]`;
    });

  return el;
}
