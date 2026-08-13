"""GST domain rules: GSTIN, HSN, state logic, tax splitting.

Every rule here is one named function so it gets one named test (brief §12).
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Final, Literal

from .money import q2, q3

SupplyType = Literal["intra", "inter"]

# --- GSTIN -----------------------------------------------------------------

_GSTIN_RE: Final = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}[Z][0-9A-Z]{1}$")
_CODE_POINTS: Final = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_MOD: Final = len(_CODE_POINTS)  # 36

# State codes 01-38 plus 97 (other territory) and 99 (centre).
_VALID_STATE_CODES: Final = frozenset(
    [f"{n:02d}" for n in range(1, 39)] + ["97", "99"]
)


def gstin_check_digit(first14: str) -> str:
    """Compute the GSTIN check digit (mod-36, alternating weights 1 and 2)."""
    total = 0
    for index, char in enumerate(first14):
        value = _CODE_POINTS.index(char)
        factor = 2 if index % 2 else 1
        addend = factor * value
        total += (addend // _MOD) + (addend % _MOD)
    return _CODE_POINTS[(_MOD - (total % _MOD)) % _MOD]


def is_valid_gstin(gstin: str | None) -> bool:
    """Format AND checksum (brief §6.6). Both must hold."""
    if not gstin:
        return False
    candidate = gstin.strip().upper()
    if not _GSTIN_RE.match(candidate):
        return False
    if candidate[:2] not in _VALID_STATE_CODES:
        return False
    return gstin_check_digit(candidate[:14]) == candidate[14]


def state_code(gstin: str | None) -> str | None:
    """First two digits of a GSTIN identify the state."""
    if not gstin or len(gstin.strip()) < 2:
        return None
    prefix = gstin.strip()[:2]
    return prefix if prefix in _VALID_STATE_CODES else None


def resolve_supply_type(
    seller_gstin: str | None,
    buyer_gstin: str | None,
    place_of_supply_code: str | None = None,
) -> SupplyType | None:
    """Intra- vs inter-state.

    Buyer GSTIN prefix is the primary signal, place of supply the fallback for
    B2C (DECISIONS.md R-05). Returns None when neither is determinable -- the
    caller must route to the Review Queue rather than guess, because guessing
    puts tax in the wrong columns silently.
    """
    seller_state = state_code(seller_gstin)
    if seller_state is None:
        return None

    buyer_state = state_code(buyer_gstin)
    if buyer_state is None:
        buyer_state = place_of_supply_code if place_of_supply_code in _VALID_STATE_CODES else None
    if buyer_state is None:
        return None

    return "intra" if seller_state == buyer_state else "inter"


# --- HSN -------------------------------------------------------------------


def normalise_hsn(raw: str | int | None) -> str | None:
    """Restore a lost leading zero without corrupting genuinely short codes.

    HSN is hierarchical and only ever 2/4/6/8 digits -- always even. An odd
    length therefore means a leading zero was eaten by a spreadsheet; an even
    length is already correct. Padding everything to 8 would turn the valid
    4-digit heading '0901' into the nonexistent '00000901' (DECISIONS.md R-12).
    """
    if raw is None:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if not digits:
        return None
    return "0" + digits if len(digits) % 2 else digits


def is_valid_hsn(hsn: str | None) -> bool:
    """Brief §6.6: HSN is 4, 6 or 8 digits (2 is a chapter, too coarse to file)."""
    if not hsn:
        return False
    return hsn.isdigit() and len(hsn) in (4, 6, 8)


# --- Tax -------------------------------------------------------------------


def split_intra_state_tax(tax: Decimal) -> tuple[Decimal, Decimal]:
    """Split a line's tax into (CGST, SGST) so the two ALWAYS sum to `tax`.

    Rounding both halves independently breaks validation rule §6.2 on odd paisa:
    1406.25 / 2 = 703.125, and 703.13 + 703.13 = 1406.26. The real sample invoice
    contains exactly this error (DECISIONS.md R-06). Taking the remainder as SGST
    makes the sum exact by construction.
    """
    cgst = q2(tax / 2)
    return cgst, q2(tax) - cgst


def split_rate(gst_rate: Decimal) -> Decimal:
    """Half the rate for CGST/SGST display. 3 dp because 0.25% -> 0.125%."""
    return q3(gst_rate / 2)


def compute_line_tax(taxable: Decimal, gst_rate_percent: Decimal) -> Decimal:
    """Line tax from taxable value. Rounded once, here, at the boundary."""
    return q2(taxable * gst_rate_percent / Decimal(100))
