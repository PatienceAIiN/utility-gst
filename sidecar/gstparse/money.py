"""The single place rounding is defined. No float ever touches money (brief §12, §13).

Convention: ROUND_HALF_UP at 2 decimal places, applied only at defined boundaries
(per-line tax, invoice totals) and never mid-calculation.
"""

from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Final

ZERO: Final = Decimal("0.00")
PAISA: Final = Decimal("0.01")
RATE_EXP: Final = Decimal("0.001")  # 3 dp: 0.25% halves to 0.125% (DECISIONS.md R-06)

_CLEAN = re.compile(r"[,\s₹]|Rs\.?|INR", re.IGNORECASE)


def q2(value: Decimal) -> Decimal:
    """Quantize to 2 dp, half-up. The ONLY rounding function for money."""
    return value.quantize(PAISA, rounding=ROUND_HALF_UP)


def q3(value: Decimal) -> Decimal:
    """Quantize a *rate* to 3 dp. Rates are not money; they halve to 0.125%."""
    return value.quantize(RATE_EXP, rounding=ROUND_HALF_UP)


def parse_money(raw: str | Decimal | int | None) -> Decimal | None:
    """Parse a money-ish token from a document. Returns None if not numeric.

    Handles thousands separators, currency marks, parenthesised negatives and
    trailing minus. Never raises on junk -- callers decide what a None means.
    """
    if raw is None:
        return None
    if isinstance(raw, Decimal):
        return raw
    if isinstance(raw, int):
        return Decimal(raw)

    text = _CLEAN.sub("", str(raw)).strip()
    if not text:
        return None

    negative = False
    if text.startswith("(") and text.endswith(")"):
        negative, text = True, text[1:-1]
    if text.endswith("-"):
        negative, text = True, text[:-1]
    if text.startswith("-"):
        negative, text = True, text[1:]

    try:
        value = Decimal(text)
    except InvalidOperation:
        return None
    return -value if negative else value


def parse_percent(raw: str | Decimal | None) -> Decimal | None:
    """Parse '18%' or '18' or '5 %' into Decimal('18'). Not a fraction."""
    if raw is None:
        return None
    if isinstance(raw, Decimal):
        return raw
    return parse_money(str(raw).replace("%", ""))


def fmt(value: Decimal | None) -> str:
    """Exact decimal string for IPC and JSON. Never a float."""
    return "" if value is None else str(q2(value))
