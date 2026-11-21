# rules_walkthrough

Bazel rules that turn a declarative slide deck — a
[`walkthrough.v1.Walkthrough`](proto/walkthrough.proto) JSON document — into a
self-contained static site: a renderer, vendored KaTeX / marked / Vega-Lite,
the deck JSON, its assets, and build-time-resolved data sidecars, all in one
TreeArtifact. The browser loads plain files; there is no network fetch and no
Python at view time.

A `Walkthrough` is a sequence of `Slide`s, each made of composable
`SlideBlock`s (markdown prose, KaTeX equations, SVG, plots, code, WebGPU
canvases, point clouds, …) rendered top to bottom.

## Setup

`rules_walkthrough` is published to the [tomato-bazel](https://github.com/tomato-bazel)
registry. Add it ahead of the BCR in your `.bazelrc` — `--registry`
accumulates and the first match wins, so list the BCR explicitly and second:

```
common --registry=https://registry.tbzl.dev/
common --registry=https://bcr.bazel.build/
```

Then in `MODULE.bazel`:

```starlark
bazel_dep(name = "rules_walkthrough", version = "0.2.0")
```

## Usage

`BUILD.bazel`:

```starlark
load("@rules_walkthrough//walkthrough:defs.bzl", "walkthrough_html")

walkthrough_html(
    name = "deck",
    src = "deck.json",                   # walkthrough.v1.Walkthrough as JSON
    assets = glob(["assets/**"]),        # SVGs, images, canvas JS modules
    data = ["//pkg:trace.npy"],          # resolved to JSON sidecars at build time
    shaders = ["//pkg/shaders:surface"], # optional: .wgsl.js ES modules
    bindings = [...],                    # optional: .bindings.js uniform-writer modules
    docs = [...],                        # optional: Markdown reference pages
)
```

This produces two targets:

- **`:deck`** — a TreeArtifact holding the assembled static site.
- **`:deck_serve`** — a `py_binary`; `bazel run //pkg:deck_serve` serves the
  site on localhost (the port is bumped if taken) and opens it in a browser.

A minimal deck:

```json
{
  "id": "hello",
  "title": "Hello",
  "slides": [
    {
      "id": "math",
      "title": "KaTeX",
      "blocks": [
        { "equation": { "latex": "e^{i\\pi} + 1 = 0" } },
        { "text": { "markdown": "Inline math works too: $\\sum_{n\\geq 1} n^{-s}$." } }
      ]
    }
  ]
}
```

See [`examples/hello_world`](examples/hello_world) for a buildable copy and
[`docs/defs.md`](docs/defs.md) for the generated API reference.

### Site layout

| Attribute | Staged at | Notes |
|---|---|---|
| `src` | `walkthrough.json` | after data-source URIs are rewritten |
| `assets` | `assets/<basename>` | referenced by blocks with relative URIs |
| `data` | `data/<stem>.<hash>.json` | resolver sidecars (see below) |
| `shaders` | `shaders/<basename>` | dynamically imported by the WebGPU renderers |
| `bindings` | `bindings/<basename>` | canvas scripts `import` them as `../bindings/<name>.bindings.js` |
| `docs` | `docs/<basename>` | viewable at `docs.html?file=<basename>`, rendered client-side by marked |

## Block types

Each `SlideBlock` sets exactly one of:

| Field | Message | Renders |
|---|---|---|
| `text` | `TextBlock` | Markdown prose (marked), with inline KaTeX |
| `equation` | `EquationBlock` | Display LaTeX via KaTeX |
| `svg` | `SvgBlock` | Inline SVG, from a string or an asset |
| `plot` | `PlotBlock` | Line, scatter, histogram or heatmap plot from inline series or a `DataSource` |
| `image` | `ImageBlock` | Static raster or vector asset |
| `code` | `CodeBlock` | Code listing with optional highlighted lines |
| `canvas` | `CanvasBlock` | JS-driven canvas module from `assets`, optionally fed a `DataSource` |
| `viz_scene` | `VizSceneBlock` | Declarative 2D scene (points, lines, rects, expressions, text) with a keyframe timeline |
| `vega_lite` | `VegaLiteBlock` | Vega-Lite spec via vega-embed |
| `heightmap` | `HeightmapBlock` | WebGPU 3D surface |
| `polar_trace` | `PolarTraceBlock` | WebGPU 3D parametric curve |
| `prime_lattice` | `PrimeLatticeBlock` | WebGPU 3D plot over prime-indexed axes |
| `zeta_density` | `ZetaDensityBlock` | Density of a complex trace, as a 2D heat map or 3D height field |
| `zeta_domain_coloring` | `ZetaDomainColoringBlock` | 2D phase + magnitude domain coloring |
| `point_cloud` | `PointCloudBlock` | Instanced 3D point cloud colored by a scalar field |
| `cluster_index` | `ClusterIndexBlock` | Sortable table of cluster summaries |

The WebGPU blocks need a browser with WebGPU enabled.
[`proto/walkthrough.proto`](proto/walkthrough.proto) documents every field.

## Design notes

- **The proto is documentation.** `proto/walkthrough.proto` is the schema, but
  it is not compiled here. The wire format is its JSON encoding, so decks can
  be hand-written, emitted with `protojson`, or produced by any encoder. A
  consumer that wants typed bindings can point its own `proto_library` at
  `@rules_walkthrough//proto:walkthrough.proto`.
- **The renderer is generic; shaders are not.** The JS under
  `walkthrough/renderer/` is framework code. Domain-specific WGSL comes in
  through `shaders`, is staged at `shaders/<basename>`, and is imported at run
  time.
- **No build-time coupling to shader tooling.** `shaders` and `bindings`
  accept files by extension (`.wgsl.js`, `.bindings.js`), so any rule that
  produces them works; `rules_walkthrough` depends on none of them.
- **Data is resolved at build time.** Each file in `data` goes through
  `walkthrough/resolver/resolve.py`, which matches it to `DataSource`
  references by basename, loads it, writes a JSON sidecar, and rewrites the
  block's `data_source.uri` to point at it. JSON and CSV work out of the box.
  `.npy` / `.npz` need `numpy` and `.parquet` needs `pyarrow` in the
  resolver's environment; they are imported lazily and fail with a clear error
  if missing.

## Layout

```
proto/walkthrough.proto   authoring schema (documentation, not compiled)
walkthrough/
  defs.bzl                the walkthrough_html macro
  serve.py                runfiles-aware http.server wrapper
  renderer/               static site: index.html, docs.html, renderer.js,
                          per-block *_renderer.js, vendor/{katex,marked,vega}
  resolver/               data-source resolver (json/csv/npy/npz/parquet → JSON)
examples/hello_world/     minimal deck (text + equations)
docs/                     generated API reference
```

## Not yet

- A native authoring CLI (`textpb` → `walkthrough.json`).
- Reveal.js / Beamer / PDF back ends — the proto leaves room for them.
- Live data — sidecars are resolved at build time and served as-is.

## License

MIT — see [`LICENSE`](LICENSE). The vendored KaTeX, marked and Vega libraries
keep their own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
