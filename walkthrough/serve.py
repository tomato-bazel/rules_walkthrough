"""Serve a built walkthrough directory over localhost and open a browser.

Invoked by the `walkthrough_html` macro's `*_serve` py_binary. It
resolves the runfiles-relative path of the walkthrough's static
directory (renderer files + the per-walkthrough walkthrough.json) and
hands it to http.server.
"""

from __future__ import annotations

import argparse
import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

try:
    # rules_python provides this on every py_binary at runtime.
    from python.runfiles import Runfiles  # type: ignore
except ImportError:  # pragma: no cover - direct-invocation fallback
    Runfiles = None


def _resolve_root(runfiles_path: str) -> Path:
    """Translate a runfiles-relative directory path to an absolute one.

    `runfiles_path` points at the staged site directory (a TreeArtifact
    declared by `_walkthrough_site`); the http server cd's into it
    and serves the tree verbatim.
    """
    if Runfiles is not None:
        r = Runfiles.Create()
        if r is not None:
            located = r.Rlocation(runfiles_path)
            if located and Path(located).exists():
                return Path(located).resolve()
            # Some Bazel versions strip the trailing segment for
            # TreeArtifact lookups; fall back to a manual probe.
            for env in ("RUNFILES_DIR", "TEST_SRCDIR"):
                base = os.environ.get(env)
                if base:
                    candidate = Path(base) / runfiles_path
                    if candidate.exists():
                        return candidate.resolve()
    candidate = Path(runfiles_path)
    if candidate.exists():
        return candidate.resolve()
    raise SystemExit(f"could not resolve runfiles path: {runfiles_path}")


def _pick_port(preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--root",
        required=True,
        help="runfiles-relative path to the walkthrough.json marker file",
    )
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-open", action="store_true")
    args = p.parse_args()

    root = _resolve_root(args.root)
    if not (root / "index.html").exists():
        raise SystemExit(f"no index.html in {root}")

    os.chdir(root)
    port = _pick_port(args.port)
    handler = http.server.SimpleHTTPRequestHandler
    # ReusableTCPServer to avoid TIME_WAIT on Ctrl-C restart.

    class _Server(socketserver.TCPServer):
        allow_reuse_address = True

    url = f"http://127.0.0.1:{port}/"
    print(f"walkthrough: serving {root} on {url}", file=sys.stderr)

    with _Server(("127.0.0.1", port), handler) as httpd:
        if not args.no_open:
            threading.Timer(0.25, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nwalkthrough: shutting down", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
