"""Bazel macros for the walkthrough renderer.

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
"""

load("@rules_python//python:defs.bzl", "py_binary")

_RENDERER_PREFIX = "walkthrough/renderer/"

def _walkthrough_site_impl(ctx):
    out_dir = ctx.actions.declare_directory(ctx.label.name + "_site")

    # === Action 1: run the resolver ===
    resolved_json = ctx.actions.declare_file(ctx.label.name + "_resolved.json")
    sidecar_dir = ctx.actions.declare_directory(ctx.label.name + "_sidecars")

    resolver_args = ctx.actions.args()
    resolver_args.add("--in", ctx.file.src.path)
    resolver_args.add("--out", resolved_json.path)
    resolver_args.add("--out-data", sidecar_dir.path)
    for f in ctx.files.data:
        resolver_args.add("--asset", f.path)

    ctx.actions.run(
        executable = ctx.executable._resolver,
        inputs = [ctx.file.src] + ctx.files.data,
        outputs = [resolved_json, sidecar_dir],
        arguments = [resolver_args],
        mnemonic = "WalkthroughResolve",
        progress_message = "Resolving walkthrough data %s" % ctx.label,
    )

    # === Action 2: stage everything into the site TreeArtifact ===
    stages = []  # (File, dest_relative_path)

    for f in ctx.files.renderer:
        sp = f.short_path

        # Renderer files come in as `<external>/walkthrough/renderer/...`
        # when consumed via @rules_walkthrough, or
        # `walkthrough/renderer/...` when consumed in-tree. Strip
        # everything up to and including the prefix in either case.
        idx = sp.find(_RENDERER_PREFIX)
        if idx < 0:
            fail("renderer file %s does not contain %s" % (sp, _RENDERER_PREFIX))
        stages.append((f, sp[idx + len(_RENDERER_PREFIX):]))

    stages.append((resolved_json, "walkthrough.json"))

    for f in ctx.files.assets:
        stages.append((f, "assets/" + f.basename))

    # Bazel-built shader ES modules (`.wgsl.js`) land under shaders/.
    # Renderers import them with relative paths like
    # `./shaders/<basename>.wgsl.js`.
    for f in ctx.files.shaders:
        stages.append((f, "shaders/" + f.basename))

    # JS bindings modules (`.bindings.js`, e.g. typed uniform writers
    # generated from shader reflection). Each lands at
    # `bindings/<basename>` inside the site. Canvas scripts import them
    # with `import { FooUniforms } from "../bindings/foo.bindings.js"`.
    for f in ctx.files.bindings:
        stages.append((f, "bindings/" + f.basename))

    # Standalone Markdown reference docs. Each .md lands at
    # `docs/<basename>` and is rendered client-side by docs.html via
    # the already-vendored marked.min.js.
    for f in ctx.files.docs:
        stages.append((f, "docs/" + f.basename))

    stage_args = ctx.actions.args()
    stage_args.add(out_dir.path)
    stage_args.add(sidecar_dir.path)
    for src, dest in stages:
        stage_args.add(src.path)
        stage_args.add(dest)

    ctx.actions.run_shell(
        outputs = [out_dir],
        inputs = [s[0] for s in stages] + [sidecar_dir],
        arguments = [stage_args],
        progress_message = "Staging walkthrough site %s" % ctx.label,
        command = """
set -e
out="$1"; shift
sidecar_dir="$1"; shift
mkdir -p "$out" "$out/data"
if [ -d "$sidecar_dir" ]; then
    # `cp -R src/. dest/` copies contents (dotglob included).
    if compgen -G "$sidecar_dir"/* > /dev/null; then
        cp -R "$sidecar_dir"/* "$out/data/"
    fi
fi
while [ $# -gt 0 ]; do
    src="$1"; dest="$2"; shift 2
    target="$out/$dest"
    mkdir -p "$(dirname "$target")"
    cp "$src" "$target"
done
""",
    )

    return [DefaultInfo(
        files = depset([out_dir]),
        runfiles = ctx.runfiles(files = [out_dir]),
    )]

_walkthrough_site = rule(
    implementation = _walkthrough_site_impl,
    attrs = {
        "src": attr.label(mandatory = True, allow_single_file = True),
        "renderer": attr.label_list(
            allow_files = True,
            default = ["@rules_walkthrough//walkthrough/renderer:all_files"],
        ),
        "assets": attr.label_list(allow_files = True, default = []),
        "data": attr.label_list(allow_files = True, default = []),
        "shaders": attr.label_list(
            allow_files = [".wgsl.js"],
            default = [],
            doc = "Bazel-built shader ES modules (`.wgsl.js`). " +
                  "Each is staged at `shaders/<basename>` inside " +
                  "the site.",
        ),
        "bindings": attr.label_list(
            allow_files = [".bindings.js"],
            default = [],
            doc = "JS bindings modules (`.bindings.js`, e.g. " +
                  "typed uniform writers generated from shader " +
                  "reflection). Each is staged at " +
                  "`bindings/<basename>` inside the site so canvas " +
                  "scripts can `import` typed uniform writers.",
        ),
        "docs": attr.label_list(
            allow_files = [".md"],
            default = [],
            doc = "Markdown reference docs. Each .md is staged at " +
                  "`docs/<basename>` and rendered client-side by " +
                  "`docs.html?file=<basename>`.",
        ),
        "_resolver": attr.label(
            default = "@rules_walkthrough//walkthrough/resolver:resolve",
            executable = True,
            cfg = "exec",
        ),
    },
    doc = "Resolve DataSource references and stage the renderer + " +
          "JSON + assets + sidecars into one TreeArtifact directory.",
)

def walkthrough_html(
        name,
        src,
        assets = None,
        data = None,
        shaders = None,
        bindings = None,
        docs = None,
        port = 8765,
        visibility = None):
    """Bundle a walkthrough.json into a runnable static site.

    Args:
      name: target name.
      src: the walkthrough JSON file (label or filename relative to
           this package). Will be staged as `walkthrough.json` in the
           served directory after data-source resolution.
      assets: extra files referenced by the walkthrough (SVGs,
              images, canvas JS modules). Each is served at
              `assets/<basename>` inside the site.
      data: data files referenced by `DataSource` blocks
            (.json/.csv/.npy/.npz/.parquet). The resolver loads each,
            emits a sidecar JSON under `data/`, and rewrites the
            block's URI to point at the sidecar.
      shaders: targets producing shader ES modules (`.wgsl.js`).
               Each output lands at `shaders/<basename>` in the site;
               the renderer dynamically imports them by variant.
      bindings: targets producing JS bindings modules (`.bindings.js`,
                e.g. typed uniform writers generated from shader
                reflection). Each lands at `bindings/<basename>`.
                Canvas scripts import them as
                `../bindings/<name>.bindings.js`.
      docs: Markdown reference docs. Each is staged at
            `docs/<basename>` and viewable
            at `docs.html?file=<basename>` (rendered client-side by
            marked.min.js).
      port: default localhost port (auto-bumped if in use).
      visibility: standard bazel visibility for both produced targets.
    """
    _walkthrough_site(
        name = name,
        src = src,
        assets = assets or [],
        data = data or [],
        shaders = shaders or [],
        bindings = bindings or [],
        docs = docs or [],
        visibility = visibility,
    )

    pkg = native.package_name()

    # The site TreeArtifact lives at `<workspace>/<pkg>/<name>_site`
    # in runfiles. Resolved by `_main/<pkg>/<name>_site` when the
    # consumer is in their own workspace.
    runfiles_dir = "_main/" + (pkg + "/" if pkg else "") + name + "_site"

    py_binary(
        name = name + "_serve",
        srcs = ["@rules_walkthrough//walkthrough:serve.py"],
        main = "@rules_walkthrough//walkthrough:serve.py",
        data = [":" + name],
        deps = ["@rules_python//python/runfiles"],
        args = [
            "--root",
            runfiles_dir,
            "--port",
            str(port),
        ],
        visibility = visibility,
    )
