"""Resolve `DataSource` references inside a Walkthrough JSON.

For every `data_source` field encountered (on PlotBlock or
CanvasBlock), this binary:

  1. Locates the referenced source file (matched by basename against
     the `--asset` list passed in by the Bazel macro).
  2. Loads it according to `kind` (JSON / CSV / NPY / NPZ / PARQUET).
  3. Writes a sidecar JSON to `<out_data_dir>/<basename>.json` in a
     uniform schema (see SIDECAR_SCHEMA below).
  4. Rewrites the in-walkthrough `uri` to `data/<basename>.json` so
     the browser fetches the sidecar directly.

The renderer's contract is "follow data_source.uri, parse as JSON,
merge into the block". The browser never sees parquet/npz/csv —
that's the resolver's job. This keeps the renderer thin and lets us
add live gRPC sources later without touching the JS.

SIDECAR_SCHEMA
==============
::

  {
    "series": [             # populated when columns look like (x, y[, series, color])
      { "name": str, "x": [..], "y": [..], "color": str? }
    ],
    "arrays": {              # populated for NPZ; one entry per array
      "<name>": [...]        # nested lists; resolver flattens ND to nested
    },
    "columns": {             # populated for CSV/PARQUET; raw columns
      "<col>": [...]
    },
    "meta": {
      "uri": "...",
      "kind": "PARQUET" | "CSV" | "NPY" | "NPZ" | "JSON",
      "shape": [...]?,
      "n_rows": int?
    }
  }

Plots read `.series`; canvas scripts get the whole sidecar passed as
`params.data`.

Usage::

  python resolve.py \\
    --in path/to/walkthrough.json \\
    --out staged/walkthrough.json \\
    --out-data staged/data/ \\
    --asset some/path/sigma_trace.npy \\
    --asset other/path/hist.csv
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable

# numpy is lazy-imported inside the .npy/.npz loaders so this resolver
# binary stays usable without it for JSON/CSV-only consumers. Callers
# that pass .npy/.npz files via `data =` must ensure numpy is in the
# resolver's runfiles (depend on it from the consumer's pip hub, or
# add a py_binary deps override when wrapping the rule).
def _np():
    import numpy as np
    return np


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--in", dest="in_path", required=True)
    p.add_argument("--out", dest="out_path", required=True)
    p.add_argument("--out-data", dest="out_data_dir", required=True)
    p.add_argument(
        "--asset",
        dest="assets",
        action="append",
        default=[],
        help="Source data files declared by the macro's `data` attr. "
             "Matched against DataSource.uri by basename.",
    )
    args = p.parse_args()

    asset_by_basename: dict[str, Path] = {}
    for a in args.assets:
        path = Path(a)
        # Allow same basename only if both files identical.
        if path.name in asset_by_basename:
            prior = asset_by_basename[path.name]
            if prior.resolve() != path.resolve():
                raise SystemExit(
                    f"data file basename collision: {path.name} "
                    f"in both {prior} and {path}")
        asset_by_basename[path.name] = path

    walk = json.loads(Path(args.in_path).read_text())
    out_data_dir = Path(args.out_data_dir)
    out_data_dir.mkdir(parents=True, exist_ok=True)

    rewrites_done = 0
    seen_sidecars: dict[str, str] = {}  # uri -> sidecar relative path

    for ds in _find_data_sources(walk):
        uri = ds.get("uri")
        if not uri:
            continue
        kind = (ds.get("kind") or "JSON").upper()
        if uri in seen_sidecars:
            ds["uri"] = seen_sidecars[uri]
            continue

        source = _locate_source(uri, asset_by_basename)
        sidecar = _build_sidecar(source, kind, ds)
        sidecar_name = _sidecar_filename(uri)
        sidecar_path = out_data_dir / sidecar_name
        sidecar_path.write_text(json.dumps(sidecar, separators=(",", ":")))

        new_uri = f"data/{sidecar_name}"
        ds["uri"] = new_uri
        seen_sidecars[uri] = new_uri
        rewrites_done += 1

    Path(args.out_path).write_text(json.dumps(walk, indent=2))
    print(
        f"resolver: rewrote {rewrites_done} data_source URI(s); "
        f"wrote {len(seen_sidecars)} sidecar(s) under {out_data_dir}",
        file=sys.stderr,
    )
    return 0


# ---------- traversal ----------

def _find_data_sources(obj: Any) -> Iterable[dict]:
    """Recursively yield every dict that is a `data_source` field.

    Matches both proto-style snake_case (`data_source`) and JSON
    camelCase (`dataSource`) — the renderer accepts either. Stops
    descending into a matched data_source itself so we don't try to
    re-resolve a sidecar's contents.
    """
    if isinstance(obj, dict):
        for key in ("data_source", "dataSource"):
            ds = obj.get(key)
            if isinstance(ds, dict) and "uri" in ds:
                yield ds
        for k, v in obj.items():
            if k in ("data_source", "dataSource"):
                continue
            yield from _find_data_sources(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _find_data_sources(item)


# ---------- source lookup ----------

def _locate_source(uri: str, by_basename: dict[str, Path]) -> Path:
    # Authoring URIs are basenames or short relative paths; the macro
    # passes the file in via `--asset` so we look it up by basename.
    basename = os.path.basename(uri)
    if basename not in by_basename:
        raise SystemExit(
            f"resolver: data file {uri!r} (basename {basename!r}) "
            f"is not in the macro's data= attr. "
            f"Add it to walkthrough_html(data=[...]).")
    return by_basename[basename]


def _sidecar_filename(uri: str) -> str:
    basename = os.path.basename(uri)
    stem, _ = os.path.splitext(basename)
    # Disambiguate when two URIs share a basename via the URI hash.
    h = hashlib.sha1(uri.encode()).hexdigest()[:8]
    return f"{stem}.{h}.json"


# ---------- loaders ----------

def _build_sidecar(path: Path, kind: str, ds_spec: dict) -> dict[str, Any]:
    meta: dict[str, Any] = {"uri": str(path.name), "kind": kind}
    if kind == "JSON":
        data = json.loads(path.read_text())
        if isinstance(data, dict):
            data.setdefault("meta", {}).update(meta)
            return data
        return {"raw": data, "meta": meta}

    if kind == "NPY":
        np = _np()
        arr = np.load(path, allow_pickle=False)
        meta["shape"] = list(arr.shape)
        return {"array": _ndarray_to_lists(arr), "meta": meta}

    if kind == "NPZ":
        np = _np()
        out_arrays: dict[str, Any] = {}
        with np.load(path, allow_pickle=False) as z:
            for name in z.files:
                out_arrays[name] = _ndarray_to_lists(z[name])
        meta["arrays"] = list(out_arrays.keys())
        sidecar: dict[str, Any] = {"arrays": out_arrays, "meta": meta}
        # If exactly two 1-D arrays match (x, y) convention, synthesize a
        # series too so PlotBlock can consume the file directly.
        sidecar.update(_maybe_series_from_arrays(out_arrays, path.stem))
        return sidecar

    if kind == "CSV":
        columns = _read_csv_columns(path)
        meta["n_rows"] = len(next(iter(columns.values()))) if columns else 0
        return _columns_to_sidecar(columns, path.stem, meta, ds_spec)

    if kind == "PARQUET":
        columns = _read_parquet_columns(path, ds_spec.get("columns", []))
        meta["n_rows"] = len(next(iter(columns.values()))) if columns else 0
        return _columns_to_sidecar(columns, path.stem, meta, ds_spec)

    raise SystemExit(f"resolver: unsupported DataSource.kind {kind!r}")


def _read_csv_columns(path: Path) -> dict[str, list]:
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        columns: dict[str, list] = {name: [] for name in (reader.fieldnames or [])}
        for row in reader:
            for k, v in row.items():
                columns[k].append(_coerce_scalar(v))
    return columns


def _read_parquet_columns(path: Path, want: list[str]) -> dict[str, list]:
    try:
        import pyarrow.parquet as pq  # type: ignore
    except ImportError:
        raise SystemExit(
            "resolver: PARQUET DataSource requires pyarrow. "
            "Either install pyarrow or convert your file to NPZ/CSV/JSON.")
    table = pq.read_table(path, columns=want or None)
    return {name: table.column(name).to_pylist() for name in table.column_names}


def _coerce_scalar(v: str) -> Any:
    if v is None or v == "":
        return None
    try:
        if "." in v or "e" in v or "E" in v:
            return float(v)
        return int(v)
    except ValueError:
        return v


def _ndarray_to_lists(arr: Any) -> Any:
    # Cast to plain Python lists; np.float32 etc. don't JSON-serialize.
    # For large arrays this is the dominant cost — fine for the
    # walkthrough's expected scale (~10⁴ values), revisit for ~10⁶+.
    if arr.dtype.kind in ("U", "S", "O"):
        return arr.tolist()
    return arr.astype(float).tolist()


# ---------- columns → series ----------

def _columns_to_sidecar(
    columns: dict[str, list],
    default_name: str,
    meta: dict,
    ds_spec: dict,
) -> dict[str, Any]:
    out: dict[str, Any] = {"columns": columns, "meta": meta}
    series = _series_from_columns(columns, default_name)
    if series:
        out["series"] = series
    return out


def _series_from_columns(columns: dict[str, list], default_name: str) -> list[dict]:
    # Convention: columns x, y, optional series, optional color.
    if "x" not in columns or "y" not in columns:
        return []
    xs = columns["x"]
    ys = columns["y"]
    if "series" not in columns:
        return [{"name": default_name, "x": list(xs), "y": list(ys)}]
    groups: dict[str, dict[str, list]] = {}
    color_col = columns.get("color")
    for i, name in enumerate(columns["series"]):
        g = groups.setdefault(str(name), {"x": [], "y": [], "color": None})
        g["x"].append(xs[i])
        g["y"].append(ys[i])
        if color_col is not None:
            g["color"] = color_col[i]
    out = []
    for name, g in groups.items():
        s = {"name": name, "x": g["x"], "y": g["y"]}
        if g["color"]:
            s["color"] = g["color"]
        out.append(s)
    return out


def _maybe_series_from_arrays(arrays: dict[str, Any], default_name: str) -> dict:
    # If the NPZ has exactly two 1-D arrays named (x, y), synthesize
    # a single series. Common idiom for analyze.py outputs.
    x = arrays.get("x")
    y = arrays.get("y")
    if isinstance(x, list) and isinstance(y, list) and len(x) == len(y):
        return {"series": [{"name": default_name, "x": x, "y": y}]}
    return {}


if __name__ == "__main__":
    sys.exit(main())
