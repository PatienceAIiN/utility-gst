"""CLI and JSON-RPC-over-stdio entry point.

`parse`/`export` make the core testable on Fedora with no Electron in sight
(brief §2: the parsing core must be OS-agnostic). `rpc` is what the Electron
main process spawns as a child.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any

from .excel.writer import write_register
from .models import Invoice
from .parser import parse_pdf

SUPPORTED = {".pdf"}


def parse_file(path: Path) -> Invoice:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return parse_pdf(path)
    raise ValueError(f"Unsupported file type: {suffix}")


def _cmd_parse(args: argparse.Namespace) -> int:
    results = []
    for name in args.files:
        try:
            results.append(parse_file(Path(name)).to_json())
        except Exception as exc:  # noqa: BLE001 - surfaced as data, never a stack trace to the UI
            results.append({"source_file": name, "error": str(exc), "is_blocked": True})
    json.dump(results, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def _cmd_export(args: argparse.Namespace) -> int:
    invoices = [parse_file(Path(name)) for name in args.files]
    blocked = [i for i in invoices if i.is_blocked]
    if blocked and not args.force:
        for invoice in blocked:
            for finding in invoice.findings:
                if finding.severity == "blocking":
                    print(f"BLOCKED {invoice.source_file}: {finding.rule_code} "
                          f"- {finding.message}", file=sys.stderr)
        print("\nExport refused: fix the blocking failures above, or pass --force.",
              file=sys.stderr)
        return 2
    path = write_register(invoices, Path(args.out))
    print(path)
    return 0


# --- JSON-RPC over stdio ---------------------------------------------------

def _rpc_dispatch(method: str, params: dict[str, Any]) -> Any:
    if method == "ping":
        return {"ok": True}
    if method == "parse":
        return parse_file(Path(params["path"])).to_json()
    if method == "export":
        invoices = [parse_file(Path(p)) for p in params["paths"]]
        if any(i.is_blocked for i in invoices) and not params.get("force"):
            raise ValueError("Export blocked by validation failures")
        stamp = dt.datetime.now()  # noqa: DTZ005 - local wall-clock is correct for an on-prem register
        return {"path": str(write_register(invoices, Path(params["out"]), stamp))}
    raise ValueError(f"Unknown method: {method}")


def _cmd_rpc(_args: argparse.Namespace) -> int:
    """Line-delimited JSON-RPC 2.0. One request per line, one response per line."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            result = _rpc_dispatch(request["method"], request.get("params") or {})
            response = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except Exception as exc:  # noqa: BLE001 - RPC must never die on one bad request
            response = {"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": -32000, "message": str(exc)}}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gstparse", description="GST invoice parsing core")
    sub = parser.add_subparsers(dest="command", required=True)

    p_parse = sub.add_parser("parse", help="Parse files and print JSON")
    p_parse.add_argument("files", nargs="+")
    p_parse.set_defaults(func=_cmd_parse)

    p_export = sub.add_parser("export", help="Parse files and write a register .xlsx")
    p_export.add_argument("files", nargs="+")
    p_export.add_argument("--out", default="./out")
    p_export.add_argument("--force", action="store_true",
                          help="Export despite blocking failures (audited)")
    p_export.set_defaults(func=_cmd_export)

    p_rpc = sub.add_parser("rpc", help="JSON-RPC over stdio (used by the desktop app)")
    p_rpc.set_defaults(func=_cmd_rpc)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
