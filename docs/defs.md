<!-- Generated with Stardoc: http://skydoc.bazel.build -->

Bazel macros for the walkthrough renderer.

Public surface:

    load("@rules_walkthrough//walkthrough:defs.bzl", "walkthrough_html")

    walkthrough_html(
        name = "walkthrough",
        src  = "walkthrough.json",
        assets = glob(["walkthrough_assets/**"]),
        data = ["//data:trace.npy"],
    )

This produces two targets:

  * `<name>`        — a TreeArtifact directory containing the
                      assembled static site (renderer + vendored
                      KaTeX/marked + walkthrough.json + assets +
                      resolved data sidecars).
  * `<name>_serve`  — a `py_binary`. `bazel run //path:<name>_serve`
                      starts an http.server on localhost and opens
                      the deck in the default browser.

Files in `data` are passed through the
`@rules_walkthrough//walkthrough/resolver` binary at build time: each
`DataSource` reference (PlotBlock or CanvasBlock) is matched by
basename, loaded (JSON/CSV/NPY/NPZ — and PARQUET if `pyarrow` is
importable), and emitted as a sidecar JSON at `data/<stem>.<hash>.json`
inside the site. The walkthrough JSON's `data_source.uri` field is
rewritten to point at the sidecar so the browser fetches plain JSON.
See `resolver/resolve.py` for the sidecar schema.

The site is fully self-contained — no network fetches at view time.
JSON, not textproto, is the on-disk format for now; Walkthrough
(in `@rules_walkthrough//proto:walkthrough.proto`) is the schema,
and a `textpb -> json` generator can be added later.

<a id="walkthrough_html"></a>

## walkthrough_html

<pre>
load("@rules_walkthrough//walkthrough:defs.bzl", "walkthrough_html")

walkthrough_html(<a href="#walkthrough_html-name">name</a>, <a href="#walkthrough_html-src">src</a>, <a href="#walkthrough_html-assets">assets</a>, <a href="#walkthrough_html-data">data</a>, <a href="#walkthrough_html-shaders">shaders</a>, <a href="#walkthrough_html-bindings">bindings</a>, <a href="#walkthrough_html-docs">docs</a>, <a href="#walkthrough_html-port">port</a>, <a href="#walkthrough_html-visibility">visibility</a>)
</pre>

Bundle a walkthrough.json into a runnable static site.

**PARAMETERS**


| Name  | Description | Default Value |
| :------------- | :------------- | :------------- |
| <a id="walkthrough_html-name"></a>name |  target name.   |  none |
| <a id="walkthrough_html-src"></a>src |  the walkthrough JSON file (label or filename relative to this package). Will be staged as `walkthrough.json` in the served directory after data-source resolution.   |  none |
| <a id="walkthrough_html-assets"></a>assets |  extra files referenced by the walkthrough (SVGs, images, canvas JS modules). Each is served at `assets/<basename>` inside the site.   |  `None` |
| <a id="walkthrough_html-data"></a>data |  data files referenced by `DataSource` blocks (.json/.csv/.npy/.npz/.parquet). The resolver loads each, emits a sidecar JSON under `data/`, and rewrites the block's URI to point at the sidecar.   |  `None` |
| <a id="walkthrough_html-shaders"></a>shaders |  targets producing shader ES modules (`.wgsl.js`). Each output lands at `shaders/<basename>` in the site; the renderer dynamically imports them by variant.   |  `None` |
| <a id="walkthrough_html-bindings"></a>bindings |  targets producing JS bindings modules (`.bindings.js`, e.g. typed uniform writers generated from shader reflection). Each lands at `bindings/<basename>`. Canvas scripts import them as `../bindings/<name>.bindings.js`.   |  `None` |
| <a id="walkthrough_html-docs"></a>docs |  Markdown reference docs. Each is staged at `docs/<basename>` and viewable at `docs.html?file=<basename>` (rendered client-side by marked.min.js).   |  `None` |
| <a id="walkthrough_html-port"></a>port |  default localhost port (auto-bumped if in use).   |  `8765` |
| <a id="walkthrough_html-visibility"></a>visibility |  standard bazel visibility for both produced targets.   |  `None` |


