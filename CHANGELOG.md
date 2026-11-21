# Changelog

## 0.2.0 — first public release

No change to the rule's behavior or attributes; this release is
documentation, licensing and CI.

* `README.md` covering registry setup, `walkthrough_html` usage, the
  staged site layout and every block type.
* MIT `LICENSE`, plus `THIRD_PARTY_NOTICES.md` and per-package license
  files next to the vendored KaTeX (and fonts), marked, Vega, Vega-Lite
  and vega-embed, so the licenses ship inside every built site.
* Generated API reference at `docs/defs.md` (stardoc), kept fresh by a
  `diff_test`; `bazel run //docs:update` regenerates it.
* `build_test` for `examples/hello_world`, so `bazel test //...`
  exercises the resolver and staging end to end.
* `.bazelrc` with the tomato-bazel registry ahead of the BCR, and a
  GitHub Actions workflow (ubuntu + macOS `bazel test //...`, plus
  buildifier).
* Attribute docs for `shaders`, `bindings` and `docs` describe the
  expected file types instead of naming specific producer rules.

## 0.1.0 — initial release

* `walkthrough_html` macro at `@rules_walkthrough//walkthrough:defs.bzl`.
* Proto schema at `@rules_walkthrough//proto:walkthrough.proto`
  (package `walkthrough.v1`).
* Renderer at `@rules_walkthrough//walkthrough/renderer:all_files`
  (block renderers: text/equation/svg/plot/code/image/canvas/
  viz_scene/heightmap/vega_lite/polar_trace/prime_lattice/zeta_density/
  zeta_domain_coloring).
* Resolver at `@rules_walkthrough//walkthrough/resolver:resolve` —
  npy/npz/csv/parquet/json → JSON sidecar. numpy/pyarrow lazy-imported
  so JSON/CSV-only consumers don't need them in their pip hub.
* Vendored KaTeX + marked + Vega-Lite under `walkthrough/renderer/vendor/`.
