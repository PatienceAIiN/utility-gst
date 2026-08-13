"""In-app spreadsheet viewing and editing for CSV and XLSX.

Deliberately conservative about writes: a spreadsheet the operator opens here may
be a source document for an already-imported invoice, so every save is
non-destructive by default (a timestamped copy) unless overwrite is explicit.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
from pathlib import Path
from typing import Any, Final

from openpyxl import Workbook, load_workbook

MAX_ROWS: Final = 20_000      # a grid past this is unusable in the UI anyway
MAX_COLS: Final = 200
CSV_SNIFF_BYTES: Final = 64 * 1024


def _detect_dialect(sample: str) -> type[csv.Dialect] | csv.Dialect:
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        return csv.excel


def read_csv(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    dialect = _detect_dialect(raw[:CSV_SNIFF_BYTES])
    rows = list(csv.reader(io.StringIO(raw), dialect))
    truncated = len(rows) > MAX_ROWS
    rows = rows[:MAX_ROWS]
    width = min(max((len(r) for r in rows), default=0), MAX_COLS)
    normalised = [[(r[i] if i < len(r) else "") for i in range(width)] for r in rows]
    return {
        "kind": "csv",
        "sheets": [{"name": path.stem, "rows": normalised}],
        "active": 0,
        "truncated": truncated,
        "path": str(path),
    }


def read_xlsx(path: Path) -> dict[str, Any]:
    workbook = load_workbook(path, data_only=True, read_only=True)
    sheets: list[dict[str, Any]] = []
    truncated = False
    for worksheet in workbook.worksheets:
        rows: list[list[str]] = []
        for index, row in enumerate(worksheet.iter_rows(values_only=True)):
            if index >= MAX_ROWS:
                truncated = True
                break
            rows.append(["" if cell is None else str(cell) for cell in row[:MAX_COLS]])
        width = min(max((len(r) for r in rows), default=0), MAX_COLS)
        rows = [[(r[i] if i < len(r) else "") for i in range(width)] for r in rows]
        sheets.append({"name": worksheet.title, "rows": rows})
    workbook.close()
    return {"kind": "xlsx", "sheets": sheets, "active": 0,
            "truncated": truncated, "path": str(path)}


def read_sheet(path: Path) -> dict[str, Any]:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return read_csv(path)
    if suffix in (".xlsx", ".xlsm"):
        return read_xlsx(path)
    raise ValueError(f"Cannot open {suffix} as a spreadsheet")


def _target(path: Path, overwrite: bool) -> Path:
    """Never clobber a source document unless explicitly told to."""
    if overwrite:
        return path
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")  # noqa: DTZ005 - local wall-clock
    return path.with_name(f"{path.stem}-edited-{stamp}{path.suffix}")


def write_sheet(
    path: Path, sheets: list[dict[str, Any]], overwrite: bool = False
) -> dict[str, str]:
    destination = _target(path, overwrite)
    suffix = destination.suffix.lower()

    if suffix == ".csv":
        rows = sheets[0]["rows"] if sheets else []
        with open(destination, "w", newline="", encoding="utf-8") as handle:
            csv.writer(handle).writerows(rows)
    elif suffix in (".xlsx", ".xlsm"):
        workbook = Workbook()
        default = workbook.active
        if default is not None:
            workbook.remove(default)
        for sheet in sheets or [{"name": "Sheet1", "rows": []}]:
            worksheet = workbook.create_sheet(title=str(sheet.get("name") or "Sheet1")[:31])
            for row in sheet.get("rows", []):
                # Everything round-trips as text. Coercing strings back to numbers
                # here would silently destroy leading zeros in HSN columns.
                worksheet.append([("" if c is None else str(c)) for c in row])
        workbook.save(destination)
    else:
        raise ValueError(f"Cannot save {suffix}")

    return {"path": str(destination), "overwrote": str(overwrite).lower()}
