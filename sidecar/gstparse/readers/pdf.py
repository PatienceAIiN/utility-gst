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
from ..money import parse_money

_GSTIN_TOKEN = re.compile(r"\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b")
_INVOICE_NO = re.compile(r"invoice\s*(?:no|number|#)\s*\.?\s*:?\s*([A-Za-z0-9/\-_]+)", re.IGNORECASE)
_DATE = re.compile(r"\bdate\s*:?\s*([0-9]{1,2}\s*(?:st|nd|rd|th)?\s*[A-Za-z]+\s*[0-9]{2,4}"
                   r"|[0-9]{1,2}[-/][0-9]{1,2}[-/][0-9]{2,4})", re.IGNORECASE)
_ROUND_OFF = re.compile(r"round\s*[-\s]?off", re.IGNORECASE)
_TOTAL_ONLY = re.compile(r"^\s*(?:grand\s*)?total\s*:?\s*$", re.IGNORECASE)


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


class PdfDocument:
    """Everything extracted from the file, before any GST interpretation."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.text: str = ""
        self.header_row: list[str | None] = []
        self.data_rows: list[list[str | None]] = []
        self.footer_rows: list[list[str | None]] = []
        self.page_count = 0
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

        best_score = 0
        best: tuple[int, int] | None = None
        for t_index, table in enumerate(tables):
            for r_index, row in enumerate(table):
                score = len(match_headers(row))
                # A real header must carry a quantity-ish and a rate-ish column.
                mapping = match_headers(row)
                if score > best_score and "qty" in mapping and "unit_rate" in mapping:
                    best_score, best = score, (t_index, r_index)

        if best is None:
            return
        t_index, r_index = best
        table = tables[t_index]
        self.header_row = table[r_index]

        # Data rows run until the arithmetic stops: a row with no qty and no rate
        # is the totals band, not a line item.
        mapping = match_headers(self.header_row)
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

    def round_off(self) -> Decimal:
        for row in self.footer_rows:
            if any(cell and _ROUND_OFF.search(cell) for cell in row):
                value = _last_number(row)
                if value is not None:
                    return value
        return Decimal("0.00")

    def stated_grand_total(self) -> Decimal | None:
        for row in reversed(self.footer_rows):
            if any(cell and _TOTAL_ONLY.match(cell) for cell in row):
                value = _last_number(row)
                if value is not None:
                    return value
        return None
