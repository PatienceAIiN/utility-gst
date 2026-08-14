"""Tier 2: generic table inference with NO AI (brief §4).

Header text is matched against a synonym dictionary, then amount-column
semantics are resolved *arithmetically* across all rows with majority
agreement. Column meaning is never assumed from its name -- the same header
"Amount" means taxable value at one vendor and gross at another, and that
ambiguity is the single largest source of silent errors (brief §5).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Final

from .money import parse_money, parse_percent

TOLERANCE: Final = Decimal("0.05")

HEADER_SYNONYMS: Final[dict[str, tuple[str, ...]]] = {
    "sr_no": ("sr no", "sr", "s no", "sl no", "serial", "sno", "#"),
    "description": ("description", "particulars", "item", "product", "goods", "item name",
                    "product description", "name of product"),
    "hsn": ("hsn", "hsn code", "hsn/sac", "hsn sac", "sac", "hsn no"),
    "qty": ("qty", "quantity", "quantiy", "qnty", "qty.", "nos", "no of units", "units", "pcs"),
    "unit": ("unit", "uom", "u o m", "per"),
    "unit_rate": ("rate", "unit rate", "price", "unit price", "rate per unit", "mrp"),
    "gst_rate": ("gst rate", "gst %", "gst%", "tax rate", "rate of tax", "gst rate %"),
    "gst_value": ("gst value", "tax value", "gst val"),
    "gst_amount": ("gst amount", "tax amount", "gst amt", "total gst", "tax amt"),
    "amount": ("amount", "total", "value", "line total", "net amount", "total amount"),
    "taxable": ("taxable", "taxable value", "taxable amount", "assessable value"),
}

_NORM = re.compile(r"[^a-z0-9 ]+")


def _normalise(text: str) -> str:
    return _NORM.sub(" ", text.lower().replace("\n", " ")).strip().replace("  ", " ")


def _edit_distance(a: str, b: str) -> int:
    """Damerau-Levenshtein (optimal string alignment). Small inputs, simple DP.

    Adjacent transposition costs 1, not 2. Swapped letters are the commonest
    typing slip -- a real header read "Taxabel" -- and charging 2 for it would
    force a tolerance loose enough to start matching genuinely unrelated words.
    """
    if a == b:
        return 0
    if not a or not b:
        return len(a) or len(b)
    rows = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        rows[i][0] = i
    for j in range(len(b) + 1):
        rows[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = int(a[i - 1] != b[j - 1])
            rows[i][j] = min(
                rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost
            )
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                rows[i][j] = min(rows[i][j], rows[i - 2][j - 2] + 1)
    return rows[-1][-1]


def _close_enough(candidate: str, synonym: str) -> bool:
    """Tolerate a typo in a header.

    Real invoices contain them -- one sample header reads "Quantiy". An exact
    match dropped the quantity column, which took the whole header row with it
    and produced zero rows and a misleading "no grand total" message. The
    tolerance scales with word length so short words stay strict: "rate" and
    "date" differ by one character and must not be conflated.
    """
    if len(synonym) < 5:
        return False
    # A typo almost never lands on the first letter, and requiring it to match
    # keeps distinct fields apart: "net amount" and "gst amount" are only two
    # substitutions apart, which the length tolerance alone would accept.
    if not candidate or candidate[0] != synonym[0]:
        return False
    allowed = 1 if len(synonym) < 8 else 2
    return _edit_distance(candidate, synonym) <= allowed


def match_headers(header_cells: list[str | None]) -> dict[str, int]:
    """Map canonical field -> column index by fuzzy header match.

    Longest synonym wins so "gst rate" is not swallowed by "rate", and a column
    already claimed by a more specific field is not reassigned.
    """
    # (exact?, synonym length, field, col index). Exactness outranks length so a
    # literal match always beats a fuzzy one -- otherwise a header reading
    # "Unit" ties with quantity's "units" and the winner falls out of
    # alphabetical order rather than out of the evidence.
    scored: list[tuple[int, int, str, int]] = []
    for index, cell in enumerate(header_cells):
        if not cell:
            continue
        norm = _normalise(cell)
        if not norm:
            continue
        for field_name, synonyms in HEADER_SYNONYMS.items():
            for synonym in synonyms:
                if norm == synonym or norm.startswith(synonym + " ") or norm == synonym.replace(" ", ""):
                    scored.append((1, len(synonym), field_name, index))
                elif _close_enough(norm, synonym):
                    scored.append((0, len(synonym), field_name, index))

    scored.sort(reverse=True)
    mapping: dict[str, int] = {}
    taken: set[int] = set()
    for _, _, field_name, index in scored:
        if field_name not in mapping and index not in taken:
            mapping[field_name] = index
            taken.add(index)
    return mapping


@dataclass(slots=True)
class AmountSemantics:
    """What the ambiguous amount columns actually mean, resolved by arithmetic."""

    amount_is_gross: bool | None          # True=taxable+tax, False=taxable, None=undetermined
    gst_value_is_per_unit: bool | None    # True=per-unit tax, False=line total tax
    votes: dict[str, int]
    sample_size: int

    @property
    def resolved(self) -> bool:
        return self.amount_is_gross is not None


def _close(a: Decimal, b: Decimal, tol: Decimal = TOLERANCE) -> bool:
    return abs(a - b) <= tol


def infer_amount_semantics(
    rows: list[list[str | None]], colmap: dict[str, int]
) -> AmountSemantics:
    """Resolve column meaning by testing arithmetic hypotheses on every row.

    Tests (brief §4 Tier 2):
      QTY x Rate ~= Amount                  -> Amount is the TAXABLE value
      QTY x Rate x (1+gst) ~= Amount        -> Amount is GROSS
      GstValue x QTY ~= GstAmount           -> GstValue is PER-UNIT tax
    Majority across rows decides; ties and empty evidence return None so the
    caller routes to review instead of picking one.
    """
    votes = {"amount_taxable": 0, "amount_gross": 0, "gstval_per_unit": 0, "gstval_line": 0}
    sample = 0

    def col(row: list[str | None], name: str) -> Decimal | None:
        index = colmap.get(name)
        if index is None or index >= len(row):
            return None
        return parse_money(row[index])

    for row in rows:
        qty = col(row, "qty")
        rate = col(row, "unit_rate")
        if qty is None or rate is None or qty == 0 or rate == 0:
            continue  # zero-qty filler lines carry no arithmetic signal
        sample += 1
        taxable = qty * rate

        gst_index = colmap.get("gst_rate")
        gst_pct = (
            parse_percent(row[gst_index])
            if gst_index is not None and gst_index < len(row)
            else None
        )

        amount = col(row, "amount")
        if amount is not None:
            if _close(taxable, amount):
                votes["amount_taxable"] += 1
            elif gst_pct is not None and _close(
                taxable * (Decimal(1) + gst_pct / Decimal(100)), amount
            ):
                votes["amount_gross"] += 1

        gst_value = col(row, "gst_value")
        gst_amount = col(row, "gst_amount")
        if gst_value is not None and gst_amount is not None and gst_value != 0:
            if _close(gst_value * qty, gst_amount):
                votes["gstval_per_unit"] += 1
            elif _close(gst_value, gst_amount):
                votes["gstval_line"] += 1

    def decide(a: str, b: str) -> bool | None:
        if votes[a] == votes[b]:
            return None
        return votes[a] > votes[b]

    return AmountSemantics(
        amount_is_gross=decide("amount_gross", "amount_taxable"),
        gst_value_is_per_unit=decide("gstval_per_unit", "gstval_line"),
        votes=votes,
        sample_size=sample,
    )
