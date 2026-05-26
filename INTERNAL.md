# rules_walkthrough — internal notes

**Status:** private / local-only. Do not push to GitHub, do not register
in any bazel-registry, do not reference publicly.

## What this is

Bazel-native, framework-agnostic slide-deck renderer for declarative
visual narratives. The authoring contract is `proto/walkthrough.proto`
(`walkthrough.v1.Walkthrough`); the runtime is a tree of static assets
that the consumer's browser loads from a single TreeArtifact.

A `Walkthrough` is a JSON document (the JSON encoding of the proto) —
a sequence of `Slide`s, each with composable `SlideBlock`s (markdown
prose, KaTeX equations, SVG, plots, WebGPU canvases, point clouds, …).
Renderers consume the JSON and render blocks top-to-bottom.

This repo is the lift-and-shift of `prime-transformer/tools/walkthrough/`,
predicted by that codebase's own design notes
(`tools/walkthrough/defs.bzl:38` — "Design intent — lift-and-shift to a
future `rules_walkthrough`"). Sibling consumers (prime-transformer,
rules_agentic_ide) load the framework via `bazel_dep` +
`local_path_override`.

## Public surface

```starlark
load("@rules_walkthrough//walkthrough:defs.bzl", "walkthrough_html")

walkthrough_html(
    name   = "deck",
    src    = "deck.json",                  # walkthrough.v1.Walkthrough JSON
    assets = glob(["assets/**"]),          # SVGs, canvas JS modules, images
    data   = ["//pkg:trace.npy"],          # resolved to JSON sidecars at build
    shaders = ["//pkg/shaders:heightmap"], # optional, .wgsl.js ES modules
    bindings = [...],                      # optional, rules_render .bindings.js
    docs    = [...],                       # optional, wgsl_doc_site .md
)
```

Produces:

  * `<name>`       — TreeArtifact: assembled static site.
  * `<name>_serve` — `py_binary`: `bazel run :<name>_serve` opens the
                     deck in a browser via `http.server`.

## Layout

```
proto/walkthrough.proto          authoring schema (not compiled, doc only)
walkthrough/
  defs.bzl                       the `walkthrough_html` macro
  serve.py                       runfiles-aware http.server wrapper
  renderer/                      static framework assets (HTML/JS/CSS)
    index.html, docs.html
    renderer.js                  block dispatcher
    *_renderer.js                per-block-type renderers (heightmap, scene, …)
    vendor/katex, vendor/marked, vendor/vega
  resolver/                      Python data-source resolver (npy/csv/parquet → JSON sidecar)
examples/
  hello_world/                   minimal smoke deck (text + equation + plot)
```

## Design notes

* **Proto is documentation.** The schema lives at `proto/walkthrough.proto`
  but is *not* compiled. The runtime contract is JSON; consumers can
  author with hand-written JSON, `protojson`, or any encoder. If a
  consumer eventually needs typed bindings, add a `proto_library` +
  `py_proto_library` later — the doc-only status is intentional for v0.

* **Renderer is generic; shaders are not.** Renderer JS modules in
  `walkthrough/renderer/` are framework code. WGSL shaders specific to
  a consumer's domain (zeta heightmaps, semantic-volume point clouds)
  come in through the macro's `shaders =` attribute. They're staged at
  `shaders/<basename>` and dynamic-imported by the renderer at runtime.

* **Headless to `rules_render`.** Optional `bindings =` attr accepts
  `.bindings.js` outputs from `rules_render`'s `wgsl_pass`/`wgsl_material`.
  No build-time dependency on `rules_render`.

* **Data sidecars.** Files in `data =` are run through
  `walkthrough/resolver/resolve.py`, which loads npy/csv/parquet/json
  and emits a `data/<stem>.<hash>.json` sidecar. The walkthrough JSON's
  `data_source.uri` is rewritten to point at the sidecar so the browser
  fetches plain JSON — no Python in the runtime.

## Consumers (current and planned)

| Repo | Use |
|---|---|
| `[[prime-transformer]]` | original author; ζ heightmaps, polar trace, prime lattice, density renderers |
| `[[rules_agentic_ide]]` | semantic-volume point cloud (Forman-Ricci on BGE k-NN graph) |

## Non-goals (v0)

* Public release.
* A native authoring CLI (`textpb → walkthrough.json` generator).
* Reveal.js / Beamer / PDF back-ends (proto leaves the door open).
* Live data — sidecars are resolved at build time, served verbatim.
