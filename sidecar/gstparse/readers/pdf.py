"""Digital PDF reader: table geometry via pdfplumber, header fields via text.

Scanned PDFs never reach here -- they go through the OCR path first and are
then force-routed to review regardless of confidence (brief §4).
"""

from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path
from typing import Any

import pdfplumber
from dateutil import parser as dateparser

from ..gst import is_valid_gstin
from ..money import parse_money, parse_percent

_GSTIN_TOKEN = re.compile(r"\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b")
_INVOICE_NO = re.compile(r"invoice\s*(?:no|number|#)\s*\.?\s*:?\s*([A-Za-z0-9/\-_]+)", re.IGNORECASE)
_DATE = re.compile(r"\bdate\s*:?\s*([0-9]{1,2}\s*(?:st|nd|rd|th)?\s*[A-Za-z]+\s*[0-9]{2,4}"
                   r"|[0-9]{1,2}[-/][0-9]{1,2}[-/][0-9]{2,4})", re.IGNORECASE)
_ROUND_OFF = re.compile(r"round\s*[-\s]?off", re.IGNORECASE)
_TOTAL_ONLY = re.compile(r"^\s*(?:grand\s*)?total\s*:?\s*$", re.IGNORECASE)
_TOTAL_LOOSE = re.compile(
    r"\b(?:grand\s*total|invoice\s*total|net\s*(?:payable|amount)|amount\s*payable|total)\b",
    re.IGNORECASE,
)


def _last_number(row: list[str | None]) -> Decimal | None:
    for cell in reversed(row):
        if cell is None:
            continue
        value = parse_money(cell)
        if value is not None:
            return value
    return None


def _clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def _numeric_columns(rows: list[list[str | None]]) -> dict[int, int]:
    """How many rows parse as a number in each column."""
    counts: dict[int, int] = {}
    for row in rows:
        for index, cell in enumerate(row):
            if parse_money(cell) is not None:
                counts[index] = counts.get(index, 0) + 1
    return counts


def infer_columns_arithmetically(
    rows: list[list[str | None]], known: dict[str, int]
) -> dict[str, int]:
    """Recover qty / rate / amount from the numbers when the header is unreadable.

    A vendor can misspell a header, merge cells, or ship a table with no header
    row at all. Rather than give up -- which previously produced zero rows and a
    misleading "no grand total" -- look for the column triple that satisfies
    qty x rate == amount (or the gross variant) on a majority of rows.

    This only ever ADDS columns the header could not supply, and only when the
    arithmetic agrees across most rows. Nothing is guessed from position alone,
    because a guess that lands in the wrong column is exactly the silent error
    this application exists to prevent.
    """
    found = dict(known)
    if {"qty", "unit_rate"} <= found.keys():
        return found

    numeric = _numeric_columns(rows)
    candidates = [c for c, n in numeric.items() if n >= max(2, len(rows) // 2)]
    if len(candidates) < 3:
        return found

    def value(row: list[str | None], index: int) -> Decimal | None:
        return parse_money(row[index]) if index < len(row) else None

    gst_index = found.get("gst_rate")
    best: tuple[tuple[int, int], tuple[int, int, int]] | None = None

    for qty_col in candidates:
        for rate_col in candidates:
            if rate_col == qty_col:
                continue
            for amount_col in candidates:
                if amount_col in (qty_col, rate_col):
                    continue
                agree = 0
                for row in rows:
                    q, r, a = value(row, qty_col), value(row, rate_col), value(row, amount_col)
                    if q is None or r is None or a is None or q == 0 or r == 0:
                        continue
                    taxable = q * r
                    if abs(taxable - a) <= Decimal("0.05"):
                        agree += 1
                        continue
                    pct = (
                        parse_percent(row[gst_index])
                        if gst_index is not None and gst_index < len(row)
                        else None
                    )
                    if pct is not None and abs(taxable * (1 + pct / 100) - a) <= Decimal("0.05"):
                        agree += 1
                if agree < 2:
                    continue
                # qty x rate is commutative, so the arithmetic alone cannot tell
                # quantity from rate -- both orderings satisfy it equally. The
                # taxable value comes out right either way, but the register
                # would carry the two columns swapped. Invoice tables put
                # quantity left of rate and both left of the amount they
                # produce; that layout breaks the tie.
                key = (agree, 1 if qty_col < rate_col < amount_col else 0)
                if best is None or key > best[0]:
                    best = (key, (qty_col, rate_col, amount_col))

    if best is None:
        return found
    qty_col, rate_col, amount_col = best[1]
    found.setdefault("qty", qty_col)
    found.setdefault("unit_rate", rate_col)
    found.setdefault("amount", amount_col)
    return found


class PdfDocument:
    """Everything extracted from the file, before any GST interpretation."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.text: str = ""
        self.header_row: list[str | None] = []
        self.data_rows: list[list[str | None]] = []
        self.footer_rows: list[list[str | None]] = []
        self.page_count = 0
        self.all_tables: list[list[list[str | None]]] = []
        self.colmap: dict[str, int] = {}
        self.healed: list[str] = []
        self._load()

    def _load(self) -> None:
        with pdfplumber.open(str(self.path)) as pdf:
            self.page_count = len(pdf.pages)
            chunks: list[str] = []
            tables: list[list[list[str | None]]] = []
            for page in pdf.pages:
                chunks.append(page.extract_text() or "")
                for table in page.extract_tables():
                    tables.append([[c for c in row] for row in table])
            self.text = "\n".join(chunks)

        # Header row = the row whose cells best match known column names.
        from ..tier2_infer import match_headers

        # Pick the row that matches the most known column names. Requiring a
        # quantity column by NAME used to be the gate, which meant one misspelt
        # header ("Quantiy") discarded the entire table. Arithmetic recovers the
        # column afterwards if the name is unreadable.
        best_score = 0
        best: tuple[int, int] | None = None
        for t_index, table in enumerate(tables):
            for r_index, row in enumerate(table):
                mapping = match_headers(row)
                score = len(mapping)
                if score > best_score and score >= 3 and "unit_rate" in mapping:
                    best_score, best = score, (t_index, r_index)

        if best is None:
            self.all_tables = tables
            return
        t_index, r_index = best
        table = tables[t_index]
        self.header_row = table[r_index]

        # Data rows run until the arithmetic stops: a row with no qty and no rate
        # is the totals band, not a line item.
        mapping = match_headers(self.header_row)
        body = table[r_index + 1:]
        if "qty" not in mapping:
            healed = infer_columns_arithmetically(body, mapping)
            if "qty" in healed:
                self.healed.append(
                    "Quantity column identified from the arithmetic; the header was not readable."
                )
                mapping = healed
        self.colmap = mapping
        qty_col, rate_col = mapping.get("qty"), mapping.get("unit_rate")
        for row in table[r_index + 1:]:
            has_data = False
            if qty_col is not None and qty_col < len(row):
                has_data = parse_money(row[qty_col]) is not None
            if not has_data and rate_col is not None and rate_col < len(row):
                has_data = parse_money(row[rate_col]) is not None
            (self.data_rows if has_data else self.footer_rows).append(row)

        for other in (t for i, t in enumerate(tables) if i != t_index):
            self.footer_rows.extend(other)
        self.all_tables = tables

    # --- header field extraction ---

    def gstins(self) -> list[str]:
        seen: list[str] = []
        for match in _GSTIN_TOKEN.finditer(self.text.upper()):
            token = match.group(1)
            if is_valid_gstin(token) and token not in seen:
                seen.append(token)
        return seen

    def invoice_no(self) -> str | None:
        match = _INVOICE_NO.search(self.text)
        return match.group(1).strip() if match else None

    def invoice_date(self) -> Any:
        match = _DATE.search(self.text)
        if not match:
            return None
        raw = re.sub(r"(\d)(st|nd|rd|th)", r"\1", match.group(1), flags=re.IGNORECASE).strip()
        try:
            return dateparser.parse(raw, dayfirst=True).date()
        except (ValueError, OverflowError, TypeError):
            return None

    def seller_name(self) -> str | None:
        for line in self.text.splitlines():
            cleaned = _clean(line)
            if cleaned:
                return cleaned
        return None

    def buyer_name(self) -> str | None:
        match = re.search(r"bill\s*to\s*:?\s*(.+)", self.text, re.IGNORECASE)
        if not match:
            return None
        # "Bill To: X    Shipping To: Y" share one text line -- keep only the bill-to side.
        return _clean(re.split(r"\bship(?:ping)?\s*to\b", match.group(1), flags=re.IGNORECASE)[0])

    def _all_rows(self) -> list[list[str | None]]:
        """Every row on the page. A label like Total can sit outside the table
        the line items were found in, so restricting the search to that table's
        footer meant a perfectly readable total was reported as missing."""
        rows = list(self.footer_rows)
        for table in self.all_tables:
            rows.extend(table)
        return rows

    def round_off(self) -> Decimal:
        for row in self._all_rows():
            if any(cell and _ROUND_OFF.search(cell) for cell in row):
                value = _last_number(row)
                if value is not None:
                    return value
        return Decimal("0.00")

    def stated_grand_total(self) -> Decimal | None:
        # Prefer an exact "Total" label, then fall back to looser phrasings, so
        # "Grand Total", "Net Payable" and "Invoice Total" all resolve.
        for pattern in (_TOTAL_ONLY, _TOTAL_LOOSE):
            for row in reversed(self._all_rows()):
                if any(cell and pattern.search(cell) for cell in row):
                    value = _last_number(row)
                    if value is not None:
                        return value
        return None
